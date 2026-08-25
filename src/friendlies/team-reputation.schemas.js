"use strict";

const crypto = require("node:crypto");
const { RadarIdentityError } = require("./radar-identity.errors");
const { validateMatchId } = require("./match-center.schemas");

const PRIVATE_FIELDS = new Set([
  "team_id", "owner_id", "account_id", "profile_id", "legacy_profile_id",
  "phone", "telefone", "whatsapp", "email", "contact", "contato",
  "address", "endereco", "location", "localizacao", "reviewer", "avaliador",
  "comment", "comentario"
]);
const SCORE_FIELDS = Object.freeze([
  "pontualidade", "organizacao", "comunicacao", "fair_play"
]);

function reputationError(code, status, message) {
  return new RadarIdentityError(code, status, message);
}

function plainObject(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function normalizeReview(input) {
  if (!plainObject(input)) {
    throw reputationError("TEAM_REVIEW_VALIDATION_ERROR", 400, "Dados invalidos.");
  }
  const allowed = new Set([...SCORE_FIELDS, "jogaria_novamente"]);
  for (const field of Object.keys(input)) {
    if (PRIVATE_FIELDS.has(field) || !allowed.has(field)) {
      throw reputationError("TEAM_REVIEW_VALIDATION_ERROR", 400, `${field}: campo nao permitido.`);
    }
  }
  for (const field of SCORE_FIELDS) {
    if (!Number.isInteger(input[field]) || input[field] < 1 || input[field] > 5) {
      throw reputationError("TEAM_REVIEW_VALIDATION_ERROR", 400, `${field}: use um inteiro entre 1 e 5.`);
    }
  }
  if (typeof input.jogaria_novamente !== "boolean") {
    throw reputationError("TEAM_REVIEW_VALIDATION_ERROR", 400, "jogaria_novamente: use verdadeiro ou falso.");
  }
  return Object.freeze({
    pontualidade: input.pontualidade,
    organizacao: input.organizacao,
    comunicacao: input.comunicacao,
    fair_play: input.fair_play,
    jogaria_novamente: input.jogaria_novamente
  });
}

function stable(value) {
  if (Array.isArray(value)) return value.map(stable);
  if (!plainObject(value)) return value;
  return Object.keys(value).sort().reduce((result, key) => {
    result[key] = stable(value[key]);
    return result;
  }, {});
}

function reviewPayloadHash(secret, value) {
  if (typeof secret !== "string" || Buffer.byteLength(secret, "utf8") < 32) {
    throw reputationError("TEAM_REPUTATION_CONFIGURATION_UNAVAILABLE", 503, "Avaliacoes temporariamente indisponiveis.");
  }
  return crypto.createHmac("sha256", secret)
    .update(JSON.stringify(stable(value)))
    .digest("hex");
}

function validateTeamPublicId(value) {
  return validateMatchId(value);
}

module.exports = {
  SCORE_FIELDS,
  normalizeReview,
  reputationError,
  reviewPayloadHash,
  validateMatchId,
  validateTeamPublicId
};
