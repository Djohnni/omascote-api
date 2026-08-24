"use strict";

const { Pool } = require("pg");

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

async function checkDatabase(pool) {
  if (!pool) {
    return { ok: false, reason: "database_not_configured" };
  }

  try {
    await pool.query("SELECT 1 AS ready");
    return { ok: true };
  } catch (error) {
    return {
      ok: false,
      reason: "database_unavailable",
      code: String(error?.code || "unknown")
    };
  }
}

module.exports = { createPool, checkDatabase };
