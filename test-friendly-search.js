"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");
const express = require("express");
const { createRadarConfig } = require("./src/config/radar");
const { RadarIdentityError } = require("./src/friendlies/radar-identity.errors");
const {
  validateFriendlySearchQuery
} = require("./src/friendlies/friendly-search.schemas");
const {
  validCoordinate,
  haversineKm,
  candidateLocation,
  buildCompatibility
} = require("./src/friendlies/friendly-search.compatibility");
const {
  createFriendlySearchService
} = require("./src/friendlies/friendly-search.service");
const {
  createFriendlySearchRouter
} = require("./src/friendlies/friendly-search.routes");

const NOW = new Date("2026-08-24T12:00:00.000Z");
const SECRET_A = "cursor-secret-32-characters-minimum-value";
const SECRET_B = "rate-limit-secret-32-characters-value";

function config(overrides = {}) {
  return createRadarConfig({
    RADAR_AMISTOSOS_ENABLED: "true",
    RADAR_SEARCH_ENABLED: "true",
    RADAR_SEARCH_CURSOR_SECRET: SECRET_A,
    RADAR_SEARCH_RATE_LIMIT_SECRET: SECRET_B,
    RADAR_SEARCH_PAGE_DEFAULT: "2",
    RADAR_SEARCH_PAGE_MAXIMUM: "10",
    RADAR_SEARCH_RADIUS_MAXIMUM_KM: "100",
    RADAR_SEARCH_ACCOUNT_LIMIT: "100",
    RADAR_SEARCH_TEAM_LIMIT: "100",
    RADAR_SEARCH_IP_LIMIT: "100",
    ...overrides
  });
}

function identity(overrides = {}) {
  return Object.freeze({
    accountId: "account-owner",
    profileId: "profile-owner",
    legacyProfile: Object.freeze({
      slug: "owner-fc",
      nome_time: "Owner FC",
      publico: true,
      escudo_url: "/escudos/owner.png"
    }),
    ...overrides
  });
}

function origin(overrides = {}) {
  return Object.freeze({
    id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
    legacyProfileId: "profile-owner",
    accountReference: "account-owner",
    publicSlug: "owner-fc",
    status: "active",
    instagramHandle: "owner.fc",
    instagramVerificationStatus: "verified",
    cityIbgeCode: "4209102",
    cityName: "Joinville",
    stateCode: "SC",
    approximateLatitude: "-26.304400",
    approximateLongitude: "-48.846400",
    modalities: ["society", "futsal"],
    categories: ["Livre", "Veterano"],
    declaredLevel: "intermediario",
    travelRadiusKm: 25,
    venuePreference: "either",
    availabilityActive: true,
    termsAcceptedAt: "2026-08-20T12:00:00.000Z",
    version: 4,
    ...overrides
  });
}

function candidate(suffix, overrides = {}) {
  return Object.freeze({
    teamId: `${String(suffix).padStart(8, "0")}-1111-4111-8111-111111111111`,
    publicSlug: `time-${suffix}`,
    publicName: `Time ${suffix}`,
    cityIbgeCode: "4209102",
    cityName: "Joinville",
    stateCode: "SC",
    approximateLatitude: "-26.310000",
    approximateLongitude: "-48.850000",
    modalities: ["society"],
    categories: ["Livre"],
    declaredLevel: "intermediario",
    modality: "society",
    category: "Livre",
    availabilityLevel: "intermediario",
    startsAt: `2026-08-${String(25 + Number(suffix)).padStart(2, "0")}T22:00:00.000Z`,
    endsAt: `2026-08-${String(25 + Number(suffix)).padStart(2, "0")}T23:30:00.000Z`,
    venuePreference: "away",
    availabilityOverlap: true,
    verifiedMatchCount: 2,
    ...overrides
  });
}

function repository(rows, owner = origin()) {
  const state = { rateCalls: [], searches: [] };
  return {
    state,
    async getOrigin(receivedIdentity) {
      assert.equal(receivedIdentity.accountId, "account-owner");
      return owner;
    },
    async consumeRateLimits(value) { state.rateCalls.push(value); },
    async searchCandidates(value) { state.searches.push(value); return rows; },
    async recordMetric() {}
  };
}

function profileResolver(slug) {
  return { slug, name: `Publico ${slug}`, public: true, hasCrest: true };
}

