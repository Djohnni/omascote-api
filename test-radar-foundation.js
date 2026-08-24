"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const express = require("express");
const { createRadarConfig } = require("./src/config/radar");
const { getBuildInfo } = require("./src/config/build-info");
const { checkDatabase } = require("./src/db/pool");
const { LATEST_REQUIRED_MIGRATION } = require("./src/db/schema");
const { listMigrationFiles } = require("./src/db/migrate");
const { createHealthRouter } = require("./src/health/health.routes");
const { createFriendliesRouter } = require("./src/friendlies/friendlies.routes");
const {
  canTransition,
  INVITATION_TRANSITIONS,
  MATCH_TRANSITIONS,
  RESULT_TRANSITIONS,
  assertInvitationTransition,
  assertResultTransition
} = require("./src/friendlies/friendlies.state-machine");

async function request(app, pathname) {
  const server = app.listen(0, "127.0.0.1");
  await new Promise((resolve, reject) => {
    server.once("listening", resolve);
    server.once("error", reject);
  });

  try {
    const address = server.address();
    const response = await fetch(`http://127.0.0.1:${address.port}${pathname}`);
    return {
      status: response.status,
      headers: response.headers,
      body: await response.json()
    };
  } finally {
    await new Promise(resolve => server.close(resolve));
  }
}

test("Radar feature flag is off by default and keeps policy defaults", () => {
  const config = createRadarConfig({});
  assert.equal(config.enabled, false);
  assert.equal(config.pilotFree, true);
  assert.equal(config.publicRatingMinimumMatches, 3);
  assert.equal(config.pilotCityIbgeCode, null);
  assert.equal(config.moderationSlaHours, null);
  assert.equal(config.instagramVerificationSecret, null);
  assert.equal(Object.hasOwn(JSON.parse(JSON.stringify(config)), "instagramVerificationSecret"), false);
  assert.equal(config.instagramVerificationConfigured, false);
  assert.equal(config.instagramChallengeMaxAttempts, 5);
  assert.equal(config.instagramTrustedProxyHops, 0);
  assert.equal(config.databaseSslRejectUnauthorized, true);
});

test("Radar city and moderation SLA are configurable instead of hard-coded", () => {
  const config = createRadarConfig({
    RADAR_AMISTOSOS_ENABLED: "true",
    RADAR_PILOT_CITY_IBGE_CODE: "4209102",
    RADAR_MODERATION_SLA_HOURS: "24",
    RADAR_PUBLIC_RATING_MIN_MATCHES: "5"
  });

  assert.equal(config.enabled, true);
  assert.equal(config.pilotCityIbgeCode, "4209102");
  assert.equal(config.moderationSlaHours, 24);
  assert.equal(config.publicRatingMinimumMatches, 5);
});

test("build metadata accepts Render commit without requiring git at runtime", () => {
  assert.deepEqual(getBuildInfo({ RENDER_GIT_COMMIT: "abc123", BUILD_ID: "build-7" }), {
    commit: "abc123",
    build: "build-7"
  });
});

test("disabled Radar route remains hidden", async () => {
  const app = express();
  app.use("/amistosos", createFriendliesRouter({ config: createRadarConfig({}) }));
  const response = await request(app, "/amistosos/status");
  assert.equal(response.status, 404);
  assert.equal(response.body.ok, false);
});

test("server integration preserves the legacy root while Radar is disabled", async () => {
  const dataDirectory = fs.mkdtempSync(path.join(os.tmpdir(), "omascote-radar-off-"));
  const previous = {
    dataDirectory: process.env.OMASCOTE_DATA_DIR,
    enabled: process.env.RADAR_AMISTOSOS_ENABLED,
    profilePrintEnabled: process.env.RADAR_PROFILE_PRINT_IMPORT_ENABLED,
    databaseUrl: process.env.DATABASE_URL,
    jwtSecret: process.env.JWT_SECRET
  };

  process.env.OMASCOTE_DATA_DIR = dataDirectory;
  process.env.JWT_SECRET = "radar-foundation-test-secret";
  delete process.env.RADAR_AMISTOSOS_ENABLED;
  delete process.env.RADAR_PROFILE_PRINT_IMPORT_ENABLED;
  delete process.env.DATABASE_URL;

  try {
    const { app } = require("./server");
    const legacy = await request(app, "/");
    const radar = await request(app, "/amistosos/status");
    const radarIdentity = await request(app, "/me/time/radar");
    const profilePrint = await request(app, "/me/time/perfil/importar-print", { method: "POST" });
    const ready = await request(app, "/health/ready");

    assert.equal(legacy.status, 200);
    assert.equal(legacy.body.msg, "omascote-api online");
    assert.equal(radar.status, 404);
    assert.equal(radarIdentity.status, 404);
    assert.equal(profilePrint.status, 404);
    assert.equal(ready.status, 200);
    assert.equal(ready.body.database, "not_required");
  } finally {
    if (previous.dataDirectory === undefined) delete process.env.OMASCOTE_DATA_DIR;
    else process.env.OMASCOTE_DATA_DIR = previous.dataDirectory;
    if (previous.enabled === undefined) delete process.env.RADAR_AMISTOSOS_ENABLED;
    else process.env.RADAR_AMISTOSOS_ENABLED = previous.enabled;
    if (previous.profilePrintEnabled === undefined) {
      delete process.env.RADAR_PROFILE_PRINT_IMPORT_ENABLED;
    } else {
      process.env.RADAR_PROFILE_PRINT_IMPORT_ENABLED = previous.profilePrintEnabled;
    }
    if (previous.databaseUrl === undefined) delete process.env.DATABASE_URL;
    else process.env.DATABASE_URL = previous.databaseUrl;
    if (previous.jwtSecret === undefined) delete process.env.JWT_SECRET;
    else process.env.JWT_SECRET = previous.jwtSecret;
    fs.rmSync(dataDirectory, { recursive: true, force: true });
  }
});

