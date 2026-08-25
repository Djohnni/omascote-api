"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");
const { PGlite } = require("@electric-sql/pglite");
const { migrate } = require("./src/db/migrate");
const { createRadarConfig } = require("./src/config/radar");
const { RadarIdentityError } = require("./src/friendlies/radar-identity.errors");
const {
  createProfilePrintImportRepository
} = require("./src/friendlies/profile-print-import.repository");
const {
  createProfilePrintImportService
} = require("./src/friendlies/profile-print-import.service");
const {
  ProfilePrintProviderError
} = require("./src/friendlies/profile-print-import.openai");
const {
  createRadarIdentityRepository
} = require("./src/friendlies/radar-identity.repository");
const {
  createRadarIdentityService
} = require("./src/friendlies/radar-identity.service");

const SECURITY_SECRET = "database-profile-print-security-secret-2026";
const SAFETY_SECRET = "database-profile-print-safety-secret-2026";

function normalizeResult(result) {
  const lastResult = Array.isArray(result) ? result[result.length - 1] : result;
  if (!lastResult) return { rows: [], rowCount: 0 };
  return {
    ...lastResult,
    rowCount: lastResult.rows?.length || lastResult.affectedRows || 0
  };
}

function createPoolAdapter(database) {
  const client = {
    async query(sql, params) {
      if (params) return normalizeResult(await database.query(sql, params));
      return normalizeResult(await database.exec(sql));
    },
    release() {}
  };
  return {
    connect: async () => client,
    query: (sql, params) => client.query(sql, params)
  };
}

function identity(suffix = "owner") {
  return Object.freeze({
    authSubject: `auth-${suffix}`,
    accountId: `account-${suffix}`,
    profileId: `profile-${suffix}`,
    legacyProfile: Object.freeze({
      perfil_id: `profile-${suffix}`,
      slug: `${suffix}-fc`,
      nome_time: `${suffix} FC`,
      publico: true,
      escudo_url: `/escudos/${suffix}.png`
    })
  });
}

function config(overrides = {}) {
  return createRadarConfig({
    RADAR_AMISTOSOS_ENABLED: "true",
    RADAR_INSTAGRAM_VERIFICATION_SECRET: "database-instagram-secret-2026-xx",
    RADAR_PROFILE_PRINT_IMPORT_ENABLED: "true",
    RADAR_PROFILE_PRINT_SECURITY_SECRET: SECURITY_SECRET,
    RADAR_PROFILE_PRINT_SAFETY_IDENTIFIER_SECRET: SAFETY_SECRET,
    RADAR_PROFILE_PRINT_OPENAI_MODEL: "gpt-5.6-sol",
    OPENAI_API_KEY: "sk-database-test-not-real-2026",
    RADAR_PROFILE_PRINT_ACCOUNT_LIMIT: "100",
    RADAR_PROFILE_PRINT_TEAM_LIMIT: "100",
    RADAR_PROFILE_PRINT_IP_LIMIT: "200",
    ...overrides
  });
}

function sampleDraft() {
  return {
    schema_version: "1.0",
    suggestions: {
      team_name: { value: "Owner FC", confidence: 0.95, evidence: "Nome no cabecalho" },
      city_name: { value: "Joinville", confidence: 0.9, evidence: "Cidade na descricao" },
      state_code: { value: "SC", confidence: 0.9, evidence: "UF ao lado da cidade" },
      instagram_handle: { value: "owner.fc", confidence: 0.98, evidence: "Usuario no topo" },
      modalities: { value: ["society"], confidence: 0.8, evidence: "Modalidade informada" },
      categories: { value: ["Livre"], confidence: 0.75, evidence: "Categoria informada" }
    },
    warnings: ["Revise todas as sugestoes antes de salvar"]
  };
}

function image(hashCharacter = "a", content = "private-image-content") {
  return Object.freeze({
    buffer: Buffer.from(content),
    byteHash: hashCharacter.repeat(64),
    format: "png",
    mimeType: "image/png",
    width: 1080,
    height: 1920,
    originalSizeBytes: 1000,
    sanitizedSizeBytes: 800
  });
}