async function request(app, route, options = {}) {
  const server = app.listen(0, "127.0.0.1");
  await new Promise(resolve => server.once("listening", resolve));
  try {
    const address = server.address();
    const response = await fetch(`http://127.0.0.1:${address.port}${route}`, options);
    return {
      status: response.status,
      headers: response.headers,
      body: await response.json()
    };
  } finally {
    await new Promise(resolve => server.close(resolve));
  }
}

test("search feature and secrets are disabled by default and configuration is bounded", () => {
  const disabled = createRadarConfig({});
  assert.equal(disabled.searchEnabled, false);
  assert.equal(disabled.searchConfigured, false);
  assert.equal(disabled.searchPageDefault, 12);
  assert.equal(disabled.searchRadiusMaximumKm, 100);
  const safe = config({
    RADAR_SEARCH_PAGE_MAXIMUM: "999",
    RADAR_SEARCH_RADIUS_MAXIMUM_KM: "9999",
    RADAR_SEARCH_QUERY_TIMEOUT_MS: "99999"
  });
  assert.equal(safe.searchPageMaximum, 50);
  assert.equal(safe.searchRadiusMaximumKm, 500);
  assert.equal(safe.searchQueryTimeoutMs, 10_000);
  assert.equal(Object.keys(safe).includes("searchCursorSecret"), false);
  assert.equal(JSON.stringify(safe).includes(SECRET_A), false);
});

test("strict filters reject ownership, source location, repeated fields and unknown parameters", () => {
  const cfg = config();
  for (const query of [
    { team_id: "other" },
    { account_id: "other" },
    { profile_id: "other" },
    { city: "Joinville" },
    { latitude: "-26.3" },
    { modality: ["society", "futsal"] },
    { radius_km: "101" },
    { limit: "11" },
    { day: "feriado" },
    { period: "madrugada" }
  ]) {
    assert.throws(() => validateFriendlySearchQuery(query, cfg), RadarIdentityError);
  }
  const parsed = validateFriendlySearchQuery({
    modality: "society",
    category: "Livre",
    day: "saturday",
    period: "evening",
    radius_km: "20",
    venue_preference: "away",
    limit: "5"
  }, cfg);
  assert.equal(parsed.dayNumber, 6);
  assert.equal(parsed.radiusKm, 20);
});

test("distance uses approximate municipality points and missing coordinates never become zero", () => {
  assert.equal(validCoordinate(null, null), false);
  assert.equal(validCoordinate("", ""), false);
  const distance = haversineKm(
    { latitude: -26.3044, longitude: -48.8464 },
    { latitude: -26.2928, longitude: -48.8487 }
  );
  assert.ok(distance > 1 && distance < 2);
  const sameCity = candidateLocation(
    origin({ approximateLatitude: null, approximateLongitude: null }),
    candidate(1, { approximateLatitude: null, approximateLongitude: null }),
    25
  );
  assert.deepEqual(sameCity, { kind: "same_city", distanceKm: null });
  assert.deepEqual(candidateLocation(
    origin({ approximateLatitude: null, approximateLongitude: null }),
    candidate(1, {
      cityIbgeCode: "3550308",
      approximateLatitude: null,
      approximateLongitude: null
    }),
    25
  ), { kind: "unknown", distanceKm: null });
});

test("compatibility is deterministic and exposes objective reasons", () => {
  const value = buildCompatibility({
    origin: origin(),
    candidate: candidate(1),
    location: { kind: "approximate_distance", distanceKm: 2 },
    radiusKm: 25
  });
  assert.equal(value.score, 98);
  assert.deepEqual(value.reasons, [
    "perto do seu time",
    "mesma modalidade",
    "categoria compativel",
    "disponivel quarta",
    "aceita jogar fora"
  ]);
});

test("service resolves origin server-side and keeps incomplete active profiles visible", async () => {
  const own = candidate(0, { teamId: origin().id, publicSlug: "owner-fc" });
  const privateCandidate = candidate(2, { publicSlug: "private-fc" });
  const repo = repository([own, candidate(1), privateCandidate]);
  const service = createFriendlySearchService({
    repository: repo,
    config: config(),
    resolvePublicProfile(slug) {
      if (slug === "private-fc") return { slug, name: "Private", public: false, hasCrest: true };
      return profileResolver(slug);
    },
    clock: () => NOW
  });
  const result = await service.search({
    identity: identity(),
    query: { limit: "5" },
    requestContext: { ip: "203.0.113.4" }
  });
  assert.deepEqual(result.items.map(item => item.slug), ["time-1", "private-fc"]);
  assert.equal(repo.state.searches[0].origin.id, origin().id);
  assert.equal(repo.state.rateCalls[0].scopes.length, 3);
  const serialized = JSON.stringify(result);
  for (const forbidden of [
    "teamId", "team_id", "account", "profile_id", "latitude", "longitude",
    "coordinate", "telefone", "phone", "email", "notes"
  ]) {
    assert.equal(serialized.toLowerCase().includes(forbidden.toLowerCase()), false, forbidden);
  }
  assert.equal(result.items[0].whatsapp_disponivel, false);
  assert.equal(result.items[0].reputation.state, "unrated");
  assert.equal(result.items[0].reputation.label, "Sem nota");
  assert.equal(result.items[0].verified_match_count, 2);
});

