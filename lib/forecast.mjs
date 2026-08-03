const monthIndex = (month) => {
  const [year, value] = month.split("-").map(Number);
  return year * 12 + value - 1;
};

const monthName = (index) =>
  new Intl.DateTimeFormat("en-IN", { month: "short", year: "numeric" })
    .format(new Date(Date.UTC(Math.floor(index / 12), index % 12, 1)));

function monthly(rows, dateKey, valueKey, mode, cutoff) {
  const buckets = new Map();
  for (const row of rows) {
    const month = String(row[dateKey] || "").slice(0, 7);
    const rawValue = row[valueKey];
    const value = Number(rawValue);
    if (rawValue == null || rawValue === "") continue;
    if (!/^\d{4}-\d{2}$/.test(month) || !Number.isFinite(value) || month > cutoff) continue;
    const bucket = buckets.get(month) || { total: 0, count: 0 };
    bucket.total += value;
    bucket.count += 1;
    buckets.set(month, bucket);
  }
  return [...buckets].sort(([a], [b]) => a.localeCompare(b)).map(([month, bucket]) => ({
    month,
    label: monthName(monthIndex(month)),
    x: monthIndex(month),
    value: mode === "average" ? bucket.total / bucket.count : bucket.total,
  }));
}

export function linearForecast(points, periods = 3) {
  if (points.length < 3) return { history: points, forecast: [], slope: 0, r2: 0, confidence: "Insufficient" };
  const meanX = points.reduce((sum, point) => sum + point.x, 0) / points.length;
  const meanY = points.reduce((sum, point) => sum + point.value, 0) / points.length;
  const denominator = points.reduce((sum, point) => sum + (point.x - meanX) ** 2, 0);
  const slope = denominator
    ? points.reduce((sum, point) => sum + (point.x - meanX) * (point.value - meanY), 0) / denominator
    : 0;
  const intercept = meanY - slope * meanX;
  const residual = points.reduce((sum, point) => sum + (point.value - (intercept + slope * point.x)) ** 2, 0);
  const total = points.reduce((sum, point) => sum + (point.value - meanY) ** 2, 0);
  const r2 = total ? Math.max(0, 1 - residual / total) : 1;
  const last = points.at(-1).x;
  const forecast = Array.from({ length: periods }, (_, index) => {
    const x = last + index + 1;
    return { x, month: `${Math.floor(x / 12)}-${String(x % 12 + 1).padStart(2, "0")}`, label: monthName(x), value: Math.max(0, intercept + slope * x) };
  });
  const confidence = points.length >= 8 && r2 >= 0.6 ? "Higher" : points.length >= 5 && r2 >= 0.3 ? "Moderate" : "Low";
  return { history: points, forecast, slope, r2, confidence };
}

export function buildForecasts(data) {
  const snapshot = new Date(`${data.meta.snapshot}T00:00:00Z`);
  snapshot.setUTCMonth(snapshot.getUTCMonth() - 1);
  const cutoff = snapshot.toISOString().slice(0, 7);
  const definitions = [
    {
      key: "production",
      label: "Production feed",
      unit: "MT",
      source: "PRODUCTION REPORT FROM 15-AUG-2025.xlsx → PRODUCTION AND RECOVERY",
      calculation: "Monthly sum of feed quantity; linear regression fitted to complete months.",
      points: monthly(data.production, "productionDate", "feed", "sum", cutoff),
    },
    {
      key: "sales",
      label: "Sales order quantity",
      unit: "MT",
      source: "Daily Outward Report 2026-27 (Daily).xlsx → Outward Details",
      calculation: "Monthly sum of order quantity by PO date; linear regression fitted to complete months.",
      points: monthly(data.sales, "poDate", "orderQty", "sum", cutoff),
    },
    {
      key: "inward",
      label: "Quality-recorded inward",
      unit: "MT",
      source: "Inward quality report (Weekly).xlsx → Inward Quality Report",
      calculation: "Monthly sum of inward quantity in quality records; linear regression fitted to complete months.",
      points: monthly(data.quality, "reportDate", "inwardQuantity", "sum", cutoff),
    },
    {
      key: "auction",
      label: "Average auction price",
      unit: "₹/MT",
      source: "Auction Rate Chart FY-2026-27 (Depends On Auction).xlsx → Consolidated Data",
      calculation: "Monthly average current auction price; linear regression fitted to complete months.",
      points: monthly(data.auctions, "closingDate", "currentPrice", "average", cutoff),
    },
  ];
  return definitions.map(({ points, ...definition }) => ({ ...definition, ...linearForecast(points), cutoff }));
}
