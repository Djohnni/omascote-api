"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawnSync } = require("node:child_process");
const test = require("node:test");
const express = require("express");
const { readJwtSecret } = require("./src/config/auth");
const { createRadarConfig } = require("./src/config/radar");
const { createCorsOriginAllowlist } = require("./src/config/cors");
const { validateStagingEnvironment, PURPOSE_SECRETS } = require("./src/config/staging-preflight");
const { createRadarObservability, classifyOperation } = require("./src/observability/radar-observability");
const { createPool, connectionStringWithoutSslOverrides } = require("./src/db/pool");
const { migrate } = require("./src/db/migrate");
const { runRadarRetention } = require("./src/maintenance/radar-retention");
const { createPilotGatedRadarIdentityResolver } = require("./src/friendlies/radar-identity.policy");
const { setupAccounts } = require("./scripts/radar-local-setup");

async function request(app, route, options = {}) {
  const server = app.listen(0, "127.0.0.1");
  await new Promise(resolve => server.once("listening", resolve));
  try {
    return await fetch(`http://127.0.0.1:${server.address().port}${route}`, options);
  } finally {
    await new Promise(resolve => server.close(resolve));
  }
}

function goodStagingEnvironment() {
  const env = {
    NODE_ENV: "staging",
    DATABASE_URL: "postgresql://staging.invalid/radar",
    DATABASE_SSL: "true",
    DATABASE_SSL_REJECT_UNAUTHORIZED: "true",
    JWT_SECRET: "jwt-".padEnd(40, "j"),
    OMASCOTE_CORS_INCLUDE_PRODUCTION_ORIGINS: "false",
    OMASCOTE_CORS_ORIGINS: "https://staging.omascote.invalid",
    RADAR_TRUST_PROXY_HOPS: "1",
    RADAR_TRUST_PROXY_PROVIDER: "render",
    RADAR_PILOT_ACCOUNT_ALLOWLIST: "account-alpha,account-beta",
    RADAR_METRICS_ENABLED: "true",
    COMMIT_SHA: "abc123",
    RELEASE_VERSION: "radar-rc1"
  };
  for (const [index, name] of PURPOSE_SECRETS.entries()) {
    env[name] = `${name.toLowerCase()}-${index}`.padEnd(48, String(index % 10));
  }
  return env;
}

test("JWT authentication has no legacy or missing-secret fallback", () => {
  assert.throws(() => readJwtSecret({}), error => error.code === "JWT_SECRET_CONFIGURATION_REQUIRED");
  assert.throws(() => readJwtSecret({ JWT_SECRET: "TROQUE_ISSO_AGORA" }), error => error.code === "JWT_SECRET_CONFIGURATION_REQUIRED");
  assert.equal(readJwtSecret({ JWT_SECRET: "secure-test-secret-with-24-bytes" }), "secure-test-secret-with-24-bytes");
});

test("server process fails closed before startup when JWT_SECRET is absent", () => {
  const env = { ...process.env };
  delete env.JWT_SECRET;
  const result = spawnSync(process.execPath, ["-e", "require('./server')"], {
    cwd: __dirname,
    env,
    encoding: "utf8",
    timeout: 20_000
  });
  assert.notEqual(result.status, 0);
  assert.match(`${result.stderr}${result.stdout}`, /JWT_SECRET must be configured/);
  assert.doesNotMatch(`${result.stderr}${result.stdout}`, /TROQUE_ISSO_AGORA.*rodando/);
});

test("staging preflight validates managed PostgreSQL, separate secrets, allowlist and disabled flags", () => {
  const good = validateStagingEnvironment(goodStagingEnvironment());
  assert.equal(good.ok, true, good.errors.join("; "));
  assert.equal(good.summary.separated_secrets, PURPOSE_SECRETS.length);
  assert.equal(good.summary.flags_enabled, 0);

  const bad = goodStagingEnvironment();
  bad.RADAR_SEARCH_CURSOR_SECRET = bad.RADAR_SEARCH_RATE_LIMIT_SECRET;
  bad.RADAR_AMISTOSOS_ENABLED = "true";
  bad.RADAR_PILOT_ACCOUNT_ALLOWLIST = "";
  const result = validateStagingEnvironment(bad);
  assert.equal(result.ok, false);
  assert.ok(result.errors.some(item => item.includes("must differ")));
  assert.ok(result.errors.some(item => item.includes("ALLOWLIST")));
  assert.ok(result.errors.some(item => item.includes("must remain false")));
});

