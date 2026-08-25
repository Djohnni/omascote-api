"use strict";

const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const test = require("node:test");
const { PGlite } = require("@electric-sql/pglite");
const { migrate } = require("./src/db/migrate");
const { createRadarConfig } = require("./src/config/radar");
const {
  createFriendlySearchRepository
} = require("./src/friendlies/friendly-search.repository");
const {
  createFriendlySearchService
} = require("./src/friendlies/friendly-search.service");

const NOW = new Date("2026-08-25T12:00:00.000Z");
const FIXTURE_CREATED_AT = "2026-08-25T10:00:00.000Z";

function normalizeResult(result) {
  const lastResult = Array.isArray(result) ? result[result.length - 1] : result;
  if (!lastResult) return { rows: [], rowCount: 0 };
  return {
    ...lastResult,
    rowCount: lastResult.rows?.length || lastResult.affectedRows || 0
  };
}

function createPoolAdapter(database) {
  function client() {
    return {
      async query(sql, params) {
        if (params) return normalizeResult(await database.query(sql, params));
        return normalizeResult(await database.exec(sql));
      },
      release() {}
    };
  }
  return {
    connect: async () => client(),
    query: (sql, params) => client().query(sql, params)
  };
}

function config(overrides = {}) {
  return createRadarConfig({
    RADAR_AMISTOSOS_ENABLED: "true",
    RADAR_SEARCH_ENABLED: "true",
    RADAR_SEARCH_CURSOR_SECRET: "database-cursor-secret-at-least-32-chars",
    RADAR_SEARCH_RATE_LIMIT_SECRET: "database-rate-secret-at-least-32-chars",
    RADAR_PILOT_CITY_IBGE_CODE: "4209102",
    RADAR_SEARCH_PAGE_DEFAULT: "10",
    RADAR_SEARCH_PAGE_MAXIMUM: "20",
    RADAR_SEARCH_ACCOUNT_LIMIT: "20",
    RADAR_SEARCH_TEAM_LIMIT: "20",
    RADAR_SEARCH_IP_LIMIT: "20",
    ...overrides
  });
}

function identity() {
  return Object.freeze({
    accountId: "account-search-owner",
    profileId: "profile-search-owner",
    legacyProfile: Object.freeze({
      slug: "search-owner-fc",
      nome_time: "Search Owner FC",
      publico: true,
      escudo_url: "/escudos/search-owner.png"
    })
  });
}

async function insertTeam(database, suffix, overrides = {}) {
  const value = {
    profileId: `profile-${suffix}`,
    accountId: `account-${suffix}`,
    slug: `${suffix}-fc`,
    status: "active",
    verification: "verified",
    cityIbgeCode: "4209102",
    cityName: "Joinville",
    stateCode: "SC",
    latitude: "-26.310000",
    longitude: "-48.850000",
    availabilityActive: true,
    termsAcceptedAt: "2026-08-20T12:00:00.000Z",
    suspendedAt: null,
    publicName: `${suffix} FC`,
    publicProfileEnabled: true,
    publicCrestAvailable: true,
    ...overrides
  };
  const result = await database.query(`
    INSERT INTO radar_team_profiles(
      legacy_profile_id, account_reference, public_slug, status,
      instagram_handle, instagram_verification_status,
      city_ibge_code, city_name, state_code,
      approximate_latitude, approximate_longitude,
      modalities, categories, declared_level, travel_radius_km,
      venue_preference, availability_active, radar_terms_accepted_at,
      suspended_at, public_name, public_profile_enabled, public_crest_available,
      created_at, updated_at
    ) VALUES (
      $1, $2, $3, $4, $5, $6,
      $7, $8, $9, $10, $11,
      ARRAY['society'], ARRAY['Livre'], 'intermediario', 25,
      'either', $12, $13, $14, $15, $16, $17, $18, $18
    ) RETURNING id
  `, [
    value.profileId,
    value.accountId,
    value.slug,
    value.status,
    `${suffix}.fc`,
    value.verification,
    value.cityIbgeCode,
    value.cityName,
    value.stateCode,
    value.latitude,
    value.longitude,
    value.availabilityActive,
    value.termsAcceptedAt,
    value.suspendedAt,
    value.publicName,
    value.publicProfileEnabled,
    value.publicCrestAvailable,
    FIXTURE_CREATED_AT
  ]);
  return { id: result.rows[0].id, ...value };
}

