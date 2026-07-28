const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const jwt = require("jsonwebtoken");

const testDataDir = fs.mkdtempSync(path.join(os.tmpdir(), "omascote-download-test-"));
process.env.OMASCOTE_DATA_DIR = testDataDir;
process.env.JWT_SECRET = "download-route-test-secret";
process.env.NODE_ENV = "test";

function writeJson(filePath, value) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, JSON.stringify(value, null, 2), "utf8");
}

function createOrder(userId, orderId, pedido = {}) {
  const base = path.join(testDataDir, "pedidos", userId, "2026-07", orderId);
  fs.mkdirSync(base, { recursive: true });
  writeJson(path.join(base, "pedido.json"), {
    aprovado_cliente: true,
    pagamento_pendente: false,
    ...pedido
  });
  fs.writeFileSync(path.join(base, "resultado_final.png"), Buffer.from(
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Y9Z7N0AAAAASUVORK5CYII=",
    "base64"
  ));
  return base;
}

createOrder("cliente-1", "pedido-ok");
createOrder("cliente-1", "pedido-pendente", { pagamento_pendente: true });
createOrder("cliente-1", "pedido-nao-aprovado", { aprovado_cliente: false });

const cartaImagePath = path.join(testDataDir, "cartas_app_imagens", "carta-1.jpg");
fs.mkdirSync(path.dirname(cartaImagePath), { recursive: true });
fs.writeFileSync(cartaImagePath, Buffer.from([0xff, 0xd8, 0xff, 0xd9]));
writeJson(path.join(testDataDir, "cartas_app.json"), [{
  id: "carta-1",
  ativo: true,
  somente_app: true,
  imagem_path: "cartas_app_imagens/carta-1.jpg",
  publico: { todos: false, clientes_ids: ["cliente-1"] }
}]);

const { app } = require("./server");

function bearer(userId) {
  return `Bearer ${jwt.sign({ whatsapp: userId }, process.env.JWT_SECRET, { expiresIn: "5m" })}`;
}

async function jsonResponse(response) {
  return response.json().catch(() => ({}));
}

test("secure direct download routes enforce ownership, state, binding and one-time use", async t => {
  const server = app.listen(0, "127.0.0.1");
  await new Promise((resolve, reject) => {
    server.once("listening", resolve);
    server.once("error", reject);
  });

  t.after(async () => {
    await new Promise(resolve => server.close(resolve));
    fs.rmSync(testDataDir, { recursive: true, force: true });
  });

  const address = server.address();
  const baseUrl = `http://127.0.0.1:${address.port}`;

  const noLogin = await fetch(`${baseUrl}/pedidos/pedido-ok/download-ticket`, {
    method: "POST"
  });
  assert.equal(noLogin.status, 401);

  const otherUser = await fetch(`${baseUrl}/pedidos/pedido-ok/download-ticket`, {
    method: "POST",
    headers: { Authorization: bearer("cliente-2"), "Content-Type": "application/json" },
    body: "{}"
  });
  assert.equal(otherUser.status, 404);

  for (const [orderId, expectedStatus] of [
    ["pedido-pendente", 403],
    ["pedido-nao-aprovado", 403],
    ["pedido-inexistente", 404]
  ]) {
    const response = await fetch(`${baseUrl}/pedidos/${orderId}/download-ticket`, {
      method: "POST",
      headers: { Authorization: bearer("cliente-1"), "Content-Type": "application/json" },
      body: "{}"
    });
    assert.equal(response.status, expectedStatus);
  }

  const ticketResponse = await fetch(`${baseUrl}/pedidos/pedido-ok/download-ticket`, {
    method: "POST",
    headers: { Authorization: bearer("cliente-1"), "Content-Type": "application/json" },
    body: "{}"
  });
  assert.equal(ticketResponse.status, 200);
  const ticketData = await jsonResponse(ticketResponse);
  assert.equal(ticketData.ok, true);
  assert.ok(ticketData.ticket);
  assert.equal(ticketData.download_path, "/pedidos/pedido-ok/download-direto/resultado");

  const changedId = await fetch(`${baseUrl}/pedidos/outro-id/download-direto/resultado`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ ticket: ticketData.ticket })
  });
  assert.equal(changedId.status, 403);

  const downloaded = await fetch(`${baseUrl}${ticketData.download_path}`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ ticket: ticketData.ticket })
  });
  const downloadedBytes = Buffer.from(await downloaded.arrayBuffer());
  assert.equal(downloaded.status, 200);
  assert.equal(downloaded.headers.get("content-type"), "image/png");
  assert.match(downloaded.headers.get("content-disposition"), /^attachment;/);
  assert.ok(downloadedBytes.length > 0);

  const reused = await fetch(`${baseUrl}${ticketData.download_path}`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ ticket: ticketData.ticket })
  });
  assert.equal(reused.status, 410);

  const oldPublicRoute = await fetch(`${baseUrl}/pedidos/pedido-ok/download-resultado`);
  assert.equal(oldPublicRoute.status, 401);

  const zipTicketResponse = await fetch(`${baseUrl}/pedidos/pedido-ok/download-ticket`, {
    method: "POST",
    headers: { Authorization: bearer("cliente-1"), "Content-Type": "application/json" },
    body: JSON.stringify({ formato: "zip" })
  });
  const zipTicket = await jsonResponse(zipTicketResponse);
  const zipDownload = await fetch(`${baseUrl}${zipTicket.download_path}`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ ticket: zipTicket.ticket })
  });
  const zipBytes = Buffer.from(await zipDownload.arrayBuffer());
  assert.equal(zipDownload.status, 200);
  assert.equal(zipDownload.headers.get("content-type"), "application/zip");
  assert.equal(zipBytes.subarray(0, 2).toString("ascii"), "PK");

  const blockedCarta = await fetch(`${baseUrl}/cartas-app/carta-1/download-ticket`, {
    method: "POST",
    headers: { Authorization: bearer("cliente-2"), "Content-Type": "application/json" },
    body: "{}"
  });
  assert.equal(blockedCarta.status, 404);

  const cartaTicketResponse = await fetch(`${baseUrl}/cartas-app/carta-1/download-ticket`, {
    method: "POST",
    headers: { Authorization: bearer("cliente-1"), "Content-Type": "application/json" },
    body: "{}"
  });
  const cartaTicket = await jsonResponse(cartaTicketResponse);
  const cartaDownload = await fetch(`${baseUrl}${cartaTicket.download_path}`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ ticket: cartaTicket.ticket })
  });
  assert.equal(cartaDownload.status, 200);
  assert.equal(cartaDownload.headers.get("content-type"), "image/jpeg");
  assert.match(cartaDownload.headers.get("content-disposition"), /carta-1_omascote\.jpg/);
});
