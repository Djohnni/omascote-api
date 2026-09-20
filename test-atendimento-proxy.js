"use strict";

const assert = require("node:assert/strict");
const http = require("node:http");
const test = require("node:test");
const express = require("express");
const {
  ALLOWED_ROUTES,
  createAtendimentoProxyRouter,
  requestSession
} = require("./src/atendimento/chat-proxy.routes");

const session = "00000000-0000-4000-8000-000000000001";

function startServer(fetchImpl, options = {}) {
  const app = express();
  app.use(express.json({ limit: "1mb" }));
  app.use("/atendimento", createAtendimentoProxyRouter({
    upstreamUrl: "https://atendimento.internal",
    fetchImpl,
    now: () => 1_000,
    ...options
  }));
  const server = http.createServer(app);
  return new Promise(resolve => server.listen(0, "127.0.0.1", () => resolve(server)));
}

test("sessão e rotas do atendimento são restritas", () => {
  assert.equal(requestSession({ query: { session } }), session);
  assert.equal(requestSession({ query: { session: "invalida" } }), null);
  assert.equal(ALLOWED_ROUTES.has("lab"), true);
  assert.equal(ALLOWED_ROUTES.has("generate"), false);
});

test("registra o histórico aceito sem alterar a resposta do atendimento", async t => {
  const captured = [];
  const server = await startServer(async () => new Response(JSON.stringify({ ok: true }), {
    status: 200,
    headers: { "Content-Type": "application/json" }
  }), {
    auditStore: {
      captureLabAction(value) { captured.push(value); }
    }
  });
  t.after(() => server.close());
  const base = `http://127.0.0.1:${server.address().port}`;
  const body = {
    action: "save_chat",
    payload: {
      conversationId: session,
      chat: [{ id: "u1", role: "user", text: "Quero uma arte" }]
    }
  };

  const response = await fetch(`${base}/atendimento/lab?session=${session}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body)
  });
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { ok: true });
  assert.equal(captured.length, 1);
  assert.equal(captured[0].session, session);
  assert.deepEqual(captured[0].body, body);
});

test("encaminha o chat sem expor o domínio interno ao navegador", async t => {
  const calls = [];
  const server = await startServer(async (url, init) => {
    calls.push({ url: String(url), init });
    return new Response(JSON.stringify({ ok: true, state: { conversationId: session } }), {
      status: 200,
      headers: { "Content-Type": "application/json" }
    });
  });
  t.after(() => server.close());
  const address = server.address();
  const base = `http://127.0.0.1:${address.port}`;

  const response = await fetch(`${base}/atendimento/lab?session=${session}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ action: "start_conversation", payload: { id: session } })
  });
  assert.equal(response.status, 200);
  assert.equal((await response.json()).ok, true);
  assert.equal(calls[0].url, "https://atendimento.internal/api/lab");
  assert.equal(calls[0].init.headers.Cookie, `omascote_lab=${session}`);
  assert.equal(calls[0].init.body.includes("start_conversation"), true);

  assert.equal((await fetch(`${base}/atendimento/lab?session=invalida`)).status, 400);
  assert.equal((await fetch(`${base}/atendimento/generate?session=${session}`)).status, 404);
});
