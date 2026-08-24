"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const express = require("express");
const { createRadarConfig } = require("./src/config/radar");
const { getBuildInfo } = require("./src/config/build-info");
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
    databaseUrl: process.env.DATABASE_URL,
    jwtSecret: process.env.JWT_SECRET
  };

  process.env.OMASCOTE_DATA_DIR = dataDirectory;
  process.env.JWT_SECRET = "radar-foundation-test-secret";
  delete process.env.RADAR_AMISTOSOS_ENABLED;
  delete process.env.DATABASE_URL;

  try {
    const { app } = require("./server");
    const legacy = await request(app, "/");
    const radar = await request(app, "/amistosos/status");
    const ready = await request(app, "/health/ready");

    assert.equal(legacy.status, 200);
    assert.equal(legacy.body.msg, "omascote-api online");
    assert.equal(radar.status, 404);
    assert.equal(ready.status, 200);
    assert.equal(ready.body.database, "not_required");
  } finally {
    if (previous.dataDirectory === undefined) delete process.env.OMASCOTE_DATA_DIR;
    else process.env.OMASCOTE_DATA_DIR = previous.dataDirectory;
    if (previous.enabled === undefined) delete process.env.RADAR_AMISTOSOS_ENABLED;
    else process.env.RADAR_AMISTOSOS_ENABLED = previous.enabled;
    if (previous.databaseUrl === undefined) delete process.env.DATABASE_URL;
    else process.env.DATABASE_URL = previous.databaseUrl;
    if (previous.jwtSecret === undefined) delete process.env.JWT_SECRET;
    else process.env.JWT_SECRET = previous.jwtSecret;
    fs.rmSync(dataDirectory, { recursive: true, force: true });
  }
});

test("enabled Radar status exposes only non-sensitive policy metadata", async () => {
  const app = express();
  const config = createRadarConfig({ RADAR_AMISTOSOS_ENABLED: "true" });
  app.use("/amistosos", createFriendliesRouter({ config }));
  const response = await request(app, "/amistosos/status");
  assert.equal(response.status, 200);
  assert.equal(response.body.feature, "radar_amistosos");
  assert.equal(response.body.pilot_free, true);
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
    config: createRadarConfig({ RADAR_AMISTOSOS_ENABLED: "true" }),
    buildInfo: { commit: null, build: null },
    checkDatabase: async () => ({ ok: false, reason: "database_unavailable" })
  }));

  const response = await request(app, "/health/ready");
  assert.equal(response.status, 503);
  assert.equal(response.body.ok, false);
  assert.equal(response.body.database, "database_unavailable");
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
  assert.deepEqual(listMigrationFiles(directory), ["001_radar_amistosos_foundation.sql"]);

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
});
