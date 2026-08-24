"use strict";

const crypto = require("node:crypto");
const { RadarIdentityError } = require("./radar-identity.errors");
const { MODALITIES, VENUE_PREFERENCES } = require("./radar-identity.schemas");

const STATUS_VALUES = new Set(["active", "paused", "expired", "cancelled"]);
const MUTABLE_STATUS_VALUES = new Set(["active", "paused"]);
const WEEK_DAYS = new Set([
  "monday", "tuesday", "wednesday", "thursday", "friday", "saturday", "sunday"
]);
const MUTATION_FIELDS = new Set([
  "modality", "category", "starts_at", "ends_at", "recurrence",
  "travel_radius_km", "venue_preference", "notes", "status"
]);
const OWNERSHIP_OR_PRIVATE_FIELDS = new Set([
  "id", "public_id", "team_id", "radar_team_id", "account_id", "account_reference",
  "profile_id", "legacy_profile_id", "declared_level", "city_ibge_code", "city_name",
  "state_code", "latitude", "longitude", "coordinates", "gps", "address", "endereco",
  "phone", "telefone", "whatsapp", "email", "contact", "contato", "version"
]);
const ISO_WITH_ZONE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:\.\d{1,3})?)?(?:Z|[+-]\d{2}:\d{2})$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function invalid(field, message, code = "AVAILABILITY_VALIDATION_ERROR") {
  throw new RadarIdentityError(code, 400, `${field}: ${message}`);
}

function plainObject(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function normalizedText(field, value, maximum, { required = true } = {}) {
  const text = String(value ?? "").replace(/\s+/g, " ").trim();
  if (required && !text) invalid(field, "campo obrigatorio");
  if (text.length > maximum) invalid(field, `use no maximo ${maximum} caracteres`);
  return text;
}

function isoDate(field, value) {
  const raw = String(value ?? "").trim();
  if (!ISO_WITH_ZONE.test(raw)) invalid(field, "use data ISO 8601 com fuso horario");
  const parsed = new Date(raw);
  if (Number.isNaN(parsed.getTime())) invalid(field, "data invalida");
  return parsed.toISOString();
}

function timeMinutes(field, value) {
  const raw = String(value ?? "").trim();
  if (!/^(?:[01][0-9]|2[0-3]):[0-5][0-9]$/.test(raw)) {
    invalid(field, "use horario HH:MM valido");
  }
  const [hours, minutes] = raw.split(":").map(Number);
  return { raw, value: hours * 60 + minutes };
}

function normalizeRecurrence(value) {
  if (value === null || value === undefined) return null;
  if (!plainObject(value)) invalid("recurrence", "recorrencia invalida");
  const allowed = new Set(["frequency", "days_of_week", "start_time", "end_time", "until"]);
  for (const field of Object.keys(value)) {
    if (!allowed.has(field)) invalid(`recurrence.${field}`, "campo nao permitido");
  }
  if (String(value.frequency || "").toLowerCase() !== "weekly") {
    invalid("recurrence.frequency", "somente weekly e permitido");
  }
  if (!Array.isArray(value.days_of_week) || value.days_of_week.length < 1 || value.days_of_week.length > 7) {
    invalid("recurrence.days_of_week", "informe de um a sete dias");
  }
  const days = [];
  const seen = new Set();
  for (const item of value.days_of_week) {
    const day = String(item || "").trim().toLowerCase();
    if (!WEEK_DAYS.has(day)) invalid("recurrence.days_of_week", "dia da semana invalido");
    if (seen.has(day)) invalid("recurrence.days_of_week", "nao repita dias");
    seen.add(day);
    days.push(day);
  }
  const start = timeMinutes("recurrence.start_time", value.start_time);
  const end = timeMinutes("recurrence.end_time", value.end_time);
  if (end.value <= start.value) invalid("recurrence.end_time", "deve ser posterior ao inicio");
  const until = String(value.until || "").trim();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(until) || Number.isNaN(new Date(`${until}T12:00:00-03:00`).getTime())) {
    invalid("recurrence.until", "use uma data valida no formato YYYY-MM-DD");
  }
  return Object.freeze({
    frequency: "weekly",
    days_of_week: Object.freeze(days),
    start_time: start.raw,
    end_time: end.raw,
    until,
    time_zone: "America/Sao_Paulo"
  });
}

