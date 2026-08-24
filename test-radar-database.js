"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");
const { PGlite } = require("@electric-sql/pglite");
const { migrate } = require("./src/db/migrate");
const { checkDatabase } = require("./src/db/pool");

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
      "002_result_confirmation_match_integrity.sql"
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
