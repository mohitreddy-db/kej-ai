import { buildForecasts } from "./forecast.mjs";

const stopWords = new Set(["a", "an", "and", "are", "as", "at", "be", "by", "do", "for", "from", "how", "i", "in", "is", "it", "of", "on", "or", "our", "the", "to", "we", "what", "which", "with"]);
const singular = (token) => token.endsWith("ies") ? `${token.slice(0, -3)}y` : token.endsWith("s") && !token.endsWith("ss") ? token.slice(0, -1) : token;
const tokens = (value) => [...new Set((String(value).toLowerCase().match(/[a-z0-9]+/g) || []).flatMap((token) => [token, singular(token)]))]
  .filter((token) => token.length > 1 && !stopWords.has(token));
const recordText = (record) => Object.entries(record)
  .filter(([key, value]) => key !== "source" && value !== null && value !== "")
  .map(([key, value]) => `${key}=${value}`)
  .join("; ");

export function buildDocuments(data) {
  const documents = [
    {
      id: "overview",
      area: "overview stock inventory inward purchase sales dispatch production auction buyers",
      source: { file: "Multiple workbooks", sheet: "Dashboard aggregates", row: "See source dashboards" },
      text: recordText(data.aggregates.overview),
    },
    {
      id: "quality-summary",
      area: "quality grade fe laboratory received indicative",
      source: { file: "Inward quality report (Weekly).xlsx", sheet: "Inward Quality Report", row: "2:111" },
      text: recordText(data.aggregates.quality),
    },
  ];
  const add = (area, rows) => rows.forEach((row, index) => documents.push({
    id: `${area}-${index}`,
    area,
    source: row.source,
    text: recordText(row),
  }));
  add("inventory stock lot quantity landed cost grade fe", data.inventory);
  add("purchase inward supplier lifted balance permit age", data.purchases);
  add("sales dispatch customer order po permit revenue", data.sales);
  add("auction market mine price premium lot", data.auctions);
  add("quality laboratory supplier grade fe chemistry inward", data.quality);
  add("production plant feed recovery recovered tailings", data.production);
  add("blend planning stock fines lumps grade fe cost age", data.blendStock);
  add("transporter logistics work order mine rate distance", data.transporters);
  add("buyer customer market destination type", data.counterparties);
  add("data trust issue warning error incomplete flagged", data.trustIssues);
  const customerSummary = Object.values(data.sales.reduce((map, item) => {
    map[item.customer] ||= { customer: item.customer, orderedMT: 0, dispatchedMT: 0, balanceMT: 0, dispatchedValueINR: 0 };
    map[item.customer].orderedMT += item.orderQty || 0;
    map[item.customer].dispatchedMT += item.dispatched || 0;
    map[item.customer].balanceMT += item.balance || 0;
    map[item.customer].dispatchedValueINR += (item.dispatched || 0) * (item.rate || 0);
    return map;
  }, {})).sort((a, b) => b.orderedMT - a.orderedMT);
  documents.push({
    id: "customer-summary",
    area: "customer buyer best ranking sales order dispatch revenue",
    source: { file: "Daily Outward Report 2026-27 (Daily).xlsx", sheet: "Outward Details", row: "3:34" },
    text: `customerCount=${customerSummary.length}; ${customerSummary.map((item) => recordText({ ...item, dispatchedValueINR: Number(item.dispatchedValueINR.toFixed(2)) })).join(" | ")}`,
  });
  for (const [index, item] of data.aggregates.mineQuality.entries()) documents.push({
    id: `mine-quality-${index}`,
    area: "mine supplier quality under delivered fe grade comparison",
    source: { file: "Inward quality report (Weekly).xlsx", sheet: "Inward Quality Report", row: "2:111" },
    text: recordText(item),
  });
  for (const [index, item] of data.aggregates.transporterSummary.entries()) documents.push({
    id: `transporter-summary-${index}`,
    area: "transporter logistics performance best ranking activity comparison work orders rate",
    source: { file: "INWARD TRANSPORTER -WORK ORDER FILE-CONTROL SHEET FORMAT.xlsm", sheet: "INWARD FINAL 26-27", row: "3:88" },
    text: `transporter=${item.transporter}; workOrders=${item.workOrders} work orders; averageAwardedRate=${item.averageRate == null ? "unavailable" : `₹${item.averageRate}/MT`}; status=${item.status}`,
  });
  for (const forecast of buildForecasts(data)) documents.push({
    id: `forecast-${forecast.key}`,
    area: `forecast prediction trend estimate ${forecast.label}`,
    source: { file: forecast.source.split(" → ")[0], sheet: forecast.source.split(" → ")[1], row: `Complete months through ${forecast.cutoff}` },
    text: `${forecast.calculation}; confidence=${forecast.confidence}; r2=${forecast.r2.toFixed(3)}; history=${recordText(Object.fromEntries(forecast.history.map((point) => [point.month, Math.round(point.value)])))}; forecast=${recordText(Object.fromEntries(forecast.forecast.map((point) => [point.month, Math.round(point.value)])))}`,
  });
  return documents;
}

export function retrieve(question, documents, limit = 14) {
  const queryTokens = tokens(question);
  const phrase = String(question).toLowerCase().trim();
  const ranked = documents.map((document) => {
    const area = document.area.toLowerCase();
    const text = document.text.toLowerCase();
    const haystack = `${area} ${text}`;
    const score = queryTokens.reduce((total, token) => total + (area.includes(token) ? 3 : 0) + (text.includes(token) ? 1 : 0), 0)
      + (phrase.length > 4 && haystack.includes(phrase) ? 5 : 0);
    return { ...document, score };
  }).filter((document) => document.score > 0)
    .sort((a, b) => b.score - a.score || a.id.localeCompare(b.id))
    .slice(0, limit);
  return ranked.length ? ranked : documents.slice(0, 2);
}

export const contextFrom = (documents) => documents
  .map((document, index) => `[${index + 1}] ${document.area}\nSource: ${document.source?.file} → ${document.source?.sheet} → ${document.source?.row}\nData: ${document.text}`)
  .join("\n\n");

export function readableText(value) {
  return String(value).split("\n")
    .filter((line) => !/^\s*\|?[\s:|-]+\|?\s*$/.test(line))
    .map((line) => line.replace(/\*\*(.*?)\*\*/g, "$1").replace(/`([^`]+)`/g, "$1")
      .replace(/^#{1,6}\s+/, "").replace(/^\s*[-*]\s+/, "• ")
      .replace(/^\s*\|(.+)\|\s*$/, (_, cells) => cells.split("|").map((cell) => cell.trim()).join(" — ")))
    .join("\n").replace(/\n{3,}/g, "\n\n").trim();
}
