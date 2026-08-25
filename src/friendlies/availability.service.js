"use strict";

const { RadarIdentityError } = require("./radar-identity.errors");
const { buildRadarEligibility } = require("./radar-identity.service");
const { validateIdempotencyKey } = require("./radar-identity.schemas");
const {
  normalizeCreateAvailability,
  normalizePatchAvailability,
  validateAvailabilityWindow,
  validatePublicAvailabilityId,
  validateAvailabilityExpectedVersion,
  validateAvailabilityListQuery,
  availabilityScheduleHash,
  availabilityMutationHash,
  encodeAvailabilityCursor
} = require("./availability.schemas");

function sanitizeRequestId(value) {
  const requestId = String(value || "").trim();
  return /^[A-Za-z0-9._:-]{1,120}$/.test(requestId) ? requestId : null;
}

function clockValue(now) {
  const value = now();
  if (!(value instanceof Date) || Number.isNaN(value.getTime())) {
    throw new TypeError("now must return a valid Date");
  }
  return value;
}

function canonicalProfileChoice(values, requested, field) {
  const candidate = String(requested || "").trim().toLowerCase();
  const match = (Array.isArray(values) ? values : []).find(
    value => String(value || "").trim().toLowerCase() === candidate
  );
  if (!match) {
    throw new RadarIdentityError(
      field === "modality" ? "AVAILABILITY_MODALITY_NOT_IN_PROFILE" : "AVAILABILITY_CATEGORY_NOT_IN_PROFILE",
      409,
      field === "modality"
        ? "A modalidade deve estar cadastrada no perfil do time."
        : "A categoria deve estar cadastrada no perfil do time."
    );
  }
  return String(match).trim();
}

function assertCanonicalTeamData(team) {
  const complete = (
    /^\d{7}$/.test(String(team?.cityIbgeCode || "")) &&
    Boolean(String(team?.cityName || "").trim()) &&
    /^[A-Z]{2}$/.test(String(team?.stateCode || ""))
  );
  if (!complete) {
    throw new RadarIdentityError(
      "AVAILABILITY_PROFILE_INCOMPLETE",
      409,
      "Complete cidade e UF no perfil antes de cadastrar uma disponibilidade."
    );
  }
}

function assertCanActivate(team, identity, config) {
  const eligibility = buildRadarEligibility({
    team,
    legacyProfile: identity.legacyProfile,
    config
  });
  if (!eligibility.eligible) {
    throw new RadarIdentityError(
      "AVAILABILITY_NOT_ELIGIBLE",
      409,
      "Complete e verifique o perfil antes de ativar a disponibilidade.",
      { missing: eligibility.missing }
    );
  }
}

function buildAvailabilityValue({ team, identity, input, current = null, config, now }) {
  assertCanonicalTeamData(team);
  const modality = canonicalProfileChoice(
    team.modalities,
    Object.hasOwn(input, "modality") ? input.modality : current?.modality,
    "modality"
  );
  const category = canonicalProfileChoice(
    team.categories,
    Object.hasOwn(input, "category") ? input.category : current?.category,
    "category"
  );
  const value = {
    modality,
    category,
    startsAt: Object.hasOwn(input, "startsAt") ? input.startsAt : current?.startsAt,
    endsAt: Object.hasOwn(input, "endsAt") ? input.endsAt : current?.endsAt,
    recurrence: Object.hasOwn(input, "recurrence") ? input.recurrence : current?.recurrence || null,
    cityIbgeCode: String(team.cityIbgeCode),
    cityName: String(team.cityName).trim(),
    stateCode: String(team.stateCode).trim().toUpperCase(),
    travelRadiusKm: Object.hasOwn(input, "travelRadiusKm")
      ? input.travelRadiusKm
      : current?.travelRadiusKm || team.travelRadiusKm || config.availabilityDefaultTravelRadiusKm,
    venuePreference: Object.hasOwn(input, "venuePreference")
      ? input.venuePreference
      : current?.venuePreference || team.venuePreference || "either",
    notes: Object.hasOwn(input, "notes") ? input.notes : current?.notes || null,
    status: Object.hasOwn(input, "status") ? input.status : current?.status || "active"
  };
  const scheduleChanged = !current || [
    "modality", "category", "startsAt", "endsAt", "recurrence",
    "travelRadiusKm", "venuePreference"
  ].some(field => Object.hasOwn(input, field));
  validateAvailabilityWindow({
    startsAt: value.startsAt,
    endsAt: value.endsAt,
    recurrence: value.recurrence,
    now,
    config,
    requireFutureStart: scheduleChanged
  });
  if (value.status === "active") assertCanActivate(team, identity, config);
  value.scheduleHash = availabilityScheduleHash(value);
  return Object.freeze(value);
}

