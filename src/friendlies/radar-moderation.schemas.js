"use strict";

const crypto = require("node:crypto");
const { RadarIdentityError } = require("./radar-identity.errors");
const { validateIdempotencyKey } = require("./radar-identity.schemas");

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const BLOCK_REASONS = new Set(["unwanted_contact", "conduct", "safety", "other"]);
const REPORT_CATEGORIES = new Set([
  "unsafe_conduct", "harassment", "identity_fraud", "spam",
  "inappropriate_content", "other"
]);
const DISPUTE_CATEGORIES = new Set(["score_incorrect", "identity_fraud", "other"]);
const ASSIGN_REASONS = new Set(["triage", "specialty", "workload"]);
const RESOLUTION_REASONS = new Set([
  "no_violation", "insufficient_evidence", "violation_confirmed",
  "invalid_review", "invalid_result"
]);
const RESOLUTION_ACTIONS = new Set([
  "dismiss", "warn", "invalidate_review", "invalidate_result", "suspend_team"
]);
const FORBIDDEN = new Set([
  "team_id", "owner_team_id", "reporter_team_id", "reported_team_id",
  "account_id", "profile_id", "phone", "telefone", "whatsapp", "email", "contact", "contato"
]);

function moderationError(code, status, message) {
  return new RadarIdentityError(code, status, message);
}

function objectBody(body) {
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    throw moderationError("RADAR_MODERATION_VALIDATION_ERROR", 400, "Dados invalidos.");
  }
  for (const key of Object.keys(body)) {
    if (FORBIDDEN.has(key)) {
      throw moderationError("RADAR_MODERATION_OWNER_ID_FORBIDDEN", 400, `${key}: campo nao permitido.`);
    }
  }
  return body;
}

function allowOnly(body, allowed) {
  for (const key of Object.keys(body)) {
    if (!allowed.has(key)) {
      throw moderationError("RADAR_MODERATION_VALIDATION_ERROR", 400, `${key}: campo nao permitido.`);
    }
  }
}

function publicId(value, field) {
  const id = String(value || "").trim().toLowerCase();
  if (!UUID.test(id)) {
    throw moderationError("RADAR_MODERATION_VALIDATION_ERROR", 400, `${field}: identificador invalido.`);
  }
  return id;
}

function shortDescription(value, maximum = 500) {
  if (value === undefined || value === null || String(value).trim() === "") return null;
  const normalized = String(value).replace(/\s+/g, " ").trim();
  if (normalized.length > maximum) {
    throw moderationError("RADAR_MODERATION_VALIDATION_ERROR", 400, `descricao: use no maximo ${maximum} caracteres.`);
  }
  return normalized;
}

function member(value, values, field) {
  const normalized = String(value || "").trim().toLowerCase();
  if (!values.has(normalized)) {
    throw moderationError("RADAR_MODERATION_VALIDATION_ERROR", 400, `${field}: opcao invalida.`);
  }
  return normalized;
}

function normalizeBlock(body) {
  const value = objectBody(body);
  allowOnly(value, new Set(["team_public_id", "motivo"]));
  return Object.freeze({
    teamPublicId: publicId(value.team_public_id, "team_public_id"),
    reason: member(value.motivo, BLOCK_REASONS, "motivo")
  });
}

function normalizeReport(body, maximum) {
  const value = objectBody(body);
  allowOnly(value, new Set(["tipo", "team_public_id", "match_id", "categoria", "descricao"]));
  const type = String(value.tipo || "").trim().toLowerCase();
  if (!new Set(["time", "partida"]).has(type)) {
    throw moderationError("RADAR_MODERATION_VALIDATION_ERROR", 400, "tipo: use time ou partida.");
  }
  if ((type === "time") !== Boolean(value.team_public_id) || (type === "partida") !== Boolean(value.match_id)) {
    throw moderationError("RADAR_MODERATION_VALIDATION_ERROR", 400, "Informe somente o alvo correspondente ao tipo.");
  }
  return Object.freeze({
    type,
    teamPublicId: type === "time" ? publicId(value.team_public_id, "team_public_id") : null,
    matchPublicId: type === "partida" ? publicId(value.match_id, "match_id") : null,
    category: member(value.categoria, REPORT_CATEGORIES, "categoria"),
    description: shortDescription(value.descricao, maximum)
  });
}

function normalizeDispute(body, maximum) {
  const value = objectBody(body);
  allowOnly(value, new Set(["motivo", "descricao"]));
  return Object.freeze({
    category: member(value.motivo, DISPUTE_CATEGORIES, "motivo"),
    description: shortDescription(value.descricao, maximum)
  });
}

function normalizeExit(body) {
  const value = objectBody(body);
  allowOnly(value, new Set(["confirmacao"]));
  if (value.confirmacao !== "SAIR_DO_RADAR") {
    throw moderationError("RADAR_EXIT_CONFIRMATION_REQUIRED", 400, "Confirme a saida do Radar.");
  }
  return Object.freeze({ confirmation: "SAIR_DO_RADAR" });
}

function expectedVersion(value) {
  const raw = String(value || "").trim().replace(/^W\//i, "").replace(/^"|"$/g, "");
  const version = Number(raw);
  if (!Number.isInteger(version) || version < 1) {
    throw moderationError("RADAR_MODERATION_VERSION_REQUIRED", 428, "Informe a versao atual em If-Match.");
  }
  return version;
}

function normalizeAssign(body) {
  const value = objectBody(body);
  allowOnly(value, new Set(["motivo"]));
  return Object.freeze({ reason: member(value.motivo, ASSIGN_REASONS, "motivo") });
}

function normalizeResolution(body) {
  const value = objectBody(body);
  allowOnly(value, new Set(["decisao", "motivo"]));
  const action = member(value.decisao, RESOLUTION_ACTIONS, "decisao");
  const reason = member(value.motivo, RESOLUTION_REASONS, "motivo");
  if (action === "dismiss" && !new Set(["no_violation", "insufficient_evidence"]).has(reason)) {
    throw moderationError("RADAR_MODERATION_VALIDATION_ERROR", 400, "Motivo incompativel com a decisao.");
  }
  if (action === "invalidate_review" && reason !== "invalid_review") {
    throw moderationError("RADAR_MODERATION_VALIDATION_ERROR", 400, "Use o motivo de avaliacao invalida.");
  }
  if (action === "invalidate_result" && reason !== "invalid_result") {
    throw moderationError("RADAR_MODERATION_VALIDATION_ERROR", 400, "Use o motivo de resultado invalido.");
  }
  return Object.freeze({ action, reason });
}

function mutationKey(value) {
  return validateIdempotencyKey(value, { required: true });
}

function payloadHash(secret, value) {
  return crypto.createHmac("sha256", secret)
    .update("radar-moderation-payload-v1\0")
    .update(JSON.stringify(value))
    .digest("hex");
}

function scopeHash(secret, type, value) {
  return crypto.createHmac("sha256", secret)
    .update(`radar-moderation-${type}-v1\0`)
    .update(String(value || "unknown"))
    .digest("hex");
}

module.exports = {
  moderationError,
  publicId,
  normalizeBlock,
  normalizeReport,
  normalizeDispute,
  normalizeExit,
  normalizeAssign,
  normalizeResolution,
  expectedVersion,
  mutationKey,
  payloadHash,
  scopeHash
};
