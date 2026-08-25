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
  constructor(location, observer = null) {
    this.location = location;
    this.observer = observer;
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
    const started = process.hrtime.bigint();
    this.observer?.observeDatabaseQuery?.({ activeDelta: 1 });
    const database = await this.database();
    try {
      const result = params
        ? await database.query(sql, params)
        : await database.exec(sql);
      this.observer?.observeDatabaseQuery?.({
        durationMs: Number(process.hrtime.bigint() - started) / 1_000_000
      });
      return normalizeEmbeddedResult(result);
    } catch (error) {
      this.observer?.observeDatabaseQuery?.({
        durationMs: Number(process.hrtime.bigint() - started) / 1_000_000,
        error: true
      });
      throw error;
    } finally {
      this.observer?.observeDatabaseQuery?.({ activeDelta: -1 });
    }
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

function instrumentQuery(query, observer) {
  return async function observedQuery(...args) {
    const started = process.hrtime.bigint();
    observer?.observeDatabaseQuery?.({ activeDelta: 1 });
    try {
      const result = await query(...args);
      observer?.observeDatabaseQuery?.({
        durationMs: Number(process.hrtime.bigint() - started) / 1_000_000
      });
      return result;
    } catch (error) {
      observer?.observeDatabaseQuery?.({
        durationMs: Number(process.hrtime.bigint() - started) / 1_000_000,
        error: true
      });
      throw error;
    } finally {
      observer?.observeDatabaseQuery?.({ activeDelta: -1 });
    }
  };
}

function instrumentPool(pool, observer) {
  if (!observer) return pool;
  return {
    query: instrumentQuery(pool.query.bind(pool), observer),
    async connect() {
      const client = await pool.connect();
      return {
        query: instrumentQuery(client.query.bind(client), observer),
        release: client.release.bind(client)
      };
    },
    end: pool.end.bind(pool),
    get totalCount() { return pool.totalCount; },
    get idleCount() { return pool.idleCount; },
    get waitingCount() { return pool.waitingCount; }
  };
}

function connectionStringWithoutSslOverrides(value) {
  try {
    const parsed = new URL(value);
    for (const name of ["sslmode", "sslcert", "sslkey", "sslrootcert"]) {
      parsed.searchParams.delete(name);
    }
    return parsed.toString();
  } catch {
    return value;
  }
}

function createPool(config, { observer = null } = {}) {
  if (!config?.databaseUrl) {
    return config?.databaseEmbeddedPath
      ? new EmbeddedRadarPool(config.databaseEmbeddedPath, observer)
      : null;
  }

  const pool = new Pool({
    connectionString: config.databaseSsl
      ? connectionStringWithoutSslOverrides(config.databaseUrl)
      : config.databaseUrl,
    connectionTimeoutMillis: config.databaseConnectionTimeoutMs,
    ssl: config.databaseSsl
      ? {
          rejectUnauthorized: config.databaseSslRejectUnauthorized,
          ...(config.databaseSslCa ? { ca: config.databaseSslCa } : {})
        }
      : undefined,
    application_name: "omascote-api-radar-amistosos"
  });
  return instrumentPool(pool, observer);
}

async function getMigrationStatus(pool) {
  if (!pool) return { ok: false, reason: "database_not_configured" };
  try {
    const result = await pool.query(`
      SELECT COUNT(*)::integer AS count, MAX(name) AS latest
      FROM public.schema_migrations
    `);
    return {
      ok: true,
      count: Number(result.rows?.[0]?.count || 0),
      latest: result.rows?.[0]?.latest || null,
      required: LATEST_REQUIRED_MIGRATION
    };
  } catch {
    return { ok: false, reason: "database_schema_unavailable", required: LATEST_REQUIRED_MIGRATION };
  }
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

module.exports = {
  createPool,
  checkDatabase,
  getMigrationStatus,
  EmbeddedRadarPool,
  normalizeEmbeddedResult,
  instrumentPool,
  connectionStringWithoutSslOverrides
};
