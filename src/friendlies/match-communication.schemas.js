"use strict";

const crypto = require("node:crypto");
const { RadarIdentityError } = require("./radar-identity.errors");
const { validateIdempotencyKey } = require("./radar-identity.schemas");

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const REPORT_CATEGORIES = new Set([
  "harassment", "spam", "inappropriate_content", "unsafe_conduct", "other"
]);

function error(code, status, message) {
  return new RadarIdentityError(code, status, message);
}

function uuid(value, code = "MATCH_NOT_FOUND") {
  const normalized = String(value || "").trim().toLowerCase();
  if (!UUID.test(normalized)) throw error(code, 404, "Partida nao encontrada.");
  return normalized;
}

function normalizeMessage(body) {
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    throw error("MATCH_MESSAGE_INVALID", 400, "Mensagem invalida.");
  }
  const allowed = new Set(["texto"]);
  if (Object.keys(body).some(key => !allowed.has(key))) {
    throw error("MATCH_MESSAGE_INVALID", 400, "Mensagem invalida.");
  }
  const text = String(body.texto || "").normalize("NFC").replace(/\r\n?/g, "\n").trim();
  if (!text || [...text].length > 1000 || /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/u.test(text)) {
    throw error("MATCH_MESSAGE_INVALID", 400, "Use ate 1000 caracteres.");
  }
  if (/[<>]/u.test(text) || /(?:javascript|data|vbscript)\s*:/iu.test(text) || /(?:^|\s)http:\/\//iu.test(text)) {
    throw error("MATCH_MESSAGE_UNSAFE", 400, "Envie somente texto e links HTTPS.");
  }
  return Object.freeze({ text });
}

function normalizeRead(body) {
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    throw error("MATCH_MESSAGE_READ_INVALID", 400, "Leitura invalida.");
  }
  if (Object.keys(body).some(key => key !== "ultima_mensagem_id")) {
    throw error("MATCH_MESSAGE_READ_INVALID", 400, "Leitura invalida.");
  }
  return Object.freeze({ messagePublicId: uuid(body.ultima_mensagem_id, "MATCH_MESSAGE_NOT_FOUND") });
}

function normalizeReport(body) {
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    throw error("MATCH_MESSAGE_REPORT_INVALID", 400, "Denuncia invalida.");
  }
  if (Object.keys(body).some(key => key !== "categoria")) {
    throw error("MATCH_MESSAGE_REPORT_INVALID", 400, "Denuncia invalida.");
  }
  const category = String(body.categoria || "").trim().toLowerCase();
  if (!REPORT_CATEGORIES.has(category)) {
    throw error("MATCH_MESSAGE_REPORT_INVALID", 400, "Selecione um motivo.");
  }
  return Object.freeze({ category });
}

function normalizeList(query, config) {
  const input = query && typeof query === "object" ? query : {};
  if (Object.keys(input).some(key => !["cursor", "limit"].includes(key))) {
    throw error("MATCH_COMMUNICATION_QUERY_INVALID", 400, "Consulta invalida.");
  }
  const maximum = Math.max(1, Number(config.matchCommunicationPageMaximum || 50));
  const requested = input.limit === undefined ? Number(config.matchCommunicationPageDefault || 30) : Number(input.limit);
  if (!Number.isInteger(requested) || requested < 1 || requested > maximum) {
    throw error("MATCH_COMMUNICATION_QUERY_INVALID", 400, "Limite invalido.");
  }
  return Object.freeze({ cursor: input.cursor || null, limit: requested });
}

function validateMutationKey(value) {
  return validateIdempotencyKey(value, { required: true });
}

function requestId(value) {
  const normalized = String(value || "").trim();
  return /^[A-Za-z0-9._:-]{1,120}$/.test(normalized) ? normalized : null;
}

function safeRequestFingerprint(value) {
  return crypto.createHash("sha256").update(String(value || "")).digest("hex");
}

module.exports = {
  UUID,
  REPORT_CATEGORIES,
  error,
  uuid,
  normalizeMessage,
  normalizeRead,
  normalizeReport,
  normalizeList,
  validateMutationKey,
  requestId,
  safeRequestFingerprint
};