test("enabled Radar status exposes only non-sensitive policy metadata", async () => {
  const app = express();
  const verificationSecret = "status-test-verification-secret-32bytes";
  const config = createRadarConfig({
    RADAR_AMISTOSOS_ENABLED: "true",
    RADAR_INSTAGRAM_VERIFICATION_SECRET: verificationSecret
  });
  app.use("/amistosos", createFriendliesRouter({ config }));
  const response = await request(app, "/amistosos/status");
  assert.equal(response.status, 200);
  assert.equal(response.body.feature, "radar_amistosos");
  assert.equal(response.body.pilot_free, true);
  assert.equal(JSON.stringify(response.body).includes(verificationSecret), false);
  assert.equal(response.headers.get("cache-control"), "private, no-store");
});

test("liveness returns build metadata and readiness does not require DB while flag is off", async () => {
  const app = express();
  let checks = 0;
  app.use(createHealthRouter({
    config: createRadarConfig({}),
    buildInfo: { commit: "abc", build: "7" },
    checkDatabase: async () => {
      checks += 1;
      return { ok: false };
    }
  }));

  const live = await request(app, "/health/live");
  const ready = await request(app, "/health/ready");
  assert.equal(live.status, 200);
  assert.equal(live.body.commit, "abc");
  assert.equal(ready.status, 200);
  assert.equal(ready.body.radar_amistosos, "disabled");
  assert.equal(ready.body.database, "not_required");
  assert.equal(checks, 0);
});

test("readiness fails closed when enabled Radar cannot reach PostgreSQL", async () => {
  const app = express();
  app.use(createHealthRouter({
    config: createRadarConfig({
      RADAR_AMISTOSOS_ENABLED: "true",
      RADAR_INSTAGRAM_VERIFICATION_SECRET: "x".repeat(32)
    }),
    buildInfo: { commit: null, build: null },
    checkDatabase: async () => ({ ok: false, reason: "database_unavailable" })
  }));

  const live = await request(app, "/health/live");
  const response = await request(app, "/health/ready");
  assert.equal(live.status, 200);
  assert.equal(live.body.ok, true);
  assert.equal(response.status, 503);
  assert.equal(response.body.ok, false);
  assert.equal(response.body.database, "database_unavailable");
  assert.equal(Object.hasOwn(response.body, "code"), false);
  assert.equal(Object.hasOwn(response.body, "details"), false);
});

for (const reason of ["database_schema_missing", "database_schema_outdated"]) {
  test(`readiness returns a non-sensitive 503 for ${reason}`, async () => {
    const app = express();
    app.use(createHealthRouter({
      config: createRadarConfig({
        RADAR_AMISTOSOS_ENABLED: "true",
        RADAR_INSTAGRAM_VERIFICATION_SECRET: "x".repeat(32)
      }),
      buildInfo: { commit: null, build: null },
      checkDatabase: async () => ({ ok: false, reason })
    }));

    const response = await request(app, "/health/ready");
    assert.equal(response.status, 503);
    assert.deepEqual(response.body, {
      ok: false,
      service: "omascote-api",
      commit: null,
      build: null,
      radar_amistosos: "enabled",
      database: reason,
      instagram_verification: "configured",
      profile_print_import: "disabled"
    });
  });
}

test("readiness fails closed when Instagram verification secret is absent", async () => {
  const app = express();
  app.use(createHealthRouter({
    config: createRadarConfig({ RADAR_AMISTOSOS_ENABLED: "true" }),
    buildInfo: { commit: null, build: null },
    checkDatabase: async () => ({ ok: true })
  }));
  const response = await request(app, "/health/ready");
  assert.equal(response.status, 503);
  assert.equal(response.body.ok, false);
  assert.equal(response.body.database, "ready");
  assert.equal(response.body.instagram_verification, "not_configured");
});

