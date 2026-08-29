const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const jwt = require("jsonwebtoken");

process.env.NODE_ENV = "test";
process.env.JWT_SECRET = "contratacao-product-test-secret";
process.env.OMASCOTE_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "omascote-contratacao-test-"));
delete process.env.MP_ACCESS_TOKEN;
delete process.env.OPENAI_API_KEY;

const PRODUCTS = require("./src/products/products");
const { app, __fotoJogosTest, __resultadoScenarioTest } = require("./server");

const TEST_USER = "551199887766";
const CLIENTES_FILE = path.join(process.env.OMASCOTE_DATA_DIR, "clientes.json");
const PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Y9Z8HkAAAAASUVORK5CYII=",
  "base64"
);

function createTestClient() {
  fs.writeFileSync(CLIENTES_FILE, JSON.stringify({
    [TEST_USER]: {
      id: TEST_USER,
      cliente_id: TEST_USER,
      whatsapp: TEST_USER,
      nome_time: "Clube Teste",
      plano: "teste",
      ativo: true,
      saldo_extra: 0,
      saldo_mensal: 0,
      usados_no_ciclo: 0,
      ciclo_mes: new Date().toISOString().slice(0, 7).replace("-", ""),
      brinde_mascote_disponivel: false,
      brinde_mascote_ja_liberado: true,
      brinde_escudo3d_app_usado: true
    }
  }, null, 2));
}

function batchBody(fields) {
  return {
    schema_version: "3",
    product_id: "contratacao",
    flyer_tipo: "zz1fm",
    rodada: fields.announcement_type === "renovado" ? "RENOVADO" : "CONTRATADO",
    data: fields.player_name,
    hora: fields.player_position,
    jogadores_json: JSON.stringify([{ nome: fields.player_name, posicao: fields.player_position }]),
    jogadores_texto: `${fields.player_name} - ${fields.player_position}`,
    fields_json: JSON.stringify(fields),
    assets_json: "{}"
  };
}

function jogadorEscudoBatchBody(name) {
  return {
    schema_version: "3",
    product_id: "jogador_escudo",
    flyer_tipo: "jog_escudo",
    rodada: "Jogador + escudo",
    data: name,
    jogadores_json: JSON.stringify([{ nome: name, posicao: "" }]),
    jogadores_texto: name,
    fields_json: JSON.stringify({ player_name: name, scenario_id: "jogador_escudo_atual_v1" }),
    assets_json: "{}"
  };
}

function validFields(overrides = {}) {
  return {
    contratacao_version: 3,
    announcement_type: "contratado",
    player_name: "Jhuan",
    player_position: "Zagueiro",
    style_mode: "catalog",
    sample_id: "contratacao_modelo_02_v1",
    jersey_enabled: false,
    ...overrides
  };
}

function validFiles(overrides = {}) {
  return {
    escudo1: [{}],
    escudo2: [{}],
    ...overrides
  };
}

test("contratacao tem preco-base exclusivo de R$ 7,80", () => {
  assert.equal(PRODUCTS.contratacao.price, 7.8);
  assert.equal(__fotoJogosTest.getCustoPedidoComAdicionais("contratacao", null, validFields()), 7.8);
});

test("camiseta acrescenta R$ 2,00 e totaliza R$ 9,80", () => {
  const fields = validFields({ jersey_enabled: true });
  assert.equal(__fotoJogosTest.contratacaoTemCamiseta(fields), true);
  assert.equal(__fotoJogosTest.getCustoPedidoComAdicionais("contratacao", null, fields), 9.8);
});

test("amostra, referencia propria e camiseta sao validadas no servidor", () => {
  const catalog = __fotoJogosTest.validarContratoContratacao({
    fields: validFields({ sample_id: "contratacao_modelo_03_v1" }),
    files: validFiles(),
    requireVersion: true
  });
  assert.equal(catalog.ok, true);

  const customMissing = __fotoJogosTest.validarContratoContratacao({
    fields: validFields({ style_mode: "custom", sample_id: "" }),
    files: validFiles(),
    requireVersion: true
  });
  assert.equal(customMissing.ok, false);
  assert.match(customMissing.errors.join(" "), /referencia/i);

  const jerseyMissing = __fotoJogosTest.validarContratoContratacao({
    fields: validFields({ jersey_enabled: true }),
    files: validFiles(),
    requireVersion: true
  });
  assert.equal(jerseyMissing.ok, false);
  assert.match(jerseyMissing.errors.join(" "), /camiseta/i);

  const complete = __fotoJogosTest.validarContratoContratacao({
    fields: validFields({ style_mode: "custom", sample_id: "", jersey_enabled: true }),
    files: validFiles({ referencia: [{}], camiseta: [{}] }),
    requireVersion: true
  });
  assert.equal(complete.ok, true);
});

test("contratacao e jogador + escudo aceitam ate 10 itens por lote", () => {
  const contratacoes = Array.from({ length: 10 }, () => ({ product_id: "contratacao" }));
  const jogadoresEscudo = Array.from({ length: 10 }, () => ({ product_id: "jogador_escudo" }));
  const loteComum = Array.from({ length: 4 }, () => ({ product_id: "resultado" }));

  assert.equal(__fotoJogosTest.getFotoJogosBatchMaxItems(contratacoes), 10);
  assert.equal(__fotoJogosTest.getFotoJogosBatchMaxItems(jogadoresEscudo), 10);
  assert.equal(__fotoJogosTest.getFotoJogosBatchMaxItems(loteComum), 3);
});