function containsPrivateContact(value) {
  const text = String(value || "");
  return /(?:https?:\/\/|www\.|\b[a-z0-9.-]+\.(?:com|com\.br|net|org|br)(?:\/|\b)|@[a-z0-9._]{1,30}\b|[a-z0-9._%+-]+@[a-z0-9.-]+\.[a-z]{2,}|\b(?:whats(?:app)?|zap|telefone|celular|instagram|facebook|tiktok|youtube|telegram|contato)\b|(?:\+?\d[\d\s().-]{7,}\d))/i.test(text);
}

function normalizeMutationBody(input, { partial }) {
  if (!plainObject(input)) invalid("body", "dados invalidos");
  const keys = Object.keys(input);
  if (keys.length === 0) invalid("body", "informe ao menos um campo");
  for (const field of keys) {
    if (OWNERSHIP_OR_PRIVATE_FIELDS.has(field)) {
      invalid(field, "campo de propriedade ou dado privado nao pode ser informado");
    }
    if (!MUTATION_FIELDS.has(field)) invalid(field, "campo nao permitido");
  }

  const output = {};
  if (Object.hasOwn(input, "modality")) {
    const modality = normalizedText("modality", input.modality, 30).toLowerCase();
    if (!MODALITIES.has(modality)) invalid("modality", "modalidade invalida");
    output.modality = modality;
  }
  if (Object.hasOwn(input, "category")) {
    const category = normalizedText("category", input.category, 40);
    if (!/^[\p{L}\p{M}\p{N} ._+\/-]{2,40}$/u.test(category)) invalid("category", "categoria invalida");
    output.category = category;
  }
  if (Object.hasOwn(input, "starts_at")) output.startsAt = isoDate("starts_at", input.starts_at);
  if (Object.hasOwn(input, "ends_at")) output.endsAt = isoDate("ends_at", input.ends_at);
  if (Object.hasOwn(input, "recurrence")) output.recurrence = normalizeRecurrence(input.recurrence);
  if (Object.hasOwn(input, "travel_radius_km")) {
    const radius = Number(input.travel_radius_km);
    if (!Number.isInteger(radius) || radius < 1 || radius > 500) {
      invalid("travel_radius_km", "use um inteiro entre 1 e 500");
    }
    output.travelRadiusKm = radius;
  }
  if (Object.hasOwn(input, "venue_preference")) {
    const preference = normalizedText("venue_preference", input.venue_preference, 20).toLowerCase();
    if (!VENUE_PREFERENCES.has(preference)) invalid("venue_preference", "preferencia invalida");
    output.venuePreference = preference;
  }
  if (Object.hasOwn(input, "notes")) {
    const notes = normalizedText("notes", input.notes, 280, { required: false });
    if (containsPrivateContact(notes)) invalid("notes", "nao informe contato, link ou rede social");
    output.notes = notes || null;
  }
  if (Object.hasOwn(input, "status")) {
    const status = normalizedText("status", input.status, 20).toLowerCase();
    if (!MUTABLE_STATUS_VALUES.has(status)) invalid("status", "use apenas active ou paused");
    output.status = status;
  }

  if (!partial) {
    for (const field of ["modality", "category", "startsAt", "endsAt"]) {
      if (!Object.hasOwn(output, field)) invalid(field.replace(/[A-Z]/g, letter => `_${letter.toLowerCase()}`), "campo obrigatorio");
    }
    if (!Object.hasOwn(output, "status")) output.status = "active";
  }
  return Object.freeze(output);
}

function validateAvailabilityWindow({ startsAt, endsAt, recurrence, now, config, requireFutureStart }) {
  const start = new Date(startsAt);
  const end = new Date(endsAt);
  if (Number.isNaN(start.getTime()) || Number.isNaN(end.getTime())) invalid("starts_at", "periodo invalido");
  if (end.getTime() <= start.getTime()) invalid("ends_at", "deve ser posterior ao inicio");
  if (requireFutureStart && start.getTime() <= now.getTime()) invalid("starts_at", "deve estar no futuro");
  const maximumDuration = config.availabilityMaxDurationHours * 60 * 60 * 1000;
  if (end.getTime() - start.getTime() > maximumDuration) invalid("ends_at", "duracao acima do limite");
  const maximumStart = now.getTime() + config.availabilityMaxHorizonDays * 24 * 60 * 60 * 1000;
  if (start.getTime() > maximumStart) invalid("starts_at", "data alem do horizonte permitido");
  if (recurrence) {
    const until = new Date(`${recurrence.until}T23:59:59-03:00`);
    const recurrenceMaximum = now.getTime() + config.availabilityRecurrenceMaxDays * 24 * 60 * 60 * 1000;
    if (until.getTime() < start.getTime()) invalid("recurrence.until", "deve incluir a data inicial");
    if (until.getTime() > recurrenceMaximum) invalid("recurrence.until", "periodo recorrente acima do limite");
  }
}

