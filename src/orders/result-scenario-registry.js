const SCENARIO_SCHEMA_VERSION = 2;
const RESULTADO_PRODUCT_ID = "resultado";

const SCENARIO_VARIANTS = Object.freeze([
  "atual",
  "sol",
  "noite",
  "chuva",
  "estadio_grande_dia",
  "estadio_varzea_dia",
  "fumaca",
  "futsal"
]);

function buildProductScenarios(productId) {
  return Object.freeze(Object.fromEntries(
    SCENARIO_VARIANTS.map(variant => {
      const id = `${productId}_${variant}_v1`;
      return [id, Object.freeze({
        id,
        product_id: productId,
        version: 1,
        status: "active"
      })];
    })
  ));
}

function buildProductDefinition(productId, aliases, reservedScenarioIds = []) {
  const scenarios = buildProductScenarios(productId);
  return Object.freeze({
    id: productId,
    aliases: new Set(aliases),
    defaultScenarioId: `${productId}_atual_v1`,
    reservedScenarioIds: Object.freeze([...reservedScenarioIds]),
    reservedScenarioIdSet: new Set(reservedScenarioIds),
    scenarios
  });
}

const SCENARIO_PRODUCTS = Object.freeze({
  resultado: buildProductDefinition(
    "resultado",
    ["resultado", "resultado_jogo", "resultado_do_jogo"],
    ["resultado_estadio_noturno_v1", "resultado_estadio_dia_v1"]
  ),
  proximo_jogo: buildProductDefinition(
    "proximo_jogo",
    ["proximo_jogo", "proximo-jogo", "proximo jogo"]
  ),
  jogador_escudo: buildProductDefinition(
    "jogador_escudo",
    ["jogador_escudo", "jogador-escudo", "jogador escudo", "jogador + escudo"]
  ),
  mascote_uniforme: buildProductDefinition(
    "mascote_uniforme",
    ["mascote_uniforme", "mascote-uniforme", "mascote uniforme"]
  ),
  escalacao: buildProductDefinition(
    "escalacao",
    ["escalacao", "escalação"]
  )
});

const SCENARIOS = Object.freeze(Object.fromEntries(
  Object.values(SCENARIO_PRODUCTS).flatMap(product => Object.entries(product.scenarios))
));

const SCENARIO_ID_OWNERS = new Map();
for (const product of Object.values(SCENARIO_PRODUCTS)) {
  for (const scenarioId of Object.keys(product.scenarios)) {
    SCENARIO_ID_OWNERS.set(scenarioId, product.id);
  }
  for (const scenarioId of product.reservedScenarioIds) {
    SCENARIO_ID_OWNERS.set(scenarioId, product.id);
  }
}

// Exports antigos permanecem como aliases para nao quebrar consumidores existentes.
const RESULTADO_SCENARIO_SCHEMA_VERSION = SCENARIO_SCHEMA_VERSION;
const RESULTADO_DEFAULT_SCENARIO_ID = SCENARIO_PRODUCTS.resultado.defaultScenarioId;
const RESULTADO_PRODUCT_ALIASES = SCENARIO_PRODUCTS.resultado.aliases;
const RESULTADO_RESERVED_SCENARIO_IDS = SCENARIO_PRODUCTS.resultado.reservedScenarioIds;
const RESULTADO_RESERVED_SCENARIO_ID_SET = SCENARIO_PRODUCTS.resultado.reservedScenarioIdSet;
const RESULTADO_SCENARIOS = SCENARIO_PRODUCTS.resultado.scenarios;

const SCENARIO_OBSERVATION_KEYS = Object.freeze([
  "observacao",
  "observacoes",
  "observation",
  "notes",
  "customer_note",
  "customer_notes",
  "instructions",
  "additional_information"
]);

function hasOwn(value, key) {
  return !!value && Object.prototype.hasOwnProperty.call(value, key);
}

function isPlainObject(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const proto = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}

