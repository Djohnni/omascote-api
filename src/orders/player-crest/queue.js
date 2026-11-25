const fs = require("node:fs");
const path = require("node:path");
const os = require("node:os");
const { createHash, randomUUID } = require("node:crypto");
const image = require("./image");
const catalog = require("../catalog/catalog");

const executor = "openai_jogador_escudo_v1";
const activationFile = dir => path.join(dir, executor + ".verified");
const owns = order => (order?.image_executor === executor && order.categoria === "jogador_escudo") || catalog.owns(order);
const revision = order => order.ajuste_solicitado_em || "original";
const readyStates = new Set(["novo", "ajuste_pendente", "em_producao"]);
const maxConcurrent = 25;

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
  // This service has one Node process and one exclusively mounted Render disk.
  const pending = new Set(), active = new Set();
  const processingOrders = new Set();
  const cooldownFile = path.join(dir, ".retry-after");
  let pausedUntil = 0, wakeTimer, pollTimer, drain, resolveDrain, stopping = false;
  // Bound local Python/Sharp memory independently of the 25 remote requests.
  let localCount = 0;
  const localWaiters = [];
  async function local(work) {
    if (localCount < 2) localCount++;
    else await new Promise(resolve => localWaiters.push(resolve));
    try { return await work(); }
    finally {
      if (localWaiters.length) localWaiters.shift()();
      else localCount--;
    }
  }
  function enqueue(base, order) {
    if (!owns(order) || order.image_delivered_revision === revision(order)) return;
    const job = { base, rev: revision(order), phase: "queued" };
    const key = createHash("sha256").update(JSON.stringify([base, job.rev])).digest("hex");
    const file = path.join(dir, key + ".json");
    fs.mkdirSync(dir, { recursive: true });
    if (!fs.existsSync(file)) {
      replace(file, JSON.stringify(job));
      pending.add(file);
      if (pollTimer) queueMicrotask(pump);
    }
  }

  async function processJob(file) {
    const job = JSON.parse(fs.readFileSync(file, "utf8"));
    // Different revisions of one order share output paths and payment authorization.
    if (processingOrders.has(job.base)) return;
    processingOrders.add(job.base);
    try { return await processRevision(file, job); }
    finally { processingOrders.delete(job.base); }
  }

  async function processRevision(file, job) {
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
      const latest = readOrder(base);
      return permission.ok && owns(latest) && revision(latest) === rev && readyStates.has(readStatus(base));
    }
    if (!await authorized()) return;
    try {
      if (!fs.existsSync(raw)) {
        if (job.phase === "submitted") throw new Error("openai_resposta_interrompida");
        const scratch = fs.mkdtempSync(path.join(os.tmpdir(), "omascote-image-"));
        try {
          const form = await local(() => stopping || pausedUntil > Date.now() ? null : renderer.prepare(base, order, scratch));
          if (!await authorized()) return;
          if (stopping) return;
          if (!form || pausedUntil > Date.now()) return true;
          writeStatus(base, "em_producao");
          // A crash after submission cannot safely be retried as a new paid edit.
          if (Array.isArray(form.artLines)) job.lines = form.artLines;
          savePhase("submitted");
          let bytes;
          try { bytes = await renderer.generate(form); }
          catch (error) {
            if (!error.rateLimited) throw error;
            job.rateLimits = (job.rateLimits || 0) + 1;
            const fallback = Math.min(60000, 1000 * 2 ** Math.min(job.rateLimits - 1, 6));
            pausedUntil = Math.max(pausedUntil, Date.now() + Math.max(1, error.retryAfterMs || fallback));
            replace(cooldownFile, String(pausedUntil));
            savePhase("queued"); // Only an explicit provider rejection is safe to resubmit.
            return true;
          }
          replace(raw, bytes);
        } finally { fs.rmSync(scratch, { force: true, recursive: true }); }
      }
      if (!await authorized()) return;
      if (job.lines && job.caption === undefined && renderer.caption) {
        job.caption = await local(() => renderer.caption(base, order, job.lines)).catch(() => "");
        savePhase("rendered");
      }
      const { result, preview } = await local(() => renderer.makeOutputs(fs.readFileSync(raw)));
      if (!await authorized()) return;
      order = readOrder(base);
      replace(path.join(base, "preview_ia4tube.jpg"), preview);
      replace(path.join(base, "resultado_final.png"), result);
      writeOrder(base, { ...order, status: "pronto", aprovado_cliente: false, baixado_cliente: false,
        image_delivered_revision: rev, resultado_enviado_em: new Date().toISOString(),
        descricao_instagram: job.caption || order.descricao_instagram || String(order.fields?.player_name || order.data || "") });
      writeStatus(base, "pronto");
      fs.rmSync(path.join(base, "ajuste_pendente.txt"), { force: true });
      finish();
    } catch (error) {
      const latest = readOrder(base);
      if (!owns(latest) || revision(latest) !== rev) return finish();
      if (latest.image_delivered_revision === rev) return;
      if (fs.existsSync(raw) && error.code && ["ENOSPC", "EIO", "EBUSY","EPERM"].includes(error.code)) throw error;
      job.reason = /^openai_http_\d+$/.test(error.message) || error.message === "openai_resposta_interrompida"
        ? error.message : "erro_pipeline_imagem";
      savePhase("failed");
      await onFailure(base, readOrder(base), job.reason);
      finish();
    }
  }

  async function run(file) {
    let retry;
    try { retry = await processJob(file); }
    catch { console.error("[jogador-escudo] fila pendente de recuperacao", path.basename(file).slice(0, 12)); }
    finally {
      active.delete(file);
      if (retry === true) pending.add(file);
      pump();
    }
  }
  function pump() {
    if (pausedUntil > Date.now() && pending.size && pollTimer && !wakeTimer) {
      wakeTimer = setTimeout(() => { wakeTimer = undefined; pump(); },
        Math.min(pausedUntil - Date.now(), 2147483647)).unref();
    }
    while (!stopping && active.size < maxConcurrent && pending.size && pausedUntil <= Date.now()) {
      const file = pending.values().next().value;
      pending.delete(file);
      active.add(file);
      run(file);
    }
    if (!active.size && resolveDrain) {
      resolveDrain();
      drain = resolveDrain = undefined;
    }
  }
  function scan() {
    if (!fs.existsSync(dir)) return;
    if (fs.existsSync(cooldownFile)) pausedUntil = Math.max(pausedUntil, Number(fs.readFileSync(cooldownFile, "utf8")));
    const recovered = [];
    for (const name of fs.readdirSync(dir)) {
      if (!name.endsWith(".json")) continue;
      const file = path.join(dir, name);
      if (!active.has(file) && !pending.has(file)) recovered.push({ file, time: fs.statSync(file).birthtimeMs });
    }
    for (const item of recovered.sort((a, b) => a.time - b.time)) pending.add(item.file);
    pump();
  }
  function waitForActive() {
    if (active.size && !drain) drain = new Promise(resolve => { resolveDrain = resolve; });
    return drain;
  }
  async function tick() {
    scan();
    return waitForActive();
  }
  function stop() {
    stopping = true;
    clearInterval(pollTimer);
    clearTimeout(wakeTimer);
    pollTimer = wakeTimer = undefined;
    return waitForActive();
  }
  function start() {
    if (pollTimer || stopping) return;
    function poll() {
      try { scan(); } catch { console.error("[jogador-escudo] fila indisponivel"); }
    }
    pollTimer = setInterval(poll, 3000).unref();
    poll();
    console.log("[artes] Fila de imagens ativa, limite global:", maxConcurrent);
  }
  return { enqueue, tick, start, stop, configuredConcurrency: () => pollTimer ? maxConcurrent : 0 };
}

module.exports = { createQueue, owns, executor, activationFile };
