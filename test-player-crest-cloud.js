const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const crypto = require("node:crypto");
const sharp = require("sharp");
const storage = require("./src/orders/order.storage");
const { executor, createQueue } = require("./src/orders/player-crest/queue");
const renderer = require("./src/orders/player-crest/image");

const player = { categoria: "jogador_escudo", image_executor: executor,
  fields: { sport: "Futebol", player_name: "D'Ávila" }, assets: { team_crest: { files: ["escudo.png"] } } };

test("arquivo original e mapa das duas referências", async () => {
  const folder = path.join(__dirname, "src/orders/player-crest");
  assert.equal(crypto.createHash("sha256").update(fs.readFileSync(path.join(folder, "prompt_jogador_escudo.txt"))).digest("hex"),
    "7212235c7b0b2f7723a8fd4dc65c0ec5ce92a18c673f3d8b7488de6104bf79f3");
  const prompt = renderer.buildPrompt(player);
  assert.ok(prompt.startsWith(fs.readFileSync(path.join(folder, "prompt_jogador_escudo.txt"), "utf8").trim()));
  assert.match(prompt, /IMAGEM 1: FOTO DO JOGADOR/);
  assert.match(prompt, /IMAGEM 2: ESCUDO DO TIME/);
  assert.match(prompt, /D'Ávila/);
  const multi = renderer.buildPrompt({ ...player, motivo_ajuste: "Luz mais suave", fields: { ...player.fields, sport: "Vôlei" } });
  assert.match(multi, /VÔLEI/);
  assert.match(multi, /Luz mais suave/);
});

test("pagamento, exclusão do PC, ajuste e retomada sem uma nova geração", async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "jogador-cloud-"));
  t.after(() => fs.rmSync(root, { force: true, recursive: true }));
  const base = path.join(root, "order"), dir = path.join(root, "queue");
  fs.mkdirSync(base);
  let paid = false, generated = 0, failures = 0;
  const photo = await sharp({ create: { width: 540, height: 960, channels: 3, background: "#486568" } }).jpeg().toBuffer();
  const crest = await sharp({ create: { width: 80, height: 80, channels: 3, background: "#e9a96f" } }).png().toBuffer();
  fs.writeFileSync(path.join(base, "mascote.png"), photo);
  fs.writeFileSync(path.join(base, "escudo1.png"), crest);
  const options = { dir, readOrder: storage.readOrder, writeOrder: storage.writeOrder,
    readStatus: storage.readStatus, writeStatus: storage.writeStatus,
    authorize: async () => ({ ok: paid, waiting: !paid }),
    onFailure: async () => { failures++; storage.writeStatus(base, "erro"); },
    renderer: { ...renderer, generate: async form => {
      const refs = form.getAll("image[]");
      assert.deepEqual(refs.map(ref => ref.type), ["image/jpeg", "image/png"]);
      assert.deepEqual(Buffer.from(await refs[0].arrayBuffer()), photo);
      assert.deepEqual(Buffer.from(await refs[1].arrayBuffer()), crest);
      generated++; return photo;
    } } };
  const queue = createQueue(options);
  queue.enqueue(base, { categoria: "jogador_escudo" });
  assert.equal(fs.existsSync(dir), false);
  storage.writeOrder(base, player);
  storage.writeStatus(base, "novo");
  queue.enqueue(base, player);
  await queue.tick();
  assert.equal(generated, 0);
  paid = true;
  await Promise.all([queue.tick(), queue.tick()]);
  assert.equal(storage.readStatus(base), "pronto");
  const preview = await sharp(path.join(base, "preview_ia4tube.jpg")).metadata();
  assert.equal(preview.width, 520);
  assert.equal((await sharp(path.join(base, "resultado_final.png")).metadata()).format, "png");
  queue.enqueue(base, storage.readOrder(base));
  assert.equal(fs.readdirSync(dir).length, 0);
  const edited = { ...storage.readOrder(base), ajuste_solicitado_em: "2026-11-24T23:10:59Z", motivo_ajuste: "Rever a luz" };
  storage.writeOrder(base, edited);
  storage.writeStatus(base, "ajuste_pendente");
  queue.enqueue(base, edited);
  const file = path.join(dir, fs.readdirSync(dir)[0]);
  const job = JSON.parse(fs.readFileSync(file, "utf8"));
  fs.writeFileSync(file, JSON.stringify({ ...job, phase: "submitted" }));
  fs.writeFileSync(file + ".image", photo);
  await createQueue(options).tick();
  assert.equal(storage.readOrder(base).image_delivered_revision, edited.ajuste_solicitado_em);
  assert.equal(generated, 1);
  const interrupted = { ...player, ajuste_solicitado_em: "later" };
  storage.writeOrder(base, interrupted);
  storage.writeStatus(base, "em_producao");
  queue.enqueue(base, interrupted);
  const pending = path.join(dir, fs.readdirSync(dir)[0]);
  fs.writeFileSync(pending, JSON.stringify({ ...JSON.parse(fs.readFileSync(pending)), phase: "submitted" }));
  await createQueue(options).tick();
  assert.equal(failures, 1);
  assert.equal(generated, 1);
});
