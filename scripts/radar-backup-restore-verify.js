"use strict";

const fs = require("node:fs");
const path = require("node:path");
const express = require("express");
const { PGlite } = require("@electric-sql/pglite");
const { checkDatabase, getMigrationStatus } = require("../src/db/pool");
const { createHealthRouter } = require("../src/health/health.routes");

function required(name) {
  const value = String(process.env[name] || "").trim();
  if (!value) throw new Error(`${name} is required`);
  return path.resolve(value);
}

function assertInsideData(target) {
  const dataRoot = path.resolve(__dirname, "..", "dados");
  if (target !== dataRoot && !target.startsWith(`${dataRoot}${path.sep}`)) {
    throw new Error("Backup verification paths must stay inside this worktree's dados directory");
  }
  return target;
}

function normalize(result) {
  return { rows: result.rows || [], rowCount: (result.rows || []).length };
}

async function httpGet(app, route) {
  const server = app.listen(0, "127.0.0.1");
  await new Promise((resolve, reject) => {
    server.once("listening", resolve);
    server.once("error", reject);
  });
  try {
    const response = await fetch(`http://127.0.0.1:${server.address().port}${route}`);
    return { status: response.status, body: await response.json() };
  } finally {
    await new Promise(resolve => server.close(resolve));
  }
}

async function counts(database) {
  const result = await database.query(`
    SELECT
      (SELECT COUNT(*) FROM schema_migrations)::integer AS migrations,
      (SELECT COUNT(*) FROM radar_team_profiles)::integer AS teams,
      (SELECT COUNT(*) FROM friendly_availabilities)::integer AS availabilities,
      (SELECT COUNT(*) FROM friendly_invitations WHERE state = 'accepted')::integer AS accepted_invitations,
      (SELECT COUNT(*) FROM friendly_matches)::integer AS matches,
      (SELECT COUNT(*) FROM friendly_matches WHERE result_state = 'verified')::integer AS verified_results,
      (SELECT COUNT(*) FROM radar_moderation_cases)::integer AS moderation_cases,
      (SELECT COUNT(*) FROM match_audit_events)::integer AS audit_events
  `);
  return result.rows[0];
}

async function main() {
  if (process.env.NODE_ENV === "production" || String(process.env.DATABASE_URL || "").trim()) {
    throw new Error("Backup rehearsal refuses production or an external DATABASE_URL");
  }
  const sourcePath = assertInsideData(required("RADAR_BACKUP_SOURCE_PATH"));
  const outputDirectory = assertInsideData(required("RADAR_BACKUP_OUTPUT_DIR"));
  if (!fs.existsSync(sourcePath)) throw new Error("Source test database does not exist");
  fs.mkdirSync(outputDirectory, { recursive: true });
  const backupPath = path.join(outputDirectory, "radar-test-backup.tar.gz");
  const restoredPath = path.join(outputDirectory, "restored-postgres");
  if (fs.existsSync(restoredPath)) throw new Error("Restore target must be an empty path");

  const totalStarted = Date.now();
  const source = await PGlite.create(`file://${sourcePath.replace(/\\/g, "/")}`);
  let sourceCounts;
  let backupMs;
  try {
    sourceCounts = await counts(source);
    const started = Date.now();
    const dump = await source.dumpDataDir("gzip");
    const bytes = Buffer.from(await dump.arrayBuffer());
    fs.writeFileSync(backupPath, bytes);
    backupMs = Date.now() - started;
  } finally {
    await source.close();
  }

  const restoreStarted = Date.now();
  const backup = fs.readFileSync(backupPath);
  const restored = await PGlite.create({
    dataDir: `file://${restoredPath.replace(/\\/g, "/")}`,
    loadDataDir: new Blob([backup])
  });
  try {
    const adapter = {
      query: async (sql, params) => normalize(await restored.query(sql, params))
    };
    const restoredCounts = await counts(restored);
    if (JSON.stringify(restoredCounts) !== JSON.stringify(sourceCounts)) {
      throw new Error("Restored database counts differ from the backup source");
    }
    if (Number(restoredCounts.migrations) !== 13 || Number(restoredCounts.teams) < 30) {
      throw new Error("Restored database is missing the pilot schema or teams");
    }
    if (Number(restoredCounts.matches) !== Number(restoredCounts.accepted_invitations)) {
      throw new Error("Restored invitation-to-match integrity check failed");
    }
    if (Number(restoredCounts.verified_results) < 5 || Number(restoredCounts.audit_events) < 1) {
      throw new Error("Restored essential result or audit flow is incomplete");
    }

    const app = express();
    app.use(createHealthRouter({
      config: {
        enabled: true,
        pilotAccountAllowlistConfigured: true,
        metricsEnabled: false,
        instagramVerificationConfigured: true,
        profilePrintImportEnabled: false,
        searchEnabled: false,
        invitationsEnabled: false,
        matchCenterEnabled: false,
        matchResultsEnabled: false,
        matchHistoryEnabled: false,
        reputationEnabled: false,
        moderationEnabled: false
      },
      buildInfo: { commit: "release-candidate-restore", build: "local-restore-rehearsal" },
      checkDatabase: () => checkDatabase(adapter),
      getMigrationStatus: () => getMigrationStatus(adapter)
    }));
    const health = await httpGet(app, "/health/ready");
    if (health.status !== 200 || health.body.migrations?.applied !== 13) {
      throw new Error("Health check failed on the restored database");
    }
    const report = {
      ok: true,
      mode: "isolated-local-backup-restore",
      official_database_touched: false,
      backup_path: backupPath,
      backup_bytes: fs.statSync(backupPath).size,
      restored_path: restoredPath,
      source_counts: sourceCounts,
      restored_counts: restoredCounts,
      health,
      backup_ms: backupMs,
      restore_and_verify_ms: Date.now() - restoreStarted,
      total_ms: Date.now() - totalStarted,
      completed_at: new Date().toISOString()
    };
    const reportPath = path.join(outputDirectory, "backup-restore-report.json");
    fs.writeFileSync(reportPath, `${JSON.stringify(report, null, 2)}\n`, "utf8");
    process.stdout.write(`${JSON.stringify({ ...report, report_path: reportPath }, null, 2)}\n`);
  } finally {
    await restored.close();
  }
}

main().catch(error => {
  process.stderr.write(`Radar backup/restore rehearsal failed: ${error.message}\n`);
  process.exitCode = 1;
});