function parseStructuredFields(value) {
  if (value === undefined || value === null || value === "") {
    return { ok: true, value: {}, raw: "" };
  }

  if (isPlainObject(value)) {
    return { ok: true, value, raw: "" };
  }

  if (typeof value !== "string") {
    return { ok: false, value: {}, raw: "" };
  }

  try {
    const parsed = JSON.parse(value);
    return {
      ok: isPlainObject(parsed),
      value: isPlainObject(parsed) ? parsed : {},
      raw: value
    };
  } catch {
    return { ok: false, value: {}, raw: value };
  }
}

function getJsonObjectKeyNames(raw) {
  if (!raw || typeof raw !== "string") return [];
  const keyTokens = raw.match(/"(?:\\.|[^"\\])*"\s*:/g) || [];
  const keys = [];

  for (const token of keyTokens) {
    try {
      const key = JSON.parse(token.replace(/\s*:$/, ""));
      if (typeof key === "string") keys.push(key);
    } catch {
      // O JSON invalido e rejeitado separadamente por parseStructuredFields.
    }
  }

  return keys;
}

function countJsonScenarioIdKeys(raw) {
  return getJsonObjectKeyNames(raw).filter(key => key === "scenario_id").length;
}

function isScenarioClientKey(key) {
  return typeof key === "string" && key.toLowerCase().startsWith("scenario");
}

function isForbiddenScenarioClientKey(key) {
  return isScenarioClientKey(key) && key !== "scenario_id";
}

function countStructuredScenarioIdKeys(value, seen = new Set()) {
  if (!value || typeof value !== "object") return 0;
  if (seen.has(value)) return 0;
  seen.add(value);

  if (Array.isArray(value)) {
    return value.reduce(
      (total, item) => total + countStructuredScenarioIdKeys(item, seen),
      0
    );
  }

  return Object.entries(value).reduce(
    (total, [key, nested]) =>
      total +
      (key === "scenario_id" ? 1 : 0) +
      countStructuredScenarioIdKeys(nested, seen),
    0
  );
}

function findForbiddenScenarioClientKey(value, seen = new Set()) {
  if (!value || typeof value !== "object") return "";
  if (seen.has(value)) return "";
  seen.add(value);

  if (Array.isArray(value)) {
    for (const item of value) {
      const nestedKey = findForbiddenScenarioClientKey(item, seen);
      if (nestedKey) return nestedKey;
    }
    return "";
  }

  for (const [key, nested] of Object.entries(value)) {
    if (isForbiddenScenarioClientKey(key)) return key;
    const nestedKey = findForbiddenScenarioClientKey(nested, seen);
    if (nestedKey) return nestedKey;
  }

  return "";
}

function hasStructuredScenarioSignal(value, seen = new Set()) {
  if (typeof value === "string") {
    return getJsonObjectKeyNames(value).some(isScenarioClientKey);
  }

  if (!value || typeof value !== "object") return false;
  if (seen.has(value)) return false;
  seen.add(value);

  if (Array.isArray(value)) {
    return value.some(item => hasStructuredScenarioSignal(item, seen));
  }

  return Object.entries(value).some(([key, nested]) =>
    isScenarioClientKey(key) ||
    hasStructuredScenarioSignal(nested, seen)
  );
}

function bodyHasStructuredScenarioSignal(body = {}) {
  return ["fields_json", "fields"].some(key =>
    hasOwn(body, key) && hasStructuredScenarioSignal(body[key])
  );
}

function normalizeProductAlias(value) {
  if (value === undefined || value === null || value === "") return "";
  if (typeof value !== "string") return null;
  return value.trim().toLowerCase();
}

function getProductDefinition(value) {
  const normalized = normalizeProductAlias(value);
  if (!normalized) return null;

  return Object.values(SCENARIO_PRODUCTS).find(product =>
    product.aliases.has(normalized)
  ) || null;
}

function getScenarioOwner(scenarioId) {
  return SCENARIO_ID_OWNERS.get(String(scenarioId || "")) || "";
}

function scenarioError(code, message, status = 400, details = {}) {
  const error = new Error(message);
  error.code = code;
  error.status = status;
  error.details = details;
  return error;
}

