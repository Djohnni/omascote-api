"use strict";

const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { createDecipheriv, createHash } = require("node:crypto");
const { execFile } = require("node:child_process");
const sharp = require("sharp");

const productIds = ["resultado", "proximo_jogo", "escalacao", "contratacao", "patrocinador", "escudo3d",
  "mascote_uniforme", "proximo_jogo_jogador", "resultado_jogo_jogador"];
const executor = "openai_catalogo_ia4tube_v1";
const activationFile = dir => path.join(dir, executor + ".verified");
const supported = id => productIds.includes(id);
const owns = order => order?.image_executor === executor && supported(order.categoria);
const python = () => process.env.PLAYER_CREST_PYTHON || (process.platform === "win32" ? "python" : "python3");
function pythonEnvironment() {
  const env = {};
  for (const key of ["PATH", "Path", "SystemRoot", "WINDIR", "TEMP", "TMP", "TMPDIR", "LANG", "SSL_CERT_FILE", "SSL_CERT_DIR"]) {
    if (process.env[key]) env[key] = process.env[key];
  }
  return env;
}

let directory;
let installing;

function execute(script, args, input, options = {}) {
  return new Promise((resolve, reject) => {
    const child = execFile(python(), ["-B", "-X", "utf8", script, ...args],
      { timeout: 45000, windowsHide: true, maxBuffer: 1024 * 1024, env: pythonEnvironment(), ...options },
      (error, output) => error ? reject(new Error("motor_ia4tube_indisponivel")) : resolve(output));
    child.stdin.on("error", () => {});
    child.stdin.end(input);
  });
}

async function initialize() {
  if (directory) return true;
  if (installing) return installing;
  const secret = process.env.IA4TUBE_CATALOG_PACK_KEY;
  if (!secret) return false;
  installing = (async () => {
    const pack = fs.readFileSync(path.join(__dirname, "catalog.pack"));
    const decrypt = createDecipheriv("aes-256-gcm", Buffer.from(secret, "base64"), pack.subarray(0,12));
    decrypt.setAuthTag(pack.subarray(-16));
    const archive = Buffer.concat([decrypt.update(pack.subarray(12,-16)), decrypt.final()]);
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "ia4tube-artes-"));
    try {
      await execute(path.join(__dirname, "install.py"), [tmp], archive);
      directory = tmp;
      process.once("exit", () => fs.rmSync(tmp, {recursive:true, force:true}));
      return true;
    } catch (error) {
      fs.rmSync(tmp, {recursive:true, force:true});
      throw error;
    }
  })();
  try { return await installing; } finally { installing = undefined; }
}

async function desktop(operation, base, data) {
  if (!await initialize()) throw new Error("motor_ia4tube_indisponivel");
  const env = { ...pythonEnvironment(), PYTHONPATH: directory,
    PLAYER_CREST_OPENAI_API_KEY: process.env.PLAYER_CREST_OPENAI_API_KEY || "" };
  const output = await execute(path.join(__dirname, "build_request.py"), [operation, base], JSON.stringify(data), { env });
  return JSON.parse(output);
}

function inputIdentity(name) {
  const single = /^(escudo1|escudo2|mascote|referencia|camiseta)\.png$/.exec(name);
  if (single) return [single[1],0];
  const photo = /^foto([2-4])\.png$/.exec(name);
  if (photo) return ["mascote",Number(photo[1])-1];
  const sponsor = /^pat(0[1-9]|1[0-9]|20)\.png$/.exec(name);
  if (sponsor) return ["patrocinadores",Number(sponsor[1])-1];
  throw new Error("referencia_invalida");
}

async function prepare(base, order, scratch) {
  const plan = await desktop("prepare", base, {order});
  const form = new FormData();
  for (const [key,value] of Object.entries({model:plan.model, size:plan.size, quality:plan.quality,
    prompt:plan.prompt, n:"1", output_format:"jpeg"})) form.set(key,value);
  for (const name of plan.refs) {
    const [field, index] = inputIdentity(name);
    const filename = path.join(base,name);
    if (!(await fs.promises.lstat(filename)).isFile()) throw new Error("referencia_invalida");
    const source = await fs.openAsBlob(filename);
    const bytes = Buffer.from(await source.arrayBuffer());
    const expected = order.idempotency_input_files?.find(f => f.field === field && f.index === index);
    if (!expected?.sha256 || createHash("sha256").update(bytes).digest("hex") !== expected.sha256)
      throw new Error("referencia_alterada");
    const input = sharp(bytes, {limitInputPixels:60000000,failOn:"error"});
    const {format} = await input.metadata();
    if (!["png","jpeg","webp"].includes(format)) throw new Error("referencia_invalida");
    // Desktop preprocessing preserves crests, including transparency, and submits other references as RGB PNG.
    const preserve = field === "escudo1" || field === "escudo2";
    const ext = preserve ? format : "png";
    let blob = source.slice(0, source.size, "image/" + ext);
    if (!preserve) {
      const conversion = input.removeAlpha().toColourspace("srgb").png();
      if (scratch) {
        const file = path.join(scratch, name);
        await conversion.toFile(file);
        blob = await fs.openAsBlob(file, { type: "image/png" });
      } else {
        blob = new Blob([await conversion.toBuffer()], { type: "image/png" });
      }
    }
    form.append("image[]", blob, name.replace(/\.png$/, "." + ext));
  }
  form.artLines = plan.lines;
  return form;
}

const caption = (base,order,lines) => desktop("caption",base,{order,lines});
module.exports = { activationFile, productIds, supported, owns, executor, initialize, ready:() => Boolean(directory), prepare, caption, desktop };
