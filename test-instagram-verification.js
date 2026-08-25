"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");
const express = require("express");
const { createRadarConfig } = require("./src/config/radar");
const { RadarIdentityError } = require("./src/friendlies/radar-identity.errors");
const {
  challengeForPublicId,
  challengeHash
} = require("./src/friendlies/instagram-verification.crypto");
const {
  validateInitiateInput,
  validateConfirmInput,
  validateRejectInput
} = require("./src/friendlies/instagram-verification.schemas");
const {
  createInstagramVerificationService
} = require("./src/friendlies/instagram-verification.service");
const {
  createInstagramVerificationRouter,
  createInstagramVerificationAdminRouter,
  rateLimitIp
} = require("./src/friendlies/instagram-verification.routes");

const TEST_SECRET = "unit-test-instagram-verification-secret-2026";
const IDENTITY = Object.freeze({
  accountId: "account-owner",
  profileId: "profile-owner",
  legacyProfile: Object.freeze({ nome_time: "Owner FC" })
});
const TEAM = Object.freeze({
  id: "11111111-1111-4111-8111-111111111111",
  instagramHandle: "owner.fc",
  instagramVerificationStatus: "unverified"
});

async function request(app, pathname, options = {}) {
  const server = app.listen(0, "127.0.0.1");
  await new Promise((resolve, reject) => {
    server.once("listening", resolve);
    server.once("error", reject);
  });
  try {
    const address = server.address();
    const response = await fetch(`http://127.0.0.1:${address.port}${pathname}`, options);
    return {
      status: response.status,
      headers: response.headers,
      body: await response.json()
    };
  } finally {
    await new Promise(resolve => server.close(resolve));
  }
}

function verification(overrides = {}) {
  return Object.freeze({
    id: "22222222-2222-4222-8222-222222222222",
    publicId: "33333333-3333-4333-8333-333333333333",
    teamId: TEAM.id,
    method: "instagram_bio_code",
    status: "pending",
    challengeExpiresAt: "2026-08-24T12:20:00.000Z",
    attemptCount: 0,
    instagramHandleSnapshot: "owner.fc",
    confirmationClaimedAt: null,
    decidedAt: null,
    version: 1,
    createdAt: "2026-08-24T12:00:00.000Z",
    ...overrides
  });
}

test("verification contracts reject client ownership fields and normalize Instagram", () => {
  assert.deepEqual(validateInitiateInput({ instagram_handle: "https://instagram.com/Owner.FC/" }), {
    instagramHandle: "owner.fc"
  });
  for (const body of [
    { instagram_handle: "owner.fc", team_id: "forged" },
    { instagram_handle: "owner.fc", account_id: "forged" },
    { instagram_handle: "https://example.com/owner" }
  ]) {
    assert.throws(
      () => validateInitiateInput(body),
      error => error.code === "VALIDATION_ERROR"
    );
  }
  assert.deepEqual(validateConfirmInput({
    verification_id: "33333333-3333-4333-8333-333333333333",
    code: "mcfc-abcd-2345"
  }), {
    verificationId: "33333333-3333-4333-8333-333333333333",
    code: "MCFC-ABCD-2345"
  });
  assert.throws(
    () => validateRejectInput({ reason_code: "other", notes: "" }),
    error => error.code === "VALIDATION_ERROR"
  );
});

test("challenge is deterministic, segmented and protected by keyed hash", () => {
  const publicId = "33333333-3333-4333-8333-333333333333";
  const challenge = challengeForPublicId(TEST_SECRET, publicId);
  assert.match(challenge.code, /^MCFC-[A-HJ-NP-Z2-9]{4}-[A-HJ-NP-Z2-9]{4}$/);
  assert.equal(challenge.segments.join(challenge.separator), challenge.code);
  assert.equal(challengeForPublicId(TEST_SECRET, publicId).code, challenge.code);
  const hash = challengeHash(TEST_SECRET, challenge.code);
  assert.match(hash, /^[0-9a-f]{64}$/);
  assert.equal(hash.includes(challenge.code), false);
  assert.notEqual(challengeHash(`${TEST_SECRET}-other`, challenge.code), hash);
});