function publicAvailability(value) {
  return Object.freeze({
    availability_id: value.publicId,
    modality: value.modality,
    category: value.category,
    starts_at: value.startsAt,
    ends_at: value.endsAt,
    recurrence: value.recurrence,
    city: Object.freeze({
      ibge_code: value.cityIbgeCode,
      name: value.cityName,
      state_code: value.stateCode
    }),
    travel_radius_km: value.travelRadiusKm,
    venue_preference: value.venuePreference,
    notes: value.notes,
    status: value.status,
    version: value.version,
    created_at: value.createdAt,
    updated_at: value.updatedAt
  });
}

function createAvailabilityService({ repository, config, now = () => new Date() }) {
  if (!repository || typeof repository.createOwned !== "function") {
    throw new TypeError("Availability service requires a repository");
  }

  async function list({ identity, query }) {
    const at = clockValue(now);
    const filters = validateAvailabilityListQuery(query, config);
    const result = await repository.listOwned({ identity, ...filters, now: at });
    const hasMore = result.rows.length > result.limit;
    const selected = result.rows.slice(0, result.limit);
    const last = selected[selected.length - 1];
    return Object.freeze({
      items: Object.freeze(selected.map(publicAvailability)),
      pagination: Object.freeze({
        limit: result.limit,
        has_more: hasMore,
        next_cursor: hasMore && last
          ? encodeAvailabilityCursor({ startsAt: last.startsAt, publicId: last.publicId })
          : null
      }),
      time_zone: config.availabilityTimeZone
    });
  }

  async function create({ identity, body, idempotencyKey, requestId }) {
    const input = normalizeCreateAvailability(body);
    const key = validateIdempotencyKey(idempotencyKey, { required: true });
    const hash = availabilityMutationHash("create", input);
    const at = clockValue(now);
    const result = await repository.createOwned({
      identity,
      idempotencyKey: key,
      payloadHash: hash,
      now: at,
      requestId: sanitizeRequestId(requestId),
      maxFuture: config.availabilityMaxFuturePerTeam,
      buildAvailability(team) {
        return buildAvailabilityValue({ team, identity, input, config, now: at });
      }
    });
    return Object.freeze({
      availability: publicAvailability(result.availability),
      replayed: result.replayed === true
    });
  }

  async function update({ identity, publicId, body, expectedVersion, idempotencyKey, requestId }) {
    const id = validatePublicAvailabilityId(publicId);
    const input = normalizePatchAvailability(body);
    const version = validateAvailabilityExpectedVersion(expectedVersion);
    const key = validateIdempotencyKey(idempotencyKey, { required: true });
    const hash = availabilityMutationHash("patch", { publicId: id, version, input });
    const at = clockValue(now);
    const changedFields = Object.keys(body);
    const result = await repository.updateOwned({
      identity,
      publicId: id,
      expectedVersion: version,
      idempotencyKey: key,
      payloadHash: hash,
      now: at,
      requestId: sanitizeRequestId(requestId),
      changedFields,
      buildAvailability(team, current) {
        return buildAvailabilityValue({ team, identity, input, current, config, now: at });
      }
    });
    return Object.freeze({
      availability: publicAvailability(result.availability),
      replayed: result.replayed === true
    });
  }

  async function cancel({ identity, publicId, expectedVersion, idempotencyKey, requestId }) {
    const id = validatePublicAvailabilityId(publicId);
    const version = validateAvailabilityExpectedVersion(expectedVersion);
    const key = validateIdempotencyKey(idempotencyKey, { required: true });
    const hash = availabilityMutationHash("delete", { publicId: id, version });
    const result = await repository.cancelOwned({
      identity,
      publicId: id,
      expectedVersion: version,
      idempotencyKey: key,
      payloadHash: hash,
      now: clockValue(now),
      requestId: sanitizeRequestId(requestId)
    });
    return Object.freeze({
      availability: publicAvailability(result.availability),
      replayed: result.replayed === true
    });
  }

  return Object.freeze({ list, create, update, cancel });
}

module.exports = {
  createAvailabilityService,
  buildAvailabilityValue,
  publicAvailability,
  canonicalProfileChoice,
  assertCanActivate
};
