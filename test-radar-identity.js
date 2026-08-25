"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");
const express = require("express");
const { createRadarConfig } = require("./src/config/radar");
const { createRadarIdentityRouter } = require("./src/friendlies/radar-identity.routes");
const { RadarIdentityError } = require("./src/friendlies/radar-identity.errors");
const {
  createLegacyRadarIdentityResolver,
  assertRadarTeamOwnedByIdentity,
  assertRadarTeamCanMutate
} = require("./src/friendlies/radar-identity.policy");
const {
  validateRadarProfileInput,
  validateExpectedVersion
} = require("./src/friendlies/radar-identity.schemas");
const {
  buildRadarEligibility,
  deriveStatus,
  ownerProfile
} = require("./src/friendlies/radar-identity.service");

async function request(app, pathname, options = {}) {
  const server = app.listen(0, "127.0.0.1");
  await new Promise((resolve, reject) => {
    server.once("listening", resolve);
    server.once("error", reject);
  });

  try {
    const address = server.address();
    const response = await fetch(`http://127.0.0.1:${address.port}${pathname}`, options);
    return {
      status: response.status,
      headers: response.headers,
      body: await response.json()
    };
  } finally {
    await new Promise(resolve => server.close(resolve));
  }
}

function completeTeam(overrides = {}) {
  return {
    publicId: "public-team-id",
    legacyProfileId: "profile-7",
    accountReference: "account-9",
    status: "paused",
    instagramHandle: "time.teste",
    instagramVerificationStatus: "verified",
    cityIbgeCode: "4209102",
    cityName: "Joinville",
    stateCode: "SC",
    modalities: ["society"],
    categories: ["Livre"],
    declaredLevel: "intermediario",
    travelRadiusKm: 25,
    venuePreference: "either",
    availabilityActive: false,
    termsAcceptedAt: "2026-08-24T12:00:00.000Z",
    suspendedAt: null,
    version: 2,
    updatedAt: "2026-08-24T12:00:00.000Z",
    ...overrides
  };
}

const publicLegacyProfile = Object.freeze({
  perfil_id: "profile-7",
  slug: "time-teste",
  nome_time: "Time Teste",
  publico: true,
  escudo_url: "/escudos/time.png"
});

test("authenticated identity keeps account, profile and phone subject separate", () => {
  let ensuredSubject = null;
  const resolve = createLegacyRadarIdentityResolver({
    getAccountRecord(subject) {
      assert.equal(subject, "5511999999999");
      return { ativo: true, cliente_id: "account-9", perfil_id: "ignored-client-field" };
    },
    ensureLegacyProfile(subject) {
      ensuredSubject = subject;
      return { perfil_id: "profile-7", perfil: publicLegacyProfile };
    }
  });

  const identity = resolve({ whatsapp: "5511999999999", cliente_id: "forged-token-id" });
  assert.equal(ensuredSubject, "5511999999999");
  assert.equal(identity.authSubject, "5511999999999");
  assert.equal(identity.accountId, "account-9");
  assert.equal(identity.profileId, "profile-7");
  assert.notEqual(identity.accountId, identity.profileId);
});

test("legacy phone identifiers become opaque account references", () => {
  const resolve = createLegacyRadarIdentityResolver({
    getAccountRecord: () => ({ ativo: true, cliente_id: "5511999999999" }),
    ensureLegacyProfile: () => ({ perfil_id: "profile-7", perfil: publicLegacyProfile })
  });
  const identity = resolve({ whatsapp: "5511999999999" });
  assert.match(identity.accountId, /^legacy_[0-9a-f]{64}$/);
  assert.equal(identity.accountId.includes("5511999999999"), false);
});

test("inactive, suspended and missing legacy accounts are denied", () => {
  for (const [account, code] of [
    [null, "ACCOUNT_NOT_FOUND"],
    [{ ativo: false }, "ACCOUNT_INACTIVE"],
    [{ ativo: true, radar_suspenso: true }, "ACCOUNT_SUSPENDED"]
  ]) {
    const resolve = createLegacyRadarIdentityResolver({
      getAccountRecord: () => account,
      ensureLegacyProfile: () => {
        throw new Error("must not run");
      }
    });
    assert.throws(
      () => resolve({ whatsapp: "5511999999999" }),
      error => error instanceof RadarIdentityError && error.code === code
    );
  }
});

