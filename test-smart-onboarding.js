"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");
const express = require("express");
const { PGlite } = require("@electric-sql/pglite");
const { migrate } = require("./src/db/migrate");
const { createRadarConfig } = require("./src/config/radar");
const { validateRadarProfileInput } = require("./src/friendlies/radar-identity.schemas");
const { resolveBrazilianCity } = require("./src/friendlies/brazil-city-catalog");
const { createRadarIdentityRepository } = require("./src/friendlies/radar-identity.repository");
const { createRadarIdentityService } = require("./src/friendlies/radar-identity.service");
const { createProfilePrintImportRepository } = require("./src/friendlies/profile-print-import.repository");
const { createProfilePrintImportService } = require("./src/friendlies/profile-print-import.service");
const { createRadarWhatsappRouter } = require("./src/friendlies/radar-whatsapp.routes");
const { normalizeWhatsapp, encryptWhatsapp, decryptWhatsapp } = require("./src/friendlies/radar-whatsapp.crypto");

const SECURITY_SECRET = "smart-onboarding-security-secret-000000000000";
const SAFETY_SECRET = "smart-onboarding-safety-secret-0000000000000";
const RATE_SECRET = "smart-onboarding-whatsapp-rate-secret-000000";
const KEY_V1 = Buffer.alloc(32, 1).toString("base64");
const KEY_V2 = Buffer.alloc(32, 2).toString("base64");

function normalizeResult(result) {
  const last = Array.isArray(result) ? result.at(-1) : result;
  if (!last) return { rows: [], rowCount: 0 };
  return { ...last, rowCount: last.rows?.length || last.affectedRows || 0 };
}

function poolFor(database) {
  function client() {
    return {
      async query(sql, params) {
        return params ? normalizeResult(await database.query(sql, params)) : normalizeResult(await database.exec(sql));
      },
      release() {}
    };
  }
  return { connect: async () => client(), query: (sql, params) => client().query(sql, params) };
}

function identity(suffix) {
  return Object.freeze({
    accountId: `account-smart-${suffix}`,
    profileId: `legacy-smart-${suffix}`,
    legacyProfile: Object.freeze({
      slug: `smart-${suffix}`,
      nome_time: `Smart ${suffix}`,
      publico: true,
      escudo_url: `/escudos/smart-${suffix}.png`
    })
  });
}

function config(overrides = {}) {
  return createRadarConfig({
    RADAR_AMISTOSOS_ENABLED: "true",
    RADAR_PROFILE_PRINT_IMPORT_ENABLED: "true",
    RADAR_PROFILE_PRINT_OPENAI_MODEL: "gpt-5-mini",
    RADAR_PROFILE_PRINT_REASONING_EFFORT: "low",
    RADAR_PROFILE_PRINT_SECURITY_SECRET: SECURITY_SECRET,
    RADAR_PROFILE_PRINT_SAFETY_IDENTIFIER_SECRET: SAFETY_SECRET,
    RADAR_PROFILE_PRINT_DAILY_TEAM_LIMIT: "3",
    RADAR_PROFILE_PRINT_MONTHLY_GLOBAL_LIMIT: "50",
    OPENAI_API_KEY: "test-only-openai-key",
    RADAR_WHATSAPP_ENCRYPTION_KEYS: `v1:${KEY_V1},v2:${KEY_V2}`,
    RADAR_WHATSAPP_ACTIVE_KEY_VERSION: "v2",
    RADAR_WHATSAPP_RATE_LIMIT_SECRET: RATE_SECRET,
    RADAR_PILOT_ACCOUNT_ALLOWLIST: "account-smart-owner,account-smart-target",
    ...overrides
  });
}

function draft() {
  return Object.freeze({
    schema_version: "1.0",
    suggestions: Object.freeze({
      team_name: Object.freeze({ value: "Smart owner", confidence: 0.98, evidence: "Nome visivel" }),
      city_name: Object.freeze({ value: "Joinville", confidence: 0.9, evidence: "Cidade visivel" }),
      state_code: Object.freeze({ value: "SC", confidence: 0.9, evidence: "UF visivel" }),
      instagram_handle: Object.freeze({ value: "smart.owner", confidence: 0.99, evidence: "Usuario visivel" }),
      modalities: Object.freeze({ value: Object.freeze(["society", "futsal"]), confidence: 0.8, evidence: "Modalidades visiveis" }),
      categories: Object.freeze({ value: Object.freeze(["Livre"]), confidence: 0.7, evidence: "Categoria visivel" })
    }),
    warnings: Object.freeze([])
  });
}

