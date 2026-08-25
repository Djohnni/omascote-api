"use strict";

const { RadarIdentityError } = require("./radar-identity.errors");
const { rowToTeam } = require("./radar-identity.repository");
const {
  assertRadarTeamOwnedByIdentity,
  assertRadarTeamCanMutate
} = require("./radar-identity.policy");
const { rowToMatch } = require("./match-center.repository");
const { matchError } = require("./match-center.schemas");
const { submissionHash } = require("./match-result.schemas");

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

const RESULT_MATCH_SELECT = `
  SELECT match.*, invitation.proposal,
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
    ) AS confirmation_count
  FROM friendly_matches match
  JOIN friendly_invitations invitation ON invitation.id = match.invitation_id
`;

async function findOwnedMatch(client, publicId, teamId) {
  const result = await client.query(`${RESULT_MATCH_SELECT}
    WHERE match.public_id = $1
      AND (match.team_a_id = $2 OR match.team_b_id = $2)
    FOR UPDATE OF match
  `, [publicId, teamId]);
  if (result.rowCount !== 1) throw matchError("MATCH_NOT_FOUND", 404, "Partida nao encontrada.");
  return result.rows[0];
}

async function currentSubmissions(client, matchId) {
  const result = await client.query(`
    SELECT * FROM match_result_submissions
    WHERE match_id = $1 AND is_current = true
    ORDER BY submitting_team_id::text
    FOR UPDATE
  `, [matchId]);
  return result.rows;
}

function sameScore(left, right) {
  return Boolean(left && right) &&
    Number(left.team_a_goals) === Number(right.team_a_goals) &&
    Number(left.team_b_goals) === Number(right.team_b_goals);
}

function decorateMatch(row, submissions) {
  const teamA = submissions.find(item => item.submitting_team_id === row.team_a_id) || null;
  const teamB = submissions.find(item => item.submitting_team_id === row.team_b_id) || null;
  return {
    ...row,
    team_a_result_submission: teamA,
    team_b_result_submission: teamB
  };
}

async function replay(client, { identity, teamId, operation, key, payloadHash }) {
  const result = await client.query(`
    SELECT payload_hash, radar_team_id, result_snapshot
    FROM radar_match_result_mutation_requests
    WHERE account_reference = $1 AND operation = $2 AND idempotency_key = $3
  `, [identity.accountId, operation, key]);
  if (!result.rowCount) return null;
  const row = result.rows[0];
  if (row.payload_hash !== payloadHash || row.radar_team_id !== teamId) {
    throw matchError("IDEMPOTENCY_KEY_REUSED", 409, "Idempotency-Key ja utilizada com outros dados.");
  }
  return Object.freeze({ ...row.result_snapshot, replayed: true });
}

async function saveMutation(client, values) {
  await client.query(`
    INSERT INTO radar_match_result_mutation_requests(
      account_reference, operation, idempotency_key, payload_hash,
      radar_team_id, match_id, result_snapshot
    ) VALUES ($1, $2, $3, $4, $5, $6, $7::jsonb)
  `, [
    values.identity.accountId, values.operation, values.idempotencyKey,
    values.payloadHash, values.teamId, values.matchId,
    JSON.stringify(values.result)
  ]);
}