async function insertTeam(database, owner, overrides = {}) {
  await database.query(`
    INSERT INTO radar_team_profiles(
      legacy_profile_id, account_reference, public_slug, status,
      instagram_handle, instagram_verification_status,
      city_ibge_code, city_name, state_code, modalities, categories,
      declared_level, radar_terms_accepted_at
    ) VALUES ($1, $2, $3, $4, $5, 'unverified',
      '4209102', 'Joinville', 'SC', ARRAY['society'], ARRAY['Livre'],
      'intermediario', now())
  `, [
    owner.profileId,
    owner.accountId,
    `${owner.profileId}-slug`,
    overrides.status || "pending_verification",
    overrides.instagramHandle || "owner.fc"
  ]);
}

function importArguments(owner, upload, key) {
  return {
    identity: owner,
    fields: { instagram_handle: "owner.fc" },
    image: upload,
    idempotencyKey: key,
    requestId: "database-profile-print-request",
    requestContext: { ip: "127.0.0.1" }
  };
}

test("profile print import is owned, draft-only, idempotent, deduplicated and migration-safe", async () => {
  const database = new PGlite();
  const pool = createPoolAdapter(database);
  const owner = identity();
  let providerCalls = 0;
  let lastSafetyIdentifier = null;
  const provider = {
    async analyze({ safetyIdentifier }) {
      providerCalls += 1;
      lastSafetyIdentifier = safetyIdentifier;
      return sampleDraft();
    }
  };
  try {
    assert.deepEqual(await migrate({ pool }), [
      "001_radar_amistosos_foundation.sql",
      "002_result_confirmation_match_integrity.sql",
      "003_radar_identity_authorization.sql",
      "004_instagram_verification_review.sql",
      "005_profile_print_import.sql",
      "006_friendly_availability_management.sql",
      "007_friendly_team_discovery.sql",
      "008_friendly_invitations_notifications.sql",
      "009_match_center.sql",
      "010_confirmed_match_results.sql",
      "011_match_history.sql",
      "012_team_reviews_reputation.sql",
      "013_radar_safety_privacy_moderation.sql",
      "014_radar_smart_onboarding.sql"
    ]);
    assert.deepEqual(await migrate({ pool }), []);
    await insertTeam(database, owner);
    const before = (await database.query(
      "SELECT * FROM radar_team_profiles WHERE legacy_profile_id = $1",
      [owner.profileId]
    )).rows[0];

    const repository = createProfilePrintImportRepository({ pool });
    const service = createProfilePrintImportService({ repository, provider, config: config() });
    const first = await service.importProfilePrint(
      importArguments(owner, image("a"), "database-print-first-0001")
    );
    assert.equal(first.import.status, "draft_ready");
    assert.equal(first.import.model, "gpt-5.6-sol");
    assert.equal(first.profile_unchanged, true);
    assert.equal(first.replayed, false);
    assert.equal(first.deduplicated, false);
    assert.equal(providerCalls, 1);
    assert.match(lastSafetyIdentifier, /^rpp_[A-Za-z0-9_-]{43}$/);
    assert.equal(lastSafetyIdentifier.includes(owner.accountId), false);
    assert.equal(lastSafetyIdentifier.includes(owner.authSubject), false);
    assert.equal(JSON.stringify(first).includes(lastSafetyIdentifier), false);

    const after = (await database.query(
      "SELECT * FROM radar_team_profiles WHERE legacy_profile_id = $1",
      [owner.profileId]
    )).rows[0];
    assert.deepEqual(after, before);

    const stored = (await database.query(`
      SELECT method, status, evidence_hash, ai_draft, ai_model,
             requested_by_account_reference, operation_metadata
      FROM team_verifications WHERE public_id = $1
    `, [first.import.import_id])).rows[0];
    assert.equal(stored.method, "profile_print_import");
    assert.equal(stored.status, "pending");
    assert.equal(stored.evidence_hash, "a".repeat(64));
    assert.deepEqual(stored.ai_draft, sampleDraft());
    assert.equal(stored.ai_model, "gpt-5.6-sol");
    assert.equal(stored.requested_by_account_reference, owner.accountId);
    assert.deepEqual(stored.operation_metadata, {
      format: "png",
      width: 1080,
      height: 1920,
      original_size_bytes: 1000,
      sanitized_size_bytes: 800
    });

    const replay = await service.importProfilePrint(
      importArguments(owner, image("a"), "database-print-first-0001")
    );
    assert.equal(replay.replayed, true);
    assert.equal(replay.import.import_id, first.import.import_id);
    assert.equal(providerCalls, 1);

    const duplicate = await service.importProfilePrint(
      importArguments(owner, image("a"), "database-print-duplicate-0001")
    );
    assert.equal(duplicate.deduplicated, true);
    assert.equal(duplicate.import.import_id, first.import.import_id);
    assert.equal(providerCalls, 1);

    await assert.rejects(
      service.importProfilePrint(
        importArguments(owner, image("b", "different-private-image"), "database-print-first-0001")
      ),
      error => error.code === "IDEMPOTENCY_KEY_REUSED"
    );
    await assert.rejects(
      service.importProfilePrint({
        ...importArguments(owner, image("c"), "database-print-id-attack-0001"),
        fields: { team_id: "attacker-selected-team" }
      }),
      error => error.code === "VALIDATION_ERROR"
    );
    await assert.rejects(
      service.importProfilePrint(
        importArguments({ ...owner, accountId: "third-party-account" }, image("d"), "third-print-0001")
      ),
      error => error.code === "RADAR_PROFILE_FORBIDDEN"
    );

    const storedText = JSON.stringify((await database.query(`
      SELECT
        (SELECT json_agg(v) FROM team_verifications v) AS verifications,
        (SELECT json_agg(r) FROM radar_profile_print_import_requests r) AS requests,
        (SELECT json_agg(a) FROM match_audit_events a) AS audits
    `)).rows[0]);
    assert.equal(storedText.includes("private-image-content"), false);
    assert.equal(storedText.includes(Buffer.from("private-image-content").toString("base64")), false);
    assert.equal(storedText.includes("sk-database-test-not-real-2026"), false);
    assert.equal(storedText.includes(lastSafetyIdentifier), false);
    assert.equal(storedText.includes("resp_"), false);
    assert.equal(storedText.includes("C:\\"), false);

    const scopes = (await database.query(`
      SELECT DISTINCT scope_type FROM radar_profile_print_rate_limits ORDER BY scope_type
    `)).rows.map(row => row.scope_type);
    assert.deepEqual(scopes, ["account", "global", "ip", "team"]);
    await assert.rejects(
      database.query("UPDATE match_audit_events SET payload = '{}'"),
      error => /append-only/.test(error.message)
    );
    await assert.rejects(
      database.query("UPDATE radar_profile_print_import_requests SET evidence_hash = $1", ["f".repeat(64)]),
      error => /immutable/.test(error.message)
    );

    const identityService = createRadarIdentityService({
      repository: createRadarIdentityRepository({ pool }),
      config: config()
    });
    await assert.rejects(
      identityService.putProfile({
        identity: owner,
        body: { city_name: "<script>automatic save</script>" },
        idempotencyKey: "manual-save-validation-0001",
        expectedVersion: String(after.version)
      }),
      error => error.code === "VALIDATION_ERROR"
    );
  } finally {
    await database.close();
  }
});