test("database readiness requires the latest mandatory migration", async () => {
  const missingSchemaPool = {
    query: async sql => sql.startsWith("SELECT 1 AS ready")
      ? { rows: [{ ready: 1 }], rowCount: 1 }
      : { rows: [{ relation: null }], rowCount: 1 }
  };
  assert.deepEqual(await checkDatabase(missingSchemaPool), {
    ok: false,
    reason: "database_schema_missing"
  });

  const outdatedSchemaPool = {
    query: async (sql, params) => {
      if (sql.startsWith("SELECT 1 AS ready")) return { rows: [{ ready: 1 }], rowCount: 1 };
      if (sql.includes("to_regclass")) {
        return { rows: [{ relation: "schema_migrations" }], rowCount: 1 };
      }
      assert.deepEqual(params, [LATEST_REQUIRED_MIGRATION]);
      return { rows: [], rowCount: 0 };
    }
  };
  assert.deepEqual(await checkDatabase(outdatedSchemaPool), {
    ok: false,
    reason: "database_schema_outdated"
  });

  const currentSchemaPool = {
    query: async sql => {
      if (sql.startsWith("SELECT 1 AS ready")) return { rows: [{ ready: 1 }], rowCount: 1 };
      if (sql.includes("to_regclass")) {
        return { rows: [{ relation: "schema_migrations" }], rowCount: 1 };
      }
      return { rows: [{ "?column?": 1 }], rowCount: 1 };
    }
  };
  assert.deepEqual(await checkDatabase(currentSchemaPool), { ok: true });
});

test("domain state machines allow documented transitions and reject unsafe jumps", () => {
  assert.equal(canTransition(INVITATION_TRANSITIONS, "pending", "accepted"), true);
  assert.equal(canTransition(INVITATION_TRANSITIONS, "accepted", "cancelled"), false);
  assert.equal(canTransition(MATCH_TRANSITIONS, "scheduled", "played"), false);
  assert.equal(canTransition(RESULT_TRANSITIONS, "waiting_other", "verified"), true);
  assert.doesNotThrow(() => assertInvitationTransition("pending", "counter_proposed"));
  assert.throws(
    () => assertResultTransition("verified", "corrected"),
    error => error.code === "INVALID_STATE_TRANSITION"
  );
});

test("versioned migration contains transactional integrity foundations", () => {
  const directory = path.join(__dirname, "src", "db", "migrations");
  const migrations = listMigrationFiles(directory);
  assert.deepEqual(migrations, [
    "001_radar_amistosos_foundation.sql",
    "002_result_confirmation_match_integrity.sql",
    "003_radar_identity_authorization.sql",
    "004_instagram_verification_review.sql",
    "005_profile_print_import.sql",
    "006_friendly_availability_management.sql"
  ]);
  assert.equal(migrations.at(-1), LATEST_REQUIRED_MIGRATION);

  const sql = fs.readFileSync(path.join(directory, "001_radar_amistosos_foundation.sql"), "utf8");
  for (const required of [
    "radar_team_profiles",
    "friendly_invitations",
    "friendly_matches",
    "match_result_submissions",
    "team_reviews",
    "team_blocks",
    "match_audit_events_append_only",
    "friendly_invitations_open_equivalent_idx"
  ]) {
    assert.match(sql, new RegExp(required));
  }

  const integritySql = fs.readFileSync(
    path.join(directory, "002_result_confirmation_match_integrity.sql"),
    "utf8"
  );
  assert.match(integritySql, /submission_id, match_id, submission_version, submission_hash/);

  const identitySql = fs.readFileSync(
    path.join(directory, "003_radar_identity_authorization.sql"),
    "utf8"
  );
  assert.match(identitySql, /public_id uuid NOT NULL DEFAULT gen_random_uuid\(\)/);
  assert.match(identitySql, /radar_team_profiles_account_reference_key/);
  assert.match(identitySql, /radar_profile_mutation_requests_append_only/);

  const verificationSql = fs.readFileSync(
    path.join(directory, "004_instagram_verification_review.sql"),
    "utf8"
  );
  assert.match(verificationSql, /team_verifications_one_open_instagram_challenge_idx/);
  assert.match(verificationSql, /radar_account_roles/);
  assert.match(verificationSql, /radar_verification_mutation_requests_append_only/);

  const profilePrintSql = fs.readFileSync(
    path.join(directory, "005_profile_print_import.sql"),
    "utf8"
  );
  assert.match(profilePrintSql, /team_verifications_one_processing_profile_print_idx/);
  assert.match(profilePrintSql, /radar_profile_print_import_requests/);
  assert.match(profilePrintSql, /radar_profile_print_rate_limits/);

  const availabilitySql = fs.readFileSync(
    path.join(directory, "006_friendly_availability_management.sql"),
    "utf8"
  );
  assert.match(availabilitySql, /friendly_availabilities_open_schedule_key/);
  assert.match(availabilitySql, /radar_availability_mutation_requests_append_only/);
  assert.match(availabilitySql, /friendly availabilities use logical cancellation/);
});