async function audit(client, { row, team, identity, eventType, requestId, submissionVersion }) {
  const payload = {
    result_state: row.result_state,
    consensus: row.result_state === "verified",
    ...(submissionVersion ? { submission_version: submissionVersion } : {})
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

async function notify(client, { recipientTeamId, row, opponent, type }) {
  const payload = {
    match_id: row.public_id,
    match_version: Number(row.version),
    result_state: row.result_state,
    opponent_slug: opponent.publicSlug,
    opponent_name: opponent.publicName
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

async function applyVerifiedStatistics(client, row, hash, now) {
  await client.query(`
    SELECT id FROM radar_team_profiles
    WHERE id IN ($1, $2)
    ORDER BY id::text
    FOR UPDATE
  `, [row.team_a_id, row.team_b_id]);
  const application = await client.query(`
    INSERT INTO radar_match_statistic_applications(
      match_id, team_a_id, team_b_id, team_a_goals, team_b_goals,
      result_hash, applied_at
    ) VALUES ($1, $2, $3, $4, $5, $6, $7)
    ON CONFLICT (match_id) DO NOTHING
    RETURNING match_id
  `, [
    row.id, row.team_a_id, row.team_b_id,
    row.verified_team_a_goals, row.verified_team_b_goals, hash, now
  ]);
  if (application.rowCount !== 1) {
    throw matchError("MATCH_RESULT_STATISTICS_CONFLICT", 409, "As estatisticas deste placar ja foram aplicadas.");
  }

  const aGoals = Number(row.verified_team_a_goals);
  const bGoals = Number(row.verified_team_b_goals);
  const outcomes = [
    {
      teamId: row.team_a_id, goalsFor: aGoals, goalsAgainst: bGoals,
      win: aGoals > bGoals ? 1 : 0, draw: aGoals === bGoals ? 1 : 0, loss: aGoals < bGoals ? 1 : 0
    },
    {
      teamId: row.team_b_id, goalsFor: bGoals, goalsAgainst: aGoals,
      win: bGoals > aGoals ? 1 : 0, draw: aGoals === bGoals ? 1 : 0, loss: bGoals < aGoals ? 1 : 0
    }
  ].sort((left, right) => left.teamId.localeCompare(right.teamId));

  for (const item of outcomes) {
    await client.query(`
      INSERT INTO radar_team_verified_statistics(
        team_id, matches_played, wins, draws, losses,
        goals_for, goals_against, version, updated_at
      ) VALUES ($1, 1, $2, $3, $4, $5, $6, 1, $7)
      ON CONFLICT (team_id) DO UPDATE SET
        matches_played = radar_team_verified_statistics.matches_played + 1,
        wins = radar_team_verified_statistics.wins + EXCLUDED.wins,
        draws = radar_team_verified_statistics.draws + EXCLUDED.draws,
        losses = radar_team_verified_statistics.losses + EXCLUDED.losses,
        goals_for = radar_team_verified_statistics.goals_for + EXCLUDED.goals_for,
        goals_against = radar_team_verified_statistics.goals_against + EXCLUDED.goals_against,
        version = radar_team_verified_statistics.version + 1,
        updated_at = EXCLUDED.updated_at
    `, [
      item.teamId, item.win, item.draw, item.loss,
      item.goalsFor, item.goalsAgainst, now
    ]);
  }
}

function normalizeDatabaseError(error) {
  if (error instanceof RadarIdentityError) return error;
  const constraint = String(error?.constraint || error?.message || "");
  if (error?.code === "23505" && constraint.includes("match_result_confirmations_match_id_confirming_team_id_key")) {
    return matchError("MATCH_RESULT_ALREADY_CONFIRMED", 409, "Este time ja confirmou o placar.");
  }
  return error;
}

function createMatchResultRepository({ pool, config }) {
  if (!pool || typeof pool.connect !== "function") throw new TypeError("Match result repository requires PostgreSQL");

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

  async function mutateOwned(values) {
    return withTransaction(async client => {
      const team = await loadOwnedTeam(client, values.identity);
      await client.query("SELECT pg_advisory_xact_lock(hashtext($1))", [
        `${values.identity.accountId}:${values.operation}:${values.idempotencyKey}`
      ]);
      const replayed = await replay(client, {
        identity: values.identity, teamId: team.id, operation: values.operation,
        key: values.idempotencyKey, payloadHash: values.payloadHash
      });
      if (replayed) return replayed;

      const original = await findOwnedMatch(client, values.publicId, team.id);
      if (Number(original.version) !== values.expectedVersion) {
        throw matchError("MATCH_VERSION_CONFLICT", 409, "A partida mudou. Atualize e tente novamente.");
      }
      if (original.occurrence_state !== "played" || Number(original.confirmation_count) !== 2) {
        throw matchError("MATCH_RESULT_TOO_EARLY", 409, "O placar abre depois que os dois times confirmarem o jogo.");
      }
      if (original.result_state === "verified") {
        throw matchError("MATCH_RESULT_IMMUTABLE", 409, "O placar oficial nao pode ser alterado.");
      }

      const isTeamA = original.team_a_id === team.id;
      const opponentId = isTeamA ? original.team_b_id : original.team_a_id;
      const opponentResult = await client.query("SELECT * FROM radar_team_profiles WHERE id = $1", [opponentId]);
      const opponent = rowToTeam(opponentResult.rows[0]);
      let submissions = await currentSubmissions(client, original.id);
      let officialSubmission = null;
      let ownSubmission = submissions.find(item => item.submitting_team_id === team.id) || null;
      const opponentSubmission = submissions.find(item => item.submitting_team_id === opponentId) || null;
      let eventType;

      if (values.operation === "submit_result") {
        const canonical = isTeamA
          ? { team_a_goals: values.value.gols_meu_time, team_b_goals: values.value.gols_adversario }
          : { team_a_goals: values.value.gols_adversario, team_b_goals: values.value.gols_meu_time };
        if (sameScore(ownSubmission, canonical)) {
          throw matchError("MATCH_RESULT_ALREADY_SUBMITTED", 409, "Este placar ja foi informado pelo seu time.");
        }
        const versionResult = await client.query(`
          SELECT COALESCE(max(version), 0)::integer + 1 AS next_version
          FROM match_result_submissions
          WHERE match_id = $1 AND submitting_team_id = $2
        `, [original.id, team.id]);
        const nextVersion = Number(versionResult.rows[0].next_version);
        if (ownSubmission) {
          await client.query("UPDATE match_result_submissions SET is_current = false WHERE id = $1", [ownSubmission.id]);
        }
        const hash = submissionHash(config.matchResultsSecuritySecret, {
          match_id: original.id,
          submitting_team_id: team.id,
          team_a_goals: canonical.team_a_goals,
          team_b_goals: canonical.team_b_goals,
          version: nextVersion
        });
        const inserted = await client.query(`
          INSERT INTO match_result_submissions(
            match_id, submitting_team_id, team_a_goals, team_b_goals,
            version, submission_hash, show_on_own_profile, is_current, created_at
          ) VALUES ($1, $2, $3, $4, $5, $6, false, true, $7)
          RETURNING *
        `, [
          original.id, team.id, canonical.team_a_goals, canonical.team_b_goals,
          nextVersion, hash, values.now
        ]);
        ownSubmission = inserted.rows[0];
        submissions = submissions.filter(item => item.submitting_team_id !== team.id).concat(ownSubmission);
        if (opponentSubmission && sameScore(ownSubmission, opponentSubmission)) {
          await client.query(`
            INSERT INTO match_result_confirmations(
              match_id, confirming_team_id, submission_id,
              submission_version, submission_hash, created_at
            ) VALUES ($1, $2, $3, $4, $5, $6)
          `, [
            original.id, team.id, opponentSubmission.id,
            opponentSubmission.version, opponentSubmission.submission_hash, values.now
          ]);
          officialSubmission = opponentSubmission;
        }
        eventType = officialSubmission
          ? "friendly_match.result_verified"
          : opponentSubmission
            ? "friendly_match.result_divergent"
            : "friendly_match.result_submitted";
      } else if (values.operation === "confirm_result") {
        if (!opponentSubmission) {
          throw matchError("MATCH_RESULT_NOT_RECEIVED", 409, "O adversario ainda nao informou o placar.");
        }
        await client.query(`
          INSERT INTO match_result_confirmations(
            match_id, confirming_team_id, submission_id,
            submission_version, submission_hash, created_at
          ) VALUES ($1, $2, $3, $4, $5, $6)
        `, [
          original.id, team.id, opponentSubmission.id,
          opponentSubmission.version, opponentSubmission.submission_hash, values.now
        ]);
        officialSubmission = opponentSubmission;
        eventType = "friendly_match.result_verified";
      } else {
        throw new TypeError("Unsupported match result mutation");
      }

      const nextState = officialSubmission
        ? "verified"
        : opponentSubmission
          ? "divergent"
          : "waiting_other";
      const updatedResult = await client.query(`
        UPDATE friendly_matches
        SET result_state = $2,
            verified_team_a_goals = $3,
            verified_team_b_goals = $4,
            verified_result_at = $5,
            version = version + 1,
            updated_at = $6
        WHERE id = $1
        RETURNING *
      `, [
        original.id, nextState,
        officialSubmission ? officialSubmission.team_a_goals : null,
        officialSubmission ? officialSubmission.team_b_goals : null,
        officialSubmission ? values.now : null,
        values.now
      ]);
      const updated = { ...original, ...updatedResult.rows[0] };

      if (officialSubmission) {
        const verifiedHash = submissionHash(config.matchResultsSecuritySecret, {
          match_id: original.id,
          team_a_goals: Number(officialSubmission.team_a_goals),
          team_b_goals: Number(officialSubmission.team_b_goals),
          verified_at: values.now.toISOString()
        });
        await applyVerifiedStatistics(client, updated, verifiedHash, values.now);
      }

      await audit(client, {
        row: updated, team, identity: values.identity, eventType,
        requestId: values.requestId, submissionVersion: ownSubmission?.version
      });
      if (officialSubmission) {
        await notify(client, { recipientTeamId: team.id, row: updated, opponent, type: "match_result_verified" });
        await notify(client, { recipientTeamId: opponentId, row: updated, opponent: team, type: "match_result_verified" });
      } else {
        const type = nextState === "divergent" ? "match_result_divergent" : "match_result_received";
        await notify(client, { recipientTeamId: opponentId, row: updated, opponent: team, type });
      }

      const result = Object.freeze({
        match: rowToMatch(decorateMatch(updated, submissions), team.id),
        replayed: false
      });
      await saveMutation(client, {
        ...values, teamId: team.id, matchId: original.id, result
      });
      return result;
    });
  }

  return Object.freeze({ mutateOwned });
}

module.exports = { createMatchResultRepository, sameScore };
