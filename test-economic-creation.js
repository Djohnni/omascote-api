const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const jwt = require("jsonwebtoken");
const crypto = require("node:crypto");
const APP_MODE = process.argv.includes("--app");

const TEST_JWT_SECRET = "economic-creation-integration-secret";
const TEST_MP_WEBHOOK_SECRET = "economic-creation-webhook-secret";
const TEST_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "omascote-economic-test-"));
const resolvedTemp = path.resolve(TEST_DATA_DIR);
const resolvedOsTemp = path.resolve(os.tmpdir());

if (!resolvedTemp.startsWith(resolvedOsTemp + path.sep)) {
  throw new Error("Diretorio temporario fora da area segura.");
}

process.env.JWT_SECRET = TEST_JWT_SECRET;
process.env.MP_ACCESS_TOKEN = "TEST-MP-TOKEN";
process.env.MP_WEBHOOK_SECRET = TEST_MP_WEBHOOK_SECRET;
process.env.OMASCOTE_DATA_DIR = TEST_DATA_DIR;
process.env.BOT_ADMIN_WHATSAPP = "15991120599";
process.env.NODE_ENV = "test";
process.env.MP_ORDERS_V2_TIMEOUT_MS = "60";

const nativeFetch = global.fetch;
const gateway = {
  nextId: 1000,
  failNextCreate: false,
  created: new Map(),
  approved: new Map(),
  idempotency: new Map(),
  nextGetMode: "",
  orderGetCalls: 0
};

