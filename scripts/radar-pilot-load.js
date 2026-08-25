"use strict";

const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");
const { writeLocalAccounts, seedRadar } = require("./radar-local-setup");
const { createRadarConfig } = require("../src/config/radar");
const { createPool } = require("../src/db/pool");
const { migrate } = require("../src/db/migrate");

function secret(label) {
  return `${label}-${crypto.randomBytes(36).toString("base64url")}`;
}

function loadAccounts() {
  return Object.freeze(Array.from({ length: 30 }, (_, index) => {
    const number = String(index + 1).padStart(2, "0");
    const opaqueSuffix = `${String.fromCharCode(97 + Math.floor(index / 26))}${String.fromCharCode(97 + (index % 26))}`;
    return Object.freeze({
      login: `load_team_${number}`,
      accountReference: `account-radar-load-${opaqueSuffix}`,
      profileId: `pf_radar_load_${number}`,
      name: `Time Piloto ${number}`,
      slug: `time-piloto-${number}`,
      instagram: `timepilotoload${number}`,
      city: "Joinville",
      state: "SC",
      cityCode: "4209102",
      latitude: -26.3045 + (index % 6) * 0.002,
      longitude: -48.8487 + Math.floor(index / 6) * 0.002,
      email: `time${number}@load.local.invalid`,
      moderator: index === 29
    });
  }));
}

function configureEnvironment(runDirectory, accounts, metricsToken, password) {
  const values = {
    NODE_ENV: "loadtest",
    OMASCOTE_DATA_DIR: path.join(runDirectory, "data"),
    RADAR_DATABASE_EMBEDDED_PATH: path.join(runDirectory, "postgres"),
    JWT_SECRET: secret("jwt"),
    RADAR_LOCAL_TEST_PASSWORD: password,
    RADAR_AMISTOSOS_ENABLED: "true",
    RADAR_SEARCH_ENABLED: "true",
    RADAR_INVITATIONS_ENABLED: "true",
    RADAR_MATCH_CENTER_ENABLED: "true",
    RADAR_MATCH_RESULTS_ENABLED: "true",
    RADAR_MATCH_HISTORY_ENABLED: "true",
    RADAR_REPUTATION_ENABLED: "true",
    RADAR_MODERATION_ENABLED: "true",
    RADAR_PROFILE_PRINT_IMPORT_ENABLED: "false",
    RADAR_PILOT_ACCOUNT_ALLOWLIST: accounts.map(item => item.accountReference).join(","),
    RADAR_INSTAGRAM_VERIFICATION_SECRET: secret("instagram"),
    RADAR_SEARCH_CURSOR_SECRET: secret("search-cursor"),
    RADAR_SEARCH_RATE_LIMIT_SECRET: secret("search-rate"),
    RADAR_INVITATIONS_SECURITY_SECRET: secret("invitation"),
    RADAR_MATCH_RESULTS_SECURITY_SECRET: secret("match-result"),
    RADAR_MATCH_HISTORY_CURSOR_SECRET: secret("history-cursor"),
    RADAR_MATCH_HISTORY_RATE_LIMIT_SECRET: secret("history-rate"),
    RADAR_REPUTATION_SECURITY_SECRET: secret("reputation"),
    RADAR_MODERATION_SECURITY_SECRET: secret("moderation"),
    RADAR_METRICS_ENABLED: "true",
    RADAR_METRICS_TOKEN: metricsToken,
    RADAR_SEARCH_ACCOUNT_LIMIT: "200",
    RADAR_SEARCH_TEAM_LIMIT: "200",
    RADAR_SEARCH_IP_LIMIT: "5000",
    RADAR_INVITATION_ACCOUNT_LIMIT: "200",
    RADAR_INVITATION_TEAM_LIMIT: "200",
    RADAR_INVITATION_IP_LIMIT: "5000",
    RADAR_MATCH_HISTORY_ACCOUNT_LIMIT: "200",
    RADAR_MATCH_HISTORY_TEAM_LIMIT: "200",
    RADAR_MATCH_HISTORY_IP_LIMIT: "5000",
    RADAR_MODERATION_ACCOUNT_LIMIT: "200",
    RADAR_MODERATION_TEAM_LIMIT: "200",
    RADAR_MODERATION_IP_LIMIT: "5000",
    RADAR_TRUST_PROXY_HOPS: "0",
    COMMIT_SHA: "release-candidate-local-load",
    RELEASE_VERSION: "rc-local-load"
  };
  for (const [name, value] of Object.entries(values)) process.env[name] = value;
}

