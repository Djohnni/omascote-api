"use strict";

const { RadarIdentityError } = require("./radar-identity.errors");
const { rowToTeam } = require("./radar-identity.repository");
const {
  assertRadarTeamOwnedByIdentity,
  assertRadarTeamCanMutate
} = require("./radar-identity.policy");
const { matchError } = require("./match-center.schemas");

function publicTeam(snapshot) {
  const value = snapshot && typeof snapshot === "object" ? snapshot : {};
  return Object.freeze({
    slug: String(value.slug || ""),
    name: String(value.name || ""),
    city: String(value.city || ""),
    state: String(value.state || "")
  });
}

function publicScore(submission, viewerIsTeamA) {
  if (!submission || typeof submission !== "object") return null;
  const myGoals = viewerIsTeamA ? submission.team_a_goals : submission.team_b_goals;
  const opponentGoals = viewerIsTeamA ? submission.team_b_goals : submission.team_a_goals;
  if (!Number.isInteger(Number(myGoals)) || !Number.isInteger(Number(opponentGoals))) return null;
  return Object.freeze({
    gols_meu_time: Number(myGoals),
    gols_adversario: Number(opponentGoals),
    informado_em: submission.created_at || null
  });
}

function rowToMatch(row, viewerTeamId) {
  const isTeamA = row.team_a_id === viewerTeamId;
  const opponent = publicTeam(isTeamA ? row.team_b_snapshot : row.team_a_snapshot);
  const proposal = row.proposal && typeof row.proposal === "object" ? row.proposal : {};
  const confirmedByMe = isTeamA ? row.team_a_confirmed : row.team_b_confirmed;
  const confirmedByOpponent = isTeamA ? row.team_b_confirmed : row.team_a_confirmed;
  const cancelled = row.occurrence_state === "cancelled";
  const mySubmission = isTeamA ? row.team_a_result_submission : row.team_b_result_submission;
  const opponentSubmission = isTeamA ? row.team_b_result_submission : row.team_a_result_submission;
  const officialScore = row.result_state === "verified" && row.result_invalidated !== true
    ? Object.freeze({
        gols_meu_time: Number(isTeamA ? row.verified_team_a_goals : row.verified_team_b_goals),
        gols_adversario: Number(isTeamA ? row.verified_team_b_goals : row.verified_team_a_goals),
        confirmado_em: row.verified_result_at || null
      })
    : null;
  return Object.freeze({
    match_id: row.public_id,
    state: row.occurrence_state,
    version: Number(row.version),
    opponent,
    scheduled_at: row.scheduled_at,
    modality: proposal.modality || null,
    category: proposal.category || null,
    city: proposal.city || opponent.city || null,
    state_code: proposal.state || opponent.state || null,
    venue_preference: proposal.venue_preference || null,
    confirmation: Object.freeze({
      by_me: confirmedByMe === true,
      by_opponent: confirmedByOpponent === true,
      total: Number(row.confirmation_count || 0),
      confirmed_at: row.occurrence_confirmed_at || null
    }),
    cancellation: cancelled ? Object.freeze({
      reason: row.cancellation_reason,
      by_me: row.cancelled_by_team_id === viewerTeamId,
      cancelled_at: row.cancelled_at
    }) : null,
    result: Object.freeze({
      state: row.result_invalidated === true ? "invalidated" : (row.result_state || "empty"),
      meu_placar: publicScore(mySubmission, isTeamA),
      placar_adversario: publicScore(opponentSubmission, isTeamA),
      placar_oficial: officialScore
    }),
    contact_unlocked: row.contact_blocked !== true,
    created_at: row.created_at,
    updated_at: row.updated_at
  });
}

async function rollbackQuietly(client, open) {
  if (!open) return;
  try { await client.query("ROLLBACK"); } catch {}
}

async function loadOwnedTeam(client, identity) {
  const result = await client.query(
    "SELECT * FROM radar_team_profiles WHERE legacy_profile_id = $1",
    [identity.profileId]
  );
  if (result.rowCount !== 1) throw matchError("RADAR_PROFILE_NOT_FOUND", 409, "Perfil do Radar indisponivel.");
  const team = rowToTeam(result.rows[0]);
  assertRadarTeamOwnedByIdentity(team, identity);
  assertRadarTeamCanMutate(team);
  return team;
}

