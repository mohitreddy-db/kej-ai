import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import pg from "pg";
import XLSX from "xlsx";

const root = process.cwd();
const databaseUrl = process.env.DATABASE_URL || "postgresql://kejai:kejai_local@127.0.0.1:54329/kejai";
const client = new pg.Client({ connectionString: databaseUrl });
const input = (name) => path.join(root, "inputs", name);
const files = {
  stock: input("HO Stock Report (Daily).xlsx"),
  inward: input("Inward Report FY-2026-27 (Daily).xlsx"),
  outward: input("Daily Outward Report 2026-27 (Daily).xlsx"),
  quality: input("Inward quality report (Weekly).xlsx"),
  auction: input("Auction Rate Chart FY-2026-27 (Depends On Auction).xlsx"),
  buyers: input("All Company Bulk Permit detaisl (Weekly).xlsx"),
  bids: input("Auction Bid Sheet Summary (Depends On Auction).xlsx"),
  transport: input("INWARD TRANSPORTER -WORK ORDER FILE-CONTROL SHEET FORMAT.xlsm"),
  fines: input("Fines Planning as on 23-07-2026.xlsx"),
  lumps: input("Lumps Planning as on 23-07-2026.xlsx"),
  production: input("PRODUCTION REPORT FROM  15-AUG-2025  (Autosaved).xlsx"),
};

const text = (value) => value == null ? "" : String(value).replace(/\s+/g, " ").trim();
const normalized = (value) => text(value).toLowerCase().replace(/[^a-z0-9]+/g, "");
const normalizedOrganization = (value) => normalized(text(value)
  .replace(/\([^)]*[0-9][^)]*\)\s*$/, "")
  .replace(/\b(private limited|pvt\.? ltd\.?|limited|ltd\.?|llp)\s*$/i, ""));
const normalizedLot = (value) => normalized(value);
const levenshtein = (left, right) => {
  let previous = Array.from({ length: right.length + 1 }, (_, index) => index);
  for (let i = 1; i <= left.length; i += 1) {
    const current = [i];
    for (let j = 1; j <= right.length; j += 1) current[j] = Math.min(
      current[j - 1] + 1,
      previous[j] + 1,
      previous[j - 1] + (left[i - 1] === right[j - 1] ? 0 : 1),
    );
    previous = current;
  }
  return previous[right.length];
};
const number = (value) => {
  const source = text(value).replace(/[₹,%\s,]/g, "");
  if (!source || source === "-" || /^-+$/.test(source)) return null;
  const parsed = Number(source);
  return Number.isFinite(parsed) ? parsed : null;
};
const integer = (value) => {
  const parsed = number(value);
  return parsed == null ? null : Math.trunc(parsed);
};
const date = (value) => {
  const source = text(value);
  if (!source) return null;
  const named = source.match(/^(\d{1,2})-([A-Za-z]{3})-(\d{2,4})$/);
  const numeric = source.match(/^(\d{1,2})\/(\d{1,2})\/(\d{2,4})$/);
  const months = { jan: 1, feb: 2, mar: 3, apr: 4, may: 5, jun: 6, jul: 7, aug: 8, sep: 9, oct: 10, nov: 11, dec: 12 };
  if (named) {
    const year = Number(named[3]) < 100 ? 2000 + Number(named[3]) : Number(named[3]);
    return `${year}-${String(months[named[2].toLowerCase()]).padStart(2, "0")}-${String(Number(named[1])).padStart(2, "0")}`;
  }
  if (numeric) {
    const year = Number(numeric[3]) < 100 ? 2000 + Number(numeric[3]) : Number(numeric[3]);
    return `${year}-${String(Number(numeric[1])).padStart(2, "0")}-${String(Number(numeric[2])).padStart(2, "0")}`;
  }
  if (/^\d{4}-\d{2}-\d{2}/.test(source)) return source.slice(0, 10);
  const parsed = new Date(source);
  return Number.isNaN(parsed.valueOf()) ? null : parsed.toISOString().slice(0, 10);
};
const businessKey = (...parts) => parts.map((part) => normalized(part) || "-").join("|");
const hash = (value) => crypto.createHash("sha256").update(value).digest("hex");
const status = (value) => {
  const key = normalized(value);
  if (key.includes("unlift")) return "unlifted";
  if (key.includes("unprocess")) return "unprocessed";
  if (key.includes("finish")) return "finished";
  if (key.includes("complete") || key.includes("close")) return "closed";
  return "unknown";
};
const paymentStatus = (value) => {
  const key = normalized(value);
  if (key.includes("return")) return "returned";
  if (key.includes("pending") || key.includes("unpaid")) return "unpaid";
  if (key.includes("partial")) return "partly_paid";
  if (key.includes("done") || key.includes("paid")) return "paid";
  return key ? "unknown" : null;
};

const severities = {
  MISSING_SOURCE_FILE: "critical",
  MISSING_REQUIRED_FIELD: "critical",
  INVALID_NUMBER: "critical",
  UNMAPPED_LOT: "critical",
  MISSING_SALES_ORDER: "critical",
  MISSING_DISPATCH_LOT: "critical",
  MISSING_PRODUCTION_LOT: "warning",
  SUMMARY_DETAIL_MISMATCH: "warning",
  STOCK_SNAPSHOT_MISMATCH: "warning",
  STOCK_AGGREGATE_MASS_BALANCE: "warning",
  TRANSPORT_MULTI_LOT: "warning",
  MISSING_PAYMENT_LEDGER: "warning",
  MISSING_AUCTION_BUYER_SOURCE: "warning",
  INVALID_QUALITY_RANGE: "critical",
  QUALITY_PLAUSIBILITY: "warning",
  INVALID_RECOVERY_RANGE: "critical",
  MISSING_DISPATCH_PERMIT: "critical",
  PERMIT_OVER_DISPATCH: "critical",
  ORDER_OVER_DISPATCH: "critical",
  NEGATIVE_REPORTED_BALANCE: "warning",
  STALE_SOURCE: "warning",
  PRODUCTION_MASS_BALANCE: "warning",
  DMG_STOCK_DIFFERENCE: "warning",
  QUANTITY_MAGNITUDE_JUMP: "warning",
  RATE_MAGNITUDE_JUMP: "warning",
  RECOVERY_OUTLIER: "warning",
  POSSIBLE_DUPLICATE_ORGANIZATION: "warning",
  QUALITY_INWARD_MISMATCH: "warning",
  PLANNING_STOCK_MISMATCH: "warning",
  DISPATCH_BEFORE_PO_DATE: "warning",
};

let runId;
let filesSeen = 0;
let rowsSeen = 0;
const staged = new Map();
const lotKeys = new Map();
const purchaseLotKeys = new Map();
const salesOrderLineKeys = new Map();
const permitKeys = new Map();
const receiptKeys = new Map();

async function one(sql, values = []) {
  const result = await client.query(sql, values);
  return result.rows[0];
}

async function issue(ruleCode, entityName, entityKey, sourceRowId, message, details = {}) {
  await client.query(`
    INSERT INTO governance.data_issue
      (import_run_id, rule_code, severity, entity_name, entity_key, source_row_id, message, details)
    VALUES ($1, $2, $3, $4, $5, $6, $7, $8::jsonb)
    ON CONFLICT DO NOTHING
  `, [runId, ruleCode, severities[ruleCode] || "warning", entityName, entityKey || null, sourceRowId || null, message, JSON.stringify(details)]);
}