test("IP rate limiting uses the proved third address from the right on Render", () => {
  const req = {
    get: name => name === "X-Forwarded-For" ? "203.0.113.7, 198.51.100.10, 192.0.2.20" : "",
    ip: "10.0.0.4",
    socket: { remoteAddress: "10.0.0.4" }
  };
  assert.equal(rateLimitIp(req, { instagramTrustedProxyHops: 0 }), "10.0.0.4");
  assert.equal(rateLimitIp(req, { trustedProxyProvider: "render", trustedProxyHops: 3 }), "203.0.113.7");
  assert.equal(rateLimitIp(req, { trustedProxyProvider: "render", trustedProxyHops: 2 }), "198.51.100.10");
});

test("initiation fails closed without an independent verification secret", async () => {
  const repository = {
    getOwnerState() { throw new Error("must not reach repository"); }
  };
  const service = createInstagramVerificationService({
    repository,
    config: createRadarConfig({ RADAR_AMISTOSOS_ENABLED: "true" })
  });
  await assert.rejects(
    service.initiate({ identity: IDENTITY, body: { instagram_handle: "owner.fc" } }),
    error => error.code === "INSTAGRAM_VERIFICATION_NOT_CONFIGURED" && error.status === 503
  );
});

test("rate limits fail closed before creating another challenge", async () => {
  let initiated = false;
  const repository = {
    async getOwnerState() { return { team: TEAM, verification: null }; },
    async consumeRateLimits(input) {
      assert.deepEqual(input.scopes.map(scope => scope.type), ["account", "team", "ip"]);
      return { allowed: false, exceeded: ["account"] };
    },
    async initiate() { initiated = true; }
  };
  const service = createInstagramVerificationService({
    repository,
    config: createRadarConfig({
      RADAR_AMISTOSOS_ENABLED: "true",
      RADAR_INSTAGRAM_VERIFICATION_SECRET: TEST_SECRET
    })
  });
  await assert.rejects(
    service.initiate({
      identity: IDENTITY,
      body: { instagram_handle: "owner.fc" },
      idempotencyKey: "rate-limit-unit-0001",
      requestContext: { ip: "127.0.0.1" }
    }),
    error => error.code === "VERIFICATION_RATE_LIMITED" && error.status === 429
  );
  assert.equal(initiated, false);
});

test("initiation response never contains the complete plaintext code", async () => {
  let inserted;
  const repository = {
    async getOwnerState() { return { team: TEAM, verification: null }; },
    async consumeRateLimits() { return { allowed: true, exceeded: [] }; },
    async initiate(input) {
      inserted = input;
      return {
        verification: verification({
          publicId: input.publicId,
          challengeHash: input.challengeHash,
          challengeExpiresAt: input.expiresAt
        }),
        replayed: false
      };
    }
  };
  const service = createInstagramVerificationService({
    repository,
    config: createRadarConfig({
      RADAR_AMISTOSOS_ENABLED: "true",
      RADAR_INSTAGRAM_VERIFICATION_SECRET: TEST_SECRET
    }),
    now: () => new Date("2026-08-24T12:00:00.000Z")
  });
  const response = await service.initiate({
    identity: IDENTITY,
    body: { instagram_handle: "owner.fc" },
    idempotencyKey: "initiate-unit-0001",
    requestId: "unit-1",
    requestContext: { ip: "127.0.0.1" }
  });
  const plaintext = response.challenge.segments.join(response.challenge.separator);
  assert.equal(JSON.stringify(response).includes(plaintext), false);
  assert.equal(inserted.challengeHash, challengeHash(TEST_SECRET, plaintext));
  assert.equal(JSON.stringify(inserted).includes(plaintext), false);
});

