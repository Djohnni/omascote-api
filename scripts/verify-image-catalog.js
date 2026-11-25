"use strict";

// Run explicitly in the target service. One synthetic image per provider operation, with persistent receipts.
const fs = require("node:fs/promises");
const path = require("node:path");
const os = require("node:os");
const {createHash, randomUUID} = require("node:crypto");
const sharp = require("sharp");
const catalog = require("../src/orders/catalog/catalog");
const image = require("../src/orders/player-crest/image");

async function check(data, {generate = image.generate} = {}) {
  if (!await catalog.initialize()) throw new Error("catálogo privado indisponível");
  const marker = catalog.activationFile(data);
  const staging = await fs.mkdtemp(path.join(os.tmpdir(), "verificar-artes-"));
  try {
    for (const [category, operation] of [["escudo3d", "edits"], ["proximo_jogo", "generations"]]) {
      const receipt = marker + "." + operation;
      try { await fs.access(receipt); continue; } catch (err) { if (err.code !== "ENOENT") throw err; }
      const order = { categoria:category, product_id:category, image_executor:catalog.executor, schema_version:2,
        fields:{sport:"Futebol", delivery_mode:"image", matchup:{home_team:"Verde",away_team:"Azul"}}, legacy:{categoria:category} };
      const base = path.join(staging, category);
      await fs.mkdir(base);
      if (operation === "edits") {
        const crest = Buffer.from('<svg width="220" height="240" xmlns="http://www.w3.org/2000/svg"><path fill="#167556" stroke="#edba4c" stroke-width="9" d="M25 30h170v95q0 52-85 92-85-40-85-92Z"/></svg>');
        const bytes = await sharp(crest).png().toBuffer();
        await fs.writeFile(path.join(base,"escudo1.png"),bytes);
        order.idempotency_input_files = [{field:"escudo1",index:0,sha256:createHash("sha256").update(bytes).digest("hex")}];
      }
      const form = await image.prepare(base, order);
      if (form.has("image[]") !== (operation === "edits")) throw new Error("operação incorreta");
      const lock = receipt + ".in-progress";
      await fs.writeFile(lock, new Date().toISOString(), {flag:"wx"});
      let bytes;
      try { bytes = await generate(form); }
      catch (err) {
        if (/^openai_http_4\d\d$/.test(err.message)) await fs.unlink(lock);
        throw err;
      }
      const {result, preview} = await image.makeOutputs(bytes);
      const final = await sharp(result).metadata(), small = await sharp(preview).metadata();
      if (final.width !== 864 || final.height !== 1536 || final.format !== "png" ||
          small.width !== 520 || small.format !== "jpeg") throw new Error("dimensões inesperadas");
      await fs.writeFile(lock, JSON.stringify({operation,width:final.width,height:final.height,verified_at:new Date().toISOString()}));
      await fs.rename(lock,receipt);
      console.log("[artes] Imagem de teste verificada:",category,operation);
    }
    const tmp = marker + "." + randomUUID();
    await fs.writeFile(tmp, JSON.stringify({products:catalog.productIds,verified_at:new Date().toISOString()}));
    await fs.rename(tmp,marker);
    console.log("[artes] Catálogo ativo:",catalog.productIds.join(","));
  } finally { await fs.rm(staging,{recursive:true,force:true}); }
}

if (require.main === module) {
  const data = process.env.OMASCOTE_DATA_DIR || (process.env.RENDER && "/var/data");
  if (!data || !process.argv.includes("--activate")) throw new Error("Use --activate no serviço de destino.");
  check(data).catch(err => {
    console.error("Verificação pendente:",err.code === "EEXIST" ? "tentativa anterior pendente" : err.message);
    process.exitCode = 1;
  });
}
module.exports = {check};