const MATCH_SELECT = `
  SELECT match.*, invitation.proposal,
    team_a.account_reference AS team_a_account_reference,
    team_b.account_reference AS team_b_account_reference,
    (
      team_a.radar_departed_at IS NOT NULL OR team_b.radar_departed_at IS NOT NULL
      OR team_a.status = 'suspended' OR team_b.status = 'suspended'
      OR EXISTS (
        SELECT 1 FROM team_blocks block
        WHERE (block.blocker_team_id = match.team_a_id AND block.blocked_team_id = match.team_b_id)
           OR (block.blocker_team_id = match.team_b_id AND block.blocked_team_id = match.team_a_id)
      )
    ) AS contact_blocked,
    EXISTS (
      SELECT 1 FROM radar_match_statistic_compensations compensation
      WHERE compensation.match_id = match.id
    ) AS result_invalidated,
    EXISTS(
      SELECT 1 FROM match_occurrence_confirmations confirmation
      WHERE confirmation.match_id = match.id
        AND confirmation.confirming_team_id = match.team_a_id
        AND confirmation.happened = true
    ) AS team_a_confirmed,
    EXISTS(
      SELECT 1 FROM match_occurrence_confirmations confirmation
      WHERE confirmation.match_id = match.id
        AND confirmation.confirming_team_id = match.team_b_id
        AND confirmation.happened = true
    ) AS team_b_confirmed,
    (
      SELECT count(*)::integer FROM match_occurrence_confirmations confirmation
      WHERE confirmation.match_id = match.id AND confirmation.happened = true
    ) AS confirmation_count,
    (
      SELECT jsonb_build_object(
        'team_a_goals', submission.team_a_goals,
        'team_b_goals', submission.team_b_goals,
        'created_at', submission.created_at
      )
      FROM match_result_submissions submission
      WHERE submission.match_id = match.id
        AND submission.submitting_team_id = match.team_a_id
        AND submission.is_current = true
      LIMIT 1
    ) AS team_a_result_submission,
    (
      SELECT jsonb_build_object(
        'team_a_goals', submission.team_a_goals,
        'team_b_goals', submission.team_b_goals,
        'created_at', submission.created_at
      )
      FROM match_result_submissions submission
      WHERE submission.match_id = match.id
        AND submission.submitting_team_id = match.team_b_id
        AND submission.is_current = true
      LIMIT 1
    ) AS team_b_result_submission
  FROM friendly_matches match
  JOIN friendly_invitations invitation ON invitation.id = match.invitation_id
  JOIN radar_team_profiles team_a ON team_a.id = match.team_a_id
  JOIN radar_team_profiles team_b ON team_b.id = match.team_b_id
`;

async function findOwnedMatch(client, publicId, teamId, { lock = false } = {}) {
  const result = await client.query(`${MATCH_SELECT}
    WHERE match.public_id = $1
      AND (match.team_a_id = $2 OR match.team_b_id = $2)
    ${lock ? "FOR UPDATE OF match" : ""}
  `, [publicId, teamId]);
  if (result.rowCount !== 1) throw matchError("MATCH_NOT_FOUND", 404, "Partida nao encontrada.");
  return result.rows[0];
}

async function audit(client, { row, team, identity, eventType, state, confirmations, reason, requestId }) {
  const payload = {
    state,
    confirmations,
    ...(reason ? { reason } : {})
  };
  await client.query(`
    INSERT INTO match_audit_events(
      match_id, invitation_id, actor_team_id, actor_reference,
      event_type, entity_version, payload, request_id
    ) VALUES ($1, $2, $3, $4, $5, $6, $7::jsonb, $8)
  `, [
    row.id, row.invitation_id, team.id, identity.accountId,
    eventType, Number(row.version), JSON.stringify(payload), requestId || null
  ]);
}

async function notify(client, { recipientTeamId, row, opponent, type, confirmations, reason }) {
  const payload = {
    match_id: row.public_id,
    match_version: Number(row.version),
    state: row.occurrence_state,
    confirmations,
    opponent_slug: opponent.publicSlug,
    opponent_name: opponent.publicName,
    ...(reason ? { reason } : {})
  };
  await client.query(`
    INSERT INTO notifications(
      recipient_team_id, event_type, entity_type, entity_public_id,
      payload, deduplication_key
    ) VALUES ($1, $2, 'friendly_match', $3, $4::jsonb, $5)
    ON CONFLICT (recipient_team_id, deduplication_key) DO NOTHING
  `, [
    recipientTeamId, type, row.public_id, JSON.stringify(payload),
    `${type}:${row.public_id}:v${row.version}`
  ]);
}

