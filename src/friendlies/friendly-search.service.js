"use strict";

const { RadarIdentityError } = require("./radar-identity.errors");
const { buildRadarEligibility } = require("./radar-identity.service");
const {
  validateFriendlySearchQuery,
  cursorBoundFilters
} = require("./friendly-search.schemas");
const {
  requireSearchSecrets,
  filtersFingerprint,
  originScope,
  rateScopeHash,
  encodeSearchCursor,
  decodeSearchCursor
} = require("./friendly-search.crypto");
const {
  candidateLocation,
  buildCompatibility,
  sortKey,
  compareSortKeys
} = require("./friendly-search.compatibility");

function searchError(code, status, message, details = null) {
  return new RadarIdentityError(code, status, message, details);
}

function livePublicProfileSafe(profile, expectedSlug) {
  const slug = String(profile?.slug || "").trim();
  const name = String(profile?.name || "").replace(/\s+/g, " ").trim();
  return profile?.public === true &&
    profile?.hasCrest === true &&
    slug === expectedSlug &&
    /^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(slug) &&
    name.length >= 2 && name.length <= 80;
}

function publicCandidate(item, liveProfile, minimumRatingMatches, pilotAccountAllowlist = []) {
  const location = item.location.kind === "same_city"
    ? Object.freeze({ kind: "same_city", label: "mesma cidade" })
    : Object.freeze({
      kind: "approximate_distance",
      distance_km: Number(item.location.distanceKm.toFixed(1)),
      label: `${Number(item.location.distanceKm.toFixed(1))} km aproximadamente`
    });
  const response = {
    public_id: item.publicId,
    slug: item.publicSlug,
    name: liveProfile.name,
    crest_url: `/time/${encodeURIComponent(item.publicSlug)}/escudo/imagem`,
    city: item.cityName,
    state: item.stateCode,
    modality: item.modality,
    category: item.category,
    whatsapp_disponivel: item.whatsappAvailable === true && pilotAccountAllowlist.includes(item.accountReference),
    location,
    compatibility: Object.freeze({
      score: item.compatibility.score,
      reasons: item.compatibility.reasons
    }),
    next_availability: Object.freeze({
      starts_at: new Date(item.startsAt).toISOString(),
      ends_at: new Date(item.endsAt).toISOString(),
      venue_preference: item.venuePreference
    }),
    reputation: Object.freeze({ state: "new_on_radar" })
  };
  if (item.verifiedMatchCount > 0) {
    response.verified_match_count = item.verifiedMatchCount;
  }
  if (item.verifiedMatchCount >= minimumRatingMatches) {
    response.reputation = Object.freeze({ state: "new_on_radar" });
  }
  return Object.freeze(response);
}

