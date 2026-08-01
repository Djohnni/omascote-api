const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");

const TEST_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "omascote-multi-scenario-"));

process.env.NODE_ENV = "test";
process.env.OMASCOTE_DATA_DIR = TEST_DATA_DIR;
process.env.JWT_SECRET = "multi-scenario-test-secret";
delete process.env.MP_ACCESS_TOKEN;
delete process.env.OPENAI_API_KEY;

const { __resultadoScenarioTest } = require("./server");

const {
  registry,
  buildOrderScenarioContext,
  buildOrderResponsePayloadFromItem,
  buildOrderCreateDedupeMeta,
  buildFotoJogosBatchPayloadHash,
  evaluatePersistentOrderReplay,
  gerarAuditoriaGeracaoLegada,
  getUploadedFilesFingerprint
} = __resultadoScenarioTest;

const VARIANTS = Object.freeze([
  "atual",
  "sol",
  "noite",
  "chuva",
  "estadio_grande_dia",
  "estadio_varzea_dia",
  "fumaca",
  "futsal"
]);

const PRODUCTS = Object.freeze([
  { id: "resultado", flyerTipo: "", prompt: "prompt_resultado.txt" },
  { id: "proximo_jogo", flyerTipo: "zz1ft", prompt: "prompt_proximo_jogo.txt" },
  { id: "jogador_escudo", flyerTipo: "jog_escudo", prompt: "prompt_jogador_escudo.txt" },
  { id: "mascote_uniforme", flyerTipo: "mascote_uniforme", prompt: "prompt_mascote_uniforme.txt" },
  { id: "escalacao", flyerTipo: "zz1fs", prompt: "prompt_escalacao.txt" }
]);

function scenarioId(productId, variant) {
  return `${productId}_${variant}_v1`;
}

function baseBody(product, structured) {
  return {
    schema_version: 2,
    product_id: product.id,
    flyer_tipo: product.flyerTipo,
    rodada: "Pedido de teste",
    data: "01/08/2026",
    hora: "Competicao de teste",
    fields_json: JSON.stringify(structured || {})
  };
}

function contextFor(product, structured) {
  return buildOrderScenarioContext(product.id, baseBody(product, structured));
}

function requestFor({ key = "same-key", body = {}, files = {} } = {}) {
  const headers = { "x-idempotency-key": key };
  return {
    headers,
    body,
    files,
    user: { whatsapp: "551199990000" },
    get(name) {
      return headers[String(name || "").toLowerCase()] || "";
    }
  };
}

function assertScenarioError(product, body, expectedCode) {
  assert.throws(
    () => buildOrderScenarioContext(product.id, body),
    error => error?.code === expectedCode,
    `${product.id} deveria falhar com ${expectedCode}`
  );
}

test.after(() => {
  fs.rmSync(TEST_DATA_DIR, { recursive: true, force: true });
});

test("registro possui matriz exata de 5 produtos por 8 cenarios", () => {
  assert.deepEqual(Object.keys(registry.SCENARIO_PRODUCTS), PRODUCTS.map(product => product.id));
  assert.deepEqual(registry.SCENARIO_VARIANTS, VARIANTS);
  assert.equal(Object.keys(registry.SCENARIOS).length, PRODUCTS.length * VARIANTS.length);

  for (const product of PRODUCTS) {
    const definition = registry.SCENARIO_PRODUCTS[product.id];
    assert.equal(definition.defaultScenarioId, scenarioId(product.id, "atual"));
    assert.deepEqual(
      Object.keys(definition.scenarios),
      VARIANTS.map(variant => scenarioId(product.id, variant))
    );

    for (const variant of VARIANTS) {
      const scenario = definition.scenarios[scenarioId(product.id, variant)];
      assert.equal(scenario.product_id, product.id);
      assert.equal(scenario.version, 1);
      assert.equal(scenario.status, "active");
    }
  }

  assert.deepEqual(registry.RESULTADO_RESERVED_SCENARIO_IDS, [
    "resultado_estadio_noturno_v1",
    "resultado_estadio_dia_v1"
  ]);
  assert.strictEqual(registry.RESULTADO_SCENARIOS, registry.SCENARIO_PRODUCTS.resultado.scenarios);
});

