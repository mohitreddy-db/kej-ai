import assert from "node:assert/strict";
import pg from "pg";

const databaseUrl = process.env.DATABASE_URL || "postgresql://kejai:kejai_local@127.0.0.1:54329/kejai";
const client = new pg.Client({ connectionString: databaseUrl });

await client.connect();
try {
  const objectCounts = (await client.query(`
    SELECT
      count(*) FILTER (WHERE table_schema = 'core')::integer AS core_tables,
      count(*) FILTER (WHERE table_schema = 'governance')::integer AS governance_tables,
      count(*) FILTER (WHERE table_schema = 'raw')::integer AS raw_tables
    FROM information_schema.tables
    WHERE table_type = 'BASE TABLE' AND table_schema IN ('core', 'governance', 'raw')
  `)).rows[0];
  const analyticsViews = Number((await client.query(`
    SELECT count(*) AS count FROM information_schema.views WHERE table_schema = 'analytics'
  `)).rows[0].count);

  assert.deepEqual(objectCounts, { core_tables: 27, governance_tables: 5, raw_tables: 1 });
  assert.equal(analyticsViews, 9, "expected nine approved analytics views");

  const counts = (await client.query(`
    SELECT
      (SELECT count(*) FROM raw.source_row)::integer AS raw_rows,
      (SELECT count(*) FROM core.lot)::integer AS lots,
      (SELECT count(*) FROM core.purchase_lot)::integer AS purchase_lots,
      (SELECT count(*) FROM core.inward_receipt)::integer AS inward_receipts,
      (SELECT count(*) FROM core.sales_order_line)::integer AS order_lines,
      (SELECT count(*) FROM core.dispatch)::integer AS dispatches,
      (SELECT count(*) FROM core.quality_sample)::integer AS quality_samples,
      (SELECT count(*) FROM core.inventory_movement)::integer AS inventory_movements,
        (SELECT count(*)
           FROM governance.open_data_issues
          WHERE import_run_id = (
            SELECT max(id) FROM governance.import_run WHERE status = 'completed'
          ))::integer AS flags
  `)).rows[0];

  assert.ok(counts.raw_rows > 10_000, "expected raw workbook rows");
  assert.ok(counts.lots > 600, "expected normalized lots");
  assert.ok(counts.purchase_lots > 20, "expected purchased lots");
  assert.ok(counts.inward_receipts > 100, "expected inward receipts");
  assert.ok(counts.order_lines > 20, "expected sales-order lines");
  assert.ok(counts.dispatches > 100, "expected dispatch rows");
  assert.ok(counts.quality_samples > 100, "expected quality samples");
  assert.ok(counts.inventory_movements > 1_000, "expected inventory movements");
  assert.ok(counts.flags > 0, "expected real data-quality flags");

  const readiness = (await client.query("SELECT * FROM analytics.answer_readiness")).rows[0];
  assert.equal(readiness.status, "incomplete", "critical source gaps must make unqualified answers incomplete");

  const provenanceCount = Number((await client.query("SELECT count(*) AS count FROM governance.source_provenance")).rows[0].count);
  assert.equal(provenanceCount, counts.raw_rows, "every raw row must retain workbook, sheet and row provenance");

  const requiredFlags = (await client.query(`
    SELECT rule_code, count(*)::integer AS count
    FROM governance.open_data_issues
    WHERE import_run_id = (SELECT max(id) FROM governance.import_run WHERE status = 'completed')
      AND rule_code IN ('MISSING_DISPATCH_LOT', 'MISSING_PAYMENT_LEDGER', 'MISSING_AUCTION_BUYER_SOURCE', 'INVALID_RECOVERY_RANGE')
    GROUP BY rule_code
  `)).rows;
  const flagCodes = new Set(requiredFlags.map((row) => row.rule_code));
  for (const required of ["MISSING_DISPATCH_LOT", "MISSING_PAYMENT_LEDGER", "MISSING_AUCTION_BUYER_SOURCE", "INVALID_RECOVERY_RANGE"]) {
    assert.ok(flagCodes.has(required), `expected ${required} flag`);
  }

  const dispatchTotal = Number((await client.query("SELECT COALESCE(sum(quantity_mt), 0) AS total FROM core.dispatch")).rows[0].total);
  const dailyDispatchTotal = Number((await client.query("SELECT COALESCE(sum(dispatched_quantity_mt), 0) AS total FROM analytics.daily_customer_dispatch")).rows[0].total);
  assert.equal(dailyDispatchTotal, dispatchTotal, "daily dispatch view must preserve actual dispatch totals");

  const stockRows = Number((await client.query("SELECT count(*) AS count FROM analytics.stock_quality_cost")).rows[0].count);
  assert.ok(stockRows > 0, "stock quantity/quality/cost view must be populated");

  await client.query("BEGIN");
  const sample = (await client.query(`
    SELECT l.id AS lot_id, sr.id AS source_row_id
    FROM core.lot l CROSS JOIN LATERAL (SELECT id FROM raw.source_row LIMIT 1) sr LIMIT 1
  `)).rows[0];
  let rejectedNegativeQuantity = false;
  try {
    await client.query(`
      INSERT INTO core.inventory_movement
        (business_key, occurred_at, event_type, lot_id, direction, quantity_mt, source_row_id)
      VALUES ('constraint-check', now(), 'adjustment', $1, 'in', -1, $2)
    `, [sample.lot_id, sample.source_row_id]);
  } catch (error) {
    rejectedNegativeQuantity = error.code === "23514";
  }
  await client.query("ROLLBACK");
  assert.ok(rejectedNegativeQuantity, "database must reject negative actual quantities");

  const flags = (await client.query(`
    SELECT severity, rule_code, count(*)::integer AS issue_count
    FROM governance.open_data_issues
    WHERE import_run_id = (SELECT max(id) FROM governance.import_run WHERE status = 'completed')
    GROUP BY severity, rule_code
    ORDER BY CASE severity WHEN 'critical' THEN 1 WHEN 'warning' THEN 2 ELSE 3 END, issue_count DESC
  `)).rows;

  console.log(JSON.stringify({ objectCounts: { ...objectCounts, analytics_views: analyticsViews }, counts, readiness, flags }, null, 2));
  console.log("Simplified PostgreSQL schema checks passed.");
} finally {
  await client.end();
}
