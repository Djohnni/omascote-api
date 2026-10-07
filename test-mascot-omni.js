const assert = require("node:assert/strict");
const test = require("node:test");
const fs = require("node:fs");
const { once } = require("node:events");
const { execFileSync } = require("node:child_process");
const os = require("node:os");
const path = require("node:path");

process.env.OMASCOTE_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "omascote-mascot-omni-test-"));
process.env.NODE_ENV = "test";
process.env.JWT_SECRET = "local-mascot-omni-contract-test-only";
process.env.BOT_ADMIN_WHATSAPP = "admin-mascot-test";
process.env.MASCOT_OMNI_ENABLED = "true";
process.env.ESCUDO3D_OMNI_ENABLED = "true";
process.env.VEO_VIDEO_ENABLED = "true";
delete process.env.MP_ACCESS_TOKEN;
delete process.env.OPENAI_API_KEY;

const { app, __resultadoScenarioTest: api, __fotoJogosTest: pricing } = require("./server");
const orders = require("./src/orders/order.service");
const req = { user: { whatsapp: "cliente-mascot-test" } };

function prepare(values = {}, product = "mascote_uniforme") {
  const fields = orders.normalizeOrderBody({
    schema_version: 2,
    product_id: product,
    fields_json: JSON.stringify({ delivery_mode: "image_video", ...values })
  });
  return { fields, result: api.prepararInternalVeoPedido(req, product, fields) };
}

test("Novos videos de mascote usam Omni 720p, inclusive navegadores que ainda enviam Fast", () => {
  for (const video_model of [undefined, "omni", "fast", "veo_fast", "lite"]) {
    const { result, fields } = prepare({ video_model, mascot_video_option: "chuva" });
    assert.equal(result.ok, true, video_model);
    const video = result.patch.video_generation;
    assert.equal(video.model, "omni");
    assert.equal(video.model_id, "gemini-omni-1.1-flash-preview");
    assert.equal(video.provider, "google_vertex_ai");
    assert.equal(video.duration_seconds, 10);
    assert.equal(video.resolution, "720p");
    assert.equal(video.aspect_ratio, "9:16");
    assert.equal(video.generate_audio, true);
    assert.equal(video.first_last_frame_same, false);
    assert.equal(video.location, "global");
    assert.equal(video.commercial, true);
    assert.equal(video.internal_test, false);
    assert.equal(fields.new_model.fields.video_model, "omni");
    assert.equal(fields.new_model.fields.mascot_video_option, "chuva");
  }
  assert.equal(prepare({ video_model: "arbitrary-model" }).result.ok, false);
});

test("Pedido normalizado conserva a opcao Chuva e o contrato Omni para o worker", () => {
  const { fields, result } = prepare({
    video_model: "omni", mascot_video_option: "chuva", mascot_animal: "Leão", sport: "futebol"
  });
  const pedido = orders.buildPedidoData({
    categoria: "mascote_uniforme", id: "test-chuva", whatsapp: "cliente-mascot-test",
    mesAtual: "2026-10", fields, files: {}, pats: []
  });
  Object.assign(pedido, result.patch);
  const serialized = JSON.parse(JSON.stringify(pedido));
  assert.equal(serialized.fields.mascot_video_option, "chuva");
  assert.equal(serialized.fields.mascot_animal, "Leão");
  assert.equal(serialized.fields.video_model, "omni");
  assert.equal(serialized.video_generation.model, "omni");
  assert.equal(serialized.video_generation.resolution, "720p");
  assert.equal(serialized.video_generation.first_last_frame_same, false);
});

test("Imagem do mascote e os demais produtos preservam os contratos existentes", () => {
  assert.equal(prepare({ delivery_mode: "image" }).result.patch, null);
  assert.equal(prepare({ delivery_mode: "", video_model: "omni" }).result.ok, false);
  for (const product of ["resultado", "proximo_jogo", "jogador_escudo", "patrocinador", "escalacao"]) {
    assert.equal(prepare({}, product).result.patch.video_generation.model, "fast", product);
    assert.equal(prepare({ video_model: "omni" }, product).result.ok, false, product);
  }
  const crest = prepare({ video_model: "omni" }, "escudo3d").result.patch.video_generation;
  assert.equal(crest.first_last_frame_same, true);
  assert.equal(crest.duration_seconds, 10);
});

test("Mascote continua R$28 com Omni e R$18 somente imagem", () => {
  for (const video_model of ["omni", "fast"]) {
    assert.equal(pricing.getCustoPedidoComAdicionais("mascote_uniforme", {}, {
      new_model: { fields: { delivery_mode: "image_video", video_model, mascot_video_option: "chuva" } }
    }), 28);
  }
  assert.equal(pricing.getCustoPedidoComAdicionais("mascote_uniforme", {}, {
    new_model: { fields: { delivery_mode: "image" } }
  }), 18);
});

