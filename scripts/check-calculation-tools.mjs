import assert from "node:assert/strict";
import { loadCalculationTools } from "../lib/calculation-tools.mjs";

const tools = await loadCalculationTools();
assert.equal(tools.available, true);
assert.equal(tools.stock.find((item) => item.category === "all").totalQuantity, 212943.25);
assert.deepEqual(tools.dailyDispatch[0], {
  date: "2026-06-01",
  customer: "Jindal Saw Limited",
  quantity: 2164.96,
  dispatchCount: 2,
  rowsMissingLot: 2,
});
assert.ok(tools.monthlyActivity.some((item) => item.customer === "X-India" && item.month === "2026-04" && item.metric === "dispatched_by_kej"));
assert.equal(tools.qualityDeviation[0].deviation, 5.15);
assert.deepEqual(tools.dispatchQualityCoverage, { rows: 207, withFe: 0 });
console.log("Calculation tools checks passed.");
