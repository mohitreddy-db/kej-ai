import { businessRules } from "../db/business-rules.mjs";
import { pool } from "../lib/postgres.mjs";

const client = await pool.connect();
try {
  await client.query("BEGIN");
  for (const rule of businessRules) {
    await client.query(`
      INSERT INTO governance.calculation_rule (code, version, definition, status, approved_by, approved_at)
      VALUES ($1, $2, $3, $4, $5, CASE WHEN $4 = 'approved' THEN now() END)
      ON CONFLICT (code, version) DO UPDATE SET
        definition = EXCLUDED.definition,
        status = EXCLUDED.status,
        approved_by = EXCLUDED.approved_by,
        approved_at = CASE WHEN EXCLUDED.status = 'approved'
          THEN COALESCE(governance.calculation_rule.approved_at, now()) END
    `, [rule.code, rule.version, rule.definition, rule.status, rule.approvedBy]);
  }
  await client.query("COMMIT");
  const { rows } = await client.query(
    "SELECT status, count(*)::integer AS count FROM governance.calculation_rule GROUP BY status ORDER BY status");
  console.log(`Loaded ${businessRules.length} business rules:`,
    rows.map((row) => `${row.count} ${row.status}`).join(", "));
} catch (error) {
  await client.query("ROLLBACK");
  console.error("Business rule load failed:", error.message);
  process.exitCode = 1;
} finally {
  client.release();
  await pool.end();
}