async function stageFile(file, definitions) {
  const name = path.basename(file);
  const cadence = /daily/i.test(name) || /production report/i.test(name) ? "daily"
    : /weekly/i.test(name) || /work order/i.test(name) ? "weekly" : "event-driven";
  const maximumAgeHours = cadence === "daily" ? 36 : cadence === "weekly" ? 192 : null;
  for (const [sheetName, headerRow] of Object.entries(definitions)) {
    await client.query(`
      INSERT INTO governance.source_contract (workbook_name, sheet_name, header_row, cadence, maximum_age_hours)
      VALUES ($1, $2, $3, $4, $5)
      ON CONFLICT (workbook_name, sheet_name) DO UPDATE SET
        header_row = EXCLUDED.header_row, cadence = EXCLUDED.cadence,
        maximum_age_hours = EXCLUDED.maximum_age_hours, active = true
    `, [name, sheetName, headerRow, cadence, maximumAgeHours]);
  }
  if (!fs.existsSync(file)) {
    await issue("MISSING_SOURCE_FILE", "source_file", path.basename(file), null, `Required workbook ${path.basename(file)} is missing.`);
    for (const sheetName of Object.keys(definitions)) staged.set(`${file}:${sheetName}`, { rows: [], sourceRows: new Map(), fileId: null });
    return;
  }
  const buffer = fs.readFileSync(file);
  const stat = fs.statSync(file);
  if (maximumAgeHours && Date.now() - stat.mtimeMs > maximumAgeHours * 60 * 60 * 1000) {
    await issue("STALE_SOURCE", "source_file", name, null,
      `${name} is stale for its ${cadence} cadence; last modified ${stat.mtime.toISOString()}.`,
      { cadence, maximumAgeHours, fileModifiedAt: stat.mtime.toISOString() });
  }
  const workbook = XLSX.read(buffer, { type: "buffer", cellDates: true });
  const fileRecord = await one(`
    INSERT INTO governance.source_file
      (import_run_id, relative_path, file_name, file_hash, file_size_bytes, file_modified_at)
    VALUES ($1, $2, $3, $4, $5, $6)
    ON CONFLICT (file_hash) DO UPDATE SET import_run_id = EXCLUDED.import_run_id, received_at = now()
    RETURNING id
  `, [runId, path.relative(root, file), path.basename(file), hash(buffer), stat.size, stat.mtime]);
  filesSeen += 1;

  for (const [sheetName, headerRow] of Object.entries(definitions)) {
    const sheet = workbook.Sheets[sheetName];
    if (!sheet) {
      await issue("MISSING_REQUIRED_FIELD", "source_sheet", `${path.basename(file)}:${sheetName}`, null, `Required sheet ${sheetName} is missing from ${path.basename(file)}.`);
      staged.set(`${file}:${sheetName}`, { rows: [], sourceRows: new Map(), fileId: fileRecord.id });
      continue;
    }
    const rows = XLSX.utils.sheet_to_json(sheet, { header: 1, defval: null, raw: false, blankrows: true });
    const sourceRows = new Map();
    for (let index = 0; index < rows.length; index += 1) {
      const rawJson = JSON.stringify(rows[index]);
      const sourceRow = await one(`
        INSERT INTO raw.source_row (source_file_id, sheet_name, row_number, row_hash, raw_data)
        VALUES ($1, $2, $3, $4, $5::jsonb)
        ON CONFLICT (source_file_id, sheet_name, row_number) DO UPDATE SET
          row_hash = EXCLUDED.row_hash, raw_data = EXCLUDED.raw_data, imported_at = now()
        RETURNING id
      `, [fileRecord.id, sheetName, index + 1, hash(rawJson), rawJson]);
      sourceRows.set(index + 1, sourceRow.id);
      rowsSeen += 1;
    }
    staged.set(`${file}:${sheetName}`, { rows, sourceRows, fileId: fileRecord.id });
  }
}

const stagedSheet = (file, sheet) => staged.get(`${file}:${sheet}`) || { rows: [], sourceRows: new Map(), fileId: null };

async function organization(name, role, sourceRowId) {
  const legalName = text(name);
  if (!legalName) return null;
  const key = normalizedOrganization(legalName) || normalized(legalName);
  const record = await one(`
    INSERT INTO core.organization (organization_code, legal_name, normalized_name, source_row_id)
    VALUES ($1, $2, $3, $4)
    ON CONFLICT (normalized_name) DO UPDATE SET active = true
    RETURNING id
  `, [key, legalName, key, sourceRowId]);
  await client.query(`
    INSERT INTO core.organization_alias (organization_id, alias, normalized_alias, source_row_id)
    VALUES ($1, $2, $3, $4)
    ON CONFLICT (normalized_alias) DO NOTHING
  `, [record.id, legalName, normalized(legalName), sourceRowId]);
  if (role) await client.query(`
    INSERT INTO core.organization_role (organization_id, role, source_row_id)
    VALUES ($1, $2, $3)
    ON CONFLICT (organization_id, role) DO NOTHING
  `, [record.id, role, sourceRowId]);
  return record.id;
}

async function material(oreType, subType, size) {
  const description = `${text(oreType)} ${text(subType)} ${text(size)}`.toLowerCase();
  const mineral = /manganese|\bmn\b/.test(description) ? "manganese" : "iron_ore";
  const category = mineral === "manganese" ? "manganese"
    : /tail/.test(description) ? "tailings"
      : /clean|screen/.test(description) ? "cleaning_screening"
        : /lump/.test(description) ? "lump"
          : /fine/.test(description) ? "fine" : "other";
  const sizeSpec = text(size) || null;
  const code = `${mineral}:${category}:${normalized(sizeSpec) || "unspecified"}`;
  const record = await one(`
    INSERT INTO core.material (material_code, mineral, category, size_spec)
    VALUES ($1, $2, $3, $4)
    ON CONFLICT (material_code) DO UPDATE SET active = true
    RETURNING id
  `, [code, mineral, category, sizeSpec]);
  return record.id;
}

function rememberLot(key, id) {
  const normalizedKey = normalizedLot(key);
  if (!normalizedKey) return;
  const ids = lotKeys.get(normalizedKey) || new Set();
  ids.add(Number(id));
  lotKeys.set(normalizedKey, ids);
}

function findLot(key) {
  const ids = lotKeys.get(normalizedLot(key));
  return ids?.size === 1 ? [...ids][0] : null;
}

async function loadLotMaster() {
  const { rows, sourceRows } = stagedSheet(files.stock, "LOT MASTER");
  for (let index = 1; index < rows.length; index += 1) {
    const row = rows[index];
    const kejLot = text(row[0]);
    if (!kejLot) continue;
    const sourceRowId = sourceRows.get(index + 1);
    const materialId = await material(row[3], row[2], row[5]);
    const record = await one(`
      INSERT INTO core.lot
        (kej_lot_number, material_id, source_lot_number, description, lifecycle_status, source_row_id)
      VALUES ($1, $2, $3, $4, $5, $6)
      ON CONFLICT (kej_lot_number) DO UPDATE SET
        material_id = EXCLUDED.material_id,
        source_lot_number = EXCLUDED.source_lot_number,
        description = EXCLUDED.description,
        lifecycle_status = EXCLUDED.lifecycle_status,
        source_row_id = EXCLUDED.source_row_id
      RETURNING id
    `, [kejLot, materialId, text(row[6]) || null, text(row[4]) || null, status(row[1]), sourceRowId]);
    rememberLot(kejLot, record.id);
    for (const alias of [row[6], row[4]]) {
      if (!text(alias)) continue;
      rememberLot(alias, record.id);
      await client.query(`
        INSERT INTO core.lot_alias (lot_id, alias, normalized_alias, source_row_id)
        VALUES ($1, $2, $3, $4)
        ON CONFLICT (lot_id, normalized_alias) DO UPDATE SET source_row_id = EXCLUDED.source_row_id
      `, [record.id, text(alias), normalizedLot(alias), sourceRowId]);
    }
  }
}

async function loadBuyerMaster() {
  const { rows, sourceRows } = stagedSheet(files.buyers, "Buyer Type");
  for (let index = 1; index < rows.length; index += 1) {
    const row = rows[index];
    if (!text(row[0])) continue;
    const sourceRowId = sourceRows.get(index + 1);
    const organizationId = await organization(row[0], "customer", sourceRowId);
    const destination = text(row[7]);
    if (destination) await client.query(`
      INSERT INTO core.site (organization_id, site_code, name, normalized_name, site_type, address, source_row_id)
      VALUES ($1, $5, $2, $3, 'customer', $2, $4)
      ON CONFLICT (organization_id, normalized_name) DO UPDATE SET address = EXCLUDED.address
    `, [organizationId, destination, normalized(destination), sourceRowId, businessKey("site", organizationId, destination)]);
  }
}