test("explicit radius is honored while teams without city remain after located teams", async () => {
  const owner = origin({
    travelRadiusKm: 10,
    approximateLatitude: null,
    approximateLongitude: null
  });
  const repo = repository([
    candidate(1, { approximateLatitude: null, approximateLongitude: null }),
    candidate(2, {
      cityIbgeCode: "3550308",
      approximateLatitude: null,
      approximateLongitude: null
    })
  ], owner);
  const service = createFriendlySearchService({
    repository: repo,
    config: config(),
    resolvePublicProfile: profileResolver,
    clock: () => NOW
  });
  const result = await service.search({ identity: identity(), query: { radius_km: "80", limit: "5" } });
  assert.equal(result.search.radius_km, 80);
  assert.equal(result.items.length, 2);
  assert.deepEqual(result.items[0].location, { kind: "same_city", label: "Mesma cidade" });
  assert.deepEqual(result.items[1].location, { kind: "unknown", label: "Cidade não informada" });
  assert.equal(JSON.stringify(result).includes("distance_km"), false);
});

test("ordering and signed pagination are stable, non-repeating and bound to filters", async () => {
  const rows = [
    candidate(4, { availabilityOverlap: false, startsAt: "2026-08-29T22:00:00.000Z" }),
    candidate(1),
    candidate(3, { declaredLevel: "avancado", availabilityLevel: "avancado" }),
    candidate(2, { approximateLatitude: "-26.390000" })
  ];
  const repo = repository(rows);
  const service = createFriendlySearchService({
    repository: repo,
    config: config(),
    resolvePublicProfile: profileResolver,
    clock: () => NOW
  });
  const first = await service.search({
    identity: identity(),
    query: { modality: "society", limit: "2" },
    requestContext: { ip: "203.0.113.5" }
  });
  assert.equal(first.items.length, 2);
  assert.equal(first.page.has_more, true);
  assert.ok(first.page.next_cursor);
  const second = await service.search({
    identity: identity(),
    query: { modality: "society", limit: "2", cursor: first.page.next_cursor },
    requestContext: { ip: "203.0.113.5" }
  });
  const slugs = [...first.items, ...second.items].map(item => item.slug);
  assert.equal(new Set(slugs).size, slugs.length);
  assert.equal(slugs.length, 4);
  const tampered = `${first.page.next_cursor.slice(0, -1)}${first.page.next_cursor.endsWith("a") ? "b" : "a"}`;
  await assert.rejects(
    service.search({ identity: identity(), query: { modality: "society", limit: "2", cursor: tampered } }),
    error => error.code === "FRIENDLY_SEARCH_CURSOR_INVALID"
  );
  await assert.rejects(
    service.search({ identity: identity(), query: { modality: "futsal", limit: "2", cursor: first.page.next_cursor } }),
    error => error.code === "FRIENDLY_SEARCH_CURSOR_FILTER_MISMATCH"
  );
});

test("missing secrets, ineligible origin and persistent rate denial fail closed", async () => {
  const rows = [candidate(1)];
  await assert.rejects(
    createFriendlySearchService({
      repository: repository(rows),
      config: createRadarConfig({ RADAR_AMISTOSOS_ENABLED: "true", RADAR_SEARCH_ENABLED: "true" }),
      resolvePublicProfile: profileResolver,
      clock: () => NOW
    }).search({ identity: identity(), query: {} }),
    error => error.code === "FRIENDLY_SEARCH_NOT_CONFIGURED" && error.status === 503
  );
  await assert.rejects(
    createFriendlySearchService({
      repository: repository(rows, origin({ status: "suspended", suspendedAt: NOW })),
      config: config(),
      resolvePublicProfile: profileResolver,
      clock: () => NOW
    }).search({ identity: identity(), query: {} }),
    error => error.code === "FRIENDLY_SEARCH_ORIGIN_INELIGIBLE"
  );
  const limited = repository(rows);
  limited.consumeRateLimits = async () => {
    throw new RadarIdentityError("FRIENDLY_SEARCH_RATE_LIMITED", 429, "Limite.");
  };
  await assert.rejects(
    createFriendlySearchService({
      repository: limited,
      config: config(),
      resolvePublicProfile: profileResolver,
      clock: () => NOW
    }).search({ identity: identity(), query: {} }),
    error => error.status === 429
  );
});

