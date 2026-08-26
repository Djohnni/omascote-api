"use strict";

const crypto = require("node:crypto");
const { RadarIdentityError } = require("./radar-identity.errors");
const { rowToTeam } = require("./radar-identity.repository");
const { assertRadarTeamOwnedByIdentity, assertRadarTeamCanMutate } = require("./radar-identity.policy");
const { moderationError } = require("./radar-moderation.schemas");

async function rollbackQuietly(client, open) {
  if (!open) return;
  try { await client.query("ROLLBACK"); } catch {}
}

function normalizeDatabaseError(error) {
  if (error instanceof RadarIdentityError) return error;
  const constraint = String(error?.constraint || error?.message || "");
  if (error?.code === "23505" && constraint.includes("radar_moderation_open_dispute_idx")) {
    return moderationError("RADAR_DISPUTE_ALREADY_OPEN", 409, "Ja existe uma contestacao aberta para esta partida.");
  }
  if (error?.code === "23505" && constraint.includes("radar_review_moderation_compensations")) {
    return moderationError("RADAR_REVIEW_ALREADY_INVALIDATED", 409, "A avaliacao ja foi invalidada.");
  }
  if (error?.code === "23505" && constraint.includes("radar_match_statistic_compensations")) {
    return moderationError("RADAR_RESULT_ALREADY_INVALIDATED", 409, "O resultado ja foi invalidado.");
  }
  return error;
}

function safeTeam(row, prefix = "") {
  return Object.freeze({
    public_id: row[`${prefix}public_id`] || null,
    slug: row[`${prefix}public_slug`] || null,
    name: row[`${prefix}public_name`] || "Time removido"
  });
}

function caseSnapshot(row, { includePrivate = false } = {}) {
  const result = {
    case_id: row.public_id,
    type: row.case_type,
    category: row.category,
    status: row.status,
    version: Number(row.version),
    reported_team: safeTeam(row, "reported_"),
    match_id: row.match_public_id || null,
    assigned: Boolean(row.assigned_to_account_reference),
    resolution: row.resolution_action ? Object.freeze({
      action: row.resolution_action,
      reason: row.resolution_reason,
      resolved_at: row.resolved_at
    }) : null,
    created_at: row.created_at,
    updated_at: row.updated_at
  };
  if (includePrivate) {
    result.description = row.private_description || null;
    result.reporter_team = safeTeam(row, "reporter_");
    if (row.case_type === "message_report") {
      result.reported_message = Object.freeze({
        message_id: row.message_public_id || null,
        texto: row.message_body || null,
        removed: row.message_body === null
      });
    }
    result.moderation_due_at = row.moderation_due_at;
  }
  return Object.freeze(result);
}

async function loadOwnedTeam(client, identity, { allowDeparted = false, lock = false } = {}) {
  const result = await client.query(`
    SELECT * FROM radar_team_profiles
    WHERE legacy_profile_id = $1
    ${lock ? "FOR UPDATE" : ""}
  `, [identity.profileId]);
  if (result.rowCount !== 1) {
    throw moderationError("RADAR_PROFILE_NOT_FOUND", 409, "Perfil do Radar indisponivel.");
  }
  const team = rowToTeam(result.rows[0]);
  assertRadarTeamOwnedByIdentity(team, identity);
  if (!allowDeparted) assertRadarTeamCanMutate(team);
  return team;
}

async function replay(client, values) {
  const result = await client.query(`
    SELECT payload_hash, radar_team_id, result_snapshot
    FROM radar_moderation_mutation_requests
    WHERE account_reference = $1 AND operation = $2 AND idempotency_key = $3
  `, [values.identity.accountId, values.operation, values.idempotencyKey]);
  if (!result.rowCount) return null;
  const row = result.rows[0];
  if (row.payload_hash !== values.payloadHash || (values.teamId && row.radar_team_id !== values.teamId)) {
    throw moderationError("IDEMPOTENCY_KEY_REUSED", 409, "Idempotency-Key ja utilizada com outros dados.");
  }
  return Object.freeze({ ...row.result_snapshot, replayed: true });
}