test("auditoria registra o prompt e os campos estruturados da contratacao", () => {
  const fields = {
    rodada: "CONTRATADO",
    data: "Jhuan",
    new_model: { fields: validFields() }
  };
  const audit = __resultadoScenarioTest.gerarAuditoriaGeracaoLegada({
    categoria: "contratacao",
    fields,
    files: validFiles(),
    request: { originalUrl: "/pedidos" }
  });
  assert.equal(audit.arquivo_prompt, "prompt_contratacao.txt");
  assert.equal(audit.prompt_sha256, "03bbbfc17ec278d653b04ca43734dd47e8944d352b718fec21aa315be7d82dd7");
  assert.ok(audit.campos_estruturados_presentes.includes("style_mode"));
});

test("lote cria pedidos antecipados de R$ 7,80 e R$ 9,80", async () => {
  createTestClient();
  const server = app.listen(0, "127.0.0.1");
  await new Promise(resolve => server.once("listening", resolve));

  try {
    const port = server.address().port;
    const token = jwt.sign({ whatsapp: TEST_USER, cliente_id: TEST_USER }, process.env.JWT_SECRET, { expiresIn: "1h" });
    const first = validFields({ player_name: "Jhuan", jersey_enabled: false });
    const second = validFields({ player_name: "Carlos", announcement_type: "renovado", jersey_enabled: true });
    const form = new FormData();
    form.append("batch_id", "contratacao_batch_test");
    form.append("items_json", JSON.stringify([
      {
        product_id: "contratacao",
        client_request_id: "contratacao_batch_item_1",
        modalidade_criacao: "com_suporte",
        fields: batchBody(first),
        files: { escudo1: "item_0_escudo1", escudo2: "item_0_escudo2" }
      },
      {
        product_id: "contratacao",
        client_request_id: "contratacao_batch_item_2",
        modalidade_criacao: "com_suporte",
        fields: batchBody(second),
        files: { escudo1: "item_1_escudo1", escudo2: "item_1_escudo2", camiseta: "item_1_camiseta" }
      }
    ]));
    ["item_0_escudo1", "item_0_escudo2", "item_1_escudo1", "item_1_escudo2", "item_1_camiseta"].forEach(name => {
      form.append(name, new Blob([PNG], { type: "image/png" }), `${name}.png`);
    });

    const response = await fetch(`http://127.0.0.1:${port}/me/time/jogos/criar-artes`, {
      method: "POST",
      headers: { Authorization: `Bearer ${token}`, "X-Idempotency-Key": "contratacao_batch_test" },
      body: form
    });
    const payload = await response.json();
    assert.equal(response.status, 200, JSON.stringify(payload));
    assert.equal(payload.criados.length, 2, JSON.stringify(payload));
    assert.deepEqual(payload.criados.map(item => item.valor_final), [7.8, 9.8]);
    assert.ok(payload.criados.every(item => item.pagamento_pendente === true));
  } finally {
    await new Promise(resolve => server.close(resolve));
  }
});

test("jogador + escudo aceita mais de 3 jogadores e segura a criacao ate o pagamento", async () => {
  createTestClient();
  const server = app.listen(0, "127.0.0.1");
  await new Promise(resolve => server.once("listening", resolve));

  try {
    const port = server.address().port;
    const token = jwt.sign({ whatsapp: TEST_USER, cliente_id: TEST_USER }, process.env.JWT_SECRET, { expiresIn: "1h" });
    const form = new FormData();
    const items = Array.from({ length: 4 }, (_, index) => ({
      product_id: "jogador_escudo",
      client_request_id: `jogador_escudo_batch_item_${index + 1}`,
      modalidade_criacao: "com_suporte",
      fields: jogadorEscudoBatchBody(`Jogador ${index + 1}`),
      files: {
        escudo1: `item_${index}_escudo1`,
        mascote: `item_${index}_mascote`
      }
    }));

    form.append("batch_id", "jogador_escudo_batch_test");
    form.append("items_json", JSON.stringify(items));
    items.forEach((_, index) => {
      ["escudo1", "mascote"].forEach(key => {
        const field = `item_${index}_${key}`;
        form.append(field, new Blob([PNG], { type: "image/png" }), `${field}.png`);
      });
    });

    const response = await fetch(`http://127.0.0.1:${port}/me/time/jogos/criar-artes`, {
      method: "POST",
      headers: { Authorization: `Bearer ${token}`, "X-Idempotency-Key": "jogador_escudo_batch_test" },
      body: form
    });
    const payload = await response.json();

    assert.equal(response.status, 200, JSON.stringify(payload));
    assert.equal(payload.criados.length, 4, JSON.stringify(payload));
    assert.ok(payload.criados.every(item => item.valor_final === 6));
    assert.ok(payload.criados.every(item => item.pagamento_pendente === true));
    assert.ok(payload.criados.every(item => item.requer_pix_antes_criacao === true));
  } finally {
    await new Promise(resolve => server.close(resolve));
  }
});
