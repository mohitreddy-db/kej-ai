import assert from "node:assert/strict";
import { AIMessage, ToolMessage } from "@langchain/core/messages";
import { createKejAgent, parseAgentResult } from "../lib/agent.mjs";
import { customerMonthlyActivityTool, dataQualityTool, feDeviationTool, highestDailyDispatchTool, stockPositionTool } from "../lib/agent-tools.mjs";

const stock = JSON.parse(await stockPositionTool.invoke({ category: "all" }));
assert.equal(stock.result.quantity_mt, 212943.25);
assert.equal(stock.result.weighted_fe_pct, 44.55791);

const dispatch = JSON.parse(await highestDailyDispatchTool.invoke({}));
assert.deepEqual(dispatch.result, {
  customer: "Jindal Saw Limited", date: "2026-06-01", dispatched_quantity_mt: 2164.96, source_row_count: 2,
});

const customerDispatch = JSON.parse(await highestDailyDispatchTool.invoke({ customer: "X India" }));
assert.deepEqual(customerDispatch.result, {
  customer: "X-India", date: "2026-05-07", dispatched_quantity_mt: 1370.46, source_row_count: 1,
});
assert.equal(customerDispatch.status, "flagged");

const customer = JSON.parse(await customerMonthlyActivityTool.invoke({ customer: "X-India", start_month: "2026-06", end_month: "2026-06" }));
assert.deepEqual(customer.result.totals_by_metric_mt, { dispatched_by_kej: 13887.64, ordered_from_kej: 10000 });
assert.match(customer.limitation, /External\/competitor/);

const deviation = JSON.parse(await feDeviationTool.invoke({ comparison: "dispatch_vs_order" }));
assert.equal(deviation.status, "incomplete");
assert.deepEqual(deviation.coverage, { rows: 207, withFe: 0 });

const quality = JSON.parse(await dataQualityTool.invoke({}));
assert.equal(quality.result.open_issue_count, 1869);
assert.equal(quality.result.lot_linkage.total > 0, true);
assert.equal(quality.sources.length > 0, true);

assert.equal(typeof createKejAgent({ apiKey: "test-key", safetyIdentifier: "test" }).invoke, "function");
assert.deepEqual(parseAgentResult({ messages: [
  new ToolMessage({ name: "test", tool_call_id: "1", content: JSON.stringify({ status: "flagged", sources: [{ file: "A.xlsx", sheet: "S", row: 2 }] }) }),
  new AIMessage("Source-backed answer"),
]}), {
  answer: "Source-backed answer", status: "flagged", sources: [{ file: "A.xlsx", sheet: "S", row: 2 }], toolCalls: 1,
});
console.log("LangGraph agent tool checks passed.");
