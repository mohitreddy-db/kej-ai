import { createAgent } from "langchain";
import { ChatOpenAI } from "@langchain/openai";
import { isToolMessage } from "@langchain/core/messages";
import { agentTools } from "./agent-tools.mjs";
import { readableText } from "./rag.mjs";

const systemPrompt = `You are kejAI's read-only iron-ore analytics orchestrator.

Success means:
- understand the user's business intent;
- call the smallest approved tool that can answer it;
- report the tool's exact result, unit, period, calculation, status, limitation and sources;
- say Unsupported or Incomplete when no approved tool or required source exists.

Hard rules:
- Never invent, estimate, add, average, rank or otherwise calculate a business number yourself.
- For any numerical fact, comparison, ranking or data-quality claim, call a tool first and copy only tool-returned values.
- Keep orders, dispatches and external auction purchases separate.
- Treat search_workbook_evidence as source discovery only, never as a calculator.
- If a tool returns Flagged or Incomplete, preserve that status and explain the exact reason.
- Do not expose hidden reasoning. Answer in simple English with short paragraphs or bullets.
- Stop once the requested result and its material caveat are supported.`;

export function createKejAgent({ apiKey, model = "gpt-5.6-sol", safetyIdentifier }) {
  const llm = new ChatOpenAI({
    apiKey,
    model,
    useResponsesApi: true,
    reasoning: { effort: "low" },
    verbosity: "low",
    maxTokens: 700,
    maxRetries: 1,
    timeout: 45_000,
    modelKwargs: { store: false, safety_identifier: safetyIdentifier },
  });
  return createAgent({ model: llm, tools: agentTools, systemPrompt });
}

const text = (content) => typeof content === "string" ? content
  : Array.isArray(content) ? content.map((item) => typeof item === "string" ? item : item.text || "").join("\n") : "";

export function parseAgentResult(result) {
  const toolResults = result.messages.filter(isToolMessage).flatMap((message) => {
    try { return [JSON.parse(text(message.content))]; } catch { return []; }
  });
  const last = result.messages.at(-1);
  const answer = readableText(text(last?.content));
  const statuses = toolResults.map((item) => item.status).filter(Boolean);
  const status = !statuses.length || statuses.includes("incomplete") ? "incomplete"
    : statuses.includes("flagged") ? "flagged" : "verified";
  const sources = [...new Map(toolResults.flatMap((item) => item.sources || []).map((item) => [
    `${item.file}|${item.sheet}|${item.row}`, item,
  ])).values()].slice(0, 10);
  return { answer, status, sources, toolCalls: toolResults.length };
}
