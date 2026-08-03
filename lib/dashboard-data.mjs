import { pool } from "./postgres.mjs";

const number = (value) => {
  const clean = String(value ?? "").replace(/[₹,%\s,]/g, "");
  if (!clean || clean === "-" || /^-+$/.test(clean)) return null;
  const parsed = Number(clean);
  return Number.isFinite(parsed) ? parsed : null;
};
const text = (value) => value == null ? "" : String(value).replace(/\s+/g, " ").trim();
const round = (value, places = 2) => Number(Number(value || 0).toFixed(places));
const source = (row) => ({
  sourceRowId: Number(row.source_row_id),
  file: row.workbook_name,
  sheet: row.sheet_name,
  row: Number(row.row_number),
  fileHash: row.file_hash,
  rowHash: row.row_hash,
});
const category = (value) => ({ fine: "FINES", lump: "LUMPS", cleaning_screening: "CLEANINGS", tailings: "TAILS", manganese: "MANGANESE", other: "OTHER" }[value] || "OTHER");
const statusLabel = (value) => value ? value[0].toUpperCase() + value.slice(1).replaceAll("_", " ") : "Unknown";
const sum = (rows, key) => rows.reduce((total, row) => total + (Number(row[key]) || 0), 0);

function evidence(rows, treatment = "normalized") {
  const groups = new Map();
  for (const item of rows) {
    const itemSource = item.source;
    if (!itemSource?.file || !itemSource?.sheet || !itemSource?.row) continue;
    const key = `${itemSource.file}|${itemSource.sheet}`;
    const group = groups.get(key) || { file: itemSource.file, sheet: itemSource.sheet, fileHash: itemSource.fileHash, rows: [], sourceRowIds: [], treatment };
    group.rows.push(Number(itemSource.row));
    if (itemSource.sourceRowId) group.sourceRowIds.push(itemSource.sourceRowId);
    groups.set(key, group);
  }
  return [...groups.values()].map((group) => ({
    ...group,
    rows: [...new Set(group.rows)].sort((a, b) => a - b),
    sourceRowIds: [...new Set(group.sourceRowIds)].sort((a, b) => a - b),
  }));
}

function buildAggregates(data) {
  const { inventory, purchases, sales, auctions, quality, production, counterparties, transporters } = data;
  const pendingPurchases = purchases.filter((item) => item.balance > 0.1);
  const pendingSales = sales.filter((item) => item.balance > 0.1);
  const qualityRows = quality.filter((item) => item.fe != null);
  const totalFeed = sum(production, "feed");
  const totalRecovered = sum(production, "recovered");
  const mineMap = new Map();
  for (const item of quality.filter((row) => row.feDifference != null)) {
    const current = mineMap.get(item.supplier) || { supplier: item.supplier || "Unknown", totalDifference: 0, records: 0, below: 0 };
    current.totalDifference += item.feDifference;
    current.records += 1;
    if (item.feDifference < 0) current.below += 1;
    mineMap.set(item.supplier, current);
  }
  const transporterMap = new Map();
  for (const item of transporters) {
    const current = transporterMap.get(item.transporter) || { transporter: item.transporter, workOrders: 0, totalRate: 0, ratedOrders: 0 };
    current.workOrders += 1;
    if (item.rate != null) { current.totalRate += item.rate; current.ratedOrders += 1; }
    transporterMap.set(item.transporter, current);
  }
  return {
    overview: {
      currentStock: round(sum(inventory, "quantity")),
      stockLots: inventory.length,
      stockValue: round(inventory.reduce((total, item) => total + item.quantity * (item.landedCost || 0), 0)),
      pendingInward: round(sum(pendingPurchases, "balance")),
      pendingPurchaseLots: pendingPurchases.length,
      pendingDispatch: round(sum(pendingSales, "balance")),
      pendingOrders: pendingSales.length,
      totalFeed: round(totalFeed),
      recovery: totalFeed ? round(totalRecovered / totalFeed * 100, 1) : 0,
      buyerCount: counterparties.length,
      auctionLots: auctions.length,
    },
    mineQuality: [...mineMap.values()].map((item) => ({
      supplier: item.supplier,
      records: item.records,
      averageDifference: round(item.totalDifference / item.records, 2),
      belowShare: round(item.below / item.records * 100, 1),
    })).sort((a, b) => a.averageDifference - b.averageDifference),
    transporterSummary: [...transporterMap.values()].map((item) => ({
      transporter: item.transporter,
      workOrders: item.workOrders,
      averageRate: item.ratedOrders ? round(item.totalRate / item.ratedOrders) : null,
      status: "Incomplete — delivery dates are not present",
    })).sort((a, b) => b.workOrders - a.workOrders),
    quality: {
      records: quality.length,
      averageFe: qualityRows.length ? round(sum(qualityRows, "fe") / qualityRows.length, 2) : 0,
      belowIndicative: quality.filter((item) => item.feDifference != null && item.feDifference < 0).length,
      severeVariance: quality.filter((item) => item.feDifference != null && item.feDifference < -1).length,
    },
  };
}

