import assert from "node:assert/strict";
import { runBusinessSql, validateBusinessSql } from "../lib/sql-tool.mjs";

assert.throws(() => validateBusinessSql("DELETE FROM core.dispatch"), /SELECT/);
assert.throws(() => validateBusinessSql("SELECT * FROM raw.source_row"), /not available/);
assert.throws(() => validateBusinessSql("SELECT * FROM core.dispatch"), /source_row_id/);
assert.equal(validateBusinessSql("SELECT source_row_id FROM core.dispatch;"), "SELECT source_row_id FROM core.dispatch");
const roleBlocked = await runBusinessSql("SELECT d.source_row_id FROM core.dispatch d, raw.source_row r LIMIT 1");
assert.match(roleBlocked.error, /not available|permission denied/);

const datedDispatch = await runBusinessSql(`SELECT o.legal_name AS customer, d.dispatch_at::date AS dispatch_date,
  sum(d.quantity_mt)::float8 AS dispatched_quantity_mt, array_agg(d.source_row_id) AS source_row_ids
  FROM core.dispatch d JOIN core.organization o ON o.id=d.customer_id
  WHERE o.legal_name='Jindal Saw Limited' AND d.dispatch_at::date=DATE '2026-07-18'
  GROUP BY o.legal_name, d.dispatch_at::date`);
assert.equal(datedDispatch.error, undefined, datedDispatch.error);
assert.equal(datedDispatch.rows[0].dispatched_quantity_mt, 1732.14);
assert.equal(datedDispatch.sources[0].row, "190");
assert.deepEqual(datedDispatch.warnings, [{ rule: "MISSING_DISPATCH_LOT", count: 1 }]);

const mayBuyer = await runBusinessSql(`SELECT o.legal_name AS customer, sum(d.quantity_mt)::float8 AS dispatched_quantity_mt,
  array_agg(d.source_row_id) AS source_row_ids
  FROM core.dispatch d JOIN core.organization o ON o.id=d.customer_id
  WHERE d.dispatch_at>=DATE '2026-05-01' AND d.dispatch_at<DATE '2026-06-01'
  GROUP BY o.legal_name ORDER BY dispatched_quantity_mt DESC LIMIT 1`);
assert.equal(mayBuyer.error, undefined, mayBuyer.error);
assert.equal(mayBuyer.rows[0].customer, "X-India");
assert.equal(mayBuyer.rows[0].dispatched_quantity_mt, 18163.07);

const transporter = await runBusinessSql(`SELECT transporter, sum(awarded_quantity_mt)::float8 AS assigned_quantity_mt,
  count(*)::integer AS work_orders, array_agg(source_row_id) AS source_row_ids
  FROM analytics.transporter_work_order_activity GROUP BY transporter ORDER BY assigned_quantity_mt DESC LIMIT 1`);
assert.equal(transporter.error, undefined, transporter.error);
assert.deepEqual(transporter.rows[0], { transporter: "SRI KRISHNA LOGISTICS", assigned_quantity_mt: 128000, work_orders: 25 });

console.log("Read-only SQL agent checks passed.");