async function loadStockSnapshot() {
  const { rows, sourceRows } = stagedSheet(files.stock, "IRON ORE");
  const snapshotDate = date(rows[0]?.[2]);
  if (!snapshotDate) {
    await issue("MISSING_REQUIRED_FIELD", "stock_snapshot", "snapshot-date", null, "IRON ORE snapshot date is missing.");
    return;
  }
  for (let index = 4; index < rows.length; index += 1) {
    const row = rows[index];
    const sourceRowId = sourceRows.get(index + 1);
    const lotId = findLot(row[1]);
    const quantity = number(row[2]);
    if (!text(row[1]) || quantity == null) continue;
    if (!lotId) {
      await issue("UNMAPPED_LOT", "stock_snapshot", text(row[1]), sourceRowId, `Stock snapshot lot ${text(row[1])} is not present in LOT MASTER.`);
      continue;
    }
    await client.query(`
      INSERT INTO core.stock_snapshot
        (snapshot_at, lot_id, recorded_quantity_mt, reported_fe_pct, reported_landed_cost_inr_per_mt, reported_status, source_row_id)
      VALUES ($1::date + time '23:59:59', $2, $3, $4, $5, $6, $7)
      ON CONFLICT (snapshot_at, lot_id, COALESCE(site_id, 0)) DO UPDATE SET
        recorded_quantity_mt = EXCLUDED.recorded_quantity_mt,
        reported_fe_pct = EXCLUDED.reported_fe_pct,
        reported_landed_cost_inr_per_mt = EXCLUDED.reported_landed_cost_inr_per_mt,
        reported_status = EXCLUDED.reported_status,
        source_row_id = EXCLUDED.source_row_id
    `, [snapshotDate, lotId, quantity, number(row[5]), number(row[9]), text(row[10]) || null, sourceRowId]);
    const landedCost = number(row[9]);
    if (landedCost != null) await client.query(`
      INSERT INTO core.lot_cost_component
        (business_key, lot_id, component_code, rate_inr_per_mt, effective_on, included_in_landed_cost, approval_status, source_row_id)
      VALUES ($1, $2, 'REPORTED_LANDED_COST', $3, $4, false, 'reported', $5)
      ON CONFLICT (business_key) DO UPDATE SET
        rate_inr_per_mt = EXCLUDED.rate_inr_per_mt,
        source_row_id = EXCLUDED.source_row_id
    `, [businessKey("snapshot-cost", lotId, snapshotDate), lotId, landedCost, snapshotDate, sourceRowId]);
  }
}

async function loadInventoryMovements() {
  const { rows, sourceRows } = stagedSheet(files.stock, "DAILY BOOKS");
  for (let index = 1; index < rows.length; index += 1) {
    const row = rows[index];
    const sourceRowId = sourceRows.get(index + 1);
    const eventDate = date(row[0]);
    const lotText = text(row[1]);
    const lotId = findLot(lotText);
    const inward = number(row[5]);
    const outward = number(row[6]);
    if (!eventDate || !lotText || (inward == null && outward == null)) continue;
    if (!lotId) {
      await issue("UNMAPPED_LOT", "inventory_movement", lotText, sourceRowId, `DAILY BOOKS lot ${lotText} is not present in LOT MASTER.`);
      continue;
    }
    const eventText = normalized(row[4]);
    const eventType = eventText.includes("opening") ? "opening"
      : eventText.includes("feed") ? "production_feed"
        : eventText.includes("produc") || eventText.includes("finish") ? "production_output"
          : eventText.includes("outward") || eventText.includes("dispatch") ? "customer_dispatch"
            : eventText.includes("inward") ? "inward_receipt"
              : eventText.includes("transfer") ? "transfer"
                : eventText.includes("short") || eventText.includes("loss") ? "shortage_loss" : "other";
    for (const [direction, quantity] of [["in", inward], ["out", outward]]) {
      if (quantity == null || quantity === 0) continue;
      const key = businessKey("book", eventDate, lotText, row[4], direction, quantity, row[25], index + 1);
      await client.query(`
        INSERT INTO core.inventory_movement
          (business_key, occurred_at, event_type, lot_id, direction, quantity_mt, reference_type, reference_key, source_row_id)
        VALUES ($1, $2::date + time '12:00:00', $3, $4, $5, $6, 'daily_books', $7, $8)
        ON CONFLICT (business_key) DO UPDATE SET
          quantity_mt = EXCLUDED.quantity_mt, source_row_id = EXCLUDED.source_row_id
      `, [key, eventDate, eventType, lotId, direction, Math.abs(quantity), text(row[25]) || null, sourceRowId]);
    }
  }
}

async function addQualitySample({ key, sampleDate, sampleType, lotId, sourceLot, representedQuantity, sourceRowId, measurements, inwardReceiptId = null, dispatchId = null, productionRunId = null, approved = true }) {
  const plausibleBands = {
    FE: [30, 72.5], SIO2: [0, 70], AL2O3: [0, 25], LOI: [-5, 30],
    P: [0, 5], MOISTURE: [0, 30], MN: [0, 80], MASS_BALANCE: [80, 105],
  };
  const clean = {};
  for (const [code, value] of Object.entries(measurements)) {
    if (value == null) continue;
    if (value < 0 || value > 100) {
      await issue("INVALID_QUALITY_RANGE", "quality_sample", key, sourceRowId, `${code} value ${value} is outside 0 to 100%.`, { code, value });
    } else {
      clean[code] = value;
      const band = plausibleBands[code];
      if (band && (value < band[0] || value > band[1])) await issue("QUALITY_PLAUSIBILITY", "quality_sample", key, sourceRowId,
        `${code} value ${value}% is outside the provisional plausible band ${band[0]}–${band[1]}%.`,
        { code, value, provisionalBand: band, clientApprovalRequired: true });
    }
  }
  const sample = await one(`
    INSERT INTO core.quality_sample
      (business_key, sample_at, sample_stage, lot_id, source_lot_number, inward_receipt_id, dispatch_id,
       production_run_id, represented_quantity_mt, fe_pct, sio2_pct, al2o3_pct, loi_pct, p_pct,
       moisture_pct, mn_pct, mass_balance_pct, approved, source_row_id)
    VALUES ($1, $2::date + time '12:00:00', $3, $4, $5, $6, $7, $8, $9,
            $10, $11, $12, $13, $14, $15, $16, $17, $18, $19)
    ON CONFLICT (business_key) DO UPDATE SET
      lot_id = EXCLUDED.lot_id,
      inward_receipt_id = EXCLUDED.inward_receipt_id,
      dispatch_id = EXCLUDED.dispatch_id,
      represented_quantity_mt = EXCLUDED.represented_quantity_mt,
      fe_pct = EXCLUDED.fe_pct,
      sio2_pct = EXCLUDED.sio2_pct,
      al2o3_pct = EXCLUDED.al2o3_pct,
      loi_pct = EXCLUDED.loi_pct,
      p_pct = EXCLUDED.p_pct,
      moisture_pct = EXCLUDED.moisture_pct,
      mass_balance_pct = EXCLUDED.mass_balance_pct,
      approved = EXCLUDED.approved,
      source_row_id = EXCLUDED.source_row_id
    RETURNING id
  `, [key, sampleDate, sampleType, lotId, sourceLot || null, inwardReceiptId, dispatchId, productionRunId,
    representedQuantity, clean.FE, clean.SIO2, clean.AL2O3, clean.LOI, clean.P, clean.MOISTURE,
    clean.MN, clean.MASS_BALANCE, approved, sourceRowId]);
  return sample.id;
}