test("general search lists a new team without city, verification, crest, categories or schedule", async () => {
  const newTeam = candidate(9, {
    publicCrestAvailable: false,
    instagramVerified: false,
    cityIbgeCode: null,
    cityName: null,
    stateCode: null,
    approximateLatitude: null,
    approximateLongitude: null,
    modalities: [],
    categories: [],
    modality: null,
    category: null,
    startsAt: null,
    endsAt: null,
    venuePreference: null,
    availabilityOverlap: false,
    verifiedMatchCount: 0
  });
  const service = createFriendlySearchService({
    repository: repository([newTeam]),
    config: config(),
    clock: () => NOW
  });
  const result = await service.search({ identity: identity(), query: {} });
  assert.equal(result.items.length, 1);
  assert.equal(result.search.radius_km, null);
  assert.equal(result.items[0].availability.label, "Horário a combinar");
  assert.equal(result.items[0].instagram.label, "Não verificado");
  assert.equal(result.items[0].verified_match_count, undefined);
  assert.equal(result.items[0].experience.label, "Novo no Radar");
  assert.equal(result.items[0].reputation.label, "Sem nota");
});

test("representative volume and concurrent searches keep deterministic small pages", async () => {
  const rows = Array.from({ length: 300 }, (_, index) => candidate(index + 1, {
    startsAt: new Date(NOW.getTime() + (index + 1) * 60_000).toISOString(),
    endsAt: new Date(NOW.getTime() + (index + 1) * 60_000 + 3_600_000).toISOString()
  }));
  const service = createFriendlySearchService({
    repository: repository(rows),
    config: config(),
    resolvePublicProfile: profileResolver,
    clock: () => NOW
  });
  const results = await Promise.all(Array.from({ length: 12 }, () => service.search({
    identity: identity(),
    query: { limit: "10" },
    requestContext: { ip: "198.51.100.8" }
  })));
  assert.ok(results.every(result => result.items.length === 10 && result.page.has_more));
  assert.ok(results.every(result => result.items.map(item => item.slug).join(",") ===
    results[0].items.map(item => item.slug).join(",")));
});

test("route is authenticated, flag-gated, no-store and resolves identity before search", async () => {
  const calls = [];
  const service = {
    async search(value) {
      calls.push(value);
      return { items: [], page: { limit: 2, has_more: false, next_cursor: null }, search: { radius_km: 25 } };
    }
  };
  const app = express();
  app.use("/amistosos", createFriendlySearchRouter({
    config: config(),
    auth(req, res, next) {
      if (req.get("Authorization") !== "Bearer session") return res.status(401).json({ ok: false });
      req.user = { opaque: true };
      return next();
    },
    resolveIdentity: async user => {
      assert.deepEqual(user, { opaque: true });
      return identity();
    },
    searchService: service
  }));
  assert.equal((await request(app, "/amistosos/times-proximos")).status, 401);
  const result = await request(app, "/amistosos/times-proximos?modality=society", {
    headers: { Authorization: "Bearer session" }
  });
  assert.equal(result.status, 200);
  assert.equal(result.headers.get("cache-control"), "private, no-store");
  assert.equal(calls[0].identity.accountId, "account-owner");
  assert.equal(calls[0].query.modality, "society");

  const disabled = express();
  disabled.use("/amistosos", createFriendlySearchRouter({
    config: createRadarConfig({}),
    searchService: service
  }));
  assert.equal((await request(disabled, "/amistosos/times-proximos")).status, 404);

  const inactive = express();
  inactive.use("/amistosos", createFriendlySearchRouter({
    config: config(),
    auth(req, res, next) { req.user = {}; next(); },
    resolveIdentity() { throw new RadarIdentityError("ACCOUNT_INACTIVE", 403, "Conta inativa."); },
    searchService: service
  }));
  const blocked = await request(inactive, "/amistosos/times-proximos");
  assert.equal(blocked.status, 403);
  assert.equal(blocked.body.code, "ACCOUNT_INACTIVE");
});
