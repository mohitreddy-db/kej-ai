import assert from "node:assert/strict";
import { loadDashboardData } from "../lib/dashboard-data.mjs";

const data = await loadDashboardData();
assert.equal(data.meta.scope, "Local PostgreSQL · normalized source of truth");
assert.deepEqual({
  inventory: data.inventory.length,
  purchases: data.purchases.length,
  sales: data.sales.length,
  auctions: data.auctions.length,
  quality: data.quality.length,
  production: data.production.length,
  blendStock: data.blendStock.length,
  transporters: data.transporters.length,
  counterparties: data.counterparties.length,
}, { inventory: 68, purchases: 41, sales: 32, auctions: 597, quality: 110, production: 760, blendStock: 89, transporters: 26, counterparties: 117 });
assert.equal(data.aggregates.overview.currentStock, 212943.25);
assert.ok(data.trustIssues.some((issue) => issue.ruleCode === "QUANTITY_MAGNITUDE_JUMP"));
assert.ok(data.trustIssues.some((issue) => issue.ruleCode === "PRODUCTION_MASS_BALANCE"));
assert.ok(data.trustIssues.some((issue) => issue.ruleCode === "STOCK_AGGREGATE_MASS_BALANCE"));
assert.ok(data.trustIssues.some((issue) => issue.ruleCode === "STALE_SOURCE"));
assert.ok(Object.values(data.validation).every((item) => ["verified", "flagged", "incomplete"].includes(item.status)));
for (const key of ["inventory", "purchases", "sales", "auctions", "quality", "production", "blendStock", "transporters", "counterparties"]) {
  assert.ok(data[key].every((row) => row.source?.sourceRowId && row.source?.file && row.source?.sheet && row.source?.row));
  assert.ok(data.evidence[key].length > 0);
}
console.log("PostgreSQL dashboard data and provenance checks passed.");
