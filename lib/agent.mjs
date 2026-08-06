import { createAgent } from "langchain";
import { ChatOpenAI } from "@langchain/openai";
import { isToolMessage } from "@langchain/core/messages";
import { agentTools } from "./agent-tools.mjs";
import { readableText } from "./rag.mjs";
import { businessRulesBlock } from "./rules.mjs";

const systemPrompt = `You are kejAI's read-only iron-ore analytics orchestrator.

Success means:
- understand the user's business intent;
- use query_business_data first for retrieval, filtering, sums, counts, grouping, rankings and comparisons;
- use a specialized tool only when the question needs its approved formula or business rule;
- report the tool's exact result, unit, period, calculation, status, limitation and sources;
- say Unsupported or Incomplete when no approved tool or required source exists.

Hard rules:
- Never invent, estimate, add, average, rank or otherwise calculate a business number yourself.
- For any numerical fact, comparison, ranking or data-quality claim, call a tool first and copy only tool-returned values.
- Never calculate across rows returned by query_business_data. Make PostgreSQL return the final aggregate or ranking.
- Apply the approved business rules and data gaps listed at the end of this prompt; they override any other interpretation, and you should name the rule code an answer relies on.
- For blend-plan requests (product, target Fe, quantity), compute one- and two-lot candidates in SQL with the tool's blend recipe from the latest stock snapshot, rank by blended landed cost per BLEND_MAX_PROFIT, and report mix quantities, blended Fe, unit cost and stock caveats.
- Treat dispatch_at and receipt_at as business dates unless the user explicitly asks for time; do not report an internal UTC time from a date-only workbook cell.
- Resolve informal organization names through PostgreSQL using one distinctive token before the fact query. If a SQL query returns no rows, make one safe name/date correction attempt before answering Incomplete.
- If name resolution returns multiple candidates, query the requested fact for those candidates and answer if exactly one has matching data. Ask the user only when multiple candidates still match.
- Keep orders, dispatches and external auction purchases separate.
- Treat search_workbook_evidence as source discovery only, never as a calculator.
- If a tool returns Flagged or Incomplete, preserve that status and explain the exact reason.
- Do not expose hidden reasoning. Answer in simple English with short paragraphs or bullets.
- Stop once the requested result and its material caveat are supported.`;

export async function createKejAgent({ apiKey, model = "gpt-5.6-sol", safetyIdentifier }) {
  const rules = await businessRulesBlock().catch((error) => {
    console.error("Business rules unavailable", error.message);
    return "Business rules could not be loaded from PostgreSQL; treat definitions as unconfirmed and say so.";
  });
  const llm = new ChatOpenAI({
    apiKey,
    model,
    useResponsesApi: true,
    reasoning: { effort: "medium" },
    verbosity: "low",
    maxTokens: 2000,
    maxRetries: 2,
    timeout: 90_000,
    modelKwargs: { store: false, safety_identifier: safetyIdentifier },
  });
  return createAgent({ model: llm, tools: agentTools, systemPrompt: `${systemPrompt}\n\n${rules}` });
}

const text = (content) => typeof content === "string" ? content
  : Array.isArray(content) ? content.map((item) => typeof item === "string" ? item : item.text || "").join("\n") : "";

export function parseAgentResult(result) {
  const toolResults = result.messages.filter(isToolMessage).flatMap((message) => {
    try { return [JSON.parse(text(message.content))]; } catch { return []; }
  });
  const last = result.messages.at(-1);
  const answer = readableText(text(last?.content));
  const status = toolResults.at(-1)?.status || "incomplete";
  const sources = [...new Map(toolResults.flatMap((item) => item.sources || []).map((item) => [
    `${item.file}|${item.sheet}|${item.row}`, item,
  ])).values()].slice(0, 10);
  return { answer, status, sources, toolCalls: toolResults.length };
}
