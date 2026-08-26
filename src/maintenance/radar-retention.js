"use strict";

const RETENTION_LOCK_ID = 724_202_613;

async function recordAvailabilityAudit(client, row, now) {
  await client.query(`
    INSERT INTO match_audit_events(
      actor_team_id, actor_reference, event_type, entity_version, payload, request_id, created_at
    ) VALUES ($1, 'system:radar-retention', 'friendly_availability.expired', $2::integer,
      jsonb_build_object('availability_public_id', $3::uuid, 'status', 'expired'),
      'system:radar-retention', $4)
  `, [row.team_id, row.version, row.public_id, now]);
}

async function recordInvitationExpiration(client, row, now) {
  await client.query(`
    INSERT INTO match_audit_events(
      invitation_id, actor_reference, event_type, entity_version, payload, request_id, created_at
    ) VALUES ($1, 'system:radar-retention', 'friendly_invitation.expired', $2::integer,
      '{"state":"expired"}'::jsonb, 'system:radar-retention', $3)
  `, [row.id, row.version, now]);
  for (const teamId of [row.requester_team_id, row.invited_team_id]) {
    await client.query(`
      INSERT INTO notifications(
        recipient_team_id, event_type, entity_type, entity_public_id,
        payload, deduplication_key, created_at
      ) VALUES ($1, 'invitation_expired', 'friendly_invitation', $2::uuid,
        jsonb_build_object('invitation_id', $2::uuid, 'state', 'expired', 'version', $3::integer),
        $4, $5)
      ON CONFLICT (recipient_team_id, deduplication_key) DO NOTHING
    `, [teamId, row.public_id, row.version, `invitation_expired:${row.public_id}:v${row.version}`, now]);
  }
}

async function expireAvailabilities(client, now, limit) {
  const result = await client.query(`
    WITH candidates AS (
      SELECT id FROM friendly_availabilities
      WHERE status IN ('active', 'paused') AND ends_at <= $1
      ORDER BY ends_at, id LIMIT $2::integer FOR UPDATE SKIP LOCKED
    )
    UPDATE friendly_availabilities availability
    SET status = 'expired', version = availability.version + 1, updated_at = $1
    FROM candidates WHERE availability.id = candidates.id
    RETURNING availability.team_id, availability.public_id, availability.version
  `, [now, limit]);
  for (const row of result.rows) await recordAvailabilityAudit(client, row, now);
  return result.rowCount;
}

async function expireInvitations(client, now, limit) {
  const result = await client.query(`
    WITH candidates AS (
      SELECT id FROM friendly_invitations
      WHERE state IN ('pending', 'counter_proposed') AND expires_at <= $1
      ORDER BY expires_at, id LIMIT $2::integer FOR UPDATE SKIP LOCKED
    )
    UPDATE friendly_invitations invitation
    SET state = 'expired', expired_at = $1,
        version = invitation.version + 1, updated_at = $1
    FROM candidates WHERE invitation.id = candidates.id
    RETURNING invitation.id, invitation.public_id, invitation.requester_team_id,
              invitation.invited_team_id, invitation.version
  `, [now, limit]);
  for (const row of result.rows) await recordInvitationExpiration(client, row, now);
  return result.rowCount;
}

async function expireInstagramChallenges(client, now, limit) {
  const result = await client.query(`
    WITH candidates AS (
      SELECT id FROM team_verifications
      WHERE method = 'instagram_bio_code' AND status = 'pending'
        AND challenge_expires_at <= $1
      ORDER BY challenge_expires_at, id LIMIT $2::integer FOR UPDATE SKIP LOCKED
    )
    UPDATE team_verifications verification
    SET status = 'expired', decided_at = $1, version = verification.version + 1,
        updated_at = $1,
        decision_details = '{"source":"system","reason_code":"expired"}'::jsonb
    FROM candidates WHERE verification.id = candidates.id
    RETURNING verification.id, verification.team_id, verification.version
  `, [now, limit]);
  for (const row of result.rows) {
    await client.query(`
      UPDATE radar_team_profiles
      SET instagram_verification_status = 'expired', version = version + 1, updated_at = $2
      WHERE id = $1 AND instagram_verification_status = 'pending'
    `, [row.team_id, now]);
    await client.query(`
      INSERT INTO match_audit_events(
        actor_team_id, actor_reference, event_type, entity_version,
        payload, request_id, created_at
      ) VALUES ($1, 'system:radar-retention', 'instagram_verification.expired', $2::integer,
        '{"method":"instagram_bio_code","status":"expired"}'::jsonb,
        'system:radar-retention', $3)
    `, [row.team_id, row.version, now]);
  }
  return result.rowCount;
}

