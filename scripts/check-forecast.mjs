import assert from "node:assert/strict";
import { loadDashboardData } from "../lib/dashboard-data.mjs";
import { buildForecasts, linearForecast } from "../lib/forecast.mjs";

const exact = linearForecast([
  { x: 1, value: 12 },
  { x: 2, value: 14 },
  { x: 3, value: 16 },
]);
assert.equal(exact.forecast[0].value, 18);
assert.equal(exact.r2, 1);

const data = await loadDashboardData();
const forecasts = buildForecasts(data);
assert.equal(forecasts.length, 4);
assert.ok(forecasts.every((forecast) => forecast.forecast.length === 3));
assert.ok(forecasts.every((forecast) => forecast.history.every((point) => point.month <= forecast.cutoff)));

assert.equal(data.purchases[0].bidDate, "2025-11-14");
assert.equal(data.sales[0].poDate, "2026-03-20");
assert.equal(data.quality[0].reportDate, "2026-01-30");
assert.equal(data.production[0].productionDate, "2025-08-16");

const blankPrices = buildForecasts({
  meta: { snapshot: "2026-07-24" },
  production: [],
  sales: [],
  quality: [],
  auctions: [
    { closingDate: "2026-04-01", currentPrice: 100 },
    { closingDate: "2026-04-02", currentPrice: null },
    { closingDate: "2026-05-01", currentPrice: 200 },
    { closingDate: "2026-06-01", currentPrice: 300 },
  ],
}).find((forecast) => forecast.key === "auction");
assert.deepEqual(blankPrices.history.map((point) => point.value), [100, 200, 300]);
console.log("forecast checks passed");
