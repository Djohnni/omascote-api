"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");
const express = require("express");
const { createRadarConfig } = require("./src/config/radar");
const {
  validateMatchId,
  validateExpectedVersion,
  normalizeCancellation,
  validateMatchList,
  safeResolvedContact
} = require("./src/friendlies/match-center.schemas");
const { createMatchCenterService } = require("./src/friendlies/match-center.service");
const { createMatchCenterRouter } = require("./src/friendlies/match-center.routes");
const { createHealthRouter } = require("./src/health/health.routes");

const MATCH_ID = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const NOW = new Date("2026-08-24T12:00:00.000Z");

function config(overrides = {}) {
  return createRadarConfig({
    RADAR_AMISTOSOS_ENABLED: "true",
    RADAR_INVITATIONS_ENABLED: "true",
    RADAR_MATCH_CENTER_ENABLED: "true",
    RADAR_INVITATIONS_SECURITY_SECRET: "match-center-test-secret-with-at-least-32-bytes",
    ...overrides
  });
}

async function request(app, route, options = {}) {
  const server = app.listen(0, "127.0.0.1");
  await new Promise(resolve => server.once("listening", resolve));
  try {
    const address = server.address();
    const response = await fetch(`http://127.0.0.1:${address.port}${route}`, options);
    return { status: response.status, headers: response.headers, body: await response.json() };
  } finally { await new Promise(resolve => server.close(resolve)); }
}

test("match center flag defaults off and readiness fails closed without configuration", async () => {
  const disabled = createRadarConfig({});
  assert.equal(disabled.matchCenterEnabled, false);
  assert.equal(disabled.matchCenterConfigured, false);
  const app = express();
  app.use(createHealthRouter({
    config: createRadarConfig({
      RADAR_AMISTOSOS_ENABLED: "true",
      RADAR_INSTAGRAM_VERIFICATION_SECRET: "x".repeat(32),
      RADAR_MATCH_CENTER_ENABLED: "true"
    }),
    buildInfo: { commit: "test", build: "local" },
    checkDatabase: async () => ({ ok: true })
  }));
  const response = await request(app, "/health/ready");
  assert.equal(response.status, 503);
  assert.equal(response.body.friendly_match_center, "not_configured");
});

test("match schemas accept only opaque ids, finite reasons and safe filters", () => {
  assert.equal(validateMatchId(MATCH_ID), MATCH_ID);
  assert.equal(validateExpectedVersion('W/"7"'), 7);
  assert.equal(normalizeCancellation({ reason: "weather" }).reason, "weather");
  assert.equal(validateMatchList({ estado: "historico", limit: "10" }, config()).state, "historico");
  for (const body of [
    { reason: "invented" },
    { reason: "weather", team_id: MATCH_ID },
    { reason: "weather", whatsapp: "47999999999" },
    { reason: "weather", message: "telefone privado" }
  ]) {
    assert.throws(() => normalizeCancellation(body), error => error.code === "MATCH_VALIDATION_ERROR");
  }
  assert.throws(() => validateExpectedVersion(null), error => error.code === "MATCH_VERSION_REQUIRED");
  assert.throws(() => validateMatchList({ team_id: MATCH_ID }, config()), /filtro nao permitido/);
});

test("resolved contacts are strictly normalized and never accepted from clients", () => {
  assert.deepEqual(safeResolvedContact({ type: "whatsapp", value: "+5547999999999" }), {
    type: "whatsapp", value: "+5547999999999"
  });
  assert.equal(safeResolvedContact({ type: "whatsapp", value: "47999999999" }), null);
  assert.equal(safeResolvedContact({ type: "url", value: "https://example.test" }), null);
  assert.deepEqual(safeResolvedContact({ type: "email", value: "TIME@EXAMPLE.COM" }), {
    type: "email", value: "time@example.com"
  });
});

