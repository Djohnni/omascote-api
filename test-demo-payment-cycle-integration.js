const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const jwt = require("jsonwebtoken");

const JWT_SECRET = "demo-cycle-integration-secret";
const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "omascote-demo-cycle-api-"));
const clientesFile = path.join(dataDir, "clientes.json");
const pedidosDir = path.join(dataDir, "pedidos");
const whatsapp = "5511999990001";
const botWhatsapp = "5511999990002";
const tinyPng = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Y9Z8HkAAAAASUVORK5CYII=",
  "base64"
);

process.env.OMASCOTE_DATA_DIR = dataDir;
process.env.JWT_SECRET = JWT_SECRET;
process.env.BOT_ADMIN_WHATSAPP = botWhatsapp;
process.env.WEEKLY_PLANS_ENABLED = "false";
process.env.NODE_ENV = "test";

const { app } = require("./server");

function tokenFor(id) {
  return jwt.sign({ whatsapp: id, cliente_id: id }, JWT_SECRET, { expiresIn: "1h" });
}

function writeClientes() {
  const month = new Date().toISOString().slice(0, 7).replace("-", "");
  fs.writeFileSync(clientesFile, JSON.stringify({
    [whatsapp]: {
      id: whatsapp,
      cliente_id: whatsapp,
      whatsapp,
      nome_time: "Teste ciclo demonstracao",
      plano: "teste",
      ativo: true,
      saldo_extra: 0,
      saldo_mensal: 0,
      usados_no_ciclo: 0,
      ciclo_mes: month,
      brinde_mascote_disponivel: false,
      brinde_mascote_ja_liberado: true,
      brinde_escudo3d_app_usado: true
    },
    [botWhatsapp]: {
      id: botWhatsapp,
      cliente_id: botWhatsapp,
      whatsapp: botWhatsapp,
      nome_time: "Bot teste",
      plano: "teste",
      ativo: true,
      saldo_extra: 0,
      saldo_mensal: 0,
      usados_no_ciclo: 0,
      ciclo_mes: month
    }
  }, null, 2), "utf8");
}

function resultForm(requestId) {
  const form = new FormData();
  form.append("client_request_id", requestId);
  form.append("rodada", "Rodada 1");
  form.append("data", "21/09/2026");
  form.append("hora", "20:00");
  form.append("time_principal", "Time A");
  form.append("time_adversario", "Time B");
  form.append("gols_time_principal", "2");
  form.append("gols_adversario", "1");
  form.append("observacao", "Teste do ciclo pago e demonstracao");
  form.append("escudo1", new Blob([tinyPng], { type: "image/png" }), "escudo.png");
  return form;
}

async function request(baseUrl, method, endpoint, token, body) {
  const response = await fetch(`${baseUrl}${endpoint}`, {
    method,
    headers: token ? { Authorization: `Bearer ${token}` } : {},
    body
  });
  return { response, payload: await response.json() };
}

function findOrderFile(orderId) {
  const ownerRoot = path.join(pedidosDir, whatsapp);
  for (const month of fs.readdirSync(ownerRoot)) {
    const candidate = path.join(ownerRoot, month, orderId, "pedido.json");
    if (fs.existsSync(candidate)) return candidate;
  }
  throw new Error(`pedido ${orderId} nao encontrado`);
}

test("API exige pagamento inicial e permite somente uma demonstracao depois", async t => {
  writeClientes();
  const server = await new Promise(resolve => {
    const instance = app.listen(0, "127.0.0.1", () => resolve(instance));
  });
  t.after(() => new Promise(resolve => server.close(resolve)));
  const baseUrl = `http://127.0.0.1:${server.address().port}`;
  const token = tokenFor(whatsapp);

  const first = await request(
    baseUrl,
    "POST",
    "/resultado_do_jogo",
    token,
    resultForm("demo_cycle_first")
  );
  assert.equal(first.response.status, 200, JSON.stringify(first.payload));
  assert.equal(first.payload.pagamento_pendente, true);
  assert.equal(first.payload.requer_pix_antes_criacao, true);
  assert.equal(first.payload.demonstracao_apos_pagamento, false);

  const firstFile = findOrderFile(first.payload.pedido_id);
  const firstBase = path.dirname(firstFile);
  assert.equal(fs.readFileSync(path.join(firstBase, "status.txt"), "utf8").trim(), "aguardando_pagamento");

  const botBeforePayment = await request(
    baseUrl,
    "GET",
    "/bot/pedidos/novos",
    tokenFor(botWhatsapp)
  );
  assert.equal(botBeforePayment.response.status, 200);
  assert.equal(
    botBeforePayment.payload.pedidos.some(item => item.id === first.payload.pedido_id),
    false
  );

  const blockedBeforePayment = await request(
    baseUrl,
    "POST",
    "/resultado_do_jogo",
    token,
    resultForm("demo_cycle_blocked_before_payment")
  );
  assert.equal(blockedBeforePayment.response.status, 409);
  assert.equal(blockedBeforePayment.payload.code, "DEMONSTRACAO_PENDENTE");
  assert.equal(blockedBeforePayment.payload.pedido_id, first.payload.pedido_id);

  const paid = JSON.parse(fs.readFileSync(firstFile, "utf8"));
  paid.pagamento_pendente = false;
  paid.pagamento_metodo = "pix";
  paid.pagamento_confirmado_em = "2026-09-21T22:00:00.000Z";
  paid.pagamento_info = { tipo: "pedido_pix", status: "approved", valor_pago: 8 };
  fs.writeFileSync(firstFile, JSON.stringify(paid, null, 2), "utf8");
  fs.writeFileSync(path.join(firstBase, "status.txt"), "novo", "utf8");

  const demo = await request(
    baseUrl,
    "POST",
    "/resultado_do_jogo",
    token,
    resultForm("demo_cycle_one_demo")
  );
  assert.equal(demo.response.status, 200, JSON.stringify(demo.payload));
  assert.equal(demo.payload.pagamento_pendente, true);
  assert.equal(demo.payload.requer_pix_antes_criacao, false);
  assert.equal(demo.payload.demonstracao_apos_pagamento, true);
  assert.equal(
    fs.readFileSync(path.join(path.dirname(findOrderFile(demo.payload.pedido_id)), "status.txt"), "utf8").trim(),
    "novo"
  );

  const blockedSecondDemo = await request(
    baseUrl,
    "POST",
    "/resultado_do_jogo",
    token,
    resultForm("demo_cycle_blocked_second_demo")
  );
  assert.equal(blockedSecondDemo.response.status, 409);
  assert.equal(blockedSecondDemo.payload.code, "DEMONSTRACAO_PENDENTE");
  assert.equal(blockedSecondDemo.payload.pedido_id, demo.payload.pedido_id);
});
