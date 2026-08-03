const round = (value, places = 2) => Number(value.toFixed(places));

export function createBlendPlans(stock, { product, quantity, targetFe, saleRate }) {
  const lots = stock
    .filter((lot) => lot.product === product && lot.quantity > 0 && lot.fe > 0)
    .sort((a, b) => a.lot.localeCompare(b.lot));
  const candidates = [];

  for (const lot of lots) {
    if (Math.abs(lot.fe - targetFe) <= 0.05 && lot.quantity >= quantity) {
      candidates.push(makeCandidate([{ lot, quantity }], quantity, targetFe, saleRate));
    }
  }
  for (let i = 0; i < lots.length; i += 1) {
    for (let j = i + 1; j < lots.length; j += 1) {
      const low = lots[i].fe <= lots[j].fe ? lots[i] : lots[j];
      const high = low === lots[i] ? lots[j] : lots[i];
      if (low.fe > targetFe || high.fe < targetFe || high.fe === low.fe) continue;
      const lowQuantity = quantity * (high.fe - targetFe) / (high.fe - low.fe);
      const highQuantity = quantity - lowQuantity;
      if (lowQuantity <= low.quantity + 0.001 && highQuantity <= high.quantity + 0.001) {
        candidates.push(makeCandidate([
          { lot: low, quantity: lowQuantity },
          { lot: high, quantity: highQuantity },
        ], quantity, targetFe, saleRate));
      }
    }
  }
  if (!candidates.length) return { plans: [], reason: "No available one- or two-lot blend can meet this target and quantity." };

  const minCost = Math.min(...candidates.map((plan) => plan.unitCost));
  const maxCost = Math.max(...candidates.map((plan) => plan.unitCost));
  const minAge = Math.min(...candidates.map((plan) => plan.averageAge));
  const maxAge = Math.max(...candidates.map((plan) => plan.averageAge));
  const normalized = (value, min, max) => max === min ? 0 : (value - min) / (max - min);
  const byProfit = [...candidates].sort((a, b) => b.margin - a.margin || a.key.localeCompare(b.key));
  const byAge = [...candidates].sort((a, b) => b.averageAge - a.averageAge || b.margin - a.margin || a.key.localeCompare(b.key));
  const byBalance = [...candidates].sort((a, b) => {
    const scoreA = normalized(a.unitCost, minCost, maxCost) * 0.6 + (1 - normalized(a.averageAge, minAge, maxAge)) * 0.4;
    const scoreB = normalized(b.unitCost, minCost, maxCost) * 0.6 + (1 - normalized(b.averageAge, minAge, maxAge)) * 0.4;
    return scoreA - scoreB || a.key.localeCompare(b.key);
  });
  const used = new Set();
  const choose = (list) => list.find((plan) => !used.has(plan.key)) || list[0];
  const label = (plan, name, note) => ({ ...plan, name, note });
  const maxProfit = choose(byProfit);
  used.add(maxProfit.key);
  const balanced = choose(byBalance);
  used.add(balanced.key);
  const fastest = choose(byAge);

  return {
    plans: [
      label(maxProfit, "Maximum profit", "Lowest-cost valid mix at the selected selling rate."),
      label(balanced, "Balanced", "60% cost efficiency and 40% stock-age priority."),
      label(fastest, "Fastest-moving", "Uses the oldest matched inventory first."),
    ],
    reason: null,
  };
}

function makeCandidate(parts, quantity, targetFe, saleRate) {
  const mix = parts.map((part) => ({
    lot: part.lot.lot,
    description: part.lot.description,
    quantity: round(part.quantity),
    fe: part.lot.fe,
    landedCost: part.lot.landedCost,
    remaining: round(part.lot.quantity - part.quantity),
    source: part.lot.source,
  }));
  const totalCost = mix.reduce((total, part) => total + part.quantity * part.landedCost, 0);
  const weightedFe = mix.reduce((total, part) => total + part.quantity * part.fe, 0) / quantity;
  const averageAge = parts.reduce((total, part, index) => total + mix[index].quantity * (part.lot.ageDays || 0), 0) / quantity;
  return {
    key: mix.map((part) => part.lot).join("+"),
    mix,
    quantity: round(quantity),
    targetFe,
    blendedFe: round(weightedFe),
    unitCost: round(totalCost / quantity),
    totalCost: round(totalCost),
    expectedRealization: round(quantity * saleRate),
    margin: round(quantity * saleRate - totalCost),
    averageAge: round(averageAge, 1),
  };
}

export function assessPurchase(stock, { product, grade, quantity, landedCost, targetFe }) {
  const highGrade = stock
    .filter((lot) => lot.product === product && lot.fe > targetFe && lot.quantity > 0)
    .sort((a, b) => b.fe - a.fe || a.lot.localeCompare(b.lot));
  let requiredWeightedFe = quantity * (targetFe - grade);
  let highQuantity = 0;
  let highCost = 0;
  const used = [];
  for (const lot of highGrade) {
    if (requiredWeightedFe <= 0) break;
    const liftPerTonne = lot.fe - targetFe;
    const take = Math.min(lot.quantity, requiredWeightedFe / liftPerTonne);
    if (take <= 0) continue;
    highQuantity += take;
    highCost += take * lot.landedCost;
    requiredWeightedFe -= take * liftPerTonne;
    used.push({ lot: lot.lot, quantity: round(take), fe: lot.fe });
  }
  if (requiredWeightedFe > 0.01) {
    return {
      feasible: false,
      message: `Current ${product.toLowerCase()} stock cannot lift the full purchase to Fe ${targetFe}.`,
      used,
    };
  }
  const totalQuantity = quantity + highQuantity;
  const blendedCost = (quantity * landedCost + highCost) / totalQuantity;
  return {
    feasible: true,
    message: `Blendable to Fe ${targetFe}, but it consumes ${round(highQuantity)} MT of higher-grade stock.`,
    highQuantity: round(highQuantity),
    totalQuantity: round(totalQuantity),
    blendedCost: round(blendedCost),
    used,
  };
}
