"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const http = require("node:http");
const crypto = require("node:crypto");
const test = require("node:test");
const express = require("express");
const { createAtendimentoProxyRouter } = require("./src/atendimento/chat-proxy.routes");

async function start(t, options = {}) {
  const storageRoot = await fs.mkdtemp(path.join(os.tmpdir(), "omascote-atendimento-local-"));
  const app = express();
  app.use(express.json({ limit: "1mb" }));
  app.use("/atendimento", createAtendimentoProxyRouter({ storageRoot, ...options }));
  const server = http.createServer(app);
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  t.after(async () => {
    await new Promise(resolve => server.close(resolve));
    assert.ok(path.resolve(storageRoot).startsWith(path.join(path.resolve(os.tmpdir()), "omascote-atendimento-local-")));
    await fs.rm(storageRoot, { recursive: true, force: true });
  });
  const origin = `http://127.0.0.1:${server.address().port}`;
  return {
    storageRoot,
    async request(route, session, body, method = body ? "POST" : "GET") {
      return fetch(`${origin}/atendimento/${route}${route.includes("?") ? "&" : "?"}session=${session}`, {
        method,
        ...(body instanceof FormData ? { body } : body ? {
          headers: { "Content-Type": "application/json" }, body: JSON.stringify(body)
        } : {})
      });
    }
  };
}

test("o atendimento inicia e salva conversas sem depender da hospedagem externa", async t => {
  const captured = [];
  const api = await start(t, { auditStore: { captureLabAction: value => captured.push(value) } });
  const session = crypto.randomUUID();
  const conversationId = crypto.randomUUID();
  let response = await api.request("lab", session, { action: "start_conversation", payload: { id: conversationId } });
  assert.equal(response.status, 200);
  const started = await response.json();
  assert.equal(started.ok, true);
  assert.equal(started.state.conversationId, conversationId);
  assert.equal(started.state.orders.length, 0);
  response = await api.request("lab", session, {
    action: "save_chat", payload: { conversationId, revision: 1, chat: [{ id: "m1", role: "user", text: "Teste da criação" }] }
  });
  assert.equal(response.status, 200);
  const saved = await (await api.request("lab", session)).json();
  assert.equal(saved.state.chat.at(-1).text, "Teste da criação");
  assert.equal(captured.length, 2);
  const isolated = await (await api.request("lab", crypto.randomUUID())).json();
  assert.equal(isolated.state.conversationId, "");
  assert.equal(isolated.state.chat.length, 0);
  assert.equal((await api.request("lab", "../../fora")).status, 400);
  assert.equal((await api.request("generate", session, {})).status, 404);
});

test("anexos são persistidos e pertencem somente à sessão que os enviou", async t => {
  const api = await start(t);
  const session = crypto.randomUUID();
  const conversationId = crypto.randomUUID();
  await api.request("lab", session, { action: "start_conversation", payload: { id: conversationId } });
  const png = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aR1cAAAAASUVORK5CYII=", "base64");
  const form = new FormData();
  form.set("file", new File([png], "escudo.png", { type: "image/png" }));
  form.set("field", "home_crest");
  const uploaded = await api.request("files", session, form);
  assert.equal(uploaded.status, 200);
  const { file } = await uploaded.json();
  assert.match(file.id, /^[a-f0-9-]{36}$/);
  assert.equal(file.field, "home_crest");
  const download = await api.request(`files?id=${file.id}`, session);
  assert.equal(download.status, 200);
  assert.equal(download.headers.get("content-type"), "image/png");
  assert.deepEqual(Buffer.from(await download.arrayBuffer()), png);
  assert.equal((await api.request(`files?id=${file.id}`, crypto.randomUUID())).status, 404);
  const draft = { id: crypto.randomUUID(), flow: "proximo_jogo", values: {}, files: [file], stage: "collect" };
  const saved = await api.request("lab", session, { action: "save_draft", payload: { conversationId, revision: 1, draft } });
  assert.equal(saved.status, 200);
  const state = await (await api.request("lab", session)).json();
  assert.equal(state.state.draft.files[0].id, file.id);
  const foreign = await api.request("lab", crypto.randomUUID(), { action: "save_draft", payload: { draft } });
  assert.equal(foreign.status, 400);
  assert.equal((await api.request("files?id=../../state.json", session)).status, 404);
});

test("falha HTML de um servidor externo vira erro JSON utilizável pelo navegador", async t => {
  const api = await start(t, {
    upstreamUrl: "https://atendimento.example",
    fetchImpl: async () => new Response("<!DOCTYPE html><title>Site unavailable</title>", {
      status: 403, headers: { "Content-Type": "text/html" }
    })
  });
  const response = await api.request("lab", crypto.randomUUID());
  assert.equal(response.status, 502);
  assert.match(response.headers.get("content-type"), /application\/json/);
  assert.deepEqual(await response.json(), {
    ok: false, error: "O atendimento está temporariamente indisponível. Tente novamente em instantes."
  });
});
