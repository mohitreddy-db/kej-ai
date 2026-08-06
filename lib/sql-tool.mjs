import { tool } from "langchain";
import { z } from "zod";
import { pool } from "./postgres.mjs";

const allowedRelations = new Set([
  "core.alert_event", "core.auction_bid_award", "core.auction_lot", "core.business_target",
  "core.dispatch", "core.inventory_movement", "core.inward_receipt", "core.lot", "core.lot_alias",
  "core.lot_cost_component", "core.material", "core.organization", "core.organization_alias",
  "core.organization_role", "core.payment_allocation", "core.permit", "core.plan", "core.plan_allocation",
  "core.plan_approval", "core.production_input", "core.production_output", "core.production_run",
  "core.purchase_lot", "core.quality_sample", "core.sales_order_line", "core.site", "core.stock_snapshot",
  "analytics.transporter_work_order_activity",
]);

export function validateBusinessSql(value) {
  const input = String(value || "").trim();
  const sql = input.endsWith(";") ? input.slice(0, -1).trim() : input;
  if (!sql || sql.length > 4000) throw new Error("SQL must be between 1 and 4,000 characters.");
  if (!/^(?:select|with)\b/i.test(sql)) throw new Error("Only a single SELECT query (optionally starting with WITH) is allowed.");
  if (/[;$]/.test(sql) || /--|\/\*/.test(sql)) throw new Error("SQL comments, parameters and multiple statements are not allowed.");
  if (/\b(insert|update|delete|merge|drop|alter|truncate|create|grant|revoke|copy|call|do|vacuum|analyze|refresh|set|reset|listen|notify|lock|execute|prepare|deallocate|discard|reindex|cluster)\b/i.test(sql)) {
    throw new Error("Only read-only analytics are allowed.");
  }
  if (/\b(pg_catalog|information_schema|raw|governance)\s*\./i.test(sql) || /\b(pg_sleep|set_config|current_setting|dblink|lo_import|lo_export)\s*\(/i.test(sql)) {
    throw new Error("That schema or function is not available to the analytics agent.");
  }
  const relations = [...sql.matchAll(/\b(?:from|join)\s+([a-z_][a-z0-9_]*\.[a-z_][a-z0-9_]*)/gi)].map((match) => match[1].toLowerCase());
  if (!relations.length || relations.some((relation) => !allowedRelations.has(relation))) {
    throw new Error("Use only the approved, schema-qualified business tables listed in the tool description.");
  }
  if (!/\bsource_row_ids?\b/i.test(sql)) throw new Error("Return source_row_id for detail queries or source_row_ids for aggregate queries.");
  return sql;
}

const sourceIdsFrom = (rows) => [...new Set(rows.flatMap((row) => {
  const values = [row.source_row_id, row.source_row_ids].flat().filter((value) => value != null);
  return values.map(Number).filter(Number.isSafeInteger);
}))];

const groupSources = (rows) => [...rows.reduce((groups, row) => {
  const key = `${row.workbook_name}|${row.sheet_name}`;
  const group = groups.get(key) || { file: row.workbook_name, sheet: row.sheet_name, rows: [], sourceRowIds: [] };
  group.rows.push(Number(row.row_number));
  group.sourceRowIds.push(Number(row.source_row_id));
  groups.set(key, group);
  return groups;
}, new Map()).values()].map((group) => ({
  ...group,
  row: [...new Set(group.rows)].sort((a, b) => a - b).join(", "),
  sourceRowIds: [...new Set(group.sourceRowIds)].sort((a, b) => a - b),
}));

export async function runBusinessSql(sqlValue) {
  let sql;
  try {
    sql = validateBusinessSql(sqlValue);
  } catch (error) {
    return { status: "incomplete", error: error.message };
  }

  const client = await pool.connect();
  try {
    await client.query("BEGIN TRANSACTION READ ONLY");
    await client.query("SET LOCAL ROLE kejai_agent_reader");
    await client.query("SET LOCAL statement_timeout = '5s'");
    await client.query("SET LOCAL lock_timeout = '1s'");
    const result = await client.query(`SELECT * FROM (${sql}) AS agent_result LIMIT 101`);
    await client.query("COMMIT");
    if (result.rows.length > 100) return { status: "incomplete", error: "Query returned more than 100 rows. Add a tighter filter or LIMIT." };
    if (!result.rows.length) return {
      status: "incomplete",
      rows: [],
      row_count: 0,
      error: "No matching records were found.",
      retry_hint: "If the user supplied an organization name, query core.organization using one distinctive name token, then retry with the matching canonical legal_name. Otherwise verify the requested date range.",
      executed_sql: sql,
    };

    const sourceIds = sourceIdsFrom(result.rows).slice(0, 1000);
    const rows = result.rows.map(({ source_row_id, source_row_ids, ...row }) => row);
    if (!sourceIds.length) return { status: "incomplete", rows, row_count: rows.length, error: "The query returned no source-row provenance.", executed_sql: sql };

    const [sourceResult, issueResult] = await Promise.all([
      client.query(`SELECT source_row_id, workbook_name, sheet_name, row_number
        FROM governance.source_provenance WHERE source_row_id = ANY($1::bigint[]) ORDER BY workbook_name, sheet_name, row_number`, [sourceIds]),
      client.query(`SELECT rule_code, count(*)::integer AS count
        FROM governance.data_issue WHERE source_row_id = ANY($1::bigint[]) AND resolved_at IS NULL
          AND import_run_id = (SELECT id FROM governance.import_run WHERE status = 'completed' ORDER BY id DESC LIMIT 1)
        GROUP BY rule_code ORDER BY count(*) DESC, rule_code`, [sourceIds]),
    ]);
    const warnings = issueResult.rows.map((row) => ({ rule: row.rule_code, count: Number(row.count) }));
    return {
      status: warnings.length ? "flagged" : "verified",
      rows,
      row_count: rows.length,
      executed_sql: sql,
      warnings,
      sources: groupSources(sourceResult.rows),
    };
  } catch (error) {
    try { await client.query("ROLLBACK"); } catch {}
    return { status: "incomplete", error: `SQL could not be executed: ${error.message}` };
  } finally {
    client.release();
  }
}

export const businessSqlTool = tool(async ({ sql }) => JSON.stringify(await runBusinessSql(sql)), {
  name: "query_business_data",
  description: `Use this first for exact-date or date-range lookups, filtering, counts, sums, grouping, rankings and comparisons that SQL can answer. PostgreSQL performs every calculation; never calculate returned rows yourself.

Approved schema:
- core.organization(id, legal_name, normalized_name, source_row_id)
- core.organization_alias(organization_id, alias, normalized_alias, source_row_id)
- core.dispatch(dispatch_at, customer_id, sales_order_line_id, lot_id, transporter_id, quantity_mt, vehicle_count, source_row_id)
- core.sales_order_line(customer_id, po_number, po_date, ordered_quantity_mt, selling_rate_inr_per_mt, target_fe_pct, reported_dispatched_quantity_mt, reported_balance_to_dispatch_mt, source_row_id)
- core.inward_receipt(receipt_at, lot_id, supplier_id, transporter_id, quantity_mt, trip_count, source_row_id)
- core.purchase_lot(purchase_date, supplier_id, source_lot_number, purchased_quantity_mt, purchase_rate_inr_per_mt, reported_landed_cost_inr_per_mt, source_row_id)
- core.stock_snapshot(snapshot_at, lot_id, recorded_quantity_mt, reported_fe_pct, reported_landed_cost_inr_per_mt, source_row_id)
- core.lot(id, kej_lot_number, supplier_id, material_id, source_row_id)
- core.material(id, mineral, category, size_spec, source_row_id)
- core.quality_sample(sample_at, sample_stage, lot_id, source_lot_number, represented_quantity_mt, fe_pct, sio2_pct, al2o3_pct, p_pct, loi_pct, moisture_pct, source_row_id)
- core.production_run(id, run_date, shift, process, reported_recovery_pct, source_row_id)
- core.production_input(production_run_id, lot_id, quantity_mt, source_row_id)
- core.production_output(production_run_id, lot_id, output_type, quantity_mt, source_row_id)
- core.auction_lot and core.auction_bid_award for auction questions
- analytics.transporter_work_order_activity(transporter, awarded_quantity_mt, work_order_number, mine, source_row_id). This is assigned work-order quantity, not confirmed delivered quantity.

Approved calculation recipes (always do the full calculation inside SQL):

1. Fastest or slowest moving customer = smallest or largest average days from order to actual dispatch. Join core.dispatch d to core.sales_order_line sol ON sol.id = d.sales_order_line_id, compute avg(d.dispatch_at::date - sol.po_date) per customer, and exclude bad PO dates with WHERE d.dispatch_at::date >= sol.po_date. State this definition and the exclusion in the answer. Example:
SELECT o.legal_name AS customer, count(d.id) AS dispatch_count,
  round(avg(d.dispatch_at::date - sol.po_date), 1) AS avg_days_order_to_dispatch,
  array_agg(d.source_row_id) AS source_row_ids
FROM core.dispatch d
JOIN core.sales_order_line sol ON sol.id = d.sales_order_line_id
JOIN core.organization o ON o.id = d.customer_id
WHERE d.dispatch_at::date >= sol.po_date
GROUP BY o.legal_name
ORDER BY avg_days_order_to_dispatch ASC LIMIT 1

2. Blend plan for a target Fe and required quantity from current stock. Use the latest stock snapshot as available lots. A single lot qualifies when abs(fe - target) <= 0.05 and quantity >= required. Otherwise pair one lot below target with one above target using the lever rule: low_qty = required * (high_fe - target) / (high_fe - low_fe), high_qty = required - low_qty, feasible when each side has enough stock. Rank feasible blends by blended landed cost ascending (this is the client's "maximum profit" rule: consume the cheapest material that still meets the customer Fe). Template for 100 MT of fines at target Fe 60 (replace the numbers and category with the user's values):
WITH stock AS (
  SELECT l.kej_lot_number, ss.recorded_quantity_mt AS qty, ss.reported_fe_pct AS fe,
    ss.reported_landed_cost_inr_per_mt AS cost, ss.source_row_id
  FROM core.stock_snapshot ss
  JOIN core.lot l ON l.id = ss.lot_id
  JOIN core.material m ON m.id = l.material_id
  WHERE ss.snapshot_at = (SELECT max(snapshot_at) FROM core.stock_snapshot)
    AND m.category = 'fine' AND ss.recorded_quantity_mt > 0
    AND ss.reported_fe_pct IS NOT NULL AND ss.reported_landed_cost_inr_per_mt IS NOT NULL
), pairs AS (
  SELECT low.kej_lot_number AS low_lot, high.kej_lot_number AS high_lot,
    low.fe AS low_fe, high.fe AS high_fe, low.qty AS low_stock_mt, high.qty AS high_stock_mt,
    round(100 * (high.fe - 60.0) / (high.fe - low.fe), 3) AS low_qty_mt,
    round(100 - 100 * (high.fe - 60.0) / (high.fe - low.fe), 3) AS high_qty_mt,
    low.cost AS low_cost, high.cost AS high_cost,
    ARRAY[low.source_row_id, high.source_row_id] AS source_row_ids
  FROM stock low
  JOIN stock high ON low.fe < 60.0 AND high.fe > 60.0
)
SELECT low_lot, high_lot, low_qty_mt, high_qty_mt, low_fe, high_fe,
  round((low_qty_mt * low_cost + high_qty_mt * high_cost) / 100.0, 2) AS blended_cost_inr_per_mt,
  source_row_ids
FROM pairs
WHERE low_qty_mt <= low_stock_mt AND high_qty_mt <= high_stock_mt
ORDER BY blended_cost_inr_per_mt ASC LIMIT 5
Report each plan's lot mix quantities, blended Fe (equal to the target by construction), blended landed cost per MT and remaining stock caveats. If no pair is feasible, say so and show the nearest single lots.

Rules:
- Use schema-qualified relation names and explicit JOINs.
- Detail queries must select source_row_id. Aggregate queries must select array_agg(the_fact_table.source_row_id) AS source_row_ids.
- Select only columns needed for the answer. Use LIMIT 20 for detail lists.
- Resolve names with core.organization; do not silently assume an ambiguous company.
- For an informal company name, first resolve candidates with one distinctive token (for example, %jindal%), not the entire user phrase. If a fact query returns no rows, follow the retry hint once before answering Incomplete.
- If name resolution finds multiple candidates, query the requested fact for all candidates. Answer when exactly one candidate has matching facts; ask the user only if multiple candidates still match.
- Highest/lowest questions must be ranked in SQL and use LIMIT 1 unless the user asks for a ranked list.
- Select dispatch_at::date or receipt_at::date unless the user explicitly asks for a time of day.
- For "highest buyer/customer by quantity", use actual core.dispatch quantity unless the user explicitly asks for orders.
- For transporter quantity, use analytics.transporter_work_order_activity and clearly call it assigned work-order quantity.`,
  schema: z.object({ sql: z.string().min(1).max(4000) }),
});
