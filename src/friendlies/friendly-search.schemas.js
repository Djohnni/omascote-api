"use strict";

const { RadarIdentityError } = require("./radar-identity.errors");
const { MODALITIES, LEVELS, VENUE_PREFERENCES } = require("./radar-identity.schemas");

const DAYS = Object.freeze({
  monday: 1,
  tuesday: 2,
  wednesday: 3,
  thursday: 4,
  friday: 5,
  saturday: 6,
  sunday: 7
});
const PERIODS = new Set(["morning", "afternoon", "evening"]);
const ALLOWED_FIELDS = new Set([
  "modality", "category", "level", "day", "period",
  "radius_km", "venue_preference", "cursor", "limit"
]);

function invalid(field, message, code = "FRIENDLY_SEARCH_VALIDATION_ERROR") {
  throw new RadarIdentityError(code, 400, `${field}: ${message}`);
}

function scalar(field, value) {
  if (Array.isArray(value) || (value && typeof value === "object")) {
    invalid(field, "informe um unico valor");
  }
  return String(value ?? "").trim();
}

function validateFriendlySearchQuery(query, config) {
  const input = query || {};
  for (const field of Object.keys(input)) {
    if (!ALLOWED_FIELDS.has(field)) invalid(field, "filtro nao permitido");
  }

  const modality = scalar("modality", input.modality).toLowerCase() || null;
  if (modality && !MODALITIES.has(modality)) invalid("modality", "modalidade invalida");

  const category = scalar("category", input.category).replace(/\s+/g, " ") || null;
  if (category && !/^[\p{L}\p{M}\p{N} ._+\/-]{2,40}$/u.test(category)) {
    invalid("category", "categoria invalida");
  }

  const level = scalar("level", input.level).toLowerCase() || null;
  if (level && !LEVELS.has(level)) invalid("level", "nivel invalido");

  const day = scalar("day", input.day).toLowerCase() || null;
  if (day && !Object.hasOwn(DAYS, day)) invalid("day", "dia da semana invalido");

  const period = scalar("period", input.period).toLowerCase() || null;
  if (period && !PERIODS.has(period)) invalid("period", "periodo invalido");

  const venuePreference = scalar("venue_preference", input.venue_preference).toLowerCase() || null;
  if (venuePreference && !VENUE_PREFERENCES.has(venuePreference)) {
    invalid("venue_preference", "preferencia de mando invalida");
  }

  const radius = input.radius_km === undefined || input.radius_km === ""
    ? null
    : Number(scalar("radius_km", input.radius_km));
  if (radius !== null && (!Number.isInteger(radius) || radius < 1 || radius > config.searchRadiusMaximumKm)) {
    invalid("radius_km", `use um inteiro entre 1 e ${config.searchRadiusMaximumKm}`);
  }

  const limit = input.limit === undefined || input.limit === ""
    ? config.searchPageDefault
    : Number(scalar("limit", input.limit));
  if (!Number.isInteger(limit) || limit < 1 || limit > config.searchPageMaximum) {
    invalid("limit", `use um inteiro entre 1 e ${config.searchPageMaximum}`);
  }

  const cursor = scalar("cursor", input.cursor) || null;
  if (cursor && cursor.length > 1900) invalid("cursor", "cursor invalido");

  return Object.freeze({
    modality,
    category,
    level,
    day,
    dayNumber: day ? DAYS[day] : null,
    period,
    radiusKm: radius,
    venuePreference,
    cursor,
    limit
  });
}

function cursorBoundFilters(filters, appliedRadiusKm) {
  return Object.freeze({
    modality: filters.modality,
    category: filters.category ? filters.category.toLocaleLowerCase("pt-BR") : null,
    level: filters.level,
    day: filters.day,
    period: filters.period,
    radius_km: appliedRadiusKm,
    venue_preference: filters.venuePreference
  });
}

module.exports = {
  DAYS,
  PERIODS,
  validateFriendlySearchQuery,
  cursorBoundFilters
};
