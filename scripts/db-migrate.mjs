import fs from "node:fs";
import pg from "pg";

const databaseUrl = process.env.DATABASE_URL || "postgresql://kejai:kejai_local@127.0.0.1:54329/kejai";
const client = new pg.Client({ connectionString: databaseUrl });

try {
  await client.connect();
  if (process.argv.includes("--reset")) {
    await client.query("DROP SCHEMA IF EXISTS analytics, core, raw, governance CASCADE");
  }
  await client.query(fs.readFileSync(new URL("../db/schema.sql", import.meta.url), "utf8"));
  console.log(`PostgreSQL schema ${process.argv.includes("--reset") ? "reset and " : ""}applied.`);
} finally {
  await client.end();
}
