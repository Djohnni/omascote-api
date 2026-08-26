"use strict";

const crypto = require("node:crypto");
const { RadarIdentityError } = require("./radar-identity.errors");
const { MODALITIES, VENUE_PREFERENCES } = require("./radar-identity.schemas");
const { containsPrivateContact } = require("./availability.schemas");

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const SLUG = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const ISO_WITH_ZONE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:\.\d{1,3})?)?(?:Z|[+-]\d{2}:\d{2})$/;
const PRIVATE_FIELDS = new Set([
  "team_id", "invited_team_id", "requester_team_id", "account_id", "profile_id",
  "legacy_profile_id", "phone", "telefone", "whatsapp", "email", "contact", "contato",
  "address", "endereco", "latitude", "longitude", "coordinates", "version", "state"
]);

function invitationError(code, status, message) {
  return new RadarIdentityError(code, status, message);
}

function invalid(field, message) {
  throw invitationError("INVITATION_VALIDATION_ERROR", 400, `${field}: ${message}`);
}

function plainObject(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function text(field, value, maximum, { required = true } = {}) {
  const normalized = String(value ?? "").replace(/\s+/g, " ").trim();
  if (required && !normalized) invalid(field, "campo obrigatorio");
  if (normalized.length > maximum) invalid(field, `use no maximo ${maximum} caracteres`);
  return normalized;
}

function date(field, value) {
  const raw = String(value ?? "").trim();
  if (!ISO_WITH_ZONE.test(raw)) invalid(field, "use data ISO 8601 com fuso horario");
  const parsed = new Date(raw);
  if (Number.isNaN(parsed.getTime())) invalid(field, "data invalida");
  return parsed.toISOString();
}

function normalizeProposal(input, { create }) {
  if (!plainObject(input)) invalid("body", "dados invalidos");
  const allowed = new Set([
    ...(create ? ["opponent_slug", "opponent_public_id"] : []),
    "starts_at", "ends_at", "modality", "category", "venue_preference", "message"
  ]);
  for (const field of Object.keys(input)) {
    if (PRIVATE_FIELDS.has(field)) invalid(field, "campo de propriedade ou dado privado nao permitido");
    if (!allowed.has(field)) invalid(field, "campo nao permitido");
  }
  const output = {};
  if (create) {
    const hasSlug = input.opponent_slug !== undefined && String(input.opponent_slug).trim() !== "";
    const hasPublicId = input.opponent_public_id !== undefined && String(input.opponent_public_id).trim() !== "";
    if (hasSlug === hasPublicId) invalid("opponent", "informe um unico identificador publico");
    if (hasPublicId) {
      output.opponentPublicId = validatePublicId(input.opponent_public_id, "opponent_public_id");
    } else {
      const slug = text("opponent_slug", input.opponent_slug, 96).toLowerCase();
      if (!SLUG.test(slug)) invalid("opponent_slug", "identificador publico invalido");
      output.opponentSlug = slug;
    }
  }
  output.startsAt = date("starts_at", input.starts_at);
  output.endsAt = date("ends_at", input.ends_at);
  const modality = text("modality", input.modality, 30).toLowerCase();
  if (!MODALITIES.has(modality)) invalid("modality", "modalidade invalida");
  output.modality = modality;
  const category = text("category", input.category, 40);
  if (!/^[\p{L}\p{M}\p{N} ._+\/-]{2,40}$/u.test(category)) invalid("category", "categoria invalida");
  output.category = category;
  const venue = text("venue_preference", input.venue_preference, 20).toLowerCase();
  if (!VENUE_PREFERENCES.has(venue)) invalid("venue_preference", "preferencia invalida");
  output.venuePreference = venue;
  const message = text("message", input.message, 180, { required: false });
  if (containsPrivateContact(message)) invalid("message", "nao informe contato, link ou rede social");
  output.message = message || null;
  return Object.freeze(output);
}

function validateInvitationWindow(value, { now, maxHorizonDays }) {
  const start = new Date(value.startsAt);
  const end = new Date(value.endsAt);
  if (start <= now) invalid("starts_at", "deve estar no futuro");
  if (end <= start) invalid("ends_at", "deve ser posterior ao inicio");
  if (end.getTime() - start.getTime() > 24 * 60 * 60 * 1000) invalid("ends_at", "duracao acima de 24 horas");
  if (start.getTime() > now.getTime() + maxHorizonDays * 24 * 60 * 60 * 1000) {
    invalid("starts_at", "data alem do horizonte permitido");
  }
}

function validatePublicId(value, field = "id") {
  const id = String(value || "").trim().toLowerCase();
  if (!UUID.test(id)) invalid(field, "identificador invalido");
  return id;
}

function validateExpectedVersion(value) {
  const raw = String(value ?? "").trim();
  if (!raw) throw invitationError("INVITATION_VERSION_REQUIRED", 428, "Informe a versao em If-Match.");
  const match = raw.match(/^(?:W\/)??"?(\d+)"?$/i);
  const version = match ? Number(match[1]) : NaN;
  if (!Number.isInteger(version) || version < 1) invalid("If-Match", "versao invalida");
  return version;
}

function validateEmptyBody(input) {
  if (input === undefined || input === null) return Object.freeze({});
  if (!plainObject(input) || Object.keys(input).length) invalid("body", "nenhum campo e permitido");
  return Object.freeze({});
}

function validateInvitationList(query, config) {
  const input = query || {};
  for (const field of Object.keys(input)) {
    if (!new Set(["caixa", "limit"]).has(field)) invalid(field, "filtro nao permitido");
  }
  const box = String(input.caixa || "").trim().toLowerCase();
  if (!new Set(["entrada", "saida"]).has(box)) invalid("caixa", "use entrada ou saida");
  const limit = input.limit === undefined ? config.invitationPageDefault : Number(input.limit);
  if (!Number.isInteger(limit) || limit < 1 || limit > config.invitationPageMaximum) invalid("limit", "limite invalido");
  return Object.freeze({ box, limit });
}

function validateNotificationList(query, config, decodeCursor) {
  const input = query || {};
  for (const field of Object.keys(input)) {
    if (!new Set(["cursor", "limit"]).has(field)) invalid(field, "filtro nao permitido");
  }
  const limit = input.limit === undefined ? config.notificationPageDefault : Number(input.limit);
  if (!Number.isInteger(limit) || limit < 1 || limit > config.notificationPageMaximum) invalid("limit", "limite invalido");
  return Object.freeze({ limit, cursor: input.cursor ? decodeCursor(String(input.cursor)) : null });
}

function stable(value) {
  if (Array.isArray(value)) return value.map(stable);
  if (!plainObject(value)) return value;
  return Object.keys(value).sort().reduce((result, key) => {
    result[key] = stable(value[key]);
    return result;
  }, {});
}

function hash(value) {
  return crypto.createHash("sha256").update(JSON.stringify(stable(value))).digest("hex");
}

module.exports = {
  invitationError,
  normalizeCreateInvitation: input => normalizeProposal(input, { create: true }),
  normalizeCounterProposal: input => normalizeProposal(input, { create: false }),
  validateInvitationWindow,
  validatePublicId,
  validateExpectedVersion,
  validateEmptyBody,
  validateInvitationList,
  validateNotificationList,
  invitationMutationHash: hash,
  proposalHash: hash
};