test("concurrent imports allow one provider call and suspended teams are blocked", async () => {
  const database = new PGlite();
  const pool = createPoolAdapter(database);
  const owner = identity("concurrent");
  let providerCalls = 0;
  let releaseProvider;
  let providerStarted;
  const started = new Promise(resolve => { providerStarted = resolve; });
  const provider = {
    async analyze() {
      providerCalls += 1;
      providerStarted();
      await new Promise(resolve => { releaseProvider = resolve; });
      return sampleDraft();
    }
  };
  try {
    await migrate({ pool });
    await insertTeam(database, owner);
    const repository = createProfilePrintImportRepository({ pool });
    const service = createProfilePrintImportService({
      repository,
      provider,
      config: config()
    });
    const first = service.importProfilePrint({
      ...importArguments(owner, image("1"), "concurrent-print-first-0001"),
      fields: { instagram_handle: "owner.fc" }
    });
    await started;
    await assert.rejects(
      service.importProfilePrint({
        ...importArguments(owner, image("2"), "concurrent-print-second-0001"),
        fields: { instagram_handle: "owner.fc" }
      }),
      error => error.code === "PROFILE_PRINT_IMPORT_IN_PROGRESS"
    );
    releaseProvider();
    assert.equal((await first).import.status, "draft_ready");
    assert.equal(providerCalls, 1);

    await database.query(`
      UPDATE radar_team_profiles SET status = 'suspended', suspended_at = now()
      WHERE legacy_profile_id = $1
    `, [owner.profileId]);
    await assert.rejects(
      service.importProfilePrint({
        ...importArguments(owner, image("3"), "suspended-print-0001"),
        fields: { instagram_handle: "owner.fc" }
      }),
      error => error.code === "RADAR_PROFILE_SUSPENDED"
    );
    assert.equal(providerCalls, 1);
  } finally {
    releaseProvider?.();
    await database.close();
  }
});

