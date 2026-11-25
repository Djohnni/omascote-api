const fs = require("node:fs/promises");
const { openAsBlob } = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");
const { spawnSync } = require("node:child_process");
const sharp = require("sharp");
const catalog = require("../catalog/catalog");

const model = "gpt-image-2.5-sunburst";
const mime = { png: "image/png", jpeg: "image/jpeg", webp: "image/webp" };

function buildPrompt(order) {
  const result = spawnSync(process.env.PLAYER_CREST_PYTHON ||
    (process.platform === "win32" ? "python" : "python3"),
  ["-B", "-X", "utf8", path.join(__dirname, "build_prompt.py")], {
    input: JSON.stringify(order), encoding: "utf8", timeout: 10000, windowsHide: true,
  });
  if (result.error || result.status !== 0 || !result.stdout.trim()) throw new Error("prompt_indisponivel");
  return result.stdout;
}

async function prepare(base, order, scratch) {
  if (catalog.owns(order)) return catalog.prepare(base, order, scratch);
  const form = new FormData();
  for (const [key, value] of Object.entries({
    model, prompt: buildPrompt(order), size: "864x1536", quality: "medium", output_format: "jpeg", n: "1",
  })) form.append(key, value);
  for (const [field, filename] of [["mascote", "mascote.png"], ["escudo1", "escudo1.png"]]) {
    const source = await openAsBlob(path.join(base, filename));
    const bytes = Buffer.from(await source.arrayBuffer());
    const expected = order.idempotency_input_files?.find(f => f.field === field && f.index === 0);
    if (expected?.sha256 && crypto.createHash("sha256").update(bytes).digest("hex") !== expected.sha256) {
      throw new Error("referencia_alterada");
    }
    const { format } = await sharp(bytes, { limitInputPixels: 60000000 }).metadata();
    if (!mime[format]) throw new Error("referencia_invalida");
    form.append("image[]", source.slice(0, source.size, mime[format]), field + "." + format);
  }
  return form;
}

function retryDelay(headers) {
  const ms = headers.get("retry-after-ms");
  if (ms !== null && Number.isFinite(Number(ms)) && Number(ms) > 0) return Math.ceil(Number(ms));
  const value = headers.get("retry-after");
  if (value) {
    const delay = /^\d+(?:\.\d+)?$/.test(value) ? Number(value) * 1000 : Date.parse(value) - Date.now();
    if (Number.isFinite(delay) && delay >= 0) return Math.ceil(delay);
  }
  const units = { d: 86400000, h: 3600000, m: 60000, s: 1000, ms: 1 };
  const delays = ["images", "requests", "tokens"].map(resource => {
    const reset = headers.get("x-ratelimit-reset-" + resource) || "";
    if (Number(headers.get("x-ratelimit-remaining-" + resource)) > 0 ||
        !/^(?:\d+(?:\.\d+)?(?:ms|[dhms]))+$/.test(reset)) return 0;
    return [...reset.matchAll(/(\d+(?:\.\d+)?)(ms|[dhms])/g)]
      .reduce((total, [, count, unit]) => total + Number(count) * units[unit], 0);
  });
  return Math.ceil(Math.max(...delays));
}

async function generate(form) {
  const key = process.env.PLAYER_CREST_OPENAI_API_KEY?.trim();
  if (!key) throw new Error("credencial_indisponivel");
  const editing = form.has("image[]");
  const headers = { Authorization: "Bearer " + key };
  let body = form;
  if (!editing) {
    headers["Content-Type"] = "application/json";
    body = JSON.stringify({ ...Object.fromEntries(form), n: 1 });
  }
  const endpoint = editing ? "edits" : "generations";
  const response = await fetch("https://api.openai.com/v1/images/" + endpoint, {
    method: "POST", headers, body, signal: AbortSignal.timeout(300000),
  });
  if (!response.ok) {
    const error = new Error("openai_http_" + response.status);
    if (response.status === 429) {
      const info = (await response.json().catch(() => null))?.error;
      const quota = ["insufficient_quota", "billing_hard_limit_reached"];
      error.rateLimited = !quota.includes(info?.code) && !quota.includes(info?.type);
      error.retryAfterMs = retryDelay(response.headers);
    }
    throw error;
  }
  const payload = await response.json();
  const encoded = payload.data?.[0]?.b64_json;
  if (typeof encoded !== "string" || !encoded.length) throw new Error("openai_sem_imagem");
  return Buffer.from(encoded, "base64");
}

async function makeOutputs(bytes) {
  const input = sharp(bytes, { limitInputPixels: 8000000 });
  const { width, height } = await input.metadata();
  if (!width || !height || height <= width) throw new Error("formato_de_resultado_invalido");
  const w = Math.min(520, width);
  const h = Math.round(height * w / width);
  const marks = [0.20, 0.52, 0.84].map(r =>
    '<text x="50%" y="' + Math.round(h * r) + '" text-anchor="middle" fill="white" stroke="#222" stroke-width="1" font-family="sans-serif" font-weight="bold" font-size="36">PRÉVIA IA4TUBE</text>').join("");
  const watermark = Buffer.from('<svg width="' + w + '" height="' + h + '" xmlns="http://www.w3.org/2000/svg"><g opacity=".60">' + marks + '</g></svg>');
  const preview = await input.clone().resize(w, h).composite([{ input: watermark }]).jpeg({ quality: 72 }).toBuffer();
  return { preview, result: await input.png().toBuffer() };
}

module.exports = { model, buildPrompt, prepare, generate, makeOutputs, caption: catalog.caption };