function getStructuredScenarioInput(body = {}) {
  const hasFieldsJson = hasOwn(body, "fields_json") && body.fields_json !== undefined && body.fields_json !== null && body.fields_json !== "";
  const hasFields = hasOwn(body, "fields") && body.fields !== undefined && body.fields !== null && body.fields !== "";
  const fieldsJson = parseStructuredFields(body.fields_json);
  const fields = parseStructuredFields(body.fields);

  if (hasFieldsJson && hasFields) {
    throw scenarioError(
      "SCENARIO_DUPLICATE_INPUT",
      "Envie apenas fields_json ou fields, nunca os dois.",
      400
    );
  }

  const selected = hasFieldsJson ? fieldsJson : fields;

  if ((hasFieldsJson || hasFields) && !selected.ok) {
    throw scenarioError(
      "SCENARIO_INVALID",
      "O campo estruturado do cenario e invalido.",
      400
    );
  }

  const parsedHasScenario = hasOwn(selected.value, "scenario_id");
  const rawScenarioCount = countJsonScenarioIdKeys(selected.raw);
  const structuredScenarioCount = countStructuredScenarioIdKeys(selected.value);

  if (rawScenarioCount > 1 || structuredScenarioCount > 1) {
    throw scenarioError(
      "SCENARIO_DUPLICATE_INPUT",
      "scenario_id foi informado mais de uma vez.",
      400
    );
  }

  if (
    (rawScenarioCount > 0 && !parsedHasScenario) ||
    structuredScenarioCount > (parsedHasScenario ? 1 : 0)
  ) {
    throw scenarioError(
      "SCENARIO_TAMPERED",
      "scenario_id deve estar no nivel principal de fields_json.",
      400
    );
  }

  const forbiddenKey = findForbiddenScenarioClientKey(selected.value);
  if (forbiddenKey) {
    throw scenarioError(
      "SCENARIO_TAMPERED",
      "Somente scenario_id pode ser enviado pelo cliente.",
      400,
      { rejected_field: forbiddenKey }
    );
  }

  return {
    explicit: parsedHasScenario,
    fields: selected.value
  };
}

function resolveProductScenario({ categoria, body = {} }) {
  const normalizedCategory = String(categoria || "").trim().toLowerCase();
  const product = getProductDefinition(normalizedCategory);
  const flatScenarioKeys = Object.keys(body).filter(isScenarioClientKey);

  if (!product) {
    if (flatScenarioKeys.length || bodyHasStructuredScenarioSignal(body)) {
      throw scenarioError(
        "SCENARIO_PRODUCT_MISMATCH",
        "Metadados de cenario nao estao disponiveis para este produto.",
        400
      );
    }

    return {
      applies: false,
      explicit: false,
      source: "",
      scenario: null,
      structuredFields: {}
    };
  }

  if (flatScenarioKeys.length) {
    throw scenarioError(
      "SCENARIO_TAMPERED",
      "Envie scenario_id somente dentro de fields_json.",
      400
    );
  }

  const structured = getStructuredScenarioInput(body);

  for (const key of ["product_id", "categoria"]) {
    const normalized = normalizeProductAlias(body[key]);
    if (normalized === null || (normalized && !product.aliases.has(normalized))) {
      throw scenarioError(
        "SCENARIO_PRODUCT_MISMATCH",
        "product_id e categoria devem identificar o produto da rota.",
        400,
        { product_id: product.id }
      );
    }
  }

  let scenarioId = product.defaultScenarioId;
  let source = "default";

  if (structured.explicit) {
    if (typeof structured.fields.scenario_id !== "string") {
      throw scenarioError(
        "SCENARIO_INVALID",
        "scenario_id deve ser um identificador textual.",
        400
      );
    }

    scenarioId = structured.fields.scenario_id.trim().toLowerCase();
    source = "explicit";

    if (
      !scenarioId ||
      scenarioId.length > 64 ||
      !/^[a-z0-9_-]+$/.test(scenarioId) ||
      scenarioId.includes("..")
    ) {
      throw scenarioError(
        "SCENARIO_INVALID",
        "scenario_id invalido.",
        400
      );
    }
  }

  const scenarioOwner = getScenarioOwner(scenarioId);
  if (scenarioOwner && scenarioOwner !== product.id) {
    throw scenarioError(
      "SCENARIO_PRODUCT_MISMATCH",
      "scenario_id pertence a outro produto.",
      400,
      {
        product_id: product.id,
        scenario_id: scenarioId,
        scenario_product_id: scenarioOwner
      }
    );
  }

  const scenario = product.scenarios[scenarioId] || null;

  if (product.reservedScenarioIdSet.has(scenarioId)) {
    throw scenarioError(
      "SCENARIO_RESERVED",
      "Este identificador de cenario foi reservado e nao pode ser utilizado.",
      422,
      { scenario_id: scenarioId }
    );
  }

  if (!scenario) {
    throw scenarioError(
      "SCENARIO_UNKNOWN",
      "scenario_id nao reconhecido.",
      400,
      { scenario_id: scenarioId }
    );
  }

  if (scenario.status !== "active") {
    throw scenarioError(
      "SCENARIO_UNAVAILABLE",
      "O cenario selecionado ainda nao esta disponivel.",
      422,
      {
        scenario_id: scenario.id,
        scenario_version: scenario.version,
        scenario_status: scenario.status
      }
    );
  }

  return {
    applies: true,
    explicit: structured.explicit,
    source,
    product,
    scenario,
    structuredFields: structured.fields
  };
}

