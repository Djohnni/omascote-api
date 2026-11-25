"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const storage = require("./src/orders/order.storage");
const catalog = require("./src/orders/catalog/catalog");
const image = require("./src/orders/player-crest/image");
const { createQueue, executor } = require("./src/orders/player-crest/queue");

function fixture(t, generate) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "queue-test-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const options = {
    dir: path.join(root, "queue"), ...storage,
    authorize: (base, current) => ({ ok: current.paid }),
    onFailure: (base, order, reason) => storage.writeOrder(base, { ...order, failure: reason }),
    renderer: { prepare: async (base, order) => order.id, generate,
      makeOutputs: async bytes => ({ result: bytes, preview: bytes }) }
  };
  const queue = createQueue(options);
  function add(id) {
    const products = ["jogador_escudo", ...catalog.productIds];
    const categoria = products[(id - 1) % products.length];
    const order = { id, whatsapp: "cliente-" + (id % 13), paid: true, categoria,
      image_executor: categoria === "jogador_escudo" ? executor : catalog.executor };
    const base = path.join(root, String(id));
    fs.mkdirSync(base);
    storage.writeOrder(base, order);
    storage.writeStatus(base, "novo");
    queue.enqueue(base, order);
    return base;
  }
  return { options, queue, add };
}

function deferred() {
  let resolve;
  const promise = new Promise(done => { resolve = done; });
  return { promise, resolve };
}

test("100 pedidos, dez produtos e treze clientes compartilham 25 vagas continuamente", { timeout: 30000 }, async t => {
  const releases = new Map(), seen = new Set(), started = [];
  const first25 = deferred(), next = deferred();
  let peak = 0, finished = 0;
  const { queue, add } = fixture(t, async id => {
    assert.ok(!seen.has(id), "geracao duplicada");
    seen.add(id);
    const gate = deferred();
    releases.set(id, gate);
    started.push(id);
    peak = Math.max(peak, releases.size);
    if (started.length === 25) first25.resolve();
    if (started.length === 26) next.resolve();
    if (started.length > 25) gate.resolve();
    await gate.promise;
    releases.delete(id);
    finished++;
    return Buffer.from(String(id));
  });
  const bases = Array.from({ length: 100 }, (_, i) => add(i + 1));
  const drain = queue.tick();
  queue.tick();
  await first25.promise;
  assert.deepEqual(started, Array.from({ length: 25 }, (_, i) => i + 1));
  assert.equal(finished, 0);
  for (const base of bases) queue.enqueue(base, storage.readOrder(base));
  queue.tick();
  releases.get(17).resolve(); // A later starter finishes before the oldest 24.
  await next.promise;
  assert.equal(started[25], 26);
  assert.equal(finished, 1);
  assert.equal(storage.readStatus(bases[16]), "pronto");
  assert.equal(releases.has(1), true);
  for (const gate of releases.values()) gate.resolve();
  await drain;
  await queue.tick();
  assert.equal(peak, 25);
  assert.equal(finished, 100);
  assert.equal(seen.size, 100);
  for (const [i, base] of bases.entries()) {
    assert.equal(storage.readStatus(base), "pronto");
    assert.equal(fs.readFileSync(path.join(base, "resultado_final.png"), "utf8"), String(i + 1));
  }
});

test("429 pausa toda a fila, sobrevive ao reinicio e retenta sem acionar estorno", async t => {
  const calls = [];
  const reject = () => Object.assign(new Error("openai_http_429"), { rateLimited: true, retryAfterMs: 60000 });
  const { queue, add, options } = fixture(t, async id => {
    calls.push(id);
    if (calls.length === 1) throw reject();
    return Buffer.from(String(id));
  });
  const base = add(1);
  const now = Date.now();
  const clock = t.mock.method(Date, "now", () => now);
  await queue.tick();
  add(2);
  assert.equal(storage.readOrder(base).failure, undefined);
  const restarted = createQueue(options);
  clock.mock.mockImplementation(() => now + 59999);
  await restarted.tick();
  assert.deepEqual(calls, [1]);
  clock.mock.mockImplementation(() => now + 60000);
  await Promise.all([restarted.tick(), restarted.tick()]);
  assert.deepEqual(calls.sort(), [1, 1, 2]);
  assert.equal(storage.readStatus(base), "pronto");
  assert.equal(storage.readOrder(base).failure, undefined);
});

test("a fila ativa acorda sozinha depois do prazo de 429", { timeout: 5000 }, async t => {
  const delivered = deferred(), attempts = [];
  const { add, options } = fixture(t, async () => {
    attempts.push(Date.now());
    if (attempts.length === 1) throw Object.assign(new Error("openai_http_429"), { rateLimited: true, retryAfterMs: 150 });
    return Buffer.from("ok");
  });
  const current = createQueue({ ...options, writeStatus(base, status) {
    storage.writeStatus(base, status);
    if (status === "pronto") delivered.resolve();
  }});
  add(1);
  current.start();
  // Production has a listening HTTP server keeping its unref'ed timers alive.
  const keepAlive = setInterval(() => {}, 1000);
  try {
    await delivered.promise;
    assert.equal(attempts.length, 2);
    assert.ok(attempts[1] - attempts[0] >= 150);
  } finally { clearInterval(keepAlive); await current.stop(); }
});

test("encerramento aguarda o envio em andamento e preserva o proximo pedido no disco", async t => {
  const started = deferred(), release = deferred(), calls = [];
  const { queue, add, options } = fixture(t, async id => {
    calls.push(id);
    if (id === 1) { started.resolve(); await release.promise; }
    return Buffer.from(String(id));
  });
  queue.start();
  const first = add(1);
  await started.promise;
  const next = add(2);
  const stopped = queue.stop();
  release.resolve();
  await stopped;
  assert.deepEqual(calls, [1]);
  assert.equal(storage.readStatus(first), "pronto");
  assert.equal(storage.readStatus(next), "novo");
  await createQueue(options).tick();
  assert.deepEqual(calls, [1, 2]);
  assert.equal(storage.readStatus(next), "pronto");
});

test("HTTP distingue ritmo e falta de credito, sem usar a rede", async t => {
  t.mock.method(global, "fetch");
  const old = process.env.PLAYER_CREST_OPENAI_API_KEY;
  process.env.PLAYER_CREST_OPENAI_API_KEY = "offline-test";
  t.after(() => { if (old === undefined) delete process.env.PLAYER_CREST_OPENAI_API_KEY;
    else process.env.PLAYER_CREST_OPENAI_API_KEY = old; });
  for (const [headers, code, limited, delay] of [
    [{"Retry-After": "12"}, "rate_limit_exceeded", true, 12000],
    [{"retry-after-ms": "1500"}, "rate_limit_exceeded", true, 1500],
    [{"x-ratelimit-reset-images": "1m2.5s"}, "rate_limit_exceeded", true, 62500],
    [{}, "insufficient_quota", false, 0]
  ]) {
    global.fetch.mock.mockImplementation(async () => new Response(JSON.stringify({ error: { code } }), { status: 429, headers }));
    await assert.rejects(image.generate(new FormData()), e => e.rateLimited === limited && e.retryAfterMs === delay);
  }
});
