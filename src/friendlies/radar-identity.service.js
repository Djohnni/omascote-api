"use strict";

const crypto = require("node:crypto");
const { RadarIdentityError } = require("./radar-identity.errors");
const {
  validateRadarProfileInput,
  validateIdempotencyKey,
  validateExpectedVersion
} = require("./radar-identity.schemas");

const CORE_REQUIREMENTS = Object.freeze([
  "radar_profile_not_created",
  "team_name_missing",
  "profile_not_public",
  "crest_missing",
  "city_missing",
  "state_missing",
  "instagram_missing",
  "modality_missing",
  "category_missing",
  "level_missing"
]);

function stableValue(value) {
  if (Array.isArray(value)) return value.map(stableValue);
  if (!value || typeof value !== "object") return value;
  return Object.keys(value).sort().reduce((result, key) => {
    result[key] = stableValue(value[key]);
    return result;
  }, {});
}

function payloadHash(value) {
  return crypto
    .createHash("sha256")
    .update(JSON.stringify(stableValue(value)))
    .digest("hex");
}

function hasText(value) {
  return Boolean(String(value ?? "").trim());
}

function hasCrest(legacyProfile) {
  return hasText(legacyProfile?.escudo_url) || hasText(legacyProfile?.escudo_path);
}

function buildRadarEligibility({ team, legacyProfile, config }) {
  const missing = [];
  if (!team) missing.push("radar_profile_not_created");
  if (!hasText(legacyProfile?.nome_time)) missing.push("team_name_missing");
  if (legacyProfile?.publico !== true) missing.push("profile_not_public");
  if (!hasCrest(legacyProfile)) missing.push("crest_missing");
  if (!hasText(team?.cityName) || !/^\d{7}$/.test(String(team?.cityIbgeCode || ""))) {
    missing.push("city_missing");
  }
  if (!/^[A-Z]{2}$/.test(String(team?.stateCode || ""))) missing.push("state_missing");
  if (!hasText(team?.instagramHandle)) missing.push("instagram_missing");
  if (!Array.isArray(team?.modalities) || team.modalities.length === 0) {
    missing.push("modality_missing");
  }
  if (!Array.isArray(team?.categories) || team.categories.length === 0) {
    missing.push("category_missing");
  }
  if (!hasText(team?.declaredLevel)) missing.push("level_missing");

  const coreMissing = missing.filter(item => CORE_REQUIREMENTS.includes(item));
  const profileComplete = coreMissing.length === 0;
  const instagramVerified = team?.instagramVerificationStatus === "verified";
  const termsAccepted = Boolean(team?.termsAcceptedAt);
  const suspended = team?.status === "suspended" || Boolean(team?.suspendedAt);
  const insidePilot = !config?.pilotCityIbgeCode ||
    String(team?.cityIbgeCode || "") === String(config.pilotCityIbgeCode);

  if (!instagramVerified) missing.push("instagram_not_verified");
  if (!termsAccepted) missing.push("terms_not_accepted");
  if (suspended) missing.push("radar_profile_suspended");
  if (!insidePilot) missing.push("outside_pilot_city");

  const eligible = profileComplete && instagramVerified && termsAccepted && !suspended && insidePilot;
  const discoverable = eligible && team?.availabilityActive === true && team?.status === "active";

  return Object.freeze({
    profile_complete: profileComplete,
    instagram_verified: instagramVerified,
    terms_accepted: termsAccepted,
    inside_pilot: insidePilot,
    eligible,
    discoverable,
    missing: Object.freeze([...new Set(missing)])
  });
}

function deriveStatus(team, eligibility) {
  if (team?.status === "suspended" || team?.suspendedAt) return "suspended";
  if (!eligibility.profile_complete) return "draft";
  if (!eligibility.instagram_verified || !eligibility.terms_accepted) {
    return "pending_verification";
  }
  return team.availabilityActive === true ? "active" : "paused";
}

function ownerProfile(team) {
  if (!team) return null;
  return Object.freeze({
    public_id: team.publicId,
    status: team.status,
    instagram_verification_status: team.instagramVerificationStatus,
    city_ibge_code: team.cityIbgeCode,
    city_name: team.cityName,
    state_code: team.stateCode,
    instagram_handle: team.instagramHandle,
    modalities: Object.freeze([...(team.modalities || [])]),
    categories: Object.freeze([...(team.categories || [])]),
    declared_level: team.declaredLevel,
    travel_radius_km: team.travelRadiusKm,
    venue_preference: team.venuePreference,
    availability_active: team.availabilityActive === true,
    terms_accepted: Boolean(team.termsAcceptedAt),
    version: team.version,
    updated_at: team.updatedAt
  });
}