test("matriz normal 5x8 resolve e persiste o par produto/cenario", () => {
  for (const product of PRODUCTS) {
    for (const variant of VARIANTS) {
      const expectedId = scenarioId(product.id, variant);
      const context = contextFor(product, { scenario_id: expectedId });
      const clean = context.fields.new_model;

      assert.equal(context.resolution.product.id, product.id);
      assert.equal(context.resolution.scenario.id, expectedId);
      assert.equal(context.resolution.source, "explicit");
      assert.equal(clean.schema_version, 2);
      assert.equal(clean.product_id, product.id);
      assert.equal(clean.fields.scenario_id, expectedId);
      assert.equal(clean.fields.scenario_version, 1);
      assert.equal(clean.fields.scenario_source, "explicit");

      const storedMeta = registry.getPedidoScenarioMeta({
        product_id: product.id,
        categoria: product.id,
        fields: clean.fields
      });
      assert.deepEqual(storedMeta, {
        scenario_id: expectedId,
        scenario_version: 1,
        scenario_source: "explicit"
      });
    }
  }
});

test("ausencia usa o default proprio e pedidos antigos continuam compativeis", () => {
  for (const product of PRODUCTS) {
    const expectedId = scenarioId(product.id, "atual");
    const context = contextFor(product, {});

    assert.equal(context.resolution.source, "default");
    assert.equal(context.fields.new_model.product_id, product.id);
    assert.equal(context.fields.new_model.fields.scenario_id, expectedId);
    assert.equal(context.fields.new_model.fields.scenario_version, 1);
    assert.equal(context.fields.new_model.fields.scenario_source, "default");

    assert.deepEqual(registry.getPedidoScenarioMeta({ categoria: product.id }), {
      scenario_id: expectedId,
      scenario_version: 1,
      scenario_source: "default"
    });
  }

  const unsupported = buildOrderScenarioContext("patrocinador", {
    rodada: "Patrocinador",
    data: "01/08/2026"
  });
  assert.equal(unsupported.resolution.applies, false);
  assert.deepEqual(registry.getPedidoScenarioMeta({ categoria: "patrocinador" }), {
    scenario_id: "",
    scenario_version: 0,
    scenario_source: ""
  });
});

test("matriz batch 5x8 inclui cada cenario no fingerprint canonico", () => {
  const hashes = new Set();

  for (const product of PRODUCTS) {
    const productHashes = new Set();

    for (const variant of VARIANTS) {
      const id = scenarioId(product.id, variant);
      const req = requestFor({ body: {}, files: [] });
      const hash = buildFotoJogosBatchPayloadHash(req, "batch-matrix", [{
        product_id: product.id,
        client_request_id: "item-1",
        modalidade_criacao: "com_suporte",
        fields: baseBody(product, { scenario_id: id }),
        files: {}
      }]);

      assert.equal(productHashes.has(hash), false, `${product.id}/${id} repetiu hash`);
      productHashes.add(hash);
      hashes.add(hash);
    }

    assert.equal(productHashes.size, VARIANTS.length);
  }

  assert.equal(hashes.size, PRODUCTS.length * VARIANTS.length);
});

test("default e atual explicito sao semanticamente idempotentes; outro cenario conflita", () => {
  for (const product of PRODUCTS) {
    const defaultContext = contextFor(product, {});
    const explicitContext = contextFor(product, {
      scenario_id: scenarioId(product.id, "atual")
    });
    const otherContext = contextFor(product, {
      scenario_id: scenarioId(product.id, "sol")
    });
    const req = requestFor({ key: `idem-${product.id}` });

    const defaultMeta = buildOrderCreateDedupeMeta(
      req,
      product.id,
      req.user.whatsapp,
      defaultContext.fields
    );
    const explicitMeta = buildOrderCreateDedupeMeta(
      req,
      product.id,
      req.user.whatsapp,
      explicitContext.fields
    );
    const otherMeta = buildOrderCreateDedupeMeta(
      req,
      product.id,
      req.user.whatsapp,
      otherContext.fields
    );

    assert.equal(defaultMeta.payloadHash, explicitMeta.payloadHash);
    assert.notEqual(defaultMeta.payloadHash, otherMeta.payloadHash);
  }
});