function applyProductScenario(fields, resolution) {
  if (!resolution?.applies || !resolution.scenario) return fields;

  const newModel = fields.new_model && typeof fields.new_model === "object"
    ? fields.new_model
    : {};
  const cleanFields = isPlainObject(newModel.fields) ? newModel.fields : {};

  fields.new_model = {
    ...newModel,
    schema_version: Math.max(
      SCENARIO_SCHEMA_VERSION,
      Number(newModel.schema_version || 0) || 0
    ),
    product_id: resolution.product?.id || resolution.scenario.product_id,
    fields: {
      ...cleanFields,
      scenario_id: resolution.scenario.id,
      scenario_version: resolution.scenario.version,
      scenario_source: resolution.source
    }
  };

  return fields;
}

function resolveResultadoScenario(options) {
  return resolveProductScenario(options);
}

function applyResultadoScenario(fields, resolution) {
  return applyProductScenario(fields, resolution);
}

function normalizeObservationText(value) {
  return String(value || "")
    .toLowerCase()
    .replace(/(^|[^a-z\u00c0-\u00ff])p\u00f4r(?=$|[^a-z\u00c0-\u00ff])/g, "$1por_acao")
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase();
}

function hasScenarioObservationConflict(value) {
  const normalized = normalizeObservationText(value);
  if (!normalized.trim()) return false;

  const actionPattern = /\b(trocar|troque|mudar|mude|alterar|altere|substituir|substitua|transformar|transforme|remover|remova|colocar|coloque|adicionar|adicione|usar|use|deixar|deixe|quero|queremos|definir|defina|selecionar|selecione|escolher|escolha|aplicar|aplique|configurar|configure|fazer|faca|criar|crie|botar|bote|ponha|por_acao)\b/g;
  const scenePattern = /\b(fundo|cenario|ambiente|estadio|quadra|arquibancada|ginasio|vestiario|gramado|torcida|iluminacao|clima)\b|\bcampo\b(?!\s+de\s+observa(?:cao|coes)\b)/;
  const visualVariantPattern = /\b(noite|noturno|noturna|madrugada|dia|diurno|diurna|manha|tarde|amanhecer|sol|ensolarado|ensolarada|chuva|chuvoso|chuvosa|fumaca|varzea|futsal)\b/;
  const directVariantPattern = /^\s+(?:(?:um|uma|o|a|outro|outra|para|em|como|com|de|do|da|no|na|arte|imagem|visual)\s+){0,6}(?:noite|noturno|noturna|madrugada|diurno|diurna|manha|tarde|amanhecer|sol|ensolarado|ensolarada|chuva|chuvoso|chuvosa|fumaca|varzea|futsal)\b/;
  const visualDayPattern = /^\s*(?:para\s+dia\b|(?:(?:um|uma|o|a|outro|outra|novo|nova)\s+){0,3}(?:imagem|arte|visual)\s+(?:de|durante\s+o)\s+dia\b)/;
  const negationPattern = /\b(nao|nunca|jamais|nem|sem|evite|evitar|proibido|proibida)\b/;
  const followingNegationPattern = /^\s+(?:que\s+)?(?:nao|nunca|jamais|nem|sem)\b/;

  return normalized
    .split(/[\n,.!?;:]+|\b(?:mas|porem|contudo|entretanto|e)\b/)
    .some(segment => {
      actionPattern.lastIndex = 0;
      const matches = [...segment.matchAll(actionPattern)];
      for (let index = 0; index < matches.length; index += 1) {
        const match = matches[index];
        const previousWords = segment
          .slice(0, match.index)
          .match(/[a-z0-9]+/g) || [];
        const negationWindow = previousWords.slice(-6).join(" ");
        const nextActionIndex = matches[index + 1]?.index ?? segment.length;
        const followingText = segment.slice(
          match.index + match[0].length,
          nextActionIndex
        );

        if (
          negationPattern.test(negationWindow) ||
          followingNegationPattern.test(followingText)
        ) {
          continue;
        }

        if (scenePattern.test(followingText)) return true;
        if (
          visualVariantPattern.test(followingText) &&
          (
            directVariantPattern.test(followingText) ||
            visualDayPattern.test(followingText)
          )
        ) {
          return true;
        }
      }

      return false;
    });
}

