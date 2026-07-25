const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const jwt = require("jsonwebtoken");

const MP_ACCESS_TOKEN = String(process.env.MP_ACCESS_TOKEN || "").trim();
if (!MP_ACCESS_TOKEN.startsWith("APP_USR-")) {
  throw new Error("Configure um Access Token de teste do Mercado Pago.");
}

const TEST_JWT_SECRET = "economic-creation-mp-sandbox-secret";
const TEST_DATA_DIR = fs.mkdtempSync(
  path.join(os.tmpdir(), "omascote-mp-sandbox-")
);
const resolvedTemp = path.resolve(TEST_DATA_DIR);
const resolvedOsTemp = path.resolve(os.tmpdir());

if (!resolvedTemp.startsWith(resolvedOsTemp + path.sep)) {
  throw new Error("Diretorio temporario fora da area segura.");
}

process.env.JWT_SECRET = TEST_JWT_SECRET;
process.env.OMASCOTE_DATA_DIR = TEST_DATA_DIR;
process.env.BOT_ADMIN_WHATSAPP = "15991120599";
process.env.PUBLIC_API_BASE_URL = "https://example.invalid/omascote-sandbox";
process.env.MP_SANDBOX_MODE = "true";

const { app } = require("./server");

const CLIENTES_FILE = path.join(TEST_DATA_DIR, "clientes.json");
const PEDIDOS_DIR = path.join(TEST_DATA_DIR, "pedidos");
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

function putClient(whatsapp) {
  const clientes = readJson(CLIENTES_FILE, {});
  clientes[whatsapp] = {
    id: whatsapp,
    cliente_id: whatsapp,
    whatsapp,
    nome_time: `Sandbox ${whatsapp}`,
    plano: "teste",
    ativo: true,
    saldo_extra: 0,
    saldo_mensal: 0,
    usados_no_ciclo: 0,
    ciclo_mes: currentMonth,
    brinde_mascote_disponivel: false,
    brinde_mascote_ja_liberado: true,
    brinde_escudo3d_app_usado: true
  };
  writeJson(CLIENTES_FILE, clientes);
}

function tokenFor(whatsapp) {
  return jwt.sign(
    { whatsapp, cliente_id: whatsapp },
    TEST_JWT_SECRET,
    { expiresIn: "1h" }
  );
}

async function localApi(baseUrl, method, endpoint, { token, body, form } = {}) {
  const headers = {};
  if (token) headers.Authorization = `Bearer ${token}`;
  if (body !== undefined) headers["Content-Type"] = "application/json";

  const response = await fetch(`${baseUrl}${endpoint}`, {
    method,
    headers,
    body: form || (body === undefined ? undefined : JSON.stringify(body))
  });
  const payload = await response.json();
  return { response, payload };
}

function resultBatchForm(mode, suffix) {
  const form = new FormData();
  form.append("batch_id", `mp_sandbox_batch_${suffix}`);
  form.append("items_json", JSON.stringify([{
    product_id: "resultado",
    client_request_id: `mp_sandbox_${suffix}`,
    modalidade_criacao: mode,
    fields: {
      flyer_tipo: "resultado",
      rodada: "Rodada Sandbox",
      data: "25/07/2026",
      hora: "20:00",
      time_principal: "Time A",
      time_adversario: "Time B",
      gols_time_principal: "2",
      gols_adversario: "1",
      observacao: "Teste oficial de Pix sandbox"
    },
    files: { escudo1: "item_0_escudo1" }
  }]));
  form.append(
    "item_0_escudo1",
    new Blob([tinyPng], { type: "image/png" }),
    "escudo.png"
  );
  return form;
}

async function createPendingOrder(baseUrl, whatsapp, mode, suffix) {
  const { response, payload } = await localApi(
    baseUrl,
    "POST",
    "/me/time/jogos/criar-artes",
    {
      token: tokenFor(whatsapp),
      form: resultBatchForm(mode, suffix)
    }
  );
  assert.equal(response.status, 200, JSON.stringify(payload));
  assert.equal(payload.criados.length, 1, JSON.stringify(payload));
  return payload.criados[0];
}

