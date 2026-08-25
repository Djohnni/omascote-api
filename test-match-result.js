"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");
const express = require("express");
const { createRadarConfig } = require("./src/config/radar");
const { createHealthRouter } = require("./src/health/health.routes");
const {
  normalizeScore,
  validateConfirmationBody,
  submissionHash
} = require("./src/friendlies/match-result.schemas");
const { createMatchResultService } = require("./src/friendlies/match-result.service");
const { createMatchResultRouter } = require("./src/friendlies/match-result.routes");
const { RadarIdentityError } = require("./src/friendlies/radar-identity.errors");

const MATCH_ID = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const NOW = new Date("2026-08-24T15:00:00.000Z");

function config(overrides = {}) {
  return createRadarConfig({
    RADAR_AMISTOSOS_ENABLED: "true",
    RADAR_MATCH_RESULTS_ENABLED: "true",
    RADAR_MATCH_RESULTS_SECURITY_SECRET: "match-result-test-secret-with-at-least-32-bytes",
    ...overrides
  });
}

async function request(app, route, options = {}) {
  const server = app.listen(0, "127.0.0.1");
  await new Promise(resolve => server.once("listening", resolve));
  try {
    const response = await fetch(`http://127.0.0.1:${server.address().port}${route}`, options);
    return { status: response.status, headers: response.headers, body: await response.json() };
  } finally { await new Promise(resolve => server.close(resolve)); }
}

test("match result flag defaults off and readiness fails closed without its secret", async () => {
  const disabled = createRadarConfig({});
  assert.equal(disabled.matchResultsEnabled, false);
  assert.equal(disabled.matchResultsConfigured, false);
  assert.equal(JSON.stringify(config()).includes("match-result-test-secret"), false);

  const app = express();
  app.use(createHealthRouter({
    config: createRadarConfig({
      RADAR_AMISTOSOS_ENABLED: "true",
      RADAR_INSTAGRAM_VERIFICATION_SECRET: "x".repeat(32),
      RADAR_MATCH_RESULTS_ENABLED: "true"
    }),
    buildInfo: { commit: "test", build: "local" },
    checkDatabase: async () => ({ ok: true })
  }));
  const response = await request(app, "/health/ready");
  assert.equal(response.status, 503);
  assert.equal(response.body.friendly_match_results, "not_configured");
});

test("score schema accepts only integer goals in safe bounds and no ownership fields", () => {
  assert.deepEqual(normalizeScore({ gols_meu_time: 3, gols_adversario: 2 }), {
    gols_meu_time: 3, gols_adversario: 2
  });
  assert.deepEqual(validateConfirmationBody({}), {});
  for (const body of [
    { gols_meu_time: "3", gols_adversario: 2 },
    { gols_meu_time: -1, gols_adversario: 2 },
    { gols_meu_time: 100, gols_adversario: 2 },
    { gols_meu_time: 3, gols_adversario: 2.5 },
    { gols_meu_time: 3, gols_adversario: 2, team_id: MATCH_ID },
    { gols_meu_time: 3 },
    { gols_meu_time: 3, gols_adversario: 2, whatsapp: "+5547999999999" }
  ]) assert.throws(() => normalizeScore(body), error => error.code === "MATCH_RESULT_VALIDATION_ERROR");
  assert.throws(() => submissionHash("known", {}), error => error.code === "MATCH_RESULTS_CONFIGURATION_UNAVAILABLE");
});

test("service validates version and idempotency before normalized repository calls", async () => {
  const calls = [];
  const service = createMatchResultService({
    config: config(),
    repository: { mutateOwned: async value => { calls.push(value); return { match: { match_id: MATCH_ID, version: 4 } }; } },
    clock: () => NOW
  });
  await assert.rejects(service.submit({
    identity: {}, publicId: MATCH_ID, body: { gols_meu_time: 2, gols_adversario: 1 },
    idempotencyKey: "score-submit-0001"
  }), error => error.code === "MATCH_VERSION_REQUIRED");
  await service.submit({
    identity: { accountId: "account-a" }, publicId: MATCH_ID,
    body: { gols_meu_time: 2, gols_adversario: 1 }, expectedVersion: 'W/"3"',
    idempotencyKey: "score-submit-0001", requestId: "score-request"
  });
  await service.confirm({
    identity: { accountId: "account-b" }, publicId: MATCH_ID,
    body: {}, expectedVersion: "4", idempotencyKey: "score-confirm-0001"
  });
  assert.deepEqual(calls.map(value => value.operation), ["submit_result", "confirm_result"]);
  assert.deepEqual(calls[0].value, { gols_meu_time: 2, gols_adversario: 1 });
  assert.equal(calls[0].now.toISOString(), NOW.toISOString());
});