function getScenarioObservationConflict(fields, resolution) {
  if (!resolution?.applies) return null;
  const cleanFields = fields?.new_model?.fields;
  if (!isPlainObject(cleanFields)) return null;

  for (const key of SCENARIO_OBSERVATION_KEYS) {
    if (hasScenarioObservationConflict(cleanFields[key])) {
      return { field: key };
    }
  }

  return null;
}

function getPedidoScenarioMeta(pedido = {}) {
  const fields = isPlainObject(pedido.fields) ? pedido.fields : {};
  const product = [pedido.product_id, pedido.categoria, pedido.produto]
    .map(getProductDefinition)
    .find(Boolean) || null;
  let scenarioId = typeof fields.scenario_id === "string"
    ? fields.scenario_id.trim().toLowerCase()
    : "";

  if (!scenarioId && product) scenarioId = product.defaultScenarioId;

  const scenario = scenarioId ? SCENARIOS[scenarioId] : null;
  const owner = getScenarioOwner(scenarioId);
  const scenarioMatchesProduct = !product || !owner || owner === product.id;
  const scenarioVersion = Number(fields.scenario_version || 0) || (
    scenario && scenarioMatchesProduct ? scenario.version : 0
  );
  const scenarioSource = fields.scenario_source === "explicit"
    ? "explicit"
    : (scenarioId ? "default" : "");

  return {
    scenario_id: scenarioId,
    scenario_version: scenarioVersion,
    scenario_source: scenarioSource
  };
}

module.exports = {
  SCENARIO_SCHEMA_VERSION,
  SCENARIO_VARIANTS,
  SCENARIO_PRODUCTS,
  SCENARIOS,
  RESULTADO_DEFAULT_SCENARIO_ID,
  RESULTADO_PRODUCT_ID,
  RESULTADO_PRODUCT_ALIASES,
  RESULTADO_RESERVED_SCENARIO_IDS,
  RESULTADO_SCENARIO_SCHEMA_VERSION,
  RESULTADO_SCENARIOS,
  applyProductScenario,
  applyResultadoScenario,
  getProductDefinition,
  getPedidoScenarioMeta,
  getScenarioOwner,
  getScenarioObservationConflict,
  hasScenarioObservationConflict,
  resolveProductScenario,
  resolveResultadoScenario,
  scenarioError
};
