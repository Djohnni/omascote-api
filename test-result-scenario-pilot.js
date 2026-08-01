const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");

const TEST_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "omascote-result-scenario-"));
const TEST_JWT_SECRET = "resultado-scenario-test-secret";
const TEST_USER = "551199990001";
const TEST_BATCH_USER = "551199990002";
const CURRENT_MONTH = new Date().toISOString().slice(0, 7).replace("-", "");

process.env.NODE_ENV = "test";
process.env.OMASCOTE_DATA_DIR = TEST_DATA_DIR;
process.env.JWT_SECRET = TEST_JWT_SECRET;
process.env.BOT_ADMIN_WHATSAPP = "551199999999";
delete process.env.MP_ACCESS_TOKEN;
delete process.env.OPENAI_API_KEY;

const jwt = require("jsonwebtoken");
const {
  app,
  __resultadoScenarioTest
} = require("./server");

const CLIENTES_FILE = path.join(TEST_DATA_DIR, "clientes.json");
const PEDIDOS_DIR = path.join(TEST_DATA_DIR, "pedidos");
const AUDIT_FILE = path.join(TEST_DATA_DIR, "produto_auditoria.jsonl");
const PNG_A = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Y9Z8HkAAAAASUVORK5CYII=",
  "base64"
);
const PNG_B = Buffer.from(PNG_A);
PNG_B[20] ^= 0xff;

const RESULTADO_NEW_SCENARIO_IDS = Object.freeze([
  "resultado_sol_v1",
  "resultado_noite_v1",
  "resultado_chuva_v1",
  "resultado_estadio_grande_dia_v1",
  "resultado_estadio_varzea_dia_v1",
  "resultado_fumaca_v1",
  "resultado_futsal_v1"
]);
const RESULTADO_RESERVED_SCENARIO_IDS = Object.freeze([
  "resultado_estadio_noturno_v1",
  "resultado_estadio_dia_v1"
]);

function readJson(file, fallback = {}) {
  try {
    return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch {
    return fallback;
  }
}

function writeJson(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(value, null, 2), "utf8");
}

function putClient(whatsapp, saldo = 1000) {
  const clientes = readJson(CLIENTES_FILE, {});
  clientes[whatsapp] = {
    id: whatsapp,
    cliente_id: whatsapp,
    whatsapp,
    nome_time: `Teste ${whatsapp}`,
    plano: "teste",
    ativo: true,
    saldo_extra: saldo,
    saldo_mensal: 0,
    usados_no_ciclo: 0,
    ciclo_mes: CURRENT_MONTH,
    brinde_mascote_disponivel: false,
    brinde_mascote_ja_liberado: true,
    brinde_escudo3d_app_usado: true
  };
  writeJson(CLIENTES_FILE, clientes);
}

function tokenFor(whatsapp) {
  return jwt.sign(
    { whatsapp, cliente_id: whatsapp },
    TEST_JWT_SECRET,
    { expiresIn: "1h" }
  );
}

async function api(baseUrl, method, endpoint, options = {}) {
  const headers = { ...(options.headers || {}) };
  if (options.user) headers.Authorization = `Bearer ${tokenFor(options.user)}`;
  if (options.body !== undefined) headers["Content-Type"] = "application/json";

  const response = await fetch(`${baseUrl}${endpoint}`, {
    method,
    headers,
    body: options.form || (options.body === undefined ? undefined : JSON.stringify(options.body))
  });
  const contentType = response.headers.get("content-type") || "";
  const payload = contentType.includes("application/json")
    ? await response.json()
    : Buffer.from(await response.arrayBuffer());

  return { response, payload };
}

function appendBaseResultFields(form, overrides = {}) {
  const values = {
    flyer_tipo: "resultado",
    rodada: "Rodada 1",
    data: "30/07/2026",
    hora: "Campeonato Teste",
    time_principal: "Time A",
    time_adversario: "Time B",
    gols_time_principal: "2",
    gols_adversario: "1",
    ...overrides
  };

  for (const [key, value] of Object.entries(values)) {
    if (value !== undefined && value !== null) form.append(key, String(value));
  }
}

function resultForm(options = {}) {
  const form = new FormData();
  appendBaseResultFields(form, options.legacy || {});

  if (options.productId !== undefined) form.append("product_id", String(options.productId));
  if (options.categoria !== undefined) form.append("categoria", String(options.categoria));
  if (options.flatScenario !== undefined) form.append("scenario_id", String(options.flatScenario));
  if (options.flatScenarioText !== undefined) form.append("scenario_text", String(options.flatScenarioText));
  if (options.flatScenarioPrompt !== undefined) form.append("scenario_prompt", String(options.flatScenarioPrompt));
  if (options.flatScenarioPath !== undefined) form.append("scenario_path", String(options.flatScenarioPath));

  if (options.fieldsJsonRaw !== undefined) {
    form.append("fields_json", options.fieldsJsonRaw);
  } else if (options.structured !== undefined) {
    form.append("fields_json", JSON.stringify(options.structured));
  }

  if (options.fieldsAlias !== undefined) {
    form.append(
      "fields",
      typeof options.fieldsAlias === "string"
        ? options.fieldsAlias
        : JSON.stringify(options.fieldsAlias)
    );
  }

  if (Array.isArray(options.repeatedFieldsJson)) {
    for (const value of options.repeatedFieldsJson) {
      form.append("fields_json", value);
    }
  }

  form.append(
    "escudo1",
    new Blob([options.bytes || PNG_A], { type: "image/png" }),
    options.filename || "escudo.png"
  );
  return form;
}

