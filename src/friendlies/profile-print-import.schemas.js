"use strict";

const { RadarIdentityError } = require("./radar-identity.errors");
const {
  normalizeInstagramHandle,
  validateIdempotencyKey,
  MODALITIES,
  BRAZILIAN_STATE_CODES
} = require("./radar-identity.schemas");

const DRAFT_FIELDS = Object.freeze([
  "team_name",
  "city_name",
  "state_code",
  "instagram_handle",
  "modalities",
  "categories"
]);

const IDENTITY_FIELDS = new Set([
  "id", "team_id", "profile_id", "public_id", "legacy_profile_id",
  "account_id", "account_reference", "telefone", "phone", "whatsapp"
]);

function scalarSuggestion(valueSchema) {
  return {
    type: "object",
    additionalProperties: false,
    required: ["value", "confidence", "evidence"],
    properties: {
      value: valueSchema,
      confidence: { type: "number", minimum: 0, maximum: 1 },
      evidence: { type: ["string", "null"], maxLength: 240 }
    }
  };
}

const PROFILE_PRINT_DRAFT_JSON_SCHEMA = Object.freeze({
  type: "object",
  additionalProperties: false,
  required: ["schema_version", "suggestions", "warnings"],
  properties: {
    schema_version: { type: "string", const: "1.0" },
    suggestions: {
      type: "object",
      additionalProperties: false,
      required: DRAFT_FIELDS,
      properties: {
        team_name: scalarSuggestion({ type: ["string", "null"], maxLength: 120 }),
        city_name: scalarSuggestion({ type: ["string", "null"], maxLength: 120 }),
        state_code: scalarSuggestion({
          type: ["string", "null"],
          enum: [...BRAZILIAN_STATE_CODES, null]
        }),
        instagram_handle: scalarSuggestion({
          type: ["string", "null"],
          pattern: "^[A-Za-z0-9._]{1,30}$"
        }),
        modalities: scalarSuggestion({
          type: "array",
          maxItems: 3,
          uniqueItems: true,
          items: { type: "string", enum: [...MODALITIES] }
        }),
        categories: scalarSuggestion({
          type: "array",
          maxItems: 12,
          uniqueItems: true,
          items: { type: "string", minLength: 2, maxLength: 40 }
        })
      }
    },
    warnings: {
      type: "array",
      maxItems: 8,
      items: { type: "string", minLength: 1, maxLength: 240 }
    }
  }
});

function invalid(field, message) {
  throw new RadarIdentityError("VALIDATION_ERROR", 400, `${field}: ${message}`);
}

function exactKeys(value, expected, field) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new TypeError(`${field} must be an object`);
  }
  const keys = Object.keys(value).sort();
  const wanted = [...expected].sort();
  if (keys.length !== wanted.length || keys.some((key, index) => key !== wanted[index])) {
    throw new TypeError(`${field} has invalid fields`);
  }
}

function cleanText(value, maximum, field, { nullable = true } = {}) {
  if (value === null && nullable) return null;
  if (typeof value !== "string") throw new TypeError(`${field} must be text`);
  const normalized = value.replace(/[\u0000-\u001f\u007f]/g, " ").replace(/\s+/g, " ").trim();
  if (!normalized || normalized.length > maximum) throw new TypeError(`${field} is invalid`);
  return normalized;
}

function containsPrivateContact(value) {
  const text = String(value || "");
  const phoneLike = (text.match(/(?:\+?\d[\s().-]*){8,}/g) || [])
    .some(candidate => candidate.replace(/\D/g, "").length >= 8);
  return /\b(?:whats?app|telefone|celular|e-?mail)\b/i.test(text) ||
    /\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/i.test(text) ||
    phoneLike;
}

function cleanEvidence(value, field) {
  const text = cleanText(value, 240, field);
  if (text !== null && containsPrivateContact(text)) {
    throw new TypeError(`${field} contains private contact data`);
  }
  return text;
}

function confidence(value, field) {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0 || value > 1) {
    throw new TypeError(`${field} is invalid`);
  }
  return Number(value.toFixed(4));
}

function suggestion(value, field, normalizeValue) {
  exactKeys(value, ["value", "confidence", "evidence"], field);
  return Object.freeze({
    value: normalizeValue(value.value),
    confidence: confidence(value.confidence, `${field}.confidence`),
    evidence: cleanEvidence(value.evidence, `${field}.evidence`)
  });
}