async function loadPurchases() {
  const { rows, sourceRows } = stagedSheet(files.inward, "Purchased Details");
  for (let index = 2; index < rows.length; index += 1) {
    const row = rows[index];
    const sourceRowId = sourceRows.get(index + 1);
    const supplierName = text(row[3]);
    const sourceLot = text(row[4]);
    const purchaseDate = date(row[0]);
    const purchased = number(row[5]);
    if (!supplierName || !sourceLot || !purchaseDate || purchased == null) continue;
    const supplierId = await organization(supplierName, "supplier", sourceRowId);
    const lotId = findLot(sourceLot);
    if (!lotId) await issue("UNMAPPED_LOT", "purchase_lot", sourceLot, sourceRowId, `Purchased source lot ${sourceLot} is not mapped to a KEJ lot.`);
    const materialId = await material(row[1], row[2], row[16]);
    const purchaseKey = businessKey("purchase-lot", supplierName, sourceLot, purchaseDate);
    const purchaseLot = await one(`
      INSERT INTO core.purchase_lot
        (business_key, supplier_id, lot_id, source_lot_number, material_id, purchase_date, purchased_quantity_mt,
         purchase_rate_inr_per_mt, reported_landed_cost_inr_per_mt, reported_lifted_quantity_mt,
         reported_balance_to_lift_mt, reported_payment_balance_mt, reported_permit_balance_mt,
         reported_payment_status, status, source_row_id)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16)
      ON CONFLICT (business_key) DO UPDATE SET
        lot_id = EXCLUDED.lot_id,
        purchased_quantity_mt = EXCLUDED.purchased_quantity_mt,
        purchase_rate_inr_per_mt = EXCLUDED.purchase_rate_inr_per_mt,
        reported_landed_cost_inr_per_mt = EXCLUDED.reported_landed_cost_inr_per_mt,
        reported_lifted_quantity_mt = EXCLUDED.reported_lifted_quantity_mt,
        reported_balance_to_lift_mt = EXCLUDED.reported_balance_to_lift_mt,
        reported_payment_balance_mt = EXCLUDED.reported_payment_balance_mt,
        reported_permit_balance_mt = EXCLUDED.reported_permit_balance_mt,
        reported_payment_status = EXCLUDED.reported_payment_status,
        status = EXCLUDED.status,
        updated_at = now(),
        source_row_id = EXCLUDED.source_row_id
      RETURNING id
    `, [purchaseKey, supplierId, lotId, sourceLot, materialId, purchaseDate, purchased, number(row[6]), number(row[7]), number(row[9]), number(row[10]), number(row[14]), number(row[15]), paymentStatus(row[20]), normalized(row[19]).includes("complete") ? "completed" : "open", sourceRowId]);
    purchaseLotKeys.set(`${supplierId}:${normalizedLot(sourceLot)}`, purchaseLot.id);
    if (lotId) await client.query("UPDATE core.lot SET supplier_id = COALESCE(supplier_id, $2), updated_at = now() WHERE id = $1", [lotId, supplierId]);
    if (lotId && number(row[7]) != null) await client.query(`
      INSERT INTO core.lot_cost_component
        (business_key, lot_id, component_code, rate_inr_per_mt, effective_on, included_in_landed_cost, approval_status, source_row_id)
      VALUES ($1, $2, 'REPORTED_LANDED_COST', $3, $4, false, 'reported', $5)
      ON CONFLICT (business_key) DO UPDATE SET
        rate_inr_per_mt = EXCLUDED.rate_inr_per_mt, source_row_id = EXCLUDED.source_row_id
    `, [businessKey("purchase-cost", lotId, purchaseDate), lotId, number(row[7]), purchaseDate, sourceRowId]);
    if (number(row[8]) != null) await addQualitySample({
      key: businessKey("indicative", supplierName, sourceLot, purchaseDate),
      sampleDate: purchaseDate,
      sampleType: "indicative",
      lotId,
      sourceLot,
      representedQuantity: purchased,
      sourceRowId,
      measurements: { FE: number(row[8]) },
    });
  }
}

async function loadInwardPermits() {
  const { rows, sourceRows } = stagedSheet(files.inward, "Permit Detail's");
  for (let index = 1; index < rows.length; index += 1) {
    const row = rows[index];
    const permitNumber = text(row[4]);
    if (!permitNumber) continue;
    const sourceRowId = sourceRows.get(index + 1);
    const supplierId = await organization(row[0], "supplier", sourceRowId);
    const materialId = await material(row[9], row[9], null);
    const purchaseLotId = purchaseLotKeys.get(`${supplierId}:${normalizedLot(row[1])}`) || null;
    const permit = await one(`
      INSERT INTO core.permit
        (permit_number, direction, organization_id, purchase_lot_id, issued_on, permitted_quantity_mt, material_id, status, source_row_id)
      VALUES ($1, 'inward', $2, $3, $4, $5, $6, $7, $8)
      ON CONFLICT (permit_number, direction) DO UPDATE SET
        purchase_lot_id = EXCLUDED.purchase_lot_id,
        permitted_quantity_mt = EXCLUDED.permitted_quantity_mt,
        status = EXCLUDED.status,
        source_row_id = EXCLUDED.source_row_id
      RETURNING id
    `, [permitNumber, supplierId, purchaseLotId, date(row[5]), number(row[3]), materialId, text(row[7]) || "unknown", sourceRowId]);
    permitKeys.set(permitNumber, permit.id);
  }
}

async function loadInwardReceipts() {
  const { rows, sourceRows } = stagedSheet(files.inward, "Daily Inward Details");
  for (let index = 1; index < rows.length; index += 1) {
    const row = rows[index];
    const receiptDate = date(row[0]);
    const supplierName = text(row[2]);
    const sourceLot = text(row[3]);
    const quantity = number(row[4]);
    if (!receiptDate || !supplierName || !sourceLot || quantity == null) continue;
    const sourceRowId = sourceRows.get(index + 1);
    const supplierId = await organization(supplierName, "supplier", sourceRowId);
    const lotId = findLot(sourceLot);
    if (!lotId) await issue("UNMAPPED_LOT", "inward_receipt", sourceLot, sourceRowId, `Inward source lot ${sourceLot} is not mapped to a KEJ lot.`);
    const permitNumber = text(row[6]);
    const key = businessKey("inward", receiptDate, supplierName, sourceLot, permitNumber, quantity, row[5]);
    const receipt = await one(`
      INSERT INTO core.inward_receipt
        (business_key, receipt_at, purchase_lot_id, lot_id, source_lot_number, permit_id, supplier_id, quantity_mt, trip_count, source_row_id)
      VALUES ($1,$2::date + time '12:00:00',$3,$4,$5,$6,$7,$8,$9,$10)
      ON CONFLICT (business_key) DO UPDATE SET
        purchase_lot_id = EXCLUDED.purchase_lot_id,
        lot_id = EXCLUDED.lot_id,
        permit_id = EXCLUDED.permit_id,
        quantity_mt = EXCLUDED.quantity_mt,
        trip_count = EXCLUDED.trip_count,
        source_row_id = EXCLUDED.source_row_id
      RETURNING id
    `, [key, receiptDate, purchaseLotKeys.get(`${supplierId}:${normalizedLot(sourceLot)}`) || null, lotId, sourceLot, permitKeys.get(permitNumber) || null, supplierId, quantity, integer(row[5]), sourceRowId]);
    receiptKeys.set(`${receiptDate}:${normalizedLot(sourceLot)}`, receipt.id);
  }
}

async function loadSalesOrders() {
  const { rows, sourceRows } = stagedSheet(files.outward, "Outward Details");
  for (let index = 2; index < rows.length; index += 1) {
    const row = rows[index];
    const customerName = text(row[0]);
    const poNumber = text(row[3]);
    const poDate = date(row[4]);
    const ordered = number(row[9]);
    if (!customerName || !poNumber || !poDate || ordered == null) continue;
    const sourceRowId = sourceRows.get(index + 1);
    const customerId = await organization(customerName, "customer", sourceRowId);
    const materialId = await material(row[1], row[2], row[13]);
    const lineKey = businessKey("sales-line", customerName, poNumber, row[2], row[13]);
    const line = await one(`
      INSERT INTO core.sales_order_line
        (business_key, customer_id, po_number, po_date, material_id, ordered_quantity_mt, selling_rate_inr_per_mt,
         target_fe_pct, size_spec, reported_dispatched_quantity_mt, reported_balance_to_dispatch_mt, status, source_row_id)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)
      ON CONFLICT (business_key) DO UPDATE SET
        po_date = EXCLUDED.po_date,
        ordered_quantity_mt = EXCLUDED.ordered_quantity_mt,
        selling_rate_inr_per_mt = EXCLUDED.selling_rate_inr_per_mt,
        target_fe_pct = EXCLUDED.target_fe_pct,
        reported_dispatched_quantity_mt = EXCLUDED.reported_dispatched_quantity_mt,
        reported_balance_to_dispatch_mt = EXCLUDED.reported_balance_to_dispatch_mt,
        status = EXCLUDED.status,
        updated_at = now(),
        source_row_id = EXCLUDED.source_row_id
      RETURNING id
    `, [lineKey, customerId, poNumber, poDate, materialId, ordered, number(row[8]), number(row[5]), text(row[13]) || null, number(row[10]), number(row[12]), normalized(row[18]).includes("complete") ? "completed" : "open", sourceRowId]);
    salesOrderLineKeys.set(`${customerId}:${normalized(poNumber)}`, line.id);
  }
}

