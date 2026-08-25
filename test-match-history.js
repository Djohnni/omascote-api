"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");
const express = require("express");
const { createRadarConfig } = require("./src/config/radar");
const { createHealthRouter } = require("./src/health/health.routes");
const {
  validateHistoryQuery,
  validateOpponentPublicId
} = require("./src/friendlies/match-history.schemas");
const {
  fingerprint,
  ownerScope,
  encodeHistoryCursor,
  decodeHistoryCursor
} = require("./src/friendlies/match-history.crypto");
const { createMatchHistoryService } = require("./src/friendlies/match-history.service");
const { createMatchHistoryRouter } = require("./src/friendlies/match-history.routes");
const { RadarIdentityError } = require("./src/friendlies/radar-identity.errors");

const OPPONENT_ID = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const MATCH_ID = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const NOW = new Date("2026-08-24T15:00:00.000Z");
const CURSOR_SECRET = "history-cursor-test-secret-at-least-32-bytes";

function config(overrides = {}) {
  return createRadarConfig({
    RADAR_AMISTOSOS_ENABLED: "true",
    RADAR_MATCH_HISTORY_ENABLED: "true",
    RADAR_MATCH_HISTORY_CURSOR_SECRET: CURSOR_SECRET,
    RADAR_MATCH_HISTORY_RATE_LIMIT_SECRET: "history-rate-test-secret-at-least-32-bytes",
    ...overrides
  });
}

async function request(app, route) {
  const server = app.listen(0, "127.0.0.1");
  await new Promise(resolve => server.once("listening", resolve));
  try {
    const response = await fetch(`http://127.0.0.1:${server.address().port}${route}`);
    return { status: response.status, headers: response.headers, body: await response.json() };
  } finally { await new Promise(resolve => server.close(resolve)); }
}

test("match history flag defaults off and readiness fails closed without independent secrets", async () => {
  const disabled = createRadarConfig({});
  assert.equal(disabled.matchHistoryEnabled, false);
  assert.equal(disabled.matchHistoryConfigured, false);
  assert.equal(JSON.stringify(config()).includes("history-cursor-test-secret"), false);

  const app = express();
  app.use(createHealthRouter({
    config: createRadarConfig({
      RADAR_AMISTOSOS_ENABLED: "true",
      RADAR_INSTAGRAM_VERIFICATION_SECRET: "x".repeat(32),
      RADAR_MATCH_HISTORY_ENABLED: "true"
    }),
    buildInfo: { commit: "test", build: "local" },
    checkDatabase: async () => ({ ok: true })
  }));
  const response = await request(app, "/health/ready");
  assert.equal(response.status, 503);
  assert.equal(response.body.friendly_match_history, "not_configured");
});

test("history filters accept only bounded period, situation, cursor and limit", () => {
  const parsed = validateHistoryQuery({ periodo: "90d", situacao: "official", limit: "12" }, config(), NOW);
  assert.equal(parsed.period, "90d");
  assert.equal(parsed.situation, "official");
  assert.equal(parsed.limit, 12);
  assert.equal(parsed.periodFrom.toISOString(), "2026-05-26T15:00:00.000Z");
  assert.equal(validateOpponentPublicId(OPPONENT_ID), OPPONENT_ID);
  for (const query of [
    { owner_id: "private" },
    { team_id: OPPONENT_ID },
    { periodo: "custom" },
    { situacao: "contact" },
    { limit: "500" }
  ]) assert.throws(() => validateHistoryQuery(query, config(), NOW), error => error.code === "MATCH_HISTORY_VALIDATION_ERROR");
  assert.throws(() => validateOpponentPublicId("uniao-vila"), error => error.code === "MATCH_HISTORY_VALIDATION_ERROR");
});

test("signed cursor detects tampering and remains bound to owner, filters and opponent scope", () => {
  const payload = {
    f: fingerprint({ periodo: "all", situacao: "all" }),
    o: ownerScope(CURSOR_SECRET, "internal-team-a"),
    s: `opponent:${OPPONENT_ID}`,
    i: NOW.toISOString(),
    k: { scheduled_at: "2026-08-10T22:00:00.000Z", match_id: MATCH_ID }
  };
  const cursor = encodeHistoryCursor(CURSOR_SECRET, payload);
  const decoded = decodeHistoryCursor(CURSOR_SECRET, cursor);
  assert.equal(decoded.scope, payload.s);
  assert.equal(decoded.key.matchId, MATCH_ID);
  assert.equal(decoded.ownerScope, payload.o);
  assert.throws(() => decodeHistoryCursor(CURSOR_SECRET, `${cursor.slice(0, -1)}0`), error => error.code === "MATCH_HISTORY_CURSOR_INVALID");
});