async function replay(client, { identity, teamId, operation, key, payloadHash }) {
  const result = await client.query(`
    SELECT payload_hash, radar_team_id, result_snapshot
    FROM radar_match_mutation_requests
    WHERE account_reference = $1 AND operation = $2 AND idempotency_key = $3
  `, [identity.accountId, operation, key]);
  if (!result.rowCount) return null;
  const row = result.rows[0];
  if (row.payload_hash !== payloadHash || row.radar_team_id !== teamId) {
    throw matchError("IDEMPOTENCY_KEY_REUSED", 409, "Idempotency-Key ja utilizada com outros dados.");
  }
  return Object.freeze({ ...row.result_snapshot, replayed: true });
}

async function saveMutation(client, { identity, teamId, operation, key, payloadHash, matchId, result }) {
  await client.query(`
    INSERT INTO radar_match_mutation_requests(
      account_reference, operation, idempotency_key, payload_hash,
      radar_team_id, match_id, result_snapshot
    ) VALUES ($1, $2, $3, $4, $5, $6, $7::jsonb)
  `, [identity.accountId, operation, key, payloadHash, teamId, matchId, JSON.stringify(result)]);
}

function normalizeDatabaseError(error) {
  if (error instanceof RadarIdentityError) return error;
  const constraint = String(error?.constraint || error?.message || "");
  if (error?.code === "23505" && constraint.includes("match_occurrence_confirmations_match_id_confirming_team_id_key")) {
    return matchError("MATCH_ALREADY_CONFIRMED", 409, "Este time ja confirmou a partida.");
  }
  return error;
}