test("Sol custa R$25 e Chuva/Ascensao Epica R$28 em todos os formatos de pedido", () => {
  for (const [mascot_video_option, expected] of [["sol",25],["chuva",28],["ascensao_epica",28],[undefined,28]]) {
    const values = { delivery_mode: "image_video", video_model: "omni", mascot_video_option, mascot_video_price: 1 };
    for (const source of [values, {fields:values}, {fields_json:JSON.stringify(values)}, {new_model:{fields:values}}]) {
      assert.equal(pricing.getCustoPedidoComAdicionais("mascote_uniforme", {}, source), expected);
    }
    const { fields, result } = prepare(values);
    assert.equal(result.ok, true);
    const pedido = orders.buildPedidoData({
      categoria: "mascote_uniforme", id: `test-${mascot_video_option || "legacy"}`, whatsapp: "cliente-mascot-test",
      mesAtual: "2026-10", fields, files: {}, pats: []
    });
    assert.equal(pedido.fields.mascot_video_option, mascot_video_option);
    assert.equal(result.patch.video_generation.model, "omni");
    assert.equal(result.patch.video_generation.resolution, "720p");
    assert.equal(pricing.getCustoPedidoComAdicionais("mascote_uniforme", {}, pedido), expected);
  }
  assert.equal(pricing.getCustoPedidoComAdicionais("mascote_uniforme", {}, {
    delivery_mode:"image", mascot_video_option:"sol"
  }),18);
});

test("Cotacao HTTP usa a opcao de mascote e ignora preco enviado pelo navegador", async () => {
  const server = app.listen(0, "127.0.0.1");
  try {
    await once(server, "listening");
    for (const [mascot_video_option, expected] of [["sol",25],["chuva",28],["ascensao_epica",28]]) {
      const response = await fetch(`http://127.0.0.1:${server.address().port}/cupons/preco`, {
        method:"POST", headers:{"Content-Type":"application/json"},
        body:JSON.stringify({product_id:"mascote_uniforme",delivery_mode:"image_video",video_model:"omni",mascot_video_option,mascot_video_price:1})
      });
      assert.equal(response.status,200);
      const quote = await response.json();
      assert.equal(quote.valor_original,expected);
      assert.equal(quote.valor_final,expected);
    }
  } finally {
    await new Promise(resolve => server.close(resolve));
  }
});

test("Consulta HTTP informa R$28 para Mascote Omni e recusa modelo invalido", async () => {
  const server = app.listen(0, "127.0.0.1");
  try {
    await once(server, "listening");
    for (const video_model of [undefined, "omni", "fast", "arbitrary-model"]) {
      const response = await fetch(`http://127.0.0.1:${server.address().port}/cupons/preco`, {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ product_id: "mascote_uniforme", delivery_mode: "image_video", video_model })
      });
      assert.equal(response.status, video_model === "arbitrary-model" ? 400 : 200);
      if (response.ok) assert.equal((await response.json()).valor_final, 28);
    }
  } finally {
    await new Promise(resolve => server.close(resolve));
  }
});

test("Desativacao do Omni Mascote recusa novos videos sem afetar Escudo ou imagem", () => {
  execFileSync(process.execPath, ["-e", `
    const assert = require('node:assert/strict');
    const { __resultadoScenarioTest: api } = require('./server');
    const req = { user: { whatsapp: 'cliente-mascot-test' } };
    for (const video_model of ['omni', 'fast']) {
      const result = api.prepararInternalVeoPedido(req, 'mascote_uniforme', {
        new_model: { fields: { delivery_mode: 'image_video', video_model } }
      });
      assert.equal(result.ok, false);
      assert.equal(result.status, 503);
    }
    const image = api.prepararInternalVeoPedido(req, 'mascote_uniforme', {
      new_model: { fields: { delivery_mode: 'image' } }
    });
    assert.equal(image.ok, true);
    assert.equal(image.patch, null);
    const crest = api.prepararInternalVeoPedido(req, 'escudo3d', {
      new_model: { fields: { delivery_mode: 'image_video', video_model: 'omni' } }
    });
    assert.equal(crest.ok, true);
    assert.equal(crest.patch.video_generation.first_last_frame_same, true);
  `], {
    cwd: __dirname, env: { ...process.env, MASCOT_OMNI_ENABLED: "false" }, timeout: 30000, stdio: "pipe"
  });
});
