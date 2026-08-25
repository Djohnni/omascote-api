"use strict";

const { RadarIdentityError } = require("./radar-identity.errors");
const { rowToTeam } = require("./radar-identity.repository");
const {
  assertRadarTeamOwnedByIdentity,
  assertRadarTeamCanMutate
} = require("./radar-identity.policy");
const { historyError } = require("./match-history.schemas");

const HISTORICAL_STATES = "('played', 'cancelled', 'no_show', 'disputed')";

async function rollbackQuietly(client, open) {
  if (!open) return;
  try { await client.query("ROLLBACK"); } catch {}
}

function normalizeDatabaseError(error) {
  if (error instanceof RadarIdentityError) return error;
  return error;
}

async function loadOwnedTeam(client, identity) {
  const result = await client.query(
    "SELECT * FROM radar_team_profiles WHERE legacy_profile_id = $1",
    [identity.profileId]
  );
  if (result.rowCount !== 1) {
    throw historyError("RADAR_PROFILE_NOT_FOUND", 409, "Perfil do Radar indisponivel.");
  }
  const team = rowToTeam(result.rows[0]);
  assertRadarTeamOwnedByIdentity(team, identity);
  assertRadarTeamCanMutate(team);
  return team;
}

function opponentSnapshot(row) {
  const raw = row.opponent_snapshot && typeof row.opponent_snapshot === "object"
    ? row.opponent_snapshot
    : {};
  return Object.freeze({
    public_id: row.opponent_public_id,
    slug: String(row.opponent_public_slug || raw.slug || ""),
    name: String(row.opponent_public_name || raw.name || "Time adversario")
  });
}

function rowToHistoryItem(row) {
  const official = row.result_state === "verified" && row.occurrence_state === "played" && row.result_invalidated !== true;
  const cancelled = row.occurrence_state === "cancelled";
  const status = row.result_invalidated === true
    ? "invalidated"
    : cancelled
    ? "cancelled"
    : row.result_state === "divergent"
      ? "divergent"
      : official
        ? "official"
        : "pending";
  const goalsFor = official ? Number(row.goals_for) : null;
  const goalsAgainst = official ? Number(row.goals_against) : null;
  const outcome = !official
    ? null
    : goalsFor > goalsAgainst
      ? "win"
      : goalsFor < goalsAgainst
        ? "loss"
        : "draw";
  const proposal = row.proposal && typeof row.proposal === "object" ? row.proposal : {};
  return Object.freeze({
    match_id: row.match_public_id,
    scheduled_at: new Date(row.scheduled_at).toISOString(),
    status,
    opponent: opponentSnapshot(row),
    modality: proposal.modality || null,
    category: proposal.category || null,
    result: official
      ? Object.freeze({ goals_for: goalsFor, goals_against: goalsAgainst, outcome })
      : null,
    cancellation: cancelled
      ? Object.freeze({ reason: row.cancellation_reason, cancelled_at: row.cancelled_at })
      : null
  });
}

function situationSql(parameter) {
  return `(
    ${parameter}::text = 'all'
    OR (${parameter}::text = 'official' AND match.occurrence_state = 'played' AND match.result_state = 'verified'
      AND NOT EXISTS (SELECT 1 FROM radar_match_statistic_compensations compensation WHERE compensation.match_id = match.id))
    OR (${parameter}::text = 'divergent' AND match.occurrence_state = 'played' AND match.result_state = 'divergent')
    OR (${parameter}::text = 'cancelled' AND match.occurrence_state = 'cancelled')
    OR (${parameter}::text = 'pending' AND match.occurrence_state = 'played' AND match.result_state NOT IN ('verified', 'divergent'))
  )`;
}

const HISTORY_SELECT = `
  SELECT
    match.public_id AS match_public_id,
    match.scheduled_at,
    match.occurrence_state,
    match.result_state,
    match.cancellation_reason,
    match.cancelled_at,
    EXISTS (
      SELECT 1 FROM radar_match_statistic_compensations compensation
      WHERE compensation.match_id = match.id
    ) AS result_invalidated,
    invitation.proposal,
    opponent.public_id AS opponent_public_id,
    opponent.public_slug AS opponent_public_slug,
    opponent.public_name AS opponent_public_name,
    CASE WHEN match.team_a_id = $1 THEN match.team_b_snapshot ELSE match.team_a_snapshot END AS opponent_snapshot,
    CASE WHEN match.team_a_id = $1 THEN match.verified_team_a_goals ELSE match.verified_team_b_goals END AS goals_for,
    CASE WHEN match.team_a_id = $1 THEN match.verified_team_b_goals ELSE match.verified_team_a_goals END AS goals_against
  FROM friendly_matches match
  JOIN friendly_invitations invitation ON invitation.id = match.invitation_id
  JOIN radar_team_profiles opponent
    ON opponent.id = CASE WHEN match.team_a_id = $1 THEN match.team_b_id ELSE match.team_a_id END
`;

