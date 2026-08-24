"use strict";

const { Pool } = require("pg");
const { LATEST_REQUIRED_MIGRATION } = require("./schema");

function createPool(config) {
  if (!config?.databaseUrl) return null;

  return new Pool({
    connectionString: config.databaseUrl,
    connectionTimeoutMillis: config.databaseConnectionTimeoutMs,
    ssl: config.databaseSsl
      ? { rejectUnauthorized: config.databaseSslRejectUnauthorized }
      : undefined,
    application_name: "omascote-api-radar-amistosos"
  });
}

async function checkDatabase(
  pool,
  { requiredMigration = LATEST_REQUIRED_MIGRATION } = {}
) {
  if (!pool) {
    return { ok: false, reason: "database_not_configured" };
  }

  try {
    await pool.query("SELECT 1 AS ready");

    const migrationTable = await pool.query(
      "SELECT to_regclass('public.schema_migrations') AS relation"
    );
    if (!migrationTable.rows?.[0]?.relation) {
      return { ok: false, reason: "database_schema_missing" };
    }

    const migration = await pool.query(
      "SELECT 1 FROM public.schema_migrations WHERE name = $1",
      [requiredMigration]
    );
    if (migration.rowCount !== 1) {
      return { ok: false, reason: "database_schema_outdated" };
    }

    return { ok: true };
  } catch {
    return { ok: false, reason: "database_unavailable" };
  }
}

module.exports = { createPool, checkDatabase };