function issueDomains(issue) {
  const entity = issue.entityName;
  if (entity === "source_file") {
    const file = issue.entityKey || "";
    if (/stock report/i.test(file)) return ["inventory"];
    if (/inward report/i.test(file)) return ["inward"];
    if (/outward report/i.test(file)) return ["sales"];
    if (/quality report/i.test(file)) return ["quality"];
    if (/auction/i.test(file)) return ["auctions"];
    if (/production report/i.test(file)) return ["production"];
    if (/planning/i.test(file)) return ["blend"];
    if (/transporter|bulk permit/i.test(file)) return ["counterparties"];
  }
  if (["lot", "stock_snapshot", "inventory_movement", "lot_cost_component"].includes(entity)) return ["inventory"];
  if (["purchase_lot", "inward_receipt", "payment"].includes(entity)) return ["inward"];
  if (entity === "quality_sample") return ["quality", "inward"];
  if (["sales_order_line", "dispatch", "permit"].includes(entity)) return ["sales"];
  if (entity === "production_run") return ["production"];
  if (entity === "planning_stock") return ["blend"];
  if (["organization", "transport_work_order"].includes(entity)) return ["counterparties"];
  if (/auction/.test(entity)) return ["auctions"];
  return ["overview"];
}

function buildValidation(issues) {
  const viewDomains = {
    overview: ["inventory", "inward", "sales", "auctions", "quality", "production", "blend", "counterparties", "overview"],
    inventory: ["inventory"], inward: ["inward"], sales: ["sales"], auctions: ["auctions"], quality: ["quality"],
    production: ["production"], forecast: ["sales", "auctions", "quality", "production"], blend: ["blend"],
    counterparties: ["counterparties"], calculations: ["inventory", "sales", "quality"], trust: ["inventory", "inward", "sales", "auctions", "quality", "production", "blend", "counterparties", "overview"],
    ask: ["inventory", "inward", "sales", "auctions", "quality", "production", "blend", "counterparties", "overview"],
  };
  return Object.fromEntries(Object.entries(viewDomains).map(([view, domains]) => {
    const relevant = issues.filter((issue) => issue.domains.some((domain) => domains.includes(domain)));
    const incomplete = relevant.filter((issue) => /^(MISSING_|UNMAPPED_|INVALID_NUMBER)/.test(issue.ruleCode));
    const counts = new Map();
    for (const issue of relevant) counts.set(issue.ruleCode, (counts.get(issue.ruleCode) || 0) + 1);
    const reasons = [...counts].sort((a, b) => b[1] - a[1]).slice(0, 4).map(([ruleCode, count]) => ({
      ruleCode, count, label: ruleCode.toLowerCase().replaceAll("_", " "),
    }));
    return [view, {
      status: incomplete.length ? "incomplete" : relevant.length ? "flagged" : "verified",
      issueCount: relevant.length,
      incompleteCount: incomplete.length,
      flaggedCount: relevant.length - incomplete.length,
      reasons,
    }];
  }));
}