function baseWhere() {
  return `
    WHERE (match.team_a_id = $1 OR match.team_b_id = $1)
      AND match.occurrence_state IN ${HISTORICAL_STATES}
      AND ($2::timestamptz IS NULL OR match.scheduled_at >= $2::timestamptz)
      AND ${situationSql("$3")}
      AND ($4::uuid IS NULL OR opponent.id = $4::uuid)
  `;
}

async function findOpponent(client, teamId, opponentPublicId) {
  const result = await client.query(`
    SELECT opponent.id, opponent.public_id, opponent.public_slug, opponent.public_name
    FROM radar_team_profiles opponent
    WHERE opponent.public_id = $1
      AND opponent.id <> $2
      AND EXISTS (
        SELECT 1 FROM friendly_matches match
        WHERE (match.team_a_id = $2 AND match.team_b_id = opponent.id)
           OR (match.team_b_id = $2 AND match.team_a_id = opponent.id)
      )
    LIMIT 1
  `, [opponentPublicId, teamId]);
  if (result.rowCount !== 1) {
    throw historyError("MATCH_HISTORY_OPPONENT_NOT_FOUND", 404, "Historico nao encontrado.");
  }
  return Object.freeze({
    id: result.rows[0].id,
    public_id: result.rows[0].public_id,
    slug: result.rows[0].public_slug,
    name: result.rows[0].public_name
  });
}

async function consumeRateLimits(client, { scopes, now, windowSeconds }) {
  const windowMs = windowSeconds * 1000;
  const windowStartedAt = new Date(Math.floor(now.getTime() / windowMs) * windowMs);
  for (const scope of scopes) {
    const result = await client.query(`
      INSERT INTO radar_match_history_rate_limits(
        scope_type, scope_hash, window_started_at, request_count, updated_at
      ) VALUES ($1, $2, $3, 1, $4)
      ON CONFLICT (scope_type, scope_hash, window_started_at)
      DO UPDATE SET
        request_count = radar_match_history_rate_limits.request_count + 1,
        updated_at = EXCLUDED.updated_at
      WHERE radar_match_history_rate_limits.request_count < $5
      RETURNING request_count
    `, [scope.type, scope.hash, windowStartedAt, now, scope.limit]);
    if (result.rowCount !== 1) {
      throw historyError(
        "MATCH_HISTORY_RATE_LIMITED",
        429,
        "Limite de consultas atingido. Aguarde e tente novamente."
      );
    }
  }
  await client.query(`
    DELETE FROM radar_match_history_rate_limits
    WHERE window_started_at < $1
  `, [new Date(now.getTime() - windowMs * 2)]);
}

async function readPage(client, { teamId, filters, opponentId, afterKey }) {
  const params = [
    teamId,
    filters.periodFrom,
    filters.situation,
    opponentId,
    afterKey?.scheduledAt || null,
    afterKey?.matchId || null,
    filters.limit + 1
  ];
  const result = await client.query(`${HISTORY_SELECT}
    ${baseWhere()}
      AND (
        $5::timestamptz IS NULL
        OR (match.scheduled_at, match.public_id) < ($5::timestamptz, $6::uuid)
      )
    ORDER BY match.scheduled_at DESC, match.public_id DESC
    LIMIT $7
  `, params);
  const hasMore = result.rows.length > filters.limit;
  const rows = hasMore ? result.rows.slice(0, filters.limit) : result.rows;
  return Object.freeze({ rows: Object.freeze(rows), hasMore });
}

