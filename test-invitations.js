"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");
const express = require("express");
const { createRadarConfig } = require("./src/config/radar");
const {
  normalizeCreateInvitation,
  normalizeCounterProposal,
  validateExpectedVersion,
  validateInvitationList
} = require("./src/friendlies/invitation.schemas");
const { encodeNotificationCursor, decodeNotificationCursor } = require("./src/friendlies/invitation.crypto");
const { createInvitationService } = require("./src/friendlies/invitation.service");
const { createInvitationRouters } = require("./src/friendlies/invitation.routes");
const { createHealthRouter } = require("./src/health/health.routes");

const NOW = new Date("2026-08-24T12:00:00.000Z");
const SECRET = "invitation-contract-secret-with-32-bytes-minimum";

function config(overrides = {}) {
  return createRadarConfig({
    RADAR_AMISTOSOS_ENABLED: "true",
    RADAR_INVITATIONS_ENABLED: "true",
    RADAR_INVITATIONS_SECURITY_SECRET: SECRET,
    ...overrides
  });
}

function body(overrides = {}) {
  return {
    opponent_slug: "uniao-vila-nova",
    starts_at: "2026-09-05T16:00:00-03:00",
    ends_at: "2026-09-05T18:00:00-03:00",
    modality: "society",
    category: "Livre",
    venue_preference: "home",
    message: "Amistoso no sabado.",
    ...overrides
  };
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

test("invitation config is disabled by default, secret is private and readiness contract fails closed", () => {
  const disabled = createRadarConfig({});
  assert.equal(disabled.invitationsEnabled, false);
  assert.equal(disabled.invitationsConfigured, false);
  assert.equal(Object.hasOwn(disabled, "invitationsSecuritySecret"), true);
  assert.equal(JSON.stringify(disabled).includes("invitationsSecuritySecret"), false);
  const missing = createRadarConfig({ RADAR_INVITATIONS_ENABLED: "true" });
  assert.equal(missing.invitationsConfigured, false);
  const enabled = config({ RADAR_INVITATION_EXPIRATION_HOURS: "999" });
  assert.equal(enabled.invitationsConfigured, true);
  assert.equal(enabled.invitationExpirationHours, 168);
});

test("readiness fails closed only when invitation rollout is enabled without its secret", async () => {
  const app = express();
  app.use(createHealthRouter({
    config: createRadarConfig({
      RADAR_AMISTOSOS_ENABLED: "true",
      RADAR_INSTAGRAM_VERIFICATION_SECRET: "x".repeat(32),
      RADAR_INVITATIONS_ENABLED: "true"
    }),
    buildInfo: { commit: "test", build: "local" },
    checkDatabase: async () => ({ ok: true })
  }));
  const response = await request(app, "/health/ready");
  assert.equal(response.status, 503);
  assert.equal(response.body.friendly_invitations, "not_configured");
  assert.equal(JSON.stringify(response.body).includes("secret"), false);
});

test("strict invitation schemas reject ownership, contact, unknown fields and unsafe versions", () => {
  assert.equal(normalizeCreateInvitation(body()).opponentSlug, "uniao-vila-nova");
  for (const invalid of [
    body({ team_id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa" }),
    body({ account_id: "account-other" }),
    body({ message: "WhatsApp 47999999999" }),
    body({ latitude: -26.3 }),
    body({ extra: true })
  ]) {
    assert.throws(() => normalizeCreateInvitation(invalid), error => error.code === "INVITATION_VALIDATION_ERROR");
  }
  const counter = { ...body() };
  delete counter.opponent_slug;
  assert.equal(normalizeCounterProposal(counter).message, "Amistoso no sabado.");
  assert.equal(validateExpectedVersion('W/"3"'), 3);
  assert.throws(() => validateExpectedVersion(null), error => error.code === "INVITATION_VERSION_REQUIRED");
  assert.throws(() => validateInvitationList({ caixa: "entrada", team_id: "x" }, config()), /filtro nao permitido/);
});

test("notification cursor is opaque, signed and tamper resistant", () => {
  const radarConfig = config();
  const cursor = encodeNotificationCursor(radarConfig, {
    created_at: "2026-08-24T12:00:00.000Z",
    public_id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa"
  });
  assert.equal(cursor.includes("2026"), false);
  assert.equal(decodeNotificationCursor(radarConfig, cursor).publicId, "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa");
  assert.throws(() => decodeNotificationCursor(radarConfig, `${cursor}x`), error => error.code === "NOTIFICATION_CURSOR_INVALID");
});

test("service validates idempotency and If-Match before repository mutation", async () => {
  const calls = [];
  const repository = {
    createOwned: async value => { calls.push(["create", value]); return { invitation: { version: 1 } }; },
    listOwned: async value => { calls.push(["list", value]); return { items: [] }; },
    mutateOwned: async value => { calls.push(["mutate", value]); return { invitation: { version: 2 } }; },
    listNotifications: async () => ({ rows: [], limit: 20 }),
    readNotification: async value => { calls.push(["read", value]); return { notification: { read: true } }; }
  };
  const service = createInvitationService({ repository, config: config(), clock: () => NOW });
  await assert.rejects(service.create({ identity: {}, body: body(), idempotencyKey: "short", ip: "127.0.0.1" }), /Idempotency-Key/);
  await service.create({ identity: {}, body: body(), idempotencyKey: "create-invitation-0001", ip: "127.0.0.1" });
  await assert.rejects(service.accept({
    identity: {}, publicId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", body: {},
    expectedVersion: null, idempotencyKey: "accept-invitation-0001", ip: "127.0.0.1"
  }), error => error.code === "INVITATION_VERSION_REQUIRED");
  await service.accept({
    identity: {}, publicId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", body: {},
    expectedVersion: "1", idempotencyKey: "accept-invitation-0001", ip: "127.0.0.1"
  });
  assert.deepEqual(calls.map(call => call[0]), ["create", "mutate"]);
});

test("all routes are authenticated, private, flag gated and expose the expected methods", async () => {
  const calls = [];
  const service = {
    create: async value => { calls.push(["create", value]); return { invitation: { version: 1 }, replayed: false }; },
    list: async value => { calls.push(["list", value]); return { items: [] }; },
    accept: async value => { calls.push(["accept", value]); return { invitation: { version: 2 } }; },
    decline: async value => { calls.push(["decline", value]); return { invitation: { version: 2 } }; },
    cancel: async value => { calls.push(["cancel", value]); return { invitation: { version: 2 } }; },
    counter: async value => { calls.push(["counter", value]); return { invitation: { version: 2 } }; },
    listNotifications: async value => { calls.push(["notifications", value]); return { items: [], pagination: { has_more: false, next_cursor: null } }; },
    readNotification: async value => { calls.push(["read", value]); return { notification: { read: true } }; }
  };
  const app = express();
  const routers = createInvitationRouters({
    config: config(), invitationService: service,
    auth(req, res, next) { req.user = { id: "auth-owner" }; next(); },
    resolveIdentity: async () => ({ accountId: "account-owner", profileId: "profile-owner" })
  });
  app.use("/amistosos", routers.invitationRouter);
  app.use("/me/time/amistosos", routers.teamRouter);
  app.use("/me/notificacoes", routers.notificationRouter);
  const json = { "Content-Type": "application/json", "Idempotency-Key": "route-key-00000001" };
  const created = await request(app, "/amistosos/convites", { method: "POST", headers: json, body: JSON.stringify(body()) });
  assert.equal(created.status, 201);
  assert.equal(created.headers.get("cache-control"), "private, no-store");
  assert.equal(created.headers.get("etag"), 'W/"1"');
  const accepted = await request(app, "/amistosos/convites/aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa/aceitar", {
    method: "POST", headers: { ...json, "If-Match": 'W/"1"' }, body: "{}"
  });
  assert.equal(accepted.status, 200);
  assert.equal(accepted.headers.get("etag"), 'W/"2"');
  assert.equal((await request(app, "/me/time/amistosos/convites?caixa=entrada")).status, 200);
  assert.equal((await request(app, "/me/notificacoes")).status, 200);
  assert.equal((await request(app, "/me/notificacoes/aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa/lida", {
    method: "POST", headers: json, body: "{}"
  })).status, 200);
  assert.deepEqual(calls.map(call => call[0]), ["create", "accept", "list", "notifications", "read"]);

  const disabledApp = express();
  const disabled = createInvitationRouters({ config: createRadarConfig({}), invitationService: service });
  disabledApp.use("/amistosos", disabled.invitationRouter);
  const hidden = await request(disabledApp, "/amistosos/convites", { method: "POST", headers: json, body: JSON.stringify(body()) });
  assert.equal(hidden.status, 404);
});

test("route errors never log bodies, tokens, contact or proposal text", async () => {
  const logs = [];
  const app = express();
  const routers = createInvitationRouters({
    config: config(),
    invitationService: { create: async () => { throw new Error("secret proposal WhatsApp 47999999999"); } },
    auth(req, res, next) { req.user = { id: "owner" }; next(); },
    resolveIdentity: async () => ({ accountId: "account-owner", profileId: "profile-owner" }),
    logger: { error(message, value) { logs.push([message, value]); } }
  });
  app.use("/amistosos", routers.invitationRouter);
  const response = await request(app, "/amistosos/convites", {
    method: "POST",
    headers: { "Content-Type": "application/json", "Authorization": "Bearer private", "Idempotency-Key": "route-error-0000001" },
    body: JSON.stringify(body())
  });
  assert.equal(response.status, 500);
  const serialized = JSON.stringify({ response: response.body, logs });
  for (const forbidden of ["47999999999", "Bearer private", "Amistoso no sabado", "secret proposal"]) {
    assert.equal(serialized.includes(forbidden), false);
  }
});
