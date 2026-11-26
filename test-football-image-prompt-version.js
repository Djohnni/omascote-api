"use strict";
const assert = require("node:assert/strict");
const test = require("node:test");
const { buildPedidoData } = require("./src/orders/order.service");
const catalog = require("./src/orders/futebol-omni/catalog.json");
const products = [...new Set(catalog.map(row => row.product))];
function build(categoria, sport, delivery_mode = "image", extras = {}) {
  const fields = { rodada: "Fixture", data: "2026-11-25", new_model: {
    schema_version: 2, product_id: categoria, fields: { ...(sport === undefined ? {} : {sport}), delivery_mode, ...extras }
  }};
  const before = JSON.stringify(fields);
  const pedido = buildPedidoData({ categoria, id: "fixture", whatsapp: "fixture", mesAtual: "2026-11",
    fields, files: {}, pats: [] });
  assert.equal(JSON.stringify(fields), before);
  return pedido;
}
test("new orders for the eight gallery products receive the current image policy in every selected sport", () => {
  assert.equal(products.length, 8);
  for (const product of products) for (const mode of ["image", "image_video"]) for (const sport of ["Futebol", "Futsal", "Basquete", "Vôlei", "Tênis", "Parkour personalizado"]) {
    const order = build(product, sport, mode);
    assert.equal(order.image_prompt_version, "football_field_v2");
    assert.equal(order.fields.sport, sport);
    assert.equal(order.fields.delivery_mode, mode);
    assert.equal(order.video_generation, undefined);
  }
});
test("absent or invalid sport and standalone crest or mascot never acquire the shared image flag", () => {
  for (const product of products) for (const sport of [undefined, "", "  ", null, {}, []]) {
    assert.equal(Object.hasOwn(build(product, sport), "image_prompt_version"), false);
  }
  for (const product of ["escudo3d", "mascote_uniforme", "unknown"]) {
    assert.equal(Object.hasOwn(build(product, "Futebol", "image", {image_prompt_version:"football_field_v2"}), "image_prompt_version"), false);
  }
});
