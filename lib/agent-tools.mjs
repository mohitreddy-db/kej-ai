import { tool } from "langchain";
import { z } from "zod";
import { loadCalculationTools } from "./calculation-tools.mjs";
import { loadDashboardData } from "./dashboard-data.mjs";
import { buildDocuments, retrieve } from "./rag.mjs";

const source = (file, sheet, row) => ({ file, sheet, row });
const output = (value) => JSON.stringify(value);
const nameKey = (value) => String(value || "").toLowerCase().replace(/[^a-z0-9]/g, "");
const calculations = async () => {
  const data = await loadCalculationTools();
  if (!data.available) throw new Error(data.error);
  return data;
};

export const stockPositionTool = tool(async ({ category }) => {
  const data = await calculations();
  const item = data.stock.find((row) => row.category === category);
  if (!item) return output({ status: "incomplete", error: `No ${category} stock category is available.` });
  return output({
    status: item.status,
    result: {
      category, quantity_mt: item.totalQuantity, weighted_fe_pct: item.weightedFe,
      weighted_landed_cost_inr_per_mt: item.weightedLandedCost, covered_stock_value_inr: item.stockValue,
      fe_coverage_mt: item.qualityQuantity, cost_coverage_mt: item.costQuantity,
    },
    calculation: "Weighted value = sum(available quantity × value) ÷ quantity having that value.",
    period: "Latest stock snapshot",
    sources: [source("HO Stock Report (Daily).xlsx", "IRON ORE", "5:72")],
  });
}, {
  name: "get_stock_position",
  description: "Return current stock quantity, quantity-weighted Fe, weighted landed cost, covered stock value, coverage and trust status. Use for stock/average-grade/landed-cost questions. Never recompute these values.",
  schema: z.object({ category: z.enum(["all", "fine", "lump", "other", "tailings"]) }),
});

export const highestDailyDispatchTool = tool(async ({ customer }) => {
  const data = await calculations();
  let rows = data.dailyDispatch;
  if (customer) {
    const names = [...new Set(rows.map((row) => row.customer))];
    const exact = names.find((name) => nameKey(name) === nameKey(customer));
    const candidates = exact ? [exact] : names.filter((name) => name.toLowerCase().includes(customer.toLowerCase()));
    if (candidates.length !== 1) return output({
      status: "incomplete",
      error: candidates.length ? "Customer name is ambiguous." : "Customer is not present in dispatch data.",
      candidates: candidates.slice(0, 10),
    });
    rows = rows.filter((row) => row.customer === candidates[0]);
  }
  const item = rows[0];
  if (!item) return output({ status: "incomplete", error: "No dated dispatch rows are available." });
  return output({
    status: item.rowsMissingLot ? "flagged" : "verified",
    result: { customer: item.customer, date: item.date, dispatched_quantity_mt: item.quantity, source_row_count: item.dispatchCount },
    calculation: `Sum actual dispatch-detail quantity by customer and business date, ${customer ? `filter to ${item.customer}, ` : ""}then rank descending.`,
    limitation: item.rowsMissingLot ? `${item.rowsMissingLot} contributing row(s) lack KEJ lot linkage; this does not change the customer/date quantity but blocks lot quality and cost analysis.` : null,
    sources: [source("Daily Outward Report 2026-27 (Daily).xlsx", "Daily Outward Detail's", "2:219")],
  });
}, {
  name: "get_highest_daily_customer_dispatch",
  description: "Return the single highest dispatch total on one date, either across all customers or for one requested customer, using actual dispatch-detail rows rather than order quantities.",
  schema: z.object({ customer: z.string().trim().min(2).max(120).optional() }),
});

export const customerMonthlyActivityTool = tool(async ({ customer, start_month, end_month }) => {
  const data = await calculations();
  const key = nameKey(customer);
  const names = [...new Set(data.monthlyActivity.map((row) => row.customer))];
  const exact = names.find((name) => nameKey(name) === key);
  const candidates = exact ? [exact] : names.filter((name) => name.toLowerCase().includes(customer.toLowerCase()));
  if (candidates.length !== 1) return output({
    status: "incomplete",
    error: candidates.length ? "Customer name is ambiguous." : "Customer is not present in KEJ activity data.",
    candidates: candidates.slice(0, 10),
  });
  const matched = candidates[0];
  const rows = data.monthlyActivity.filter((row) => row.customer === matched
    && (!start_month || row.month >= start_month) && (!end_month || row.month <= end_month));
  const totals = rows.reduce((result, row) => {
    result[row.metric] = Number(((result[row.metric] || 0) + row.quantity).toFixed(3));
    return result;
  }, {});
  const hasExternal = data.monthlyActivity.some((row) => row.metric === "external_auction_allocated");
  return output({
    status: rows.length ? "flagged" : "incomplete",
    result: { customer: matched, start_month: start_month || null, end_month: end_month || null, monthly_rows: rows, totals_by_metric_mt: totals },
    definitions: {
      ordered_from_kej: "Customer order quantity grouped by PO month.",
      dispatched_by_kej: "Actual dispatch-detail quantity grouped by dispatch month.",
      external_auction_allocated: "Quantity allocated to the buyer in an external auction.",
    },
    limitation: hasExternal ? null : "External/competitor purchase awards are not available. Do not describe KEJ orders or dispatches as total market purchases.",
    sources: [source("Daily Outward Report 2026-27 (Daily).xlsx", "Outward Details + Daily Outward Detail's", "Source rows retained in PostgreSQL")],
  });
}, {
  name: "get_customer_monthly_activity",
  description: "Return month-wise and total customer activity with KEJ orders, KEJ dispatches and external auction allocations kept as separate metrics. Use empty strings for an unspecified start or end month.",
  schema: z.object({
    customer: z.string().min(2),
    start_month: z.string().regex(/^$|^\d{4}-\d{2}$/),
    end_month: z.string().regex(/^$|^\d{4}-\d{2}$/),
  }),
});