async function loadOutwardPermits() {
  const { rows, sourceRows } = stagedSheet(files.outward, "Permit Detail's");
  for (let index = 1; index < rows.length; index += 1) {
    const row = rows[index];
    const permitNumber = text(row[3]);
    if (!permitNumber) continue;
    const sourceRowId = sourceRows.get(index + 1);
    const customerId = await organization(row[0], "customer", sourceRowId);
    const materialId = await material(row[9], row[9], null);
    const orderLineId = salesOrderLineKeys.get(`${customerId}:${normalized(row[2])}`) || null;
    const permit = await one(`
      INSERT INTO core.permit
        (permit_number, direction, organization_id, sales_order_line_id, issued_on, permitted_quantity_mt, material_id, status, source_row_id)
      VALUES ($1, 'outward', $2, $3, $4, $5, $6, $7, $8)
      ON CONFLICT (permit_number, direction) DO UPDATE SET
        sales_order_line_id = EXCLUDED.sales_order_line_id,
        permitted_quantity_mt = EXCLUDED.permitted_quantity_mt,
        status = EXCLUDED.status,
        source_row_id = EXCLUDED.source_row_id
      RETURNING id
    `, [permitNumber, customerId, orderLineId, date(row[4]), number(row[5]), materialId, text(row[7]) || "unknown", sourceRowId]);
    permitKeys.set(permitNumber, permit.id);
  }
}

async function loadDispatches() {
  const { rows, sourceRows } = stagedSheet(files.outward, "Daily Outward Detail's");
  for (let index = 1; index < rows.length; index += 1) {
    const row = rows[index];
    const dispatchDate = date(row[0]);
    const customerName = text(row[1]);
    const poNumber = text(row[2]);
    const quantity = number(row[3]);
    if (!dispatchDate || !customerName || !poNumber || quantity == null) continue;
    const sourceRowId = sourceRows.get(index + 1);
    const customerId = await organization(customerName, "customer", sourceRowId);
    const orderLineId = salesOrderLineKeys.get(`${customerId}:${normalized(poNumber)}`) || null;
    if (!orderLineId) await issue("MISSING_SALES_ORDER", "dispatch", `${customerName}:${poNumber}`, sourceRowId, `Dispatch for PO ${poNumber} cannot be connected to Outward Details.`);
    const permitNumber = text(row[5]);
    const permitId = permitKeys.get(permitNumber) || null;
    const key = businessKey("dispatch", dispatchDate, customerName, poNumber, permitNumber, quantity, row[4]);
    if (!permitNumber || !permitId) await issue("MISSING_DISPATCH_PERMIT", "dispatch", key, sourceRowId,
      permitNumber ? `Dispatch permit ${permitNumber} does not resolve to the outward permit register.` : `Dispatch for PO ${poNumber} has no permit number.`);
    const dispatch = await one(`
      INSERT INTO core.dispatch
        (business_key, dispatch_at, sales_order_line_id, customer_id, lot_id, permit_id, quantity_mt, vehicle_count, source_row_id)
      VALUES ($1,$2::date + time '12:00:00',$3,$4,NULL,$5,$6,$7,$8)
      ON CONFLICT (business_key) DO UPDATE SET
        sales_order_line_id = EXCLUDED.sales_order_line_id,
        permit_id = EXCLUDED.permit_id,
        quantity_mt = EXCLUDED.quantity_mt,
        vehicle_count = EXCLUDED.vehicle_count,
        source_row_id = EXCLUDED.source_row_id
      RETURNING id
    `, [key, dispatchDate, orderLineId, customerId, permitId, quantity, integer(row[4]), sourceRowId]);
    await issue("MISSING_DISPATCH_LOT", "dispatch", key, sourceRowId, `Dispatch for PO ${poNumber} has no KEJ lot number in Daily Outward Detail's.`);
    await addQualitySample({
      key: businessKey("dispatch-quality", key),
      sampleDate: dispatchDate,
      sampleType: "dispatch",
      lotId: null,
      sourceLot: null,
      representedQuantity: quantity,
      sourceRowId,
      dispatchId: dispatch.id,
      measurements: { FE: number(row[10]), MOISTURE: number(row[11]), SIO2: number(row[12]), AL2O3: number(row[13]), P: number(row[14]), LOI: number(row[15]) },
    });
  }
}

async function loadInwardQuality() {
  const { rows, sourceRows } = stagedSheet(files.quality, "Inward Quality Report");
  for (let index = 1; index < rows.length; index += 1) {
    const row = rows[index];
    const sampleDate = date(row[0]);
    const sourceLot = text(row[2]);
    if (!sampleDate || !sourceLot) continue;
    const sourceRowId = sourceRows.get(index + 1);
    const lotId = findLot(sourceLot);
    if (!lotId) await issue("UNMAPPED_LOT", "quality_sample", sourceLot, sourceRowId, `Quality result for ${sourceLot} is not mapped to a KEJ lot.`);
    await addQualitySample({
      key: businessKey("inward-quality", sampleDate, sourceLot, row[7], index + 1),
      sampleDate,
      sampleType: "inward",
      lotId,
      sourceLot,
      representedQuantity: number(row[7]),
      sourceRowId,
      inwardReceiptId: receiptKeys.get(`${sampleDate}:${normalizedLot(sourceLot)}`) || null,
      measurements: {
        FE: number(row[12]), SIO2: number(row[13]), AL2O3: number(row[14]), LOI: number(row[15]),
        P: number(row[16]), MOISTURE: number(row[19]), MASS_BALANCE: number(row[30]),
      },
    });
    if (number(row[10]) != null) await addQualitySample({
      key: businessKey("inward-quality-indicative", sampleDate, sourceLot, index + 1),
      sampleDate,
      sampleType: "indicative",
      lotId,
      sourceLot,
      representedQuantity: number(row[7]),
      sourceRowId,
      measurements: { FE: number(row[10]) },
    });
  }
}

async function loadAuctions() {
  const { rows, sourceRows } = stagedSheet(files.auction, "Consolidated Data");
  for (let index = 1; index < rows.length; index += 1) {
    const row = rows[index];
    const auctionNumber = text(row[1]);
    const externalLot = text(row[2]);
    if (!auctionNumber || !externalLot) continue;
    const sourceRowId = sourceRows.get(index + 1);
    const sellerId = text(row[19]) ? await organization(row[19], "mine_owner", sourceRowId) : null;
    const closingDate = date(row[0]);
    let siteId = null;
    if (text(row[3])) {
      const site = await one(`
        INSERT INTO core.site (organization_id, site_code, name, normalized_name, site_type, source_row_id)
        VALUES ($1,$5,$2,$3,'mine',$4)
        ON CONFLICT (organization_id, normalized_name) DO UPDATE SET source_row_id = EXCLUDED.source_row_id
        RETURNING id
      `, [sellerId, text(row[3]), normalized(row[3]), sourceRowId, businessKey("site", sellerId, row[3])]);
      siteId = site.id;
    }
    const materialId = await material("iron ore", row[4], row[4]);
    const key = businessKey("auction-lot", auctionNumber, externalLot);
    await client.query(`
      INSERT INTO core.auction_lot
        (business_key, auction_number, external_lot_number, closes_at, seller_id, site_id, material_id,
         offered_quantity_mt, sold_quantity_mt, indicative_fe_pct, opening_price_inr_per_mt,
         current_price_inr_per_mt, reported_landed_price_inr_per_mt, reported_premium_pct, source_row_id)
      VALUES ($1,$2,$3,$4::date + time '23:59:59',$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15)
      ON CONFLICT (business_key) DO UPDATE SET
        closes_at = EXCLUDED.closes_at,
        seller_id = EXCLUDED.seller_id,
        site_id = EXCLUDED.site_id,
        offered_quantity_mt = EXCLUDED.offered_quantity_mt,
        sold_quantity_mt = EXCLUDED.sold_quantity_mt,
        indicative_fe_pct = EXCLUDED.indicative_fe_pct,
        opening_price_inr_per_mt = EXCLUDED.opening_price_inr_per_mt,
        current_price_inr_per_mt = EXCLUDED.current_price_inr_per_mt,
        reported_landed_price_inr_per_mt = EXCLUDED.reported_landed_price_inr_per_mt,
        reported_premium_pct = EXCLUDED.reported_premium_pct,
        source_row_id = EXCLUDED.source_row_id
    `, [key, auctionNumber, externalLot, closingDate, sellerId, siteId, materialId, number(row[7]), number(row[9]), number(row[5]), number(row[11]), number(row[12]), number(row[14]), number(row[16]), sourceRowId]);
  }
}