test("service returns only public history shape and generates a nonrepeating next cursor", async () => {
  const calls = [];
  const service = createMatchHistoryService({
    config: config({ RADAR_MATCH_HISTORY_PAGE_DEFAULT: "1" }),
    clock: () => NOW,
    repository: {
      rowToHistoryItem: row => ({
        match_id: row.match_public_id,
        opponent: { public_id: OPPONENT_ID, name: "Uniao" },
        result: { goals_for: 3, goals_against: 1, outcome: "win" }
      }),
      async read(value) {
        calls.push(value);
        return {
          teamId: "private-team-a",
          opponent: null,
          rows: [{ match_public_id: MATCH_ID, scheduled_at: "2026-08-10T22:00:00.000Z" }],
          hasMore: true,
          summary: { wins: 1, draws: 0, losses: 0, goals_for: 3, goals_against: 1, recent_form: ["win"] }
        };
      }
    }
  });
  const first = await service.list({
    identity: { accountId: "account-a", profileId: "profile-a" },
    query: {}, requestContext: { ip: "203.0.113.4" }
  });
  assert.equal(first.items[0].result.goals_for, 3);
  assert.equal(typeof first.page.next_cursor, "string");
  assert.equal(JSON.stringify(first).includes("private-team-a"), false);
  await service.list({
    identity: { accountId: "account-a", profileId: "profile-a" },
    query: { cursor: first.page.next_cursor }, requestContext: { ip: "203.0.113.4" }
  });
  assert.equal(calls[1].afterKey.matchId, MATCH_ID);
});

test("cursor cannot cross owners, filters or opponents and expires", async () => {
  let teamId = "team-a";
  const service = createMatchHistoryService({
    config: config({ RADAR_MATCH_HISTORY_CURSOR_TTL_MINUTES: "15", RADAR_MATCH_HISTORY_PAGE_DEFAULT: "1" }),
    clock: () => NOW,
    repository: {
      rowToHistoryItem: row => row,
      async read() {
        return {
          teamId, opponent: null,
          rows: [{ match_public_id: MATCH_ID, scheduled_at: "2026-08-10T22:00:00.000Z" }],
          hasMore: true, summary: { recent_form: [] }
        };
      }
    }
  });
  const first = await service.list({ identity: { accountId: "a" }, query: {} });
  teamId = "team-b";
  await assert.rejects(
    service.list({ identity: { accountId: "b" }, query: { cursor: first.page.next_cursor } }),
    error => error.code === "MATCH_HISTORY_CURSOR_OWNER_MISMATCH"
  );
  await assert.rejects(
    service.list({ identity: { accountId: "a" }, query: { situacao: "official", cursor: first.page.next_cursor } }),
    error => error.code === "MATCH_HISTORY_CURSOR_FILTER_MISMATCH"
  );
  teamId = "team-a";
  const expired = encodeHistoryCursor(CURSOR_SECRET, {
    f: fingerprint({ periodo: "all", situacao: "all" }),
    o: ownerScope(CURSOR_SECRET, "team-a"),
    s: "all",
    i: "2026-08-24T14:40:00.000Z",
    k: { scheduled_at: "2026-08-10T22:00:00.000Z", match_id: MATCH_ID }
  });
  await assert.rejects(
    service.list({ identity: { accountId: "a" }, query: { cursor: expired } }),
    error => error.code === "MATCH_HISTORY_CURSOR_EXPIRED"
  );
});

test("history routes are private, authenticated, flag-hidden and logs omit query secrets", async () => {
  const calls = [];
  const service = {
    list: async value => { calls.push(["list", value]); return { summary: {}, items: [], page: {} }; },
    against: async value => { calls.push(["against", value]); return { summary: {}, items: [], page: {} }; }
  };
  const app = express();
  app.use("/me/time/amistosos", createMatchHistoryRouter({
    config: config(), historyService: service,
    auth(req, res, next) { req.user = { subject: "owner" }; next(); },
    resolveIdentity: async () => ({ accountId: "account-owner", profileId: "profile-owner" })
  }));
  const listed = await request(app, "/me/time/amistosos/historico?periodo=30d");
  const against = await request(app, `/me/time/amistosos/historico/${OPPONENT_ID}`);
  assert.equal(listed.status, 200);
  assert.equal(against.status, 200);
  assert.equal(listed.headers.get("cache-control"), "private, no-store");
  assert.deepEqual(calls.map(call => call[0]), ["list", "against"]);

  const hidden = express();
  hidden.use("/me/time/amistosos", createMatchHistoryRouter({ config: createRadarConfig({}), historyService: service }));
  assert.equal((await request(hidden, "/me/time/amistosos/historico")).status, 404);

  const inactive = express();
  inactive.use("/me/time/amistosos", createMatchHistoryRouter({
    config: config(), historyService: service,
    auth(req, res, next) { req.user = {}; next(); },
    resolveIdentity: async () => { throw new RadarIdentityError("ACCOUNT_INACTIVE", 403, "Conta inativa."); }
  }));
  assert.equal((await request(inactive, "/me/time/amistosos/historico")).status, 403);

  const logs = [];
  const broken = express();
  broken.use("/me/time/amistosos", createMatchHistoryRouter({
    config: config(),
    historyService: { list: async () => { throw new Error("cursor-private contact@example.com"); } },
    auth(req, res, next) { req.user = {}; next(); },
    resolveIdentity: async () => ({ accountId: "a", profileId: "p" }),
    logger: { error(message, value) { logs.push([message, value]); } }
  }));
  const failed = await request(broken, "/me/time/amistosos/historico?cursor=cursor-private");
  const serialized = JSON.stringify({ logs, body: failed.body });
  assert.equal(failed.status, 500);
  assert.equal(serialized.includes("cursor-private"), false);
  assert.equal(serialized.includes("contact@example.com"), false);
});