async function expireProfilePrintDrafts(client, now, limit) {
  const onboarding = await client.query(`
    WITH candidates AS (
      SELECT id FROM radar_profile_print_import_requests
      WHERE verification_id IS NULL
        AND (
          (state = 'processing' AND processing_expires_at <= $1)
          OR (state = 'completed' AND evidence_delete_after <= $1)
        )
      ORDER BY COALESCE(evidence_delete_after, processing_expires_at), id
      LIMIT $2::integer FOR UPDATE SKIP LOCKED
    )
    UPDATE radar_profile_print_import_requests request
    SET state = CASE WHEN request.state = 'processing' THEN 'failed' ELSE 'expired' END,
        failure_code = CASE WHEN request.state = 'processing' THEN 'processing_expired' ELSE NULL END,
        ai_draft = NULL,
        result_snapshot = CASE WHEN request.state = 'processing' THEN NULL ELSE '{"outcome":"expired"}'::jsonb END,
        updated_at = $1
    FROM candidates WHERE request.id = candidates.id
    RETURNING request.account_reference
  `, [now, limit]);
  for (const row of onboarding.rows) {
    await client.query(`
      INSERT INTO match_audit_events(
        actor_reference, event_type, payload, request_id, created_at
      ) VALUES ($1, 'profile_print_import.expired',
        '{"method":"profile_print_import","status":"expired","onboarding":true}'::jsonb,
        'system:radar-retention', $2)
    `, [row.account_reference, now]);
  }
  const stale = await client.query(`
    SELECT id, team_id, version
    FROM team_verifications
    WHERE method = 'profile_print_import' AND status = 'pending'
      AND (
        (ai_draft IS NULL AND processing_expires_at <= $1)
        OR evidence_delete_after <= $1
      )
    ORDER BY COALESCE(evidence_delete_after, processing_expires_at), id
    LIMIT $2::integer FOR UPDATE SKIP LOCKED
  `, [now, limit]);
  for (const row of stale.rows) {
    await client.query(`
      UPDATE radar_profile_print_import_requests
      SET state = 'failed', failure_code = 'processing_expired', updated_at = $2
      WHERE verification_id = $1 AND state = 'processing'
    `, [row.id, now]);
    await client.query(`
      UPDATE team_verifications
      SET status = 'expired', ai_draft = NULL, decided_at = $2,
          version = version + 1, updated_at = $2
      WHERE id = $1
    `, [row.id, now]);
    await client.query(`
      INSERT INTO match_audit_events(
        actor_team_id, actor_reference, event_type, entity_version,
        payload, request_id, created_at
      ) VALUES ($1, 'system:radar-retention', 'profile_print_import.expired', $2::integer,
        '{"method":"profile_print_import","status":"expired"}'::jsonb,
        'system:radar-retention', $3)
    `, [row.team_id, Number(row.version) + 1, now]);
  }
  return stale.rowCount + onboarding.rowCount;
}

async function eraseModerationDescriptions(client, now, limit) {
  const result = await client.query(`
    WITH candidates AS (
      SELECT id FROM radar_moderation_cases
      WHERE private_description IS NOT NULL AND description_erased_at IS NULL
        AND retention_expires_at <= $1
      ORDER BY retention_expires_at, id LIMIT $2::integer FOR UPDATE SKIP LOCKED
    )
    UPDATE radar_moderation_cases moderation_case
    SET private_description = NULL, description_erased_at = $1,
        version = moderation_case.version + 1, updated_at = $1
    FROM candidates WHERE moderation_case.id = candidates.id
    RETURNING moderation_case.id, moderation_case.version
  `, [now, limit]);
  for (const row of result.rows) {
    await client.query(`
      INSERT INTO radar_moderation_case_events(
        case_id, event_type, case_version, safe_payload, request_id, created_at
      ) VALUES ($1, 'description_erased', $2::integer, '{"reason":"retention"}'::jsonb,
        'system:radar-retention', $3)
    `, [row.id, row.version, now]);
  }
  return result.rowCount;
}