function orderPath(whatsapp, orderId) {
  const userRoot = path.join(PEDIDOS_DIR, whatsapp);
  for (const month of fs.readdirSync(userRoot)) {
    const candidate = path.join(userRoot, month, orderId, "pedido.json");
    if (fs.existsSync(candidate)) return candidate;
  }
  throw new Error(`Pedido ${orderId} nao encontrado.`);
}

async function mercadoPago(pathname, { method = "GET", body } = {}) {
  const response = await fetch(`https://api.mercadopago.com${pathname}`, {
    method,
    headers: {
      Authorization: `Bearer ${MP_ACCESS_TOKEN}`,
      "Content-Type": "application/json",
      "X-Idempotency-Key": crypto.randomUUID()
    },
    body: body === undefined ? undefined : JSON.stringify(body)
  });
  const payload = await response.json();
  return { response, payload };
}

async function assertGatewayOrder(orderId, expectedAmount) {
  const { response, payload } = await mercadoPago(
    `/v1/orders/${encodeURIComponent(orderId)}`
  );
  assert.equal(response.status, 200, JSON.stringify(payload));
  const payment = payload.transactions?.payments?.[0] || {};
  assert.equal(Number(payload.total_amount), expectedAmount);
  assert.equal(payload.country_code, "BRA");
  assert.equal(Number(payment.amount), expectedAmount);
  assert.equal(payment.payment_method?.id, "pix");
  assert.equal(payment.payment_method?.type, "bank_transfer");
  assert.ok(payment.payment_method?.qr_code);
  assert.ok(payment.payment_method?.qr_code_base64);
  return payload;
}

async function cancelGatewayOrder(orderId) {
  const { response, payload } = await mercadoPago(
    `/v1/orders/${encodeURIComponent(orderId)}/cancel`,
    { method: "POST", body: {} }
  );
  assert.equal(response.status, 200, JSON.stringify(payload));
  assert.ok(["cancelled", "canceled"].includes(String(payload.status)));
}

async function createOfficialSandboxOrder(amount) {
  const value = Number(amount).toFixed(2);
  const { response, payload } = await mercadoPago("/v1/orders", {
    method: "POST",
    body: {
      type: "online",
      processing_mode: "automatic",
      external_reference:
        `omascote_sandbox_${Math.round(Number(amount) * 100)}_${Date.now()}`,
      total_amount: value,
      payer: {
        email: "test_user_br@testuser.com",
        first_name: "APRO"
      },
      transactions: {
        payments: [{
          amount: value,
          payment_method: {
            id: "pix",
            type: "bank_transfer"
          }
        }]
      }
    }
  });
  assert.equal(response.status, 201, JSON.stringify(payload));
  assert.equal(Number(payload.total_amount), Number(amount));
  assert.ok(payload.transactions?.payments?.[0]?.payment_method?.qr_code);

  let latest = payload;
  for (let attempt = 0; attempt < 10; attempt += 1) {
    const payment = latest.transactions?.payments?.[0];
    if (
      latest.status === "processed" ||
      payment?.status === "processed" ||
      payment?.status === "approved"
    ) {
      return latest;
    }
    await new Promise(resolve => setTimeout(resolve, 1500));
    const lookup = await mercadoPago(
      `/v1/orders/${encodeURIComponent(payload.id)}`
    );
    assert.equal(lookup.response.status, 200, JSON.stringify(lookup.payload));
    latest = lookup.payload;
  }

  throw new Error(
    `Order PIX ${value} nao foi aprovada no prazo de sandbox: ` +
    `${latest.status}/${latest.transactions?.payments?.[0]?.status}`
  );
}