test("replay v2 pre-rollout aceita apenas default com mesmos dados e bytes", () => {
  const preRolloutProducts = PRODUCTS.filter(product => product.id !== "resultado");
  const bytesA = Buffer.from([10, 20, 30, 40]);
  const bytesB = Buffer.from([10, 20, 30, 41]);
  const makeFile = (buffer, originalname = "mesmo.png") => ({
    fieldname: "escudo1",
    originalname,
    mimetype: "image/png",
    detected_mimetype: "image/png",
    size: buffer.length,
    buffer
  });

  for (const product of preRolloutProducts) {
    const body = baseBody(product, { titulo: "Mesmo pedido" });
    const context = buildOrderScenarioContext(product.id, body);
    const oldRequest = requestFor({
      key: `pre-rollout-${product.id}`,
      body,
      files: { escudo1: [makeFile(bytesA, "nome-antigo.png")] }
    });
    const request = requestFor({
      key: `pre-rollout-${product.id}`,
      body,
      files: { escudo1: [makeFile(bytesA, "nome-novo.png")] }
    });
    const oldV2Meta = buildOrderCreateDedupeMeta(
      oldRequest,
      product.id,
      request.user.whatsapp,
      context.legacyFields
    );
    const currentMeta = buildOrderCreateDedupeMeta(
      request,
      product.id,
      request.user.whatsapp,
      context.fields,
      { legacyFields: context.legacyFields }
    );
    const storedOrder = {
      categoria: product.id,
      product_id: product.id,
      fields: { titulo: "Mesmo pedido" },
      idempotency_payload_hash_version: 2,
      idempotency_payload_hash: oldV2Meta.payloadHash
    };

    assert.equal(currentMeta.preScenarioDefaultCompatibilityV2.eligible, true);
    assert.equal(
      currentMeta.preScenarioDefaultCompatibilityV2.payloadHash,
      oldV2Meta.payloadHash
    );
    assert.deepEqual(evaluatePersistentOrderReplay(storedOrder, currentMeta), {
      replay: true,
      mode: "v2_pre_scenario_default_compat"
    });

    const storedWithScenario = {
      ...storedOrder,
      fields: { scenario_id: scenarioId(product.id, "atual") }
    };
    assert.equal(
      evaluatePersistentOrderReplay(storedWithScenario, currentMeta).conflict,
      true,
      `${product.id}: pedido com metadata nao usa compatibilidade`
    );

    const changedBody = { ...body, rodada: "Pedido alterado" };
    const changedContext = buildOrderScenarioContext(product.id, changedBody);
    const changedMeta = buildOrderCreateDedupeMeta(
      requestFor({
        key: `pre-rollout-${product.id}`,
        body: changedBody,
        files: { escudo1: [makeFile(bytesA)] }
      }),
      product.id,
      request.user.whatsapp,
      changedContext.fields,
      { legacyFields: changedContext.legacyFields }
    );
    assert.equal(evaluatePersistentOrderReplay(storedOrder, changedMeta).conflict, true);

    const changedBytesMeta = buildOrderCreateDedupeMeta(
      requestFor({
        key: `pre-rollout-${product.id}`,
        body,
        files: { escudo1: [makeFile(bytesB)] }
      }),
      product.id,
      request.user.whatsapp,
      context.fields,
      { legacyFields: context.legacyFields }
    );
    assert.equal(evaluatePersistentOrderReplay(storedOrder, changedBytesMeta).conflict, true);

    const nonDefaultContext = contextFor(product, {
      scenario_id: scenarioId(product.id, "sol")
    });
    const nonDefaultMeta = buildOrderCreateDedupeMeta(
      request,
      product.id,
      request.user.whatsapp,
      nonDefaultContext.fields,
      { legacyFields: nonDefaultContext.legacyFields }
    );
    assert.equal(nonDefaultMeta.preScenarioDefaultCompatibilityV2.eligible, false);
    assert.equal(evaluatePersistentOrderReplay(storedOrder, nonDefaultMeta).conflict, true);

    const explicitDefaultContext = buildOrderScenarioContext(
      product.id,
      baseBody(product, {
        titulo: "Mesmo pedido",
        scenario_id: scenarioId(product.id, "atual")
      })
    );
    const explicitDefaultMeta = buildOrderCreateDedupeMeta(
      request,
      product.id,
      request.user.whatsapp,
      explicitDefaultContext.fields,
      { legacyFields: explicitDefaultContext.legacyFields }
    );
    assert.equal(explicitDefaultMeta.preScenarioDefaultCompatibilityV2.eligible, true);
    assert.deepEqual(evaluatePersistentOrderReplay(storedOrder, explicitDefaultMeta), {
      replay: true,
      mode: "v2_pre_scenario_default_compat"
    });

    assert.notEqual(currentMeta.legacyPayloadHash, oldV2Meta.payloadHash);
    assert.equal(evaluatePersistentOrderReplay({
      ...storedOrder,
      idempotency_payload_hash: currentMeta.legacyPayloadHash
    }, currentMeta).conflict, true, `${product.id}: fingerprint por nome/tamanho rejeitado`);
  }
});