function nullableText(maximum, pattern, transform = value => value) {
  return value => {
    const normalized = cleanText(value, maximum, "value");
    if (normalized === null) return null;
    const transformed = transform(normalized);
    if (pattern && !pattern.test(transformed)) throw new TypeError("value is invalid");
    return transformed;
  };
}

function enumOrNull(values, transform = value => value) {
  return value => {
    if (value === null) return null;
    const normalized = transform(cleanText(value, 40, "value", { nullable: false }));
    if (!values.has(normalized)) throw new TypeError("value is invalid");
    return normalized;
  };
}

function stringArray(value, { maximumItems, normalize, valid }) {
  if (!Array.isArray(value) || value.length > maximumItems) {
    throw new TypeError("value is invalid");
  }
  const normalized = value.map(normalize);
  if (normalized.some(item => !valid(item)) || new Set(normalized.map(item => item.toLowerCase())).size !== normalized.length) {
    throw new TypeError("value is invalid");
  }
  return Object.freeze(normalized);
}

function normalizeProfilePrintDraft(input) {
  exactKeys(input, ["schema_version", "suggestions", "warnings"], "draft");
  if (input.schema_version !== "1.0") throw new TypeError("draft schema version is invalid");
  exactKeys(input.suggestions, DRAFT_FIELDS, "suggestions");

  const suggestions = Object.freeze({
    team_name: suggestion(
      input.suggestions.team_name,
      "team_name",
      nullableText(120, /^[\p{L}\p{M}\p{N} ._'&+\/-]{2,120}$/u)
    ),
    city_name: suggestion(
      input.suggestions.city_name,
      "city_name",
      nullableText(120, /^[\p{L}\p{M} .'-]{2,120}$/u)
    ),
    state_code: suggestion(
      input.suggestions.state_code,
      "state_code",
      enumOrNull(BRAZILIAN_STATE_CODES, value => value.toUpperCase())
    ),
    instagram_handle: suggestion(
      input.suggestions.instagram_handle,
      "instagram_handle",
      nullableText(30, /^[A-Za-z0-9._]{1,30}$/, value => value.toLowerCase())
    ),
    modalities: suggestion(input.suggestions.modalities, "modalities", value => stringArray(value, {
      maximumItems: 3,
      normalize: item => cleanText(item, 30, "modalities", { nullable: false }).toLowerCase(),
      valid: item => MODALITIES.has(item)
    })),
    categories: suggestion(input.suggestions.categories, "categories", value => stringArray(value, {
      maximumItems: 12,
      normalize: item => cleanText(item, 40, "categories", { nullable: false }),
      valid: item => /^[\p{L}\p{M}\p{N} ._+\/-]{2,40}$/u.test(item)
    }))
  });

  if (!Array.isArray(input.warnings) || input.warnings.length > 8) {
    throw new TypeError("warnings is invalid");
  }
  const warnings = input.warnings.map((warning, index) => {
    const normalized = cleanText(warning, 240, `warnings.${index}`, { nullable: false });
    if (containsPrivateContact(normalized)) throw new TypeError("warning contains private contact data");
    return normalized;
  });

  return Object.freeze({
    schema_version: "1.0",
    suggestions,
    warnings: Object.freeze(warnings)
  });
}

function validateProfilePrintForm(fields = {}) {
  if (!fields || typeof fields !== "object" || Array.isArray(fields)) {
    invalid("form", "dados invalidos");
  }
  for (const field of Object.keys(fields)) {
    if (IDENTITY_FIELDS.has(field)) invalid(field, "campo de identidade nao pode ser informado");
    if (field !== "instagram_handle") invalid(field, "campo nao permitido");
    if (Array.isArray(fields[field])) invalid(field, "envie apenas um valor");
  }
  if (!Object.hasOwn(fields, "instagram_handle") || !String(fields.instagram_handle || "").trim()) {
    return Object.freeze({ instagramHandle: null });
  }
  const normalized = normalizeInstagramHandle(fields.instagram_handle).toLowerCase();
  if (!/^[a-z0-9._]{1,30}$/.test(normalized)) {
    invalid("instagram_handle", "usuario invalido");
  }
  return Object.freeze({ instagramHandle: normalized });
}

module.exports = {
  PROFILE_PRINT_DRAFT_JSON_SCHEMA,
  DRAFT_FIELDS,
  normalizeProfilePrintDraft,
  validateProfilePrintForm,
  validateIdempotencyKey,
  containsPrivateContact
};