test("owner policy rejects another account and suspended teams", () => {
  const identity = { accountId: "account-9", profileId: "profile-7" };
  assert.doesNotThrow(() => assertRadarTeamOwnedByIdentity(completeTeam(), identity));
  assert.throws(
    () => assertRadarTeamOwnedByIdentity(
      completeTeam({ accountReference: "account-other" }),
      identity
    ),
    error => error.code === "RADAR_PROFILE_FORBIDDEN"
  );
  assert.throws(
    () => assertRadarTeamCanMutate(completeTeam({ status: "suspended" })),
    error => error.code === "RADAR_PROFILE_SUSPENDED"
  );
});

test("profile contract normalizes safe fields and rejects identity or invalid values", () => {
  assert.deepEqual(validateRadarProfileInput({
    city_name: "  Joinville ",
    state_code: "sc",
    instagram_handle: "https://instagram.com/Time.Teste/?hl=pt-br",
    modalities: ["society", "futsal", "SOCIETY"],
    categories: ["Livre", "Livre"],
    travel_radius_km: 40,
    venue_preference: "either",
    availability_active: false,
    accept_terms: true
  }), {
    cityName: "Joinville",
    stateCode: "SC",
    instagramHandle: "time.teste",
    modalities: ["society", "futsal"],
    categories: ["Livre"],
    travelRadiusKm: 40,
    venuePreference: "either",
    availabilityActive: false,
    acceptTerms: true
  });

  for (const body of [
    { team_id: "forged" },
    { phone: "5511999999999" },
    { city_ibge_code: "4209102" },
    { declared_level: "intermediario" },
    { status: "active" },
    { state_code: "XX" },
    { instagram_handle: "https://example.com/time" },
    { city_name: "x".repeat(121) }
  ]) {
    assert.throws(
      () => validateRadarProfileInput(body),
      error => error.code === "VALIDATION_ERROR"
    );
  }
});

test("If-Match supports numeric ETags and rejects unsafe versions", () => {
  assert.equal(validateExpectedVersion(undefined), null);
  assert.equal(validateExpectedVersion("2"), 2);
  assert.equal(validateExpectedVersion('W/"7"'), 7);
  assert.throws(
    () => validateExpectedVersion("team-7"),
    error => error.code === "INVALID_PROFILE_VERSION"
  );
});

test("eligibility is derived from verified persisted and legacy data", () => {
  const config = createRadarConfig({
    RADAR_AMISTOSOS_ENABLED: "true",
    RADAR_PILOT_CITY_IBGE_CODE: "4209102"
  });
  const team = completeTeam();
  const eligibility = buildRadarEligibility({ team, legacyProfile: publicLegacyProfile, config });
  assert.equal(eligibility.eligible, true);
  assert.equal(eligibility.discoverable, false);
  assert.deepEqual(eligibility.missing, []);
  assert.equal(deriveStatus(team, eligibility), "paused");

  const unsafe = buildRadarEligibility({
    team: completeTeam({ instagramVerificationStatus: "unverified" }),
    legacyProfile: { ...publicLegacyProfile, publico: false, escudo_url: "" },
    config
  });
  assert.equal(unsafe.eligible, false);
  assert.ok(unsafe.missing.includes("profile_not_public"));
  assert.ok(unsafe.missing.includes("crest_missing"));
  assert.ok(unsafe.missing.includes("instagram_not_verified"));
});

test("owner response does not expose internal identity or contact fields", () => {
  const response = ownerProfile(completeTeam({
    id: "internal-db-id",
    accountReference: "account-secret",
    phone: "5511999999999"
  }));
  assert.equal(response.public_id, "public-team-id");
  assert.equal(Object.hasOwn(response, "id"), false);
  assert.equal(Object.hasOwn(response, "account_reference"), false);
  assert.equal(Object.hasOwn(response, "phone"), false);
});

