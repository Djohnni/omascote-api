const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const jwt = require("jsonwebtoken");

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "omascote-art-reviews-"));
process.env.OMASCOTE_DATA_DIR = dataDir;
process.env.JWT_SECRET = "art-reviews-local-test-secret";
process.env.NODE_ENV = "test";

const pedidoId = "pedido-avaliacao-1";
const pedidoBase = path.join(dataDir, "pedidos", "cliente-1", "2026-09", pedidoId);
fs.mkdirSync(pedidoBase, { recursive: true });
fs.writeFileSync(path.join(pedidoBase, "pedido.json"), JSON.stringify({
  aprovado_cliente: true,
  pagamento_pendente: false,
  categoria: "resultado",
  video_generation: { requested: true, commercial: true, delivery_mode: "image_video" }
}));
fs.writeFileSync(path.join(pedidoBase, "resultado_final.png"), Buffer.from("imagem de teste"));
fs.writeFileSync(path.join(pedidoBase, "resultado_video.mp4"), Buffer.from("video de teste"));
fs.writeFileSync(path.join(dataDir, "clientes.json"), JSON.stringify({ "cliente-1": {}, "cliente-2": {} }));

const { app } = require("./server");
const bearer = cliente => `Bearer ${jwt.sign({ whatsapp: cliente }, process.env.JWT_SECRET, { expiresIn: "5m" })}`;

test("avaliações públicas exigem download real e não expõem dados privados", async t => {
  const server = app.listen(0, "127.0.0.1");
  await new Promise(resolve => server.once("listening", resolve));
  t.after(async () => {
    await new Promise(resolve => server.close(resolve));
    fs.rmSync(dataDir, { recursive: true, force: true });
  });
  const base = `http://127.0.0.1:${server.address().port}`;
  const reviewPath = `${base}/pedidos/${pedidoId}/avaliacao-arte`;
  const postReview = (cliente, tipo, comentario = "Gostei muito da arte entregue.") => fetch(reviewPath, {
    method: "POST",
    headers: { Authorization: bearer(cliente), "Content-Type": "application/json" },
    body: JSON.stringify({ tipo, nome: "Equipe Azul", comentario, publicar: true })
  });
  const download = async formato => {
    const ticketResponse = await fetch(`${base}/pedidos/${pedidoId}/download-ticket`, {
      method: "POST",
      headers: { Authorization: bearer("cliente-1"), "Content-Type": "application/json" },
      body: JSON.stringify({ formato })
    });
    assert.equal(ticketResponse.status, 200);
    const ticket = await ticketResponse.json();
    const response = await fetch(`${base}${ticket.download_path}`, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ ticket: ticket.ticket })
    });
    assert.equal(response.status, 200);
    await response.arrayBuffer();
  };

  assert.equal((await postReview("cliente-1", "imagem")).status, 403, "não aceita comentário antes do download");
  await download("resultado");
  assert.equal((await postReview("cliente-1", "vídeo")).status, 403, "imagem baixada não libera avaliação do vídeo");
  assert.equal((await postReview("cliente-2", "imagem")).status, 404, "outra conta não avalia o pedido");

  const posted = await postReview("cliente-1", "imagem");
  assert.equal(posted.status, 200);
  const first = (await posted.json()).avaliacao;
  assert.equal(first.minha, true);
  assert.equal((await postReview("cliente-1", "imagem", "A segunda versão ficou ainda melhor.")).status, 200);

  await download("video");
  assert.equal((await postReview("cliente-1", "vídeo", "O vídeo ficou muito bom também.")).status, 200);

  const publicResponse = await fetch(`${base}/avaliacoes-artes`);
  assert.equal(publicResponse.status, 200);
  const publicData = await publicResponse.json();
  assert.equal(publicData.total, 2, "a reavaliação atualiza sem duplicar");
  assert.equal(publicData.avaliacoes.some(item => item.comentario === "A segunda versão ficou ainda melhor."), true);
  assert.equal(JSON.stringify(publicData).includes("cliente-1"), false, "não expõe identificador da conta");
  assert.equal(JSON.stringify(publicData).includes(pedidoId), false, "não expõe identificador do pedido");

  assert.equal((await fetch(`${base}/avaliacoes-artes/${first.id}`, {
    method: "DELETE", headers: { Authorization: bearer("cliente-2") }
  })).status, 404, "outra conta não exclui o comentário");
  assert.equal((await fetch(`${base}/avaliacoes-artes/${first.id}`, {
    method: "DELETE", headers: { Authorization: bearer("cliente-1") }
  })).status, 200);
  assert.equal((await (await fetch(`${base}/avaliacoes-artes`)).json()).total, 1);
});
