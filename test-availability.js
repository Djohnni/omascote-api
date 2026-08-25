"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");
const express = require("express");
const { createRadarConfig } = require("./src/config/radar");
const { RadarIdentityError } = require("./src/friendlies/radar-identity.errors");
const {
  normalizeCreateAvailability,
  normalizePatchAvailability,
  validateAvailabilityWindow,
  normalizeRecurrence,
  containsPrivateContact
} = require("./src/friendlies/availability.schemas");
const {
  createAvailabilityService
} = require("./src/friendlies/availability.service");
const {
  createAvailabilityRouter
} = require("./src/friendlies/availability.routes");

const NOW = new Date("2026-08-24T12:00:00.000Z");
const PUBLIC_ID = "11111111-1111-4111-8111-111111111111";

function config(overrides = {}) {
  return createRadarConfig({
    RADAR_AMISTOSOS_ENABLED: "true",
    RADAR_AVAILABILITY_MAX_FUTURE_PER_TEAM: "20",
    ...overrides
  });
}

function identity(suffix = "owner") {
  return Object.freeze({
    accountId: `account-${suffix}`,
    profileId: `profile-${suffix}`,
    legacyProfile: Object.freeze({
      nome_time: `${suffix} FC`,
      publico: true,
      escudo_url: `/escudos/${suffix}.png`
    })
  });
}

function team(overrides = {}) {
  return Object.freeze({
    id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
    publicId: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
    legacyProfileId: "profile-owner",
    accountReference: "account-owner",
    status: "paused",
    instagramHandle: "owner.fc",
    instagramVerificationStatus: "verified",
    cityIbgeCode: "4209102",
    cityName: "Joinville",
    stateCode: "SC",
    modalities: ["society", "futsal"],
    categories: ["Livre", "Veterano"],
    declaredLevel: "intermediario",
    travelRadiusKm: 25,
    venuePreference: "either",
    availabilityActive: false,
    termsAcceptedAt: "2026-08-20T12:00:00.000Z",
    version: 3,
    ...overrides
  });
}

function body(overrides = {}) {
  return {
    modality: "society",
    category: "Livre",
    starts_at: "2026-08-25T19:00:00-03:00",
    ends_at: "2026-08-25T21:00:00-03:00",
    status: "active",
    ...overrides
  };
}

function availability(value, overrides = {}) {
  return Object.freeze({
    id: "cccccccc-cccc-4ccc-8ccc-cccccccccccc",
    publicId: PUBLIC_ID,
    teamId: value.teamId || team().id,
    modality: value.modality,
    category: value.category,
    declaredLevel: value.declaredLevel,
    startsAt: value.startsAt,
    endsAt: value.endsAt,
    recurrence: value.recurrence,
    cityIbgeCode: value.cityIbgeCode,
    cityName: value.cityName,
    stateCode: value.stateCode,
    travelRadiusKm: value.travelRadiusKm,
    venuePreference: value.venuePreference,
    notes: value.notes,
    status: value.status,
    scheduleHash: value.scheduleHash,
    version: 1,
    createdAt: NOW.toISOString(),
    updatedAt: NOW.toISOString(),
    ...overrides
  });
}

function repository(ownerTeam = team()) {
  const state = { created: null, updated: null, cancelled: null };
  return {
    state,
    async listOwned({ limit }) {
      return { rows: state.created ? [state.created] : [], limit };
    },
    async createOwned(options) {
      const value = options.buildAvailability(ownerTeam);
      state.created = availability({ ...value, teamId: ownerTeam.id });
      return { availability: state.created, replayed: false };
    },
    async updateOwned(options) {
      const current = state.created || availability({
        ...normalizeCreateAvailability(body({ status: "paused" })),
        declaredLevel: ownerTeam.declaredLevel,
        cityIbgeCode: ownerTeam.cityIbgeCode,
        cityName: ownerTeam.cityName,
        stateCode: ownerTeam.stateCode,
        travelRadiusKm: 25,
        venuePreference: "either",
        scheduleHash: "a".repeat(64)
      });
      const value = options.buildAvailability(ownerTeam, current);
      state.updated = availability({ ...value, teamId: ownerTeam.id }, { version: current.version + 1 });
      return { availability: state.updated, replayed: false };
    },
    async cancelOwned() {
      state.cancelled = availability({
        ...(state.updated || state.created),
        teamId: ownerTeam.id
      }, { status: "cancelled", version: 3 });
      return { availability: state.cancelled, replayed: false };
    }
  };
}

async function request(app, route, options = {}) {
  const server = app.listen(0, "127.0.0.1");
  await new Promise(resolve => server.once("listening", resolve));
  try {
    const address = server.address();
    const response = await fetch(`http://127.0.0.1:${address.port}${route}`, options);
    const text = await response.text();
    let parsed = null;
    if (text) {
      try { parsed = JSON.parse(text); } catch { parsed = text; }
    }
    return { status: response.status, headers: response.headers, body: parsed };
  } finally {
    await new Promise(resolve => server.close(resolve));
  }
}

