"use strict";

const { RadarIdentityError } = require("./radar-identity.errors");

const ALLOWED_FIELDS = new Set([
  "city_name",
  "state_code",
  "instagram_handle",
  "modalities",
  "categories",
  "travel_radius_km",
  "venue_preference",
  "availability_active",
  "accept_terms",
  "whatsapp",
  "whatsapp_visible"
]);

const IDENTITY_FIELDS = new Set([
  "id",
  "team_id",
  "public_id",
  "profile_id",
  "legacy_profile_id",
  "account_id",
  "account_reference",
  "telefone",
  "phone",
  "status",
  "instagram_verification_status"
]);

const MODALITIES = new Set(["futebol_campo", "futsal", "society"]);
const VENUE_PREFERENCES = new Set(["home", "away", "either"]);
const BRAZILIAN_STATE_CODES = new Set([
  "AC", "AL", "AP", "AM", "BA", "CE", "DF", "ES", "GO", "MA", "MT", "MS",
  "MG", "PA", "PB", "PR", "PE", "PI", "RJ", "RN", "RS", "RO", "RR", "SC",
  "SP", "SE", "TO"
]);

function text(field, value, max) {
  const normalized = String(value ?? "").replace(/\s+/g, " ").trim();
  if (normalized.length > max) invalid(field, `use no maximo ${max} caracteres`);
  return normalized;
}

function instagramHandle(value) {
  const raw = text("instagram_handle", value, 120);
  if (/^https?:\/\//i.test(raw) && !/^https?:\/\/(www\.)?instagram\.com\//i.test(raw)) {
    invalid("instagram_handle", "use um usuario ou link do Instagram");
  }
  return raw
    .replace(/^https?:\/\/(www\.)?instagram\.com\//i, "")
    .replace(/^@+/, "")
    .replace(/[/?#].*$/, "")
    .trim();
}

function uniqueStrings(values, normalize) {
  const seen = new Set();
  const result = [];
  for (const value of values) {
    const normalized = normalize(value);
    if (!normalized) continue;
    const key = normalized.toLowerCase();
    if (!seen.has(key)) {
      seen.add(key);
      result.push(normalized);
    }
  }
  return result;
}

function invalid(field, message) {
  throw new RadarIdentityError("VALIDATION_ERROR", 400, `${field}: ${message}`);
}

function validateRadarProfileInput(input) {
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    throw new RadarIdentityError("VALIDATION_ERROR", 400, "Dados do Radar invalidos.");
  }

  for (const field of Object.keys(input)) {
    if (IDENTITY_FIELDS.has(field)) invalid(field, "campo de identidade nao pode ser informado");
    if (!ALLOWED_FIELDS.has(field)) invalid(field, "campo nao permitido");
  }
  if (Object.keys(input).length === 0) invalid("body", "informe ao menos um campo");

  const output = {};
  if (Object.hasOwn(input, "city_name")) {
    const value = text("city_name", input.city_name, 120);
    if (!/^[\p{L}\p{M} .'-]{2,120}$/u.test(value)) invalid("city_name", "cidade invalida");
    output.cityName = value;
  }
  if (Object.hasOwn(input, "state_code")) {
    const value = text("state_code", input.state_code, 2).toUpperCase();
    if (!BRAZILIAN_STATE_CODES.has(value)) invalid("state_code", "use uma UF valida");
    output.stateCode = value;
  }
  if (Object.hasOwn(input, "instagram_handle")) {
    const value = instagramHandle(input.instagram_handle);
    if (!/^[A-Za-z0-9._]{1,30}$/.test(value)) invalid("instagram_handle", "usuario invalido");
    output.instagramHandle = value.toLowerCase();
  }
  if (Object.hasOwn(input, "modalities")) {
    if (!Array.isArray(input.modalities) || input.modalities.length < 1 || input.modalities.length > 3) {
      invalid("modalities", "selecione de uma a tres modalidades");
    }
    const values = uniqueStrings(
      input.modalities,
      value => text("modalities", value, 30).toLowerCase()
    );
    if (values.some(value => !MODALITIES.has(value))) invalid("modalities", "modalidade invalida");
    output.modalities = values;
  }
  if (Object.hasOwn(input, "categories")) {
    if (!Array.isArray(input.categories) || input.categories.length > 12) {
      invalid("categories", "lista invalida");
    }
    const values = uniqueStrings(
      input.categories,
      value => text("categories", value, 40)
    );
    if (values.some(value => !/^[\p{L}\p{N} ._+\/-]{2,40}$/u.test(value))) {
      invalid("categories", "categoria invalida");
    }
    output.categories = values;
  }
  if (Object.hasOwn(input, "travel_radius_km")) {
    const value = Number(input.travel_radius_km);
    if (!Number.isInteger(value) || value < 1 || value > 500) {
      invalid("travel_radius_km", "use um inteiro entre 1 e 500");
    }
    output.travelRadiusKm = value;
  }
  if (Object.hasOwn(input, "venue_preference")) {
    const value = text("venue_preference", input.venue_preference, 20).toLowerCase();
    if (!VENUE_PREFERENCES.has(value)) invalid("venue_preference", "preferencia invalida");
    output.venuePreference = value;
  }
  if (Object.hasOwn(input, "availability_active")) {
    if (typeof input.availability_active !== "boolean") invalid("availability_active", "use booleano");
    output.availabilityActive = input.availability_active;
  }
  if (Object.hasOwn(input, "accept_terms")) {
    if (input.accept_terms !== true) invalid("accept_terms", "o aceite deve ser explicito");
    output.acceptTerms = true;
  }
  if (Object.hasOwn(input, "whatsapp")) {
    const value = text("whatsapp", input.whatsapp, 32);
    output.whatsapp = value || null;
  }
  if (Object.hasOwn(input, "whatsapp_visible")) {
    if (typeof input.whatsapp_visible !== "boolean") invalid("whatsapp_visible", "use booleano");
    output.whatsappVisible = input.whatsapp_visible;
  }

  return Object.freeze(output);
}

function validateIdempotencyKey(value, { required = false } = {}) {
  const key = String(value || "").trim();
  if (!key && !required) return null;
  if (!/^[A-Za-z0-9._:-]{8,200}$/.test(key)) {
    throw new RadarIdentityError(
      "INVALID_IDEMPOTENCY_KEY",
      400,
      "Idempotency-Key invalida."
    );
  }
  return key;
}

function validateExpectedVersion(value) {
  const raw = String(value ?? "").trim();
  if (!raw) return null;
  const match = raw.match(/^(?:W\/)?"?(\d+)"?$/i);
  const version = match ? Number(match[1]) : NaN;
  if (!Number.isInteger(version) || version < 1) {
    throw new RadarIdentityError(
      "INVALID_PROFILE_VERSION",
      400,
      "If-Match deve conter a versao numerica do perfil."
    );
  }
  return version;
}

module.exports = {
  validateRadarProfileInput,
  validateIdempotencyKey,
  validateExpectedVersion,
  normalizeInstagramHandle: instagramHandle,
  MODALITIES,
  VENUE_PREFERENCES,
  BRAZILIAN_STATE_CODES
};
