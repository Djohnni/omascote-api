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

function publicCandidate(item, minimumRatingMatches) {
  const location = item.location.kind === "same_city"
    ? Object.freeze({ kind: "same_city", label: "Mesma cidade" })
    : item.location.kind === "approximate_distance"
      ? Object.freeze({
        kind: "approximate_distance",
        distance_km: Number(item.location.distanceKm.toFixed(1)),
        label: `${Number(item.location.distanceKm.toFixed(1))} km aprox.`
      })
      : Object.freeze({ kind: "unknown", label: "Cidade não informada" });
  const reviewCount = Number(item.verifiedReviewCount || 0);
  const reputation = reviewCount >= minimumRatingMatches
    ? Object.freeze({
      state: "established",
      verified_evaluations: reviewCount,
      overall: Math.round((
        item.punctualitySum + item.organizationSum +
        item.communicationSum + item.fairPlaySum
      ) * 10 / (reviewCount * 4)) / 10,
      would_play_again_percent: Math.round(item.wouldPlayAgainCount * 100 / reviewCount)
    })
    : Object.freeze({ state: "unrated", label: "Sem nota" });
  const response = {
    public_id: item.publicId,
    slug: item.publicSlug,
    name: item.publicName || "Time do Meu Clube FC",
    crest_url: item.publicCrestAvailable && item.publicSlug
      ? `/time/${encodeURIComponent(item.publicSlug)}/escudo/imagem`
      : null,
    city: item.cityName || null,
    state: item.stateCode || null,
    modalities: Object.freeze([...(item.modalities || [])]),
    categories: Object.freeze([...(item.categories || [])]),
    modality: item.modality,
    category: item.category,
    whatsapp_disponivel: item.whatsappAvailable === true,
    location,
    compatibility: Object.freeze({
      score: item.compatibility.score,
      reasons: item.compatibility.reasons
    }),
    availability: item.startsAt
      ? Object.freeze({ state: "available", label: "Disponível" })
      : Object.freeze({ state: "to_arrange", label: "Horário a combinar" }),
    next_availability: item.startsAt ? Object.freeze({
      starts_at: new Date(item.startsAt).toISOString(),
      ends_at: new Date(item.endsAt).toISOString(),
      venue_preference: item.venuePreference
    }) : null,
    instagram: Object.freeze({
      verified: item.instagramVerified === true,
      label: item.instagramVerified === true ? "Verificado" : "Não verificado"
    }),
    joined_at: item.joinedAt ? new Date(item.joinedAt).toISOString() : null,
    experience: item.verifiedMatchCount > 0
      ? Object.freeze({ state: "experienced", label: `${item.verifiedMatchCount} jogos` })
      : Object.freeze({ state: "new", label: "Novo no Radar" }),
    statistics: Object.freeze({
      matches: Number(item.verifiedMatchCount || 0),
      wins: Number(item.wins || 0),
      draws: Number(item.draws || 0),
      losses: Number(item.losses || 0)
    }),
    reputation
  };
  if (item.verifiedMatchCount > 0) {
    response.verified_match_count = item.verifiedMatchCount;
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
    if (!eligibility.eligible) {
      throw searchError(
        "FRIENDLY_SEARCH_ORIGIN_INELIGIBLE",
        409,
        "Este time nao pode usar o Radar no momento.",
        { missing: eligibility.missing }
      );
    }

    const appliedRadiusKm = filters.radiusKm === null
      ? null
      : Math.min(filters.radiusKm, config.searchRadiusMaximumKm);
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
      const candidates = [];
      for (const candidate of located) {
        const compatibility = buildCompatibility({
          origin,
          candidate,
          location: candidate.location,
          radiusKm: appliedRadiusKm
        });
        candidates.push(Object.freeze({ ...candidate, compatibility }));
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
        config.publicRatingMinimumMatches
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
  publicCandidate
};