test("availability configuration is safe by default and bounded by environment", () => {
  const disabled = createRadarConfig({});
  assert.equal(disabled.enabled, false);
  assert.equal(disabled.availabilityDefaultTravelRadiusKm, 25);
  assert.equal(disabled.availabilityTimeZone, "America/Sao_Paulo");
  assert.equal(config({ RADAR_AVAILABILITY_MAX_FUTURE_PER_TEAM: "999" }).availabilityMaxFuturePerTeam, 100);
});

test("availability schemas reject ownership, coordinates, arbitrary state and contact", () => {
  for (const value of [
    { ...body(), team_id: "other" },
    { ...body(), account_id: "other" },
    { ...body(), profile_id: "other" },
    { ...body(), latitude: -26.3 },
    { ...body(), status: "verified" },
    { ...body(), notes: "WhatsApp (47) 99999-9999" },
    { ...body(), notes: "instagram @owner.fc" },
    { ...body(), notes: "acesse https://example.com" }
  ]) {
    assert.throws(() => normalizeCreateAvailability(value), RadarIdentityError);
  }
  assert.equal(containsPrivateContact("Jogo amistoso, gramado sintetico"), false);
  assert.equal(normalizePatchAvailability({ status: "paused" }).status, "paused");
});

test("dates, horizon, duration and weekly recurrence are strictly bounded", () => {
  const cfg = config();
  assert.throws(() => normalizeCreateAvailability(body({ starts_at: "2026-08-25 19:00" })));
  assert.throws(() => validateAvailabilityWindow({
    startsAt: "2026-08-23T19:00:00.000Z",
    endsAt: "2026-08-23T20:00:00.000Z",
    recurrence: null,
    now: NOW,
    config: cfg,
    requireFutureStart: true
  }));
  assert.throws(() => validateAvailabilityWindow({
    startsAt: "2026-08-25T12:00:00.000Z",
    endsAt: "2026-08-27T12:00:00.000Z",
    recurrence: null,
    now: NOW,
    config: cfg,
    requireFutureStart: true
  }));
  assert.throws(() => validateAvailabilityWindow({
    startsAt: "2027-08-25T12:00:00.000Z",
    endsAt: "2027-08-25T13:00:00.000Z",
    recurrence: null,
    now: NOW,
    config: cfg,
    requireFutureStart: true
  }));
  assert.throws(() => normalizeRecurrence({
    frequency: "monthly",
    days_of_week: ["monday"],
    start_time: "19:00",
    end_time: "20:00",
    until: "2026-09-10"
  }));
  const recurrence = normalizeRecurrence({
    frequency: "weekly",
    days_of_week: ["monday", "thursday"],
    start_time: "19:00",
    end_time: "21:00",
    until: "2026-09-10"
  });
  assert.equal(recurrence.time_zone, "America/Sao_Paulo");
  assert.throws(() => validateAvailabilityWindow({
    startsAt: "2026-08-25T22:00:00.000Z",
    endsAt: "2026-08-25T23:00:00.000Z",
    recurrence: { ...recurrence, until: "2027-01-30" },
    now: NOW,
    config: cfg,
    requireFutureStart: true
  }));
});

test("owner can create active or paused slots with canonical profile data and master switch off", async () => {
  const repo = repository();
  const service = createAvailabilityService({ repository: repo, config: config(), now: () => NOW });
  const result = await service.create({
    identity: identity(),
    body: body(),
    idempotencyKey: "availability-create-0001"
  });
  assert.equal(result.availability.status, "active");
  assert.equal(Object.hasOwn(result.availability, "declared_level"), false);
  assert.equal(result.availability.city.ibge_code, "4209102");
  assert.equal(result.availability.travel_radius_km, 25);
  assert.equal(result.availability.availability_id, PUBLIC_ID);
  assert.equal(Object.hasOwn(result.availability, "team_id"), false);
  assert.equal(Object.hasOwn(result.availability, "account_id"), false);

  const paused = await service.create({
    identity: identity(),
    body: body({ status: "paused" }),
    idempotencyKey: "availability-create-0002"
  });
  assert.equal(paused.availability.status, "paused");
});