async function insertAvailability(database, teamId, suffix, overrides = {}) {
  const value = {
    startsAt: "2026-08-26T22:00:00.000Z",
    endsAt: "2026-08-27T00:00:00.000Z",
    status: "active",
    modality: "society",
    category: "Livre",
    cityIbgeCode: "4209102",
    cityName: "Joinville",
    stateCode: "SC",
    level: "intermediario",
    venuePreference: "away",
    ...overrides
  };
  const hash = crypto.createHash("sha256").update(`search-slot-${suffix}`).digest("hex");
  await database.query(`
    INSERT INTO friendly_availabilities(
      team_id, modality, category, declared_level, starts_at, ends_at,
      city_ibge_code, city_name, state_code, travel_radius_km,
      venue_preference, status, schedule_hash, created_at, updated_at
    ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, 25, $10, $11, $12, $13, $13)
  `, [
    teamId,
    value.modality,
    value.category,
    value.level,
    value.startsAt,
    value.endsAt,
    value.cityIbgeCode,
    value.cityName,
    value.stateCode,
    value.venuePreference,
    value.status,
    hash,
    FIXTURE_CREATED_AT
  ]);
}

function publicResolver(publicTeams) {
  return slug => {
    const team = publicTeams.get(slug);
    if (!team) return null;
    return {
      slug,
      name: team.publicName,
      public: team.publicProfileEnabled,
      hasCrest: team.publicCrestAvailable
    };
  };
}

test("migration 007 is idempotent and discovery excludes unsafe candidates in real PostgreSQL", async () => {
  const database = new PGlite();
  const pool = createPoolAdapter(database);
  try {
    const applied = await migrate({ pool });
    assert.equal(applied.at(-1), "014_radar_smart_onboarding.sql");
    assert.deepEqual(await migrate({ pool }), []);
    assert.equal((await database.query(`
      SELECT count(*)::integer AS total
      FROM schema_migrations
      WHERE name = '007_friendly_team_discovery.sql'
    `)).rows[0].total, 1);

    const ownerIdentity = identity();
    const owner = await insertTeam(database, "search-owner", {
      profileId: ownerIdentity.profileId,
      accountId: ownerIdentity.accountId,
      slug: "search-owner-fc",
      publicName: "Search Owner FC",
      latitude: "-26.304400",
      longitude: "-48.846400"
    });
    await insertAvailability(database, owner.id, "owner");

    const visible = await insertTeam(database, "visible");
    await insertAvailability(database, visible.id, "visible");
    const sameCity = await insertTeam(database, "same-city", { latitude: null, longitude: null });
    await insertAvailability(database, sameCity.id, "same-city", {
      startsAt: "2026-08-27T22:00:00.000Z",
      endsAt: "2026-08-28T00:00:00.000Z"
    });
    const far = await insertTeam(database, "far", { latitude: "-25.000000", longitude: "-48.850000" });
    await insertAvailability(database, far.id, "far");
    const unverified = await insertTeam(database, "unverified", { verification: "unverified" });
    await insertAvailability(database, unverified.id, "unverified");
    const suspended = await insertTeam(database, "suspended", {
      status: "suspended",
      suspendedAt: "2026-08-24T12:00:00.000Z"
    });
    await insertAvailability(database, suspended.id, "suspended");
    const expired = await insertTeam(database, "expired");
    await insertAvailability(database, expired.id, "expired", {
      startsAt: "2026-08-23T20:00:00.000Z",
      endsAt: "2026-08-23T22:00:00.000Z"
    });
    const blocked = await insertTeam(database, "blocked");
    await insertAvailability(database, blocked.id, "blocked");
    await database.query(
      "INSERT INTO team_blocks(blocker_team_id, blocked_team_id, private_reason) VALUES ($1, $2, $3)",
      [blocked.id, owner.id, "private database reason"]
    );
    const privateTeam = await insertTeam(database, "private", { publicProfileEnabled: false });
    await insertAvailability(database, privateTeam.id, "private");

    const teams = new Map([
      visible, sameCity, far, unverified, suspended, expired, blocked, privateTeam
    ].map(team => [team.slug, team]));
    const service = createFriendlySearchService({
      repository: createFriendlySearchRepository({ pool, config: config() }),
      config: config(),
      resolvePublicProfile: publicResolver(teams),
      clock: () => NOW
    });
    const result = await service.search({
      identity: ownerIdentity,
      query: { modality: "society", category: "Livre", radius_km: "25", limit: "10" },
      requestContext: { ip: "203.0.113.40" }
    });
    assert.deepEqual(new Set(result.items.map(item => item.slug)), new Set(["visible-fc", "same-city-fc"]));
    assert.equal(result.items.find(item => item.slug === "same-city-fc").location.label, "mesma cidade");
    const visibleResult = result.items.find(item => item.slug === "visible-fc");
    assert.ok(visibleResult.location.distance_km > 0);
    assert.ok(visibleResult.location.distance_km < 2);
    assert.equal(visibleResult.reputation.state, "new_on_radar");
    const serialized = JSON.stringify(result).toLowerCase();
    for (const forbidden of [
      "account-search-owner", owner.id, visible.id, "private database reason",
      "latitude", "longitude", "whatsapp_url", "telefone", "email", "notes"
    ]) {
      assert.equal(serialized.includes(String(forbidden).toLowerCase()), false, forbidden);
    }
    assert.equal(visibleResult.whatsapp_disponivel, false);
    const storedLimits = await database.query(
      "SELECT scope_type, scope_hash::text FROM radar_search_rate_limits ORDER BY scope_type"
    );
    assert.equal(storedLimits.rows.length, 3);
    assert.ok(storedLimits.rows.every(row => /^[0-9a-f]{64}$/.test(row.scope_hash)));
    assert.equal(JSON.stringify(storedLimits.rows).includes(ownerIdentity.accountId), false);
    const metrics = await database.query("SELECT outcome, request_count, returned_count FROM radar_search_metrics");
    assert.deepEqual(metrics.rows, [{ outcome: "success", request_count: 1, returned_count: 2 }]);
  } finally {
    await database.close();
  }
});

