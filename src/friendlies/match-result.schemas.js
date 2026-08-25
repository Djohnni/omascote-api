"use strict";

const crypto = require("node:crypto");
const { matchError, validateMatchId, validateExpectedVersion } = require("./match-center.schemas");

const PRIVATE_FIELDS = new Set([
  "team_id", "owner_id", "account_id", "profile_id", "legacy_profile_id",
  "phone", "telefone", "whatsapp", "email", "contact", "contato", "address", "endereco"
]);

function plainObject(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function invalid(field, message) {
  throw matchError("MATCH_RESULT_VALIDATION_ERROR", 400, `${field}: ${message}`);
}

function normalizeScore(input) {
  if (!plainObject(input)) invalid("body", "dados invalidos");
  const allowed = new Set(["gols_meu_time", "gols_adversario"]);
  for (const field of Object.keys(input)) {
    if (PRIVATE_FIELDS.has(field)) invalid(field, "campo privado ou de propriedade nao permitido");
    if (!allowed.has(field)) invalid(field, "campo nao permitido");
  }
  for (const field of allowed) {
    if (!Object.hasOwn(input, field)) invalid(field, "campo obrigatorio");
    if (!Number.isInteger(input[field]) || input[field] < 0 || input[field] > 99) {
      invalid(field, "use um inteiro entre 0 e 99");
    }
  }
  return Object.freeze({
    gols_meu_time: input.gols_meu_time,
    gols_adversario: input.gols_adversario
  });
}

function validateConfirmationBody(input) {
  if (input === undefined || input === null) return Object.freeze({});
  if (!plainObject(input) || Object.keys(input).length) invalid("body", "nenhum campo e permitido");
  return Object.freeze({});
}

function stable(value) {
  if (Array.isArray(value)) return value.map(stable);
  if (!plainObject(value)) return value;
  return Object.keys(value).sort().reduce((result, key) => {
    result[key] = stable(value[key]);
    return result;
  }, {});
}

function resultMutationHash(value) {
  return crypto.createHash("sha256").update(JSON.stringify(stable(value))).digest("hex");
}

function submissionHash(secret, value) {
  if (typeof secret !== "string" || Buffer.byteLength(secret, "utf8") < 32) {
    throw matchError("MATCH_RESULTS_CONFIGURATION_UNAVAILABLE", 503, "Placares temporariamente indisponiveis.");
  }
  return crypto.createHmac("sha256", secret).update(JSON.stringify(stable(value))).digest("hex");
}

module.exports = {
  normalizeScore,
  validateConfirmationBody,
  resultMutationHash,
  submissionHash,
  validateMatchId,
  validateExpectedVersion
};