function validatePublicAvailabilityId(value) {
  const id = String(value || "").trim().toLowerCase();
  if (!UUID.test(id)) invalid("id", "identificador invalido", "AVAILABILITY_ID_INVALID");
  return id;
}

function validateAvailabilityExpectedVersion(value) {
  const raw = String(value ?? "").trim();
  if (!raw) {
    throw new RadarIdentityError(
      "AVAILABILITY_VERSION_REQUIRED",
      428,
      "Informe a versao atual da disponibilidade em If-Match."
    );
  }
  const match = raw.match(/^(?:W\/)??"?(\d+)"?$/i);
  const version = match ? Number(match[1]) : NaN;
  if (!Number.isInteger(version) || version < 1) invalid("If-Match", "versao invalida");
  return version;
}

function stableValue(value) {
  if (Array.isArray(value)) return value.map(stableValue);
  if (!plainObject(value)) return value;
  return Object.keys(value).sort().reduce((result, key) => {
    result[key] = stableValue(value[key]);
    return result;
  }, {});
}

function sha256(value) {
  return crypto.createHash("sha256").update(JSON.stringify(stableValue(value))).digest("hex");
}

function availabilityScheduleHash(value) {
  return sha256({
    modality: value.modality,
    category: value.category,
    startsAt: value.startsAt,
    endsAt: value.endsAt,
    recurrence: value.recurrence || null,
    cityIbgeCode: value.cityIbgeCode,
    travelRadiusKm: value.travelRadiusKm,
    venuePreference: value.venuePreference
  });
}

function availabilityMutationHash(operation, value) {
  return sha256({ operation, value });
}

function encodeAvailabilityCursor({ startsAt, publicId }) {
  return Buffer.from(JSON.stringify({ starts_at: startsAt, public_id: publicId }), "utf8").toString("base64url");
}

function decodeAvailabilityCursor(value) {
  if (!value) return null;
  const raw = String(value).trim();
  if (!/^[A-Za-z0-9_-]{1,512}$/.test(raw)) invalid("cursor", "cursor invalido");
  try {
    const parsed = JSON.parse(Buffer.from(raw, "base64url").toString("utf8"));
    return Object.freeze({
      startsAt: isoDate("cursor", parsed.starts_at),
      publicId: validatePublicAvailabilityId(parsed.public_id)
    });
  } catch (error) {
    if (error instanceof RadarIdentityError) throw error;
    invalid("cursor", "cursor invalido");
  }
}

function validateAvailabilityListQuery(query, config) {
  const input = query || {};
  const allowed = new Set(["status", "cursor", "limit"]);
  for (const field of Object.keys(input)) {
    if (!allowed.has(field)) invalid(field, "filtro nao permitido");
  }
  const status = String(input.status || "").trim().toLowerCase() || null;
  if (status && !STATUS_VALUES.has(status)) invalid("status", "filtro de estado invalido");
  const requestedLimit = input.limit === undefined
    ? config.availabilityPageDefault
    : Number(input.limit);
  if (!Number.isInteger(requestedLimit) || requestedLimit < 1 || requestedLimit > config.availabilityPageMaximum) {
    invalid("limit", `use um inteiro entre 1 e ${config.availabilityPageMaximum}`);
  }
  return Object.freeze({
    status,
    cursor: decodeAvailabilityCursor(input.cursor),
    limit: requestedLimit
  });
}

module.exports = {
  STATUS_VALUES,
  MUTABLE_STATUS_VALUES,
  WEEK_DAYS,
  containsPrivateContact,
  normalizeRecurrence,
  normalizeCreateAvailability: input => normalizeMutationBody(input, { partial: false }),
  normalizePatchAvailability: input => normalizeMutationBody(input, { partial: true }),
  validateAvailabilityWindow,
  validatePublicAvailabilityId,
  validateAvailabilityExpectedVersion,
  validateAvailabilityListQuery,
  availabilityScheduleHash,
  availabilityMutationHash,
  encodeAvailabilityCursor
};