test("persistent limits reject repeated enumeration and store only opaque hashes", async () => {
  const database = new PGlite();
  const pool = createPoolAdapter(database);
  try {
    await migrate({ pool });
    const ownerIdentity = identity();
    const owner = await insertTeam(database, "search-owner", {
      profileId: ownerIdentity.profileId,
      accountId: ownerIdentity.accountId,
      slug: "search-owner-fc",
      publicName: "Search Owner FC"
    });
    const visible = await insertTeam(database, "limited-visible");
    await insertAvailability(database, visible.id, "limited-visible");
    const limitedConfig = config({
      RADAR_SEARCH_ACCOUNT_LIMIT: "1",
      RADAR_SEARCH_TEAM_LIMIT: "1",
      RADAR_SEARCH_IP_LIMIT: "1"
    });
    const service = createFriendlySearchService({
      repository: createFriendlySearchRepository({ pool, config: limitedConfig }),
      config: limitedConfig,
      resolvePublicProfile: publicResolver(new Map([[visible.slug, visible]])),
      clock: () => NOW
    });
    await assert.doesNotReject(service.search({
      identity: ownerIdentity,
      query: {},
      requestContext: { ip: "198.51.100.50" }
    }));
    await assert.rejects(service.search({
      identity: ownerIdentity,
      query: {},
      requestContext: { ip: "198.51.100.50" }
    }), error => error.code === "FRIENDLY_SEARCH_RATE_LIMITED" && error.status === 429);
    const rows = await database.query("SELECT scope_hash::text FROM radar_search_rate_limits");
    assert.equal(rows.rows.length, 3);
    assert.equal(JSON.stringify(rows.rows).includes(ownerIdentity.accountId), false);
    assert.equal(JSON.stringify(rows.rows).includes(owner.id), false);
  } finally {
    await database.close();
  }
});
