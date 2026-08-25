"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");
const express = require("express");
const { createRadarConfig } = require("./src/config/radar");
const { createHealthRouter } = require("./src/health/health.routes");
const {
  normalizeReview,
  reviewPayloadHash
} = require("./src/friendlies/team-reputation.schemas");
const { reputationSnapshot } = require("./src/friendlies/team-reputation.repository");
const { createTeamReputationService } = require("./src/friendlies/team-reputation.service");
const { createTeamReputationRouters } = require("./src/friendlies/team-reputation.routes");
const { RadarIdentityError } = require("./src/friendlies/radar-identity.errors");

const MATCH_ID = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const TEAM_ID = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const NOW = new Date("2026-08-24T18:00:00.000Z");
const REVIEW = Object.freeze({
  pontualidade: 5,
  organizacao: 4,
  comunicacao: 5,
  fair_play: 5,
  jogaria_novamente: true
});

function config(overrides = {}) {
  return createRadarConfig({
    RADAR_AMISTOSOS_ENABLED: "true",
    RADAR_REPUTATION_ENABLED: "true",
    RADAR_REPUTATION_SECURITY_SECRET: "team-reputation-test-secret-at-least-32-bytes",
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

test("reputation flag defaults off and readiness fails closed without its secret", async () => {
  const disabled = createRadarConfig({});
  assert.equal(disabled.reputationEnabled, false);
  assert.equal(disabled.reputationConfigured, false);
  assert.equal(disabled.reputationMinimumVerifiedReviews, 3);
  assert.equal(JSON.stringify(config()).includes("team-reputation-test-secret"), false);

  const app = express();
  app.use(createHealthRouter({
    config: createRadarConfig({
      RADAR_AMISTOSOS_ENABLED: "true",
      RADAR_INSTAGRAM_VERIFICATION_SECRET: "x".repeat(32),
      RADAR_REPUTATION_ENABLED: "true"
    }),
    buildInfo: { commit: "test", build: "local" },
    checkDatabase: async () => ({ ok: true })
  }));
  const response = await request(app, "/health/ready");
  assert.equal(response.status, 503);
  assert.equal(response.body.friendly_reputation, "not_configured");
});

test("review schema is strict, bounded and rejects ownership or free-text fields", () => {
  assert.deepEqual(normalizeReview(REVIEW), REVIEW);
  for (const body of [
    { ...REVIEW, pontualidade: 0 },
    { ...REVIEW, organizacao: 6 },
    { ...REVIEW, comunicacao: "5" },
    { ...REVIEW, fair_play: 4.5 },
    { ...REVIEW, jogaria_novamente: "sim" },
    { ...REVIEW, team_id: TEAM_ID },
    { ...REVIEW, comentario: "texto publico" },
    { ...REVIEW, whatsapp: "+5547999999999" }
  ]) assert.throws(() => normalizeReview(body), error => error.code === "TEAM_REVIEW_VALIDATION_ERROR");
  assert.throws(() => reviewPayloadHash("known", REVIEW), error => error.code === "TEAM_REPUTATION_CONFIGURATION_UNAVAILABLE");
});

test("service derives a protected mutation without accepting a client team id", async () => {
  const calls = [];
  const service = createTeamReputationService({
    config: config(),
    repository: {
      submit: async value => { calls.push(value); return { evaluation: { match_id: MATCH_ID, status: "submitted" } }; },
      listPending: async () => ({ items: [] }),
      getOwn: async () => ({ reputation: {} }),
      getPublic: async () => ({ reputation: {} })
    },
    clock: () => NOW
  });
  await service.submit({
    identity: { accountId: "account-owner", profileId: "profile-owner" },
    publicId: MATCH_ID,
    body: REVIEW,
    idempotencyKey: "review-submit-key-0001",
    requestId: "review-request"
  });
  assert.deepEqual(calls[0].review, REVIEW);
  assert.equal(calls[0].payloadHash.length, 64);
  assert.equal(calls[0].now.toISOString(), NOW.toISOString());
  assert.equal(Object.hasOwn(calls[0], "teamId"), false);
});

test("minimum threshold hides every score and established snapshots stay anonymous", () => {
  const row = {
    team_public_id: TEAM_ID,
    team_public_slug: "uniao-vila-nova",
    team_public_name: "Uniao Vila Nova",
    verified_review_count: 2,
    punctuality_sum: 10,
    organization_sum: 8,
    communication_sum: 9,
    fair_play_sum: 10,
    would_play_again_count: 2
  };
  assert.deepEqual(reputationSnapshot(row, 3), {
    team: { public_id: TEAM_ID, slug: "uniao-vila-nova", name: "Uniao Vila Nova" },
    state: "new",
    label: "Reputacao nova"
  });
  const publicView = reputationSnapshot({
    ...row,
    verified_review_count: 4,
    punctuality_sum: 19,
    organization_sum: 16,
    communication_sum: 18,
    fair_play_sum: 20,
    would_play_again_count: 3
  }, 3);
  assert.equal(publicView.overall, 4.6);
  assert.equal(publicView.would_play_again_percent, 75);
  const serialized = JSON.stringify(publicView);
  for (const forbidden of ["reviewer", "avaliador", "account", "match_id", "comment"]) {
    assert.equal(serialized.includes(forbidden), false);
  }
});

test("private and public routes expose only their contracts and the flag hides both", async () => {
  const calls = [];
  const service = {
    pending: async value => { calls.push(["pending", value]); return { items: [] }; },
    own: async value => { calls.push(["own", value]); return { reputation: { state: "new", label: "Reputacao nova" } }; },
    publicReputation: async value => { calls.push(["public", value]); return { reputation: { state: "new", label: "Reputacao nova" } }; },
    submit: async value => { calls.push(["submit", value]); return { evaluation: { match_id: MATCH_ID, status: "submitted" }, replayed: false }; }
  };
  const routers = createTeamReputationRouters({
    config: config(), reputationService: service,
    auth(req, res, next) { req.user = { subject: "owner" }; next(); },
    resolveIdentity: async () => ({ accountId: "account-owner", profileId: "profile-owner" })
  });
  const app = express();
  app.use("/me/time", routers.privateRouter);
  app.use("/radar/times", routers.publicRouter);

  const pending = await request(app, "/me/time/avaliacoes/pendentes");
  assert.equal(pending.status, 200);
  assert.equal(pending.headers.get("cache-control"), "private, no-store");
  const submitted = await request(app, `/me/time/amistosos/${MATCH_ID}/avaliacao`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "Idempotency-Key": "review-route-key-0001" },
    body: JSON.stringify(REVIEW)
  });
  assert.equal(submitted.status, 200);
  assert.equal((await request(app, "/me/time/reputacao")).status, 200);
  const publicResponse = await request(app, `/radar/times/${TEAM_ID}/reputacao`);
  assert.equal(publicResponse.status, 200);
  assert.equal(publicResponse.headers.get("cache-control"), "no-store");
  assert.deepEqual(calls.map(call => call[0]), ["pending", "submit", "own", "public"]);

  const hiddenRouters = createTeamReputationRouters({ config: createRadarConfig({}), reputationService: service });
  const hidden = express();
  hidden.use("/me/time", hiddenRouters.privateRouter);
  hidden.use("/radar/times", hiddenRouters.publicRouter);
  assert.equal((await request(hidden, "/me/time/reputacao")).status, 404);
  assert.equal((await request(hidden, `/radar/times/${TEAM_ID}/reputacao`)).status, 404);
});

test("inactive accounts and internal failures never log scores, keys or tokens", async () => {
  const inactiveRouters = createTeamReputationRouters({
    config: config(), reputationService: { pending: async () => ({ items: [] }) },
    auth(req, res, next) { req.user = {}; next(); },
    resolveIdentity: async () => { throw new RadarIdentityError("ACCOUNT_INACTIVE", 403, "Conta inativa."); }
  });
  const inactive = express();
  inactive.use("/me/time", inactiveRouters.privateRouter);
  assert.equal((await request(inactive, "/me/time/avaliacoes/pendentes")).status, 403);

  const logs = [];
  const brokenRouters = createTeamReputationRouters({
    config: config(),
    reputationService: { submit: async () => { throw new Error("fair_play 1 token-private"); } },
    auth(req, res, next) { req.user = {}; next(); },
    resolveIdentity: async () => ({ accountId: "account-a", profileId: "profile-a" }),
    logger: { error(message, value) { logs.push([message, value]); } }
  });
  const broken = express();
  broken.use("/me/time", brokenRouters.privateRouter);
  const response = await request(broken, `/me/time/amistosos/${MATCH_ID}/avaliacao`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "Authorization": "Bearer token-private",
      "Idempotency-Key": "private-review-key"
    },
    body: JSON.stringify({ ...REVIEW, fair_play: 1 })
  });
  const serialized = JSON.stringify({ response: response.body, logs });
  assert.equal(response.status, 500);
  for (const forbidden of ["fair_play", "token-private", "private-review-key"]) {
    assert.equal(serialized.includes(forbidden), false);
  }
});
