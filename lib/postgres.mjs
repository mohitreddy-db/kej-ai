import pg from "pg";

export const pool = new pg.Pool({
  connectionString: process.env.DATABASE_URL || "postgresql://kejai:kejai_local@127.0.0.1:54329/kejai",
  max: 5,
  allowExitOnIdle: true,
});