test("staging CORS can exclude production and rejects path or script origins", () => {
  assert.deepEqual(createCorsOriginAllowlist({
    OMASCOTE_CORS_INCLUDE_PRODUCTION_ORIGINS: "false",
    OMASCOTE_CORS_ORIGINS: "https://stage.example,http://127.0.0.1:4190/path,javascript:alert(1)"
  }), ["https://stage.example"]);
});

test("enabled pilot fails closed when the opaque account allowlist is absent", () => {
  const resolver = createPilotGatedRadarIdentityResolver({
    config: createRadarConfig({ RADAR_AMISTOSOS_ENABLED: "true" }),
    resolveIdentity: user => user
  });
  assert.throws(() => resolver({ accountId: "account-alpha" }), error => {
    assert.equal(error.code, "RADAR_PILOT_CONFIGURATION_UNAVAILABLE");
    assert.equal(error.status, 503);
    return true;
  });
});

test("request logs and metrics are structured, token-protected and redact private fields", async () => {
  const lines = [];
  const observability = createRadarObservability({
    output: { info: line => lines.push(line), warn: line => lines.push(line), error: line => lines.push(line) }
  });
  const token = "metrics-token".padEnd(40, "m");
  const app = express();
  app.use(observability.requestContext);
  app.use(observability.httpMetrics);
  app.get("/amistosos/times-proximos", (req, res) => res.json({ ok: true }));
  app.use(observability.metricsRouter({ enabled: true, token }));
  const searched = await request(app, "/amistosos/times-proximos", {
    headers: { "X-Request-Id": "request-safe-123", Authorization: "Bearer private-client-token" }
  });
  assert.equal(searched.status, 200);
  assert.equal(searched.headers.get("x-request-id"), "request-safe-123");
  const denied = await request(app, "/internal/radar/metrics");
  assert.equal(denied.status, 401);
  const metrics = await request(app, "/internal/radar/metrics", { headers: { Authorization: `Bearer ${token}` } });
  assert.equal(metrics.status, 200);
  assert.match(await metrics.text(), /radar_search_events_total 1/);
  const serialized = lines.join("\n");
  assert.match(serialized, /"event":"radar.http.completed"/);
  assert.match(serialized, /"request_id":"request-safe-123"/);
  assert.doesNotMatch(serialized, /private-client-token|metrics-token/);
});

test("Radar metrics never classify legacy result downloads as score events", () => {
  assert.equal(classifyOperation("POST", "/pedidos/abc/download-direto/resultado"), null);
  assert.equal(classifyOperation("POST", "/me/time/amistosos/opaque/resultado"), "score");
});

