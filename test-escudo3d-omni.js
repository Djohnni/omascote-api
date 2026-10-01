const assert = require("node:assert/strict");
const test = require("node:test");
const fs = require("node:fs");
const { once } = require("node:events");
const os = require("node:os");
const path = require("node:path");
process.env.OMASCOTE_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "omascote-omni-test-"));
process.env.NODE_ENV = "test";
process.env.JWT_SECRET = "local-omni-contract-test-only";
process.env.BOT_ADMIN_WHATSAPP = "admin-omni-test";
process.env.ESCUDO3D_OMNI_ENABLED = "true";
const { app, __resultadoScenarioTest: api, __fotoJogosTest: pricing } = require("./server");
const req = { user: { whatsapp: "cliente-omni-test" } };
function contract(product, delivery = "image_video", model) {
  const fields = { new_model: { fields: { delivery_mode: delivery, ...(model ? { video_model: model } : {}) } } };
  const result = api.prepararInternalVeoPedido(req, product, fields);
  return { result, fields };
}
test("Escudo 3D distingue Fast 8s e Omni 10s no pedido comercial", () => {
  for (const model of [undefined, "fast"]) {
    const { result, fields } = contract("escudo3d", "image_video", model);
    assert.equal(result.ok, true);
    assert.equal(result.patch.video_generation.model, "fast");
    assert.equal(result.patch.video_generation.duration_seconds, 8);
    assert.equal(result.patch.video_generation.first_last_frame_same, undefined);
    assert.equal(fields.new_model.fields.video_model, "fast");
  }
  const { result, fields } = contract("escudo3d", "image_video", "omni");
  assert.equal(result.ok, true);
  const video = result.patch.video_generation;
  assert.equal(video.model, "omni");
  assert.equal(video.model_id, "gemini-omni-1.1-flash-preview");
  assert.equal(video.duration_seconds, 10);
  assert.equal(video.resolution, "720p");
  assert.equal(video.aspect_ratio, "9:16");
  assert.equal(video.generate_audio, true);
  assert.equal(video.first_last_frame_same, true);
  assert.equal(video.location, "global");
  assert.equal(fields.new_model.fields.video_model, "omni");
  assert.equal(contract("escudo3d", "image_video", "lite").result.ok, false);
});
test("Escudo 3D somente imagem permanece sem video", () => {
  assert.equal(contract("escudo3d", "image").result.patch, null);
});
test("Outros produtos conservam Fast 8s e nao permitem Omni", () => {
  for (const product of ["proximo_jogo", "resultado", "mascote_uniforme", "jogador_escudo", "patrocinador"]) {
    const { result } = contract(product);
    assert.equal(result.ok, true, product);
    assert.equal(result.patch.video_generation.model, "fast");
    assert.equal(result.patch.video_generation.duration_seconds, 8);
    assert.equal(result.patch.video_generation.first_last_frame_same, undefined);
    assert.equal(contract(product, "image_video", "omni").result.ok, false);
  }
});
test("Preco comercial do Escudo 3D acompanha o modelo escolhido", () => {
  assert.equal(pricing.getCustoPedidoComAdicionais("escudo3d", {}, {
    new_model: { fields: { delivery_mode: "image_video", video_model: "fast" } }
  }), 14.90);
  assert.equal(pricing.getCustoPedidoComAdicionais("escudo3d", {}, {
    new_model: { fields: { delivery_mode: "image_video", video_model: "omni" } }
  }), 19.90);
  assert.equal(pricing.getCustoPedidoComAdicionais("escudo3d", {}, {
    delivery_mode: "image_video", video_model: "omni"
  }), 19.90);
  assert.equal(pricing.getCustoPedidoComAdicionais("escudo3d", {}, {
    new_model: { fields: { delivery_mode: "image" } }
  }), 4.00);
});

test("Consulta de preco mostra Fast e Omni antes do pagamento", async () => {
  const server = app.listen(0, "127.0.0.1");
  try {
    await once(server, "listening");
    for (const [video_model, expected] of [["fast", 14.90], ["omni", 19.90]]) {
      const response = await fetch(`http://127.0.0.1:${server.address().port}/cupons/preco`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ product_id: "escudo3d", delivery_mode: "image_video", video_model })
      });
      assert.equal(response.status, 200);
      assert.equal((await response.json()).valor_final, expected);
    }
  } finally {
    await new Promise(resolve => server.close(resolve));
  }
});

test("Chave de retorno ao Fast conserva novos pedidos em 8s sem alterar precos", () => {
  const { execFileSync } = require("node:child_process");
  execFileSync(process.execPath, ["-e", `
    const assert = require('node:assert/strict');
    const { __resultadoScenarioTest: api } = require('./server');
    const fields = { new_model: { fields: { delivery_mode: 'image_video', video_model: 'fast' } } };
    const out = api.prepararInternalVeoPedido({user:{whatsapp:'cliente-omni-test'}}, 'escudo3d', fields);
    assert.equal(out.ok, true);
    assert.equal(out.patch.video_generation.model, 'fast');
    assert.equal(out.patch.video_generation.duration_seconds, 8);
    assert.equal(out.patch.video_generation.first_last_frame_same, undefined);
  `], { cwd: __dirname, env: { ...process.env, ESCUDO3D_OMNI_ENABLED: "false" }, timeout: 30000, stdio: "pipe" });
});
