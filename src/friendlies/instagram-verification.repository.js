"use strict";

const { RadarIdentityError } = require("./radar-identity.errors");
const { rowToTeam } = require("./radar-identity.repository");
const {
  assertRadarTeamOwnedByIdentity,
  assertRadarTeamCanMutate
} = require("./radar-identity.policy");
const { hashesEqual } = require("./instagram-verification.crypto");

function rowToVerification(row) {
  if (!row) return null;
  if (row.publicId) return Object.freeze({ ...row });
  return Object.freeze({
    id: row.id,
    publicId: row.public_id,
    teamId: row.team_id,
    method: row.method,
    status: row.status,
    challengeHash: row.challenge_hash,
    challengeExpiresAt: row.challenge_expires_at,
    attemptCount: Number(row.attempt_count || 0),
    instagramHandleSnapshot: row.instagram_handle_snapshot,
    requestedByAccountReference: row.requested_by_account_reference,
    confirmationClaimedAt: row.confirmation_claimed_at,
    humanDecisionBy: row.human_decision_by,
    humanDecisionReason: row.human_decision_reason,
    decisionDetails: row.decision_details,
    decidedAt: row.decided_at,
    version: Number(row.version || 1),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    teamPublicId: row.team_public_id || null
  });
}

async function rollbackQuietly(client, open) {
  if (!open) return;
  try {
    await client.query("ROLLBACK");
  } catch {}
}

async function loadOwnedTeam(client, identity, { lock = false } = {}) {
  const result = await client.query(
    `SELECT * FROM radar_team_profiles WHERE legacy_profile_id = $1${lock ? " FOR UPDATE" : ""}`,
    [identity.profileId]
  );
  if (result.rowCount !== 1) {
    throw new RadarIdentityError(
      "RADAR_PROFILE_NOT_FOUND",
      409,
      "Crie o perfil do Radar antes de verificar o Instagram."
    );
  }
  const team = rowToTeam(result.rows[0]);
  assertRadarTeamOwnedByIdentity(team, identity);
  return team;
}

async function findReplay(client, { accountReference, operation, idempotencyKey, payloadHash }) {
  const result = await client.query(`
    SELECT payload_hash, verification_id, result_snapshot
    FROM radar_verification_mutation_requests
    WHERE account_reference = $1 AND operation = $2 AND idempotency_key = $3
  `, [accountReference, operation, idempotencyKey]);
  if (result.rowCount !== 1) return null;
  if (result.rows[0].payload_hash !== payloadHash) {
    throw new RadarIdentityError(
      "IDEMPOTENCY_KEY_REUSED",
      409,
      "Idempotency-Key ja utilizada com outros dados."
    );
  }
  return result.rows[0];
}

async function recordMutation(client, {
  accountReference,
  operation,
  idempotencyKey,
  payloadHash,
  verificationId,
  snapshot
}) {
  await client.query(`
    INSERT INTO radar_verification_mutation_requests(
      account_reference, operation, idempotency_key, payload_hash,
      verification_id, result_snapshot
    ) VALUES ($1, $2, $3, $4, $5, $6::jsonb)
  `, [
    accountReference,
    operation,
    idempotencyKey,
    payloadHash,
    verificationId || null,
    JSON.stringify(snapshot)
  ]);
}

async function recordAudit(client, {
  actorTeamId = null,
  actorReference,
  eventType,
  entityVersion = null,
  payload = {},
  requestId = null
}) {
  await client.query(`
    INSERT INTO match_audit_events(
      actor_team_id, actor_reference, event_type, entity_version, payload, request_id
    ) VALUES ($1, $2, $3, $4, $5::jsonb, $6)
  `, [
    actorTeamId,
    actorReference,
    eventType,
    entityVersion,
    JSON.stringify(payload),
    requestId
  ]);
}

async function setTeamVerificationState(client, teamId, verificationStatus, statusMode) {
  const statusExpression = statusMode === "verified"
    ? "CASE WHEN status = 'suspended' THEN 'suspended' WHEN status = 'draft' THEN 'draft' ELSE 'paused' END"
    : "CASE WHEN status = 'suspended' THEN 'suspended' WHEN status = 'draft' THEN 'draft' ELSE 'pending_verification' END";
  await client.query(`
    UPDATE radar_team_profiles
    SET instagram_verification_status = $2,
        availability_active = false,
        status = ${statusExpression},
        version = version + 1,
        updated_at = now()
    WHERE id = $1
  `, [teamId, verificationStatus]);
}