function createMatchCenterRepository({ pool }) {
  if (!pool || typeof pool.connect !== "function") throw new TypeError("Match center repository requires PostgreSQL");

  async function withTransaction(work) {
    const client = await pool.connect();
    let open = false;
    try {
      await client.query("BEGIN");
      open = true;
      const result = await work(client);
      await client.query("COMMIT");
      open = false;
      return result;
    } catch (error) {
      await rollbackQuietly(client, open);
      throw normalizeDatabaseError(error);
    } finally { client.release(); }
  }

  async function listOwned({ identity, state, limit }) {
    return withTransaction(async client => {
      const team = await loadOwnedTeam(client, identity);
      const filter = state === "proximas"
        ? "AND match.occurrence_state NOT IN ('played', 'cancelled', 'no_show')"
        : state === "historico"
          ? "AND match.occurrence_state IN ('played', 'cancelled', 'no_show', 'disputed')"
          : "";
      const result = await client.query(`${MATCH_SELECT}
        WHERE (match.team_a_id = $1 OR match.team_b_id = $1)
        ${filter}
        ORDER BY
          CASE WHEN match.occurrence_state IN ('played', 'cancelled', 'no_show', 'disputed') THEN 1 ELSE 0 END,
          CASE WHEN match.occurrence_state IN ('played', 'cancelled', 'no_show', 'disputed') THEN match.scheduled_at END DESC,
          CASE WHEN match.occurrence_state NOT IN ('played', 'cancelled', 'no_show', 'disputed') THEN match.scheduled_at END ASC,
          match.public_id ASC
        LIMIT $2
      `, [team.id, limit]);
      return Object.freeze({ items: Object.freeze(result.rows.map(row => rowToMatch(row, team.id))) });
    });
  }

  async function getOwned({ identity, publicId }) {
    return withTransaction(async client => {
      const team = await loadOwnedTeam(client, identity);
      const row = await findOwnedMatch(client, publicId, team.id);
      const reference = row.team_a_id === team.id
        ? row.team_b_account_reference
        : row.team_a_account_reference;
      return Object.freeze({
        match: rowToMatch(row, team.id),
        opponentAccountReference: row.contact_blocked === true ? null : reference
      });
    });
  }

  async function mutateOwned({ identity, publicId, expectedVersion, operation, value, idempotencyKey, payloadHash, now, requestId }) {
    return withTransaction(async client => {
      const team = await loadOwnedTeam(client, identity);
      await client.query("SELECT pg_advisory_xact_lock(hashtext($1))", [
        `${identity.accountId}:${operation}:${idempotencyKey}`
      ]);
      const replayed = await replay(client, {
        identity, teamId: team.id, operation, key: idempotencyKey, payloadHash
      });
      if (replayed) return replayed;
      const original = await findOwnedMatch(client, publicId, team.id, { lock: true });
      if (Number(original.version) !== expectedVersion) {
        throw matchError("MATCH_VERSION_CONFLICT", 409, "A partida mudou. Atualize e tente novamente.");
      }
      if (["played", "cancelled"].includes(original.occurrence_state)) {
        throw matchError("MATCH_TERMINAL", 409, "Partida encerrada.");
      }
      const opponentId = original.team_a_id === team.id ? original.team_b_id : original.team_a_id;
      const opponentResult = await client.query("SELECT * FROM radar_team_profiles WHERE id = $1", [opponentId]);
      const opponent = rowToTeam(opponentResult.rows[0]);
      let updated;

      if (operation === "confirm_occurrence") {
        if (new Date(original.scheduled_at) > now) {
          throw matchError("MATCH_CONFIRMATION_TOO_EARLY", 409, "A confirmacao abre depois do horario da partida.");
        }
        if (original.cancellation_reason) throw matchError("MATCH_TERMINAL", 409, "Partida encerrada.");
        await client.query(`
          INSERT INTO match_occurrence_confirmations(match_id, confirming_team_id, happened)
          VALUES ($1, $2, true)
        `, [original.id, team.id]);
        const countResult = await client.query(`
          SELECT count(*)::integer AS total FROM match_occurrence_confirmations
          WHERE match_id = $1 AND happened = true
        `, [original.id]);
        const confirmations = Number(countResult.rows[0].total);
        const state = confirmations === 2 ? "played" : "awaiting_occurrence";
        const result = await client.query(`
          UPDATE friendly_matches
          SET occurrence_state = $2::text,
              occurrence_confirmed_at = CASE
                WHEN $2::text = 'played' THEN $3::timestamptz
                ELSE NULL::timestamptz
              END,
              version = version + 1, updated_at = $3::timestamptz
          WHERE id = $1
          RETURNING *
        `, [original.id, state, now]);
        updated = { ...original, ...result.rows[0], confirmation_count: confirmations };
        if (original.team_a_id === team.id) updated.team_a_confirmed = true;
        else updated.team_b_confirmed = true;
        await audit(client, {
          row: updated, team, identity, eventType: "friendly_match.occurrence_confirmed",
          state, confirmations, requestId
        });
        await notify(client, {
          recipientTeamId: opponentId, row: updated, opponent: team,
          type: "match_occurrence_confirmed", confirmations
        });
        if (confirmations === 2) {
          await notify(client, {
            recipientTeamId: team.id, row: updated, opponent,
            type: "match_played", confirmations
          });
          await notify(client, {
            recipientTeamId: opponentId, row: updated, opponent: team,
            type: "match_played", confirmations
          });
        }
      } else if (operation === "cancel") {
        const confirmationsResult = await client.query(`
          SELECT count(*)::integer AS total FROM match_occurrence_confirmations
          WHERE match_id = $1 AND happened = true
        `, [original.id]);
        const confirmations = Number(confirmationsResult.rows[0].total);
        if (confirmations > 0) {
          throw matchError("MATCH_CANCELLATION_FORBIDDEN", 409, "A partida ja possui confirmacao de realizacao.");
        }
        const result = await client.query(`
          UPDATE friendly_matches
          SET occurrence_state = 'cancelled', cancellation_reason = $2,
              cancelled_by_team_id = $3, cancelled_at = $4,
              version = version + 1, updated_at = $4
          WHERE id = $1
          RETURNING *
        `, [original.id, value.reason, team.id, now]);
        updated = { ...original, ...result.rows[0], confirmation_count: 0 };
        await audit(client, {
          row: updated, team, identity, eventType: "friendly_match.cancelled",
          state: "cancelled", confirmations: 0, reason: value.reason, requestId
        });
        await notify(client, {
          recipientTeamId: opponentId, row: updated, opponent: team,
          type: "match_cancelled", confirmations: 0, reason: value.reason
        });
      } else {
        throw new TypeError("Unsupported match mutation");
      }

      const result = Object.freeze({ match: rowToMatch(updated, team.id), replayed: false });
      await saveMutation(client, {
        identity, teamId: team.id, operation, key: idempotencyKey,
        payloadHash, matchId: original.id, result
      });
      return result;
    });
  }

  return Object.freeze({ listOwned, getOwned, mutateOwned });
}

module.exports = { createMatchCenterRepository, rowToMatch };
