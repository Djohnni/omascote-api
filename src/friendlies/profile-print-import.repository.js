"use strict";

const { RadarIdentityError } = require("./radar-identity.errors");
const { rowToTeam } = require("./radar-identity.repository");
const {
  assertRadarTeamOwnedByIdentity,
  assertRadarTeamCanMutate
} = require("./radar-identity.policy");

function rowToImport(row) {
  if (!row) return null;
  return Object.freeze({
    id: row.id,
    publicId: row.public_id,
    teamId: row.team_id,
    status: row.status,
    evidenceHash: row.evidence_hash,
    aiDraft: row.ai_draft,
    aiModel: row.ai_model,
    aiCompletedAt: row.ai_completed_at,
    processingExpiresAt: row.processing_expires_at,
    evidenceDeleteAfter: row.evidence_delete_after,
    operationMetadata: row.operation_metadata || {},
    version: Number(row.version || 1),
    createdAt: row.created_at
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
      "Crie o perfil do Radar antes de importar um print."
    );
  }
  const team = rowToTeam(result.rows[0]);
  assertRadarTeamOwnedByIdentity(team, identity);
  assertRadarTeamCanMutate(team);
  return team;
}

async function loadImportSubject(client, identity, { lock = false } = {}) {
  const result = await client.query(
    `SELECT * FROM radar_team_profiles WHERE legacy_profile_id = $1${lock ? " FOR UPDATE" : ""}`,
    [identity.profileId]
  );
  if (result.rowCount === 0) {
    return Object.freeze({
      id: null,
      scopeReference: `legacy:${identity.profileId}`,
      existingProfile: false
    });
  }
  const team = rowToTeam(result.rows[0]);
  assertRadarTeamOwnedByIdentity(team, identity);
  assertRadarTeamCanMutate(team);
  return Object.freeze({ ...team, scopeReference: team.id, existingProfile: true });
}