async function loadTransportWorkOrders() {
  const { rows, sourceRows } = stagedSheet(files.transport, "INWARD FINAL 26-27");
  for (let index = 2; index < rows.length; index += 1) {
    const row = rows[index];
    const workOrderNumber = text(row[0]);
    const transporterName = text(row[5]);
    if (!workOrderNumber || !transporterName) continue;
    const sourceRowId = sourceRows.get(index + 1);
    await organization(transporterName, "transporter", sourceRowId);
    const financialYear = text(row[1]) || "unknown";
    const key = businessKey("transport-work-order", financialYear, workOrderNumber);
    const mineName = text(row[7]);
    if (mineName) {
      const mineOwnerId = await organization(mineName, "mine_owner", sourceRowId);
      await client.query(`
        INSERT INTO core.site (organization_id, site_code, name, normalized_name, site_type, source_row_id)
        VALUES ($1,$5,$2,$3,'mine',$4)
        ON CONFLICT (organization_id, normalized_name) DO UPDATE SET source_row_id = EXCLUDED.source_row_id
      `, [mineOwnerId, mineName, normalized(mineName), sourceRowId, businessKey("site", mineOwnerId, mineName)]);
    }
    const sourceLotText = text(row[9]);
    if (/[+,&]/.test(sourceLotText) || /[+]/.test(text(row[8]))) {
      await issue("TRANSPORT_MULTI_LOT", "transport_work_order", key, sourceRowId, `Work order ${workOrderNumber} contains combined lot or quantity values that require a client-approved split.`, { quantity: text(row[8]), lots: sourceLotText });
    }
    const lotId = findLot(sourceLotText);
    const rate = number(row[11]);
    const effectiveOn = date(row[2]);
    if (lotId && rate != null && effectiveOn) await client.query(`
      INSERT INTO core.lot_cost_component
        (business_key, lot_id, component_code, rate_inr_per_mt, effective_on, included_in_landed_cost, approval_status, source_row_id)
      VALUES ($1,$2,'INWARD_TRANSPORT',$3,$4,false,'reported',$5)
      ON CONFLICT (business_key) DO UPDATE SET rate_inr_per_mt = EXCLUDED.rate_inr_per_mt, source_row_id = EXCLUDED.source_row_id
    `, [businessKey(key, sourceLotText), lotId, rate, effectiveOn, sourceRowId]);
  }
}

async function loadProduction() {
  const { rows, sourceRows } = stagedSheet(files.production, "PRODUCTION AND RECOVERY");
  for (let index = 4; index < rows.length; index += 1) {
    const row = rows[index];
    const runDate = date(row[0]);
    const materialName = text(row[4]);
    const feed = number(row[5]);
    if (!runDate || !materialName || feed == null) continue;
    const sourceRowId = sourceRows.get(index + 1);
    const inputLotId = findLot(materialName);
    const key = businessKey("production", runDate, row[1], row[2], materialName, index + 1);
    const reportedRecovery = number(row[41]);
    if (reportedRecovery != null && (reportedRecovery < 0 || reportedRecovery > 100)) {
      await issue("INVALID_RECOVERY_RANGE", "production_run", key, sourceRowId, `Reported recovery ${reportedRecovery}% is outside 0 to 100%.`, { reportedRecovery });
    }
    const run = await one(`
      INSERT INTO core.production_run
        (business_key, run_date, shift, process, source_material_name, reported_recovery_pct, source_row_id)
      VALUES ($1,$2,$3,$4,$5,$6,$7)
      ON CONFLICT (business_key) DO UPDATE SET
        reported_recovery_pct = EXCLUDED.reported_recovery_pct,
        source_row_id = EXCLUDED.source_row_id
      RETURNING id
    `, [key, runDate, text(row[1]) || null, `${text(row[2])} ${text(row[3])}`.trim() || null, materialName, reportedRecovery, sourceRowId]);
    await client.query(`
      INSERT INTO core.production_input (production_run_id, lot_id, quantity_mt, source_row_id)
      VALUES ($1,$2,$3,$4) ON CONFLICT DO NOTHING
    `, [run.id, inputLotId, feed, sourceRowId]);
    if (!inputLotId) await issue("MISSING_PRODUCTION_LOT", "production_run", key, sourceRowId, `Production material ${materialName} is not linked to a stable KEJ input lot.`);
    const recovered = number(row[40]) ?? number(row[32]);
    if (recovered != null) {
      const materialId = await material(row[3], row[3], null);
      await client.query(`
        INSERT INTO core.production_output
          (production_run_id, lot_id, material_id, output_type, quantity_mt, source_row_id)
        VALUES ($1,NULL,$2,'recovered_total',$3,$4) ON CONFLICT DO NOTHING
      `, [run.id, materialId, recovered, sourceRowId]);
    }
    const tailings = number(row[29]);
    if (tailings != null && tailings > 0) {
      const tailMaterialId = await material("iron ore", "tailings", null);
      await client.query(`
        INSERT INTO core.production_output
          (production_run_id, lot_id, material_id, output_type, quantity_mt, source_row_id)
        VALUES ($1,NULL,$2,'tailings',$3,$4) ON CONFLICT DO NOTHING
      `, [run.id, tailMaterialId, tailings, sourceRowId]);
    }
  }
}

