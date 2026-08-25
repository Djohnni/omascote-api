"use strict";

const { RadarIdentityError } = require("./radar-identity.errors");
const { rowToTeam } = require("./radar-identity.repository");
const {
  assertRadarTeamOwnedByIdentity,
  assertRadarTeamCanMutate
} = require("./radar-identity.policy");
const { reputationError } = require("./team-reputation.schemas");

async function rollbackQuietly(client, open) {
  if (!open) return;
  try { await client.query("ROLLBACK"); } catch {}
}

async function loadOwnedTeam(client, identity) {
  const result = await client.query(
    "SELECT * FROM radar_team_profiles WHERE legacy_profile_id = $1",
    [identity.profileId]
  );
  if (result.rowCount !== 1) {
    throw reputationError("RADAR_PROFILE_NOT_FOUND", 409, "Perfil do Radar indisponivel.");
  }
  const team = rowToTeam(result.rows[0]);
  assertRadarTeamOwnedByIdentity(team, identity);
  assertRadarTeamCanMutate(team);
  return team;
}

function safeTeam(row, prefix = "team") {
  return Object.freeze({
    public_id: row[`${prefix}_public_id`],
    slug: row[`${prefix}_public_slug`] || "",
    name: row[`${prefix}_public_name`] || "Time"
  });
}

function oneDecimal(value) {
  return Math.round(Number(value) * 10) / 10;
}

function reputationSnapshot(row, minimum) {
  const team = safeTeam(row);
  const count = Number(row.verified_review_count || 0);
  if (count < minimum) {
    return Object.freeze({ team, state: "new", label: "Reputacao nova" });
  }
  const criteria = Object.freeze({
    pontualidade: oneDecimal(Number(row.punctuality_sum) / count),
    organizacao: oneDecimal(Number(row.organization_sum) / count),
    comunicacao: oneDecimal(Number(row.communication_sum) / count),
    fair_play: oneDecimal(Number(row.fair_play_sum) / count)
  });
  const overall = oneDecimal((
    Number(row.punctuality_sum) + Number(row.organization_sum) +
    Number(row.communication_sum) + Number(row.fair_play_sum)
  ) / (count * 4));
  return Object.freeze({
    team,
    state: "established",
    verified_evaluations: count,
    overall,
    criteria,
    would_play_again_percent: Math.round(Number(row.would_play_again_count) * 100 / count)
  });
}

function normalizeDatabaseError(error) {
  if (error instanceof RadarIdentityError) return error;
  const constraint = String(error?.constraint || error?.message || "");
  if (error?.code === "23505" && constraint.includes("team_reviews_match_id_reviewer_team_id_key")) {
    return reputationError("TEAM_REVIEW_ALREADY_SUBMITTED", 409, "Este time ja avaliou esta partida.");
  }
  if (error?.code === "23505" && constraint.includes("team_reviews_reviewer_team_id_idempotency_key_key")) {
    return reputationError("IDEMPOTENCY_KEY_REUSED", 409, "Idempotency-Key ja utilizada com outros dados.");
  }
  return error;
}

