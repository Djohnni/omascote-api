"use strict";

// Real Express/multer/payment routes, isolated persistent data and no network.
const assert = require("node:assert/strict");
const test = require("node:test");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const jwt = require("jsonwebtoken");
const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "omascote-tester-integration-"));
process.env.OMASCOTE_DATA_DIR = dataDir;
process.env.NODE_ENV = "test";
process.env.JWT_SECRET = "local-tester-integration-secret-only";
process.env.BOT_ADMIN_WHATSAPP = "tester-integration-bot";
process.env.WEEKLY_PLANS_ENABLED = "false";
process.env.RADAR_ENABLED = "false";
process.env.RADAR_AMISTOSOS_ENABLED = "false";
delete process.env.DATABASE_URL;
delete process.env.RADAR_DATABASE_EMBEDDED_PATH;
delete process.env.POSTGRES_URL;
process.env.VEO_VIDEO_ENABLED = "true";
process.env.GOOGLE_CLIENT_ID = "local-tester-google-client";

const storeModule = require("./src/tester-bonus/tester-bonus.store");
const createStore = storeModule.createTesterBonusStore;
const store = createStore({ dataDir });
let failConsume = false;
storeModule.createTesterBonusStore = options => {
  const original = createStore(options);
  return { ...original, consume: input => {
    if (failConsume) { failConsume = false; return Promise.reject(new Error("injected_consume_failure")); }
    return original.consume(input);
  } };
};
const planModule = require("./src/plans/weekly-plans.service");
const createPlans = planModule.createWeeklyPlansService;
let planQueries = 0;
planModule.createWeeklyPlansService = options => ({ ...createPlans(options),
  customerOperationalState: async () => { planQueries += 1; return { hasEntitlement: false, paymentPending: false }; }
});
// This fixture disables the optional database; opening it is a test failure.
const Module = require("node:module");
const load = Module._load;
Module._load = function(request, parent, isMain) {
  if (request === "pg") return { Pool: class { constructor() { throw new Error("Unexpected PostgreSQL use in offline tester-bonus fixture"); } } };
  return load.call(this, request, parent, isMain);
};
let app, resetDedupe;
try {
  const serverModule = require("./server");
  app = serverModule.app;
  resetDedupe = serverModule.__resultadoScenarioTest.resetDedupe;
} finally { Module._load = load; }
const { injectRequest } = require("./test-support/inject-request");
const orderService = require("./src/orders/order.service");
const orderStorage = require("./src/orders/order.storage");
const clientsFile = path.join(dataDir, "clientes.json");
const pedidosDir = path.join(dataDir, "pedidos");
const png = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Y9Z8HkAAAAASUVORK5CYII=", "base64");

function readClients() { return JSON.parse(fs.readFileSync(clientsFile, "utf8")); }
async function customer(id, { balance = 0, bonus = true } = {}) {
  const all = readClients();
  all[id] = { ativo: true, nome_time: "Local test", saldo_extra: balance, saldo_mensal: 0,
    usados_no_ciclo: 8, ciclo_mes: new Date().toISOString().slice(0, 7).replace("-", ""),
    ...(bonus ? { tester_bonus_customer_key: id } : {}) };
  fs.writeFileSync(clientsFile, JSON.stringify(all));
  if (bonus) await store.grant({ customerKey: id, actor: "local-test-admin" });
}
function headers(owner) {
  return owner ? { authorization: "Bearer " + jwt.sign({ whatsapp: owner }, process.env.JWT_SECRET) } : {};
}
function api(owner, route, json, method = json === undefined ? "GET" : "POST") {
  return injectRequest(app, { method, path: route, headers: headers(owner), ...(json === undefined ? {} : { json }) });
}
function image(owner, requestId, fields = {}, extra = {}) {
  return injectRequest(app, { method: "POST", path: "/pedidos", headers: headers(owner), multipart: {
    fields: { flyer_tipo: "escudo3d", rodada: "Escudo 3D", data: "Escudo 3D",
      ...(requestId ? { client_request_id: requestId } : {}),
      fields_json: JSON.stringify({ delivery_mode: "image", sport: "Futebol", ...fields }), ...extra },
    files: [{ field: "escudo1", filename: "escudo.png", contentType: "image/png", data: png }]
  } });
}
function saved(owner, requestId) { return orderStorage.findPedidoByClientRequestId(pedidosDir, owner, requestId); }
function quote(owner, extra = {}) { return api(owner, "/cupons/preco", { product_id: "escudo3d", delivery_mode: "image", ...extra }); }

