"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const http = require("node:http");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const express = require("express");
const { AtendimentoChatAuditStore } = require("./src/atendimento/chat-audit.store");
const { createChatAuditAdminRouter } = require("./src/atendimento/chat-audit.routes");

const session = "00000000-0000-4000-8000-000000000001";
const conversationId = "00000000-0000-4000-8000-000000000002";

function createFixture(t) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "omascote-chat-audit-"));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  let timestamp = Date.parse("2026-09-19T12:00:00.000Z");
  const store = new AtendimentoChatAuditStore({
    filePath: path.join(directory, "audit.json"),
    now: () => new Date(timestamp)
  });
  return {
    store,
    advance(milliseconds) { timestamp += milliseconds; }
  };
}

function saveChat(store, chat) {
  return store.captureLabAction({
    session,
    body: {
      action: "save_chat",
      payload: { conversationId, chat }
    }
  });
}

test("libera a conversa somente depois de dez minutos de inatividade", t => {
  const fixture = createFixture(t);
  saveChat(fixture.store, [
    { id: "welcome", role: "assistant", text: "Olá" },
    { id: "u1", role: "user", text: "Quero uma arte de contratação" },
    { id: "a1", role: "assistant", text: "Qual é o esporte?" }
  ]);

  fixture.advance(9 * 60 * 1000 + 59_000);
  assert.equal(fixture.store.listPending().length, 0);
  fixture.advance(1_000);
  const pending = fixture.store.listPending();
  assert.equal(pending.length, 1);
  assert.equal(pending[0].messages[1].text, "Quero uma arte de contratação");
  assert.equal(pending[0].inactive_for_seconds, 600);
});

test("preserva mensagens antigas quando o chat visível é reduzido", t => {
  const fixture = createFixture(t);
  saveChat(fixture.store, [
    { id: "u1", role: "user", text: "Quero anunciar um jogador" },
    { id: "a1", role: "assistant", text: "Envie os dados" }
  ]);
  fixture.advance(1_000);
  const updated = saveChat(fixture.store, [
    { id: "a2", role: "assistant", text: "Pedido enviado" }
  ]);
  assert.deepEqual(updated.messages.map(message => message.id), ["u1", "a1", "a2"]);
});

test("uma atualização posterior volta para a fila sem perder a confirmação anterior", t => {
  const fixture = createFixture(t);
  const first = saveChat(fixture.store, [
    { id: "u1", role: "user", text: "Preciso de uma arte" },
    { id: "a1", role: "assistant", text: "Qual tipo?" }
  ]);
  fixture.advance(10 * 60 * 1000);
  fixture.store.acknowledge({ id: conversationId, revision: first.revision });
  assert.equal(fixture.store.listPending().length, 0);

  fixture.advance(1_000);
  const second = saveChat(fixture.store, [
    { id: "u1", role: "user", text: "Preciso de uma arte" },
    { id: "a1", role: "assistant", text: "Qual tipo?" },
    { id: "u2", role: "user", text: "De resultado" }
  ]);
  fixture.advance(10 * 60 * 1000);
  const pending = fixture.store.listPending();
  assert.equal(pending.length, 1);
  assert.equal(pending[0].revision, second.revision);
  assert.ok(pending[0].delivered_revision < pending[0].revision);
});

test("rotas administrativas exigem administrador e confirmam por revisão", async t => {
  const fixture = createFixture(t);
  const saved = saveChat(fixture.store, [
    { id: "u1", role: "user", text: "Quero uma arte" },
    { id: "a1", role: "assistant", text: "Claro" }
  ]);
  fixture.advance(10 * 60 * 1000);

  const app = express();
  app.use(express.json());
  app.use("/audit", createChatAuditAdminRouter({
    store: fixture.store,
    auth(req, res, next) {
      req.user = { admin: req.headers.authorization === "Bearer admin" };
      next();
    },
    isAdmin: req => req.user?.admin === true
  }));
  const server = http.createServer(app);
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  t.after(() => server.close());
  const base = `http://127.0.0.1:${server.address().port}/audit`;

  assert.equal((await fetch(`${base}/pendentes`)).status, 403);
  const listed = await fetch(`${base}/pendentes`, {
    headers: { Authorization: "Bearer admin" }
  });
  assert.equal(listed.status, 200);
  assert.equal((await listed.json()).total, 1);

  const acknowledged = await fetch(`${base}/${conversationId}/recebida`, {
    method: "POST",
    headers: { Authorization: "Bearer admin", "Content-Type": "application/json" },
    body: JSON.stringify({ revision: saved.revision })
  });
  assert.equal(acknowledged.status, 200);
  assert.equal(fixture.store.listPending().length, 0);
});