test("owner and admin routers expose only protected expected routes", async () => {
  const calls = [];
  const service = {
    async getOwnerVerification(identity) {
      calls.push(["get", identity]);
      return { instagram_handle: "owner.fc", verification: null };
    },
    async initiate(input) {
      calls.push(["initiate", input]);
      return { verification: { status: "challenge_issued" }, challenge: null, replayed: false };
    },
    async confirm(input) {
      calls.push(["confirm", input]);
      return { verification: { status: "pending_review" }, replayed: false };
    },
    async listPendingReviews(identity) {
      calls.push(["list", identity]);
      return { items: [] };
    },
    async approve(input) {
      calls.push(["approve", input]);
      return { decision: "approved" };
    },
    async reject(input) {
      calls.push(["reject", input]);
      return { decision: "rejected" };
    }
  };
  const options = {
    config: createRadarConfig({ RADAR_AMISTOSOS_ENABLED: "true" }),
    auth(req, res, next) {
      if (req.get("Authorization") !== "Bearer valid") {
        return res.status(401).json({ ok: false, error: "Sem token" });
      }
      req.user = { whatsapp: "5511999999999" };
      return next();
    },
    resolveIdentity: () => IDENTITY,
    verificationService: service,
    logger: { error() { throw new Error("unexpected log"); } }
  };
  const app = express();
  app.use("/me/time", createInstagramVerificationRouter(options));
  app.use("/admin/radar/verificacoes", createInstagramVerificationAdminRouter(options));

  assert.equal((await request(app, "/me/time/verificacao")).status, 401);
  const owner = await request(app, "/me/time/verificacao", {
    headers: { Authorization: "Bearer valid" }
  });
  assert.equal(owner.status, 200);
  assert.equal(owner.headers.get("cache-control"), "private, no-store");

  const initiated = await request(app, "/me/time/verificacoes/instagram", {
    method: "POST",
    headers: {
      Authorization: "Bearer valid",
      "Content-Type": "application/json",
      "Idempotency-Key": "route-initiate-0001"
    },
    body: JSON.stringify({ instagram_handle: "owner.fc" })
  });
  assert.equal(initiated.status, 201);

  const confirmed = await request(app, "/me/time/verificacoes/instagram/confirmar", {
    method: "POST",
    headers: {
      Authorization: "Bearer valid",
      "Content-Type": "application/json",
      "Idempotency-Key": "route-confirm-0001"
    },
    body: JSON.stringify({
      verification_id: "33333333-3333-4333-8333-333333333333",
      code: "MCFC-ABCD-2345"
    })
  });
  assert.equal(confirmed.status, 200);

  const queue = await request(app, "/admin/radar/verificacoes", {
    headers: { Authorization: "Bearer valid" }
  });
  assert.equal(queue.status, 200);
  assert.equal(calls.some(call => call[0] === "list"), true);
});

test("feature flag hides owner and administrative verification routes", async () => {
  const options = { config: createRadarConfig({}) };
  const app = express();
  app.use("/me/time", createInstagramVerificationRouter(options));
  app.use("/admin/radar/verificacoes", createInstagramVerificationAdminRouter(options));
  assert.equal((await request(app, "/me/time/verificacao")).status, 404);
  assert.equal((await request(app, "/admin/radar/verificacoes")).status, 404);
});

test("inactive-account errors remain private at verification routes", async () => {
  const app = express();
  app.use("/me/time", createInstagramVerificationRouter({
    config: createRadarConfig({ RADAR_AMISTOSOS_ENABLED: "true" }),
    auth(req, res, next) { req.user = { whatsapp: "5511999999999" }; next(); },
    resolveIdentity() {
      throw new RadarIdentityError("ACCOUNT_INACTIVE", 403, "Conta inativa.");
    },
    verificationService: { getOwnerVerification() {} }
  }));
  const response = await request(app, "/me/time/verificacao");
  assert.equal(response.status, 403);
  assert.deepEqual(response.body, { ok: false, code: "ACCOUNT_INACTIVE", error: "Conta inativa." });
});