async function eraseMatchMessages(client, now, limit) {
  const result = await client.query(`
    WITH candidates AS (
      SELECT message.id
      FROM radar_match_messages message
      WHERE message.body IS NOT NULL
        AND message.retention_expires_at <= $1
        AND NOT EXISTS (
          SELECT 1 FROM radar_moderation_cases moderation_case
          WHERE moderation_case.message_id = message.id
            AND moderation_case.status IN ('open', 'assigned')
        )
      ORDER BY message.retention_expires_at, message.id
      LIMIT $2::integer FOR UPDATE OF message SKIP LOCKED
    )
    UPDATE radar_match_messages message
    SET body = NULL, body_erased_at = $1
    FROM candidates WHERE message.id = candidates.id
    RETURNING message.id
  `, [now, limit]);
  return result.rowCount;
}

async function cleanupTechnicalLimits(client, cutoff) {
  const tables = [
    "radar_verification_rate_limits", "radar_profile_print_rate_limits",
    "radar_search_rate_limits", "radar_invitation_rate_limits",
    "radar_match_history_rate_limits", "radar_moderation_rate_limits"
    , "radar_match_communication_rate_limits"
  ];
  let deleted = 0;
  for (const table of tables) {
    const result = await client.query(`DELETE FROM ${table} WHERE window_started_at < $1`, [cutoff]);
    deleted += result.rowCount;
  }
  return deleted;
}

async function runRadarRetention({ pool, config, now = new Date(), logger = console }) {
  if (!pool || typeof pool.connect !== "function") throw new TypeError("Radar retention requires PostgreSQL");
  if (!(now instanceof Date) || Number.isNaN(now.getTime())) throw new TypeError("Invalid retention clock");
  const client = await pool.connect();
  let locked = false;
  let open = false;
  try {
    const lock = await client.query("SELECT pg_try_advisory_lock($1) AS locked", [RETENTION_LOCK_ID]);
    locked = lock.rows?.[0]?.locked === true;
    if (!locked) return Object.freeze({ ok: true, lock_acquired: false, skipped: "already_running" });
    await client.query("BEGIN");
    open = true;
    const limit = Number(config?.retentionBatchMaximum || 500);
    const cutoff = new Date(now.getTime() - Number(config?.technicalRetentionDays || 14) * 86_400_000);
    const result = {
      ok: true,
      lock_acquired: true,
      availabilities_expired: await expireAvailabilities(client, now, limit),
      invitations_expired: await expireInvitations(client, now, limit),
      instagram_challenges_expired: await expireInstagramChallenges(client, now, limit),
      profile_print_drafts_expired: await expireProfilePrintDrafts(client, now, limit),
      moderation_descriptions_erased: await eraseModerationDescriptions(client, now, limit),
      match_messages_erased: await eraseMatchMessages(client, now, limit),
      technical_rows_deleted: await cleanupTechnicalLimits(client, cutoff),
      audit_rows_deleted: 0
    };
    await client.query("COMMIT");
    open = false;
    logger.info?.("radar.retention.completed", { result: "ok", count: Object.values(result).filter(Number.isFinite).reduce((sum, value) => sum + value, 0) });
    return Object.freeze(result);
  } catch (error) {
    if (open) {
      try { await client.query("ROLLBACK"); } catch {}
    }
    logger.error?.("radar.retention.failed", { error: error?.name || "Error" });
    throw error;
  } finally {
    if (locked) {
      try { await client.query("SELECT pg_advisory_unlock($1)", [RETENTION_LOCK_ID]); } catch {}
    }
    client.release();
  }
}

module.exports = { RETENTION_LOCK_ID, runRadarRetention };
