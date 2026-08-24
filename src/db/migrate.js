"use strict";

const fs = require("fs");
const path = require("path");
const { createRadarConfig } = require("../config/radar");
const { createPool } = require("./pool");

const MIGRATION_LOCK_ID = 724_202_608;

function listMigrationFiles(directory) {
  return fs.readdirSync(directory)
    .filter(name => /^\d{3}_[a-z0-9_-]+\.sql$/i.test(name))
    .sort();
}

async function migrate({ pool, directory = path.join(__dirname, "migrations") }) {
  if (!pool) throw new Error("DATABASE_URL is required to run migrations");

  const client = await pool.connect();
  const applied = [];

  try {
    await client.query("SELECT pg_advisory_lock($1)", [MIGRATION_LOCK_ID]);
    await client.query(`
      CREATE TABLE IF NOT EXISTS public.schema_migrations (
        name text PRIMARY KEY,
        applied_at timestamptz NOT NULL DEFAULT now()
      )
    `);

    for (const name of listMigrationFiles(directory)) {
      const found = await client.query(
        "SELECT 1 FROM public.schema_migrations WHERE name = $1",
        [name]
      );
      if (found.rowCount > 0) continue;

      const sql = fs.readFileSync(path.join(directory, name), "utf8");
      await client.query("BEGIN");
      try {
        await client.query(sql);
        await client.query("INSERT INTO public.schema_migrations(name) VALUES ($1)", [name]);
        await client.query("COMMIT");
        applied.push(name);
      } catch (error) {
        await client.query("ROLLBACK");
        throw error;
      }
    }

    return applied;
  } finally {
    try {
      await client.query("SELECT pg_advisory_unlock($1)", [MIGRATION_LOCK_ID]);
    } finally {
      client.release();
    }
  }
}

async function main() {
  const config = createRadarConfig();
  const pool = createPool(config);

  try {
    const applied = await migrate({ pool });
    console.log(applied.length ? `Applied: ${applied.join(", ")}` : "Database is up to date");
  } finally {
    if (pool) await pool.end();
  }
}

if (require.main === module) {
  main().catch(error => {
    console.error("Migration failed:", error.message);
    process.exitCode = 1;
  });
}

module.exports = { listMigrationFiles, migrate };