async function run() {
  const server = await new Promise(resolve => {
    const instance = app.listen(0, "127.0.0.1", () => resolve(instance));
  });
  const baseUrl = `http://127.0.0.1:${server.address().port}`;

  try {
    const supportUser = "551100000101";
    const economicUser = "551100000102";
    putClient(supportUser);
    putClient(economicUser);

    const supportOrder = await createPendingOrder(
      baseUrl,
      supportUser,
      "com_suporte",
      "support_8"
    );
    const economicOrder = await createPendingOrder(
      baseUrl,
      economicUser,
      "economica",
      "economic_4"
    );
    assert.equal(supportOrder.valor_final, 8);
    assert.equal(economicOrder.valor_final, 4);

    const supportPix = await localApi(
      baseUrl,
      "POST",
      `/pedidos/${supportOrder.pedido_id}/gerar-pix`,
      { token: tokenFor(supportUser) }
    );
    const economicPix = await localApi(
      baseUrl,
      "POST",
      `/pedidos/${economicOrder.pedido_id}/gerar-pix`,
      { token: tokenFor(economicUser) }
    );
    assert.equal(
      supportPix.response.status,
      200,
      JSON.stringify(supportPix.payload)
    );
    assert.equal(
      economicPix.response.status,
      200,
      JSON.stringify(economicPix.payload)
    );
    assert.equal(supportPix.payload.valor_final, 8);
    assert.equal(economicPix.payload.valor_final, 4);
    assert.ok(supportPix.payload.pix_copia_cola);
    assert.ok(economicPix.payload.pix_copia_cola);
    assert.ok(supportPix.payload.qr_code_base64);
    assert.ok(economicPix.payload.qr_code_base64);

    await assertGatewayOrder(supportPix.payload.order_id, 8);
    await assertGatewayOrder(economicPix.payload.order_id, 4);

    const replay = await localApi(
      baseUrl,
      "POST",
      `/pedidos/${economicOrder.pedido_id}/gerar-pix`,
      { token: tokenFor(economicUser) }
    );
    assert.equal(replay.response.status, 200, JSON.stringify(replay.payload));
    assert.equal(replay.payload.order_id, economicPix.payload.order_id);

    await cancelGatewayOrder(supportPix.payload.order_id);
    await cancelGatewayOrder(economicPix.payload.order_id);

    const cancelledWebhook = await localApi(
      baseUrl,
      "POST",
      "/webhook/mercadopago",
      {
        body: {
          type: "order",
          data: { id: economicPix.payload.order_id }
        }
      }
    );
    assert.equal(
      cancelledWebhook.response.status,
      200,
      JSON.stringify(cancelledWebhook.payload)
    );
    assert.equal(
      readJson(
        orderPath(economicUser, economicOrder.pedido_id),
        {}
      ).pagamento_pendente,
      true
    );
    assert.ok(
      ["canceled", "cancelled"].includes(
        readJson(
          orderPath(economicUser, economicOrder.pedido_id),
          {}
        ).mp_payment_status
      )
    );

    const regeneratedPix = await localApi(
      baseUrl,
      "POST",
      `/pedidos/${economicOrder.pedido_id}/gerar-pix`,
      { token: tokenFor(economicUser) }
    );
    assert.equal(
      regeneratedPix.response.status,
      200,
      JSON.stringify(regeneratedPix.payload)
    );
    assert.notEqual(
      regeneratedPix.payload.order_id,
      economicPix.payload.order_id
    );
    await assertGatewayOrder(regeneratedPix.payload.order_id, 4);
    await cancelGatewayOrder(regeneratedPix.payload.order_id);

    await createOfficialSandboxOrder(8);
    await createOfficialSandboxOrder(4);

    console.log("OK - rota real gera PIX sandbox de R$ 8 com QR e copia e cola");
    console.log("OK - rota real gera PIX sandbox de R$ 4 com QR e copia e cola");
    console.log("OK - Mercado Pago confirma valores, moeda e metodo PIX");
    console.log("OK - repeticao reutiliza a mesma cobranca sem duplicar PIX");
    console.log("OK - cancelamento real mantem o pedido pendente e permite gerar novo PIX");
    console.log("OK - Orders sandbox aprova PIX ficticio de R$ 8 e R$ 4");
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
    if (resolvedTemp.startsWith(resolvedOsTemp + path.sep)) {
      fs.rmSync(resolvedTemp, { recursive: true, force: true });
    }
  });