test("protected Radar endpoints authenticate, resolve server-side identity and hide errors", async () => {
  const calls = [];
  const service = {
    async getProfile(identity) {
      calls.push({ type: "get", identity });
      return {
        profile: null,
        legacy_profile: { slug: "time-teste" },
        eligibility: { eligible: false, missing: ["radar_profile_not_created"] },
        onboarding: { required: true, next_action: "create_profile" },
        replayed: false
      };
    },
    async putProfile(input) {
      calls.push({ type: "put", input });
      return {
        profile: { public_id: "public-team-id", version: 1 },
        legacy_profile: { slug: "time-teste" },
        eligibility: { eligible: false, missing: ["instagram_not_verified"] },
        onboarding: { required: false, next_action: null },
        replayed: false
      };
    }
  };
  const app = express();
  app.use("/me/time/radar", createRadarIdentityRouter({
    config: createRadarConfig({ RADAR_AMISTOSOS_ENABLED: "true" }),
    auth(req, res, next) {
      if (req.get("Authorization") !== "Bearer valid") {
        return res.status(401).json({ ok: false, error: "Sem token" });
      }
      req.user = { whatsapp: "5511999999999" };
      return next();
    },
    resolveIdentity(user) {
      assert.equal(user.whatsapp, "5511999999999");
      return { accountId: "account-9", profileId: "profile-7", legacyProfile: publicLegacyProfile };
    },
    identityService: service,
    logger: { error() { throw new Error("unexpected log"); } }
  }));

  const denied = await request(app, "/me/time/radar");
  assert.equal(denied.status, 401);

  const firstAccess = await request(app, "/me/time/radar", {
    headers: { Authorization: "Bearer valid" }
  });
  assert.equal(firstAccess.status, 200);
  assert.equal(firstAccess.body.profile, null);
  assert.deepEqual(firstAccess.body.onboarding, {
    required: true,
    next_action: "create_profile"
  });

  const eligibility = await request(app, "/me/time/radar/elegibilidade", {
    headers: { Authorization: "Bearer valid" }
  });
  assert.equal(eligibility.status, 200);
  assert.equal(eligibility.body.profile, null);
  assert.equal(eligibility.body.onboarding.required, true);
  assert.equal(eligibility.body.eligibility.eligible, false);

  const updated = await request(app, "/me/time/radar", {
    method: "PATCH",
    headers: {
      Authorization: "Bearer valid",
      "Content-Type": "application/json",
      "Idempotency-Key": "profile-update-0001",
      "If-Match": 'W/"2"',
      "X-Request-Id": "request-7"
    },
    body: JSON.stringify({ city_name: "Joinville" })
  });
  assert.equal(updated.status, 200);
  assert.equal(updated.headers.get("etag"), 'W/"1"');
  const put = calls.find(call => call.type === "put").input;
  assert.equal(put.identity.accountId, "account-9");
  assert.equal(put.idempotencyKey, "profile-update-0001");
  assert.equal(put.expectedVersion, 'W/"2"');
  assert.deepEqual(put.body, { city_name: "Joinville" });

  const wrongType = await request(app, "/me/time/radar", {
    method: "PATCH",
    headers: { Authorization: "Bearer valid", "Content-Type": "text/plain" },
    body: "city_name=Joinville"
  });
  assert.equal(wrongType.status, 415);
  assert.equal(wrongType.body.code, "UNSUPPORTED_MEDIA_TYPE");

  const invalidJson = await request(app, "/me/time/radar", {
    method: "PATCH",
    headers: { Authorization: "Bearer valid", "Content-Type": "application/json" },
    body: "{"
  });
  assert.equal(invalidJson.status, 400);
  assert.equal(invalidJson.body.code, "INVALID_JSON");
});

test("feature flag and safe Radar errors fail closed", async () => {
  const disabled = express();
  disabled.use("/me/time/radar", createRadarIdentityRouter({ config: createRadarConfig({}) }));
  assert.equal((await request(disabled, "/me/time/radar")).status, 404);

  const enabled = express();
  enabled.use("/me/time/radar", createRadarIdentityRouter({
    config: createRadarConfig({ RADAR_AMISTOSOS_ENABLED: "true" }),
    auth(req, res, next) {
      req.user = { whatsapp: "5511999999999" };
      next();
    },
    resolveIdentity() {
      throw new RadarIdentityError("ACCOUNT_INACTIVE", 403, "Conta inativa.");
    },
    identityService: { getProfile() {}, putProfile() {} }
  }));
  const response = await request(enabled, "/me/time/radar");
  assert.equal(response.status, 403);
  assert.deepEqual(response.body, {
    ok: false,
    code: "ACCOUNT_INACTIVE",
    error: "Conta inativa."
  });
  assert.equal(response.headers.get("cache-control"), "private, no-store");
});