test("hash por bytes reais continua distinguindo uploads com mesmos metadados", () => {
  const makeFile = buffer => ({
    fieldname: "escudo1",
    originalname: "mesmo.png",
    mimetype: "image/png",
    detected_mimetype: "image/png",
    size: buffer.length,
    buffer
  });
  const bytesA = Buffer.from([1, 2, 3, 4]);
  const bytesB = Buffer.from([1, 2, 3, 5]);
  const fingerprintA = getUploadedFilesFingerprint({ escudo1: [makeFile(bytesA)] });
  const fingerprintB = getUploadedFilesFingerprint({ escudo1: [makeFile(bytesB)] });

  assert.equal(fingerprintA[0].size, fingerprintB[0].size);
  assert.equal(fingerprintA[0].mimetype, fingerprintB[0].mimetype);
  assert.notEqual(fingerprintA[0].sha256, fingerprintB[0].sha256);

  const product = PRODUCTS[0];
  const context = contextFor(product, { scenario_id: scenarioId(product.id, "atual") });
  const metaA = buildOrderCreateDedupeMeta(
    requestFor({ files: { escudo1: [makeFile(bytesA)] } }),
    product.id,
    "551199990000",
    context.fields
  );
  const metaB = buildOrderCreateDedupeMeta(
    requestFor({ files: { escudo1: [makeFile(bytesB)] } }),
    product.id,
    "551199990000",
    context.fields
  );
  assert.notEqual(metaA.payloadHash, metaB.payloadHash);
});

test("seguranca rejeita cross-product, desconhecido, caminho, longo, flat, nested e duplicado", () => {
  for (let index = 0; index < PRODUCTS.length; index += 1) {
    const product = PRODUCTS[index];
    const other = PRODUCTS[(index + 1) % PRODUCTS.length];

    assertScenarioError(
      product,
      baseBody(product, { scenario_id: scenarioId(other.id, "atual") }),
      "SCENARIO_PRODUCT_MISMATCH"
    );
    assertScenarioError(
      product,
      baseBody(product, { scenario_id: `${product.id}_inexistente_v1` }),
      "SCENARIO_UNKNOWN"
    );
    assertScenarioError(
      product,
      baseBody(product, { scenario_id: "../prompt.txt" }),
      "SCENARIO_INVALID"
    );
    assertScenarioError(
      product,
      baseBody(product, { scenario_id: "a".repeat(65) }),
      "SCENARIO_INVALID"
    );
    assertScenarioError(
      product,
      {
        ...baseBody(product, {}),
        scenario_id: scenarioId(product.id, "atual")
      },
      "SCENARIO_TAMPERED"
    );
    assertScenarioError(
      product,
      baseBody(product, { extras: { scenario_id: scenarioId(product.id, "atual") } }),
      "SCENARIO_TAMPERED"
    );
    assertScenarioError(
      product,
      {
        ...baseBody(product, {}),
        fields_json: `{"scenario_id":"${scenarioId(product.id, "atual")}","scenario_id":"${scenarioId(product.id, "sol")}"}`
      },
      "SCENARIO_DUPLICATE_INPUT"
    );
    assertScenarioError(
      product,
      {
        ...baseBody(product, { scenario_id: scenarioId(product.id, "atual") }),
        fields: JSON.stringify({ scenario_id: scenarioId(product.id, "atual") })
      },
      "SCENARIO_DUPLICATE_INPUT"
    );
    assertScenarioError(
      product,
      baseBody(product, {
        scenario_id: scenarioId(product.id, "atual"),
        scenario_version: 1
      }),
      "SCENARIO_TAMPERED"
    );
    assertScenarioError(
      product,
      {
        ...baseBody(product, { scenario_id: scenarioId(product.id, "atual") }),
        product_id: other.id
      },
      "SCENARIO_PRODUCT_MISMATCH"
    );
  }

  for (const reservedId of registry.RESULTADO_RESERVED_SCENARIO_IDS) {
    assertScenarioError(
      PRODUCTS[0],
      baseBody(PRODUCTS[0], { scenario_id: reservedId }),
      "SCENARIO_RESERVED"
    );
  }
});