async function readSummary(client, { teamId, filters, opponentId }) {
  const params = [teamId, filters.periodFrom, filters.situation, opponentId];
  const result = await client.query(`
    SELECT
      count(*)::integer AS records,
      count(*) FILTER (
        WHERE match.occurrence_state = 'played' AND match.result_state = 'verified'
          AND NOT EXISTS (SELECT 1 FROM radar_match_statistic_compensations compensation WHERE compensation.match_id = match.id)
      )::integer AS official_matches,
      count(*) FILTER (
        WHERE match.occurrence_state = 'played' AND match.result_state = 'verified'
          AND NOT EXISTS (SELECT 1 FROM radar_match_statistic_compensations compensation WHERE compensation.match_id = match.id)
          AND (CASE WHEN match.team_a_id = $1 THEN match.verified_team_a_goals ELSE match.verified_team_b_goals END)
            > (CASE WHEN match.team_a_id = $1 THEN match.verified_team_b_goals ELSE match.verified_team_a_goals END)
      )::integer AS wins,
      count(*) FILTER (
        WHERE match.occurrence_state = 'played' AND match.result_state = 'verified'
          AND NOT EXISTS (SELECT 1 FROM radar_match_statistic_compensations compensation WHERE compensation.match_id = match.id)
          AND match.verified_team_a_goals = match.verified_team_b_goals
      )::integer AS draws,
      count(*) FILTER (
        WHERE match.occurrence_state = 'played' AND match.result_state = 'verified'
          AND NOT EXISTS (SELECT 1 FROM radar_match_statistic_compensations compensation WHERE compensation.match_id = match.id)
          AND (CASE WHEN match.team_a_id = $1 THEN match.verified_team_a_goals ELSE match.verified_team_b_goals END)
            < (CASE WHEN match.team_a_id = $1 THEN match.verified_team_b_goals ELSE match.verified_team_a_goals END)
      )::integer AS losses,
      COALESCE(sum(CASE
        WHEN match.occurrence_state = 'played' AND match.result_state = 'verified'
          AND NOT EXISTS (SELECT 1 FROM radar_match_statistic_compensations compensation WHERE compensation.match_id = match.id)
          THEN CASE WHEN match.team_a_id = $1 THEN match.verified_team_a_goals ELSE match.verified_team_b_goals END
        ELSE 0 END), 0)::integer AS goals_for,
      COALESCE(sum(CASE
        WHEN match.occurrence_state = 'played' AND match.result_state = 'verified'
          AND NOT EXISTS (SELECT 1 FROM radar_match_statistic_compensations compensation WHERE compensation.match_id = match.id)
          THEN CASE WHEN match.team_a_id = $1 THEN match.verified_team_b_goals ELSE match.verified_team_a_goals END
        ELSE 0 END), 0)::integer AS goals_against
    FROM friendly_matches match
    JOIN radar_team_profiles opponent
      ON opponent.id = CASE WHEN match.team_a_id = $1 THEN match.team_b_id ELSE match.team_a_id END
    ${baseWhere()}
  `, params);
  const recent = await client.query(`
    SELECT
      CASE WHEN match.team_a_id = $1 THEN match.verified_team_a_goals ELSE match.verified_team_b_goals END AS goals_for,
      CASE WHEN match.team_a_id = $1 THEN match.verified_team_b_goals ELSE match.verified_team_a_goals END AS goals_against
    FROM friendly_matches match
    JOIN radar_team_profiles opponent
      ON opponent.id = CASE WHEN match.team_a_id = $1 THEN match.team_b_id ELSE match.team_a_id END
    ${baseWhere()}
      AND match.occurrence_state = 'played'
      AND match.result_state = 'verified'
      AND NOT EXISTS (SELECT 1 FROM radar_match_statistic_compensations compensation WHERE compensation.match_id = match.id)
    ORDER BY match.scheduled_at DESC, match.public_id DESC
    LIMIT 5
  `, params);
  const row = result.rows[0];
  return Object.freeze({
    records: Number(row.records),
    official_matches: Number(row.official_matches),
    wins: Number(row.wins),
    draws: Number(row.draws),
    losses: Number(row.losses),
    goals_for: Number(row.goals_for),
    goals_against: Number(row.goals_against),
    recent_form: Object.freeze(recent.rows.map(item => {
      const goalsFor = Number(item.goals_for);
      const goalsAgainst = Number(item.goals_against);
      return goalsFor > goalsAgainst ? "win" : goalsFor < goalsAgainst ? "loss" : "draw";
    }))
  });
}

function createMatchHistoryRepository({ pool, config }) {
  if (!pool || typeof pool.connect !== "function") {
    throw new TypeError("Match history repository requires PostgreSQL");
  }

  async function read({ identity, filters, opponentPublicId, afterKey, rateScopes, now }) {
    const client = await pool.connect();
    let open = false;
    try {
      await client.query("BEGIN");
      open = true;
      const team = await loadOwnedTeam(client, identity);
      await consumeRateLimits(client, {
        scopes: rateScopes(team),
        now,
        windowSeconds: config.matchHistoryRateWindowSeconds
      });
      const opponent = opponentPublicId
        ? await findOpponent(client, team.id, opponentPublicId)
        : null;
      const values = { teamId: team.id, filters, opponentId: opponent?.id || null };
      const page = await readPage(client, { ...values, afterKey });
      const summary = await readSummary(client, values);
      await client.query("COMMIT");
      open = false;
      return Object.freeze({
        teamId: team.id,
        opponent: opponent ? Object.freeze({
          public_id: opponent.public_id,
          slug: opponent.slug,
          name: opponent.name
        }) : null,
        rows: page.rows,
        hasMore: page.hasMore,
        summary
      });
    } catch (error) {
      await rollbackQuietly(client, open);
      throw normalizeDatabaseError(error);
    } finally { client.release(); }
  }

  return Object.freeze({ read, rowToHistoryItem });
}

module.exports = {
  createMatchHistoryRepository,
  rowToHistoryItem,
  loadOwnedTeam,
  normalizeDatabaseError
};