function image(hash = "a") {
  return Object.freeze({
    buffer: Buffer.from("synthetic-image-without-personal-data"), byteHash: hash.repeat(64),
    format: "png", mimeType: "image/png", width: 390, height: 844,
    originalSizeBytes: 40, sanitizedSizeBytes: 40
  });
}

function profileBody(extra = {}) {
  return {
    city_name: "Joinville", state_code: "SC", instagram_handle: "smart.owner",
    modalities: ["society", "futsal", "futebol_campo"], categories: ["Livre"],
    travel_radius_km: 25, venue_preference: "either", accept_terms: true, ...extra
  };
}

async function http(app, path) {
  const server = app.listen(0, "127.0.0.1");
  await new Promise(resolve => server.once("listening", resolve));
  try {
    const response = await fetch(`http://127.0.0.1:${server.address().port}${path}`);
    return { status: response.status, body: await response.json(), headers: response.headers };
  } finally { await new Promise(resolve => server.close(resolve)); }
}

test("manual contract uses city and UF only, supports one to three modalities and rejects legacy level", () => {
  assert.equal(resolveBrazilianCity("joinville", "sc").ibgeCode, "4209102");
  const parsed = validateRadarProfileInput(profileBody());
  assert.deepEqual(parsed.modalities, ["society", "futsal", "futebol_campo"]);
  assert.equal(Object.hasOwn(parsed, "cityIbgeCode"), false);
  assert.equal(Object.hasOwn(parsed, "declaredLevel"), false);
  for (const body of [
    { city_ibge_code: "4209102" }, { declared_level: "intermediario" },
    { modalities: [] }, { modalities: ["society", "futsal", "futebol_campo", "society"] }
  ]) assert.throws(() => validateRadarProfileInput(body), error => error.code === "VALIDATION_ERROR");
  assert.throws(() => resolveBrazilianCity("Joinville", "PR"), error => error.code === "RADAR_CITY_INVALID");
});

test("print draft on first access creates no Radar profile and profile confirmation is exactly once", async () => {
  const database = new PGlite();
  const pool = poolFor(database);
  const owner = identity("owner");
  let providerCalls = 0;
  try {
    const first = await migrate({ pool });
    assert.equal(first.at(-1), "016_match_communication.sql");
    assert.deepEqual(await migrate({ pool }), []);
    const importService = createProfilePrintImportService({
      repository: createProfilePrintImportRepository({ pool }),
      provider: { async analyze() { providerCalls += 1; return draft(); } },
      config: config(), now: () => new Date("2026-08-25T12:00:00.000Z")
    });
    const before = await importService.authorize(owner);
    assert.equal(before.existingProfile, false);
    assert.equal((await database.query("SELECT count(*)::integer AS total FROM radar_team_profiles")).rows[0].total, 0);
    const imported = await importService.importProfilePrint({
      identity: owner, fields: {}, image: image("a"), idempotencyKey: "smart-print-0001",
      requestId: "smart-request-1", requestContext: { ip: "203.0.113.10" }
    });
    assert.equal(imported.profile_unchanged, true);
    assert.equal(imported.draft.suggestions.modalities.value.length, 2);
    assert.equal(Object.hasOwn(imported.draft.suggestions, "declared_level"), false);
    assert.equal((await database.query("SELECT count(*)::integer AS total FROM radar_team_profiles")).rows[0].total, 0);
    assert.equal((await database.query("SELECT count(*)::integer AS total FROM radar_profile_print_import_requests")).rows[0].total, 1);
    const replay = await importService.importProfilePrint({
      identity: owner, fields: {}, image: image("a"), idempotencyKey: "smart-print-0001",
      requestContext: { ip: "203.0.113.10" }
    });
    assert.equal(replay.replayed, true);
    assert.equal(providerCalls, 1);

    const identityService = createRadarIdentityService({
      repository: createRadarIdentityRepository({ pool }), config: config(),
      now: () => new Date("2026-08-25T12:05:00.000Z")
    });
    const created = await identityService.putProfile({
      identity: owner, body: profileBody(), idempotencyKey: "smart-profile-0001", expectedVersion: null
    });
    assert.equal(created.profile.version, 1);
    const duplicate = await identityService.putProfile({
      identity: owner, body: profileBody(), idempotencyKey: "smart-profile-0001", expectedVersion: null
    });
    assert.equal(duplicate.replayed, true);
    assert.equal((await database.query("SELECT count(*)::integer AS total FROM radar_team_profiles")).rows[0].total, 1);
  } finally { await database.close(); }
});

