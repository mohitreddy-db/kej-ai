import assert from "node:assert/strict";
import { assessPurchase, createBlendPlans } from "../lib/blend.mjs";

const stock = [
  { product: "Fines", lot: "LOW", description: "Low", quantity: 1000, fe: 55, landedCost: 2000, ageDays: 90, source: {} },
  { product: "Fines", lot: "HIGH", description: "High", quantity: 1000, fe: 65, landedCost: 4000, ageDays: 20, source: {} },
];
const first = createBlendPlans(stock, { product: "Fines", quantity: 1000, targetFe: 60, saleRate: 5000 });
const second = createBlendPlans(stock, { product: "Fines", quantity: 1000, targetFe: 60, saleRate: 5000 });
assert.deepEqual(first, second);
assert.equal(first.plans[0].blendedFe, 60);
assert.equal(first.plans[0].quantity, 1000);
assert.equal(assessPurchase(stock, { product: "Fines", grade: 55, quantity: 100, landedCost: 1800, targetFe: 60 }).feasible, true);

const fractional = createBlendPlans([
  { ...stock[0], lot: "FRACTIONAL-LOW", fe: 59.7, landedCost: 2517 },
  { ...stock[1], lot: "FRACTIONAL-HIGH", fe: 60.41, landedCost: 3185 },
], { product: "Fines", quantity: 1000, targetFe: 60, saleRate: 6000 }).plans[0];
const displayedCost = fractional.mix.reduce((sum, part) => sum + part.quantity * part.landedCost, 0);
assert.equal(fractional.totalCost, displayedCost);
assert.equal(fractional.margin, 6000000 - displayedCost);
console.log("blend checks passed");