test("profile membership and activation eligibility cannot be bypassed", async () => {
  const service = createAvailabilityService({ repository: repository(), config: config(), now: () => NOW });
  await assert.rejects(
    service.create({ identity: identity(), body: body({ modality: "futebol_campo" }), idempotencyKey: "bad-modality-0001" }),
    error => error.code === "AVAILABILITY_MODALITY_NOT_IN_PROFILE"
  );
  await assert.rejects(
    service.create({ identity: identity(), body: body({ category: "Sub-17" }), idempotencyKey: "bad-category-0001" }),
    error => error.code === "AVAILABILITY_CATEGORY_NOT_IN_PROFILE"
  );
  const unverified = team({ instagramVerificationStatus: "unverified" });
  await assert.rejects(
    createAvailabilityService({ repository: repository(unverified), config: config(), now: () => NOW })
      .create({ identity: identity(), body: body(), idempotencyKey: "not-eligible-0001" }),
    error => error.code === "AVAILABILITY_NOT_ELIGIBLE" && error.details.missing.includes("instagram_not_verified")
  );
  await assert.doesNotReject(
    createAvailabilityService({ repository: repository(unverified), config: config(), now: () => NOW })
      .create({ identity: identity(), body: body({ status: "paused" }), idempotencyKey: "paused-unverified-0001" })
  );
});

test("updates and cancellation require idempotency and If-Match and preserve public responses", async () => {
  const repo = repository();
  const service = createAvailabilityService({ repository: repo, config: config(), now: () => NOW });
  await service.create({ identity: identity(), body: body(), idempotencyKey: "create-before-update" });
  await assert.rejects(
    service.update({ identity: identity(), publicId: PUBLIC_ID, body: { status: "paused" }, idempotencyKey: "patch-no-version" }),
    error => error.code === "AVAILABILITY_VERSION_REQUIRED" && error.status === 428
  );
  const updated = await service.update({
    identity: identity(),
    publicId: PUBLIC_ID,
    body: { status: "paused", notes: "Campo coberto" },
    expectedVersion: 'W/"1"',
    idempotencyKey: "availability-patch-0001"
  });
  assert.equal(updated.availability.status, "paused");
  assert.equal(updated.availability.version, 2);
  const cancelled = await service.cancel({
    identity: identity(),
    publicId: PUBLIC_ID,
    expectedVersion: '"2"',
    idempotencyKey: "availability-delete-0001"
  });
  assert.equal(cancelled.availability.status, "cancelled");
  await assert.rejects(
    service.cancel({ identity: identity(), publicId: PUBLIC_ID, expectedVersion: "3" }),
    error => error.code === "INVALID_IDEMPOTENCY_KEY"
  );
});

test("private routes are owner-gated, flag-gated, no-store and expose no future features", async () => {
  const service = {
    async list() {
      return { items: [], pagination: { limit: 20, has_more: false, next_cursor: null }, time_zone: "America/Sao_Paulo" };
    },
    async create() {
      return { availability: { availability_id: PUBLIC_ID, status: "active", version: 1 }, replayed: false };
    },
    async update() {
      return { availability: { availability_id: PUBLIC_ID, status: "paused", version: 2 }, replayed: false };
    },
    async cancel() {
      return { availability: { availability_id: PUBLIC_ID, status: "cancelled", version: 3 }, replayed: false };
    }
  };
  const app = express();
  app.use("/me/time/amistosos", createAvailabilityRouter({
    config: config(),
    auth(req, res, next) { req.user = { session: "opaque" }; next(); },
    resolveIdentity: async () => identity(),
    availabilityService: service,
    logger: { error() { throw new Error("unexpected log"); } }
  }));
  const listed = await request(app, "/me/time/amistosos/disponibilidades");
  assert.equal(listed.status, 200);
  assert.equal(listed.headers.get("cache-control"), "private, no-store");
  assert.equal(JSON.stringify(listed.body).includes("account"), false);
  assert.equal((await request(app, "/me/time/amistosos/busca")).status, 404);
  assert.equal((await request(app, "/me/time/amistosos/convites", { method: "POST" })).status, 404);

  const created = await request(app, "/me/time/amistosos/disponibilidades", {
    method: "POST",
    headers: { "Content-Type": "application/json", "Idempotency-Key": "route-create-0001" },
    body: JSON.stringify(body())
  });
  assert.equal(created.status, 201);
  assert.equal(created.headers.get("etag"), 'W/"1"');

  const disabled = express();
  disabled.use("/me/time/amistosos", createAvailabilityRouter({
    config: createRadarConfig({}),
    availabilityService: service
  }));
  assert.equal((await request(disabled, "/me/time/amistosos/disponibilidades")).status, 404);

  const inactive = express();
  inactive.use("/me/time/amistosos", createAvailabilityRouter({
    config: config(),
    auth(req, res, next) { req.user = {}; next(); },
    resolveIdentity() { throw new RadarIdentityError("ACCOUNT_INACTIVE", 403, "Conta inativa."); },
    availabilityService: service
  }));
  const blocked = await request(inactive, "/me/time/amistosos/disponibilidades");
  assert.equal(blocked.status, 403);
  assert.equal(blocked.body.code, "ACCOUNT_INACTIVE");
});