function batchForm(options = {}) {
  const form = new FormData();
  const fields = {
    flyer_tipo: "resultado",
    rodada: "Rodada 1",
    data: "30/07/2026",
    hora: "Campeonato Teste",
    time_principal: "Time A",
    time_adversario: "Time B",
    gols_time_principal: "2",
    gols_adversario: "1"
  };

  if (options.explicitCurrent) {
    fields.schema_version = 2;
    fields.product_id = "resultado";
    fields.fields_json = {
      scenario_id: "resultado_atual_v1"
    };
  }

  form.append("batch_id", options.batchId);
  form.append("items_json", JSON.stringify([{
    product_id: "resultado",
    client_request_id: options.requestId,
    modalidade_criacao: options.modalidade || "com_suporte",
    fields,
    files: { escudo1: "item_0_escudo1" }
  }]));
  form.append(
    "item_0_escudo1",
    new Blob([options.bytes || PNG_A], { type: "image/png" }),
    options.filename || "escudo.png"
  );
  return form;
}

function findOrderPath(whatsapp, orderId) {
  const userDir = path.join(PEDIDOS_DIR, whatsapp);
  if (!fs.existsSync(userDir)) return "";

  for (const month of fs.readdirSync(userDir)) {
    const candidate = path.join(userDir, month, orderId, "pedido.json");
    if (fs.existsSync(candidate)) return candidate;
  }

  return "";
}

function readOrder(whatsapp, orderId) {
  const file = findOrderPath(whatsapp, orderId);
  assert.ok(file, `pedido ${orderId} nao encontrado`);
  return readJson(file, {});
}

function countOrders(whatsapp) {
  const userDir = path.join(PEDIDOS_DIR, whatsapp);
  if (!fs.existsSync(userDir)) return 0;
  let total = 0;
  for (const month of fs.readdirSync(userDir)) {
    const monthDir = path.join(userDir, month);
    if (!fs.statSync(monthDir).isDirectory()) continue;
    total += fs.readdirSync(monthDir).filter(name =>
      fs.existsSync(path.join(monthDir, name, "pedido.json"))
    ).length;
  }
  return total;
}

function readAuditEntries() {
  if (!fs.existsSync(AUDIT_FILE)) return [];
  return fs.readFileSync(AUDIT_FILE, "utf8")
    .split(/\r?\n/)
    .filter(Boolean)
    .map(line => JSON.parse(line));
}

function writeLegacyOrder(whatsapp, orderId, requestId, overrides = {}) {
  const base = path.join(PEDIDOS_DIR, whatsapp, CURRENT_MONTH, orderId);
  fs.mkdirSync(base, { recursive: true });
  const pedido = {
    id: orderId,
    whatsapp,
    mes: CURRENT_MONTH,
    categoria: "resultado",
    client_request_id: requestId,
    status: "novo",
    criado_em: new Date().toISOString(),
    ...overrides
  };
  writeJson(path.join(base, "pedido.json"), pedido);
  fs.writeFileSync(path.join(base, "status.txt"), "novo", "utf8");
  return pedido;
}