test("service resolves opponent contact only for detail and validates every mutation", async () => {
  const calls = [];
  const match = { match_id: MATCH_ID, version: 1, contact_unlocked: true };
  const repository = {
    listOwned: async value => { calls.push(["list", value]); return { items: [match] }; },
    getOwned: async value => {
      calls.push(["get", value]);
      return { match, opponentAccountReference: "opaque-opponent" };
    },
    mutateOwned: async value => {
      calls.push(["mutate", value]);
      return { match: { ...match, version: 2 }, replayed: false };
    }
  };
  const service = createMatchCenterService({
    repository,
    config: config(),
    clock: () => NOW,
    resolveContact: async reference => reference === "opaque-opponent"
      ? { type: "whatsapp", value: "+5547999999999" }
      : null
  });
  const listed = await service.list({ identity: {}, query: {} });
  assert.equal(JSON.stringify(listed).includes("opponent_contact"), false);
  const detail = await service.get({ identity: {}, publicId: MATCH_ID });
  assert.equal(detail.match.opponent_contact.value, "+5547999999999");
  await assert.rejects(service.confirmOccurrence({
    identity: {}, publicId: MATCH_ID, body: {}, expectedVersion: null,
    idempotencyKey: "confirm-match-0001"
  }), error => error.code === "MATCH_VERSION_REQUIRED");
  await service.confirmOccurrence({
    identity: {}, publicId: MATCH_ID, body: {}, expectedVersion: 'W/"1"',
    idempotencyKey: "confirm-match-0001", requestId: "request-one"
  });
  await service.cancel({
    identity: {}, publicId: MATCH_ID, body: { reason: "safety" }, expectedVersion: "1",
    idempotencyKey: "cancel-match-000001", requestId: "request-two"
  });
  assert.deepEqual(calls.map(call => call[0]), ["list", "get", "mutate", "mutate"]);
  assert.equal(JSON.stringify(calls.filter(call => call[0] === "mutate")).includes("47999999999"), false);
});

test("all match routes are private, authenticated, versioned and flag gated", async () => {
  const calls = [];
  const service = {
    list: async value => { calls.push(["list", value]); return { items: [] }; },
    get: async value => { calls.push(["get", value]); return { match: { match_id: MATCH_ID, version: 3 } }; },
    confirmOccurrence: async value => { calls.push(["confirm", value]); return { match: { match_id: MATCH_ID, version: 4 } }; },
    cancel: async value => { calls.push(["cancel", value]); return { match: { match_id: MATCH_ID, version: 4 } }; }
  };
  const app = express();
  app.use("/me/time/amistosos", createMatchCenterRouter({
    config: config(), matchService: service,
    auth(req, res, next) { req.user = { subject: "owner" }; next(); },
    resolveIdentity: async () => ({ accountId: "account-owner", profileId: "profile-owner" })
  }));
  const json = {
    "Content-Type": "application/json",
    "Idempotency-Key": "route-match-key-0001",
    "If-Match": 'W/"3"'
  };
  const list = await request(app, "/me/time/amistosos?estado=proximas");
  assert.equal(list.status, 200);
  assert.equal(list.headers.get("cache-control"), "private, no-store");
  const detail = await request(app, `/me/time/amistosos/${MATCH_ID}`);
  assert.equal(detail.status, 200);
  assert.equal(detail.headers.get("etag"), 'W/"3"');
  const confirmed = await request(app, `/me/time/amistosos/${MATCH_ID}/confirmar-realizacao`, {
    method: "POST", headers: json, body: "{}"
  });
  assert.equal(confirmed.status, 200);
  assert.equal(confirmed.headers.get("etag"), 'W/"4"');
  assert.equal((await request(app, `/me/time/amistosos/${MATCH_ID}/cancelar`, {
    method: "POST", headers: json, body: JSON.stringify({ reason: "weather" })
  })).status, 200);
  assert.deepEqual(calls.map(call => call[0]), ["list", "get", "confirm", "cancel"]);

  const hiddenApp = express();
  hiddenApp.use("/me/time/amistosos", createMatchCenterRouter({
    config: createRadarConfig({}), matchService: service
  }));
  assert.equal((await request(hiddenApp, "/me/time/amistosos")).status, 404);
});

test("route failures do not log contact, token, idempotency key or body", async () => {
  const logs = [];
  const app = express();
  app.use("/me/time/amistosos", createMatchCenterRouter({
    config: config(),
    matchService: { cancel: async () => { throw new Error("private +5547999999999 safety"); } },
    auth(req, res, next) { req.user = { subject: "owner" }; next(); },
    resolveIdentity: async () => ({ accountId: "account-owner", profileId: "profile-owner" }),
    logger: { error(message, value) { logs.push([message, value]); } }
  }));
  const response = await request(app, `/me/time/amistosos/${MATCH_ID}/cancelar`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json", "Authorization": "Bearer private-token",
      "Idempotency-Key": "private-idempotency-key", "If-Match": "1"
    },
    body: JSON.stringify({ reason: "safety" })
  });
  assert.equal(response.status, 500);
  const serialized = JSON.stringify({ response: response.body, logs });
  for (const secret of ["+5547999999999", "private-token", "private-idempotency-key", "safety"]) {
    assert.equal(serialized.includes(secret), false);
  }
});
