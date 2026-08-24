"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");
const { PGlite } = require("@electric-sql/pglite");
const { migrate } = require("./src/db/migrate");
const { createRadarConfig } = require("./src/config/radar");
const {
  createInstagramVerificationRepository
} = require("./src/friendlies/instagram-verification.repository");
const {
  createInstagramVerificationService
} = require("./src/friendlies/instagram-verification.service");
const {
  createRadarIdentityRepository
} = require("./src/friendlies/radar-identity.repository");
const { createRadarIdentityService } = require("./src/friendlies/radar-identity.service");

const TEST_SECRET = "database-test-instagram-verification-secret-2026";

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

function ownerIdentity(overrides = {}) {
  return Object.freeze({
    authSubject: "5511999999999",
    accountId: "account-owner-db",
    profileId: "profile-owner-db",
    legacyProfile: Object.freeze({
      perfil_id: "profile-owner-db",
      slug: "owner-db-fc",
      nome_time: "Owner DB FC",
      publico: true,
      escudo_url: "/escudos/owner-db.png"
    }),
    ...overrides
  });
}

function reconstructCode(response) {
  return response.challenge.segments.join(response.challenge.separator);
}

test("Instagram verification lifecycle is private, reviewed, bounded and migration-safe", async () => {
  const database = new PGlite();
  const pool = createPoolAdapter(database);
  let currentTime = new Date("2026-08-24T12:00:00.000Z");
  const config = createRadarConfig({
    RADAR_AMISTOSOS_ENABLED: "true",
    RADAR_INSTAGRAM_VERIFICATION_SECRET: TEST_SECRET,
    RADAR_INSTAGRAM_INITIATE_ACCOUNT_LIMIT: "50",
    RADAR_INSTAGRAM_INITIATE_TEAM_LIMIT: "50",
    RADAR_INSTAGRAM_INITIATE_IP_LIMIT: "100",
    RADAR_INSTAGRAM_CONFIRM_ACCOUNT_LIMIT: "100",
    RADAR_INSTAGRAM_CONFIRM_TEAM_LIMIT: "100",
    RADAR_INSTAGRAM_CONFIRM_IP_LIMIT: "200"
  });
  const identity = ownerIdentity();
  const adminIdentity = ownerIdentity({
    authSubject: "5511888888888",
    accountId: "account-reviewer-db",
    profileId: "profile-reviewer-db",
    legacyProfile: Object.freeze({ perfil_id: "profile-reviewer-db", nome_time: "Reviewer" })
  });

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
      "009_match_center.sql"
    ]);
    assert.deepEqual(await migrate({ pool }), []);

    await database.query(`
      INSERT INTO radar_team_profiles(
        legacy_profile_id, account_reference, public_slug, status,
        instagram_handle, instagram_verification_status,
        city_ibge_code, city_name, state_code, modalities, categories,
        declared_level, radar_terms_accepted_at
      ) VALUES (
        $1, $2, 'owner-db-fc', 'paused',
        'owner.db', 'unverified',
        '4209102', 'Joinville', 'SC', ARRAY['society'], ARRAY['Livre'],
        'intermediario', now()
      )
    `, [identity.profileId, identity.accountId]);

    const repository = createInstagramVerificationRepository({ pool });
    const service = createInstagramVerificationService({
      repository,
      config,
      now: () => new Date(currentTime)
    });
    const mutationContext = {
      identity,
      body: { instagram_handle: "owner.db" },
      requestContext: { ip: "127.0.0.1" }
    };

    await assert.rejects(
      service.getOwnerVerification({ ...identity, accountId: "third-party-account" }),
      error => error.code === "RADAR_PROFILE_FORBIDDEN"
    );

    const first = await service.initiate({
      ...mutationContext,
      idempotencyKey: "db-initiate-first-0001",
      requestId: "db-request-first"
    });
    const firstCode = reconstructCode(first);
    assert.equal(first.verification.status, "challenge_issued");
    assert.equal(JSON.stringify(first).includes(firstCode), false);

    const replayed = await service.initiate({
      ...mutationContext,
      idempotencyKey: "db-initiate-first-0001",
      requestId: "db-request-first-replay"
    });
    assert.equal(replayed.replayed, true);
    assert.equal(replayed.verification.verification_id, first.verification.verification_id);
    assert.equal(reconstructCode(replayed), firstCode);

    const firstRow = (await database.query(`
      SELECT id, challenge_hash FROM team_verifications WHERE public_id = $1
    `, [first.verification.verification_id])).rows[0];
    assert.match(firstRow.challenge_hash, /^[0-9a-f]{64}$/);
    assert.notEqual(firstRow.challenge_hash, firstCode);

    await assert.rejects(
      database.query(`
        INSERT INTO team_verifications(
          team_id, method, status, challenge_hash, challenge_expires_at,
          instagram_handle_snapshot, requested_by_account_reference
        ) SELECT team_id, 'instagram_bio_code', 'pending', $2, now() + interval '20 minutes',
                 'owner.db', $3
          FROM team_verifications WHERE id = $1
      `, [firstRow.id, "a".repeat(64), identity.accountId]),
      error => error.code === "23505"
    );

    const second = await service.initiate({
      ...mutationContext,
      idempotencyKey: "db-initiate-second-0001"
    });
    const secondCode = reconstructCode(second);
    assert.notEqual(second.verification.verification_id, first.verification.verification_id);
    assert.notEqual(secondCode, firstCode);
    const firstStatus = (await database.query(
      "SELECT status FROM team_verifications WHERE public_id = $1",
      [first.verification.verification_id]
    )).rows[0].status;
    assert.equal(firstStatus, "cancelled");

    const wrongConfirmation = {
      identity,
      body: {
        verification_id: second.verification.verification_id,
        code: "MCFC-AAAA-AAAA"
      },
      idempotencyKey: "db-confirm-wrong-0001",
      requestContext: { ip: "127.0.0.1" }
    };
    await assert.rejects(
      service.confirm(wrongConfirmation),
      error => error.code === "INVALID_VERIFICATION_CODE" && error.details.attempts_remaining === 4
    );
    await assert.rejects(
      service.confirm(wrongConfirmation),
      error => error.code === "INVALID_VERIFICATION_CODE"
    );
    assert.equal((await database.query(
      "SELECT attempt_count FROM team_verifications WHERE public_id = $1",
      [second.verification.verification_id]
    )).rows[0].attempt_count, 1);

    const confirmed = await service.confirm({
      identity,
      body: {
        verification_id: second.verification.verification_id,
        code: secondCode
      },
      idempotencyKey: "db-confirm-correct-0001",
      requestId: "db-confirm-request",
      requestContext: { ip: "127.0.0.1" }
    });
    assert.equal(confirmed.verification.status, "pending_review");
    assert.equal((await service.getOwnerVerification(identity)).instagram_verification_status, "pending");

    await assert.rejects(
      service.listPendingReviews(adminIdentity),
      error => error.code === "VERIFICATION_REVIEW_FORBIDDEN"
    );
    await database.query(`
      INSERT INTO radar_account_roles(
        account_reference, role, granted_by_account_reference
      ) VALUES ($1, 'verification_reviewer', 'bootstrap-database-test')
    `, [identity.accountId]);
    await assert.rejects(
      service.approve({
        adminIdentity: identity,
        verificationId: second.verification.verification_id,
        body: { observed_code: secondCode },
        idempotencyKey: "db-self-approve-0001"
      }),
      error => error.code === "VERIFICATION_SELF_REVIEW_FORBIDDEN"
    );

    await database.query(`
      INSERT INTO radar_account_roles(
        account_reference, role, granted_by_account_reference
      ) VALUES ($1, 'verification_reviewer', 'bootstrap-database-test')
    `, [adminIdentity.accountId]);
    const queue = await service.listPendingReviews(adminIdentity);
    assert.equal(queue.items.length, 1);
    assert.equal(queue.items[0].verification_id, second.verification.verification_id);
    assert.equal(Object.hasOwn(queue.items[0], "requested_by_account_reference"), false);

    await assert.rejects(
      service.approve({
        adminIdentity,
        verificationId: second.verification.verification_id,
        body: { observed_code: "MCFC-BBBB-BBBB" },
        idempotencyKey: "db-admin-wrong-code-0001"
      }),
      error => error.code === "OBSERVED_CODE_MISMATCH"
    );
    const approved = await service.approve({
      adminIdentity,
      verificationId: second.verification.verification_id,
      body: { observed_code: secondCode },
      idempotencyKey: "db-admin-approve-0001",
      requestId: "db-admin-request"
    });
    assert.equal(approved.decision, "approved");
    const approvedReplay = await service.approve({
      adminIdentity,
      verificationId: second.verification.verification_id,
      body: { observed_code: secondCode },
      idempotencyKey: "db-admin-approve-0001",
      requestId: "db-admin-request-replay"
    });
    assert.equal(approvedReplay.replayed, true);
    const approvedState = (await database.query(`
      SELECT v.status, v.human_decision_by, t.instagram_verification_status,
             t.availability_active
      FROM team_verifications v
      JOIN radar_team_profiles t ON t.id = v.team_id
      WHERE v.public_id = $1
    `, [second.verification.verification_id])).rows[0];
    assert.equal(approvedState.status, "verified");
    assert.equal(approvedState.human_decision_by, adminIdentity.accountId);
    assert.equal(approvedState.instagram_verification_status, "verified");
    assert.equal(approvedState.availability_active, false);

    await assert.rejects(
      database.query(
        "UPDATE team_verifications SET status = 'rejected' WHERE public_id = $1",
        [second.verification.verification_id]
      ),
      error => /terminal team verification is immutable/.test(error.message)
    );
    await assert.rejects(
      database.query("DELETE FROM team_verifications WHERE public_id = $1", [
        second.verification.verification_id
      ]),
      error => /team verification history cannot be deleted/.test(error.message)
    );

    const rejectionChallenge = await service.initiate({
      ...mutationContext,
      idempotencyKey: "db-initiate-reject-0001"
    });
    const rejectionCode = reconstructCode(rejectionChallenge);
    await service.confirm({
      identity,
      body: {
        verification_id: rejectionChallenge.verification.verification_id,
        code: rejectionCode
      },
      idempotencyKey: "db-confirm-reject-0001",
      requestContext: { ip: "127.0.0.1" }
    });
    const rejected = await service.reject({
      adminIdentity,
      verificationId: rejectionChallenge.verification.verification_id,
      body: { reason_code: "bio_code_missing", notes: "Codigo nao estava visivel." },
      idempotencyKey: "db-admin-reject-0001"
    });
    assert.equal(rejected.decision, "rejected");
    const rejectionDetails = (await database.query(
      "SELECT decision_details FROM team_verifications WHERE public_id = $1",
      [rejectionChallenge.verification.verification_id]
    )).rows[0].decision_details;
    assert.equal(rejectionDetails.reason_code, "bio_code_missing");
    assert.equal(rejectionDetails.notes, "Codigo nao estava visivel.");

    const expiring = await service.initiate({
      ...mutationContext,
      idempotencyKey: "db-initiate-expiring-0001"
    });
    const expiringCode = reconstructCode(expiring);
    currentTime = new Date("2026-08-24T12:21:00.000Z");
    await assert.rejects(
      service.confirm({
        identity,
        body: {
          verification_id: expiring.verification.verification_id,
          code: expiringCode
        },
        idempotencyKey: "db-confirm-expired-0001",
        requestContext: { ip: "127.0.0.1" }
      }),
      error => error.code === "VERIFICATION_EXPIRED"
    );
    assert.equal((await database.query(
      "SELECT status FROM team_verifications WHERE public_id = $1",
      [expiring.verification.verification_id]
    )).rows[0].status, "expired");

    currentTime = new Date("2026-08-24T13:00:00.000Z");
    const attempts = await service.initiate({
      ...mutationContext,
      idempotencyKey: "db-initiate-attempts-0001"
    });
    for (let index = 1; index <= 5; index += 1) {
      await assert.rejects(
        service.confirm({
          identity,
          body: {
            verification_id: attempts.verification.verification_id,
            code: "MCFC-CCCC-CCCC"
          },
          idempotencyKey: `db-attempt-${index}-0001`,
          requestContext: { ip: "127.0.0.1" }
        }),
        error => index === 5
          ? error.code === "VERIFICATION_ATTEMPTS_EXCEEDED"
          : error.code === "INVALID_VERIFICATION_CODE"
      );
    }
    assert.equal((await database.query(
      "SELECT status, attempt_count FROM team_verifications WHERE public_id = $1",
      [attempts.verification.verification_id]
    )).rows[0].status, "rejected");

    const profileChange = await service.initiate({
      ...mutationContext,
      idempotencyKey: "db-initiate-profile-change-0001"
    });
    const radarRepository = createRadarIdentityRepository({ pool });
    const radarService = createRadarIdentityService({
      repository: radarRepository,
      config,
      now: () => new Date(currentTime)
    });
    const profile = await radarService.getProfile(identity);
    await radarService.putProfile({
      identity,
      body: { instagram_handle: "owner.changed" },
      idempotencyKey: "db-profile-instagram-change-0001",
      expectedVersion: String(profile.profile.version)
    });
    assert.equal((await database.query(
      "SELECT status FROM team_verifications WHERE public_id = $1",
      [profileChange.verification.verification_id]
    )).rows[0].status, "cancelled");
    const changedTeam = (await database.query(`
      SELECT instagram_handle, instagram_verification_status
      FROM radar_team_profiles WHERE legacy_profile_id = $1
    `, [identity.profileId])).rows[0];
    assert.equal(changedTeam.instagram_handle, "owner.changed");
    assert.equal(changedTeam.instagram_verification_status, "unverified");
    await assert.rejects(
      service.initiate({
        ...mutationContext,
        idempotencyKey: "db-initiate-old-handle-0001"
      }),
      error => error.code === "INSTAGRAM_HANDLE_MISMATCH"
    );

    await database.query(`
      INSERT INTO radar_team_profiles(
        legacy_profile_id, account_reference, status, suspended_at,
        instagram_handle
      ) VALUES ('profile-suspended-db', 'account-suspended-db', 'suspended', now(), 'suspended.fc')
    `);
    const suspendedIdentity = ownerIdentity({
      accountId: "account-suspended-db",
      profileId: "profile-suspended-db"
    });
    await assert.rejects(
      service.initiate({
        identity: suspendedIdentity,
        body: { instagram_handle: "suspended.fc" },
        idempotencyKey: "db-suspended-initiate-0001",
        requestContext: { ip: "127.0.0.2" }
      }),
      error => error.code === "RADAR_PROFILE_SUSPENDED"
    );

    const storedText = JSON.stringify((await database.query(`
      SELECT
        (SELECT json_agg(v) FROM team_verifications v) AS verifications,
        (SELECT json_agg(m) FROM radar_verification_mutation_requests m) AS mutations,
        (SELECT json_agg(a) FROM match_audit_events a) AS audits
    `)).rows[0]);
    for (const plaintext of [firstCode, secondCode, rejectionCode, expiringCode]) {
      assert.equal(storedText.includes(plaintext), false);
    }
    assert.equal(storedText.includes("5511999999999"), false);

    const rateScopes = (await database.query(`
      SELECT DISTINCT scope_type FROM radar_verification_rate_limits ORDER BY scope_type
    `)).rows.map(row => row.scope_type);
    assert.deepEqual(rateScopes, ["account", "ip", "team"]);

    await assert.rejects(
      database.query("UPDATE radar_verification_mutation_requests SET result_snapshot = '{}'"),
      error => /append-only/.test(error.message)
    );
  } finally {
    await database.close();
  }
});
