"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");
const { PGlite } = require("@electric-sql/pglite");
const { migrate } = require("./src/db/migrate");
const { checkDatabase } = require("./src/db/pool");
const { createRadarIdentityRepository } = require("./src/friendlies/radar-identity.repository");
const { createRadarIdentityService } = require("./src/friendlies/radar-identity.service");
const { createRadarConfig } = require("./src/config/radar");

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

test("clean PostgreSQL schema migrates idempotently and rejects cross-match confirmation", async () => {
  const database = new PGlite();
  const pool = createPoolAdapter(database);

  try {
    assert.deepEqual(await migrate({ pool }), [
      "001_radar_amistosos_foundation.sql",
      "002_result_confirmation_match_integrity.sql",
      "003_radar_identity_authorization.sql"
    ]);
    assert.deepEqual(await migrate({ pool }), []);
    assert.deepEqual(await checkDatabase(pool), { ok: true });

    const teamA = (await database.query(
      "INSERT INTO radar_team_profiles(legacy_profile_id) VALUES ('db-test-a') RETURNING id"
    )).rows[0].id;
    const teamB = (await database.query(
      "INSERT INTO radar_team_profiles(legacy_profile_id) VALUES ('db-test-b') RETURNING id"
    )).rows[0].id;

    const invitationOne = (await database.query(`
      INSERT INTO friendly_invitations(
        requester_team_id, invited_team_id, state, proposal, proposal_hash,
        idempotency_key, idempotency_payload_hash, expires_at
      ) VALUES ($1, $2, 'accepted', '{}', $3, 'db-invite-1', $4, now() + interval '1 hour')
      RETURNING id
    `, [teamA, teamB, "a".repeat(64), "b".repeat(64)])).rows[0].id;

    const invitationTwo = (await database.query(`
      INSERT INTO friendly_invitations(
        requester_team_id, invited_team_id, state, proposal, proposal_hash,
        idempotency_key, idempotency_payload_hash, expires_at
      ) VALUES ($1, $2, 'accepted', '{}', $3, 'db-invite-2', $4, now() + interval '1 hour')
      RETURNING id
    `, [teamA, teamB, "c".repeat(64), "d".repeat(64)])).rows[0].id;

    const matchOne = (await database.query(`
      INSERT INTO friendly_matches(
        invitation_id, team_a_id, team_b_id, team_a_snapshot, team_b_snapshot, scheduled_at
      ) VALUES ($1, $2, $3, '{}', '{}', now()) RETURNING id
    `, [invitationOne, teamA, teamB])).rows[0].id;

    const matchTwo = (await database.query(`
      INSERT INTO friendly_matches(
        invitation_id, team_a_id, team_b_id, team_a_snapshot, team_b_snapshot, scheduled_at
      ) VALUES ($1, $2, $3, '{}', '{}', now()) RETURNING id
    `, [invitationTwo, teamA, teamB])).rows[0].id;

    const submissionHash = "e".repeat(64);
    const submission = (await database.query(`
      INSERT INTO match_result_submissions(
        match_id, submitting_team_id, team_a_goals, team_b_goals, version, submission_hash
      ) VALUES ($1, $2, 2, 1, 1, $3) RETURNING id
    `, [matchOne, teamA, submissionHash])).rows[0].id;

    await assert.rejects(
      database.query(`
        INSERT INTO match_result_confirmations(
          match_id, confirming_team_id, submission_id, submission_version, submission_hash
        ) VALUES ($1, $2, $3, 1, $4)
      `, [matchTwo, teamB, submission, submissionHash]),
      error => error.code === "23503"
    );

    await assert.doesNotReject(database.query(`
      INSERT INTO match_result_confirmations(
        match_id, confirming_team_id, submission_id, submission_version, submission_hash
      ) VALUES ($1, $2, $3, 1, $4)
    `, [matchOne, teamB, submission, submissionHash]));
  } finally {
    await database.close();
  }
});

