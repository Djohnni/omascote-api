// Explicit one-time release check. Only a completed synthetic image enables routing.
const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const sharp = require("sharp");
const image = require("../src/orders/player-crest/image");
const { activationFile } = require("../src/orders/player-crest/queue");

async function verify() {
  if (!process.argv.includes("--activate")) throw new Error("Use --activate para gerar uma única arte de teste.");
  if (!process.env.PLAYER_CREST_OPENAI_API_KEY?.trim()) throw new Error("Chave de imagens ausente.");
  const data = process.env.OMASCOTE_DATA_DIR || (process.env.RENDER ? "/var/data" : "");
  if (!data) throw new Error("Diretório de dados não configurado.");
  const marker = activationFile(data);
  try {
    console.log("Jogador + Escudo já verificado", await fs.readFile(marker, "utf8"));
    return;
  } catch (error) { if (error.code !== "ENOENT") throw error; }
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "jogador-escudo-check-"));
  try {
    const photo = '<svg width="300" height="420" xmlns="http://www.w3.org/2000/svg"><rect width="300" height="420" fill="#cce2e3"/><circle cx="150" cy="110" r="44" fill="#a66e4a"/><path d="M95 160 L130 144 L170 144 L205 160 L238 220 L202 241 L187 218 L187 334 L113 334 L113 218 L97 241 L62 220Z" fill="#207956"/></svg>';
    const crest = '<svg width="200" height="200" xmlns="http://www.w3.org/2000/svg"><path d="M30 25h140v70q0 53-70 87-70-34-70-87Z" fill="#236b4d" stroke="#e9b742" stroke-width="8"/></svg>';
    await sharp(Buffer.from(photo)).png().toFile(path.join(tmp, "mascote.png"));
    await sharp(Buffer.from(crest)).png().toFile(path.join(tmp, "escudo1.png"));
    const order = { categoria: "jogador_escudo", fields: { player_name: "ATLETA TESTE", sport: "Futebol" },
      assets: { team_crest: { files: ["escudo1.png"] }, player_photo: { files: ["mascote.png"] } } };
    const form = await image.prepare(tmp, order);
    const lock = marker + ".in-progress";
    await fs.writeFile(lock, String(Date.now()), { flag: "wx" });
    let bytes;
    try {
      bytes = await image.generate(form);
    } catch (error) {
      if (/^openai_http_4\d\d$/.test(error.message)) await fs.unlink(lock);
      throw error;
    }
    const { result, preview } = await image.makeOutputs(bytes);
    const finalInfo = await sharp(result).metadata();
    const previewInfo = await sharp(preview).metadata();
    if (finalInfo.format !== "png" || finalInfo.width !== 864 || finalInfo.height !== 1536 ||
        previewInfo.format !== "jpeg" || previewInfo.width !== 520) throw new Error("Formato inesperado.");
    const proof = { model: image.model, width: finalInfo.width, height: finalInfo.height,
      preview_width: previewInfo.width, verified_at: new Date().toISOString() };
    await fs.writeFile(lock, JSON.stringify(proof));
    await fs.rename(lock, marker);
    console.log("Jogador + Escudo ativo", proof);
  } finally {
    await fs.rm(tmp, { recursive: true, force: true });
  }
}
verify().catch(error => { console.error("Verificação pendente:", error.message); process.exitCode = 1; });