function createFriendlySearchService({
  repository,
  config,
  resolvePublicProfile,
  resolvePublicProfiles,
  clock = () => new Date()
}) {
  if (!repository || typeof repository.getOrigin !== "function") {
    throw new TypeError("Friendly search service requires a repository");
  }
  if (typeof resolvePublicProfile !== "function" && typeof resolvePublicProfiles !== "function") {
    throw new TypeError("Friendly search service requires a public profile resolver");
  }

  async function recordMetricQuietly(outcome, returnedCount, now) {
    try {
      await repository.recordMetric({ outcome, returnedCount, now });
    } catch {}
  }

  async function search({ identity, query, requestContext = {} }) {
    const now = clock();
    const filters = validateFriendlySearchQuery(query, config);
    const secrets = requireSearchSecrets(config);
    const origin = await repository.getOrigin(identity);
    const eligibility = buildRadarEligibility({
      team: origin,
      legacyProfile: identity.legacyProfile,
      config
    });
    if (!eligibility.eligible || origin.status !== "active") {
      throw searchError(
        "FRIENDLY_SEARCH_ORIGIN_INELIGIBLE",
        409,
        "Complete e ative o perfil do Radar antes de procurar amistosos.",
        { missing: eligibility.missing }
      );
    }

    const requestedRadius = filters.radiusKm || 25;
    const appliedRadiusKm = Math.min(
      requestedRadius,
      Number(origin.travelRadiusKm || 25),
      config.searchRadiusMaximumKm
    );
    const boundFilters = cursorBoundFilters(filters, appliedRadiusKm);
    const fingerprint = filtersFingerprint(boundFilters);
    const expectedOriginScope = originScope(secrets.cursor, origin);
    let snapshot = now;
    let afterKey = null;
    if (filters.cursor) {
      const decoded = decodeSearchCursor(secrets.cursor, filters.cursor);
      if (decoded.filtersFingerprint !== fingerprint) {
        throw searchError(
          "FRIENDLY_SEARCH_CURSOR_FILTER_MISMATCH",
          400,
          "O cursor pertence a outros filtros de busca."
        );
      }
      if (decoded.originScope !== expectedOriginScope) {
        throw searchError(
          "FRIENDLY_SEARCH_CURSOR_ORIGIN_MISMATCH",
          400,
          "O cursor nao pertence a este time."
        );
      }
      const ageMs = now.getTime() - decoded.snapshot.getTime();
      if (ageMs < -60_000 || ageMs > config.searchCursorTtlMinutes * 60_000) {
        throw searchError(
          "FRIENDLY_SEARCH_CURSOR_EXPIRED",
          400,
          "O cursor expirou. Refaca a busca."
        );
      }
      snapshot = decoded.snapshot;
      afterKey = decoded.key;
    }

    await repository.consumeRateLimits({
      now,
      scopes: [
        {
          type: "account",
          hash: rateScopeHash(secrets.rate, "account", identity.accountId),
          limit: config.searchAccountLimit
        },
        {
          type: "team",
          hash: rateScopeHash(secrets.rate, "team", origin.id),
          limit: config.searchTeamLimit
        },
        {
          type: "ip",
          hash: rateScopeHash(secrets.rate, "ip", requestContext.ip || "unknown"),
          limit: config.searchIpLimit
        }
      ]
    });

    try {
      const rows = await repository.searchCandidates({ origin, filters, snapshot, now });
      const located = [];
      for (const candidate of rows) {
        if (String(candidate.teamId || "") === String(origin.id || "")) continue;
        const location = candidateLocation(origin, candidate, appliedRadiusKm);
        if (!location) continue;
        located.push(Object.freeze({ ...candidate, location }));
      }
      const liveProfiles = typeof resolvePublicProfiles === "function"
        ? await resolvePublicProfiles(located.map(candidate => candidate.publicSlug))
        : null;
      const candidates = [];
      for (const candidate of located) {
        const liveProfile = liveProfiles instanceof Map
          ? liveProfiles.get(candidate.publicSlug)
          : liveProfiles && typeof liveProfiles === "object"
            ? liveProfiles[candidate.publicSlug]
            : await resolvePublicProfile(candidate.publicSlug);
        if (!livePublicProfileSafe(liveProfile, candidate.publicSlug)) continue;
        const compatibility = buildCompatibility({
          origin,
          candidate,
          location: candidate.location,
          radiusKm: appliedRadiusKm
        });
        candidates.push(Object.freeze({ ...candidate, compatibility, liveProfile }));
      }
      candidates.sort((first, second) => compareSortKeys(sortKey(first), sortKey(second)));
      const remaining = afterKey
        ? candidates.filter(item => compareSortKeys(sortKey(item), afterKey) > 0)
        : candidates;
      const page = remaining.slice(0, filters.limit);
      const hasMore = remaining.length > filters.limit;
      const nextCursor = hasMore && page.length > 0
        ? encodeSearchCursor(secrets.cursor, {
          f: fingerprint,
          o: expectedOriginScope,
          s: snapshot.toISOString(),
          k: {
            score: sortKey(page.at(-1)).score,
            distance: sortKey(page.at(-1)).distance,
            starts_at: sortKey(page.at(-1)).startsAt,
            slug: sortKey(page.at(-1)).slug
          }
        })
        : null;
      const items = Object.freeze(page.map(item => publicCandidate(
        item,
        item.liveProfile,
        config.publicRatingMinimumMatches,
        config.pilotAccountAllowlist || []
      )));
      await recordMetricQuietly(items.length > 0 ? "success" : "empty", items.length, now);
      return Object.freeze({
        items,
        page: Object.freeze({
          limit: filters.limit,
          next_cursor: nextCursor,
          has_more: hasMore
        }),
        search: Object.freeze({ radius_km: appliedRadiusKm })
      });
    } catch (error) {
      await recordMetricQuietly(
        error?.code === "FRIENDLY_SEARCH_TIMEOUT" ? "timeout" : "error",
        0,
        now
      );
      throw error;
    }
  }

  return Object.freeze({ search });
}

module.exports = {
  createFriendlySearchService,
  publicCandidate,
  livePublicProfileSafe
};