function percentile(values, ratio) {
  if (!values.length) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.ceil(sorted.length * ratio) - 1)];
}

function summarize(samples) {
  const groups = new Map();
  for (const item of samples) {
    const values = groups.get(item.operation) || [];
    values.push(item.duration_ms);
    groups.set(item.operation, values);
  }
  const result = {};
  for (const [operation, values] of groups) {
    result[operation] = {
      requests: values.length,
      p50_ms: Number(percentile(values, 0.5).toFixed(2)),
      p95_ms: Number(percentile(values, 0.95).toFixed(2)),
      p99_ms: Number(percentile(values, 0.99).toFixed(2)),
      max_ms: Number(Math.max(...values).toFixed(2))
    };
  }
  return result;
}

function etag(item) {
  const version = Number(item?.version);
  if (!Number.isInteger(version)) throw new Error("Resource version missing");
  return `W/\"${version}\"`;
}

async function main() {
  if (process.env.NODE_ENV === "production" || String(process.env.DATABASE_URL || "").trim()) {
    throw new Error("Load test refuses production or an external DATABASE_URL");
  }
  const root = path.resolve(__dirname, "..", "dados", "release-candidate");
  const runDirectory = path.join(root, `load-${new Date().toISOString().replace(/[:.]/g, "-")}`);
  fs.mkdirSync(runDirectory, { recursive: true });
  const accounts = loadAccounts();
  const metricsToken = secret("metrics");
  const password = secret("load-password");
  configureEnvironment(runDirectory, accounts, metricsToken, password);
  writeLocalAccounts(process.env.OMASCOTE_DATA_DIR, password, accounts);

  const setupPool = createPool(createRadarConfig());
  const setupStarted = Date.now();
  let firstMigrations;
  let secondMigrations;
  try {
    firstMigrations = await migrate({ pool: setupPool });
    secondMigrations = await migrate({ pool: setupPool });
    await seedRadar(setupPool, accounts);
  } finally {
    await setupPool.end();
  }

  const { app, __radarReleaseCandidate } = require("../server");
  const server = app.listen(0, "127.0.0.1");
  await new Promise((resolve, reject) => {
    server.once("listening", resolve);
    server.once("error", reject);
  });
  const baseUrl = `http://127.0.0.1:${server.address().port}`;
  const samples = [];
  const unexpected = [];
  let expectedConflicts = 0;

  async function call(operation, route, options = {}) {
    const started = process.hrtime.bigint();
    const headers = { Accept: options.raw ? "text/plain" : "application/json", "X-Request-Id": crypto.randomUUID() };
    if (options.token) headers.Authorization = `Bearer ${options.token}`;
    if (options.metrics) headers.Authorization = `Bearer ${metricsToken}`;
    if (options.body !== undefined) headers["Content-Type"] = "application/json";
    if (options.key) headers["Idempotency-Key"] = options.key;
    if (options.etag) headers["If-Match"] = options.etag;
    const response = await fetch(`${baseUrl}${route}`, {
      method: options.method || "GET",
      headers,
      body: options.body === undefined ? undefined : JSON.stringify(options.body)
    });
    const durationMs = Number(process.hrtime.bigint() - started) / 1_000_000;
    samples.push({ operation, duration_ms: durationMs, status: response.status });
    const data = options.raw ? await response.text() : await response.json().catch(() => ({}));
    const expected = options.expected || [200, 201];
    if (!expected.includes(response.status)) {
      unexpected.push({ operation, status: response.status, code: data?.code || "unknown" });
      throw new Error(`${operation} failed with ${response.status} ${data?.code || data?.error || ""}`);
    }
    return { response, data };
  }

  async function login(account) {
    const result = await call("login", "/auth/login", {
      method: "POST",
      body: { whatsapp: account.login, senha: password },
      expected: [200]
    });
    return result.data.token;
  }

  try {
    const ready = await call("health", "/health/ready", { expected: [200] });
    const tokens = await Promise.all(accounts.map(login));
    const availabilityStart = new Date(Date.now() + 3_600_000);
    const availabilityEnd = new Date(availabilityStart.getTime() + 7_200_000);
    await Promise.all(tokens.map((token, index) => call("availability", "/me/time/amistosos/disponibilidades", {
      token,
      method: "POST",
      key: crypto.randomUUID(),
      body: {
        modality: "society", category: "Livre",
        starts_at: availabilityStart.toISOString(), ends_at: availabilityEnd.toISOString(),
        travel_radius_km: 50, venue_preference: "either", status: "active"
      }
    })));

    const searches = await Promise.all(tokens.map(token => call("search", "/amistosos/times-proximos?modality=society&category=Livre&radius_km=50&limit=5", {
      token, expected: [200]
    })));
    if (searches.some(item => !Array.isArray(item.data.items) || item.data.items.length === 0)) {
      throw new Error("Concurrent search returned an empty candidate set");
    }
    const pageCursor = searches[0].data.page?.next_cursor || searches[0].data.next_cursor;
    if (pageCursor) {
      await call("pagination", `/amistosos/times-proximos?modality=society&category=Livre&radius_km=50&limit=5&cursor=${encodeURIComponent(pageCursor)}`, {
        token: tokens[0], expected: [200]
      });
    }

    const scheduledAt = new Date(Date.now() + 12_000);
    const scheduledEnd = new Date(scheduledAt.getTime() + 7_200_000);
    const invitations = await Promise.all(Array.from({ length: 15 }, (_, pair) => {
      const origin = pair * 2;
      return call("invitation", "/amistosos/convites", {
        token: tokens[origin], method: "POST", key: crypto.randomUUID(),
        body: {
          opponent_slug: accounts[origin + 1].slug,
          starts_at: scheduledAt.toISOString(), ends_at: scheduledEnd.toISOString(),
          modality: "society", category: "Livre", venue_preference: "either",
          message: "Carga controlada do piloto."
        }
      });
    }));

    const accepted = await Promise.all(invitations.map(async (created, pair) => {
      const invitation = created.data.invitation;
      const key = crypto.randomUUID();
      const route = `/amistosos/convites/${invitation.invitation_id}/aceitar`;
      const options = {
        token: tokens[pair * 2 + 1], method: "POST", key,
        etag: etag(invitation), body: {}, expected: [200]
      };
      const [first, repeated] = await Promise.all([
        call("acceptance", route, options),
        call("acceptance_replay", route, options)
      ]);
      const match = first.data.match || repeated.data.match;
      if (!match?.match_id) throw new Error("Concurrent acceptance did not return a match");
      return match;
    }));
    if (new Set(accepted.map(item => item.match_id)).size !== 15) {
      throw new Error("Concurrent acceptance created a duplicate match");
    }

    const waitMs = scheduledAt.getTime() - Date.now() + 400;
    if (waitMs > 0) await new Promise(resolve => setTimeout(resolve, waitMs));
    const played = [];
    for (let pair = 0; pair < 5; pair += 1) {
      const matchId = accepted[pair].match_id;
      const left = await call("match_detail", `/me/time/amistosos/${matchId}`, { token: tokens[pair * 2], expected: [200] });
      const right = await call("match_detail", `/me/time/amistosos/${matchId}`, { token: tokens[pair * 2 + 1], expected: [200] });
      const occurrenceRoute = `/me/time/amistosos/${matchId}/confirmar-realizacao`;
      const attempts = await Promise.all([
        call("occurrence_concurrent", occurrenceRoute, {
          token: tokens[pair * 2], method: "POST", key: crypto.randomUUID(),
          etag: left.response.headers.get("etag"), body: {}, expected: [200, 409]
        }),
        call("occurrence_concurrent", occurrenceRoute, {
          token: tokens[pair * 2 + 1], method: "POST", key: crypto.randomUUID(),
          etag: right.response.headers.get("etag"), body: {}, expected: [200, 409]
        })
      ]);
      expectedConflicts += attempts.filter(item => item.response.status === 409).length;
      for (let side = 0; side < 2; side += 1) {
        if (attempts[side].response.status !== 409) continue;
        const current = await call("match_detail", `/me/time/amistosos/${matchId}`, { token: tokens[pair * 2 + side], expected: [200] });
        await call("occurrence_retry", occurrenceRoute, {
          token: tokens[pair * 2 + side], method: "POST", key: crypto.randomUUID(),
          etag: current.response.headers.get("etag"), body: {}, expected: [200]
        });
      }
      played.push(matchId);
    }

    await Promise.all(played.map(async (matchId, pair) => {
      const current = await call("match_detail", `/me/time/amistosos/${matchId}`, { token: tokens[pair * 2], expected: [200] });
      await call("score", `/me/time/amistosos/${matchId}/resultado`, {
        token: tokens[pair * 2], method: "POST", key: crypto.randomUUID(),
        etag: current.response.headers.get("etag"),
        body: { gols_meu_time: 2 + pair, gols_adversario: 1 }, expected: [200]
      });
      const opponent = await call("match_detail", `/me/time/amistosos/${matchId}`, { token: tokens[pair * 2 + 1], expected: [200] });
      await call("score_confirmation", `/me/time/amistosos/${matchId}/resultado/confirmar`, {
        token: tokens[pair * 2 + 1], method: "POST", key: crypto.randomUUID(),
        etag: opponent.response.headers.get("etag"), body: {}, expected: [200]
      });
    }));

    const reports = await Promise.all(played.slice(0, 3).map((matchId, index) => call("report", "/me/time/radar/denuncias", {
      token: tokens[index * 2], method: "POST", key: crypto.randomUUID(),
      body: { tipo: "partida", match_id: matchId, categoria: "unsafe_conduct", descricao: "Relato privado de carga." }
    })));
    const moderatorToken = tokens[29];
    for (const report of reports) {
      const caseId = report.data.case.case_id;
      const queue = await call("moderation", "/admin/radar/moderacao?limit=20", { token: moderatorToken, expected: [200] });
      const item = queue.data.items.find(candidate => candidate.case_id === caseId);
      const assigned = await call("moderation", `/admin/radar/moderacao/${caseId}/atribuir`, {
        token: moderatorToken, method: "POST", key: crypto.randomUUID(),
        etag: etag(item), body: { motivo: "triage" }, expected: [200]
      });
      await call("moderation", `/admin/radar/moderacao/${caseId}/resolver`, {
        token: moderatorToken, method: "POST", key: crypto.randomUUID(),
        etag: etag(assigned.data.case),
        body: { decisao: "warn", motivo: "violation_confirmed" }, expected: [200]
      });
    }

    const metrics = await call("metrics", "/internal/radar/metrics", { metrics: true, raw: true, expected: [200] });
    const snapshot = __radarReleaseCandidate.observabilitySnapshot();
    const report = {
      ok: unexpected.length === 0,
      mode: "isolated-local-pilot-load",
      production_targeted: false,
      teams: accounts.length,
      availabilities: accounts.length,
      concurrent_searches: searches.length,
      invitations: invitations.length,
      unique_matches: new Set(accepted.map(item => item.match_id)).size,
      played_and_scored_matches: played.length,
      reports_moderated: reports.length,
      expected_version_conflicts: expectedConflicts,
      unexpected_errors: unexpected,
      latency: summarize(samples),
      database: snapshot.database,
      metrics_present: [
        "radar_search_events_total", "radar_invitation_events_total",
        "radar_acceptance_events_total", "radar_match_events_total",
        "radar_score_events_total", "radar_report_events_total",
        "radar_moderation_events_total", "radar_errors_total"
      ].filter(name => metrics.data.includes(name)),
      migrations: {
        first_run: firstMigrations.length,
        second_run: secondMigrations.length,
        latest: ready.data.migrations?.latest || null,
        health_applied: ready.data.migrations?.applied || null
      },
      setup_ms: Date.now() - setupStarted,
      completed_at: new Date().toISOString()
    };
    const reportPath = path.join(runDirectory, "load-report.json");
    fs.writeFileSync(reportPath, `${JSON.stringify(report, null, 2)}\n`, "utf8");
    process.stdout.write(`${JSON.stringify({ ...report, report_path: reportPath, database_path: process.env.RADAR_DATABASE_EMBEDDED_PATH, data_path: process.env.OMASCOTE_DATA_DIR }, null, 2)}\n`);
    if (!report.ok) process.exitCode = 1;
  } finally {
    await new Promise(resolve => server.close(resolve));
    await __radarReleaseCandidate.closePool();
  }
}

main().catch(error => {
  process.stderr.write(`Radar pilot load failed: ${error.message}\n`);
  process.exitCode = 1;
});
