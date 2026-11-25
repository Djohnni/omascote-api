const fs = require("node:fs");
const path = require("node:path");
const { createHash, randomUUID } = require("node:crypto");
const image = require("./image");

const executor = "openai_jogador_escudo_v1";
const activationFile = dir => path.join(dir, executor + ".verified");
const owns = order => order?.image_executor === executor && order.categoria === "jogador_escudo";
const revision = order => order.ajuste_solicitado_em || "original";
const readyStates = new Set(["novo", "ajuste_pendente", "em_producao"]);

function replace(file, data) {
  const temp = file + "." + randomUUID() + ".tmp";
  try {
    fs.writeFileSync(temp, data);
    fs.renameSync(temp, file);
  } finally {
    fs.rmSync(temp, { force: true });
  }
}

function createQueue({ dir, readOrder, writeOrder, readStatus, writeStatus, authorize, onFailure, renderer = image }) {
  let running = false;
  function enqueue(base, order) {
    if (!owns(order) || order.image_delivered_revision === revision(order)) return;
    const job = { base, rev: revision(order), phase: "queued" };
    const key = createHash("sha256").update(JSON.stringify([base, job.rev])).digest("hex");
    const file = path.join(dir, key + ".json");
    fs.mkdirSync(dir, { recursive: true });
    if (!fs.existsSync(file)) replace(file, JSON.stringify(job));
  }

  async function processJob(file) {
    const job = JSON.parse(fs.readFileSync(file, "utf8"));
    const { base, rev } = job;
    const raw = file + ".image";
    function finish() {
      fs.rmSync(raw, { force: true });
      fs.rmSync(file, { force: true });
    }
    function savePhase(phase) {
      job.phase = phase;
      replace(file, JSON.stringify(job));
    }
    let order = readOrder(base);
    if (!owns(order) || revision(order) !== rev) return finish();
    if (order.image_delivered_revision === rev) {
      if (readyStates.has(readStatus(base))) writeStatus(base, "pronto");
      return finish();
    }
    if (job.phase === "failed") {
      await onFailure(base, order, job.reason);
      return finish();
    }
    async function authorized() {
      const current = readOrder(base);
      if (!owns(current) || revision(current) !== rev || !readyStates.has(readStatus(base))) return false;
      const permission = await authorize(base, current);
      if (!permission.ok && !permission.temporary && !permission.waiting) finish();
      return permission.ok;
    }
    if (!await authorized()) return;
    try {
      if (!fs.existsSync(raw)) {
        if (job.phase === "submitted") throw new Error("openai_resposta_interrompida");
        const form = await renderer.prepare(base, order);
        if (!await authorized()) return;
        writeStatus(base, "em_producao");
        // A crash after submission cannot safely be retried as a new paid edit.
        savePhase("submitted");
        replace(raw, await renderer.generate(form));
      }
      const { result, preview } = await renderer.makeOutputs(fs.readFileSync(raw));
      if (!await authorized()) return;
      order = readOrder(base);
      replace(path.join(base, "preview_ia4tube.jpg"), preview);
      replace(path.join(base, "resultado_final.png"), result);
      writeOrder(base, { ...order, status: "pronto", aprovado_cliente: false, baixado_cliente: false,
        image_delivered_revision: rev, resultado_enviado_em: new Date().toISOString(),
        descricao_instagram: order.descricao_instagram || String(order.fields?.player_name || order.data || "") });
      writeStatus(base, "pronto");
      fs.rmSync(path.join(base, "ajuste_pendente.txt"), { force: true });
      finish();
    } catch (error) {
      if (readOrder(base)?.image_delivered_revision === rev) return;
      if (fs.existsSync(raw) && error.code && ["ENOSPC", "EIO", "EBUSY","EPERM"].includes(error.code)) throw error;
      job.reason = /^openai_http_\d+$/.test(error.message) || error.message === "openai_resposta_interrompida"
        ? error.message : "erro_pipeline_imagem";
      savePhase("failed");
      await onFailure(base, readOrder(base), job.reason);
      finish();
    }
  }

  async function tick() {
    if (running || !fs.existsSync(dir)) return;
    running = true;
    try {
      for (const name of fs.readdirSync(dir).filter(name => name.endsWith(".json"))) {
        try { await processJob(path.join(dir, name)); }
        catch { console.error("[jogador-escudo] fila pendente de recuperacao", name.slice(0, 12)); }
      }
    } finally { running = false; }
  }
  function start() {
    tick().catch(() => console.error("[jogador-escudo] fila indisponivel"));
    setInterval(() => tick().catch(() => console.error("[jogador-escudo] fila indisponivel")), 3000).unref();
  }
  return { enqueue, tick, start };
}

module.exports = { createQueue, owns, executor, activationFile };