test("tester promotion isolates five images from payments, video and other quotas", async t => {
  await customer("tester-integration-bot", { bonus: false });

  await t.test("unknown login keeps its existing unauthorized response and empty credentials remain invalid", async () => {
    for (const identifier of ["unknown-existing-format", "unknown.campaign@gmail.com"]) {
      const response = await api(null, "/auth/login", { whatsapp: identifier, senha: "local-unknown-password" });
      assert.equal(response.status, 401, response.text);
      assert.equal(response.json.error, "Login não encontrado");
    }
    assert.equal((await api(null, "/auth/login", { whatsapp: "", senha: "local-password" })).status, 400);
    assert.equal((await api(null, "/auth/login", { whatsapp: "unknown-existing-format", senha: "" })).status, 400);
  });

  await t.test("quote never consumes; six parallel images cover five and no sixth escudo gift", async () => {
    await customer("five");
    for (let index = 0; index < 3; index++) {
      const response = await quote("five");
      assert.equal(response.status, 200, response.text);
      assert.equal(response.json.valor_final, 0);
      assert.equal(response.json.coberto_pelo_bonus_testador, true);
    }
    assert.equal(store.getSummary("five").remaining, 5);
    const requests = await Promise.all(Array.from({ length: 6 }, (_, i) => image("five", `five-creation-${i}`)));
    requests.forEach(response => assert.equal(response.status, 200, response.text));
    const free = requests.filter(response => response.json.coberto_pelo_bonus_testador);
    const paid = requests.filter(response => !response.json.coberto_pelo_bonus_testador);
    assert.equal(free.length, 5);
    assert.equal(paid.length, 1);
    assert.equal(paid[0].json.pagamento_pendente, true);
    assert.equal(paid[0].json.requer_pix_antes_criacao, true);
    assert.equal(paid[0].json.brinde_escudo_login, false);
    assert.equal((await quote("five")).json.valor_final > 0, true);
    const me = await api("five", "/me");
    assert.equal(me.json.tester_image_bonus.used, 5);
    assert.equal(me.json.tester_image_bonus.remaining, 0);
    assert.equal(me.json.brinde_escudo_login_disponivel, false);
    const queue = await api("tester-integration-bot", "/bot/pedidos/novos");
    assert.equal(queue.json.pedidos.filter(item => item.whatsapp === "five").length, 5);
    assert.equal(readClients().five.saldo_extra, 0);
  });

  await t.test("replay and changed content do not spend another image; no-key replay preserves original order", async () => {
    await customer("replays");
    const first = await image("replays", "replay-image-0001");
    const again = await image("replays", "replay-image-0001");
    assert.equal(again.json.pedido_id, first.json.pedido_id);
    assert.equal((await image("replays", "replay-image-0001", { sport: "Futsal" })).status, 409);
    const automatic = await image("replays", null, { sport: "Futsal" });
    resetDedupe(); // Simulate process-local state lost during restart.
    const automaticAgain = await image("replays", null, { sport: "Futsal" });
    assert.equal(automaticAgain.json.pedido_id, automatic.json.pedido_id, automaticAgain.text);
    assert.equal(store.getSummary("replays").used, 2);
    assert.equal(orderStorage.listPedidoBasesByWhatsapp(pedidosDir, "replays").length, 2);
  });

  await t.test("commercial video and aliases stay paid, while image coverage leaves monetary balance intact", async () => {
    await customer("video", { balance: 40 });
    const beforeQueries = planQueries;
    const covered = await image("video", "video-before-image", {}, { cupom_codigo: "NONEXISTENT" });
    assert.equal(covered.json.coberto_pelo_bonus_testador, true, covered.text);
    assert.equal(covered.json.cupom_aplicado, false);
    assert.equal(readClients().video.saldo_extra, 40);
    assert.equal(planQueries, beforeQueries, "promotion must not query/reserve a weekly plan");
    const paid = await image("video", "paid-video-request", { delivery_mode: "foto_video", video_model: "fast" });
    assert.equal(paid.status, 200, paid.text);
    assert.equal(paid.json.coberto_pelo_bonus_testador, false);
    assert.equal(paid.json.valor_final, 14.90);
    assert.equal(readClients().video.saldo_extra, 25.10);
    assert.equal(store.getSummary("video").used, 1);
    assert.equal(saved("video", "paid-video-request").pedido.video_generation.requested, true);
    const videoQuote = await quote("video", { fields_json: JSON.stringify({ delivery_mode: "image_video", video_model: "fast" }) });
    assert.equal(videoQuote.json.coberto_pelo_bonus_testador, false);
    assert.equal(videoQuote.json.valor_final, 14.90);
    const bad = await image("video", "invalid-json-request", {}, { fields_json: "{bad" });
    assert.equal(bad.status, 400);
    assert.equal(store.getSummary("video").remaining, 4);
  });

  await t.test("persisted draft and consumption failure recover the same reservation before queueing", async () => {
    await customer("recovery");
    const original = orderService.createOrderDraft;
    let injected = true;
    orderService.createOrderDraft = options => {
      const draft = original(options);
      if (injected) { injected = false; throw new Error("injected_after_draft_save"); }
      return draft;
    };
    try {
      const interrupted = await image("recovery", "persisted-draft-0001");
      assert.equal(interrupted.status, 400, interrupted.text);
    } finally { orderService.createOrderDraft = original; }
    const pending = saved("recovery", "persisted-draft-0001");
    assert.equal(fs.readFileSync(path.join(pending.base, "status.txt"), "utf8").trim(), "preparando_pagamento");
    assert.equal(store.getSummary("recovery").reserved, 1);
    const recovered = await image("recovery", "persisted-draft-0001");
    assert.equal(recovered.status, 200, recovered.text);
    assert.equal(recovered.json.pedido_id, pending.id);
    assert.equal(store.getSummary("recovery").used, 1);
    failConsume = true;
    const consumeFailure = await image("recovery", "consume-failure-0002");
    assert.equal(consumeFailure.status, 503, consumeFailure.text);
    const another = saved("recovery", "consume-failure-0002");
    assert.equal(fs.readFileSync(path.join(another.base, "status.txt"), "utf8").trim(), "preparando_pagamento");
    assert.equal((await image("recovery", "consume-failure-0002")).json.pedido_id, another.id);
    assert.equal(store.getSummary("recovery").used, 2);
  });

  await t.test("unsaved draft failure restores one slot and old request cannot resurrect it", async () => {
    await customer("unsaved");
    const original = orderService.createOrderDraft;
    orderService.createOrderDraft = () => { throw new Error("injected_before_save"); };
    try { assert.equal((await image("unsaved", "unsaved-draft-0001")).status, 400); }
    finally { orderService.createOrderDraft = original; }
    assert.equal(store.getSummary("unsaved").remaining, 5);
    assert.equal((await image("unsaved", "unsaved-draft-0001")).status, 409);
    assert.equal((await image("unsaved", "unsaved-new-request")).json.coberto_pelo_bonus_testador, true);
  });

  await t.test("only trusted technical failure without delivered output restores quota; released orders are blocked", async () => {
    await customer("technical");
    const first = await image("technical", "technical-failure-01");
    const orderId = first.json.pedido_id;
    const endpoint = "/bot/suporte/erro-pedido";
    assert.equal((await api("technical", endpoint, { pedido_id: orderId, whatsapp: "technical", motivo: "erro_pipeline" })).status, 403);
    await api("technical", `/pedidos/${orderId}/status`, { status: "erro" });
    assert.equal(store.getSummary("technical").remaining, 4, "client status is not proof of technical failure");
    const payload = { pedido_id: orderId, whatsapp: "technical", motivo: "erro_pipeline" };
    assert.equal((await api("tester-integration-bot", endpoint, payload)).status, 200);
    await api("tester-integration-bot", endpoint, payload);
    assert.equal(store.getSummary("technical").remaining, 5);
    const replay = await image("technical", "technical-failure-01");
    assert.ok([403, 409].includes(replay.status), replay.text);
    assert.equal((await api("technical", `/pedidos/${orderId}/aprovar`, {})).status, 403);
    assert.equal((await api("technical", `/pedidos/${orderId}/download-ticket`, { formato: "resultado" })).status, 403);
    assert.equal((await api("tester-integration-bot", `/bot/pedidos/${orderId}/zip`)).status, 403);
    assert.equal((await api("technical", `/pedidos/${orderId}/solicitar-ajuste`, { motivo: "Corrigir a imagem" })).status, 403);
    const stale = saved("technical", "technical-failure-01");
    fs.writeFileSync(path.join(stale.base, "resultado_final.png"), png);
    stale.pedido.aprovado_cliente = true;
    orderStorage.writeOrder(stale.base, stale.pedido);
    await api("technical", `/pedidos/${orderId}/status`, { status: "novo" });
    assert.equal((await api("technical", `/me/time/galeria/${orderId}/imagem`)).status, 403,
      "a late output after release must not appear in the gallery");
    const queue = await api("tester-integration-bot", "/bot/pedidos/novos");
    assert.equal(queue.json.pedidos.some(item => item.id === orderId), false);
    const delivered = await image("technical", "technical-with-result");
    const entry = saved("technical", "technical-with-result");
    fs.writeFileSync(path.join(entry.base, "resultado_final.png"), png);
    await api("tester-integration-bot", endpoint, { pedido_id: delivered.json.pedido_id, whatsapp: "technical", motivo: "timeout" });
    assert.equal(store.getSummary("technical").remaining, 4, "delivered output cannot be used to farm refunds");
  });

  await t.test("damaged ledger fails closed for grantees and leaves an ordinary customer's paid flow available", async () => {
    await customer("damaged");
    await customer("ordinary", { balance: 20, bonus: false });
    const original = fs.readFileSync(store.filePath);
    fs.writeFileSync(store.filePath, "{corrupt");
    try {
      assert.equal((await quote("damaged")).status, 503);
      assert.equal((await image("damaged", "corrupt-ledger-001")).status, 503);
      assert.equal((await image("damaged", "corrupt-paid-video", { delivery_mode: "image_video", video_model: "fast" })).status, 503);
      assert.equal(orderStorage.listPedidoBasesByWhatsapp(pedidosDir, "damaged").length, 0);
      const ordinary = await image("ordinary", "ordinary-paid-0001", { delivery_mode: "image_video", video_model: "fast" });
      assert.equal(ordinary.status, 200, ordinary.text);
      assert.equal(ordinary.json.valor_final, 14.90);
      assert.equal(readClients().ordinary.saldo_extra, 5.10);
    } finally { fs.writeFileSync(store.filePath, original); }
    fs.unlinkSync(store.filePath);
    try {
      assert.equal((await api("damaged", "/me")).status, 503);
      assert.equal((await quote("damaged")).status, 503, "a missing ledger cannot silently reset five images");
    } finally { fs.writeFileSync(store.filePath, original); }
  });

  await t.test("ordinary accounts retain the existing single escudo gift", async () => {
    await customer("ordinary-gift", { bonus: false, balance: 0 });
    assert.equal((await quote("ordinary-gift")).json.valor_final, 0);
    const gifted = await image("ordinary-gift", "ordinary-gift-once");
    assert.equal(gifted.json.brinde_escudo_login, true);
    assert.equal(gifted.json.coberto_pelo_bonus_testador, false);
    const next = await image("ordinary-gift", "ordinary-gift-next");
    assert.equal(next.json.pagamento_pendente, true);
    assert.equal(next.json.brinde_escudo_login, false);
  });

  await t.test("ten-item player batch counts every individual image, then follows the existing paid flow", async () => {
    await customer("batch-ten");
    const batchId = "tester_batch_of_ten";
    const items = Array.from({ length: 10 }, (_, index) => ({
      product_id: "jogador_escudo", client_request_id: `${batchId}_item_${index}`,
      modalidade_criacao: "com_suporte",
      fields: { rodada: "Jogador + Escudo", data: `Jogador ${index}`, foto_tipo: "jogador" },
      files: { escudo1: `item_${index}_escudo1`, mascote: `item_${index}_mascote` }
    }));
    const files = items.flatMap((item, index) => ["escudo1", "mascote"].map(field => ({
      field: `item_${index}_${field}`, filename: `${field}.png`, contentType: "image/png", data: png
    })));
    const batch = await injectRequest(app, { method: "POST", path: "/me/time/jogos/criar-artes",
      headers: headers("batch-ten"), multipart: { fields: { batch_id: batchId, items_json: JSON.stringify(items) }, files } });
    assert.equal(batch.status, 200, batch.text);
    assert.equal(batch.json.criados.length, 10, batch.text);
    assert.equal(batch.json.criados.filter(item => item.coberto_pelo_bonus_testador).length, 5);
    assert.equal(batch.json.criados.filter(item => item.pagamento_pendente).length, 5);
    assert.equal(store.getSummary("batch-ten").used, 5);
    const replay = await injectRequest(app, { method: "POST", path: "/me/time/jogos/criar-artes",
      headers: headers("batch-ten"), multipart: { fields: { batch_id: batchId, items_json: JSON.stringify(items) }, files } });
    assert.equal(replay.json.criados.length, 10, replay.text);
    assert.equal(store.getSummary("batch-ten").used, 5);
  });

  await t.test("verified Google identity reuses a campaign password account without changing credentials or bonus", async () => {
    await customer("campaign-email", { balance: 37 });
    await customer("campaign-unverified");
    const bcrypt = require("bcryptjs");
    const clients = readClients();
    clients["campaign-email"].email = "campaign.owned@gmail.com";
    clients["campaign-email"].login_tipo = "tester_password";
    clients["campaign-email"].senha_hash = bcrypt.hashSync("local-password-123", 4);
    clients["campaign-unverified"].email = "campaign.unverified@gmail.com";
    clients["campaign-unverified"].login_tipo = "tester_password";
    fs.writeFileSync(clientsFile, JSON.stringify(clients));
    const originalHash = clients["campaign-email"].senha_hash;
    let claims = { aud: process.env.GOOGLE_CLIENT_ID, sub: "verified-google-subject",
      email: "campaign.owned@gmail.com", email_verified: "true" };
    const originalFetch = global.fetch;
    global.fetch = async url => {
      assert.ok(String(url).startsWith("https://oauth2.googleapis.com/tokeninfo?id_token="));
      return new Response(JSON.stringify(claims), { status: 200, headers: { "Content-Type": "application/json" } });
    };
    try {
      const linked = await api(null, "/auth/google", { id_token: "local-fixture-token" });
      assert.equal(linked.status, 200, linked.text);
      assert.equal(jwt.verify(linked.json.token, process.env.JWT_SECRET).whatsapp, "campaign-email");
      let after = readClients();
      assert.equal(after["campaign-email"].senha_hash, originalHash);
      assert.equal(after["campaign-email"].saldo_extra, 37);
      assert.equal(after["campaign-email"].google_id, "verified-google-subject");
      assert.equal(after.google_verified_google_subject, undefined);
      assert.equal(after["google_verified-google-subject"], undefined);
      assert.equal(store.getSummary("campaign-email").remaining, 5);
      const passwordLogin = await api(null, "/auth/login", { whatsapp: "campaign.owned@gmail.com", senha: "local-password-123" });
      assert.equal(passwordLogin.status, 200, passwordLogin.text);
      assert.equal(jwt.verify(passwordLogin.json.token, process.env.JWT_SECRET).whatsapp, "campaign-email");
      claims = { ...claims, email: "campaign.unverified@gmail.com", sub: "unverified-google-subject", email_verified: false };
      const denied = await api(null, "/auth/google", { id_token: "unverified-local-fixture" });
      assert.equal(denied.status, 409, denied.text);
      after = readClients();
      assert.equal(after["google_unverified-google-subject"], undefined);
      assert.equal(after["campaign-unverified"].google_id, undefined);
      claims = { ...claims, email_verified: true };
      after["campaign-unverified"].google_id = "different-google-subject";
      fs.writeFileSync(clientsFile, JSON.stringify(after));
      assert.equal((await api(null, "/auth/google", { id_token: "conflicting-local-fixture" })).status, 409);
    } finally { global.fetch = originalFetch; }
  });
});