async function saveMutation(client, values, result, caseId = null) {
  await client.query(`
    INSERT INTO radar_moderation_mutation_requests(
      account_reference, operation, idempotency_key, payload_hash,
      radar_team_id, case_id, result_snapshot
    ) VALUES ($1, $2, $3, $4, $5, $6, $7::jsonb)
  `, [
    values.identity.accountId, values.operation, values.idempotencyKey,
    values.payloadHash, values.teamId || null, caseId, JSON.stringify(result)
  ]);
}

async function consumeLimits(client, values, teamId, config) {
  const windowMs = config.moderationRateWindowSeconds * 1000;
  const started = new Date(Math.floor(values.now.getTime() / windowMs) * windowMs);
  const teamHash = crypto.createHmac("sha256", config.moderationSecuritySecret)
    .update("radar-moderation-team-v1\0").update(teamId).digest("hex");
  const scopes = [
    ["account", values.accountHash, config.moderationAccountLimit],
    ["team", teamHash, config.moderationTeamLimit],
    ["ip", values.ipHash, config.moderationIpLimit]
  ];
  for (const [type, hash, limit] of scopes) {
    const result = await client.query(`
      INSERT INTO radar_moderation_rate_limits(
        operation, scope_type, scope_hash, window_started_at, request_count, updated_at
      ) VALUES ($1, $2, $3, $4, 1, $5)
      ON CONFLICT (operation, scope_type, scope_hash, window_started_at)
      DO UPDATE SET request_count = radar_moderation_rate_limits.request_count + 1,
                    updated_at = EXCLUDED.updated_at
      WHERE radar_moderation_rate_limits.request_count < $6
      RETURNING request_count
    `, [values.operation, type, hash, started, values.now, limit]);
    if (!result.rowCount) {
      throw moderationError("RADAR_MODERATION_RATE_LIMITED", 429, "Limite de operacoes atingido. Aguarde e tente novamente.");
    }
  }
}

async function audit(client, { matchId = null, invitationId = null, teamId = null, accountReference, type, version, payload, requestId }) {
  await client.query(`
    INSERT INTO match_audit_events(
      match_id, invitation_id, actor_team_id, actor_reference,
      event_type, entity_version, payload, request_id
    ) VALUES ($1, $2, $3, $4, $5, $6, $7::jsonb, $8)
  `, [matchId, invitationId, teamId, accountReference, type, version, JSON.stringify(payload || {}), requestId]);
}

async function caseEvent(client, row, values, type, payload = {}) {
  await client.query(`
    INSERT INTO radar_moderation_case_events(
      case_id, actor_team_id, actor_account_reference,
      event_type, case_version, safe_payload, request_id
    ) VALUES ($1, $2, $3, $4, $5, $6::jsonb, $7)
  `, [row.id, values.teamId || null, values.identity.accountId, type, row.version, JSON.stringify(payload), values.requestId]);
}

async function notify(client, teamId, type, row) {
  if (!teamId) return;
  await client.query(`
    INSERT INTO notifications(
      recipient_team_id, event_type, entity_type, entity_public_id,
      payload, deduplication_key
    ) VALUES ($1, $2, 'moderation_case', $3, $4::jsonb, $5)
    ON CONFLICT (recipient_team_id, deduplication_key) DO NOTHING
  `, [teamId, type, row.public_id, JSON.stringify({
    case_id: row.public_id,
    status: row.status,
    category: row.category,
    version: Number(row.version)
  }), `${type}:${row.public_id}:v${row.version}`]);
}

async function eraseExpiredDescriptions(client, now) {
  const expired = await client.query(`
    UPDATE radar_moderation_cases
    SET private_description = NULL, description_erased_at = $1,
        version = version + 1, updated_at = $1
    WHERE private_description IS NOT NULL
      AND description_erased_at IS NULL
      AND retention_expires_at <= $1
    RETURNING id, version
  `, [now]);
  for (const row of expired.rows) {
    await client.query(`
      INSERT INTO radar_moderation_case_events(
        case_id, event_type, case_version, safe_payload, created_at
      ) VALUES ($1, 'description_erased', $2, '{"reason":"retention"}'::jsonb, $3)
    `, [row.id, row.version, now]);
  }
}