async function recordAudit(client, {
  actorTeamId,
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

function publicDraft(verification, flags = {}) {
  return Object.freeze({
    import: Object.freeze({
      import_id: verification.publicId,
      status: "draft_ready",
      expires_at: verification.evidenceDeleteAfter,
      model: verification.aiModel
    }),
    draft: verification.aiDraft,
    profile_unchanged: true,
    replayed: flags.replayed === true,
    deduplicated: flags.deduplicated === true
  });
}

function requestError(code, status, message) {
  return new RadarIdentityError(code, status, message);
}

async function requestOutcome(client, {
  accountReference,
  idempotencyKey,
  payloadHash,
  now
}) {
  const result = await client.query(`
    SELECT r.payload_hash, r.state, r.failure_code,
           COALESCE(v.id, r.verification_id) AS id,
           COALESCE(v.public_id, r.public_id) AS public_id,
           CASE WHEN v.id IS NULL AND r.state = 'completed' THEN 'pending' ELSE v.status END AS status,
           COALESCE(v.ai_draft, r.ai_draft) AS ai_draft,
           COALESCE(v.ai_model, r.ai_model) AS ai_model,
           COALESCE(v.ai_completed_at, r.ai_completed_at) AS ai_completed_at,
           COALESCE(v.evidence_delete_after, r.evidence_delete_after) AS evidence_delete_after,
           COALESCE(v.operation_metadata, r.operation_metadata) AS operation_metadata,
           COALESCE(v.version, 1) AS version,
           COALESCE(v.created_at, r.created_at) AS created_at,
           COALESCE(v.team_id, r.radar_team_id) AS team_id,
           COALESCE(v.evidence_hash, r.evidence_hash) AS evidence_hash,
           COALESCE(v.processing_expires_at, r.processing_expires_at) AS processing_expires_at
    FROM radar_profile_print_import_requests r
    LEFT JOIN team_verifications v ON v.id = r.verification_id
    WHERE r.account_reference = $1 AND r.idempotency_key = $2
  `, [accountReference, idempotencyKey]);
  if (result.rowCount !== 1) return null;
  const row = result.rows[0];
  if (row.payload_hash !== payloadHash) {
    throw requestError(
      "IDEMPOTENCY_KEY_REUSED",
      409,
      "Idempotency-Key ja utilizada com outros dados."
    );
  }
  if (row.state === "processing") {
    throw requestError(
      "PROFILE_PRINT_IMPORT_IN_PROGRESS",
      409,
      "Uma importacao por print ja esta em processamento."
    );
  }
  if (row.state === "failed") {
    throw requestError(
      "PROFILE_PRINT_IMPORT_PREVIOUSLY_FAILED",
      409,
      "Esta tentativa de importacao foi encerrada. Use uma nova Idempotency-Key."
    );
  }
  const verification = rowToImport(row);
  if (
    !verification?.aiDraft ||
    verification.status !== "pending" ||
    new Date(verification.evidenceDeleteAfter).getTime() <= now.getTime()
  ) {
    return Object.freeze({ kind: "expired" });
  }
  return Object.freeze({ kind: "replay", response: publicDraft(verification, { replayed: true }) });
}

async function expireRows(client, rows, now, actorReference) {
  let expiredCount = 0;
  for (const row of rows) {
    if (!row.ai_draft) {
      await client.query(`
        UPDATE radar_profile_print_import_requests
        SET state = 'failed', failure_code = 'processing_expired', updated_at = $2
        WHERE verification_id = $1 AND state = 'processing'
      `, [row.id, now]);
    }
    const updated = await client.query(`
      UPDATE team_verifications
      SET status = 'expired', ai_draft = NULL,
          decided_at = $2,
          decision_details = jsonb_build_object(
            'source', 'system',
            'reason_code', CASE
              WHEN ai_draft IS NULL THEN 'processing_expired'
              ELSE 'retention_expired'
            END
          ),
          version = version + 1, updated_at = $2
      WHERE id = $1
        AND method = 'profile_print_import'
        AND status = 'pending'
        AND (
          (ai_draft IS NULL AND processing_expires_at <= $2)
          OR
          (ai_draft IS NOT NULL AND evidence_delete_after <= $2)
        )
      RETURNING team_id, version, ai_completed_at
    `, [row.id, now]);
    if (updated.rowCount !== 1) continue;
    expiredCount += 1;
    await recordAudit(client, {
      actorTeamId: updated.rows[0].team_id,
      actorReference,
      eventType: "profile_print_import.expired",
      entityVersion: Number(updated.rows[0].version),
      payload: {
        method: "profile_print_import",
        draft_removed: Boolean(updated.rows[0].ai_completed_at)
      }
    });
  }
  return expiredCount;
}

async function expireStaleImports(client, team, now, actorReference) {
  const stale = await client.query(`
    SELECT * FROM team_verifications
    WHERE team_id = $1
      AND method = 'profile_print_import'
      AND status = 'pending'
      AND (
        (ai_draft IS NULL AND processing_expires_at <= $2)
        OR
        (ai_draft IS NOT NULL AND evidence_delete_after <= $2)
      )
  `, [team.id, now]);
  return expireRows(client, stale.rows, now, actorReference);
}

function createProfilePrintImportRepository({ pool }) {
  if (!pool || typeof pool.query !== "function" || typeof pool.connect !== "function") {
    throw new TypeError("Profile print import repository requires a PostgreSQL pool");
  }

  async function getImportSubject(identity) {
    const client = await pool.connect();
    try {
      return await loadImportSubject(client, identity);
    } finally {
      client.release();
    }
  }

  async function consumeRateLimits({ scopes }) {
    const client = await pool.connect();
    let open = false;
    try {
      await client.query("BEGIN");
      open = true;
      const exceeded = [];
      for (const scope of scopes) {
        const result = await client.query(`
          INSERT INTO radar_profile_print_rate_limits(
            scope_type, scope_hash, window_started_at, request_count
          ) VALUES ($1, $2, $3, 1)
          ON CONFLICT (scope_type, scope_hash, window_started_at)
          DO UPDATE SET
            request_count = radar_profile_print_rate_limits.request_count + 1,
            updated_at = now()
          RETURNING request_count
        `, [scope.type, scope.hash, scope.windowStartedAt]);
        if (Number(result.rows[0].request_count) > scope.limit) exceeded.push(scope.type);
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

  async function expireStale({ now = new Date(), limit = 100 } = {}) {
    if (!(now instanceof Date) || Number.isNaN(now.getTime())) {
      throw new TypeError("now must be a valid Date");
    }
    const boundedLimit = Math.min(Math.max(Number(limit) || 100, 1), 500);
    const client = await pool.connect();
    let open = false;
    try {
      await client.query("BEGIN");
      open = true;
      const stale = await client.query(`
        SELECT * FROM team_verifications
        WHERE method = 'profile_print_import'
          AND status = 'pending'
          AND (
            (ai_draft IS NULL AND processing_expires_at <= $1)
            OR
            (ai_draft IS NOT NULL AND evidence_delete_after <= $1)
          )
        ORDER BY COALESCE(evidence_delete_after, processing_expires_at), created_at
        LIMIT $2
      `, [now, boundedLimit]);
      const expired = await expireRows(
        client,
        stale.rows,
        now,
        "system:profile-print-retention"
      );
      await client.query("COMMIT");
      open = false;
      return Object.freeze({ expired });
    } catch (error) {
      await rollbackQuietly(client, open);
      throw error;
    } finally {
      client.release();
    }
  }

  async function beginImport({
    identity,
    publicId,
    evidenceHash,
    payloadHash,
    idempotencyKey,
    model,
    processingExpiresAt,
    evidenceDeleteAfter,
    metadata,
    now,
    requestId
  }) {
    const client = await pool.connect();
    let open = false;
    try {
      await client.query("BEGIN");
      open = true;
      const team = await loadImportSubject(client, identity, { lock: true });
      if (team.existingProfile) {
        await expireStaleImports(client, team, now, identity.accountId);
      }

      const replay = await requestOutcome(client, {
        accountReference: identity.accountId,
        idempotencyKey,
        payloadHash,
        now
      });
      if (replay) {
        await client.query("COMMIT");
        open = false;
        if (replay.kind === "expired") {
          throw requestError(
            "PROFILE_PRINT_DRAFT_EXPIRED",
            410,
            "O rascunho desta importacao expirou. Envie o print novamente."
          );
        }
        return replay;
      }

      const duplicate = team.existingProfile ? await client.query(`
        SELECT * FROM team_verifications
        WHERE team_id = $1
          AND method = 'profile_print_import'
          AND status = 'pending'
          AND ai_draft IS NOT NULL
          AND evidence_hash = $2
          AND evidence_delete_after > $3
        ORDER BY created_at DESC
        LIMIT 1
      `, [team.id, evidenceHash, now]) : await client.query(`
        SELECT public_id, radar_team_id AS team_id, state AS status,
               evidence_hash, ai_draft, ai_model, ai_completed_at,
               processing_expires_at, evidence_delete_after,
               operation_metadata, 1 AS version, created_at
        FROM radar_profile_print_import_requests
        WHERE account_reference = $1 AND state = 'completed'
          AND ai_draft IS NOT NULL AND evidence_hash = $2
          AND evidence_delete_after > $3
        ORDER BY created_at DESC LIMIT 1
      `, [identity.accountId, evidenceHash, now]);
      if (duplicate.rowCount === 1) {
        const verification = rowToImport(duplicate.rows[0]);
        await client.query(`
          INSERT INTO radar_profile_print_import_requests(
            account_reference, radar_team_id, idempotency_key, payload_hash,
            evidence_hash, verification_id, state, result_snapshot, ai_draft,
            ai_model, ai_completed_at, evidence_delete_after, operation_metadata
          ) VALUES ($1, $2, $3, $4, $5, $6, 'completed', $7::jsonb, $8::jsonb,
                    $9, $10, $11, $12::jsonb)
        `, [
          identity.accountId,
          team.id,
          idempotencyKey,
          payloadHash,
          evidenceHash,
          team.existingProfile ? verification.id : null,
          JSON.stringify(publicDraft(verification, { deduplicated: true })),
          JSON.stringify(verification.aiDraft),
          verification.aiModel,
          verification.aiCompletedAt,
          verification.evidenceDeleteAfter,
          JSON.stringify(verification.operationMetadata || {})
        ]);
        await recordAudit(client, {
          actorTeamId: team.id,
          actorReference: identity.accountId,
          eventType: "profile_print_import.deduplicated",
          entityVersion: verification.version,
          payload: { method: "profile_print_import" },
          requestId
        });
        await client.query("COMMIT");
        open = false;
        return Object.freeze({
          kind: "deduplicated",
          response: publicDraft(verification, { deduplicated: true })
        });
      }

      const processing = team.existingProfile ? await client.query(`
        SELECT 1 FROM team_verifications
        WHERE team_id = $1 AND method = 'profile_print_import'
          AND status = 'pending' AND ai_draft IS NULL
        LIMIT 1
      `, [team.id]) : await client.query(`
        SELECT 1 FROM radar_profile_print_import_requests
        WHERE account_reference = $1 AND state = 'processing'
        LIMIT 1
      `, [identity.accountId]);
      if (processing.rowCount > 0) {
        throw requestError(
          "PROFILE_PRINT_IMPORT_IN_PROGRESS",
          409,
          "Uma importacao por print ja esta em processamento."
        );
      }

      if (!team.existingProfile) {
        const request = await client.query(`
          INSERT INTO radar_profile_print_import_requests(
            account_reference, radar_team_id, idempotency_key, payload_hash,
            evidence_hash, state, ai_model, processing_expires_at,
            evidence_delete_after, operation_metadata
          ) VALUES ($1, NULL, $2, $3, $4, 'processing', $5, $6, $7, $8::jsonb)
          RETURNING id, public_id
        `, [
          identity.accountId, idempotencyKey, payloadHash, evidenceHash,
          model, processingExpiresAt, evidenceDeleteAfter, JSON.stringify(metadata)
        ]);
        await recordAudit(client, {
          actorTeamId: null,
          actorReference: identity.accountId,
          eventType: "profile_print_import.started",
          payload: { method: "profile_print_import", onboarding: true, format: metadata.format },
          requestId
        });
        await client.query("COMMIT");
        open = false;
        return Object.freeze({
          kind: "created",
          requestDbId: request.rows[0].id,
          verification: Object.freeze({ id: null, publicId: request.rows[0].public_id }),
          team
        });
      }

      const inserted = await client.query(`
        INSERT INTO team_verifications(
          public_id, team_id, method, status, requested_by_account_reference,
          evidence_hash, evidence_delete_after, processing_expires_at,
          ai_model, operation_metadata
        ) VALUES ($1, $2, 'profile_print_import', 'pending', $3, $4, $5, $6, $7, $8::jsonb)
        RETURNING *
      `, [
        publicId,
        team.id,
        identity.accountId,
        evidenceHash,
        evidenceDeleteAfter,
        processingExpiresAt,
        model,
        JSON.stringify(metadata)
      ]);
      const verification = rowToImport(inserted.rows[0]);
      const request = await client.query(`
        INSERT INTO radar_profile_print_import_requests(
          account_reference, radar_team_id, idempotency_key, payload_hash,
          evidence_hash, verification_id
        ) VALUES ($1, $2, $3, $4, $5, $6)
        RETURNING id
      `, [
        identity.accountId,
        team.id,
        idempotencyKey,
        payloadHash,
        evidenceHash,
        verification.id
      ]);
      await recordAudit(client, {
        actorTeamId: team.id,
        actorReference: identity.accountId,
        eventType: "profile_print_import.started",
        entityVersion: verification.version,
        payload: {
          method: "profile_print_import",
          format: metadata.format,
          width: metadata.width,
          height: metadata.height
        },
        requestId
      });
      await client.query("COMMIT");
      open = false;
      return Object.freeze({
        kind: "created",
        requestDbId: request.rows[0].id,
        verification,
        team
      });
    } catch (error) {
      await rollbackQuietly(client, open);
      open = false;
      if (error?.code === "23505") {
        const concurrent = await requestOutcome(pool, {
          accountReference: identity.accountId,
          idempotencyKey,
          payloadHash,
          now
        });
        if (concurrent?.kind === "expired") {
          throw requestError(
            "PROFILE_PRINT_DRAFT_EXPIRED",
            410,
            "O rascunho desta importacao expirou. Envie o print novamente."
          );
        }
        if (concurrent) return concurrent;
        throw requestError(
          "PROFILE_PRINT_IMPORT_IN_PROGRESS",
          409,
          "Uma importacao por print ja esta em processamento."
        );
      }
      throw error;
    } finally {
      client.release();
    }
  }

  async function completeImport({ requestDbId, verificationId, identity, draft, metadata, now, requestId }) {
    const client = await pool.connect();
    let open = false;
    try {
      await client.query("BEGIN");
      open = true;
      const request = await client.query(`
        SELECT * FROM radar_profile_print_import_requests
        WHERE id = $1 AND account_reference = $2 AND state = 'processing'
        FOR UPDATE
      `, [requestDbId, identity.accountId]);
      if (request.rowCount !== 1 || request.rows[0].verification_id !== verificationId) {
        throw requestError(
          "PROFILE_PRINT_IMPORT_NOT_OPEN",
          409,
          "A importacao por print nao esta aberta."
        );
      }
      if (verificationId === null) {
        const snapshot = Object.freeze({
          import: Object.freeze({
            import_id: request.rows[0].public_id,
            status: "draft_ready",
            expires_at: request.rows[0].evidence_delete_after,
            model: request.rows[0].ai_model
          }),
          draft,
          profile_unchanged: true,
          replayed: false,
          deduplicated: false
        });
        await client.query(`
          UPDATE radar_profile_print_import_requests
          SET state = 'completed', ai_draft = $2::jsonb, ai_completed_at = $3,
              operation_metadata = $4::jsonb, result_snapshot = $5::jsonb,
              updated_at = $3
          WHERE id = $1
        `, [requestDbId, JSON.stringify(draft), now, JSON.stringify(metadata), JSON.stringify(snapshot)]);
        await recordAudit(client, {
          actorTeamId: null,
          actorReference: identity.accountId,
          eventType: "profile_print_import.completed",
          payload: { method: "profile_print_import", onboarding: true, suggestion_fields: Object.keys(draft.suggestions) },
          requestId
        });
        await client.query("COMMIT");
        open = false;
        return snapshot;
      }
      const updated = await client.query(`
        UPDATE team_verifications
        SET ai_draft = $2::jsonb, ai_completed_at = $3,
            operation_metadata = $4::jsonb,
            version = version + 1, updated_at = $3
        WHERE id = $1 AND method = 'profile_print_import'
          AND status = 'pending' AND ai_draft IS NULL
        RETURNING *
      `, [verificationId, JSON.stringify(draft), now, JSON.stringify(metadata)]);
      if (updated.rowCount !== 1) {
        throw requestError(
          "PROFILE_PRINT_IMPORT_NOT_OPEN",
          409,
          "A importacao por print nao esta aberta."
        );
      }
      const verification = rowToImport(updated.rows[0]);
      await client.query(`
        UPDATE radar_profile_print_import_requests
        SET state = 'completed', result_snapshot = '{"outcome":"draft_ready"}'::jsonb,
            updated_at = $2
        WHERE id = $1
      `, [requestDbId, now]);
      await recordAudit(client, {
        actorTeamId: verification.teamId,
        actorReference: identity.accountId,
        eventType: "profile_print_import.completed",
        entityVersion: verification.version,
        payload: {
          method: "profile_print_import",
          suggestion_fields: Object.keys(draft.suggestions),
          warning_count: draft.warnings.length
        },
        requestId
      });
      await client.query("COMMIT");
      open = false;
      return publicDraft(verification);
    } catch (error) {
      await rollbackQuietly(client, open);
      throw error;
    } finally {
      client.release();
    }
  }

  async function failImport({ requestDbId, verificationId, identity, failureCode, now, requestId }) {
    const client = await pool.connect();
    let open = false;
    try {
      await client.query("BEGIN");
      open = true;
      const request = await client.query(`
        SELECT * FROM radar_profile_print_import_requests
        WHERE id = $1 AND account_reference = $2
        FOR UPDATE
      `, [requestDbId, identity.accountId]);
      if (request.rowCount !== 1 || request.rows[0].state !== "processing") {
        await client.query("COMMIT");
        open = false;
        return;
      }
      const updated = verificationId === null ? { rowCount: 0, rows: [] } : await client.query(`
        UPDATE team_verifications
        SET status = 'cancelled', decided_at = $2,
            decision_details = $3::jsonb,
            version = version + 1, updated_at = $2
        WHERE id = $1 AND method = 'profile_print_import'
          AND status = 'pending' AND ai_draft IS NULL
        RETURNING team_id, version
      `, [
        verificationId,
        now,
        JSON.stringify({ source: "system", reason_code: failureCode })
      ]);
      await client.query(`
        UPDATE radar_profile_print_import_requests
        SET state = 'failed', failure_code = $2, updated_at = $3
        WHERE id = $1
      `, [requestDbId, failureCode, now]);
      if (verificationId === null) {
        await recordAudit(client, {
          actorTeamId: null,
          actorReference: identity.accountId,
          eventType: "profile_print_import.failed",
          payload: { method: "profile_print_import", onboarding: true, failure_code: failureCode },
          requestId
        });
      }
      if (updated.rowCount === 1) {
        await recordAudit(client, {
          actorTeamId: updated.rows[0].team_id,
          actorReference: identity.accountId,
          eventType: "profile_print_import.failed",
          entityVersion: Number(updated.rows[0].version),
          payload: { method: "profile_print_import", failure_code: failureCode },
          requestId
        });
      }
      await client.query("COMMIT");
      open = false;
    } catch (error) {
      await rollbackQuietly(client, open);
      throw error;
    } finally {
      client.release();
    }
  }

  return Object.freeze({
    getImportSubject,
    consumeRateLimits,
    expireStale,
    beginImport,
    completeImport,
    failImport
  });
}

module.exports = {
  createProfilePrintImportRepository,
  rowToImport,
  publicDraft,
  loadImportSubject
};