function createInstagramVerificationRepository({ pool }) {
  if (!pool || typeof pool.query !== "function" || typeof pool.connect !== "function") {
    throw new TypeError("Instagram verification repository requires a PostgreSQL pool");
  }

  async function consumeRateLimits({ operation, windowStartedAt, scopes }) {
    const client = await pool.connect();
    let open = false;
    try {
      await client.query("BEGIN");
      open = true;
      const exceeded = [];
      for (const scope of scopes) {
        const result = await client.query(`
          INSERT INTO radar_verification_rate_limits(
            scope_type, scope_hash, operation, window_started_at, request_count
          ) VALUES ($1, $2, $3, $4, 1)
          ON CONFLICT (scope_type, scope_hash, operation, window_started_at)
          DO UPDATE SET
            request_count = radar_verification_rate_limits.request_count + 1,
            updated_at = now()
          RETURNING request_count
        `, [scope.type, scope.hash, operation, windowStartedAt]);
        const count = Number(result.rows[0].request_count);
        if (count > scope.limit) exceeded.push(scope.type);
      }
      await client.query("COMMIT");
      open = false;
      return Object.freeze({ allowed: exceeded.length === 0, exceeded: Object.freeze(exceeded) });
    } catch (error) {
      await rollbackQuietly(client, open);
      throw error;
    } finally {
      client.release();
    }
  }

  async function getOwnerState(identity) {
    const client = await pool.connect();
    try {
      const team = await loadOwnedTeam(client, identity);
      const result = await client.query(`
        SELECT * FROM team_verifications
        WHERE team_id = $1 AND method = 'instagram_bio_code'
        ORDER BY created_at DESC
        LIMIT 1
      `, [team.id]);
      return Object.freeze({ team, verification: rowToVerification(result.rows[0]) });
    } finally {
      client.release();
    }
  }

  async function initiate({
    identity,
    publicId,
    instagramHandle,
    challengeHash,
    expiresAt,
    idempotencyKey,
    payloadHash,
    requestId
  }) {
    const client = await pool.connect();
    let open = false;
    try {
      await client.query("BEGIN");
      open = true;
      const team = await loadOwnedTeam(client, identity, { lock: true });
      assertRadarTeamCanMutate(team);
      if (!team.instagramHandle || team.instagramHandle !== instagramHandle) {
        throw new RadarIdentityError(
          "INSTAGRAM_HANDLE_MISMATCH",
          409,
          "O Instagram deve ser exatamente o mesmo salvo no perfil do Radar."
        );
      }

      const replay = await findReplay(client, {
        accountReference: identity.accountId,
        operation: "initiate",
        idempotencyKey,
        payloadHash
      });
      if (replay) {
        const current = replay.verification_id
          ? await client.query("SELECT * FROM team_verifications WHERE id = $1", [replay.verification_id])
          : { rows: [] };
        await client.query("COMMIT");
        open = false;
        return Object.freeze({
          verification: rowToVerification(current.rows[0]),
          snapshot: replay.result_snapshot,
          replayed: true
        });
      }

      const cancelled = await client.query(`
        UPDATE team_verifications
        SET status = 'cancelled',
            decided_at = now(),
            decision_details = '{"source":"system","reason_code":"replaced"}'::jsonb,
            version = version + 1,
            updated_at = now()
        WHERE team_id = $1 AND method = 'instagram_bio_code' AND status = 'pending'
        RETURNING id
      `, [team.id]);

      const inserted = await client.query(`
        INSERT INTO team_verifications(
          public_id, team_id, method, status, challenge_hash,
          challenge_expires_at, instagram_handle_snapshot,
          requested_by_account_reference
        ) VALUES ($1, $2, 'instagram_bio_code', 'pending', $3, $4, $5, $6)
        RETURNING *
      `, [
        publicId,
        team.id,
        challengeHash,
        expiresAt,
        instagramHandle,
        identity.accountId
      ]);
      const verification = rowToVerification(inserted.rows[0]);
      await setTeamVerificationState(client, team.id, "pending", "pending");

      const snapshot = {
        outcome: "challenge_issued",
        verification_public_id: verification.publicId
      };
      await recordMutation(client, {
        accountReference: identity.accountId,
        operation: "initiate",
        idempotencyKey,
        payloadHash,
        verificationId: verification.id,
        snapshot
      });
      if (cancelled.rowCount > 0) {
        await recordAudit(client, {
          actorTeamId: team.id,
          actorReference: identity.accountId,
          eventType: "instagram_verification.replaced",
          payload: { invalidated_count: cancelled.rowCount },
          requestId
        });
      }
      await recordAudit(client, {
        actorTeamId: team.id,
        actorReference: identity.accountId,
        eventType: "instagram_verification.initiated",
        entityVersion: verification.version,
        payload: { method: verification.method, status: verification.status },
        requestId
      });

      await client.query("COMMIT");
      open = false;
      return Object.freeze({ verification, snapshot, replayed: false });
    } catch (error) {
      await rollbackQuietly(client, open);
      throw error;
    } finally {
      client.release();
    }
  }

  async function confirm({
    identity,
    verificationPublicId,
    submittedChallengeHash,
    maxAttempts,
    now,
    idempotencyKey,
    payloadHash,
    requestId
  }) {
    const client = await pool.connect();
    let open = false;
    try {
      await client.query("BEGIN");
      open = true;
      const team = await loadOwnedTeam(client, identity, { lock: true });
      assertRadarTeamCanMutate(team);
      const result = await client.query(`
        SELECT * FROM team_verifications
        WHERE public_id = $1 AND team_id = $2 AND method = 'instagram_bio_code'
        FOR UPDATE
      `, [verificationPublicId, team.id]);
      if (result.rowCount !== 1) {
        throw new RadarIdentityError(
          "VERIFICATION_NOT_FOUND",
          404,
          "Verificacao nao encontrada."
        );
      }
      let verification = rowToVerification(result.rows[0]);

      const replay = await findReplay(client, {
        accountReference: identity.accountId,
        operation: "confirm",
        idempotencyKey,
        payloadHash
      });
      if (replay) {
        await client.query("COMMIT");
        open = false;
        return Object.freeze({
          verification,
          outcome: replay.result_snapshot.outcome,
          replayed: true
        });
      }

      let outcome;
      const expired = new Date(verification.challengeExpiresAt).getTime() <= now.getTime();
      const handleChanged = verification.instagramHandleSnapshot !== team.instagramHandle;

      if (verification.status !== "pending") {
        outcome = verification.status;
      } else if (handleChanged) {
        const updated = await client.query(`
          UPDATE team_verifications
          SET status = 'cancelled', decided_at = $2,
              decision_details = '{"source":"system","reason_code":"instagram_changed"}'::jsonb,
              version = version + 1, updated_at = $2
          WHERE id = $1 RETURNING *
        `, [verification.id, now]);
        verification = rowToVerification(updated.rows[0]);
        await setTeamVerificationState(client, team.id, "unverified", "pending");
        outcome = "instagram_changed";
      } else if (expired) {
        const updated = await client.query(`
          UPDATE team_verifications
          SET status = 'expired', decided_at = $2,
              decision_details = '{"source":"system","reason_code":"expired"}'::jsonb,
              version = version + 1, updated_at = $2
          WHERE id = $1 RETURNING *
        `, [verification.id, now]);
        verification = rowToVerification(updated.rows[0]);
        await setTeamVerificationState(client, team.id, "expired", "pending");
        outcome = "expired";
      } else if (verification.confirmationClaimedAt) {
        outcome = "pending_review";
      } else if (!hashesEqual(verification.challengeHash, submittedChallengeHash)) {
        const nextAttempts = verification.attemptCount + 1;
        const locked = nextAttempts >= maxAttempts;
        const updated = await client.query(`
          UPDATE team_verifications
          SET attempt_count = $2,
              status = CASE WHEN $3 THEN 'rejected' ELSE status END,
              decided_at = CASE WHEN $3 THEN $4 ELSE decided_at END,
              decision_details = CASE WHEN $3
                THEN '{"source":"system","reason_code":"attempt_limit"}'::jsonb
                ELSE decision_details END,
              version = version + 1,
              updated_at = $4
          WHERE id = $1 RETURNING *
        `, [verification.id, nextAttempts, locked, now]);
        verification = rowToVerification(updated.rows[0]);
        if (locked) await setTeamVerificationState(client, team.id, "rejected", "pending");
        outcome = locked ? "attempt_limit" : "invalid_code";
        await recordAudit(client, {
          actorTeamId: team.id,
          actorReference: identity.accountId,
          eventType: "instagram_verification.code_rejected",
          entityVersion: verification.version,
          payload: { attempt_count: nextAttempts, challenge_closed: locked },
          requestId
        });
      } else {
        const updated = await client.query(`
          UPDATE team_verifications
          SET attempt_count = attempt_count + 1,
              confirmation_claimed_at = $2,
              version = version + 1,
              updated_at = $2
          WHERE id = $1 RETURNING *
        `, [verification.id, now]);
        verification = rowToVerification(updated.rows[0]);
        outcome = "pending_review";
        await recordAudit(client, {
          actorTeamId: team.id,
          actorReference: identity.accountId,
          eventType: "instagram_verification.confirmation_claimed",
          entityVersion: verification.version,
          payload: { status: "pending_review" },
          requestId
        });
      }

      await recordMutation(client, {
        accountReference: identity.accountId,
        operation: "confirm",
        idempotencyKey,
        payloadHash,
        verificationId: verification.id,
        snapshot: { outcome }
      });
      if (["expired", "instagram_changed"].includes(outcome)) {
        await recordAudit(client, {
          actorTeamId: team.id,
          actorReference: identity.accountId,
          eventType: `instagram_verification.${outcome}`,
          entityVersion: verification.version,
          payload: { status: verification.status },
          requestId
        });
      }

      await client.query("COMMIT");
      open = false;
      return Object.freeze({ verification, outcome, replayed: false });
    } catch (error) {
      await rollbackQuietly(client, open);
      throw error;
    } finally {
      client.release();
    }
  }

  async function assertReviewer(client, accountReference) {
    const role = await client.query(`
      SELECT role FROM radar_account_roles
      WHERE account_reference = $1
        AND role IN ('verification_reviewer', 'radar_admin')
        AND active = true
        AND revoked_at IS NULL
      ORDER BY CASE role WHEN 'radar_admin' THEN 0 ELSE 1 END
      LIMIT 1
    `, [accountReference]);
    if (role.rowCount !== 1) {
      throw new RadarIdentityError(
        "VERIFICATION_REVIEW_FORBIDDEN",
        403,
        "Acesso restrito a revisores autorizados."
      );
    }
    return role.rows[0].role;
  }

  async function listPendingReviews(adminIdentity, { limit = 50, now = new Date() } = {}) {
    const client = await pool.connect();
    try {
      await assertReviewer(client, adminIdentity.accountId);
      const result = await client.query(`
        SELECT v.*, t.public_id AS team_public_id
        FROM team_verifications v
        JOIN radar_team_profiles t ON t.id = v.team_id
        WHERE v.method = 'instagram_bio_code'
          AND v.status = 'pending'
          AND v.confirmation_claimed_at IS NOT NULL
          AND v.challenge_expires_at > $2
        ORDER BY v.confirmation_claimed_at ASC, v.created_at ASC
        LIMIT $1
      `, [Math.min(Math.max(Number(limit) || 50, 1), 100), now]);
      return Object.freeze(result.rows.map(rowToVerification));
    } finally {
      client.release();
    }
  }

  async function decide({
    adminIdentity,
    verificationPublicId,
    decision,
    observedChallengeHash,
    reason,
    now,
    idempotencyKey,
    payloadHash,
    requestId
  }) {
    const client = await pool.connect();
    let open = false;
    try {
      await client.query("BEGIN");
      open = true;
      await assertReviewer(client, adminIdentity.accountId);

      const result = await client.query(`
        SELECT v.*, t.public_id AS team_public_id, t.instagram_handle AS current_instagram_handle
        FROM team_verifications v
        JOIN radar_team_profiles t ON t.id = v.team_id
        WHERE v.public_id = $1 AND v.method = 'instagram_bio_code'
        FOR UPDATE OF v, t
      `, [verificationPublicId]);
      if (result.rowCount !== 1) {
        throw new RadarIdentityError("VERIFICATION_NOT_FOUND", 404, "Verificacao nao encontrada.");
      }
      let verification = rowToVerification(result.rows[0]);
      if (verification.requestedByAccountReference === adminIdentity.accountId) {
        throw new RadarIdentityError(
          "VERIFICATION_SELF_REVIEW_FORBIDDEN",
          403,
          "O solicitante nao pode revisar a propria verificacao."
        );
      }

      const replay = await findReplay(client, {
        accountReference: adminIdentity.accountId,
        operation: decision,
        idempotencyKey,
        payloadHash
      });
      if (replay) {
        await client.query("COMMIT");
        open = false;
        return Object.freeze({ verification, outcome: replay.result_snapshot.outcome, replayed: true });
      }

      let outcome;
      const expired = new Date(verification.challengeExpiresAt).getTime() <= now.getTime();
      const handleChanged = verification.instagramHandleSnapshot !== result.rows[0].current_instagram_handle;
      if (verification.status !== "pending") {
        throw new RadarIdentityError(
          "VERIFICATION_ALREADY_DECIDED",
          409,
          "Esta verificacao ja foi encerrada."
        );
      }
      if (!verification.confirmationClaimedAt) {
        throw new RadarIdentityError(
          "VERIFICATION_NOT_CONFIRMED",
          409,
          "O responsavel ainda nao confirmou a publicacao do codigo."
        );
      }
      if (expired || handleChanged) {
        outcome = expired ? "expired" : "instagram_changed";
        const status = expired ? "expired" : "cancelled";
        const updated = await client.query(`
          UPDATE team_verifications
          SET status = $2, decided_at = $3,
              decision_details = $4::jsonb,
              version = version + 1, updated_at = $3
          WHERE id = $1 RETURNING *
        `, [
          verification.id,
          status,
          now,
          JSON.stringify({ source: "system", reason_code: outcome })
        ]);
        verification = rowToVerification(updated.rows[0]);
        await setTeamVerificationState(
          client,
          verification.teamId,
          expired ? "expired" : "unverified",
          "pending"
        );
      } else if (decision === "approve" && !hashesEqual(
        verification.challengeHash,
        observedChallengeHash
      )) {
        outcome = "observed_code_mismatch";
      } else {
        const targetStatus = decision === "approve" ? "verified" : "rejected";
        const details = decision === "approve"
          ? { source: "manual_review", decision: "approved" }
          : {
            source: "manual_review",
            decision: "rejected",
            reason_code: reason.reasonCode,
            notes: reason.notes
          };
        const updated = await client.query(`
          UPDATE team_verifications
          SET status = $2,
              human_decision_by = $3,
              human_decision_reason = $4,
              decision_details = $5::jsonb,
              decided_at = $6,
              version = version + 1,
              updated_at = $6
          WHERE id = $1 RETURNING *
        `, [
          verification.id,
          targetStatus,
          adminIdentity.accountId,
          decision === "reject" ? reason.reasonCode : "manual_review",
          JSON.stringify(details),
          now
        ]);
        verification = rowToVerification(updated.rows[0]);
        await setTeamVerificationState(
          client,
          verification.teamId,
          decision === "approve" ? "verified" : "rejected",
          decision === "approve" ? "verified" : "pending"
        );
        outcome = targetStatus;
      }

      await recordMutation(client, {
        accountReference: adminIdentity.accountId,
        operation: decision,
        idempotencyKey,
        payloadHash,
        verificationId: verification.id,
        snapshot: { outcome }
      });
      await recordAudit(client, {
        actorReference: adminIdentity.accountId,
        eventType: `instagram_verification.review_${outcome}`,
        entityVersion: verification.version,
        payload: {
          decision,
          outcome,
          reason_code: decision === "reject" ? reason.reasonCode : null
        },
        requestId
      });

      await client.query("COMMIT");
      open = false;
      return Object.freeze({ verification, outcome, replayed: false });
    } catch (error) {
      await rollbackQuietly(client, open);
      throw error;
    } finally {
      client.release();
    }
  }

  return Object.freeze({
    consumeRateLimits,
    getOwnerState,
    initiate,
    confirm,
    listPendingReviews,
    decide
  });
}

module.exports = { createInstagramVerificationRepository, rowToVerification };