test("result routes are private, authenticated, versioned and hidden by the flag", async () => {
  const calls = [];
  const service = {
    submit: async value => { calls.push(["submit", value]); return { match: { match_id: MATCH_ID, version: 4 } }; },
    confirm: async value => { calls.push(["confirm", value]); return { match: { match_id: MATCH_ID, version: 5 } }; }
  };
  const app = express();
  app.use("/me/time/amistosos", createMatchResultRouter({
    config: config(), resultService: service,
    auth(req, res, next) { req.user = { subject: "owner" }; next(); },
    resolveIdentity: async () => ({ accountId: "account-owner", profileId: "profile-owner" })
  }));
  const headers = {
    "Content-Type": "application/json", "Idempotency-Key": "score-route-key-0001", "If-Match": 'W/"3"'
  };
  const submitted = await request(app, `/me/time/amistosos/${MATCH_ID}/resultado`, {
    method: "POST", headers, body: JSON.stringify({ gols_meu_time: 3, gols_adversario: 2 })
  });
  assert.equal(submitted.status, 200);
  assert.equal(submitted.headers.get("etag"), 'W/"4"');
  assert.equal(submitted.headers.get("cache-control"), "private, no-store");
  const confirmed = await request(app, `/me/time/amistosos/${MATCH_ID}/resultado/confirmar`, {
    method: "POST", headers: { ...headers, "If-Match": 'W/"4"' }, body: "{}"
  });
  assert.equal(confirmed.status, 200);
  assert.equal(confirmed.headers.get("etag"), 'W/"5"');
  assert.deepEqual(calls.map(call => call[0]), ["submit", "confirm"]);

  const hidden = express();
  hidden.use("/me/time/amistosos", createMatchResultRouter({ config: createRadarConfig({}), resultService: service }));
  assert.equal((await request(hidden, `/me/time/amistosos/${MATCH_ID}/resultado`, {
    method: "POST", headers: { "Content-Type": "application/json" }, body: "{}"
  })).status, 404);
});

test("inactive account errors and internal failures never log scores, tokens or request keys", async () => {
  const logs = [];
  const inactive = express();
  inactive.use("/me/time/amistosos", createMatchResultRouter({
    config: config(), resultService: { submit: async () => ({}) },
    auth(req, res, next) { req.user = {}; next(); },
    resolveIdentity: async () => { throw new RadarIdentityError("ACCOUNT_INACTIVE", 403, "Conta inativa."); }
  }));
  assert.equal((await request(inactive, `/me/time/amistosos/${MATCH_ID}/resultado`, {
    method: "POST", headers: { "Content-Type": "application/json" }, body: "{}"
  })).status, 403);

  const broken = express();
  broken.use("/me/time/amistosos", createMatchResultRouter({
    config: config(), resultService: { submit: async () => { throw new Error("score 77 token-private"); } },
    auth(req, res, next) { req.user = {}; next(); },
    resolveIdentity: async () => ({ accountId: "account-a", profileId: "profile-a" }),
    logger: { error(message, value) { logs.push([message, value]); } }
  }));
  const response = await request(broken, `/me/time/amistosos/${MATCH_ID}/resultado`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json", "Authorization": "Bearer token-private",
      "Idempotency-Key": "private-result-key", "If-Match": "3"
    },
    body: JSON.stringify({ gols_meu_time: 77, gols_adversario: 1 })
  });
  const serialized = JSON.stringify({ response: response.body, logs });
  assert.equal(response.status, 500);
  for (const forbidden of ["77", "token-private", "private-result-key"]) {
    assert.equal(serialized.includes(forbidden), false);
  }
});