test("piloto local de scenario_id para Resultado", async t => {
  putClient(TEST_USER);
  putClient(TEST_BATCH_USER);

  const server = await new Promise(resolve => {
    const instance = app.listen(0, "127.0.0.1", () => resolve(instance));
  });
  const address = server.address();
  const baseUrl = `http://127.0.0.1:${address.port}`;

  try {
    await t.test("registro ativa somente os IDs novos e reserva os IDs antigos", async () => {
      const registry = __resultadoScenarioTest.registry;
      assert.deepEqual(
        Object.keys(registry.RESULTADO_SCENARIOS),
        ["resultado_atual_v1", ...RESULTADO_NEW_SCENARIO_IDS]
      );
      assert.deepEqual(
        registry.RESULTADO_RESERVED_SCENARIO_IDS,
        RESULTADO_RESERVED_SCENARIO_IDS
      );

      const payloadHashes = new Set();
      for (const scenarioId of RESULTADO_NEW_SCENARIO_IDS) {
        assert.equal(registry.RESULTADO_SCENARIOS[scenarioId].status, "active");
        assert.equal(registry.RESULTADO_SCENARIOS[scenarioId].version, 1);

        const created = await api(baseUrl, "POST", "/resultado_do_jogo", {
          user: TEST_USER,
          headers: { "X-Idempotency-Key": `active-${scenarioId}` },
          form: resultForm({
            productId: "resultado",
            structured: { scenario_id: scenarioId }
          })
        });
        assert.equal(created.response.status, 200, `${scenarioId}: ${JSON.stringify(created.payload)}`);
        assert.equal(created.payload.scenario_id, scenarioId);
        assert.equal(created.payload.scenario_version, 1);
        assert.equal(created.payload.scenario_source, "explicit");

        const order = readOrder(TEST_USER, created.payload.pedido_id);
        assert.equal(order.fields.scenario_id, scenarioId);
        assert.equal(order.fields.scenario_version, 1);
        assert.equal(order.fields.scenario_source, "explicit");
        payloadHashes.add(order.idempotency_payload_hash);

        const audit = readAuditEntries().find(
          entry => entry.pedido_id === created.payload.pedido_id
        );
        assert.equal(audit.geracao.scenario_id, scenarioId);
        assert.equal(audit.geracao.scenario_version, 1);
        assert.equal(audit.geracao.scenario_source, "explicit");
      }

      assert.equal(
        payloadHashes.size,
        RESULTADO_NEW_SCENARIO_IDS.length,
        "cada scenario_id deve participar do fingerprint canonico"
      );
    });

    await t.test("default e explicito atual sao canonicos e auditados", async () => {
      const defaultCreate = await api(baseUrl, "POST", "/resultado_do_jogo", {
        user: TEST_USER,
        headers: { "X-Idempotency-Key": "scenario-default-create" },
        form: resultForm()
      });
      assert.equal(defaultCreate.response.status, 200, JSON.stringify(defaultCreate.payload));
      assert.equal(defaultCreate.payload.scenario_id, "resultado_atual_v1");
      assert.equal(defaultCreate.payload.scenario_version, 1);
      assert.equal(defaultCreate.payload.scenario_source, "default");

      const defaultOrder = readOrder(TEST_USER, defaultCreate.payload.pedido_id);
      assert.equal(defaultOrder.schema_version, 2);
      assert.equal(defaultOrder.product_id, "resultado");
      assert.equal(defaultOrder.fields.scenario_id, "resultado_atual_v1");
      assert.equal(defaultOrder.fields.scenario_version, 1);
      assert.equal(defaultOrder.fields.scenario_source, "default");
      assert.equal(defaultOrder.idempotency_payload_hash_version, 2);
      assert.equal(defaultOrder.idempotency_input_files.length, 1);
      assert.deepEqual(
        {
          field: defaultOrder.idempotency_input_files[0].field,
          index: defaultOrder.idempotency_input_files[0].index,
          mimetype: defaultOrder.idempotency_input_files[0].mimetype,
          size: defaultOrder.idempotency_input_files[0].size,
          sha256: defaultOrder.idempotency_input_files[0].sha256
        },
        {
          field: "escudo1",
          index: 0,
          mimetype: "image/png",
          size: PNG_A.length,
          sha256: crypto.createHash("sha256").update(PNG_A).digest("hex")
        }
      );

      const explicitCreate = await api(baseUrl, "POST", "/resultado_do_jogo", {
        user: TEST_USER,
        headers: { "X-Idempotency-Key": "scenario-explicit-create" },
        form: resultForm({
          productId: "resultado_do_jogo",
          structured: { scenario_id: "resultado_atual_v1" }
        })
      });
      assert.equal(explicitCreate.response.status, 200, JSON.stringify(explicitCreate.payload));
      assert.equal(explicitCreate.payload.scenario_source, "explicit");
      const explicitOrder = readOrder(TEST_USER, explicitCreate.payload.pedido_id);
      assert.equal(
        explicitOrder.idempotency_payload_hash,
        defaultOrder.idempotency_payload_hash,
        "ausente e explicito atual devem ter o mesmo hash semantico"
      );

      const audit = readAuditEntries().find(entry => entry.pedido_id === explicitCreate.payload.pedido_id);
      assert.equal(audit.geracao.scenario_id, "resultado_atual_v1");
      assert.equal(audit.geracao.scenario_version, 1);
      assert.equal(audit.geracao.scenario_source, "explicit");
      assert.deepEqual(
        audit.geracao.arquivos_sha256.escudo1,
        [{
          index: 0,
          size: PNG_A.length,
          mimetype: "image/png",
          sha256: crypto.createHash("sha256").update(PNG_A).digest("hex")
        }],
        "auditoria deve registrar apenas metadados semanticos e hash dos bytes"
      );
    });

    await t.test("replay v2 compara cenario, campos e bytes reais", async () => {
      const key = "scenario-semantic-replay";
      const first = await api(baseUrl, "POST", "/resultado_do_jogo", {
        user: TEST_USER,
        headers: { "X-Idempotency-Key": key },
        form: resultForm({ filename: "primeiro.png" })
      });
      assert.equal(first.response.status, 200);
      const orderCountAfterFirst = countOrders(TEST_USER);
      const saldoAfterFirst = readJson(CLIENTES_FILE, {})[TEST_USER].saldo_extra;

      const explicitReplay = await api(baseUrl, "POST", "/resultado_do_jogo", {
        user: TEST_USER,
        headers: { "X-Idempotency-Key": key },
        form: resultForm({
          filename: "renomeado.png",
          productId: "resultado",
          structured: { scenario_id: "resultado_atual_v1" }
        })
      });
      assert.equal(explicitReplay.response.status, 200, JSON.stringify(explicitReplay.payload));
      assert.equal(explicitReplay.payload.pedido_id, first.payload.pedido_id);
      assert.equal(explicitReplay.payload.idempotent_replay, true);
      assert.equal(countOrders(TEST_USER), orderCountAfterFirst);
      assert.equal(readJson(CLIENTES_FILE, {})[TEST_USER].saldo_extra, saldoAfterFirst);

      const differentScenario = await api(baseUrl, "POST", "/resultado_do_jogo", {
        user: TEST_USER,
        headers: { "X-Idempotency-Key": key },
        form: resultForm({
          productId: "resultado",
          structured: { scenario_id: "resultado_sol_v1" }
        })
      });
      assert.equal(differentScenario.response.status, 409);
      assert.equal(differentScenario.payload.code, "IDEMPOTENCY_CONFLICT");
      assert.equal(countOrders(TEST_USER), orderCountAfterFirst);
      assert.equal(readJson(CLIENTES_FILE, {})[TEST_USER].saldo_extra, saldoAfterFirst);

      const differentBytes = await api(baseUrl, "POST", "/resultado_do_jogo", {
        user: TEST_USER,
        headers: { "X-Idempotency-Key": key },
        form: resultForm({ bytes: PNG_B, filename: "primeiro.png" })
      });
      assert.equal(differentBytes.response.status, 409);
      assert.equal(differentBytes.payload.code, "IDEMPOTENCY_CONFLICT");
      assert.equal(countOrders(TEST_USER), orderCountAfterFirst);
      assert.equal(readJson(CLIENTES_FILE, {})[TEST_USER].saldo_extra, saldoAfterFirst);

      const differentField = await api(baseUrl, "POST", "/resultado_do_jogo", {
        user: TEST_USER,
        headers: { "X-Idempotency-Key": key },
        form: resultForm({ legacy: { data: "31/07/2026" } })
      });
      assert.equal(differentField.response.status, 409);
      assert.equal(differentField.payload.code, "IDEMPOTENCY_CONFLICT");
      assert.equal(countOrders(TEST_USER), orderCountAfterFirst);
    });

    await t.test("registro rejeita IDs reservados, texto, prompt, path, metadados e entradas adulteradas", async () => {
      const cases = [
        ...RESULTADO_RESERVED_SCENARIO_IDS.map((scenarioId, index) => ({
          name: `reserved-${index}`,
          expectedStatus: 422,
          expectedCode: "SCENARIO_RESERVED",
          form: () => resultForm({
            productId: "resultado",
            structured: { scenario_id: scenarioId }
          })
        })),
        {
          name: "unknown",
          expectedStatus: 400,
          expectedCode: "SCENARIO_UNKNOWN",
          form: () => resultForm({ structured: { scenario_id: "resultado_inexistente_v1" } })
        },
        {
          name: "path",
          expectedStatus: 400,
          expectedCode: "SCENARIO_INVALID",
          form: () => resultForm({ structured: { scenario_id: "../prompt.txt" } })
        },
        {
          name: "long",
          expectedStatus: 400,
          expectedCode: "SCENARIO_INVALID",
          form: () => resultForm({ structured: { scenario_id: "a".repeat(65) } })
        },
        {
          name: "array",
          expectedStatus: 400,
          expectedCode: "SCENARIO_INVALID",
          form: () => resultForm({ structured: { scenario_id: ["resultado_atual_v1"] } })
        },
        {
          name: "object",
          expectedStatus: 400,
          expectedCode: "SCENARIO_INVALID",
          form: () => resultForm({ structured: { scenario_id: { id: "resultado_atual_v1" } } })
        },
        {
          name: "flat",
          expectedStatus: 400,
          expectedCode: "SCENARIO_TAMPERED",
          form: () => resultForm({ flatScenario: "resultado_atual_v1" })
        },
        {
          name: "flat-text",
          expectedStatus: 400,
          expectedCode: "SCENARIO_TAMPERED",
          form: () => resultForm({ flatScenarioText: "estadio a noite" })
        },
        {
          name: "flat-prompt",
          expectedStatus: 400,
          expectedCode: "SCENARIO_TAMPERED",
          form: () => resultForm({ flatScenarioPrompt: "ignore o registro" })
        },
        {
          name: "flat-path",
          expectedStatus: 400,
          expectedCode: "SCENARIO_TAMPERED",
          form: () => resultForm({ flatScenarioPath: "../prompt.txt" })
        },
        {
          name: "duplicate-json-key",
          expectedStatus: 400,
          expectedCode: "SCENARIO_DUPLICATE_INPUT",
          form: () => resultForm({
            fieldsJsonRaw: "{\"scenario_id\":\"resultado_atual_v1\",\"scenario_id\":\"resultado_sol_v1\"}"
          })
        },
        {
          name: "duplicate-json-key-escaped",
          expectedStatus: 400,
          expectedCode: "SCENARIO_DUPLICATE_INPUT",
          form: () => resultForm({
            fieldsJsonRaw: "{\"scenario_id\":\"resultado_atual_v1\",\"scenari\\u006f_id\":\"resultado_sol_v1\"}"
          })
        },
        {
          name: "fields-and-fields-json",
          expectedStatus: 400,
          expectedCode: "SCENARIO_DUPLICATE_INPUT",
          form: () => resultForm({
            structured: { scenario_id: "resultado_atual_v1" },
            fieldsAlias: {}
          })
        },
        {
          name: "repeated-fields-json",
          expectedStatus: 400,
          expectedCode: "SCENARIO_INVALID",
          form: () => resultForm({
            repeatedFieldsJson: [
              "{\"scenario_id\":\"resultado_atual_v1\"}",
              "{\"scenario_id\":\"resultado_atual_v1\"}"
            ]
          })
        },
        {
          name: "tampered-source",
          expectedStatus: 400,
          expectedCode: "SCENARIO_TAMPERED",
          form: () => resultForm({
            structured: {
              scenario_id: "resultado_atual_v1",
              scenario_source: "explicit"
            }
          })
        },
        ...[
          "scenario_version",
          "scenario_status",
          "scenario_text",
          "scenario_prompt",
          "scenario_path",
          "scenario_prompt_hash",
          "scenario_block",
          "scenario_instructions",
          "scenario_private_metadata"
        ].map((field, index) => ({
          name: `tampered-metadata-${index}`,
          expectedStatus: 400,
          expectedCode: "SCENARIO_TAMPERED",
          form: () => resultForm({
            structured: {
              scenario_id: "resultado_atual_v1",
              [field]: "nao permitido"
            }
          })
        })),
        {
          name: "tampered-nested-prompt",
          expectedStatus: 400,
          expectedCode: "SCENARIO_TAMPERED",
          form: () => resultForm({
            structured: {
              scenario_id: "resultado_atual_v1",
              extras: { scenario_prompt: "texto escondido" }
            }
          })
        },
        {
          name: "nested-scenario-id",
          expectedStatus: 400,
          expectedCode: "SCENARIO_TAMPERED",
          form: () => resultForm({
            structured: { extras: { scenario_id: "resultado_sol_v1" } }
          })
        },
        {
          name: "root-and-nested-scenario-id",
          expectedStatus: 400,
          expectedCode: "SCENARIO_DUPLICATE_INPUT",
          form: () => resultForm({
            structured: {
              scenario_id: "resultado_atual_v1",
              extras: { scenario_id: "resultado_sol_v1" }
            }
          })
        },
        {
          name: "wrong-product-id",
          expectedStatus: 400,
          expectedCode: "SCENARIO_PRODUCT_MISMATCH",
          form: () => resultForm({
            productId: "proximo_jogo",
            structured: { scenario_id: "resultado_atual_v1" }
          })
        }
      ];

      for (const item of cases) {
        const before = countOrders(TEST_USER);
        const result = await api(baseUrl, "POST", "/resultado_do_jogo", {
          user: TEST_USER,
          headers: { "X-Idempotency-Key": `invalid-${item.name}` },
          form: item.form()
        });
        assert.equal(result.response.status, item.expectedStatus, `${item.name}: ${JSON.stringify(result.payload)}`);
        assert.equal(result.payload.code, item.expectedCode, item.name);
        assert.equal(countOrders(TEST_USER), before, item.name);
      }

      const wrongRoute = await api(baseUrl, "POST", "/pedidos", {
        user: TEST_USER,
        headers: { "X-Idempotency-Key": "wrong-route-scenario" },
        form: resultForm({
          legacy: { flyer_tipo: "zz1ft" },
          productId: "proximo_jogo",
          structured: { scenario_id: "resultado_atual_v1" }
        })
      });
      assert.equal(wrongRoute.response.status, 400);
      assert.equal(wrongRoute.payload.code, "SCENARIO_PRODUCT_MISMATCH");

      const wrongProductSource = await api(baseUrl, "POST", "/pedidos", {
        user: TEST_USER,
        headers: { "X-Idempotency-Key": "wrong-product-scenario-source" },
        form: resultForm({
          legacy: { flyer_tipo: "zz1ft" },
          productId: "proximo_jogo",
          structured: { scenario_source: "explicit" }
        })
      });
      assert.equal(wrongProductSource.response.status, 400);
      assert.equal(wrongProductSource.payload.code, "SCENARIO_TAMPERED");
    });

    await t.test("produtos com cenario rejeitam containers ambiguos e usam default proprio", async () => {
      const duplicateContainers = await api(baseUrl, "POST", "/pedidos", {
        user: TEST_USER,
        headers: { "X-Idempotency-Key": "legacy-other-product-two-fields" },
        form: resultForm({
          legacy: { flyer_tipo: "zz1ft" },
          productId: "proximo_jogo",
          structured: { observacao: "Campo legado principal." },
          fieldsAlias: { observacao: "Campo legado alternativo." }
        })
      });
      assert.equal(
        duplicateContainers.response.status,
        400,
        JSON.stringify(duplicateContainers.payload)
      );
      assert.equal(duplicateContainers.payload.code, "SCENARIO_DUPLICATE_INPUT");

      const arrayFields = await api(baseUrl, "POST", "/pedidos", {
        user: TEST_USER,
        headers: { "X-Idempotency-Key": "legacy-other-product-array-fields" },
        form: resultForm({
          legacy: { flyer_tipo: "zz1ft" },
          productId: "proximo_jogo",
          structured: []
        })
      });
      assert.equal(arrayFields.response.status, 400, JSON.stringify(arrayFields.payload));
      assert.equal(arrayFields.payload.code, "SCENARIO_INVALID");

      const defaultScenario = await api(baseUrl, "POST", "/pedidos", {
        user: TEST_USER,
        headers: { "X-Idempotency-Key": "other-product-default-scenario" },
        form: resultForm({
          legacy: { flyer_tipo: "zz1ft" },
          productId: "proximo_jogo",
          structured: { observacao: "Campo estruturado valido." }
        })
      });
      assert.equal(defaultScenario.response.status, 200, JSON.stringify(defaultScenario.payload));
      assert.equal(defaultScenario.payload.scenario_id, "proximo_jogo_atual_v1");
      assert.equal(defaultScenario.payload.scenario_version, 1);
      assert.equal(defaultScenario.payload.scenario_source, "default");
    });

    await t.test("customer_notes e ajustes distinguem comando afirmativo de negacao", async () => {
      const conflict = await api(baseUrl, "POST", "/resultado_do_jogo", {
        user: TEST_USER,
        headers: { "X-Idempotency-Key": "notes-conflict" },
        form: resultForm({
          productId: "resultado",
          structured: {
            scenario_id: "resultado_atual_v1",
            customer_notes: "Troque o fundo para um estadio a noite."
          }
        })
      });
      assert.equal(conflict.response.status, 422);
      assert.equal(conflict.payload.code, "SCENARIO_OBSERVATION_CONFLICT");

      const general = await api(baseUrl, "POST", "/resultado_do_jogo", {
        user: TEST_USER,
        headers: { "X-Idempotency-Key": "notes-general" },
        form: resultForm({
          productId: "resultado",
          structured: {
            scenario_id: "resultado_atual_v1",
            customer_notes: "Partida no Estadio Municipal. Preservar o nome dos times."
          }
        })
      });
      assert.equal(general.response.status, 200, JSON.stringify(general.payload));

      const defaultConflict = await api(baseUrl, "POST", "/resultado_do_jogo", {
        user: TEST_USER,
        headers: { "X-Idempotency-Key": "notes-default-legacy" },
        form: resultForm({
          productId: "resultado",
          structured: {
            customer_notes: "Troque o fundo para um estadio a noite."
          }
        })
      });
      assert.equal(defaultConflict.response.status, 422, JSON.stringify(defaultConflict.payload));
      assert.equal(defaultConflict.payload.code, "SCENARIO_OBSERVATION_CONFLICT");
      assert.equal(defaultConflict.payload.scenario_id, "resultado_atual_v1");
      assert.equal(defaultConflict.payload.scenario_version, 1);
      assert.equal(defaultConflict.payload.scenario_source, "default");

      const negativePhrases = [
        "Nao mude/troque o cenario.",
        "Nunca alterar o fundo.",
        "Sem mudar o cenario."
      ];
      for (const phrase of negativePhrases) {
        assert.equal(
          __resultadoScenarioTest.registry.hasScenarioObservationConflict(phrase),
          false,
          phrase
        );
      }
      assert.equal(
        __resultadoScenarioTest.registry.hasScenarioObservationConflict(
          "Nao mude o cenario; troque o fundo para um estadio."
        ),
        true
      );
      for (const phrase of [
        "Use chuva.",
        "Coloque sol.",
        "Mude para futsal.",
        "Transforme em noite.",
        "Use fumaca."
      ]) {
        assert.equal(
          __resultadoScenarioTest.registry.hasScenarioObservationConflict(phrase),
          true,
          phrase
        );
      }

      const negatedDefault = await api(baseUrl, "POST", "/resultado_do_jogo", {
        user: TEST_USER,
        headers: { "X-Idempotency-Key": "notes-default-negated" },
        form: resultForm({
          productId: "resultado",
          structured: {
            customer_notes: "Nao mude o cenario. Preserve os nomes dos times."
          }
        })
      });
      assert.equal(negatedDefault.response.status, 200, JSON.stringify(negatedDefault.payload));
      assert.equal(negatedDefault.payload.scenario_source, "default");
      assert.equal(negatedDefault.payload.scenario_version, 1);

      const negatedAdjustment = await api(
        baseUrl,
        "POST",
        `/pedidos/${general.payload.pedido_id}/solicitar-ajuste`,
        {
          user: TEST_USER,
          body: { motivo: "Nao mude o cenario. Corrija apenas o nome do campeonato." }
        }
      );
      assert.equal(negatedAdjustment.response.status, 200, JSON.stringify(negatedAdjustment.payload));

      const adjustment = await api(
        baseUrl,
        "POST",
        `/pedidos/${negatedDefault.payload.pedido_id}/solicitar-ajuste`,
        {
          user: TEST_USER,
          body: { motivo: "Mude o cenario para uma quadra." }
        }
      );
      assert.equal(adjustment.response.status, 422);
      assert.equal(adjustment.payload.code, "SCENARIO_OBSERVATION_CONFLICT");
      assert.equal(adjustment.payload.scenario_version, 1);
      assert.equal(adjustment.payload.scenario_source, "default");

      writeLegacyOrder(
        TEST_USER,
        "legacy-adjustment-without-scenario",
        "legacy-adjustment-without-scenario"
      );
      const legacyGeneralAdjustment = await api(
        baseUrl,
        "POST",
        "/pedidos/legacy-adjustment-without-scenario/solicitar-ajuste",
        {
          user: TEST_USER,
          body: { motivo: "Corrija apenas o nome do campeonato." }
        }
      );
      assert.equal(
        legacyGeneralAdjustment.response.status,
        200,
        JSON.stringify(legacyGeneralAdjustment.payload)
      );

      writeLegacyOrder(
        TEST_USER,
        "legacy-result-scene-change",
        "legacy-result-scene-change"
      );
      const legacyResultSceneChange = await api(
        baseUrl,
        "POST",
        "/pedidos/legacy-result-scene-change/solicitar-ajuste",
        {
          user: TEST_USER,
          body: { motivo: "Mude o cenario para uma quadra." }
        }
      );
      assert.equal(legacyResultSceneChange.response.status, 422);
      assert.equal(
        legacyResultSceneChange.payload.code,
        "SCENARIO_OBSERVATION_CONFLICT"
      );
      assert.equal(
        legacyResultSceneChange.payload.scenario_id,
        "resultado_atual_v1"
      );
      assert.equal(legacyResultSceneChange.payload.scenario_version, 1);
      assert.equal(legacyResultSceneChange.payload.scenario_source, "default");

      writeLegacyOrder(
        TEST_USER,
        "legacy-other-product-scene-change",
        "legacy-other-product-scene-change",
        { categoria: "proximo_jogo" }
      );
      const legacyOtherProductSceneChange = await api(
        baseUrl,
        "POST",
        "/pedidos/legacy-other-product-scene-change/solicitar-ajuste",
        {
          user: TEST_USER,
          body: { motivo: "Mude o cenario para uma quadra." }
        }
      );
      assert.equal(
        legacyOtherProductSceneChange.response.status,
        422,
        JSON.stringify(legacyOtherProductSceneChange.payload)
      );
      assert.equal(legacyOtherProductSceneChange.payload.code, "SCENARIO_OBSERVATION_CONFLICT");
      assert.equal(legacyOtherProductSceneChange.payload.scenario_id, "proximo_jogo_atual_v1");
    });

    await t.test("outer batch_id e item persistente comparam hash binario", async () => {
      const first = await api(baseUrl, "POST", "/me/time/jogos/criar-artes", {
        user: TEST_BATCH_USER,
        form: batchForm({
          batchId: "scenario_batch_outer",
          requestId: "scenario_batch_item",
          filename: "primeiro.png"
        })
      });
      assert.equal(first.response.status, 200, JSON.stringify(first.payload));
      assert.equal(first.payload.criados.length, 1);
      const pedidoId = first.payload.criados[0].pedido_id;

      const equivalent = await api(baseUrl, "POST", "/me/time/jogos/criar-artes", {
        user: TEST_BATCH_USER,
        form: batchForm({
          batchId: "scenario_batch_outer",
          requestId: "scenario_batch_item",
          explicitCurrent: true,
          filename: "renomeado.png"
        })
      });
      assert.equal(equivalent.response.status, 200, JSON.stringify(equivalent.payload));
      assert.equal(equivalent.payload.criados[0].pedido_id, pedidoId);

      const outerConflict = await api(baseUrl, "POST", "/me/time/jogos/criar-artes", {
        user: TEST_BATCH_USER,
        form: batchForm({
          batchId: "scenario_batch_outer",
          requestId: "scenario_batch_item",
          bytes: PNG_B
        })
      });
      assert.equal(outerConflict.response.status, 409);
      assert.equal(outerConflict.payload.code, "IDEMPOTENCY_CONFLICT");

      __resultadoScenarioTest.resetDedupe();
      const persistentControlConflict = await api(baseUrl, "POST", "/me/time/jogos/criar-artes", {
        user: TEST_BATCH_USER,
        form: batchForm({
          batchId: "scenario_batch_outer",
          requestId: "scenario_batch_item",
          modalidade: "economica"
        })
      });
      assert.equal(persistentControlConflict.response.status, 409, JSON.stringify(persistentControlConflict.payload));
      assert.equal(persistentControlConflict.payload.falhas[0].code, "IDEMPOTENCY_CONFLICT");

      const persistentItemConflict = await api(baseUrl, "POST", "/me/time/jogos/criar-artes", {
        user: TEST_BATCH_USER,
        form: batchForm({
          batchId: "scenario_batch_outer_new",
          requestId: "scenario_batch_item",
          bytes: PNG_B
        })
      });
      assert.equal(persistentItemConflict.response.status, 409, JSON.stringify(persistentItemConflict.payload));
      assert.equal(persistentItemConflict.payload.falhas[0].code, "IDEMPOTENCY_CONFLICT");
      assert.equal(countOrders(TEST_BATCH_USER), 1);
    });

    await t.test("fingerprints legados sao fail-closed e exigem nova chave", async () => {
      const legacyInputPath = path.join(TEST_DATA_DIR, "legacy-input.png");
      fs.writeFileSync(legacyInputPath, PNG_A);
      const legacyBody = {
        flyer_tipo: "resultado",
        rodada: "Rodada 1",
        data: "30/07/2026",
        hora: "Campeonato Teste",
        time_principal: "Time A",
        time_adversario: "Time B",
        gols_time_principal: "2",
        gols_adversario: "1"
      };
      const legacyContext = __resultadoScenarioTest.buildOrderScenarioContext(
        "resultado",
        legacyBody
      );
      const legacyRequestId = "legacy-hash-replay";
      const legacyMeta = __resultadoScenarioTest.buildOrderCreateDedupeMeta(
        {
          user: { whatsapp: TEST_USER },
          body: legacyBody,
          files: {
            escudo1: [{
              path: legacyInputPath,
              originalname: "escudo.png",
              mimetype: "image/png",
              detected_mimetype: "image/png",
              size: PNG_A.length
            }]
          },
          get(name) {
            return String(name).toLowerCase().includes("idempotency")
              ? legacyRequestId
              : "";
          }
        },
        "resultado",
        TEST_USER,
        legacyContext.fields,
        { legacyFields: legacyContext.legacyFields }
      );

      writeLegacyOrder(TEST_USER, "legacy-hash-order", legacyRequestId, {
        idempotency_payload_hash: legacyMeta.legacyPayloadHash
      });

      const legacyReplay = await api(baseUrl, "POST", "/resultado_do_jogo", {
        user: TEST_USER,
        headers: { "X-Idempotency-Key": legacyRequestId },
        form: resultForm()
      });
      assert.equal(legacyReplay.response.status, 409, JSON.stringify(legacyReplay.payload));
      assert.equal(legacyReplay.payload.code, "IDEMPOTENCY_CONFLICT");

      const legacyExplicit = await api(baseUrl, "POST", "/resultado_do_jogo", {
        user: TEST_USER,
        headers: { "X-Idempotency-Key": legacyRequestId },
        form: resultForm({
          productId: "resultado",
          structured: { scenario_id: "resultado_atual_v1" }
        })
      });
      assert.equal(legacyExplicit.response.status, 409);
      assert.equal(legacyExplicit.payload.code, "IDEMPOTENCY_CONFLICT");

      writeLegacyOrder(TEST_USER, "legacy-no-hash-order", "legacy-no-hash");
      const noHashReplay = await api(baseUrl, "POST", "/resultado_do_jogo", {
        user: TEST_USER,
        headers: { "X-Idempotency-Key": "legacy-no-hash" },
        form: resultForm()
      });
      assert.equal(noHashReplay.response.status, 409);
      assert.equal(noHashReplay.payload.code, "IDEMPOTENCY_CONFLICT");

      writeLegacyOrder(TEST_USER, "legacy-no-hash-explicit-order", "legacy-no-hash-explicit");
      const noHashExplicit = await api(baseUrl, "POST", "/resultado_do_jogo", {
        user: TEST_USER,
        headers: { "X-Idempotency-Key": "legacy-no-hash-explicit" },
        form: resultForm({
          productId: "resultado",
          structured: { scenario_id: "resultado_atual_v1" }
        })
      });
      assert.equal(noHashExplicit.response.status, 409);
      assert.equal(noHashExplicit.payload.code, "IDEMPOTENCY_CONFLICT");
    });
  } finally {
    __resultadoScenarioTest.resetDedupe();
    await new Promise(resolve => server.close(resolve));
    const resolvedTemp = path.resolve(TEST_DATA_DIR);
    if (resolvedTemp.startsWith(path.resolve(os.tmpdir()))) {
      fs.rmSync(resolvedTemp, { recursive: true, force: true });
    }
  }
});