test("identity profile mutation is owned, versioned, idempotent and audited", async () => {
  const database = new PGlite();
  const pool = createPoolAdapter(database);
  const identity = Object.freeze({
    authSubject: "5511999999999",
    accountId: "account-database-1",
    profileId: "legacy-profile-database-1",
    legacyProfile: Object.freeze({
      perfil_id: "legacy-profile-database-1",
      slug: "database-fc",
      nome_time: "Database FC",
      publico: true,
      escudo_url: "/escudos/database-fc.png"
    })
  });

  try {
    await migrate({ pool });
    const repository = createRadarIdentityRepository({ pool });
    const service = createRadarIdentityService({
      repository,
      config: createRadarConfig({
        RADAR_AMISTOSOS_ENABLED: "true",
        RADAR_PILOT_CITY_IBGE_CODE: "4209102"
      }),
      now: () => new Date("2026-08-24T12:00:00.000Z")
    });
    const body = {
      city_ibge_code: "4209102",
      city_name: "Joinville",
      state_code: "SC",
      instagram_handle: "database.fc",
      modalities: ["society"],
      categories: ["Livre"],
      declared_level: "intermediario",
      travel_radius_km: 35,
      venue_preference: "either",
      accept_terms: true
    };

    const created = await service.putProfile({
      identity,
      body,
      idempotencyKey: "database-create-0001",
      expectedVersion: null,
      requestId: "database-request-1"
    });
    assert.equal(created.profile.version, 1);
    assert.equal(created.profile.status, "pending_verification");
    assert.equal(created.profile.terms_accepted, true);
    assert.equal(created.eligibility.instagram_verified, false);
    assert.match(created.profile.public_id, /^[0-9a-f-]{36}$/i);
    assert.equal(Object.hasOwn(created.profile, "account_reference"), false);

    const persisted = (await database.query(`
      SELECT account_reference, legacy_profile_id, version, status
      FROM radar_team_profiles
      WHERE legacy_profile_id = $1
    `, [identity.profileId])).rows[0];
    assert.equal(persisted.account_reference, identity.accountId);
    assert.equal(persisted.legacy_profile_id, identity.profileId);
    assert.equal(persisted.version, 1);
    assert.equal(persisted.status, "pending_verification");

    const replay = await service.putProfile({
      identity,
      body,
      idempotencyKey: "database-create-0001"
    });
    assert.equal(replay.replayed, true);
    assert.equal(replay.profile.version, 1);

    await assert.rejects(
      service.putProfile({
        identity,
        body: { ...body, city_name: "Florianopolis" },
        idempotencyKey: "database-create-0001"
      }),
      error => error.code === "IDEMPOTENCY_KEY_REUSED"
    );
    await assert.rejects(
      service.putProfile({
        identity,
        body: { travel_radius_km: 40 },
        idempotencyKey: "database-update-0001"
      }),
      error => error.code === "PROFILE_VERSION_REQUIRED" && error.status === 428
    );
    await assert.rejects(
      service.putProfile({
        identity,
        body: { travel_radius_km: 40 },
        idempotencyKey: "database-update-0002",
        expectedVersion: "99"
      }),
      error => error.code === "PROFILE_VERSION_CONFLICT"
    );

    await database.query(`
      UPDATE radar_team_profiles
      SET instagram_verification_status = 'verified'
      WHERE legacy_profile_id = $1
    `, [identity.profileId]);
    const activated = await service.putProfile({
      identity,
      body: { availability_active: true },
      idempotencyKey: "database-activate-0001",
      expectedVersion: 'W/"1"',
      requestId: "database-request-2"
    });
    assert.equal(activated.profile.version, 2);
    assert.equal(activated.profile.status, "active");
    assert.equal(activated.profile.availability_active, true);
    assert.equal(activated.eligibility.discoverable, true);

    const handleChanged = await service.putProfile({
      identity,
      body: { instagram_handle: "database.novo" },
      idempotencyKey: "database-instagram-0001",
      expectedVersion: "2"
    });
    assert.equal(handleChanged.profile.version, 3);
    assert.equal(handleChanged.profile.instagram_verification_status, "unverified");
    assert.equal(handleChanged.profile.availability_active, false);
    assert.equal(handleChanged.profile.status, "pending_verification");

    await assert.rejects(
      service.getProfile({ ...identity, accountId: "another-account" }),
      error => error.code === "RADAR_PROFILE_FORBIDDEN"
    );

    await database.query(`
      UPDATE radar_team_profiles
      SET status = 'suspended', suspended_at = now()
      WHERE legacy_profile_id = $1
    `, [identity.profileId]);
    await assert.rejects(
      service.putProfile({
        identity,
        body: { travel_radius_km: 45 },
        idempotencyKey: "database-suspended-0001",
        expectedVersion: "3"
      }),
      error => error.code === "RADAR_PROFILE_SUSPENDED"
    );

    const counts = (await database.query(`
      SELECT
        (SELECT count(*)::integer FROM radar_profile_mutation_requests) AS mutations,
        (SELECT count(*)::integer FROM match_audit_events) AS audits
    `)).rows[0];
    assert.equal(counts.mutations, 3);
    assert.equal(counts.audits, 3);

    const privateAudit = await database.query(`
      SELECT 1
      FROM match_audit_events
      WHERE payload::text LIKE '%5511999999999%'
    `);
    assert.equal(privateAudit.rows.length, 0);

    await assert.rejects(
      database.query("UPDATE radar_profile_mutation_requests SET resulting_version = 99"),
      error => /append-only/.test(error.message)
    );

    await database.query(`
      INSERT INTO radar_team_profiles(legacy_profile_id, account_reference)
      VALUES ('another-profile', NULL)
    `);
    await assert.rejects(
      database.query(`
        UPDATE radar_team_profiles
        SET account_reference = $1
        WHERE legacy_profile_id = 'another-profile'
      `, [identity.accountId]),
      error => error.code === "23505"
    );
  } finally {
    await database.close();
  }
});