export async function loadDashboardData() {
  const provenance = `sp.workbook_name, sp.sheet_name, sp.row_number, sp.file_hash, sp.row_hash`;
  const query = async (name, sql) => {
    const started = Date.now();
    const result = await pool.query(sql);
    if (process.env.DEBUG_DB) console.log(`${name}: ${Date.now() - started}ms`);
    return result;
  };
  const [metaResult, inventoryResult, purchaseResult, salesResult, auctionResult, qualityResult, productionResult, rawResult, issueResult] = await Promise.all([
    query("meta", `SELECT COALESCE((SELECT max(snapshot_at)::date::text FROM core.stock_snapshot), current_date::text) AS snapshot,
      finished_at FROM governance.import_run WHERE status='completed' ORDER BY id DESC LIMIT 1`),
    query("inventory", `SELECT ss.source_row_id, ss.recorded_quantity_mt::float8, ss.reported_fe_pct::float8,
      ss.reported_landed_cost_inr_per_mt::float8, ss.reported_status, l.kej_lot_number, l.description,
      m.category, m.size_spec, sr.raw_data, ${provenance}
      FROM core.stock_snapshot ss JOIN core.lot l ON l.id=ss.lot_id JOIN core.material m ON m.id=l.material_id
      JOIN raw.source_row sr ON sr.id=ss.source_row_id JOIN governance.source_provenance sp ON sp.source_row_id=ss.source_row_id
      WHERE ss.snapshot_at=(SELECT max(snapshot_at) FROM core.stock_snapshot) ORDER BY l.kej_lot_number`),
    query("purchases", `SELECT pl.*, pl.purchase_date::text, o.legal_name AS supplier, m.category, m.size_spec, sr.raw_data, ${provenance}
      FROM core.purchase_lot pl JOIN core.organization o ON o.id=pl.supplier_id LEFT JOIN core.material m ON m.id=pl.material_id
      JOIN raw.source_row sr ON sr.id=pl.source_row_id JOIN governance.source_provenance sp ON sp.source_row_id=pl.source_row_id
      ORDER BY pl.purchase_date, pl.id`),
    query("sales", `SELECT sol.*, sol.po_date::text, o.legal_name AS customer, m.category, sr.raw_data, ${provenance}
      FROM core.sales_order_line sol JOIN core.organization o ON o.id=sol.customer_id LEFT JOIN core.material m ON m.id=sol.material_id
      JOIN raw.source_row sr ON sr.id=sol.source_row_id JOIN governance.source_provenance sp ON sp.source_row_id=sol.source_row_id
      WHERE m.mineral='iron_ore' ORDER BY sol.po_date, sol.id`),
    query("auctions", `SELECT al.*, al.closes_at::date::text AS closing_date, seller.legal_name AS mine, site.name AS location,
      m.size_spec, sr.raw_data, ${provenance}
      FROM core.auction_lot al LEFT JOIN core.organization seller ON seller.id=al.seller_id LEFT JOIN core.site site ON site.id=al.site_id
      LEFT JOIN core.material m ON m.id=al.material_id JOIN raw.source_row sr ON sr.id=al.source_row_id
      JOIN governance.source_provenance sp ON sp.source_row_id=al.source_row_id ORDER BY al.closes_at, al.id`),
    query("quality", `SELECT qs.*, qs.sample_at::date::text AS report_date, indicative.fe_pct::float8 AS indicative_fe,
      sr.raw_data, ${provenance}
      FROM core.quality_sample qs LEFT JOIN core.quality_sample indicative
        ON indicative.source_row_id=qs.source_row_id AND indicative.sample_stage='indicative'
      JOIN raw.source_row sr ON sr.id=qs.source_row_id JOIN governance.source_provenance sp ON sp.source_row_id=qs.source_row_id
      WHERE qs.sample_stage='inward' ORDER BY qs.sample_at, qs.id`),
    query("production", `SELECT pr.*, pr.run_date::text, ar.feed_quantity_mt::float8, ar.recovered_quantity_mt::float8,
      ar.tailings_quantity_mt::float8, ar.calculated_recovery_pct::float8, sr.raw_data, ${provenance}
      FROM core.production_run pr JOIN analytics.production_recovery ar ON ar.production_run_id=pr.id
      JOIN raw.source_row sr ON sr.id=pr.source_row_id JOIN governance.source_provenance sp ON sp.source_row_id=pr.source_row_id
      ORDER BY pr.run_date, pr.id`),
    query("raw-support", `SELECT sr.id AS source_row_id, sr.raw_data, sf.file_name AS workbook_name, sr.sheet_name,
      sr.row_number, sf.file_hash, sr.row_hash
      FROM raw.source_row sr JOIN governance.source_file sf ON sf.id=sr.source_file_id
      WHERE sf.import_run_id=(SELECT id FROM governance.import_run WHERE status='completed' ORDER BY id DESC LIMIT 1)
        AND ((sf.file_name IN ('Fines Planning as on 23-07-2026.xlsx','Lumps Planning as on 23-07-2026.xlsx') AND sr.sheet_name='Opening Stock')
          OR (sf.file_name='INWARD TRANSPORTER -WORK ORDER FILE-CONTROL SHEET FORMAT.xlsm' AND sr.sheet_name='INWARD FINAL 26-27')
          OR (sf.file_name='All Company Bulk Permit detaisl (Weekly).xlsx' AND sr.sheet_name='Buyer Type'))
      ORDER BY sf.file_name, sr.sheet_name, sr.row_number`),
    query("issues", `SELECT di.*, sp.workbook_name, sp.sheet_name, sp.row_number, sp.file_hash, sp.row_hash
      FROM governance.data_issue di LEFT JOIN governance.source_provenance sp ON sp.source_row_id=di.source_row_id
      WHERE di.import_run_id=(SELECT id FROM governance.import_run WHERE status='completed' ORDER BY id DESC LIMIT 1)
        AND di.resolved_at IS NULL ORDER BY CASE di.severity WHEN 'critical' THEN 1 WHEN 'warning' THEN 2 ELSE 3 END, di.id`),
  ]);

  const inventory = inventoryResult.rows.map((row) => ({
    oreGroup: text(row.raw_data?.[0]), lot: row.kej_lot_number, quantity: number(row.recorded_quantity_mt) || 0,
    size: text(row.raw_data?.[3]) || row.size_spec || "", product: category(row.category), fe: number(row.reported_fe_pct),
    sio2: number(row.raw_data?.[6]), al2o3: number(row.raw_data?.[7]), thirdPartyFe: number(row.raw_data?.[8]),
    landedCost: number(row.reported_landed_cost_inr_per_mt), status: row.reported_status || "", description: row.description || "", source: source(row),
  }));
  const purchases = purchaseResult.rows.map((row) => ({
    bidDate: row.purchase_date, oreType: category(row.category), supplier: row.supplier, lot: row.source_lot_number,
    purchased: number(row.purchased_quantity_mt) || 0, rate: number(row.purchase_rate_inr_per_mt), landedRate: number(row.reported_landed_cost_inr_per_mt),
    indicativeFe: number(row.raw_data?.[8]), lifted: number(row.reported_lifted_quantity_mt) || 0, balance: number(row.reported_balance_to_lift_mt) || 0,
    observationFe: number(row.raw_data?.[11]), receivingFe: number(row.raw_data?.[12]), feDifference: number(row.raw_data?.[13]),
    permitBalance: number(row.reported_permit_balance_mt), size: row.size_spec || "", status: statusLabel(row.status),
    remarks: text(row.raw_data?.[20]), agingDays: number(text(row.raw_data?.[21]).replace(/[^\d.-]/g, "")), source: source(row),
  }));
  const sales = salesResult.rows.map((row) => ({
    customer: row.customer, product: statusLabel(row.category), po: row.po_number, poDate: row.po_date,
    targetFe: number(row.target_fe_pct), dispatchFe: number(row.raw_data?.[6]), rate: number(row.selling_rate_inr_per_mt),
    orderQty: number(row.ordered_quantity_mt) || 0, dispatched: number(row.reported_dispatched_quantity_mt) || 0,
    progress: number(row.raw_data?.[11]), balance: number(row.reported_balance_to_dispatch_mt) || 0, size: row.size_spec || "",
    availablePermit: number(row.raw_data?.[14]) || 0, permitNeeded: number(row.raw_data?.[15]) || 0,
    status: statusLabel(row.status), source: source(row),
  }));
  const auctions = auctionResult.rows.map((row) => ({
    closingDate: row.closing_date, auction: row.auction_number, lot: row.external_lot_number,
    location: row.location || "", size: row.size_spec || text(row.raw_data?.[4]), fe: number(row.indicative_fe_pct), labFe: number(row.raw_data?.[6]),
    quantity: number(row.offered_quantity_mt) || 0, lotSize: number(row.raw_data?.[8]), sold: number(row.sold_quantity_mt) || 0,
    balance: Math.max(0, (number(row.offered_quantity_mt) || 0) - (number(row.sold_quantity_mt) || 0)),
    openingPrice: number(row.opening_price_inr_per_mt), currentPrice: number(row.current_price_inr_per_mt), statutory: number(row.raw_data?.[13]),
    landedPrice: number(row.reported_landed_price_inr_per_mt), premium: number(row.reported_premium_pct),
    ourBidLot: text(row.raw_data?.[17]), ourPrice: number(row.raw_data?.[18]), mine: row.mine || text(row.raw_data?.[19]), source: source(row),
  }));
  const quality = qualityResult.rows.map((row) => ({
    reportDate: row.report_date, lot: row.source_lot_number, supplier: text(row.raw_data?.[3]), product: text(row.raw_data?.[4]),
    size: text(row.raw_data?.[5]), dmgQuantity: number(row.raw_data?.[6]), inwardQuantity: number(row.represented_quantity_mt) || 0,
    trips: number(row.raw_data?.[8]), shortage: number(row.raw_data?.[9]), indicativeFe: number(row.indicative_fe),
    feDifference: row.fe_pct == null || row.indicative_fe == null ? null : round(Number(row.fe_pct) - Number(row.indicative_fe), 2),
    fe: number(row.fe_pct), sio2: number(row.sio2_pct), al2o3: number(row.al2o3_pct), loi: number(row.loi_pct),
    phos: number(row.p_pct), moisture: number(row.moisture_pct), massBalance: number(row.mass_balance_pct), source: source(row),
  }));
  const production = productionResult.rows.map((row) => ({
    productionDate: row.run_date, shift: row.shift || "", productionType: text(row.raw_data?.[2]), materialType: text(row.raw_data?.[3]),
    material: row.source_material_name, feed: number(row.feed_quantity_mt) || 0, feedFe: number(row.raw_data?.[6]),
    product: number(row.recovered_quantity_mt), productFe: number(row.raw_data?.[33]), tailings: number(row.tailings_quantity_mt) || 0,
    recovered: number(row.recovered_quantity_mt), recovery: number(row.reported_recovery_pct) ?? number(row.calculated_recovery_pct),
    recoveryFe: number(row.raw_data?.[42]), source: source(row),
  }));

  const rawRows = rawResult.rows.map((row) => ({ ...row, source: source(row) }));
  const rawPlanning = rawRows.filter((row) => row.sheet_name === "Opening Stock" && row.row_number > 1);
  const blendStock = rawPlanning.flatMap((row) => {
    const lot = text(row.raw_data?.[1]); const quantity = number(row.raw_data?.[6]); const fe = number(row.raw_data?.[3]);
    if (!lot || !quantity || !fe) return [];
    const description = text(row.raw_data?.[0]);
    const purchase = purchases.find((item) => description.replace(/[^a-z0-9]/gi, "").toLowerCase().includes(item.lot.replace(/[^a-z0-9]/gi, "").toLowerCase()));
    return [{ product: row.workbook_name.startsWith("Fines") ? "Fines" : "Lumps", description, lot,
      size: text(row.raw_data?.[2]), fe, status: text(row.raw_data?.[4]), landedCost: number(row.raw_data?.[5]) || 0,
      quantity, ageDays: purchase?.agingDays || 0, source: row.source }];
  });
  const transporters = rawRows.filter((row) => row.sheet_name === "INWARD FINAL 26-27" && row.row_number > 2).flatMap((row) => {
    const transporter = text(row.raw_data?.[5]); if (!transporter) return [];
    return [{ workOrder: text(row.raw_data?.[0]), date: text(row.raw_data?.[2]), transporter, mine: text(row.raw_data?.[7]),
      statedQuantity: text(row.raw_data?.[8]), lot: text(row.raw_data?.[9]), rate: number(row.raw_data?.[11]),
      distanceKm: number(row.raw_data?.[15]), source: row.source }];
  });
  const counterparties = rawRows.filter((row) => row.sheet_name === "Buyer Type" && row.row_number > 1).flatMap((row) => {
    const buyer = text(row.raw_data?.[0]); if (!buyer) return [];
    return [{ buyer, type: text(row.raw_data?.[1]) || "Unclassified", oreType: text(row.raw_data?.[2]),
      destination: text(row.raw_data?.[7]), workingStatus: text(row.raw_data?.[8]) || "Not recorded",
      lastWorkingMonth: text(row.raw_data?.[9]), source: row.source }];
  });
  const trustIssues = issueResult.rows.map((row) => ({
    severity: /^(MISSING_|UNMAPPED_|INVALID_NUMBER)/.test(row.rule_code) ? "incomplete" : row.severity === "info" ? "verified" : "flagged",
    dbSeverity: row.severity, ruleCode: row.rule_code, entityName: row.entity_name, entityKey: row.entity_key,
    area: statusLabel(row.entity_name), title: row.rule_code.replaceAll("_", " "), detail: row.message,
    source: row.source_row_id ? source(row) : null,
  })).map((issue) => ({ ...issue, domains: issueDomains(issue) }));
  const data = {
    meta: {
      title: "kejAI Operations Control", snapshot: metaResult.rows[0]?.snapshot,
      generatedAt: metaResult.rows[0]?.finished_at?.toISOString?.() || String(metaResult.rows[0]?.finished_at || ""),
      scope: "Local PostgreSQL · normalized source of truth",
    },
    inventory, purchases, sales, auctions, quality, production, blendStock, transporters, counterparties, trustIssues,
  };
  data.aggregates = buildAggregates(data);
  data.validation = buildValidation(trustIssues);
  data.evidence = {
    inventory: evidence(inventory), purchases: evidence(purchases), sales: evidence(sales), auctions: evidence(auctions),
    quality: evidence(quality), production: evidence(production), blendStock: evidence(blendStock, "raw PostgreSQL"),
    transporters: evidence(transporters, "raw PostgreSQL"), counterparties: evidence(counterparties, "raw PostgreSQL"),
    trustIssues: evidence(trustIssues),
  };
  return data;
}