function createTeamReputationRepository({ pool }) {
  if (!pool || typeof pool.connect !== "function") {
    throw new TypeError("Team reputation repository requires PostgreSQL");
  }

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

  async function listPending({ identity }) {
    return withTransaction(async client => {
      const team = await loadOwnedTeam(client, identity);
      const result = await client.query(`
        SELECT match.public_id AS match_public_id, match.scheduled_at,
          opponent.public_id AS opponent_public_id,
          opponent.public_slug AS opponent_public_slug,
          opponent.public_name AS opponent_public_name
        FROM friendly_matches match
        JOIN radar_team_profiles opponent
          ON opponent.id = CASE
            WHEN match.team_a_id = $1 THEN match.team_b_id
            ELSE match.team_a_id
          END
        WHERE (match.team_a_id = $1 OR match.team_b_id = $1)
          AND match.occurrence_state = 'played'
          AND match.result_state = 'verified'
          AND NOT EXISTS (
            SELECT 1 FROM team_reviews review
            WHERE review.match_id = match.id AND review.reviewer_team_id = $1
          )
        ORDER BY match.scheduled_at DESC, match.public_id DESC
        LIMIT 50
      `, [team.id]);
      return Object.freeze({
        items: Object.freeze(result.rows.map(row => Object.freeze({
          match_id: row.match_public_id,
          scheduled_at: new Date(row.scheduled_at).toISOString(),
          opponent: Object.freeze({
            public_id: row.opponent_public_id,
            slug: row.opponent_public_slug || "",
            name: row.opponent_public_name || "Time adversario"
          })
        })))
      });
    });
  }

  async function replay(client, { teamId, publicId, idempotencyKey, payloadHash }) {
    const result = await client.query(`
      SELECT review.id, review.idempotency_payload_hash, match.public_id AS match_public_id
      FROM team_reviews review
      JOIN friendly_matches match ON match.id = review.match_id
      WHERE review.reviewer_team_id = $1 AND review.idempotency_key = $2
    `, [teamId, idempotencyKey]);
    if (!result.rowCount) return null;
    const row = result.rows[0];
    if (row.idempotency_payload_hash !== payloadHash || row.match_public_id !== publicId) {
      throw reputationError("IDEMPOTENCY_KEY_REUSED", 409, "Idempotency-Key ja utilizada com outros dados.");
    }
    return Object.freeze({
      evaluation: Object.freeze({ match_id: row.match_public_id, status: "submitted" }),
      replayed: true
    });
  }

  async function submit(values) {
    return withTransaction(async client => {
      const team = await loadOwnedTeam(client, values.identity);
      await client.query("SELECT pg_advisory_xact_lock(hashtext($1))", [
        `${values.identity.accountId}:submit_review:${values.idempotencyKey}`
      ]);
      const replayed = await replay(client, {
        teamId: team.id,
        publicId: values.publicId,
        idempotencyKey: values.idempotencyKey,
        payloadHash: values.payloadHash
      });
      if (replayed) return replayed;

      const matchResult = await client.query(`
        SELECT match.*, opponent.public_id AS opponent_public_id
        FROM friendly_matches match
        JOIN radar_team_profiles opponent
          ON opponent.id = CASE
            WHEN match.team_a_id = $2 THEN match.team_b_id
            ELSE match.team_a_id
          END
        WHERE match.public_id = $1
          AND (match.team_a_id = $2 OR match.team_b_id = $2)
        FOR UPDATE OF match
      `, [values.publicId, team.id]);
      if (matchResult.rowCount !== 1) {
        throw reputationError("MATCH_NOT_FOUND", 404, "Partida nao encontrada.");
      }
      const match = matchResult.rows[0];
      if (match.occurrence_state !== "played" || match.result_state !== "verified") {
        throw reputationError("TEAM_REVIEW_NOT_ELIGIBLE", 409, "A avaliacao abre depois do resultado oficial.");
      }
      const reviewedTeamId = match.team_a_id === team.id ? match.team_b_id : match.team_a_id;
      const inserted = await client.query(`
        INSERT INTO team_reviews(
          match_id, reviewer_team_id, reviewed_team_id,
          fair_play, punctuality, organization, communication,
          would_play_again, publication_state,
          idempotency_key, idempotency_payload_hash, created_at
        ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, 'blind', $9, $10, $11)
        RETURNING id
      `, [
        match.id, team.id, reviewedTeamId,
        values.review.fair_play, values.review.pontualidade,
        values.review.organizacao, values.review.comunicacao,
        values.review.jogaria_novamente,
        values.idempotencyKey, values.payloadHash, values.now
      ]);
      const reviewId = inserted.rows[0].id;
      const applied = await client.query(`
        INSERT INTO team_reputation_applications(review_id, reviewed_team_id, applied_at)
        VALUES ($1, $2, $3)
        ON CONFLICT (review_id) DO NOTHING
        RETURNING review_id
      `, [reviewId, reviewedTeamId, values.now]);
      if (applied.rowCount !== 1) {
        throw reputationError("TEAM_REPUTATION_APPLICATION_CONFLICT", 409, "A reputacao ja foi atualizada.");
      }
      await client.query(`
        INSERT INTO team_reputation_aggregates(
          team_id, verified_review_count,
          punctuality_sum, organization_sum, communication_sum, fair_play_sum,
          would_play_again_count, version, updated_at
        ) VALUES ($1, 1, $2, $3, $4, $5, $6, 1, $7)
        ON CONFLICT (team_id) DO UPDATE SET
          verified_review_count = team_reputation_aggregates.verified_review_count + 1,
          punctuality_sum = team_reputation_aggregates.punctuality_sum + EXCLUDED.punctuality_sum,
          organization_sum = team_reputation_aggregates.organization_sum + EXCLUDED.organization_sum,
          communication_sum = team_reputation_aggregates.communication_sum + EXCLUDED.communication_sum,
          fair_play_sum = team_reputation_aggregates.fair_play_sum + EXCLUDED.fair_play_sum,
          would_play_again_count = team_reputation_aggregates.would_play_again_count + EXCLUDED.would_play_again_count,
          version = team_reputation_aggregates.version + 1,
          updated_at = EXCLUDED.updated_at
      `, [
        reviewedTeamId, values.review.pontualidade, values.review.organizacao,
        values.review.comunicacao, values.review.fair_play,
        values.review.jogaria_novamente ? 1 : 0, values.now
      ]);
      await client.query(`
        INSERT INTO match_audit_events(
          match_id, invitation_id, actor_team_id, actor_reference,
          event_type, entity_version, payload, request_id
        ) VALUES ($1, $2, $3, $4, 'friendly_match.review_submitted', $5, $6::jsonb, $7)
      `, [
        match.id, match.invitation_id, team.id, values.identity.accountId,
        Number(match.version),
        JSON.stringify({ reviewed_team_public_id: match.opponent_public_id, review_state: "submitted" }),
        values.requestId
      ]);
      return Object.freeze({
        evaluation: Object.freeze({ match_id: match.public_id, status: "submitted" }),
        replayed: false
      });
    });
  }

  async function reputationQuery(client, whereSql, value) {
    const result = await client.query(`
      SELECT team.public_id AS team_public_id,
        team.public_slug AS team_public_slug,
        team.public_name AS team_public_name,
        aggregate.verified_review_count,
        aggregate.punctuality_sum,
        aggregate.organization_sum,
        aggregate.communication_sum,
        aggregate.fair_play_sum,
        aggregate.would_play_again_count
      FROM radar_team_profiles team
      LEFT JOIN team_reputation_aggregates aggregate ON aggregate.team_id = team.id
      WHERE ${whereSql}
      LIMIT 1
    `, [value]);
    return result.rows[0] || null;
  }

  async function getOwn({ identity, minimum }) {
    return withTransaction(async client => {
      const team = await loadOwnedTeam(client, identity);
      const row = await reputationQuery(client, "team.id = $1", team.id);
      return Object.freeze({ reputation: reputationSnapshot(row, minimum) });
    });
  }

  async function getPublic({ teamPublicId, minimum }) {
    return withTransaction(async client => {
      const row = await reputationQuery(client, `
        team.public_id = $1
        AND team.status = 'active'
        AND team.public_profile_enabled = true
        AND team.suspended_at IS NULL
      `, teamPublicId);
      if (!row) {
        throw reputationError("TEAM_REPUTATION_NOT_FOUND", 404, "Reputacao nao encontrada.");
      }
      return Object.freeze({ reputation: reputationSnapshot(row, minimum) });
    });
  }

  return Object.freeze({ listPending, submit, getOwn, getPublic });
}

module.exports = {
  createTeamReputationRepository,
  reputationSnapshot,
  normalizeDatabaseError
};