test("provider failures are persisted safely and persistent limits stop repeated imports", async () => {
  const database = new PGlite();
  const pool = createPoolAdapter(database);
  const owner = identity("failure");
  let providerCalls = 0;
  const provider = {
    async analyze() {
      providerCalls += 1;
      throw new ProfilePrintProviderError("timeout");
    }
  };
  try {
    await migrate({ pool });
    await insertTeam(database, owner);
    const repository = createProfilePrintImportRepository({ pool });
    const service = createProfilePrintImportService({
      repository,
      provider,
      config: config({
        RADAR_PROFILE_PRINT_DAILY_TEAM_LIMIT: "1",
        RADAR_PROFILE_PRINT_IP_LIMIT: "10"
      })
    });
    await assert.rejects(
      service.importProfilePrint({
        ...importArguments(owner, image("e"), "failure-print-0001"),
        fields: { instagram_handle: "owner.fc" }
      }),
      error => error.code === "PROFILE_PRINT_AI_TIMEOUT" &&
        !error.message.includes("provider")
    );
    const failed = (await database.query(`
      SELECT v.status, v.decision_details, r.state, r.failure_code
      FROM team_verifications v
      JOIN radar_profile_print_import_requests r ON r.verification_id = v.id
    `)).rows[0];
    assert.equal(failed.status, "cancelled");
    assert.equal(failed.state, "failed");
    assert.equal(failed.failure_code, "timeout");
    assert.equal(failed.decision_details.reason_code, "timeout");
    await assert.rejects(
      service.importProfilePrint({
        ...importArguments(owner, image("f"), "failure-print-0002"),
        fields: { instagram_handle: "owner.fc" }
      }),
      error => error.code === "PROFILE_PRINT_RATE_LIMITED"
    );
    assert.equal(providerCalls, 1);
  } finally {
    await database.close();
  }
});

test("expired drafts are erased while their nonsensitive history remains auditable", async () => {
  const database = new PGlite();
  const pool = createPoolAdapter(database);
  const owner = identity("expiry");
  let currentTime = new Date("2026-08-24T12:00:00.000Z");
  const provider = { async analyze() { return sampleDraft(); } };
  try {
    await migrate({ pool });
    await insertTeam(database, owner);
    const repository = createProfilePrintImportRepository({ pool });
    const service = createProfilePrintImportService({
      repository,
      provider,
      config: config({ RADAR_PROFILE_PRINT_DRAFT_TTL_MINUTES: "1" }),
      now: () => new Date(currentTime)
    });
    await service.importProfilePrint({
      ...importArguments(owner, image("9"), "expiry-print-0001"),
      fields: { instagram_handle: "owner.fc" }
    });
    currentTime = new Date("2026-08-24T12:02:00.000Z");
    assert.deepEqual(await repository.expireStale({ now: new Date(currentTime) }), { expired: 1 });
    assert.deepEqual(await repository.expireStale({ now: new Date(currentTime) }), { expired: 0 });
    await assert.rejects(
      service.importProfilePrint({
        ...importArguments(owner, image("9"), "expiry-print-0001"),
        fields: { instagram_handle: "owner.fc" }
      }),
      error => error.code === "PROFILE_PRINT_DRAFT_EXPIRED" && error.status === 410
    );
    const expired = (await database.query(`
      SELECT status, ai_draft, ai_completed_at, decision_details
      FROM team_verifications WHERE method = 'profile_print_import'
    `)).rows[0];
    assert.equal(expired.status, "expired");
    assert.equal(expired.ai_draft, null);
    assert.ok(expired.ai_completed_at);
    assert.equal(expired.decision_details.reason_code, "retention_expired");
    const audit = await database.query(`
      SELECT 1 FROM match_audit_events WHERE event_type = 'profile_print_import.expired'
    `);
    assert.equal(audit.rows.length, 1);
  } finally {
    await database.close();
  }
});
