"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");
const express = require("express");
const { createRadarConfig } = require("./src/config/radar");
const { classifyOperation } = require("./src/observability/radar-observability");
const {
  normalizeMessage, normalizeRead, normalizeReport, normalizeList
} = require("./src/friendlies/match-communication.schemas");
const {
  encodeCursor, decodeCursor, accountPseudonym
} = require("./src/friendlies/match-communication.crypto");
const { createMatchCommunicationService } = require("./src/friendlies/match-communication.service");
const { createMatchCommunicationRouter } = require("./src/friendlies/match-communication.routes");

const SECRET = "communication-secret-that-is-longer-than-32-bytes";
const MATCH_ID = "11111111-1111-4111-8111-111111111111";
const MESSAGE_ID = "22222222-2222-4222-8222-222222222222";

function config(overrides = {}) {
  return createRadarConfig({
    RADAR_AMISTOSOS_ENABLED: "true",
    RADAR_MATCH_COMMUNICATION_ENABLED: "true",
    RADAR_MATCH_COMMUNICATION_SECURITY_SECRET: SECRET,
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

test("communication is feature-flagged and requires an independent secret", async () => {
  const disabled = config({ RADAR_MATCH_COMMUNICATION_ENABLED: "false" });
  assert.equal(disabled.matchCommunicationEnabled, false);
  assert.equal(disabled.matchCommunicationConfigured, true);
  const unconfigured = config({ RADAR_MATCH_COMMUNICATION_SECURITY_SECRET: "short" });
  assert.equal(unconfigured.matchCommunicationConfigured, false);
  assert.equal(Object.keys(config()).includes("matchCommunicationSecuritySecret"), false);
  const service = createMatchCommunicationService({
    repository: { getChannels: async () => ({}) }, config: disabled
  });
  assert.throws(
    () => service.getChannels({ identity: {}, publicId: MATCH_ID }),
    error => error.code === "MATCH_COMMUNICATION_DISABLED" && error.status === 404
  );
});

test("message validation keeps plain HTTPS text and rejects HTML or dangerous schemes", () => {
  assert.deepEqual(normalizeMessage({ texto: "  Olá!\r\nhttps://omascote.com.br  " }), {
    text: "Olá!\nhttps://omascote.com.br"
  });
  for (const texto of ["<b>oi</b>", "javascript:alert(1)", "http://example.com", "data:text/html,x"]) {
    assert.throws(() => normalizeMessage({ texto }), error => error.code === "MATCH_MESSAGE_UNSAFE");
  }
  assert.throws(() => normalizeMessage({ texto: "a".repeat(1001) }), error => error.code === "MATCH_MESSAGE_INVALID");
  assert.throws(() => normalizeMessage({ texto: "oi", html: true }), error => error.code === "MATCH_MESSAGE_INVALID");
});

test("read and report contracts accept only opaque IDs and structured categories", () => {
  assert.deepEqual(normalizeRead({ ultima_mensagem_id: MESSAGE_ID }), { messagePublicId: MESSAGE_ID });
  assert.deepEqual(normalizeReport({ categoria: "harassment" }), { category: "harassment" });
  assert.throws(() => normalizeReport({ categoria: "livre" }), error => error.code === "MATCH_MESSAGE_REPORT_INVALID");
  assert.throws(() => normalizeRead({ ultima_mensagem_id: "12" }), error => error.code === "MATCH_MESSAGE_NOT_FOUND");
});

test("signed pagination rejects tampering and limits remain bounded", () => {
  const current = config();
  const cursor = encodeCursor(current, { created_at: "2026-08-24T12:00:00.000Z", sequence: 42 });
  assert.equal(decodeCursor(current, cursor).sequence, 42);
  assert.throws(() => decodeCursor(current, `${cursor.slice(0, -1)}0`), error => error.code === "MATCH_COMMUNICATION_CURSOR_INVALID");
  assert.deepEqual(normalizeList({}, current), { cursor: null, limit: 30 });
  assert.throws(() => normalizeList({ limit: 101 }, current), error => error.code === "MATCH_COMMUNICATION_QUERY_INVALID");
});

test("account audit references are pseudonymous and observability classifies chat without content", () => {
  const current = config();
  const pseudonym = accountPseudonym(current, "private-login-reference");
  assert.match(pseudonym, /^[0-9a-f]{64}$/);
  assert.equal(pseudonym.includes("private-login-reference"), false);
  assert.equal(classifyOperation("POST", `/me/time/amistosos/${MATCH_ID}/mensagens`), "communication");
});

test("service forwards normalized mutations and hashes idempotent payloads", async () => {
  const calls = [];
  const repository = {
    sendMessage: async value => { calls.push(value); return { ok: true }; },
    markRead: async value => { calls.push(value); return { ok: true }; },
    reportMessage: async value => { calls.push(value); return { ok: true }; }
  };
  const service = createMatchCommunicationService({ repository, config: config(), clock: () => new Date("2026-08-24T12:00:00Z") });
  const base = { identity: { accountId: "account", profileId: "profile" }, publicId: MATCH_ID, ip: "203.0.113.1", idempotencyKey: "communication-key-0001" };
  await service.sendMessage({ ...base, body: { texto: "Vamos jogar!" } });
  await service.markRead({ ...base, idempotencyKey: "communication-key-0002", body: { ultima_mensagem_id: MESSAGE_ID } });
  await service.reportMessage({ ...base, idempotencyKey: "communication-key-0003", messagePublicId: MESSAGE_ID, body: { categoria: "spam" } });
  assert.equal(calls.length, 3);
  assert.equal(calls[0].value.text, "Vamos jogar!");
  assert.match(calls[0].payloadHash, /^[0-9a-f]{64}$/);
  assert.equal(calls[2].messagePublicId, MESSAGE_ID);
});

test("communication routes are private, authenticated, no-store and feature-gated", async () => {
  const calls = [];
  const service = {
    getChannels: async value => { calls.push(["channels", value]); return { channels: {} }; },
    listMessages: async value => { calls.push(["list", value]); return { items: [] }; },
    sendMessage: async value => { calls.push(["send", value]); return { message: { message_id: MESSAGE_ID } }; },
    markRead: async value => { calls.push(["read", value]); return { read: true }; },
    reportMessage: async value => { calls.push(["report", value]); return { case: { case_id: MESSAGE_ID } }; }
  };
  const app = express();
  app.use("/me/time/amistosos", createMatchCommunicationRouter({
    config: config(), service,
    auth(req, res, next) { req.user = { subject: "owner" }; next(); },
    resolveIdentity: async () => ({ accountId: "account-owner", profileId: "profile-owner" })
  }));
  const json = { "Content-Type": "application/json", "Idempotency-Key": "communication-route-key-0001" };
  assert.equal((await request(app, `/me/time/amistosos/${MATCH_ID}/comunicacao`)).status, 200);
  const listed = await request(app, `/me/time/amistosos/${MATCH_ID}/mensagens`);
  assert.equal(listed.status, 200);
  assert.equal(listed.headers.get("cache-control"), "private, no-store");
  assert.equal((await request(app, `/me/time/amistosos/${MATCH_ID}/mensagens`, { method: "POST", headers: json, body: JSON.stringify({ texto: "Olá" }) })).status, 201);
  assert.equal((await request(app, `/me/time/amistosos/${MATCH_ID}/mensagens/lidas`, { method: "POST", headers: json, body: JSON.stringify({ ultima_mensagem_id: MESSAGE_ID }) })).status, 200);
  assert.equal((await request(app, `/me/time/amistosos/${MATCH_ID}/mensagens/${MESSAGE_ID}/denunciar`, { method: "POST", headers: json, body: JSON.stringify({ categoria: "spam" }) })).status, 201);
  assert.deepEqual(calls.map(call => call[0]), ["channels", "list", "send", "read", "report"]);
  const hidden = express();
  hidden.use("/me/time/amistosos", createMatchCommunicationRouter({ config: config({ RADAR_MATCH_COMMUNICATION_ENABLED: "false" }), service }));
  assert.equal((await request(hidden, `/me/time/amistosos/${MATCH_ID}/mensagens`)).status, 404);
});

test("route failures never log message text, token or idempotency key", async () => {
  const logs = [];
  const app = express();
  app.use("/me/time/amistosos", createMatchCommunicationRouter({
    config: config(),
    service: { sendMessage: async () => { throw new Error("private content"); } },
    auth(req, res, next) { req.user = { subject: "owner" }; next(); },
    resolveIdentity: async () => ({ accountId: "account-owner", profileId: "profile-owner" }),
    logger: { error(event, fields) { logs.push([event, fields]); } }
  }));
  const response = await request(app, `/me/time/amistosos/${MATCH_ID}/mensagens`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json", "Authorization": "Bearer private-token",
      "Idempotency-Key": "private-key-0001"
    },
    body: JSON.stringify({ texto: "segredo da partida" })
  });
  assert.equal(response.status, 500);
  const serialized = JSON.stringify({ response: response.body, logs });
  for (const secret of ["segredo da partida", "private-token", "private-key-0001", "private content"]) {
    assert.equal(serialized.includes(secret), false);
  }
});