function createRadarModerationRepository({ pool, config }) {
  if (!pool || typeof pool.connect !== "function") throw new TypeError("Radar moderation repository requires PostgreSQL");

  async function transaction(work) {
    const client = await pool.connect();
    let open = false;
    try {
      await client.query("BEGIN"); open = true;
      const result = await work(client);
      await client.query("COMMIT"); open = false;
      return result;
    } catch (error) {
      await rollbackQuietly(client, open);
      throw normalizeDatabaseError(error);
    } finally { client.release(); }
  }

  async function listBlocks({ identity }) {
    return transaction(async client => {
      const team = await loadOwnedTeam(client, identity);
      const result = await client.query(`
        SELECT block.created_at, block.private_reason,
               target.public_id, target.public_slug, target.public_name
        FROM team_blocks block
        JOIN radar_team_profiles target ON target.id = block.blocked_team_id
        WHERE block.blocker_team_id = $1
        ORDER BY block.created_at DESC, target.public_id DESC
      `, [team.id]);
      return Object.freeze({ items: Object.freeze(result.rows.map(row => Object.freeze({
        team: safeTeam(row), reason: row.private_reason, blocked_at: row.created_at
      }))) });
    });
  }

  async function block(values) {
    return transaction(async client => {
      const team = await loadOwnedTeam(client, values.identity, { lock: true });
      values.teamId = team.id;
      await client.query("SELECT pg_advisory_xact_lock(hashtext($1))", [`${values.identity.accountId}:block:${values.idempotencyKey}`]);
      const repeated = await replay(client, values); if (repeated) return repeated;
      await consumeLimits(client, values, team.id, config);
      const targetResult = await client.query(`
        SELECT * FROM radar_team_profiles
        WHERE public_id = $1 AND radar_departed_at IS NULL
        FOR UPDATE
      `, [values.value.teamPublicId]);
      if (targetResult.rowCount !== 1) throw moderationError("RADAR_TEAM_NOT_FOUND", 404, "Time nao encontrado.");
      const target = rowToTeam(targetResult.rows[0]);
      if (target.id === team.id) throw moderationError("RADAR_SELF_BLOCK_FORBIDDEN", 400, "Um time nao pode bloquear a si mesmo.");
      const inserted = await client.query(`
        INSERT INTO team_blocks(blocker_team_id, blocked_team_id, private_reason, created_at)
        VALUES ($1, $2, $3, $4)
        ON CONFLICT (blocker_team_id, blocked_team_id) DO NOTHING
        RETURNING id
      `, [team.id, target.id, values.value.reason, values.now]);
      const cancelled = await client.query(`
        UPDATE friendly_invitations
        SET state = 'cancelled', cancelled_at = $3,
            version = version + 1, updated_at = $3
        WHERE ((requester_team_id = $1 AND invited_team_id = $2)
            OR (requester_team_id = $2 AND invited_team_id = $1))
          AND state IN ('pending', 'counter_proposed')
        RETURNING id, public_id, version
      `, [team.id, target.id, values.now]);
      for (const invitation of cancelled.rows) {
        await audit(client, {
          invitationId: invitation.id, teamId: team.id, accountReference: values.identity.accountId,
          type: "friendly_invitation.closed_by_block", version: invitation.version,
          payload: { state: "cancelled" }, requestId: values.requestId
        });
      }
      await audit(client, {
        teamId: team.id, accountReference: values.identity.accountId,
        type: "radar_team.blocked", version: team.version,
        payload: { target_team_public_id: target.publicId, reason: values.value.reason, invitations_closed: cancelled.rowCount },
        requestId: values.requestId
      });
      const result = Object.freeze({
        blocked: true, already_blocked: inserted.rowCount === 0,
        team: Object.freeze({ public_id: target.publicId, slug: target.publicSlug, name: target.publicName }),
        pending_invitations_closed: cancelled.rowCount, replayed: false
      });
      await saveMutation(client, values, result);
      return result;
    });
  }

  async function unblock(values) {
    return transaction(async client => {
      const team = await loadOwnedTeam(client, values.identity, { lock: true });
      values.teamId = team.id;
      await client.query("SELECT pg_advisory_xact_lock(hashtext($1))", [`${values.identity.accountId}:unblock:${values.idempotencyKey}`]);
      const repeated = await replay(client, values); if (repeated) return repeated;
      await consumeLimits(client, values, team.id, config);
      const target = await client.query("SELECT id, public_id FROM radar_team_profiles WHERE public_id = $1", [values.value.teamPublicId]);
      if (target.rowCount !== 1) throw moderationError("RADAR_TEAM_NOT_FOUND", 404, "Time nao encontrado.");
      const removed = await client.query(`
        DELETE FROM team_blocks WHERE blocker_team_id = $1 AND blocked_team_id = $2 RETURNING id
      `, [team.id, target.rows[0].id]);
      await audit(client, {
        teamId: team.id, accountReference: values.identity.accountId,
        type: "radar_team.unblocked", version: team.version,
        payload: { target_team_public_id: target.rows[0].public_id, removed: removed.rowCount === 1 },
        requestId: values.requestId
      });
      const result = Object.freeze({ unblocked: true, was_blocked: removed.rowCount === 1, replayed: false });
      await saveMutation(client, values, result);
      return result;
    });
  }

  async function resolveCaseTarget(client, team, value, operation) {
    if (operation === "report" && value.type === "time") {
      const result = await client.query(`
        SELECT id, public_id FROM radar_team_profiles
        WHERE public_id = $1 AND radar_departed_at IS NULL
          AND suspended_at IS NULL AND radar_visible = true
      `, [value.teamPublicId]);
      if (result.rowCount !== 1 || result.rows[0].id === team.id) {
        throw moderationError("RADAR_REPORT_TARGET_NOT_FOUND", 404, "Alvo nao encontrado.");
      }
      return { reportedTeamId: result.rows[0].id, matchId: null, matchPublicId: null, caseType: "team_report" };
    }
    const matchPublicId = operation === "dispute" ? value.matchPublicId : value.matchPublicId;
    const result = await client.query(`
      SELECT match.id, match.public_id, match.team_a_id, match.team_b_id, match.result_state,
             match.occurrence_state
      FROM friendly_matches match
      WHERE match.public_id = $1 AND (match.team_a_id = $2 OR match.team_b_id = $2)
    `, [matchPublicId, team.id]);
    if (result.rowCount !== 1) throw moderationError("RADAR_REPORT_TARGET_NOT_FOUND", 404, "Partida nao encontrada.");
    const match = result.rows[0];
    if (operation === "dispute" && (match.occurrence_state !== "played" || !["verified", "divergent"].includes(match.result_state))) {
      throw moderationError("RADAR_DISPUTE_NOT_ELIGIBLE", 409, "Este resultado nao pode ser contestado.");
    }
    return {
      reportedTeamId: match.team_a_id === team.id ? match.team_b_id : match.team_a_id,
      matchId: match.id, matchPublicId: match.public_id,
      caseType: operation === "dispute" ? "result_dispute" : "match_report"
    };
  }

  async function createCase(values) {
    return transaction(async client => {
      const team = await loadOwnedTeam(client, values.identity, { lock: true });
      values.teamId = team.id;
      await client.query("SELECT pg_advisory_xact_lock(hashtext($1))", [`${values.identity.accountId}:${values.operation}:${values.idempotencyKey}`]);
      const repeated = await replay(client, values); if (repeated) return repeated;
      await consumeLimits(client, values, team.id, config);
      const target = await resolveCaseTarget(client, team, values.value, values.operation);
      const retention = new Date(values.now.getTime() + config.moderationRetentionDays * 86400000);
      const due = config.moderationSlaHours
        ? new Date(values.now.getTime() + config.moderationSlaHours * 3600000)
        : null;
      const inserted = await client.query(`
        INSERT INTO radar_moderation_cases(
          case_type, reporter_team_id, reported_team_id, match_id,
          category, private_description, moderation_due_at,
          retention_expires_at, created_at, updated_at
        ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $9)
        RETURNING *
      `, [
        target.caseType, team.id, target.reportedTeamId, target.matchId,
        values.value.category, values.value.description, due, retention, values.now
      ]);
      const row = inserted.rows[0];
      await caseEvent(client, row, values, "created", { case_type: row.case_type, category: row.category });
      await audit(client, {
        matchId: target.matchId, teamId: team.id, accountReference: values.identity.accountId,
        type: `radar_moderation.${target.caseType}_created`, version: 1,
        payload: { case_id: row.public_id, category: row.category }, requestId: values.requestId
      });
      const result = Object.freeze({ case: Object.freeze({
        case_id: row.public_id, type: row.case_type, category: row.category,
        status: row.status, version: 1, created_at: row.created_at
      }), replayed: false });
      await saveMutation(client, values, result, row.id);
      return result;
    });
  }

  async function listOwnerCases({ identity, now }) {
    return transaction(async client => {
      const team = await loadOwnedTeam(client, identity);
      await eraseExpiredDescriptions(client, now);
      const result = await client.query(`
        SELECT case_row.*, reported.public_id AS reported_public_id,
          reported.public_slug AS reported_public_slug, reported.public_name AS reported_public_name,
          match.public_id AS match_public_id
        FROM radar_moderation_cases case_row
        JOIN radar_team_profiles reported ON reported.id = case_row.reported_team_id
        LEFT JOIN friendly_matches match ON match.id = case_row.match_id
        WHERE case_row.reporter_team_id = $1
        ORDER BY case_row.created_at DESC, case_row.public_id DESC
        LIMIT $2
      `, [team.id, config.moderationPageMaximum]);
      return Object.freeze({ items: Object.freeze(result.rows.map(row => caseSnapshot(row))) });
    });
  }

  async function exitRadar(values) {
    return transaction(async client => {
      const team = await loadOwnedTeam(client, values.identity, { allowDeparted: true, lock: true });
      values.teamId = team.id;
      await client.query("SELECT pg_advisory_xact_lock(hashtext($1))", [`${values.identity.accountId}:radar_exit:${values.idempotencyKey}`]);
      const repeated = await replay(client, values); if (repeated) return repeated;
      if (team.departedAt) throw moderationError("RADAR_ALREADY_EXITED", 409, "O time ja saiu do Radar.");
      await consumeLimits(client, values, team.id, config);
      const availabilities = await client.query(`
        UPDATE friendly_availabilities
        SET status = 'cancelled', version = version + 1, updated_at = $2
        WHERE team_id = $1 AND status IN ('active', 'paused')
        RETURNING id
      `, [team.id, values.now]);
      const invitations = await client.query(`
        UPDATE friendly_invitations
        SET state = 'cancelled', cancelled_at = $2,
            version = version + 1, updated_at = $2
        WHERE (requester_team_id = $1 OR invited_team_id = $1)
          AND state IN ('pending', 'counter_proposed')
        RETURNING id, version
      `, [team.id, values.now]);
      await client.query("DELETE FROM team_blocks WHERE blocker_team_id = $1 OR blocked_team_id = $1", [team.id]);
      await client.query("DELETE FROM notifications WHERE recipient_team_id = $1", [team.id]);
      const erasedCases = await client.query(`
        UPDATE radar_moderation_cases
        SET reporter_team_id = NULL, private_description = NULL,
            description_erased_at = COALESCE(description_erased_at, $2),
            version = version + 1, updated_at = $2
        WHERE reporter_team_id = $1
        RETURNING id, version
      `, [team.id, values.now]);
      for (const row of erasedCases.rows) {
        await client.query(`
          INSERT INTO radar_moderation_case_events(
            case_id, actor_team_id, actor_account_reference,
            event_type, case_version, safe_payload, request_id, created_at
          ) VALUES ($1, $2, $3, 'description_erased', $4, '{"reason":"radar_exit"}'::jsonb, $5, $6)
        `, [row.id, team.id, values.identity.accountId, row.version, values.requestId, values.now]);
      }
      const pseudonym = crypto.createHmac("sha256", config.moderationSecuritySecret)
        .update("radar-departure-account-v1\0").update(values.identity.accountId).digest("hex");
      await client.query(`
        INSERT INTO radar_departure_records(
          team_id, account_pseudonym, invitation_count, availability_count, requested_at
        ) VALUES ($1, $2, $3, $4, $5)
      `, [team.id, pseudonym, invitations.rowCount, availabilities.rowCount, values.now]);
      const updated = await client.query(`
        UPDATE radar_team_profiles SET
          public_slug = NULL, status = 'paused', instagram_handle = NULL,
          instagram_verification_status = 'unverified', city_ibge_code = NULL,
          city_name = NULL, state_code = NULL, approximate_latitude = NULL,
          approximate_longitude = NULL, modalities = '{}', categories = '{}',
          availability_active = false, radar_terms_accepted_at = NULL,
          public_name = 'Time removido', public_profile_enabled = false,
          public_crest_available = false, radar_visible = false, radar_departed_at = $2,
          version = version + 1, updated_at = $2
        WHERE id = $1 RETURNING version
      `, [team.id, values.now]);
      await audit(client, {
        teamId: team.id, accountReference: values.identity.accountId,
        type: "radar_privacy.departed", version: updated.rows[0].version,
        payload: { invitations_closed: invitations.rowCount, availabilities_closed: availabilities.rowCount },
        requestId: values.requestId
      });
      const result = Object.freeze({
        exited: true, profile_hidden: true,
        pending_invitations_closed: invitations.rowCount,
        availabilities_closed: availabilities.rowCount, replayed: false
      });
      await saveMutation(client, values, result);
      return result;
    });
  }

  async function moderatorRole(client, identity) {
    const role = await client.query(`
      SELECT role FROM radar_account_roles
      WHERE account_reference = $1
        AND role IN ('radar_moderator', 'radar_admin')
        AND active = true AND revoked_at IS NULL
      ORDER BY CASE role WHEN 'radar_admin' THEN 0 ELSE 1 END LIMIT 1
    `, [identity.accountId]);
    if (role.rowCount !== 1) throw moderationError("RADAR_MODERATION_FORBIDDEN", 403, "Acesso restrito a moderacao.");
    const own = await client.query(`
      SELECT id FROM radar_team_profiles
      WHERE account_reference = $1 OR legacy_profile_id = $2 LIMIT 1
    `, [identity.accountId, identity.profileId]);
    return { role: role.rows[0].role, ownTeamId: own.rows[0]?.id || null };
  }

  function assertIndependent(moderator, row) {
    if (moderator.ownTeamId && [row.reporter_team_id, row.reported_team_id].includes(moderator.ownTeamId)) {
      throw moderationError("RADAR_MODERATION_SELF_CASE_FORBIDDEN", 403, "O moderador nao pode decidir caso do proprio time.");
    }
  }

  const ADMIN_CASE_SELECT = `
    SELECT case_row.*,
      reported.public_id AS reported_public_id, reported.public_slug AS reported_public_slug,
      reported.public_name AS reported_public_name,
      reporter.public_id AS reporter_public_id, reporter.public_slug AS reporter_public_slug,
      reporter.public_name AS reporter_public_name,
      match.public_id AS match_public_id,
      message.public_id AS message_public_id,
      message.body AS message_body
    FROM radar_moderation_cases case_row
    JOIN radar_team_profiles reported ON reported.id = case_row.reported_team_id
    LEFT JOIN radar_team_profiles reporter ON reporter.id = case_row.reporter_team_id
    LEFT JOIN friendly_matches match ON match.id = case_row.match_id
    LEFT JOIN radar_match_messages message ON message.id = case_row.message_id
  `;

  async function adminQueue({ identity, limit, now }) {
    return transaction(async client => {
      await moderatorRole(client, identity);
      await eraseExpiredDescriptions(client, now);
      const result = await client.query(`${ADMIN_CASE_SELECT}
        WHERE case_row.status IN ('open', 'assigned')
        ORDER BY case_row.moderation_due_at NULLS LAST, case_row.created_at, case_row.public_id
        LIMIT $1
      `, [limit]);
      return Object.freeze({ items: Object.freeze(result.rows.map(row => caseSnapshot(row, { includePrivate: true }))) });
    });
  }

  async function adminMutation(values, operation) {
    return transaction(async client => {
      const moderator = await moderatorRole(client, values.identity);
      await client.query("SELECT pg_advisory_xact_lock(hashtext($1))", [`${values.identity.accountId}:${operation}:${values.idempotencyKey}`]);
      const repeated = await replay(client, values); if (repeated) return repeated;
      const found = await client.query(`${ADMIN_CASE_SELECT}
        WHERE case_row.public_id = $1 FOR UPDATE OF case_row
      `, [values.value.casePublicId]);
      if (found.rowCount !== 1) throw moderationError("RADAR_MODERATION_CASE_NOT_FOUND", 404, "Caso nao encontrado.");
      const row = found.rows[0];
      assertIndependent(moderator, row);
      if (Number(row.version) !== values.value.expectedVersion) {
        throw moderationError("RADAR_MODERATION_VERSION_CONFLICT", 409, "O caso mudou. Atualize e tente novamente.");
      }
      if (["resolved", "dismissed"].includes(row.status)) {
        throw moderationError("RADAR_MODERATION_CASE_TERMINAL", 409, "O caso ja foi encerrado.");
      }
      values.teamId = moderator.ownTeamId;
      if (operation === "assign_case") {
        const updated = await client.query(`
          UPDATE radar_moderation_cases
          SET status = 'assigned', assigned_to_account_reference = $2,
              version = version + 1, updated_at = $3
          WHERE id = $1 RETURNING *
        `, [row.id, values.identity.accountId, values.now]);
        const current = { ...row, ...updated.rows[0] };
        await caseEvent(client, current, values, "assigned", { reason: values.value.reason, role: moderator.role });
        const result = Object.freeze({ case: caseSnapshot(current, { includePrivate: true }), replayed: false });
        await saveMutation(client, values, result, row.id);
        return result;
      }
      if (row.assigned_to_account_reference && row.assigned_to_account_reference !== values.identity.accountId && moderator.role !== "radar_admin") {
        throw moderationError("RADAR_MODERATION_ASSIGNMENT_FORBIDDEN", 403, "Caso atribuido a outro moderador.");
      }
      await applyResolution(client, row, values);
      const status = values.value.action === "dismiss" ? "dismissed" : "resolved";
      const updated = await client.query(`
        UPDATE radar_moderation_cases
        SET status = $2, assigned_to_account_reference = COALESCE(assigned_to_account_reference, $3),
            resolution_action = $4, resolution_reason = $5, resolved_at = $6,
            version = version + 1, updated_at = $6
        WHERE id = $1 RETURNING *
      `, [row.id, status, values.identity.accountId, values.value.action, values.value.reason, values.now]);
      const current = { ...row, ...updated.rows[0] };
      await caseEvent(client, current, values, status === "dismissed" ? "dismissed" : "resolved", {
        action: values.value.action, reason: values.value.reason, role: moderator.role
      });
      await audit(client, {
        matchId: row.match_id, accountReference: values.identity.accountId,
        type: "radar_moderation.case_resolved", version: current.version,
        payload: { case_id: row.public_id, action: values.value.action, reason: values.value.reason },
        requestId: values.requestId
      });
      await notify(client, row.reporter_team_id, "moderation_case_resolved", current);
      const result = Object.freeze({ case: caseSnapshot(current, { includePrivate: true }), replayed: false });
      await saveMutation(client, values, result, row.id);
      return result;
    });
  }

  async function compensateReview(client, review, row, values) {
    const inserted = await client.query(`
      INSERT INTO radar_review_moderation_compensations(
        case_id, review_id, reviewed_team_id, punctuality, organization,
        communication, fair_play, would_play_again,
        applied_by_account_reference, applied_at
      ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)
      ON CONFLICT (review_id) DO NOTHING RETURNING id
    `, [
      row.id, review.id, review.reviewed_team_id, review.punctuality,
      review.organization, review.communication, review.fair_play,
      review.would_play_again, values.identity.accountId, values.now
    ]);
    if (!inserted.rowCount) return false;
    const aggregate = await client.query(`
      UPDATE team_reputation_aggregates SET
        verified_review_count = verified_review_count - 1,
        punctuality_sum = punctuality_sum - $2,
        organization_sum = organization_sum - $3,
        communication_sum = communication_sum - $4,
        fair_play_sum = fair_play_sum - $5,
        would_play_again_count = would_play_again_count - $6,
        version = version + 1, updated_at = $7
      WHERE team_id = $1
        AND verified_review_count >= 1
        AND punctuality_sum >= $2 AND organization_sum >= $3
        AND communication_sum >= $4 AND fair_play_sum >= $5
        AND would_play_again_count >= $6
      RETURNING team_id
    `, [
      review.reviewed_team_id, review.punctuality, review.organization,
      review.communication, review.fair_play, review.would_play_again ? 1 : 0, values.now
    ]);
    if (!aggregate.rowCount) throw moderationError("RADAR_REPUTATION_COMPENSATION_CONFLICT", 409, "Nao foi possivel compensar a reputacao.");
    return true;
  }

  async function compensateMatchStatistics(client, row, values) {
    const application = await client.query("SELECT * FROM radar_match_statistic_applications WHERE match_id = $1 FOR UPDATE", [row.match_id]);
    if (application.rowCount !== 1) throw moderationError("RADAR_RESULT_COMPENSATION_UNAVAILABLE", 409, "Estatisticas do resultado indisponiveis.");
    const item = application.rows[0];
    const inserted = await client.query(`
      INSERT INTO radar_match_statistic_compensations(
        case_id, match_id, team_a_id, team_b_id, team_a_goals, team_b_goals,
        applied_by_account_reference, applied_at
      ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
      ON CONFLICT (match_id) DO NOTHING RETURNING id
    `, [row.id, item.match_id, item.team_a_id, item.team_b_id, item.team_a_goals, item.team_b_goals, values.identity.accountId, values.now]);
    if (!inserted.rowCount) throw moderationError("RADAR_RESULT_ALREADY_INVALIDATED", 409, "O resultado ja foi invalidado.");
    const aWin = item.team_a_goals > item.team_b_goals ? 1 : 0;
    const draw = item.team_a_goals === item.team_b_goals ? 1 : 0;
    const aLoss = item.team_a_goals < item.team_b_goals ? 1 : 0;
    for (const [teamId, win, loss, gf, ga] of [
      [item.team_a_id, aWin, aLoss, item.team_a_goals, item.team_b_goals],
      [item.team_b_id, aLoss, aWin, item.team_b_goals, item.team_a_goals]
    ]) {
      const updated = await client.query(`
        UPDATE radar_team_verified_statistics SET
          matches_played = matches_played - 1, wins = wins - $2,
          draws = draws - $3, losses = losses - $4,
          goals_for = goals_for - $5, goals_against = goals_against - $6,
          version = version + 1, updated_at = $7
        WHERE team_id = $1 AND matches_played >= 1
          AND wins >= $2 AND draws >= $3 AND losses >= $4
          AND goals_for >= $5 AND goals_against >= $6
        RETURNING team_id
      `, [teamId, win, draw, loss, gf, ga, values.now]);
      if (!updated.rowCount) throw moderationError("RADAR_RESULT_COMPENSATION_CONFLICT", 409, "Nao foi possivel compensar as estatisticas.");
    }
    const reviews = await client.query("SELECT * FROM team_reviews WHERE match_id = $1 ORDER BY id FOR UPDATE", [row.match_id]);
    for (const review of reviews.rows) await compensateReview(client, review, row, values);
  }

  async function applyResolution(client, row, values) {
    if (values.value.action === "invalidate_review") {
      if (!row.match_id) throw moderationError("RADAR_REVIEW_COMPENSATION_UNAVAILABLE", 409, "O caso nao possui partida.");
      const review = await client.query(`
        SELECT * FROM team_reviews
        WHERE match_id = $1 AND reviewer_team_id = $2
        FOR UPDATE
      `, [row.match_id, row.reported_team_id]);
      if (review.rowCount !== 1) throw moderationError("RADAR_REVIEW_COMPENSATION_UNAVAILABLE", 409, "Avaliacao nao encontrada.");
      const applied = await compensateReview(client, review.rows[0], row, values);
      if (!applied) throw moderationError("RADAR_REVIEW_ALREADY_INVALIDATED", 409, "A avaliacao ja foi invalidada.");
    } else if (values.value.action === "invalidate_result") {
      if (!row.match_id) throw moderationError("RADAR_RESULT_COMPENSATION_UNAVAILABLE", 409, "O caso nao possui partida.");
      await compensateMatchStatistics(client, row, values);
    } else if (values.value.action === "suspend_team") {
      await client.query(`
        UPDATE radar_team_profiles SET status = 'suspended', suspended_at = $2,
          suspension_reason = 'moderation', availability_active = false,
          version = version + 1, updated_at = $2
        WHERE id = $1
      `, [row.reported_team_id, values.now]);
      await client.query(`
        UPDATE friendly_invitations SET state = 'cancelled', cancelled_at = $2,
          version = version + 1, updated_at = $2
        WHERE (requester_team_id = $1 OR invited_team_id = $1)
          AND state IN ('pending', 'counter_proposed')
      `, [row.reported_team_id, values.now]);
    }
  }

  return Object.freeze({
    listBlocks, block, unblock, createCase, listOwnerCases, exitRadar,
    adminQueue,
    assignCase: values => adminMutation(values, "assign_case"),
    resolveCase: values => adminMutation(values, "resolve_case")
  });
}

module.exports = {
  createRadarModerationRepository,
  normalizeDatabaseError,
  caseSnapshot
};
