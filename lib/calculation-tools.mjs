import { pool } from "./postgres.mjs";

const number = (value) => value == null ? null : Number(value);
const date = (value) => value instanceof Date ? value.toISOString().slice(0, 10) : String(value || "").slice(0, 10);
const round = (value, places = 2) => Number(Number(value || 0).toFixed(places));

function combineStock(rows) {
  const totalQuantity = rows.reduce((sum, row) => sum + row.totalQuantity, 0);
  const qualityQuantity = rows.reduce((sum, row) => sum + row.qualityQuantity, 0);
  const costQuantity = rows.reduce((sum, row) => sum + row.costQuantity, 0);
  const stockValue = rows.reduce((sum, row) => sum + row.costQuantity * (row.weightedLandedCost || 0), 0);
  return {
    category: "all",
    totalQuantity: round(totalQuantity, 3),
    qualityQuantity: round(qualityQuantity, 3),
    weightedFe: qualityQuantity ? round(rows.reduce((sum, row) => sum + row.qualityQuantity * (row.weightedFe || 0), 0) / qualityQuantity, 5) : null,
    costQuantity: round(costQuantity, 3),
    weightedLandedCost: costQuantity ? round(stockValue / costQuantity, 4) : null,
    stockValue: round(stockValue, 2),
    status: rows.every((row) => row.status === "verified") ? "verified" : rows.some((row) => row.status === "incomplete") ? "incomplete" : "flagged",
  };
}

export async function loadCalculationTools() {
  try {
    const [stockResult, dispatchResult, monthlyResult, deviationResult, coverageResult, readinessResult] = await Promise.all([
      pool.query(`SELECT category, total_quantity_mt::float8, quality_covered_quantity_mt::float8,
        weighted_fe_pct::float8, cost_covered_quantity_mt::float8,
        weighted_landed_cost_inr_per_mt::float8, status
        FROM analytics.stock_quality_cost ORDER BY category`),
      pool.query(`SELECT business_date::text, customer, dispatched_quantity_mt::float8, dispatch_count, rows_missing_lot
        FROM analytics.daily_customer_dispatch ORDER BY dispatched_quantity_mt DESC, business_date, customer`),
      pool.query(`SELECT customer, month::text, metric, quantity_mt::float8
        FROM analytics.customer_monthly_activity ORDER BY customer, month, metric`),
      pool.query(`SELECT q.kej_lot_number, q.comparison, q.expected_fe_pct::float8, q.actual_fe_pct::float8,
        q.deviation_fe_points::float8, actual.workbook_name, actual.sheet_name, actual.row_number
        FROM analytics.quality_deviation q
        LEFT JOIN governance.source_provenance actual ON actual.source_row_id = q.actual_source_row_id
        ORDER BY abs(q.deviation_fe_points) DESC LIMIT 30`),
      pool.query(`SELECT count(*)::integer AS dispatch_rows,
        count(*) FILTER (WHERE qs.fe_pct IS NOT NULL)::integer AS rows_with_fe
        FROM core.dispatch d LEFT JOIN core.quality_sample qs ON qs.dispatch_id = d.id AND qs.sample_stage = 'dispatch'`),
      pool.query("SELECT * FROM analytics.answer_readiness"),
    ]);
    const stock = stockResult.rows.map((row) => {
      const item = {
        category: row.category,
        totalQuantity: number(row.total_quantity_mt),
        qualityQuantity: number(row.quality_covered_quantity_mt) || 0,
        weightedFe: number(row.weighted_fe_pct),
        costQuantity: number(row.cost_covered_quantity_mt) || 0,
        weightedLandedCost: number(row.weighted_landed_cost_inr_per_mt),
        status: row.status,
      };
      item.stockValue = round(item.costQuantity * (item.weightedLandedCost || 0), 2);
      return item;
    });
    return {
      available: true,
      stock: [combineStock(stock), ...stock],
      dailyDispatch: dispatchResult.rows.map((row) => ({
        date: date(row.business_date), customer: row.customer, quantity: number(row.dispatched_quantity_mt),
        dispatchCount: Number(row.dispatch_count), rowsMissingLot: Number(row.rows_missing_lot),
      })),
      monthlyActivity: monthlyResult.rows.map((row) => ({
        customer: row.customer, month: date(row.month).slice(0, 7), metric: row.metric, quantity: number(row.quantity_mt),
      })),
      qualityDeviation: deviationResult.rows.map((row) => ({
        lot: row.kej_lot_number, comparison: row.comparison, expectedFe: number(row.expected_fe_pct),
        actualFe: number(row.actual_fe_pct), deviation: number(row.deviation_fe_points),
        source: { file: row.workbook_name, sheet: row.sheet_name, row: row.row_number },
      })),
      dispatchQualityCoverage: {
        rows: Number(coverageResult.rows[0].dispatch_rows), withFe: Number(coverageResult.rows[0].rows_with_fe),
      },
      readiness: readinessResult.rows[0],
    };
  } catch (error) {
    console.error("Local calculation tools unavailable", error.message);
    return { available: false, error: "Local PostgreSQL is unavailable. Start it with npm run db:up." };
  }
}
