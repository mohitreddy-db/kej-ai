import { pool } from "./postgres.mjs";

let cache = { at: 0, block: "" };

// Highest approved version per code, formatted for the agent's system prompt.
// Cached for a minute so the per-request cost is one query at most.
export async function businessRulesBlock() {
  if (Date.now() - cache.at < 60_000) return cache.block;
  const { rows } = await pool.query(`
    SELECT DISTINCT ON (code) code, version, definition
    FROM governance.calculation_rule
    WHERE status = 'approved'
    ORDER BY code, version DESC`);
  const gaps = rows.filter((row) => row.code.startsWith("GAP_"));
  const rules = rows.filter((row) => !row.code.startsWith("GAP_"));
  const line = (row) => `- ${row.code} v${row.version}: ${row.definition}`;
  const block = [
    "Approved business rules and definitions (the single source of truth; name the rule code your answer relies on):",
    ...rules.map(line),
    "",
    "Known data gaps (when one applies, answer Incomplete and name the gap):",
    ...gaps.map(line),
  ].join("\n");
  cache = { at: Date.now(), block };
  return block;
}
