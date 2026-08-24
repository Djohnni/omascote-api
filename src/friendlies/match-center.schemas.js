"use strict";

const crypto = require("node:crypto");
const { RadarIdentityError } = require("./radar-identity.errors");

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const CANCELLATION_REASONS = new Set([
  "weather", "field_unavailable", "team_unavailable",
  "scheduling_conflict", "safety", "other"
]);
const PRIVATE_FIELDS = new Set([
  "team_id", "owner_id", "account_id", "profile_id", "legacy_profile_id",
  "phone", "telefone", "whatsapp", "email", "contact", "contato", "address", "endereco"
]);

function matchError(code, status, message) {
  return new RadarIdentityError(code, status, message);
}

function invalid(field, message) {
  throw matchError("MATCH_VALIDATION_ERROR", 400, `${field}: ${message}`);
}

function plainObject(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function validateMatchId(value) {
  const id = String(value || "").trim().toLowerCase();
  if (!UUID.test(id)) invalid("matchId", "identificador invalido");
  return id;
}

function validateExpectedVersion(value) {
  const raw = String(value ?? "").trim();
  if (!raw) throw matchError("MATCH_VERSION_REQUIRED", 428, "Informe a versao em If-Match.");
  const found = raw.match(/^(?:W\/)??"?(\d+)"?$/i);
  const version = found ? Number(found[1]) : NaN;
  if (!Number.isInteger(version) || version < 1) invalid("If-Match", "versao invalida");
  return version;
}

function validateEmptyBody(input) {
  if (input === undefined || input === null) return Object.freeze({});
  if (!plainObject(input) || Object.keys(input).length) invalid("body", "nenhum campo e permitido");
  return Object.freeze({});
}

function normalizeCancellation(input) {
  if (!plainObject(input)) invalid("body", "dados invalidos");
  for (const field of Object.keys(input)) {
    if (PRIVATE_FIELDS.has(field)) invalid(field, "campo privado ou de propriedade nao permitido");
    if (field !== "reason") invalid(field, "campo nao permitido");
  }
  const reason = String(input.reason || "").trim().toLowerCase();
  if (!CANCELLATION_REASONS.has(reason)) invalid("reason", "motivo invalido");
  return Object.freeze({ reason });
}

function validateMatchList(query, config) {
  const input = query || {};
  for (const field of Object.keys(input)) {
    if (!new Set(["estado", "limit"]).has(field)) invalid(field, "filtro nao permitido");
  }
  const state = String(input.estado || "todas").trim().toLowerCase();
  if (!new Set(["proximas", "historico", "todas"]).has(state)) invalid("estado", "filtro invalido");
  const limit = input.limit === undefined ? config.matchPageDefault : Number(input.limit);
  if (!Number.isInteger(limit) || limit < 1 || limit > config.matchPageMaximum) invalid("limit", "limite invalido");
  return Object.freeze({ state, limit });
}

function stable(value) {
  if (Array.isArray(value)) return value.map(stable);
  if (!plainObject(value)) return value;
  return Object.keys(value).sort().reduce((result, key) => {
    result[key] = stable(value[key]);
    return result;
  }, {});
}

function mutationHash(value) {
  return crypto.createHash("sha256").update(JSON.stringify(stable(value))).digest("hex");
}

function safeResolvedContact(value) {
  if (!plainObject(value)) return null;
  const type = String(value.type || "").trim().toLowerCase();
  const contact = String(value.value || "").replace(/\s+/g, " ").trim();
  if (type === "whatsapp" && /^\+[1-9]\d{9,14}$/.test(contact)) {
    return Object.freeze({ type, value: contact });
  }
  if (type === "email" && contact.length <= 254 && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(contact)) {
    return Object.freeze({ type, value: contact.toLowerCase() });
  }
  return null;
}

module.exports = {
  CANCELLATION_REASONS,
  matchError,
  validateMatchId,
  validateExpectedVersion,
  validateEmptyBody,
  normalizeCancellation,
  validateMatchList,
  mutationHash,
  safeResolvedContact
};
