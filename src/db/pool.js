"use strict";

const { Pool } = require("pg");
const { LATEST_REQUIRED_MIGRATION } = require("./schema");

function normalizeEmbeddedResult(result) {
  const last = Array.isArray(result) ? result.at(-1) : result;
  if (!last) return { rows: [], rowCount: 0 };
  return {
    ...last,
    rows: Array.isArray(last.rows) ? last.rows : [],
    rowCount: Array.isArray(last.rows) ? last.rows.length : Number(last.affectedRows || 0)
  };
}

class EmbeddedRadarPool {
  constructor(location) {
    this.location = location;
    this.databasePromise = null;
    this.queue = Promise.resolve();
  }

  async database() {
    if (!this.databasePromise) {
      this.databasePromise = Promise.resolve().then(() => {
        const { PGlite } = require("@electric-sql/pglite");
        return new PGlite(`file://${this.location.replace(/\\/g, "/")}`);
      });
    }
    return this.databasePromise;
  }

  async acquire() {
    let release;
    const previous = this.queue;
    this.queue = new Promise(resolve => { release = resolve; });
    await previous;
    return release;
  }

  async execute(sql, params) {
    const database = await this.database();
    const result = params
      ? await database.query(sql, params)
      : await database.exec(sql);
    return normalizeEmbeddedResult(result);
  }

  async query(sql, params) {
    const release = await this.acquire();
    try {
      return await this.execute(sql, params);
    } finally {
      release();
    }
  }

  async connect() {
    const release = await this.acquire();
    let open = true;
    return {
      query: (sql, params) => this.execute(sql, params),
      release() {
        if (!open) return;
        open = false;
        release();
      }
    };
  }

  async end() {
    const database = await this.databasePromise;
    if (database) await database.close();
  }
}

function createPool(config) {
  if (!config?.databaseUrl) {
    return config?.databaseEmbeddedPath
      ? new EmbeddedRadarPool(config.databaseEmbeddedPath)
      : null;
  }

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

module.exports = { createPool, checkDatabase, EmbeddedRadarPool, normalizeEmbeddedResult };