test("WhatsApp is normalized, encrypted with versioned keys and can rotate without plaintext storage", () => {
  assert.equal(normalizeWhatsapp("(47) 99999-9999"), "+5547999999999");
  assert.equal(normalizeWhatsapp("+351 912 345 678"), "+351912345678");
  assert.throws(() => normalizeWhatsapp("123"), error => error.code === "VALIDATION_ERROR");
  const encrypted = encryptWhatsapp("+5547999999999", config({ RADAR_WHATSAPP_ACTIVE_KEY_VERSION: "v1" }));
  assert.equal(encrypted.keyVersion, "v1");
  assert.equal(encrypted.ciphertext.includes("5547999999999"), false);
  assert.equal(decryptWhatsapp(encrypted.ciphertext, encrypted.keyVersion, config()), "+5547999999999");
});

test("WhatsApp is released only on protected click and disappears after bilateral block", async () => {
  const database = new PGlite();
  const pool = poolFor(database);
  const owner = identity("owner");
  const target = identity("target");
  try {
    await migrate({ pool });
    const service = createRadarIdentityService({ repository: createRadarIdentityRepository({ pool }), config: config() });
    const own = await service.putProfile({ identity: owner, body: profileBody(), idempotencyKey: "whatsapp-owner-1", expectedVersion: null });
    const other = await service.putProfile({
      identity: target,
      body: profileBody({ instagram_handle: "smart.target", whatsapp: "(47) 99999-9999", whatsapp_visible: true }),
      idempotencyKey: "whatsapp-target-1", expectedVersion: null
    });
    await database.query(`UPDATE radar_team_profiles
      SET instagram_verification_status = 'verified', status = 'active', availability_active = true
      WHERE public_id IN ($1, $2)`, [own.profile.public_id, other.profile.public_id]);
    const stored = (await database.query("SELECT whatsapp_ciphertext, whatsapp_key_version, whatsapp_visible FROM radar_team_profiles WHERE public_id = $1", [other.profile.public_id])).rows[0];
    assert.equal(stored.whatsapp_visible, true);
    assert.equal(stored.whatsapp_ciphertext.includes("5547999999999"), false);

    const app = express();
    app.use("/radar/times", createRadarWhatsappRouter({
      config: config(), pool,
      auth(req, res, next) { req.user = { id: "authenticated" }; next(); },
      async resolveIdentity() { return owner; },
      logger: { error() { throw new Error("unexpected log"); } }
    }));
    const released = await http(app, `/radar/times/${other.profile.public_id}/whatsapp`);
    assert.equal(released.status, 200);
    assert.equal(released.headers.get("cache-control"), "private, no-store");
    assert.equal(released.body.whatsapp_url, "https://wa.me/5547999999999");
    const audit = (await database.query("SELECT payload::text AS payload FROM match_audit_events WHERE event_type = 'radar_whatsapp.released' ORDER BY id DESC LIMIT 1")).rows[0].payload;
    assert.equal(audit.includes("5547999999999"), false);

    const ids = (await database.query("SELECT id, public_id FROM radar_team_profiles WHERE public_id IN ($1, $2)", [own.profile.public_id, other.profile.public_id])).rows;
    const ownId = ids.find(row => row.public_id === own.profile.public_id).id;
    const targetId = ids.find(row => row.public_id === other.profile.public_id).id;
    await database.query("INSERT INTO team_blocks(blocker_team_id, blocked_team_id) VALUES ($1, $2)", [targetId, ownId]);
    const blocked = await http(app, `/radar/times/${other.profile.public_id}/whatsapp`);
    assert.equal(blocked.status, 404);
  } finally { await database.close(); }
});