function legacySummary(legacyProfile) {
  return Object.freeze({
    slug: String(legacyProfile?.slug || ""),
    nome_time: String(legacyProfile?.nome_time || ""),
    publico: legacyProfile?.publico === true,
    possui_escudo: hasCrest(legacyProfile)
  });
}

function buildOwnerResponse({ team, identity, config, replayed = false }) {
  return Object.freeze({
    profile: ownerProfile(team),
    legacy_profile: legacySummary(identity.legacyProfile),
    eligibility: buildRadarEligibility({
      team,
      legacyProfile: identity.legacyProfile,
      config
    }),
    replayed
  });
}

function sanitizeRequestId(value) {
  const requestId = String(value || "").trim();
  return /^[A-Za-z0-9._:-]{1,120}$/.test(requestId) ? requestId : null;
}

function applyInput(team, input, now) {
  const instagramChanged = Object.hasOwn(input, "instagramHandle") &&
    input.instagramHandle !== team.instagramHandle;
  const prospective = {
    ...team,
    cityIbgeCode: Object.hasOwn(input, "cityIbgeCode") ? input.cityIbgeCode : team.cityIbgeCode,
    cityName: Object.hasOwn(input, "cityName") ? input.cityName : team.cityName,
    stateCode: Object.hasOwn(input, "stateCode") ? input.stateCode : team.stateCode,
    instagramHandle: Object.hasOwn(input, "instagramHandle")
      ? input.instagramHandle
      : team.instagramHandle,
    instagramVerificationStatus: instagramChanged
      ? "unverified"
      : team.instagramVerificationStatus,
    modalities: Object.hasOwn(input, "modalities") ? input.modalities : team.modalities,
    categories: Object.hasOwn(input, "categories") ? input.categories : team.categories,
    declaredLevel: Object.hasOwn(input, "declaredLevel")
      ? input.declaredLevel
      : team.declaredLevel,
    travelRadiusKm: Object.hasOwn(input, "travelRadiusKm")
      ? input.travelRadiusKm
      : team.travelRadiusKm,
    venuePreference: Object.hasOwn(input, "venuePreference")
      ? input.venuePreference
      : team.venuePreference,
    availabilityActive: Object.hasOwn(input, "availabilityActive")
      ? input.availabilityActive
      : team.availabilityActive,
    termsAcceptedAt: input.acceptTerms === true && !team.termsAcceptedAt
      ? now.toISOString()
      : team.termsAcceptedAt
  };
  return prospective;
}

function createRadarIdentityService({ repository, config, now = () => new Date() }) {
  if (!repository || typeof repository.findOwnedByIdentity !== "function") {
    throw new TypeError("Radar identity service requires a repository");
  }

  async function getProfile(identity) {
    const team = await repository.findOwnedByIdentity(identity);
    return buildOwnerResponse({ team, identity, config });
  }

  async function putProfile({
    identity,
    body,
    idempotencyKey,
    expectedVersion,
    requestId
  }) {
    const input = validateRadarProfileInput(body);
    const normalizedIdempotencyKey = validateIdempotencyKey(idempotencyKey, { required: true });
    const normalizedExpectedVersion = validateExpectedVersion(expectedVersion);
    const hash = payloadHash(input);
    const mutationTime = now();
    if (!(mutationTime instanceof Date) || Number.isNaN(mutationTime.getTime())) {
      throw new TypeError("now must return a valid Date");
    }

    const result = await repository.mutateOwnedProfile({
      identity,
      idempotencyKey: normalizedIdempotencyKey,
      payloadHash: hash,
      expectedVersion: normalizedExpectedVersion,
      requestId: sanitizeRequestId(requestId),
      buildMutation(currentTeam) {
        const prospective = applyInput(currentTeam, input, mutationTime);
        const eligibility = buildRadarEligibility({
          team: prospective,
          legacyProfile: identity.legacyProfile,
          config
        });

        if (input.availabilityActive === true && !eligibility.eligible) {
          throw new RadarIdentityError(
            "RADAR_PROFILE_NOT_ELIGIBLE",
            409,
            "Complete e verifique o perfil antes de ativar a disponibilidade.",
            { missing: eligibility.missing }
          );
        }

        if (!eligibility.eligible) prospective.availabilityActive = false;

        prospective.status = deriveStatus(prospective, eligibility);
        return prospective;
      }
    });

    return buildOwnerResponse({
      team: result.team,
      identity,
      config,
      replayed: result.replayed
    });
  }

  return Object.freeze({ getProfile, putProfile });
}

module.exports = {
  createRadarIdentityService,
  buildRadarEligibility,
  deriveStatus,
  payloadHash,
  ownerProfile
};
