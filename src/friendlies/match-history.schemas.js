"use strict";

const { RadarIdentityError } = require("./radar-identity.errors");

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const PERIODS = new Set(["30d", "90d", "365d", "all"]);
const SITUATIONS = new Set(["all", "official", "divergent", "cancelled", "pending"]);
const ALLOWED_FIELDS = new Set(["periodo", "situacao", "cursor", "limit"]);

function historyError(code, status, message) {
  return new RadarIdentityError(code, status, message);
}

function invalid(field, message) {
  throw historyError("MATCH_HISTORY_VALIDATION_ERROR", 400, `${field}: ${message}`);
}

function scalar(field, value) {
  if (Array.isArray(value) || (value && typeof value === "object")) {
    invalid(field, "informe um unico valor");
  }
  return String(value ?? "").trim();
}

function validateOpponentPublicId(value) {
  const id = String(value || "").trim().toLowerCase();
  if (!UUID.test(id)) invalid("opponentPublicId", "identificador invalido");
  return id;
}

function validateHistoryQuery(query, config, now = new Date()) {
  const input = query || {};
  for (const field of Object.keys(input)) {
    if (!ALLOWED_FIELDS.has(field)) invalid(field, "filtro nao permitido");
  }

  const period = scalar("periodo", input.periodo || "all").toLowerCase();
  if (!PERIODS.has(period)) invalid("periodo", "use 30d, 90d, 365d ou all");

  const situation = scalar("situacao", input.situacao || "all").toLowerCase();
  if (!SITUATIONS.has(situation)) {
    invalid("situacao", "use official, divergent, cancelled, pending ou all");
  }

  const limit = input.limit === undefined || input.limit === ""
    ? config.matchHistoryPageDefault
    : Number(scalar("limit", input.limit));
  if (!Number.isInteger(limit) || limit < 1 || limit > config.matchHistoryPageMaximum) {
    invalid("limit", `use um inteiro entre 1 e ${config.matchHistoryPageMaximum}`);
  }

  const cursor = scalar("cursor", input.cursor) || null;
  if (cursor && cursor.length > 1800) invalid("cursor", "cursor invalido");

  const days = period === "30d" ? 30 : period === "90d" ? 90 : period === "365d" ? 365 : null;
  const periodFrom = days === null ? null : new Date(now.getTime() - days * 24 * 60 * 60 * 1000);
  return Object.freeze({ period, periodFrom, situation, limit, cursor });
}

function boundHistoryFilters(filters) {
  return Object.freeze({ periodo: filters.period, situacao: filters.situation });
}

module.exports = {
  PERIODS,
  SITUATIONS,
  historyError,
  validateOpponentPublicId,
  validateHistoryQuery,
  boundHistoryFilters
};