export const feDeviationTool = tool(async ({ comparison }) => {
  const data = await calculations();
  if (comparison === "dispatch_vs_order") {
    return output({
      status: "incomplete",
      error: "Dispatch/customer Fe deviation cannot be calculated.",
      coverage: data.dispatchQualityCoverage,
      missing: "Actual dispatch or customer-reported Fe linked to each dispatch/PO.",
      sources: [source("Daily Outward Report 2026-27 (Daily).xlsx", "Daily Outward Detail's", "2:219")],
    });
  }
  const rows = data.qualityDeviation.filter((row) => row.comparison === "inbound_vs_indicative");
  return output({
    status: rows.length ? "flagged" : "incomplete",
    result: { comparison, largest_absolute_deviation: rows[0] || null, top_deviations: rows.slice(0, 10) },
    calculation: "Received inward Fe minus indicative Fe, ranked by absolute Fe-point difference.",
    sources: rows.slice(0, 10).map((row) => row.source),
  });
}, {
  name: "get_fe_deviation",
  description: "Return the largest Fe deviation for either inward received versus indicative quality, or dispatch actual versus customer-order target. It explicitly reports missing outbound quality data.",
  schema: z.object({ comparison: z.enum(["inbound_vs_indicative", "dispatch_vs_order"]) }),
});

export const dataQualityTool = tool(async () => {
  const data = await loadDashboardData();
  const counts = data.trustIssues.reduce((map, issue) => {
    map[issue.ruleCode] = (map[issue.ruleCode] || 0) + 1;
    return map;
  }, {});
  const readiness = data.validation.trust;
  const lotIssues = data.trustIssues.filter((issue) => ["MISSING_DISPATCH_LOT", "MISSING_PRODUCTION_LOT", "UNMAPPED_LOT"].includes(issue.ruleCode));
  return output({
    status: readiness.status,
    result: {
      readiness,
      open_issue_count: data.trustIssues.length,
      top_rules: Object.entries(counts).sort((a, b) => b[1] - a[1]).slice(0, 12).map(([rule, count]) => ({ rule, count })),
      lot_linkage: {
        missing_dispatch_lot: counts.MISSING_DISPATCH_LOT || 0,
        missing_production_lot: counts.MISSING_PRODUCTION_LOT || 0,
        unmapped_lot: counts.UNMAPPED_LOT || 0,
        total: lotIssues.length,
      },
    },
    sources: lotIssues.map((issue) => issue.source).filter(Boolean).slice(0, 10),
  });
}, {
  name: "get_data_quality_status",
  description: "Return the current Verified, Flagged or Incomplete readiness, issue counts and most common deterministic validation failures.",
  schema: z.object({}),
});

export const evidenceSearchTool = tool(async ({ query }) => {
  const data = await loadDashboardData();
  const hits = retrieve(query, buildDocuments(data), 8);
  return output({
    status: "flagged",
    allowed_use: "Source discovery and non-calculated facts only. Do not calculate, total, average or rank these text records.",
    evidence: hits.map(({ area, text, source: hitSource }) => ({ area, text, source: hitSource })),
    sources: hits.map((hit) => hit.source).filter(Boolean),
  });
}, {
  name: "search_workbook_evidence",
  description: "Retrieve relevant PostgreSQL-backed workbook evidence for definitions or source discovery when no calculation tool applies. Never use it to perform a numerical calculation or ranking.",
  schema: z.object({ query: z.string().min(3).max(300) }),
});

export const agentTools = [
  stockPositionTool,
  highestDailyDispatchTool,
  customerMonthlyActivityTool,
  feDeviationTool,
  dataQualityTool,
  evidenceSearchTool,
];
