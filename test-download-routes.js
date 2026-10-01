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
process.env.BOT_ADMIN_WHATSAPP = "admin-video";

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
  fs.writeFileSync(path.join(base, "preview_ia4tube.jpg"), Buffer.from([0xff, 0xd8, 0xff, 0xd9]));
  return base;
}

createOrder("cliente-1", "pedido-ok");
createOrder("cliente-1", "pedido-pendente", { pagamento_pendente: true });
createOrder("cliente-1", "pedido-nao-aprovado", { aprovado_cliente: false });
createOrder("cliente-1", "pedido-pix", {
  mp_payment_status: "approved",
  pagamento_info: { origem: "mercado_pago_pix" }
});
createOrder("cliente-1", "pedido-saldo", {
  pagamento_info: { origem: "saldo" }
});
const regularVideoBase = createOrder("cliente-1", "pedido-video-regular", {
  categoria: "proximo_jogo",
  video_generation: { requested: true, internal_test: true, model: "lite" }
});
const commercialVideoBase = createOrder("cliente-1", "pedido-video-comercial", {
  categoria: "resultado",
  video_generation: { requested: true, commercial: true, delivery_mode: "image_video", internal_test: false, model: "fast" }
});
const legacyPersonVideoBase = createOrder("cliente-1", "pedido-video-comercial-atleta", {
  categoria: "jogador_escudo",
  video_generation: { requested: true, commercial: true, delivery_mode: "image_video", internal_test: false, model: "fast" }
});
const adminVideoBase = createOrder("admin-video", "pedido-video-admin", {
  categoria: "proximo_jogo",
  video_generation: { requested: true, internal_test: true, model: "fast" }
});
const adminVideoUploadBase = createOrder("admin-video", "pedido-video-upload", {
  categoria: "proximo_jogo",
  video_generation: { requested: true, internal_test: true, model: "lite", status: "pending" }
});
const testMp4 = Buffer.from([0, 0, 0, 24, 0x66, 0x74, 0x79, 0x70, 0x69, 0x73, 0x6f, 0x6d]);
const omniVideoBase = createOrder("cliente-1", "pedido-video-omni", {
  categoria: "escudo3d",
  video_generation: { requested: true, commercial: true, delivery_mode: "image_video",
    model: "omni", model_id: "gemini-omni-1.1-flash-preview", duration_seconds: 10 }
});
fs.writeFileSync(path.join(omniVideoBase, "resultado_video.mp4"), testMp4);
fs.writeFileSync(path.join(regularVideoBase, "resultado_video.mp4"), testMp4);
fs.writeFileSync(path.join(commercialVideoBase, "resultado_video.mp4"), testMp4);
fs.writeFileSync(path.join(legacyPersonVideoBase, "resultado_video.mp4"), testMp4);
fs.writeFileSync(path.join(adminVideoBase, "resultado_video.mp4"), testMp4);
for (let index = 1; index <= 17; index += 1) {
  createOrder("cliente-1", `pedido-historico-${String(index).padStart(2, "0")}`, {
    criado_em: new Date(Date.UTC(2026, 0, index)).toISOString()
  });
}
writeJson(path.join(testDataDir, "clientes.json"), {
  "cliente-1": { nome_time: "Cliente de teste" },
  "admin-video": { nome_time: "Conta interna" }
});

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

  const issueHttps = (orderId, formato = "resultado", userId = "cliente-1") => fetch(
    `${baseUrl}/pedidos/${orderId}/download-ticket`, {
      method: "POST", headers: { "Content-Type": "application/json", ...(userId ? { Authorization: bearer(userId) } : {}) },
      body: JSON.stringify({ formato, transporte: "https" })
    }
  );
  for (const [orderId, userId, expected] of [
    ["pedido-ok", null, 401], ["pedido-ok", "outro-cliente", 404],
    ["pedido-pendente", "cliente-1", 403], ["pedido-nao-aprovado", "cliente-1", 403]
  ]) {
    const denied = await issueHttps(orderId, "resultado", userId);
    assert.equal(denied.status, expected);
    await denied.arrayBuffer();
  }
  const nativeReply = await issueHttps("pedido-ok");
  assert.equal(nativeReply.status, 200);
  assert.match(nativeReply.headers.get("cache-control"), /no-store/);
  const native = await nativeReply.json();
  assert.equal(native.transporte, "https");
  assert.equal(native.expires_in, 300);
  assert.equal(native.ticket, undefined);
  const nativeUrl = `${baseUrl}${native.download_path}`;
  const nativePedidoPath = path.join(testDataDir, "pedidos", "cliente-1", "2026-07", "pedido-ok", "pedido.json");
  const beforeHead = fs.readFileSync(nativePedidoPath, "utf8");
  const head = await fetch(nativeUrl, { method: "HEAD" });
  assert.equal(head.status, 200);
  assert.equal(fs.readFileSync(nativePedidoPath, "utf8"), beforeHead);
  for (let i = 0; i < 2; i++) {
    const downloaded = await fetch(nativeUrl);
    assert.equal(downloaded.status, 200);
    assert.match(downloaded.headers.get("content-disposition"), /^attachment;/);
    assert.match(downloaded.headers.get("cache-control"), /no-store/);
    assert.equal(downloaded.headers.get("referrer-policy"), "no-referrer");
    assert.deepEqual(Buffer.from(await downloaded.arrayBuffer()), fs.readFileSync(path.join(path.dirname(nativePedidoPath), "resultado_final.png")));
  }
  for (const badUrl of [
    nativeUrl.replace("pedido-ok", "pedido-pendente"), nativeUrl.replace("/resultado?", "/video?"),
    nativeUrl.replace(/chave=.*/, "chave=invalida"), nativeUrl.split("?")[0]
  ]) {
    const denied = await fetch(badUrl);
    assert.equal(denied.status, 403);
    await denied.arrayBuffer();
  }
  const changedOrder = JSON.parse(fs.readFileSync(nativePedidoPath));
  writeJson(nativePedidoPath, { ...changedOrder, pagamento_pendente: true });
  const revoked = await fetch(nativeUrl);
  assert.equal(revoked.status, 403, "revalidate paid state after issuing link");
  await revoked.arrayBuffer();
  writeJson(nativePedidoPath, changedOrder);
  const nativeVideoDenied = await issueHttps("pedido-video-regular", "video");
  assert.equal(nativeVideoDenied.status, 403);
  const videoNative = await (await issueHttps("pedido-video-comercial", "video")).json();
  const videoUrl = `${baseUrl}${videoNative.download_path}`;
  for (const [range, expected] of [["bytes=0-3", testMp4.subarray(0, 4)], ["bytes=4-", testMp4.subarray(4)]]) {
    const partial = await fetch(videoUrl, { headers: { Range: range } });
    assert.equal(partial.status, 206);
    assert.equal(partial.headers.get("accept-ranges"), "bytes");
    assert.deepEqual(Buffer.from(await partial.arrayBuffer()), expected);
  }
  const nativeFullVideo = await fetch(videoUrl);
  assert.equal(nativeFullVideo.status, 200);
  assert.deepEqual(Buffer.from(await nativeFullVideo.arrayBuffer()), testMp4);
  process.env.DOWNLOAD_HTTPS_ENABLED = "false";
  const disabled = await issueHttps("pedido-ok");
  assert.ok((await disabled.json()).ticket, "kill switch preserves legacy POST tickets");
  const disabledGet = await fetch(nativeUrl);
  assert.equal(disabledGet.status, 403);
  await disabledGet.arrayBuffer();
  delete process.env.DOWNLOAD_HTTPS_ENABLED;

  const viewPedidoPath = path.join(testDataDir, "pedidos", "cliente-1", "2026-07", "pedido-ok", "pedido.json");
  const beforeView = fs.readFileSync(viewPedidoPath, "utf8");
  const imageView = await fetch(`${baseUrl}/pedidos/pedido-ok/download-resultado?visualizacao=1`, {
    headers: { Authorization: bearer("cliente-1") }
  });
  assert.equal(imageView.status, 200);
  assert.match(imageView.headers.get("content-disposition"), /^inline;/);
  assert.match(imageView.headers.get("cache-control"), /no-store/);
  assert.equal(imageView.headers.get("x-omascote-image-view"), "1");
  assert.equal(fs.readFileSync(viewPedidoPath, "utf8"), beforeView, "visualizar não registra download");
  assert.deepEqual(Buffer.from(await imageView.arrayBuffer()), fs.readFileSync(path.join(path.dirname(viewPedidoPath), "resultado_final.png")));
  for (const [orderId, userId, expected] of [
    ["pedido-ok", null, 401], ["pedido-ok", "outro-cliente", 404],
    ["pedido-pendente", "cliente-1", 403], ["pedido-nao-aprovado", "cliente-1", 403]
  ]) {
    const viewDenied = await fetch(`${baseUrl}/pedidos/${orderId}/download-resultado?visualizacao=1`, {
      headers: userId ? { Authorization: bearer(userId) } : {}
    });
    assert.equal(viewDenied.status, expected);
    await viewDenied.arrayBuffer();
  }

  const noLogin = await fetch(`${baseUrl}/pedidos/pedido-ok/download-ticket`, {
    method: "POST"
  });
  assert.equal(noLogin.status, 401);

  const historyResponse = await fetch(`${baseUrl}/meus-pedidos`, {
    headers: { Authorization: bearer("cliente-1") }
  });
  const historyData = await jsonResponse(historyResponse);
  assert.equal(historyResponse.status, 200);
  assert.ok(historyData.pedidos.length > 15);
  assert.ok(historyData.pedidos.some(item => item.id === "pedido-historico-01"));
  assert.equal(historyData.pedidos.find(item => item.id === "pedido-video-regular")?.video_pronto, false);
  assert.equal(historyData.pedidos.find(item => item.id === "pedido-video-comercial")?.video_pronto, true);
  assert.equal(historyData.pedidos.find(item => item.id === "pedido-video-comercial-atleta")?.video_pronto, true);

  const regularMeResponse = await fetch(`${baseUrl}/me`, {
    headers: { Authorization: bearer("cliente-1") }
  });
  const regularMe = await jsonResponse(regularMeResponse);
  assert.equal(regularMe.internal_features?.next_match_veo, false);

  const adminMeResponse = await fetch(`${baseUrl}/me`, {
    headers: { Authorization: bearer("admin-video") }
  });
  const adminMe = await jsonResponse(adminMeResponse);
  assert.equal(adminMe.internal_features?.next_match_veo, true);
  assert.deepEqual(adminMe.internal_features?.veo_models?.map(item => item.key), ["lite", "fast"]);

  const uploadForm = new FormData();
  uploadForm.append("resultado", new Blob([fs.readFileSync(path.join(adminVideoUploadBase, "resultado_final.png"))], { type: "image/png" }), "resultado_final.png");
  uploadForm.append("video", new Blob([testMp4], { type: "video/mp4" }), "resultado_video.mp4");
  uploadForm.append("video_status", "ready");
  const videoUploadResponse = await fetch(`${baseUrl}/bot/pedidos/pedido-video-upload/upload-resultado`, {
    method: "POST",
    headers: { Authorization: bearer("admin-video") },
    body: uploadForm
  });
  const videoUpload = await jsonResponse(videoUploadResponse);
  assert.equal(videoUploadResponse.status, 200);
  assert.equal(videoUpload.video, "resultado_video.mp4");
  assert.equal(fs.existsSync(path.join(adminVideoUploadBase, "resultado_video.mp4")), true);
  assert.equal(JSON.parse(fs.readFileSync(path.join(adminVideoUploadBase, "pedido.json"), "utf8")).video_generation.status, "ready");

  const regularVideoTicket = await fetch(`${baseUrl}/pedidos/pedido-video-regular/download-ticket`, {
    method: "POST",
    headers: { Authorization: bearer("cliente-1"), "Content-Type": "application/json" },
    body: JSON.stringify({ formato: "video" })
  });
  assert.equal(regularVideoTicket.status, 403);

  const commercialVideoTicketResponse = await fetch(`${baseUrl}/pedidos/pedido-video-comercial/download-ticket`, {
    method: "POST",
    headers: { Authorization: bearer("cliente-1"), "Content-Type": "application/json" },
    body: JSON.stringify({ formato: "video" })
  });
  assert.equal(commercialVideoTicketResponse.status, 200);
  const commercialVideoTicket = await jsonResponse(commercialVideoTicketResponse);
  const commercialVideoDownload = await fetch(`${baseUrl}${commercialVideoTicket.download_path}`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ ticket: commercialVideoTicket.ticket })
  });
  assert.equal(commercialVideoDownload.status, 200);
  assert.equal(commercialVideoDownload.headers.get("content-type"), "video/mp4");
  assert.equal(commercialVideoTicket.video_duration_seconds, 8);

  for (const transporte of ["https", "legacy"]) {
    const ticketResponse = await fetch(`${baseUrl}/pedidos/pedido-video-omni/download-ticket`, {
      method: "POST", headers: { Authorization: bearer("cliente-1"), "Content-Type": "application/json" },
      body: JSON.stringify({ formato: "video", transporte })
    });
    assert.equal(ticketResponse.status, 200);
    const ticket = await jsonResponse(ticketResponse);
    assert.equal(ticket.video_duration_seconds, 10);
    const downloaded = await fetch(`${baseUrl}${ticket.download_path}`, transporte === "https" ? {} : {
      method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ ticket: ticket.ticket })
    });
    assert.equal(downloaded.status, 200);
    assert.match(downloaded.headers.get("content-disposition"), /video_10s\.mp4/);
    assert.equal(downloaded.headers.get("content-type"), "video/mp4");
    assert.deepEqual(Buffer.from(await downloaded.arrayBuffer()), testMp4);
  }

  const legacyPersonVideoTicketResponse = await fetch(`${baseUrl}/pedidos/pedido-video-comercial-atleta/download-ticket`, {
    method: "POST",
    headers: { Authorization: bearer("cliente-1"), "Content-Type": "application/json" },
    body: JSON.stringify({ formato: "video" })
  });
  assert.equal(legacyPersonVideoTicketResponse.status, 200);

  const adminHistoryResponse = await fetch(`${baseUrl}/meus-pedidos`, {
    headers: { Authorization: bearer("admin-video") }
  });
  const adminHistory = await jsonResponse(adminHistoryResponse);
  assert.equal(adminHistory.pedidos.find(item => item.id === "pedido-video-admin")?.video_pronto, true);

  const adminVideoTicketResponse = await fetch(`${baseUrl}/pedidos/pedido-video-admin/download-ticket`, {
    method: "POST",
    headers: { Authorization: bearer("admin-video"), "Content-Type": "application/json" },
    body: JSON.stringify({ formato: "video" })
  });
  assert.equal(adminVideoTicketResponse.status, 200);
  const adminVideoTicket = await jsonResponse(adminVideoTicketResponse);
  const adminVideoDownload = await fetch(`${baseUrl}${adminVideoTicket.download_path}`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ ticket: adminVideoTicket.ticket })
  });
  assert.equal(adminVideoDownload.status, 200);
  assert.equal(adminVideoDownload.headers.get("content-type"), "video/mp4");

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

  const publicPreview = await fetch(`${baseUrl}/pedidos/pedido-ok/preview`);
  assert.equal(publicPreview.status, 200);
  assert.match(publicPreview.headers.get("content-type"), /^image\/jpeg/);

  for (const orderId of ["pedido-pix", "pedido-saldo"]) {
    const paidTicketResponse = await fetch(`${baseUrl}/pedidos/${orderId}/download-ticket`, {
      method: "POST",
      headers: { Authorization: bearer("cliente-1"), "Content-Type": "application/json" },
      body: "{}"
    });
    assert.equal(paidTicketResponse.status, 200);
  }

  const approvalResponse = await fetch(`${baseUrl}/pedidos/pedido-nao-aprovado/aprovar`, {
    method: "POST",
    headers: { Authorization: bearer("cliente-1"), "Content-Type": "application/json" },
    body: "{}"
  });
  assert.equal(approvalResponse.status, 200);
  const afterApprovalTicket = await fetch(
    `${baseUrl}/pedidos/pedido-nao-aprovado/download-ticket`,
    {
      method: "POST",
      headers: { Authorization: bearer("cliente-1"), "Content-Type": "application/json" },
      body: "{}"
    }
  );
  assert.equal(afterApprovalTicket.status, 200);

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