async function runReconciliations() {
  const purchaseRows = (await client.query(`
    SELECT pl.id, pl.source_row_id, pl.reported_lifted_quantity_mt,
      COALESCE(SUM(ir.quantity_mt), 0) AS calculated_quantity_mt
    FROM core.purchase_lot pl
    LEFT JOIN core.inward_receipt ir ON ir.purchase_lot_id = pl.id
    GROUP BY pl.id
  `)).rows;
  for (const row of purchaseRows) {
    if (row.reported_lifted_quantity_mt != null && Math.abs(Number(row.reported_lifted_quantity_mt) - Number(row.calculated_quantity_mt)) > 0.05) {
      await issue("SUMMARY_DETAIL_MISMATCH", "purchase_lot", row.id, row.source_row_id,
        `Reported lifted quantity ${row.reported_lifted_quantity_mt} MT differs from calculated inward receipts ${row.calculated_quantity_mt} MT.`);
    }
  }

  const salesRows = (await client.query(`
    SELECT sol.id, sol.source_row_id, sol.ordered_quantity_mt, sol.reported_dispatched_quantity_mt,
      COALESCE(SUM(d.quantity_mt), 0) AS calculated_quantity_mt
    FROM core.sales_order_line sol
    LEFT JOIN core.dispatch d ON d.sales_order_line_id = sol.id
    GROUP BY sol.id
  `)).rows;
  for (const row of salesRows) {
    if (row.reported_dispatched_quantity_mt != null && Math.abs(Number(row.reported_dispatched_quantity_mt) - Number(row.calculated_quantity_mt)) > 0.05) {
      await issue("SUMMARY_DETAIL_MISMATCH", "sales_order_line", row.id, row.source_row_id,
        `Reported dispatched quantity ${row.reported_dispatched_quantity_mt} MT differs from calculated dispatches ${row.calculated_quantity_mt} MT.`);
    }
    if (Number(row.calculated_quantity_mt) > Number(row.ordered_quantity_mt) + 0.05) {
      await issue("ORDER_OVER_DISPATCH", "sales_order_line", row.id, row.source_row_id,
        `Calculated dispatch ${row.calculated_quantity_mt} MT exceeds ordered quantity ${row.ordered_quantity_mt} MT.`);
    }
  }

  const backdatedRows = (await client.query(`
    SELECT sol.id, sol.po_number, sol.po_date::text AS po_date, sol.source_row_id,
      min(d.dispatch_at::date)::text AS first_dispatch_on
    FROM core.sales_order_line sol
    JOIN core.dispatch d ON d.sales_order_line_id = sol.id
    GROUP BY sol.id
    HAVING min(d.dispatch_at::date) < sol.po_date
  `)).rows;
  for (const row of backdatedRows) {
    await issue("DISPATCH_BEFORE_PO_DATE", "sales_order_line", row.id, row.source_row_id,
      `PO ${row.po_number} is dated ${row.po_date} but its first dispatch happened on ${row.first_dispatch_on}; the PO date looks wrong and lead-time rankings must exclude it.`,
      { poDate: row.po_date, firstDispatchOn: row.first_dispatch_on });
  }

  const snapshotRows = (await client.query(`
    WITH latest AS (SELECT max(snapshot_at) AS snapshot_at FROM core.stock_snapshot), movement AS (
      SELECT im.lot_id,
        SUM(CASE im.direction WHEN 'in' THEN im.quantity_mt ELSE -im.quantity_mt END) AS calculated_quantity_mt
      FROM core.inventory_movement im, latest
      WHERE im.occurred_at <= latest.snapshot_at
      GROUP BY im.lot_id
    )
    SELECT ss.lot_id, ss.source_row_id, ss.recorded_quantity_mt,
      COALESCE(m.calculated_quantity_mt, 0) AS calculated_quantity_mt
    FROM core.stock_snapshot ss
    JOIN latest ON latest.snapshot_at = ss.snapshot_at
    LEFT JOIN movement m ON m.lot_id = ss.lot_id
  `)).rows;
  for (const row of snapshotRows) {
    if (Math.abs(Number(row.recorded_quantity_mt) - Number(row.calculated_quantity_mt)) > 0.05) {
      await issue("STOCK_SNAPSHOT_MISMATCH", "lot", row.lot_id, row.source_row_id,
        `Snapshot quantity ${row.recorded_quantity_mt} MT differs from movement quantity ${row.calculated_quantity_mt} MT.`);
    }
  }
  if (snapshotRows.length) {
    const recorded = snapshotRows.reduce((total, row) => total + Number(row.recorded_quantity_mt), 0);
    const calculated = snapshotRows.reduce((total, row) => total + Number(row.calculated_quantity_mt), 0);
    const tolerance = Math.max(0.05, recorded * 0.001);
    if (Math.abs(recorded - calculated) > tolerance) await issue("STOCK_AGGREGATE_MASS_BALANCE", "stock_snapshot", "latest-aggregate", snapshotRows[0].source_row_id,
      `Aggregate closing stock ${recorded.toFixed(3)} MT does not reconcile with opening + inward − outward − feed + produced ${calculated.toFixed(3)} MT within ${tolerance.toFixed(3)} MT.`,
      { recordedClosingMT: recorded, calculatedClosingMT: calculated, toleranceMT: tolerance, provisionalTolerance: "greater of 0.05 MT or 0.1%" });
  }

  const permitRows = (await client.query(`
    SELECT p.id, p.permit_number, p.source_row_id, p.permitted_quantity_mt,
      COALESCE(SUM(d.quantity_mt), 0) AS dispatched_quantity_mt
    FROM core.permit p LEFT JOIN core.dispatch d ON d.permit_id=p.id
    WHERE p.direction='outward'
    GROUP BY p.id
  `)).rows;
  for (const row of permitRows) {
    if (row.permitted_quantity_mt != null && Number(row.dispatched_quantity_mt) > Number(row.permitted_quantity_mt) + 0.05) {
      await issue("PERMIT_OVER_DISPATCH", "permit", row.permit_number, row.source_row_id,
        `Dispatch ${row.dispatched_quantity_mt} MT exceeds permit quantity ${row.permitted_quantity_mt} MT.`);
    }
  }

  const productionBalances = (await client.query(`
    SELECT production_run_id, source_row_id, feed_quantity_mt, recovered_quantity_mt, tailings_quantity_mt
    FROM analytics.production_recovery WHERE feed_quantity_mt > 0
  `)).rows;
  for (const row of productionBalances) {
    const feed = Number(row.feed_quantity_mt);
    const output = Number(row.recovered_quantity_mt || 0) + Number(row.tailings_quantity_mt || 0);
    const tolerance = Math.max(0.05, feed * 0.01);
    if (Math.abs(feed - output) > tolerance) await issue("PRODUCTION_MASS_BALANCE", "production_run", row.production_run_id, row.source_row_id,
      `Feed ${feed.toFixed(3)} MT does not reconcile with produced plus tailings ${output.toFixed(3)} MT within ${tolerance.toFixed(3)} MT.`,
      { feed, output, tolerance });
  }

  const qualityRows = (await client.query(`
    SELECT qs.id, qs.source_row_id, qs.represented_quantity_mt, qs.inward_receipt_id,
      ir.quantity_mt AS receipt_quantity_mt, sr.raw_data
    FROM core.quality_sample qs JOIN raw.source_row sr ON sr.id=qs.source_row_id
    LEFT JOIN core.inward_receipt ir ON ir.id=qs.inward_receipt_id
    WHERE qs.sample_stage='inward'
  `)).rows;
  for (const row of qualityRows) {
    const dmg = number(row.raw_data?.[6]);
    const inward = Number(row.represented_quantity_mt);
    if (dmg != null && Math.abs(dmg - inward) > 0.05) await issue("DMG_STOCK_DIFFERENCE", "quality_sample", row.id, row.source_row_id,
      `DMG-declared quantity ${dmg} MT differs from inward quantity ${inward} MT.`, { dmgQuantityMT: dmg, inwardQuantityMT: inward });
    if (row.receipt_quantity_mt != null && Math.abs(Number(row.receipt_quantity_mt) - inward) > 0.05) {
      await issue("QUALITY_INWARD_MISMATCH", "quality_sample", row.id, row.source_row_id,
        `Quality record quantity ${inward} MT differs from linked inward receipt ${row.receipt_quantity_mt} MT.`);
    }
  }

  const quantityJumps = (await client.query(`
    WITH stats AS (
      SELECT lot_id, event_type, direction, count(*) AS records,
        percentile_cont(0.5) WITHIN GROUP (ORDER BY quantity_mt) AS median_quantity
      FROM core.inventory_movement GROUP BY lot_id, event_type, direction
    )
    SELECT im.id, im.source_row_id, im.quantity_mt, s.median_quantity, s.records
    FROM core.inventory_movement im JOIN stats s USING (lot_id, event_type, direction)
    WHERE s.records >= 3 AND s.median_quantity > 0
      AND (im.quantity_mt >= s.median_quantity * 10 OR im.quantity_mt <= s.median_quantity / 10)
  `)).rows;
  for (const row of quantityJumps) await issue("QUANTITY_MAGNITUDE_JUMP", "inventory_movement", row.id, row.source_row_id,
    `Quantity ${row.quantity_mt} MT is at least 10× above or below the lot-event median ${Number(row.median_quantity).toFixed(3)} MT.`,
    { provisionalRule: "10x median", historyRecords: Number(row.records) });

  const rateJumps = (await client.query(`
    WITH stats AS (
      SELECT lot_id, component_code, count(*) AS records,
        percentile_cont(0.5) WITHIN GROUP (ORDER BY rate_inr_per_mt) AS median_rate
      FROM core.lot_cost_component WHERE rate_inr_per_mt IS NOT NULL GROUP BY lot_id, component_code
    )
    SELECT c.id, c.source_row_id, c.rate_inr_per_mt, s.median_rate, s.records
    FROM core.lot_cost_component c JOIN stats s USING (lot_id, component_code)
    WHERE s.records >= 3 AND s.median_rate > 0
      AND (c.rate_inr_per_mt >= s.median_rate * 10 OR c.rate_inr_per_mt <= s.median_rate / 10)
  `)).rows;
  for (const row of rateJumps) await issue("RATE_MAGNITUDE_JUMP", "lot_cost_component", row.id, row.source_row_id,
    `Rate ₹${row.rate_inr_per_mt}/MT is at least 10× above or below the lot-component median ₹${Number(row.median_rate).toFixed(2)}/MT.`,
    { provisionalRule: "10x median", historyRecords: Number(row.records) });

  const recoveryOutliers = (await client.query(`
    WITH stats AS (
      SELECT source_material_name, count(*) AS records, avg(reported_recovery_pct) AS mean_recovery,
        stddev_samp(reported_recovery_pct) AS recovery_stddev
      FROM core.production_run WHERE reported_recovery_pct BETWEEN 0 AND 100 GROUP BY source_material_name
    )
    SELECT pr.id, pr.source_row_id, pr.reported_recovery_pct, s.*
    FROM core.production_run pr JOIN stats s USING (source_material_name)
    WHERE s.records >= 5 AND abs(pr.reported_recovery_pct-s.mean_recovery) > greatest(10, 3*COALESCE(s.recovery_stddev, 0))
  `)).rows;
  for (const row of recoveryOutliers) await issue("RECOVERY_OUTLIER", "production_run", row.id, row.source_row_id,
    `Recovery ${row.reported_recovery_pct}% is wildly different from the material mean ${Number(row.mean_recovery).toFixed(2)}%.`,
    { provisionalRule: "greater of 10 points or 3 standard deviations", historyRecords: Number(row.records) });

  const organizations = (await client.query(`
    SELECT o.id, o.legal_name, o.normalized_name, o.source_row_id, array_agg(r.role) FILTER (WHERE r.role IS NOT NULL) AS roles
    FROM core.organization o LEFT JOIN core.organization_role r ON r.organization_id=o.id GROUP BY o.id ORDER BY o.id
  `)).rows;
  // ponytail: O(n²) is adequate for the current small master; use pg_trgm when the master reaches thousands of names.
  for (let left = 0; left < organizations.length; left += 1) for (let right = left + 1; right < organizations.length; right += 1) {
    const a = organizations[left]; const b = organizations[right];
    if (Math.min(a.normalized_name.length, b.normalized_name.length) < 5 || !a.roles?.some((role) => b.roles?.includes(role))) continue;
    if (levenshtein(a.normalized_name, b.normalized_name) <= 2) await issue("POSSIBLE_DUPLICATE_ORGANIZATION", "organization", `${a.id}:${b.id}`, b.source_row_id,
      `Possible spelling drift: “${a.legal_name}” and “${b.legal_name}”. Confirm the canonical name before merging.`);
  }

  const latestStock = (await client.query(`
    SELECT ss.lot_id, ss.recorded_quantity_mt FROM core.stock_snapshot ss
    WHERE ss.snapshot_at=(SELECT max(snapshot_at) FROM core.stock_snapshot)
  `)).rows;
  const stockByLot = new Map(latestStock.map((row) => [Number(row.lot_id), Number(row.recorded_quantity_mt)]));
  for (const file of [files.fines, files.lumps]) {
    const { rows, sourceRows } = stagedSheet(file, "Opening Stock");
    for (let index = 1; index < rows.length; index += 1) {
      const lotText = text(rows[index][1]); const plannedQuantity = number(rows[index][6]);
      if (!lotText || plannedQuantity == null) continue;
      const lotId = findLot(lotText); const sourceRowId = sourceRows.get(index + 1);
      if (!lotId) {
        await issue("UNMAPPED_LOT", "planning_stock", lotText, sourceRowId, `Planning lot ${lotText} does not resolve to LOT MASTER.`);
        continue;
      }
      const stockQuantity = stockByLot.get(Number(lotId));
      if (stockQuantity == null || Math.abs(stockQuantity - plannedQuantity) > 0.05) await issue("PLANNING_STOCK_MISMATCH", "planning_stock", lotText, sourceRowId,
        `Planning quantity ${plannedQuantity} MT differs from HO stock snapshot ${stockQuantity ?? "missing"} MT.`);
    }
  }

  const freshnessRows = (await client.query(`
    SELECT * FROM (
      SELECT 'HO Stock Report (Daily).xlsx' AS workbook_name, 'daily' AS cadence, 36 AS maximum_age_hours,
        max(snapshot_at) AS latest_business_at, (array_agg(source_row_id ORDER BY snapshot_at DESC))[1] AS source_row_id FROM core.stock_snapshot
      UNION ALL
      SELECT 'Inward Report FY-2026-27 (Daily).xlsx', 'daily', 36,
        max(receipt_at), (array_agg(source_row_id ORDER BY receipt_at DESC))[1] FROM core.inward_receipt
      UNION ALL
      SELECT 'Daily Outward Report 2026-27 (Daily).xlsx', 'daily', 36,
        max(dispatch_at), (array_agg(source_row_id ORDER BY dispatch_at DESC))[1] FROM core.dispatch
      UNION ALL
      SELECT 'PRODUCTION REPORT FROM  15-AUG-2025  (Autosaved).xlsx', 'daily', 36,
        max(run_date)::timestamptz, (array_agg(source_row_id ORDER BY run_date DESC))[1] FROM core.production_run
      UNION ALL
      SELECT 'Inward quality report (Weekly).xlsx', 'weekly', 192,
        max(sample_at), (array_agg(source_row_id ORDER BY sample_at DESC))[1] FROM core.quality_sample WHERE sample_stage='inward'
    ) freshness WHERE latest_business_at IS NOT NULL
  `)).rows;
  for (const row of freshnessRows) {
    const ageHours = (Date.now() - new Date(row.latest_business_at).valueOf()) / 3600000;
    if (ageHours > Number(row.maximum_age_hours)) await issue("STALE_SOURCE", "source_file", row.workbook_name, row.source_row_id,
      `${row.workbook_name} is stale for its ${row.cadence} cadence; latest business date is ${new Date(row.latest_business_at).toISOString()}.`,
      { cadence: row.cadence, maximumAgeHours: Number(row.maximum_age_hours), ageHours: Number(ageHours.toFixed(1)) });
  }

  const negativeBalances = (await client.query(`
    SELECT id, source_row_id, label, value FROM core.purchase_lot
    CROSS JOIN LATERAL (VALUES
      ('balance to lift', reported_balance_to_lift_mt),
      ('payment-based balance', reported_payment_balance_mt),
      ('permit balance', reported_permit_balance_mt)
    ) balance(label, value)
    WHERE value < 0
  `)).rows;
  for (const row of negativeBalances) {
    await issue("NEGATIVE_REPORTED_BALANCE", "purchase_lot", row.id, row.source_row_id,
      `Source reports ${row.label} of ${row.value} MT.`);
  }
}

