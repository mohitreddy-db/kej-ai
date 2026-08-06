import { createKejAgent, parseAgentResult } from "../../../lib/agent.mjs";

const buckets = new Map();
const clientIp = (request) => request.headers.get("cf-connecting-ip")
  || request.headers.get("x-forwarded-for")?.split(",")[0].trim()
  || "unknown";

// ponytail: per-isolate rate limit; replace with a Cloudflare Rate Limiting binding before high public traffic.
function rateLimited(key) {
  const now = Date.now();
  const recent = (buckets.get(key) || []).filter((timestamp) => now - timestamp < 10 * 60 * 1000);
  recent.push(now);
  buckets.set(key, recent);
  if (buckets.size > 500) for (const [id, values] of buckets) if (now - values.at(-1) > 10 * 60 * 1000) buckets.delete(id);
  return recent.length > 10;
}

async function safetyIdentifier(request) {
  const input = `${clientIp(request)}:${request.headers.get("user-agent") || "unknown"}`;
  const hash = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(input));
  return [...new Uint8Array(hash)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

export async function POST(request) {
  const env = globalThis.__KEJAI_ENV__ || process.env;
  const client = clientIp(request);
  if (rateLimited(client)) return Response.json({ error: "Too many questions. Please try again in ten minutes." }, { status: 429 });

  let body;
  try {
    body = await request.json();
  } catch {
    return Response.json({ error: "Invalid request." }, { status: 400 });
  }
  const question = String(body.question || "").trim();
  if (question.length < 3 || question.length > 500) {
    return Response.json({ error: "Enter a question between 3 and 500 characters." }, { status: 400 });
  }
  if (!env.OPENAI_API_KEY) {
    return Response.json({ error: "AI answers are waiting for the OPENAI_API_KEY production secret." }, { status: 503 });
  }

  try {
    const model = env.OPENAI_MODEL || "gpt-5.6-sol";
    const agent = await createKejAgent({ apiKey: env.OPENAI_API_KEY, model, safetyIdentifier: await safetyIdentifier(request) });
    const history = Array.isArray(body.history) ? body.history.slice(-6).map((item) => ({
      role: item.role === "assistant" ? "assistant" : "user",
      content: String(item.content || "").slice(0, 800),
    })) : [];
    const result = parseAgentResult(await agent.invoke({
      messages: [...history, { role: "user", content: question }],
    }, { recursionLimit: 16 }));
    if (!result.answer) return Response.json({ error: "The agent returned an empty answer." }, { status: 502 });
    return Response.json({ ...result, model, agent: "LangGraph ReAct" });
  } catch (error) {
    console.error("LangGraph agent error", error);
    return Response.json({ error: "The analytics agent could not answer right now." }, { status: 502 });
  }
}