test("retention is locked, idempotent and never deletes append-only audit", async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "radar-retention-"));
  const config = createRadarConfig({ RADAR_DATABASE_EMBEDDED_PATH: directory, RADAR_TECHNICAL_RETENTION_DAYS: "7" });
  const pool = createPool(config);
  const now = new Date("2026-08-25T12:00:00.000Z");
  try {
    await migrate({ pool });
    const teams = [];
    for (let index = 0; index < 2; index += 1) {
      const result = await pool.query(`
        INSERT INTO radar_team_profiles(
          legacy_profile_id, account_reference, public_slug, status,
          instagram_handle, instagram_verification_status, city_ibge_code,
          city_name, state_code, modalities, categories, declared_level,
          public_name, public_profile_enabled, public_crest_available
        ) VALUES ($1,$2,$3,'active',$4,'verified','4209102','Joinville','SC',
          ARRAY['society'],ARRAY['Livre'],'intermediario',$5,true,true)
        RETURNING id
      `, [`profile-${index}`, `account-${index}`, `team-${index}`, `team${index}`, `Time ${index}`]);
      teams.push(result.rows[0].id);
    }
    await pool.query(`
      INSERT INTO friendly_availabilities(
        team_id, modality, category, declared_level, starts_at, ends_at,
        city_ibge_code, city_name, state_code, travel_radius_km,
        venue_preference, status, schedule_hash
      ) VALUES ($1,'society','Livre','intermediario',$2,$3,'4209102','Joinville','SC',
        25,'either','active',$4)
    `, [teams[0], new Date(now.getTime() - 7_200_000), new Date(now.getTime() - 3_600_000), "a".repeat(64)]);
    await pool.query(`
      INSERT INTO friendly_invitations(
        requester_team_id, invited_team_id, state, proposal, proposal_hash,
        idempotency_key, idempotency_payload_hash, expires_at
      ) VALUES ($1,$2,'pending','{}',$3,'retention-test',$4,$5)
    `, [teams[0], teams[1], "b".repeat(64), "c".repeat(64), new Date(now.getTime() - 1_000)]);
    await pool.query(`
      INSERT INTO radar_moderation_cases(
        case_type, reporter_team_id, reported_team_id, category,
        private_description, retention_expires_at, created_at, updated_at
      ) VALUES ('team_report',$1,$2,'other','private detail',$3,$4,$4)
    `, [teams[0], teams[1], new Date(now.getTime() - 1_000), new Date(now.getTime() - 86_400_000)]);
    await pool.query(`
      INSERT INTO match_audit_events(actor_team_id, actor_reference, event_type, payload)
      VALUES ($1,'test','audit.sentinel','{}')
    `, [teams[0]]);

    const first = await runRadarRetention({ pool, config, now, logger: { info() {}, error() {} } });
    const second = await runRadarRetention({ pool, config, now, logger: { info() {}, error() {} } });
    assert.equal(first.lock_acquired, true);
    assert.equal(first.availabilities_expired, 1);
    assert.equal(first.invitations_expired, 1);
    assert.equal(first.moderation_descriptions_erased, 1);
    assert.equal(first.audit_rows_deleted, 0);
    assert.equal(second.availabilities_expired, 0);
    assert.equal(second.invitations_expired, 0);
    assert.equal(second.moderation_descriptions_erased, 0);
    const audit = await pool.query("SELECT COUNT(*)::integer AS count FROM match_audit_events WHERE event_type = 'audit.sentinel'");
    assert.equal(Number(audit.rows[0].count), 1);
  } finally {
    await pool.end();
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test("release scripts refuse external databases and production targets", () => {
  for (const file of ["scripts/radar-pilot-load.js", "scripts/radar-backup-restore-verify.js"]) {
    const source = fs.readFileSync(path.join(__dirname, file), "utf8");
    assert.match(source, /refuses production or an external DATABASE_URL/);
    assert.match(source, /NODE_ENV === "production"/);
  }
});

test("staging setup can seed exactly 30 isolated load-test teams", () => {
  const configured = setupAccounts({ NODE_ENV: "staging", RADAR_STAGING_TEST_TEAM_COUNT: "30" });
  const loadTeams = configured.filter(item => item.login.startsWith("load_team_"));
  assert.equal(loadTeams.length, 30);
  assert.equal(new Set(loadTeams.map(item => item.accountReference)).size, 30);
  assert.equal(configured.filter(item => item.moderator).length, 1);
  assert.throws(
    () => setupAccounts({ NODE_ENV: "production", RADAR_STAGING_TEST_TEAM_COUNT: "30" }),
    /allowed only in staging/
  );
});

test("managed PostgreSQL TLS keeps explicit verification and a pinned CA", () => {
  const pem = "-----BEGIN CERTIFICATE-----\nZmFrZQ==\n-----END CERTIFICATE-----";
  const config = createRadarConfig({
    DATABASE_SSL: "true",
    DATABASE_SSL_REJECT_UNAUTHORIZED: "true",
    DATABASE_SSL_CA_B64: Buffer.from(pem).toString("base64")
  });
  assert.equal(config.databaseSsl, true);
  assert.equal(config.databaseSslRejectUnauthorized, true);
  assert.equal(config.databaseSslCa, pem);
  const sanitized = connectionStringWithoutSslOverrides(
    "postgresql://user:password@db.example/radar?sslmode=require&application_name=radar"
  );
  assert.equal(new URL(sanitized).searchParams.has("sslmode"), false);
  assert.equal(new URL(sanitized).searchParams.get("application_name"), "radar");
});