async function main() {
  await client.connect();
  const run = await one("INSERT INTO governance.import_run DEFAULT VALUES RETURNING id");
  runId = run.id;
  try {
    await client.query("BEGIN");
    await stageFile(files.stock, { "LOT MASTER": 1, "DAILY BOOKS": 1, "IRON ORE": 4 });
    await stageFile(files.inward, { "Purchased Details": 2, "Daily Inward Details": 1, "Permit Detail's": 1 });
    await stageFile(files.outward, { "Outward Details": 2, "Daily Outward Detail's": 1, "Permit Detail's": 1 });
    await stageFile(files.quality, { "Inward Quality Report": 1, "LOT Details": 1 });
    await stageFile(files.auction, { "Consolidated Data": 1 });
    await stageFile(files.buyers, { "Buyer Type": 1 });
    await stageFile(files.bids, { "Bid Details": 1, "Transportation": 1, "Royalty": 1 });
    await stageFile(files.transport, { "MASTER ": 1, "INWARD FINAL 26-27": 2 });
    await stageFile(files.fines, { "Opening Stock": 1 });
    await stageFile(files.lumps, { "Opening Stock": 1 });
    await stageFile(files.production, { "PRODUCTION AND RECOVERY": 5 });

    await loadLotMaster();
    await loadBuyerMaster();
    await loadPurchases();
    await loadInwardPermits();
    await loadInwardReceipts();
    await loadSalesOrders();
    await loadOutwardPermits();
    await loadDispatches();
    await loadInwardQuality();
    await loadStockSnapshot();
    await loadInventoryMovements();
    await loadAuctions();
    await loadTransportWorkOrders();
    await loadProduction();
    await issue("MISSING_PAYMENT_LEDGER", "payment", "authoritative-ledger", null, "No authoritative payment ledger is present; Purchased Details remarks are retained as reported status only.");
    await issue("MISSING_AUCTION_BUYER_SOURCE", "auction_bid_award", "authoritative-buyer-awards", null, "The supplied auction sheets do not provide an approved buyer/competitor award source.");
    await runReconciliations();
    await client.query("COMMIT");

    const coreCount = await one(`
      SELECT
        (SELECT count(*) FROM core.lot) +
        (SELECT count(*) FROM core.purchase_lot) +
        (SELECT count(*) FROM core.inward_receipt) +
        (SELECT count(*) FROM core.sales_order_line) +
        (SELECT count(*) FROM core.dispatch) +
        (SELECT count(*) FROM core.quality_sample) +
        (SELECT count(*) FROM core.inventory_movement) AS count
    `);
    const issueCount = await one("SELECT count(*) AS count FROM governance.data_issue WHERE import_run_id = $1 AND resolved_at IS NULL", [runId]);
    await client.query(`
      UPDATE governance.import_run SET
        finished_at = now(), status = 'completed', files_seen = $2, rows_seen = $3,
        core_records_written = $4, issue_count = $5
      WHERE id = $1
    `, [runId, filesSeen, rowsSeen, Number(coreCount.count), Number(issueCount.count)]);
    console.log(`Loaded ${filesSeen} workbooks, ${rowsSeen} raw rows, ${coreCount.count} core records; ${issueCount.count} open flags.`);
  } catch (error) {
    await client.query("ROLLBACK");
    await client.query("UPDATE governance.import_run SET finished_at = now(), status = 'failed', error_message = $2 WHERE id = $1", [runId, String(error.stack || error)]);
    throw error;
  } finally {
    await client.end();
  }
}

await main();