test("observacao e ajuste detectam comandos e negacoes nos cinco produtos", () => {
  const commands = [
    "Quero outro fundo.",
    "Deixe o cenario noturno.",
    "Defina o fundo como um estadio grande.",
    "Escolha um cenario de futsal.",
    "Use chuva.",
    "Coloque sol.",
    "Adicione um fundo com fumaca.",
    "Mude para dia.",
    "Troque para dia.",
    "Quero uma imagem de dia.",
    "Faca um fundo de noite.",
    "Fazer uma arte de dia.",
    "Crie um cenario de futsal.",
    "Criar um fundo com fumaca.",
    "Bote chuva no fundo.",
    "Botar sol no cenario.",
    "Ponha noite no fundo.",
    "P\u00f4r chuva no fundo.",
    "Selecione futsal.",
    "Configure o ambiente para noite."
  ];
  const negated = [
    "Nao quero mudar o cenario.",
    "Nao deixe o fundo noturno.",
    "Nunca defina outro fundo.",
    "Sem escolher outro cenario.",
    "Nao use chuva.",
    "Nao coloque sol.",
    "Quero que nao mude o fundo.",
    "Evite usar outro cenario."
  ];
  const neutral = [
    "A torcida aparece ao fundo.",
    "Cenario atual aprovado.",
    "O jogo sera a noite no estadio municipal.",
    "Quero destacar o resultado do dia.",
    "Use o escudo sem alterar o fundo.",
    "Mude o dia do jogo para domingo.",
    "Use o campo de observacoes para mostrar o campeonato.",
    "Quero a frase: hoje e dia de vitoria."
  ];

  for (const product of PRODUCTS) {
    for (const phrase of commands) {
      assertScenarioError(
        product,
        baseBody(product, {
          scenario_id: scenarioId(product.id, "atual"),
          customer_notes: phrase
        }),
        "SCENARIO_OBSERVATION_CONFLICT"
      );
    }

    for (const phrase of [...negated, ...neutral]) {
      const allowed = contextFor(product, {
        scenario_id: scenarioId(product.id, "atual"),
        customer_notes: phrase
      });
      assert.equal(
        allowed.resolution.scenario.id,
        scenarioId(product.id, "atual"),
        `${product.id}: falso positivo em ${phrase}`
      );
    }
  }

  assert.equal(
    registry.hasScenarioObservationConflict(
      "Nao mude o cenario, mas use outro fundo."
    ),
    true
  );
});

test("resposta e auditoria carregam cenario para todos, inclusive mascote", () => {
  for (const product of PRODUCTS) {
    const id = scenarioId(product.id, "futsal");
    const context = contextFor(product, { scenario_id: id });
    const pedido = {
      id: `pedido-${product.id}`,
      product_id: product.id,
      categoria: product.id,
      fields: context.fields.new_model.fields,
      status: "novo",
      criado_em: "2026-08-01T00:00:00.000Z"
    };
    const response = buildOrderResponsePayloadFromItem({ pedido });
    const audit = gerarAuditoriaGeracaoLegada({
      categoria: product.id,
      fields: context.fields,
      files: {},
      request: { originalUrl: "/pedidos" }
    });

    assert.equal(response.scenario_id, id);
    assert.equal(response.scenario_version, 1);
    assert.equal(response.scenario_source, "explicit");
    assert.ok(audit, `${product.id} precisa de contrato de auditoria`);
    assert.equal(audit.produto_equivalente, product.id);
    assert.equal(audit.arquivo_prompt, product.prompt);
    assert.equal(audit.scenario_id, id);
    assert.equal(audit.scenario_version, 1);
    assert.equal(audit.scenario_source, "explicit");
    assert.equal(audit.parametros_esperados.quality, "medium");
    assert.equal(
      Object.prototype.hasOwnProperty.call(
        audit.parametros_esperados,
        "input_fidelity"
      ),
      false
    );
    if (product.id === "proximo_jogo") {
      assert.equal(
        audit.prompt_sha256,
        "52332d764971c58dbf076c6fd0bced4ad9267e1e1362fc6ae698170b59bd2605"
      );
    }
  }
});

test("regressoes: aliases Resultado e exports antigos continuam validos", () => {
  for (const alias of ["resultado", "resultado_jogo", "resultado_do_jogo"]) {
    const resolution = registry.resolveResultadoScenario({
      categoria: "resultado",
      body: {
        product_id: alias,
        fields_json: JSON.stringify({ scenario_id: "resultado_atual_v1" })
      }
    });
    assert.equal(resolution.scenario.id, "resultado_atual_v1");
  }

  assert.equal(registry.RESULTADO_DEFAULT_SCENARIO_ID, "resultado_atual_v1");
  assert.equal(registry.RESULTADO_SCENARIO_SCHEMA_VERSION, 2);
  assert.equal(registry.RESULTADO_PRODUCT_ID, "resultado");
});