global.fetch = async (input, options = {}) => {
  const url = String(input || "");

  if (url === "https://api.mercadopago.com/checkout/preferences" && options.method === "POST") {
    const payload = JSON.parse(options.body || "{}");
    assert.equal(payload.items[0].unit_price, 8);
    return Response.json({ init_point: "https://example.test/checkout/saldo" });
  }

  if (url === "https://api.mercadopago.com/v1/orders" && options.method === "POST") {
    if (gateway.failNextCreate) {
      gateway.failNextCreate = false;
      return new Response(JSON.stringify({ message: "gateway indisponivel" }), {
        status: 500,
        headers: { "Content-Type": "application/json" }
      });
    }

    const payload = JSON.parse(options.body || "{}");
    const idempotencyKey = String(
      options.headers?.["X-Idempotency-Key"] ||
      options.headers?.["x-idempotency-key"] ||
      ""
    );
    const idempotentOrder = idempotencyKey
      ? gateway.idempotency.get(idempotencyKey)
      : null;

    if (idempotentOrder) {
      return new Response(JSON.stringify(idempotentOrder), {
        status: 201,
        headers: { "Content-Type": "application/json" }
      });
    }

    const sequence = ++gateway.nextId;
    const id = `ORD-${sequence}`;
    const paymentId = `PAY-${sequence}`;
    const amount = Number(payload.total_amount);
    const order = {
      id,
      status: "action_required",
      country_code: "BRA",
      total_amount: payload.total_amount,
      external_reference: payload.external_reference,
      payer: payload.payer,
      transactions: {
        payments: [{
          id: paymentId,
          amount: payload.transactions.payments[0].amount,
          status: "action_required",
          payment_method: {
            id: "pix",
            type: "bank_transfer",
            qr_code: `PIX-COPIA-COLA-${id}-${amount}`,
            qr_code_base64: Buffer.from(`QR-${id}`).toString("base64"),
            ticket_url: `https://example.test/pix/${id}`
          }
        }]
      }
    };
    gateway.created.set(id, order);
    if (idempotencyKey) gateway.idempotency.set(idempotencyKey, order);
    return new Response(JSON.stringify(order), {
      status: 201,
      headers: { "Content-Type": "application/json" }
    });
  }

  if (url === "https://api.mercadopago.com/v1/payments" && options.method === "POST") {
    if (gateway.failNextCreate) {
      gateway.failNextCreate = false;
      return new Response(JSON.stringify({ message: "gateway indisponivel" }), {
        status: 500,
        headers: { "Content-Type": "application/json" }
      });
    }

    const payload = JSON.parse(options.body || "{}");
    const id = String(++gateway.nextId);
    const payment = {
      id,
      status: "pending",
      transaction_amount: payload.transaction_amount,
      currency_id: "BRL",
      external_reference: payload.external_reference,
      metadata: payload.metadata,
      payer: payload.payer,
      point_of_interaction: {
        transaction_data: {
          qr_code: `PIX-COPIA-COLA-${id}-${payload.transaction_amount}`,
          qr_code_base64: Buffer.from(`QR-${id}`).toString("base64"),
          ticket_url: `https://example.test/pix/${id}`
        }
      }
    };
    gateway.created.set(id, payment);
    return new Response(JSON.stringify(payment), {
      status: 201,
      headers: { "Content-Type": "application/json" }
    });
  }

  const orderMatch = url.match(/^https:\/\/api\.mercadopago\.com\/v1\/orders\/([^/?#]+)$/);
  if (orderMatch) {
    gateway.orderGetCalls += 1;
    const getMode = gateway.nextGetMode;
    gateway.nextGetMode = "";
    if (getMode === "unavailable") {
      throw new TypeError("gateway indisponivel");
    }
    if (getMode === "slow") {
      await new Promise((resolve, reject) => {
        const timer = setTimeout(resolve, 250);
        options.signal?.addEventListener("abort", () => {
          clearTimeout(timer);
          reject(new DOMException("Aborted", "AbortError"));
        }, { once: true });
      });
    }
    const id = orderMatch[1];
    const order = gateway.approved.get(id) || gateway.created.get(id);
    return new Response(JSON.stringify(order || { status: "not_found" }), {
      status: order ? 200 : 404,
      headers: { "Content-Type": "application/json" }
    });
  }

  const paymentMatch = url.match(/^https:\/\/api\.mercadopago\.com\/v1\/payments\/([^/?#]+)$/);
  if (paymentMatch) {
    const id = paymentMatch[1];
    const payment = gateway.approved.get(id) || gateway.created.get(id);
    return new Response(JSON.stringify(payment || { status: "not_found" }), {
      status: payment ? 200 : 404,
      headers: { "Content-Type": "application/json" }
    });
  }

  return nativeFetch(input, options);
};

const { app, __mpOrdersV2Test } = require("./server");

const CLIENTES_FILE = path.join(TEST_DATA_DIR, "clientes.json");
const PEDIDOS_DIR = path.join(TEST_DATA_DIR, "pedidos");
const SALDO_TRANSACOES_FILE = path.join(TEST_DATA_DIR, "saldo_transacoes.json");
const MP_PROCESSADOS_FILE = path.join(TEST_DATA_DIR, "mp_processados.json");
const MP_ORDERS_V2_FILE = path.join(TEST_DATA_DIR, "mp_orders_v2.json");
const MP_ORDERS_V2_EVENTS_FILE = path.join(TEST_DATA_DIR, "mp_orders_v2_events.jsonl");
const currentMonth = new Date().toISOString().slice(0, 7).replace("-", "");
const tinyPng = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Y9Z8HkAAAAASUVORK5CYII=",
  "base64"
);

function readJson(file, fallback) {
  try {
    return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch {
    return fallback;
  }
}

function writeJson(file, value) {
  fs.writeFileSync(file, JSON.stringify(value, null, 2), "utf8");
}

function putClient(whatsapp, saldo) {
  const clientes = readJson(CLIENTES_FILE, {});
  clientes[whatsapp] = {
    id: whatsapp,
    cliente_id: whatsapp,
    whatsapp,
    nome_time: `Teste ${whatsapp}`,
    plano: "teste",
    ativo: true,
    saldo_extra: Number(saldo),
    saldo_mensal: 0,
    usados_no_ciclo: 0,
    ciclo_mes: currentMonth,
    brinde_mascote_disponivel: false,
    brinde_mascote_ja_liberado: true,
    brinde_escudo3d_app_usado: true
  };
  writeJson(CLIENTES_FILE, clientes);
}

function setBalance(whatsapp, saldo) {
  const clientes = readJson(CLIENTES_FILE, {});
  clientes[whatsapp].saldo_extra = Number(saldo);
  clientes[whatsapp].saldo_mensal = 0;
  writeJson(CLIENTES_FILE, clientes);
}

function tokenFor(whatsapp) {
  return jwt.sign({ whatsapp, cliente_id: whatsapp }, TEST_JWT_SECRET, { expiresIn: "1h" });
}

async function api(
  baseUrl,
  method,
  endpoint,
  { token, body, form, headers: extraHeaders = {} } = {}
) {
  const headers = {
    ...(APP_MODE ? { "X-Omascote-App-Mode": "app" } : {}),
    ...extraHeaders
  };
  if (token) headers.Authorization = `Bearer ${token}`;
  if (body !== undefined) headers["Content-Type"] = "application/json";
  const response = await nativeFetch(`${baseUrl}${endpoint}`, {
    method,
    headers,
    body: form || (body === undefined ? undefined : JSON.stringify(body))
  });
  const contentType = response.headers.get("content-type") || "";
  const payload = contentType.includes("application/json")
    ? await response.json()
    : Buffer.from(await response.arrayBuffer());
  return { response, payload };
}

function orderPath(whatsapp, orderId) {
  const root = path.join(PEDIDOS_DIR, whatsapp);
  if (!fs.existsSync(root)) return "";

  for (const month of fs.readdirSync(root)) {
    const candidate = path.join(root, month, orderId, "pedido.json");
    if (fs.existsSync(candidate)) return candidate;
  }

  return "";
}

function readOrder(whatsapp, orderId) {
  const file = orderPath(whatsapp, orderId);
  assert.ok(file, `pedido ${orderId} nao encontrado`);
  return readJson(file, {});
}

function readOrderStatus(whatsapp, orderId) {
  const file = orderPath(whatsapp, orderId);
  assert.ok(file, `pedido ${orderId} nao encontrado`);
  return fs.readFileSync(path.join(path.dirname(file), "status.txt"), "utf8").trim();
}

function createLegacyOrder(whatsapp, orderId, overrides = {}) {
  const base = path.join(PEDIDOS_DIR, whatsapp, currentMonth, orderId);
  fs.mkdirSync(base, { recursive: true });
  const pedido = {
    id: orderId,
    pedido_id: orderId,
    whatsapp,
    categoria: "resultado",
    modalidade_criacao: "economica",
    pagamento_pendente: true,
    valor_pendente: 4,
    valor_final: 4,
    aprovado_cliente: false,
    ...overrides
  };
  writeJson(path.join(base, "pedido.json"), pedido);
  fs.writeFileSync(path.join(base, "status.txt"), "aguardando_pagamento", "utf8");
  return { base, pedido };
}

function resultBatchForm({ mode, requestId, batchId, tamperedValue }) {
  const form = new FormData();
  const fields = {
    flyer_tipo: "resultado",
    rodada: "Rodada 1",
    data: "25/07/2026",
    hora: "Campeonato de Teste",
    time_principal: "Time A",
    time_adversario: "Time B",
    gols_time_principal: "2",
    gols_adversario: "1",
    observacao: "Teste integrado da criacao economica"
  };

  if (tamperedValue !== undefined) {
    fields.valor = tamperedValue;
    fields.preco = tamperedValue;
    fields.valor_final = tamperedValue;
    fields.valor_pendente = tamperedValue;
  }

  form.append("batch_id", batchId);
  form.append("items_json", JSON.stringify([{
    product_id: "resultado",
    client_request_id: requestId,
    modalidade_criacao: mode,
    fields,
    files: { escudo1: "item_0_escudo1" }
  }]));
  form.append("item_0_escudo1", new Blob([tinyPng], { type: "image/png" }), "escudo.png");
  return form;
}

function doubleResultBatchForm({ mode, batchId }) {
  const form = new FormData();
  const items = [0, 1].map(index => ({
    product_id: "resultado",
    client_request_id: `${batchId}_item_${index + 1}`,
    modalidade_criacao: mode,
    fields: {
      flyer_tipo: "resultado",
      rodada: `Rodada ${index + 1}`,
      data: "25/07/2026",
      hora: "12:00",
      time_principal: `Time ${index + 1}A`,
      time_adversario: `Time ${index + 1}B`,
      gols_time_principal: "2",
      gols_adversario: "1",
      observacao: "Teste de PIX unico para duas artes"
    },
    files: { escudo1: `item_${index}_escudo1` }
  }));
  form.append("batch_id", batchId);
  form.append("items_json", JSON.stringify(items));
  items.forEach((item, index) => {
    form.append(`item_${index}_escudo1`, new Blob([tinyPng], { type: "image/png" }), `escudo_${index}.png`);
  });
  return form;
}

async function createResult(baseUrl, whatsapp, mode, suffix, tamperedValue) {
  const { response, payload } = await api(
    baseUrl,
    "POST",
    "/me/time/jogos/criar-artes",
    {
      token: tokenFor(whatsapp),
      form: resultBatchForm({
        mode,
        requestId: `economic_test_${suffix}`,
        batchId: `economic_batch_${suffix}`,
        tamperedValue
      })
    }
  );

  assert.equal(response.status, 200, JSON.stringify(payload));
  assert.equal(payload.ok, true, JSON.stringify(payload));
  assert.equal(payload.criados.length, 1, JSON.stringify(payload));
  return payload.criados[0];
}

async function getMe(baseUrl, whatsapp) {
  const { response, payload } = await api(baseUrl, "GET", "/me", {
    token: tokenFor(whatsapp)
  });
  assert.equal(response.status, 200, JSON.stringify(payload));
  return payload;
}

async function generatePix(baseUrl, whatsapp, orderId) {
  return api(baseUrl, "POST", `/pedidos/${orderId}/gerar-pix`, {
    token: tokenFor(whatsapp)
  });
}

async function webhook(baseUrl, paymentId, type = "order", extraBody = {}) {
  const dataId = String(paymentId).toLowerCase();
  const timestamp = String(Date.now());
  const requestId = crypto.randomUUID();
  const manifest = `id:${dataId};request-id:${requestId};ts:${timestamp};`;
  const signature = crypto
    .createHmac("sha256", TEST_MP_WEBHOOK_SECRET)
    .update(manifest)
    .digest("hex");
  const endpoint =
    `/webhook/mercadopago?data.id=${encodeURIComponent(paymentId)}` +
    `&type=${encodeURIComponent(type)}`;

  return api(baseUrl, "POST", endpoint, {
    headers: {
      "x-request-id": requestId,
      "x-signature": `ts=${timestamp},v1=${signature}`
    },
    body: { type, data: { id: paymentId }, ...extraBody }
  });
}

async function run() {
  const server = await new Promise(resolve => {
    const instance = app.listen(0, "127.0.0.1", () => resolve(instance));
  });
  const address = server.address();
  const baseUrl = `http://127.0.0.1:${address.port}`;

  try {
    const supportUser = "551100000001";
    const economicUser = "551100000002";
    const insufficientSupportUser = "551100000003";
    const insufficientEconomicUser = "551100000004";
    const pixErrorUser = "551100000005";
    const pixCanceledUser = "551100000006";
    const pixMismatchUser = "551100000007";
    const pixConcurrentUser = "551100000010";
    const autoPlayerUser = "auto_jogador_1785365126442";
    const interruptionUser = "551100000013";
    const wrongOwnerUser = "551100000014";
    const currencyMismatchUser = "551100000015";
    const legacyBalanceUser = "551100000016";
    const legacyPaymentsUser = "551100000017";
    const legacyUntouchedUser = "551100000018";

    putClient(supportUser, 20);
    putClient(economicUser, 20);
    putClient(insufficientSupportUser, 0);
    putClient(insufficientEconomicUser, 0);
    putClient(pixErrorUser, 0);
    putClient(pixCanceledUser, 0);
    putClient(pixMismatchUser, 0);
    putClient(pixConcurrentUser, 0);
    putClient(autoPlayerUser, 0);
    putClient(interruptionUser, 0);
    putClient(wrongOwnerUser, 0);
    putClient(currencyMismatchUser, 0);
    putClient(legacyBalanceUser, 0);
    putClient(legacyPaymentsUser, 0);
    putClient(legacyUntouchedUser, 0);

    const paymentRoutes = [
      "/comprar-creditos",
      "/comprar-creditos-pix",
      "/pedidos/gerar-pix-lote",
      "/pedidos/inexistente/gerar-pix",
      "/pedidos/inexistente/pagar-com-saldo"
    ];
    for (const endpoint of paymentRoutes) {
      const unauthenticated = await api(baseUrl, "POST", endpoint);
      assert.equal(unauthenticated.response.status, 401, endpoint);
    }

    for (const appContext of [
      { headers: { "X-Omascote-App-Mode": "app" } },
      { headers: { "X-Omascote-App-Mode": "twa" } },
      { body: { origem_acesso: "app" } },
      { body: { origem_acesso: "twa" } },
      { body: { omascote_app: "1" } },
      { body: { modo_app: "1" } }
    ]) {
      const missing = await api(baseUrl, "POST", "/pedidos/inexistente/gerar-pix", {
        token: tokenFor(supportUser), ...appContext
      });
      assert.equal(missing.response.status, 404);
    }

    const creditPix = await api(baseUrl, "POST", "/comprar-creditos-pix", {
      token: tokenFor(supportUser), body: { pacote: "saldo_800" }
    });
    assert.equal(creditPix.response.status, 200);
    assert.ok(creditPix.payload.pix_copia_cola);
    assert.ok(creditPix.payload.qr_code_base64);
    assert.equal((await getMe(baseUrl, supportUser)).saldo, 20);
    const creditCheckout = await api(baseUrl, "POST", "/comprar-creditos", {
      token: tokenFor(supportUser), body: { pacote: "saldo_800" }
    });
    assert.equal(creditCheckout.response.status, 200);
    assert.equal(creditCheckout.payload.init_point, "https://example.test/checkout/saldo");

    const support = await createResult(baseUrl, supportUser, "com_suporte", "support_balance");
    assert.equal(support.valor_final, 8);
    assert.equal(support.pagamento_pendente, true);
    assert.equal(support.requer_pix_antes_criacao, true);
    assert.equal((await getMe(baseUrl, supportUser)).saldo, 20);
    const supportOrder = readOrder(supportUser, support.pedido_id);
    for (const action of ["gerar-pix", "pagar-com-saldo"]) {
      const wrongOwner = await api(baseUrl, "POST", `/pedidos/${support.pedido_id}/${action}`, {
        token: tokenFor(wrongOwnerUser)
      });
      assert.equal(wrongOwner.response.status, 404);
    }
    assert.equal(supportOrder.modalidade_criacao, "com_suporte");
    assert.equal(supportOrder.valor_original, 8);
    assert.equal(supportOrder.valor_final, 8);
    assert.equal(supportOrder.pagamento_info, undefined);
    assert.equal(supportOrder.motivo_pagamento_pendente, "pix_obrigatorio_assistente");
    assert.equal(readOrderStatus(supportUser, support.pedido_id), "aguardando_pagamento");

    const economic = await createResult(baseUrl, economicUser, "economica", "economic_balance", 0.01);
    assert.equal(economic.valor_final, 4);
    assert.equal(economic.pagamento_pendente, true);
    assert.equal(economic.requer_pix_antes_criacao, true);
    assert.equal((await getMe(baseUrl, economicUser)).saldo, 20);
    const economicOrder = readOrder(economicUser, economic.pedido_id);
    assert.equal(economicOrder.modalidade_criacao, "economica");
    assert.equal(economicOrder.suporte_personalizado_incluido, false);
    assert.equal(economicOrder.valor_original, 4);
    assert.equal(economicOrder.valor_final, 4);
    assert.equal(economicOrder.pagamento_info, undefined);
    assert.equal(economicOrder.motivo_pagamento_pendente, "pix_obrigatorio_assistente");
    assert.equal(readOrderStatus(economicUser, economic.pedido_id), "aguardando_pagamento");

    const economicReplay = await createResult(baseUrl, economicUser, "economica", "economic_balance", 0.01);
    assert.equal(economicReplay.pedido_id, economic.pedido_id);
    assert.equal((await getMe(baseUrl, economicUser)).saldo, 20);

    const ledger = readJson(SALDO_TRANSACOES_FILE, []);
    const supportTx = ledger.find(tx => tx.pedido_id === support.pedido_id);
    const economicTx = ledger.find(tx => tx.pedido_id === economic.pedido_id);
    assert.equal(supportTx, undefined);
    assert.equal(economicTx, undefined);
    assert.equal(ledger.filter(tx => tx.pedido_id === economic.pedido_id).length, 0);

    const pendingSupport = await createResult(baseUrl, insufficientSupportUser, "com_suporte", "support_pix");
    assert.equal(pendingSupport.pagamento_pendente, true);
    assert.equal(pendingSupport.valor_pendente, 8);
    assert.equal(readOrder(insufficientSupportUser, pendingSupport.pedido_id).valor_final, 8);

    const pendingEconomic = await createResult(baseUrl, insufficientEconomicUser, "economica", "economic_pix");
    assert.equal(pendingEconomic.pagamento_pendente, true);
    assert.equal(pendingEconomic.valor_pendente, 4);
    assert.equal(readOrder(insufficientEconomicUser, pendingEconomic.pedido_id).valor_final, 4);

    const noBalancePayment = await api(
      baseUrl,
      "POST",
      `/pedidos/${pendingEconomic.pedido_id}/pagar-com-saldo`,
      { token: tokenFor(insufficientEconomicUser) }
    );
    assert.equal(noBalancePayment.response.status, 403);
    assert.equal(readOrder(insufficientEconomicUser, pendingEconomic.pedido_id).pagamento_pendente, true);

    setBalance(insufficientEconomicUser, 4);
    const paidWithLaterBalance = await api(
      baseUrl,
      "POST",
      `/pedidos/${pendingEconomic.pedido_id}/pagar-com-saldo`,
      { token: tokenFor(insufficientEconomicUser) }
    );
    assert.equal(paidWithLaterBalance.response.status, 200, JSON.stringify(paidWithLaterBalance.payload));
    assert.equal(paidWithLaterBalance.payload.valor_final, 4);
    assert.equal((await getMe(baseUrl, insufficientEconomicUser)).saldo, 0);
    assert.equal(readOrderStatus(insufficientEconomicUser, pendingEconomic.pedido_id), "novo");
    const laterLedger = readJson(SALDO_TRANSACOES_FILE, []);
    assert.equal(laterLedger.find(tx => tx.pedido_id === pendingEconomic.pedido_id).valor, 4);

    const supportPix = await generatePix(baseUrl, insufficientSupportUser, pendingSupport.pedido_id);
    assert.equal(supportPix.response.status, 200, JSON.stringify(supportPix.payload));
    assert.equal(supportPix.payload.valor_final, 8);
    assert.equal(supportPix.payload.modalidade_criacao, "com_suporte");
    const supportGatewayOrder = gateway.created.get(String(supportPix.payload.order_id));
    assert.equal(Number(supportGatewayOrder.total_amount), 8);
    assert.match(
      supportGatewayOrder.external_reference,
      /^omv2_[a-f0-9]{24}$/
    );
    assert.ok(supportPix.payload.pix_copia_cola);
    assert.ok(supportPix.payload.qr_code_base64);
    const supportOrderPath = orderPath(
      insufficientSupportUser,
      pendingSupport.pedido_id
    );
    const supportOrderAfterProvider = readJson(supportOrderPath, {});
    for (const field of [
      "mp_order_id",
      "mp_payment_id",
      "mp_order_status",
      "mp_payment_status",
      "mp_orders_v2_attempt_id",
      "pix_tentativa",
      "pix_copia_cola",
      "pix_qr_code_base64",
      "pix_ticket_url",
      "pix_gerado_em"
    ]) {
      delete supportOrderAfterProvider[field];
    }
    writeJson(supportOrderPath, supportOrderAfterProvider);
    const recoveredBindingPix = await generatePix(
      baseUrl,
      insufficientSupportUser,
      pendingSupport.pedido_id
    );
    assert.equal(recoveredBindingPix.response.status, 200);
    assert.equal(recoveredBindingPix.payload.order_id, supportPix.payload.order_id);
    assert.equal(
      readOrder(insufficientSupportUser, pendingSupport.pedido_id).pix_tentativa,
      1
    );

    const concurrentOrder = await createResult(
      baseUrl,
      pixConcurrentUser,
      "economica",
      "economic_pix_concurrent"
    );
    const [concurrentPixA, concurrentPixB] = await Promise.all([
      generatePix(baseUrl, pixConcurrentUser, concurrentOrder.pedido_id),
      generatePix(baseUrl, pixConcurrentUser, concurrentOrder.pedido_id)
    ]);
    assert.equal(concurrentPixA.response.status, 200);
    assert.equal(concurrentPixB.response.status, 200);
    assert.equal(
      concurrentPixA.payload.order_id,
      concurrentPixB.payload.order_id
    );
    assert.equal(
      readOrder(pixConcurrentUser, concurrentOrder.pedido_id).pix_tentativa,
      1
    );

    const historyGetCallsBefore = gateway.orderGetCalls;
    const pendingHistory = await api(baseUrl, "GET", "/meus-pedidos", {
      token: tokenFor(pixConcurrentUser)
    });
    assert.equal(pendingHistory.response.status, 200);
    assert.equal(gateway.orderGetCalls, historyGetCallsBefore);

    const autoPlayerOrder = await createResult(
      baseUrl,
      autoPlayerUser,
      "economica",
      "auto_player_recovery"
    );
    const autoPlayerPix = await generatePix(
      baseUrl,
      autoPlayerUser,
      autoPlayerOrder.pedido_id
    );
    assert.equal(autoPlayerPix.response.status, 200, JSON.stringify(autoPlayerPix.payload));
    const autoGatewayOrder = gateway.created.get(String(autoPlayerPix.payload.order_id));
    assert.equal(
      readOrder(autoPlayerUser, autoPlayerOrder.pedido_id).whatsapp,
      autoPlayerUser
    );
    gateway.approved.set(String(autoPlayerPix.payload.order_id), {
      ...autoGatewayOrder,
      status: "processed",
      transactions: {
        payments: [{
          ...autoGatewayOrder.transactions.payments[0],
          status: "processed",
          status_detail: "accredited"
        }]
      }
    });

    const sensitiveMarker = "SEGREDO-NAO-DEVE-SER-GRAVADO";
    const [autoWebhook, autoRecovery] = await Promise.all([
      webhook(baseUrl, autoPlayerPix.payload.order_id, "order", {
        access_token: sensitiveMarker
      }),
      api(
        baseUrl,
        "POST",
        `/pedidos/${autoPlayerOrder.pedido_id}/download-ticket`,
        {
          token: tokenFor(autoPlayerUser),
          body: { formato: "resultado" }
        }
      )
    ]);
    assert.equal(autoWebhook.response.status, 200);
    assert.ok([200, 403, 404].includes(autoRecovery.response.status));
    const autoPaidOrder = readOrder(autoPlayerUser, autoPlayerOrder.pedido_id);
    assert.equal(autoPaidOrder.pagamento_pendente, false);
    assert.notEqual(autoPaidOrder.aprovado_cliente, true);
    assert.equal(
      autoPaidOrder.mensagens_cliente.filter(item => item.tipo === "pagamento_confirmado").length,
      1
    );
    assert.equal(readJson(CLIENTES_FILE, {})[autoPlayerUser].saldo_extra, 4);

    const duplicateAutoWebhook = await webhook(
      baseUrl,
      autoPlayerPix.payload.order_id
    );
    assert.equal(duplicateAutoWebhook.response.status, 200);
    assert.equal(duplicateAutoWebhook.payload.liberados, 0);
    assert.equal(
      readOrder(autoPlayerUser, autoPlayerOrder.pedido_id)
        .mensagens_cliente.filter(item => item.tipo === "pagamento_confirmado").length,
      1
    );
    assert.equal(readJson(CLIENTES_FILE, {})[autoPlayerUser].saldo_extra, 4);
    const auditEventsText = fs.readFileSync(MP_ORDERS_V2_EVENTS_FILE, "utf8");
    assert.equal(auditEventsText.includes(sensitiveMarker), false);
    assert.equal(auditEventsText.includes("[redigido]"), true);

    const batchPixUser = "551100000011";
    putClient(batchPixUser, 50);
    const batchId = "economic_test_two_items_batch";
    const batchCreate = await api(baseUrl, "POST", "/me/time/jogos/criar-artes", {
      token: tokenFor(batchPixUser),
      form: doubleResultBatchForm({ mode: "economica", batchId })
    });
    assert.equal(batchCreate.response.status, 200, JSON.stringify(batchCreate.payload));
    assert.equal(batchCreate.payload.criados.length, 2);
    assert.ok(batchCreate.payload.criados.every(item => item.pagamento_pendente === true));
    assert.ok(batchCreate.payload.criados.every(item => item.valor_final === 4));
    assert.equal((await getMe(baseUrl, batchPixUser)).saldo, 50);

    const batchPix = await api(baseUrl, "POST", "/pedidos/gerar-pix-lote", {
      token: tokenFor(batchPixUser),
      body: { batch_id: batchId }
    });
    assert.equal(batchPix.response.status, 200, JSON.stringify(batchPix.payload));
    assert.equal(batchPix.payload.quantidade, 2);
    assert.equal(batchPix.payload.valor_final, 8);
    assert.equal(batchPix.payload.pedido_ids.length, 2);
    assert.ok(batchPix.payload.pix_copia_cola);
    const batchGatewayOrder = gateway.created.get(String(batchPix.payload.order_id));
    assert.equal(Number(batchGatewayOrder.total_amount), 8);
    assert.match(batchGatewayOrder.external_reference, /^omv2_[a-f0-9]{24}$/);
    const batchPixReplay = await api(baseUrl, "POST", "/pedidos/gerar-pix-lote", {
      token: tokenFor(batchPixUser),
      body: { batch_id: batchId }
    });
    assert.equal(batchPixReplay.payload.order_id, batchPix.payload.order_id);
    assert.equal(gateway.created.size > 0, true);

    gateway.approved.set(String(batchPix.payload.order_id), {
      ...batchGatewayOrder,
      status: "processed",
      transactions: {
        payments: [{
          ...batchGatewayOrder.transactions.payments[0],
          status: "processed",
          status_detail: "accredited"
        }]
      }
    });
    const batchWebhook = await webhook(baseUrl, batchPix.payload.order_id);
    assert.equal(batchWebhook.response.status, 200);
    assert.equal(batchWebhook.payload.liberados, 2);
    for (const item of batchCreate.payload.criados) {
      assert.equal(readOrder(batchPixUser, item.pedido_id).pagamento_pendente, false);
      assert.equal(readOrderStatus(batchPixUser, item.pedido_id), "novo");
    }

    const supportBatchUser = "551100000012";
    putClient(supportBatchUser, 50);
    const supportBatchId = "support_test_two_items_batch";
    const supportBatchCreate = await api(baseUrl, "POST", "/me/time/jogos/criar-artes", {
      token: tokenFor(supportBatchUser),
      form: doubleResultBatchForm({ mode: "com_suporte", batchId: supportBatchId })
    });
    assert.equal(supportBatchCreate.response.status, 200);
    assert.equal(supportBatchCreate.payload.criados.length, 2);
    assert.ok(supportBatchCreate.payload.criados.every(item => item.pagamento_pendente === true));
    const supportBatchPix = await api(baseUrl, "POST", "/pedidos/gerar-pix-lote", {
      token: tokenFor(supportBatchUser),
      body: { batch_id: supportBatchId }
    });
    assert.equal(supportBatchPix.response.status, 200, JSON.stringify(supportBatchPix.payload));
    assert.equal(supportBatchPix.payload.quantidade, 2);
    assert.equal(supportBatchPix.payload.valor_final, 16);
    assert.equal((await getMe(baseUrl, supportBatchUser)).saldo, 50);

    const economicPixUser = "551100000008";
    putClient(economicPixUser, 0);
    const economicPixOrder = await createResult(baseUrl, economicPixUser, "economica", "economic_pix_approved");
    const botToken = tokenFor("15991120599");
    const botBeforePayment = await api(baseUrl, "GET", "/bot/pedidos/novos", { token: botToken });
    assert.equal(botBeforePayment.response.status, 200);
    assert.equal(
      botBeforePayment.payload.pedidos.some(item => item.id === economicPixOrder.pedido_id),
      false
    );
    const pendingZip = await api(
      baseUrl,
      "GET",
      `/bot/pedidos/${economicPixOrder.pedido_id}/zip`,
      { token: botToken }
    );
    assert.equal(pendingZip.response.status, 403);
    const pendingStatusUpdate = await api(
      baseUrl,
      "POST",
      `/bot/pedidos/${economicPixOrder.pedido_id}/status`,
      { token: botToken, body: { status: "processando" } }
    );
    assert.equal(pendingStatusUpdate.response.status, 403);
    const pendingUploadForm = new FormData();
    pendingUploadForm.append("resultado", new Blob([tinyPng], { type: "image/png" }), "resultado_final.png");
    const pendingUpload = await api(
      baseUrl,
      "POST",
      `/bot/pedidos/${economicPixOrder.pedido_id}/upload-resultado`,
      { token: botToken, form: pendingUploadForm }
    );
    assert.equal(pendingUpload.response.status, 403);
    const economicPix = await generatePix(baseUrl, economicPixUser, economicPixOrder.pedido_id);
    assert.equal(economicPix.response.status, 200, JSON.stringify(economicPix.payload));
    assert.equal(economicPix.payload.valor_final, 4);
    assert.equal(economicPix.payload.modalidade_criacao, "economica");
    const economicGatewayOrder = gateway.created.get(String(economicPix.payload.order_id));
    assert.equal(Number(economicGatewayOrder.total_amount), 4);
    assert.match(
      economicGatewayOrder.external_reference,
      /^omv2_[a-f0-9]{24}$/
    );

    gateway.approved.set(String(economicPix.payload.order_id), {
      ...economicGatewayOrder,
      status: "processed",
      payer: {
        ...economicGatewayOrder.payer,
        first_name: "Cliente",
        last_name: "Teste",
        identification: { type: "CPF", number: "12345678901" }
      },
      transactions: {
        payments: [{
          ...economicGatewayOrder.transactions.payments[0],
          status: "processed",
          status_detail: "accredited"
        }]
      }
    });
    const approvedWebhook = await webhook(baseUrl, economicPix.payload.order_id);
    assert.equal(approvedWebhook.response.status, 200);
    const paidEconomicOrder = readOrder(economicPixUser, economicPixOrder.pedido_id);
    assert.equal(paidEconomicOrder.pagamento_pendente, false);
    assert.equal(paidEconomicOrder.modalidade_criacao, "economica");
    assert.equal(paidEconomicOrder.pagamento_info.valor_pago, 4);
    assert.equal(paidEconomicOrder.pagamento_info.modalidade_criacao, "economica");
    assert.equal(readOrderStatus(economicPixUser, economicPixOrder.pedido_id), "novo");

    const errorOrder = await createResult(baseUrl, pixErrorUser, "economica", "pix_error");
    gateway.failNextCreate = true;
    const failedPix = await generatePix(baseUrl, pixErrorUser, errorOrder.pedido_id);
    assert.equal(failedPix.response.status, 503);
    assert.equal(readOrder(pixErrorUser, errorOrder.pedido_id).pagamento_pendente, true);
    assert.equal(readOrder(pixErrorUser, errorOrder.pedido_id).mp_order_id, undefined);
    assert.equal(readOrder(pixErrorUser, errorOrder.pedido_id).mp_payment_id, undefined);

    const canceledOrder = await createResult(baseUrl, pixCanceledUser, "com_suporte", "pix_canceled");
    const canceledPix = await generatePix(baseUrl, pixCanceledUser, canceledOrder.pedido_id);
    const canceledGatewayOrder = gateway.created.get(String(canceledPix.payload.order_id));
    gateway.approved.set(String(canceledPix.payload.order_id), {
      ...canceledGatewayOrder,
      status: "cancelled",
      transactions: {
        payments: [{
          ...canceledGatewayOrder.transactions.payments[0],
          status: "cancelled"
        }]
      }
    });
    const invalidSignatureWebhook = await api(
      baseUrl,
      "POST",
      `/webhook/mercadopago?data.id=${encodeURIComponent(canceledPix.payload.order_id)}&type=order`,
      {
        headers: {
          "x-request-id": crypto.randomUUID(),
          "x-signature": `ts=${Date.now()},v1=${"0".repeat(64)}`
        },
        body: { type: "order", data: { id: canceledPix.payload.order_id } }
      }
    );
    assert.equal(invalidSignatureWebhook.response.status, 401);
    assert.equal(readOrder(pixCanceledUser, canceledOrder.pedido_id).pagamento_pendente, true);

    const canceledWebhook = await webhook(baseUrl, canceledPix.payload.order_id);
    assert.equal(canceledWebhook.response.status, 200);
    const canceledLocalOrder = readOrder(pixCanceledUser, canceledOrder.pedido_id);
    assert.equal(canceledLocalOrder.pagamento_pendente, true);
    assert.equal(canceledLocalOrder.mp_payment_status, "cancelled");

    const regeneratedPix = await generatePix(
      baseUrl,
      pixCanceledUser,
      canceledOrder.pedido_id
    );
    assert.equal(regeneratedPix.response.status, 200);
    assert.notEqual(regeneratedPix.payload.order_id, canceledPix.payload.order_id);
    assert.equal(
      Number(gateway.created.get(String(regeneratedPix.payload.order_id)).total_amount),
      8
    );
    assert.equal(
      readOrder(pixCanceledUser, canceledOrder.pedido_id).pix_tentativa,
      2
    );
    const regeneratedGatewayOrder = gateway.created.get(
      String(regeneratedPix.payload.order_id)
    );
    gateway.approved.set(String(regeneratedPix.payload.order_id), {
      ...regeneratedGatewayOrder,
      status: "expired",
      transactions: {
        payments: [{
          ...regeneratedGatewayOrder.transactions.payments[0],
          status: "expired"
        }]
      }
    });
    const expiredWebhook = await webhook(
      baseUrl,
      regeneratedPix.payload.order_id
    );
    assert.equal(expiredWebhook.response.status, 200);
    assert.equal(expiredWebhook.payload.terminal, true);
    const pixAfterExpired = await generatePix(
      baseUrl,
      pixCanceledUser,
      canceledOrder.pedido_id
    );
    assert.equal(pixAfterExpired.response.status, 200);
    assert.notEqual(
      pixAfterExpired.payload.order_id,
      regeneratedPix.payload.order_id
    );
    assert.equal(
      readOrder(pixCanceledUser, canceledOrder.pedido_id).pix_tentativa,
      3
    );

    const mismatchOrder = await createResult(baseUrl, pixMismatchUser, "economica", "pix_mismatch");
    const mismatchPix = await generatePix(baseUrl, pixMismatchUser, mismatchOrder.pedido_id);
    const mismatchGatewayOrder = gateway.created.get(String(mismatchPix.payload.order_id));
    gateway.approved.set(String(mismatchPix.payload.order_id), {
      ...mismatchGatewayOrder,
      status: "processed",
      total_amount: "8.00",
      transactions: {
        payments: [{
          ...mismatchGatewayOrder.transactions.payments[0],
          amount: "8.00",
          status: "processed",
          status_detail: "accredited"
        }]
      }
    });
    const mismatchWebhook = await webhook(baseUrl, mismatchPix.payload.order_id);
    assert.equal(mismatchWebhook.response.status, 200);
    assert.equal(mismatchWebhook.payload.rejeitado, true);
    assert.equal(readOrder(pixMismatchUser, mismatchOrder.pedido_id).pagamento_pendente, true);
    const mismatchLedger = readJson(MP_ORDERS_V2_FILE, {});
    const mismatchAttempt = mismatchLedger.attempts[
      mismatchLedger.by_order_id[String(mismatchPix.payload.order_id)]
    ];
    assert.equal(mismatchAttempt.state, "divergent");
    assert.equal(mismatchAttempt.divergence_reason, "valor_divergente");
    assert.equal(mismatchAttempt.divergence.valor_esperado, 4);
    assert.equal(mismatchAttempt.divergence.valor_order, 8);

    const currencyOrder = await createResult(
      baseUrl,
      currencyMismatchUser,
      "economica",
      "pix_currency_mismatch"
    );
    const currencyPix = await generatePix(
      baseUrl,
      currencyMismatchUser,
      currencyOrder.pedido_id
    );
    const currencyGatewayOrder = gateway.created.get(String(currencyPix.payload.order_id));
    gateway.approved.set(String(currencyPix.payload.order_id), {
      ...currencyGatewayOrder,
      status: "processed",
      transactions: {
        payments: [{
          ...currencyGatewayOrder.transactions.payments[0],
          currency_id: "USD",
          status: "processed",
          status_detail: "accredited"
        }]
      }
    });
    const currencyWebhook = await webhook(baseUrl, currencyPix.payload.order_id);
    assert.equal(currencyWebhook.response.status, 200);
    assert.equal(currencyWebhook.payload.rejeitado, true);
    assert.equal(currencyWebhook.payload.reason, "moeda_divergente");
    assert.equal(
      readOrder(currencyMismatchUser, currencyOrder.pedido_id).pagamento_pendente,
      true
    );

    const wrongOwnerOrder = await createResult(
      baseUrl,
      wrongOwnerUser,
      "economica",
      "wrong_owner"
    );
    const wrongOwnerPix = await generatePix(
      baseUrl,
      wrongOwnerUser,
      wrongOwnerOrder.pedido_id
    );
    const wrongOwnerGatewayOrder = gateway.created.get(String(wrongOwnerPix.payload.order_id));
    gateway.approved.set(String(wrongOwnerPix.payload.order_id), {
      ...wrongOwnerGatewayOrder,
      status: "processed",
      transactions: {
        payments: [{
          ...wrongOwnerGatewayOrder.transactions.payments[0],
          status: "processed",
          status_detail: "accredited"
        }]
      }
    });
    const ownerRejected = await __mpOrdersV2Test.processarOrderV2(
      wrongOwnerPix.payload.order_id,
      {
        source: "teste_proprietario_divergente",
        expectedOwnerId: autoPlayerUser,
        expectedPedidoId: wrongOwnerOrder.pedido_id
      }
    );
    assert.equal(ownerRejected.rejected, true);
    assert.equal(ownerRejected.reason, "proprietario_divergente");
    assert.equal(
      readOrder(wrongOwnerUser, wrongOwnerOrder.pedido_id).pagamento_pendente,
      true
    );

    const interruptedOrder = await createResult(
      baseUrl,
      interruptionUser,
      "economica",
      "processing_interruption"
    );
    const interruptedPix = await generatePix(
      baseUrl,
      interruptionUser,
      interruptedOrder.pedido_id
    );
    const interruptedGatewayOrder = gateway.created.get(String(interruptedPix.payload.order_id));
    gateway.approved.set(String(interruptedPix.payload.order_id), {
      ...interruptedGatewayOrder,
      status: "processed",
      transactions: {
        payments: [{
          ...interruptedGatewayOrder.transactions.payments[0],
          status: "processed",
          status_detail: "accredited"
        }]
      }
    });
    let interruptionInjected = false;
    __mpOrdersV2Test.setHooks({
      async afterCoreWrite() {
        if (!interruptionInjected) {
          interruptionInjected = true;
          throw new Error("interrupcao simulada");
        }
      }
    });
    const interruptedWebhook = await webhook(
      baseUrl,
      interruptedPix.payload.order_id
    );
    assert.equal(interruptedWebhook.response.status, 500);
    assert.equal(
      readOrder(interruptionUser, interruptedOrder.pedido_id).pagamento_pendente,
      false
    );
    __mpOrdersV2Test.resetHooks();
    const resumedWebhook = await webhook(
      baseUrl,
      interruptedPix.payload.order_id
    );
    assert.equal(resumedWebhook.response.status, 200);
    assert.equal(resumedWebhook.payload.confirmed, true);
    const resumedOrder = readOrder(interruptionUser, interruptedOrder.pedido_id);
    assert.equal(
      resumedOrder.mensagens_cliente.filter(item => item.tipo === "pagamento_confirmado").length,
      1
    );
    assert.equal(readJson(CLIENTES_FILE, {})[interruptionUser].saldo_extra, 4);

    gateway.nextGetMode = "unavailable";
    await assert.rejects(
      __mpOrdersV2Test.processarOrderV2(wrongOwnerPix.payload.order_id, {
        source: "teste_indisponibilidade",
        expectedOwnerId: wrongOwnerUser,
        expectedPedidoId: wrongOwnerOrder.pedido_id
      }),
      error => error?.code === "MP_UNAVAILABLE" && error?.retryable === true
    );
    gateway.nextGetMode = "slow";
    await assert.rejects(
      __mpOrdersV2Test.processarOrderV2(wrongOwnerPix.payload.order_id, {
        source: "teste_timeout",
        expectedOwnerId: wrongOwnerUser,
        expectedPedidoId: wrongOwnerOrder.pedido_id
      }),
      error => error?.code === "MP_TIMEOUT" && error?.retryable === true
    );
    assert.equal(
      readOrder(wrongOwnerUser, wrongOwnerOrder.pedido_id).pagamento_pendente,
      true
    );

    const invalidModeUser = "551100000009";
    putClient(invalidModeUser, 20);
    const invalidMode = await api(baseUrl, "POST", "/me/time/jogos/criar-artes", {
      token: tokenFor(invalidModeUser),
      form: resultBatchForm({
        mode: "economica_adulterada",
        requestId: "invalid_mode",
        batchId: "invalid_mode_batch"
      })
    });
    assert.equal(invalidMode.response.status, 400);
    assert.equal(invalidMode.payload.criados.length, 0);
    assert.match(invalidMode.payload.falhas[0].error, /Modalidade/);
    assert.equal((await getMe(baseUrl, invalidModeUser)).saldo, 20);

    const untouchedLegacyId = "legacy-order-untouched";
    const untouchedLegacy = createLegacyOrder(
      legacyUntouchedUser,
      untouchedLegacyId,
      {
        mp_order_id: "ORD-LEGACY-UNTOUCHED",
        mp_payment_id: "PAY-LEGACY-UNTOUCHED"
      }
    );
    const untouchedPath = path.join(untouchedLegacy.base, "pedido.json");
    const untouchedBefore = crypto
      .createHash("sha256")
      .update(fs.readFileSync(untouchedPath))
      .digest("hex");
    gateway.created.set("ORD-LEGACY-UNTOUCHED", {
      id: "ORD-LEGACY-UNTOUCHED",
      status: "action_required",
      country_code: "BRA",
      total_amount: "4.00",
      external_reference: "pedido_antigo_sem_vinculo_v2",
      transactions: {
        payments: [{
          id: "PAY-LEGACY-UNTOUCHED",
          amount: "4.00",
          status: "action_required",
          payment_method: { id: "pix", type: "bank_transfer" }
        }]
      }
    });
    const ignoredLegacyWebhook = await webhook(
      baseUrl,
      "ORD-LEGACY-UNTOUCHED"
    );
    assert.equal(ignoredLegacyWebhook.response.status, 200);
    assert.equal(ignoredLegacyWebhook.payload.ignored, true);
    const legacyGenerateAttempt = await generatePix(
      baseUrl,
      legacyUntouchedUser,
      untouchedLegacyId
    );
    assert.equal(legacyGenerateAttempt.response.status, 409);
    const untouchedAfter = crypto
      .createHash("sha256")
      .update(fs.readFileSync(untouchedPath))
      .digest("hex");
    assert.equal(untouchedAfter, untouchedBefore);

    const legacyBalancePaymentId = "900001";
    gateway.approved.set(legacyBalancePaymentId, {
      id: legacyBalancePaymentId,
      status: "approved",
      transaction_amount: 8,
      currency_id: "BRL",
      external_reference: `${legacyBalanceUser}|saldo_800|${Date.now()}`,
      metadata: {
        tipo: "saldo",
        whatsapp: legacyBalanceUser,
        pacote: "saldo_800",
        credito: 8
      },
      payer: { email: "saldo@example.test" }
    });
    const balanceWebhook = await webhook(
      baseUrl,
      legacyBalancePaymentId,
      "payment"
    );
    assert.equal(balanceWebhook.response.status, 200);
    assert.equal(readJson(CLIENTES_FILE, {})[legacyBalanceUser].saldo_extra, 8);
    const balanceDuplicate = await webhook(
      baseUrl,
      legacyBalancePaymentId,
      "payment"
    );
    assert.equal(balanceDuplicate.response.status, 200);
    assert.equal(balanceDuplicate.payload.duplicado, true);
    assert.equal(readJson(CLIENTES_FILE, {})[legacyBalanceUser].saldo_extra, 8);

    const legacyPaymentOrderId = "legacy-payment-order";
    const legacyPaymentId = "900002";
    createLegacyOrder(legacyPaymentsUser, legacyPaymentOrderId, {
      mp_payment_id: legacyPaymentId
    });
    gateway.approved.set(legacyPaymentId, {
      id: legacyPaymentId,
      status: "approved",
      transaction_amount: 4,
      currency_id: "BRL",
      external_reference:
        `pedido_pix|${legacyPaymentsUser}|${legacyPaymentOrderId}|resultado|economica`,
      metadata: {
        tipo: "pedido_pix",
        whatsapp: legacyPaymentsUser,
        pedido_id: legacyPaymentOrderId,
        modalidade_criacao: "economica"
      },
      payer: { email: "legacy@example.test" }
    });
    const legacyPaymentWebhook = await webhook(
      baseUrl,
      legacyPaymentId,
      "payment"
    );
    assert.equal(legacyPaymentWebhook.response.status, 200);
    assert.equal(
      readOrder(legacyPaymentsUser, legacyPaymentOrderId).pagamento_pendente,
      false
    );
    assert.equal(
      readOrder(legacyPaymentsUser, legacyPaymentOrderId).pagamento_info.payment_id,
      legacyPaymentId
    );

    const botOrders = await api(baseUrl, "GET", "/bot/pedidos/novos", { token: botToken });
    assert.equal(botOrders.response.status, 200);
    assert.ok(botOrders.payload.pedidos.some(item => item.id === economicPixOrder.pedido_id));

    const orderZip = await api(baseUrl, "GET", `/bot/pedidos/${economicPixOrder.pedido_id}/zip`, {
      token: botToken
    });
    assert.equal(orderZip.response.status, 200);
    assert.ok(Buffer.isBuffer(orderZip.payload));
    assert.ok(orderZip.payload.length > 100);

    const uploadForm = new FormData();
    uploadForm.append("descricao_instagram", "Descricao final do teste");
    uploadForm.append("resultado", new Blob([tinyPng], { type: "image/png" }), "resultado_final.png");
    uploadForm.append("preview", new Blob([tinyPng], { type: "image/png" }), "preview.png");
    const uploadResult = await api(
      baseUrl,
      "POST",
      `/bot/pedidos/${economicPixOrder.pedido_id}/upload-resultado`,
      { token: botToken, form: uploadForm }
    );
    assert.equal(uploadResult.response.status, 200, JSON.stringify(uploadResult.payload));

    const history = await api(baseUrl, "GET", "/meus-pedidos", {
      token: tokenFor(economicPixUser)
    });
    const historyOrder = history.payload.pedidos.find(item => item.id === economicPixOrder.pedido_id);
    assert.equal(historyOrder.valor_final, 4);
    assert.equal(historyOrder.modalidade_criacao, "economica");
    assert.equal(historyOrder.suporte_personalizado_incluido, false);
    assert.equal(historyOrder.pode_pedir_ajuste, false);
    assert.equal(historyOrder.imagem_pronta, true);

    const forbiddenAdjustment = await api(
      baseUrl,
      "POST",
      `/pedidos/${economicPixOrder.pedido_id}/solicitar-ajuste`,
      {
        token: tokenFor(economicPixUser),
        body: { motivo: "Quero alterar a imagem" }
      }
    );
    assert.equal(forbiddenAdjustment.response.status, 403);

    const approve = await api(baseUrl, "POST", `/pedidos/${economicPixOrder.pedido_id}/aprovar`, {
      token: tokenFor(economicPixUser)
    });
    assert.equal(approve.response.status, 200);

    const download = await api(
      baseUrl,
      "GET",
      `/pedidos/${economicPixOrder.pedido_id}/download-resultado`,
      { token: tokenFor(economicPixUser) }
    );
    assert.equal(download.response.status, 200);
    assert.ok(Buffer.isBuffer(download.payload));
    assert.ok(download.payload.length > 10);

    console.log(`OK - pagamentos no modo ${APP_MODE ? "app Android/TWA" : "navegador"}`);
    console.log("OK - compra de saldo por PIX e checkout aceita o app sem antecipar credito");
    console.log("OK - pagamentos exigem autenticacao e acesso ao proprio pedido");
    console.log("OK - assistente com suporte exige PIX de R$8 antes da criacao");
    console.log("OK - economico exige PIX antes da criacao e nao desconta saldo automaticamente");
    console.log("OK - repeticao idempotente nao duplica pedido, PIX nem desconto");
    console.log("OK - saldo insuficiente cria pagamento pendente e pagamento posterior registra extrato");
    console.log("OK - PIX suporte gera R$8 com QR Code e copia e cola");
    console.log("OK - PIX economico gera R$4 e so libera a fila apos webhook aprovado");
    console.log("OK - requisicoes PIX simultaneas reutilizam a mesma cobranca");
    console.log("OK - duas artes economicas geram um unico PIX de R$8 e liberam juntas");
    console.log("OK - duas artes com suporte geram um unico PIX de R$16 antes da criacao");
    console.log("OK - gateway com erro ou cancelamento nao libera pedido e permite novo PIX");
    console.log("OK - webhook com assinatura invalida e rejeitado antes do processamento");
    console.log("OK - webhook rejeita pagamento divergente de R$8 para pedido economico de R$4");
    console.log("OK - conta auto_jogador funciona com webhook e recuperacao simultaneos");
    console.log("OK - notificacao duplicada e Order ja processada nao duplicam efeitos");
    console.log("OK - interrupcao no processamento retoma sem duplicar bonus ou mensagem");
    console.log("OK - Order cancelada ou expirada permite gerar outro PIX");
    console.log("OK - valor, moeda e proprietario divergentes nao liberam o pedido");
    console.log("OK - falha, lentidao e indisponibilidade do Mercado Pago mantem o pedido pendente");
    console.log("OK - historico nao consulta o Mercado Pago");
    console.log("OK - pedido anterior ao V2 permanece byte a byte inalterado");
    console.log("OK - compra de saldo e pagamentos antigos via Payments permanecem idempotentes");
    console.log("OK - modalidade invalida e adulteracao de preco sao rejeitadas/ignoradas");
    console.log("OK - worker nao acessa pedido economico pendente e conclui apos pagamento");
    console.log("OK - historico grava R$4 e bloqueia ajuste personalizado");
  } finally {
    await new Promise(resolve => server.close(resolve));
  }
}

run()
  .catch(error => {
    console.error(error);
    process.exitCode = 1;
  })
  .finally(() => {
    global.fetch = nativeFetch;
    if (resolvedTemp.startsWith(resolvedOsTemp + path.sep)) {
      fs.rmSync(resolvedTemp, { recursive: true, force: true });
    }
  });
