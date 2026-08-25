"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");
const { PGlite } = require("@electric-sql/pglite");
const { migrate } = require("./src/db/migrate");
const { createRadarConfig } = require("./src/config/radar");
const { createInvitationRepository } = require("./src/friendlies/invitation.repository");
const { createInvitationService } = require("./src/friendlies/invitation.service");
const { createMatchCenterRepository } = require("./src/friendlies/match-center.repository");
const { createMatchCenterService } = require("./src/friendlies/match-center.service");
const { createMatchResultRepository } = require("./src/friendlies/match-result.repository");
const { createMatchResultService } = require("./src/friendlies/match-result.service");

const INVITE_NOW = new Date("2026-08-01T12:00:00.000Z");
const MATCH_NOW = new Date("2026-08-24T12:00:00.000Z");
const RESULT_NOW = new Date("2026-08-24T15:00:00.000Z");

function normalizeResult(result) {
  const last = Array.isArray(result) ? result.at(-1) : result;
  if (!last) return { rows: [], rowCount: 0 };
  return { ...last, rowCount: last.rows?.length || last.affectedRows || 0 };
}

function pool(database) {
  function client() {
    return {
      async query(sql, params) {
        return params ? normalizeResult(await database.query(sql, params)) : normalizeResult(await database.exec(sql));
      },
      release() {}
    };
  }
  return { connect: async () => client(), query: (sql, params) => client().query(sql, params) };
}

function identity(name) {
  return Object.freeze({ accountId: `account-${name}`, profileId: `profile-${name}` });
}

function config(overrides = {}) {
  return createRadarConfig({
    RADAR_AMISTOSOS_ENABLED: "true",
    RADAR_INVITATIONS_ENABLED: "true",
    RADAR_MATCH_CENTER_ENABLED: "true",
    RADAR_MATCH_RESULTS_ENABLED: "true",
    RADAR_INVITATIONS_SECURITY_SECRET: "match-result-database-invitation-secret-32-bytes",
    RADAR_MATCH_RESULTS_SECURITY_SECRET: "match-result-database-score-secret-at-least-32-bytes",
    RADAR_INVITATION_ACCOUNT_LIMIT: "500",
    RADAR_INVITATION_TEAM_LIMIT: "500",
    RADAR_INVITATION_IP_LIMIT: "1000",
    ...overrides
  });
}

async function insertTeam(database, name, overrides = {}) {
  const owner = identity(name);
  const result = await database.query(`
    INSERT INTO radar_team_profiles(
      legacy_profile_id, account_reference, public_slug, status,
      instagram_handle, instagram_verification_status,
      city_ibge_code, city_name, state_code, modalities, categories,
      declared_level, travel_radius_km, venue_preference, availability_active,
      radar_terms_accepted_at, public_name, public_profile_enabled,
      public_crest_available, suspended_at
    ) VALUES (
      $1, $2, $3, $4, $5, 'verified', '4209102', 'Joinville', 'SC',
      ARRAY['society'], ARRAY['Livre'], 'intermediario', 25, 'either', true,
      '2026-07-20T12:00:00.000Z', $6, true, true, $7
    ) RETURNING id, public_slug
  `, [
    owner.profileId, owner.accountId, `${name}-fc`, overrides.status || "active",
    `${name}.fc`, `${name} FC`, overrides.status === "suspended" ? MATCH_NOW : null
  ]);
  const team = result.rows[0];
  await database.query(`
    INSERT INTO friendly_availabilities(
      team_id, modality, category, declared_level, starts_at, ends_at,
      city_ibge_code, city_name, state_code, travel_radius_km,
      venue_preference, status, schedule_hash
    ) VALUES ($1, 'society', 'Livre', 'intermediario',
      '2026-08-10T18:00:00.000Z', '2026-08-10T23:00:00.000Z',
      '4209102', 'Joinville', 'SC', 25, 'either', 'active', $2)
  `, [team.id, name.padEnd(64, "a").slice(0, 64).replace(/[^0-9a-f]/g, "a")]);
  return { ...team, identity: owner };
}

function invitationService(database) {
  const radarConfig = config();
  return createInvitationService({
    repository: createInvitationRepository({ pool: pool(database), config: radarConfig }),
    config: radarConfig,
    clock: () => INVITE_NOW
  });
}

function matchService(database) {
  const radarConfig = config();
  return createMatchCenterService({
    repository: createMatchCenterRepository({ pool: pool(database) }),
    config: radarConfig,
    clock: () => MATCH_NOW
  });
}

function resultService(database, overrides = {}) {
  const radarConfig = config(overrides);
  return createMatchResultService({
    repository: createMatchResultRepository({ pool: pool(database), config: radarConfig }),
    config: radarConfig,
    clock: () => RESULT_NOW
  });
}

async function createAcceptedMatch(database, first, second, suffix) {
  const invitations = invitationService(database);
  const created = await invitations.create({
    identity: first.identity,
    body: {
      opponent_slug: second.public_slug,
      starts_at: "2026-08-10T19:00:00-03:00",
      ends_at: "2026-08-10T21:00:00-03:00",
      modality: "society", category: "Livre", venue_preference: "home",
      message: "Jogo amistoso."
    },
    idempotencyKey: `create-result-${suffix}-0001`, ip: "203.0.113.10"
  });
  const accepted = await invitations.accept({
    identity: second.identity, publicId: created.invitation.invitation_id,
    body: {}, expectedVersion: "1", idempotencyKey: `accept-result-${suffix}-0001`,
    ip: "203.0.113.11"
  });
  return accepted.match.match_id;
}

async function confirmPlayed(database, matchId, first, second, suffix) {
  const matches = matchService(database);
  await matches.confirmOccurrence({
    identity: first.identity, publicId: matchId, body: {}, expectedVersion: "1",
    idempotencyKey: `occur-first-${suffix}-0001`
  });
  await matches.confirmOccurrence({
    identity: second.identity, publicId: matchId, body: {}, expectedVersion: "2",
    idempotencyKey: `occur-second-${suffix}-0001`
  });
}

async function createPlayedMatch(database, first, second, suffix) {
  const matchId = await createAcceptedMatch(database, first, second, suffix);
  await confirmPlayed(database, matchId, first, second, suffix);
  return matchId;
}

test("migration 010 runs twice and installs result ledgers and verified statistics", async () => {
  const database = new PGlite();
  try {
    const adapter = pool(database);
    const applied = await migrate({ pool: adapter });
    assert.equal(applied.at(-1), "014_radar_smart_onboarding.sql");
    assert.deepEqual(await migrate({ pool: adapter }), []);
    const tables = await database.query(`
      SELECT table_name FROM information_schema.tables
      WHERE table_name IN (
        'radar_team_verified_statistics',
        'radar_match_statistic_applications',
        'radar_match_result_mutation_requests'
      )
    `);
    assert.equal(tables.rows.length, 3);
  } finally { await database.close(); }
});

test("only participants with active teams can submit and scoring waits for played state", async () => {
  const database = new PGlite();
  try {
    await migrate({ pool: pool(database) });
    const alpha = await insertTeam(database, "auth-alpha");
    const beta = await insertTeam(database, "auth-beta");
    const outsider = await insertTeam(database, "auth-outsider");
    const matchId = await createAcceptedMatch(database, alpha, beta, "auth");
    const results = resultService(database);
    await assert.rejects(results.submit({
      identity: alpha.identity, publicId: matchId,
      body: { gols_meu_time: 1, gols_adversario: 0 }, expectedVersion: "1",
      idempotencyKey: "premature-score-0001"
    }), error => error.code === "MATCH_RESULT_TOO_EARLY");
    await confirmPlayed(database, matchId, alpha, beta, "auth");
    await assert.rejects(results.submit({
      identity: outsider.identity, publicId: matchId,
      body: { gols_meu_time: 1, gols_adversario: 0 }, expectedVersion: "3",
      idempotencyKey: "outsider-score-0001"
    }), error => error.code === "MATCH_NOT_FOUND");
    await database.query("UPDATE radar_team_profiles SET status = 'suspended', suspended_at = $2 WHERE id = $1", [alpha.id, RESULT_NOW]);
    await assert.rejects(results.submit({
      identity: alpha.identity, publicId: matchId,
      body: { gols_meu_time: 1, gols_adversario: 0 }, expectedVersion: "3",
      idempotencyKey: "suspended-score-0001"
    }), error => error.code === "RADAR_PROFILE_SUSPENDED");
  } finally { await database.close(); }
});

test("goals are normalized by participant side and first score waits for the opponent", async () => {
  const database = new PGlite();
  try {
    await migrate({ pool: pool(database) });
    const alpha = await insertTeam(database, "side-alpha");
    const beta = await insertTeam(database, "side-beta");
    const matchId = await createPlayedMatch(database, alpha, beta, "side");
    const results = resultService(database);
    const submitted = await results.submit({
      identity: beta.identity, publicId: matchId,
      body: { gols_meu_time: 2, gols_adversario: 3 }, expectedVersion: 'W/"3"',
      idempotencyKey: "side-beta-score-0001", requestId: "side-submit"
    });
    assert.equal(submitted.match.result.state, "waiting_other");
    assert.equal(submitted.match.result.meu_placar.gols_meu_time, 2);
    assert.equal(submitted.match.result.meu_placar.gols_adversario, 3);
    assert.equal(new Date(submitted.match.result.meu_placar.informado_em).toISOString(), RESULT_NOW.toISOString());
    const stored = await database.query(`
      SELECT submission.team_a_goals, submission.team_b_goals, submission.submission_hash,
             match.result_state, match.version
      FROM match_result_submissions submission
      JOIN friendly_matches match ON match.id = submission.match_id
      WHERE match.public_id = $1
    `, [matchId]);
    assert.equal(stored.rows[0].team_a_goals, 3);
    assert.equal(stored.rows[0].team_b_goals, 2);
    assert.match(stored.rows[0].submission_hash, /^[0-9a-f]{64}$/);
    assert.equal(stored.rows[0].result_state, "waiting_other");
    assert.equal(stored.rows[0].version, 4);
    const alphaDetail = await matchService(database).get({ identity: alpha.identity, publicId: matchId });
    assert.deepEqual(alphaDetail.match.result.placar_adversario.gols_meu_time, 3);
  } finally { await database.close(); }
});

test("opponent confirmation makes the score immutable and applies statistics exactly once", async () => {
  const database = new PGlite();
  try {
    await migrate({ pool: pool(database) });
    const alpha = await insertTeam(database, "verify-alpha");
    const beta = await insertTeam(database, "verify-beta");
    const matchId = await createPlayedMatch(database, alpha, beta, "verify");
    const results = resultService(database);
    await results.submit({
      identity: alpha.identity, publicId: matchId,
      body: { gols_meu_time: 4, gols_adversario: 1 }, expectedVersion: "3",
      idempotencyKey: "verify-submit-0001"
    });
    const verified = await results.confirm({
      identity: beta.identity, publicId: matchId, body: {}, expectedVersion: "4",
      idempotencyKey: "verify-confirm-0001", requestId: "verify-confirm"
    });
    assert.equal(verified.match.result.state, "verified");
    assert.deepEqual(verified.match.result.placar_oficial.gols_meu_time, 1);
    const replay = await results.confirm({
      identity: beta.identity, publicId: matchId, body: {}, expectedVersion: "4",
      idempotencyKey: "verify-confirm-0001"
    });
    assert.equal(replay.replayed, true);
    await assert.rejects(results.submit({
      identity: alpha.identity, publicId: matchId,
      body: { gols_meu_time: 5, gols_adversario: 1 }, expectedVersion: "5",
      idempotencyKey: "verify-change-0001"
    }), error => error.code === "MATCH_RESULT_IMMUTABLE");
    const statistics = await database.query(`
      SELECT team_id, matches_played, wins, draws, losses, goals_for, goals_against
      FROM radar_team_verified_statistics ORDER BY team_id::text
    `);
    assert.equal(statistics.rows.length, 2);
    const alphaStats = statistics.rows.find(row => row.team_id === alpha.id);
    const betaStats = statistics.rows.find(row => row.team_id === beta.id);
    assert.deepEqual(alphaStats, {
      team_id: alpha.id, matches_played: 1, wins: 1, draws: 0, losses: 0, goals_for: 4, goals_against: 1
    });
    assert.deepEqual(betaStats, {
      team_id: beta.id, matches_played: 1, wins: 0, draws: 0, losses: 1, goals_for: 1, goals_against: 4
    });
    assert.equal((await database.query("SELECT count(*)::integer AS total FROM radar_match_statistic_applications")).rows[0].total, 1);
  } finally { await database.close(); }
});

test("different scores stay divergent without winner or statistics and can reach consensus", async () => {
  const database = new PGlite();
  try {
    await migrate({ pool: pool(database) });
    const alpha = await insertTeam(database, "diff-alpha");
    const beta = await insertTeam(database, "diff-beta");
    const matchId = await createPlayedMatch(database, alpha, beta, "diff");
    const results = resultService(database);
    await results.submit({
      identity: alpha.identity, publicId: matchId,
      body: { gols_meu_time: 3, gols_adversario: 2 }, expectedVersion: "3",
      idempotencyKey: "diff-alpha-score-0001"
    });
    const divergent = await results.submit({
      identity: beta.identity, publicId: matchId,
      body: { gols_meu_time: 2, gols_adversario: 2 }, expectedVersion: "4",
      idempotencyKey: "diff-beta-score-0001"
    });
    assert.equal(divergent.match.result.state, "divergent");
    assert.equal(divergent.match.result.placar_oficial, null);
    assert.equal((await database.query("SELECT count(*)::integer AS total FROM radar_team_verified_statistics")).rows[0].total, 0);
    const resolved = await results.confirm({
      identity: alpha.identity, publicId: matchId, body: {}, expectedVersion: "5",
      idempotencyKey: "diff-alpha-agrees-0001"
    });
    assert.equal(resolved.match.result.state, "verified");
    assert.deepEqual(resolved.match.result.placar_oficial.gols_meu_time, 2);
    assert.equal((await database.query("SELECT count(*)::integer AS total FROM radar_match_statistic_applications")).rows[0].total, 1);
  } finally { await database.close(); }
});

test("same normalized scores reach consensus while stale concurrent intent cannot double-apply", async () => {
  const database = new PGlite();
  try {
    await migrate({ pool: pool(database) });
    const alpha = await insertTeam(database, "race-score-alpha");
    const beta = await insertTeam(database, "race-score-beta");
    const matchId = await createPlayedMatch(database, alpha, beta, "race-score");
    const results = resultService(database);
    await results.submit({
      identity: alpha.identity, publicId: matchId,
      body: { gols_meu_time: 2, gols_adversario: 0 }, expectedVersion: "3",
      idempotencyKey: "race-score-alpha-0001"
    });
    await assert.rejects(results.submit({
      identity: beta.identity, publicId: matchId,
      body: { gols_meu_time: 0, gols_adversario: 2 }, expectedVersion: "3",
      idempotencyKey: "race-score-beta-stale"
    }), error => error.code === "MATCH_VERSION_CONFLICT");
    const verified = await results.submit({
      identity: beta.identity, publicId: matchId,
      body: { gols_meu_time: 0, gols_adversario: 2 }, expectedVersion: "4",
      idempotencyKey: "race-score-beta-0001"
    });
    assert.equal(verified.match.result.state, "verified");
    assert.equal((await database.query("SELECT count(*)::integer AS total FROM match_result_confirmations")).rows[0].total, 1);
    assert.equal((await database.query("SELECT count(*)::integer AS total FROM radar_match_statistic_applications")).rows[0].total, 1);
  } finally { await database.close(); }
});

test("a divergent team may replace only its current version before official consensus", async () => {
  const database = new PGlite();
  try {
    await migrate({ pool: pool(database) });
    const alpha = await insertTeam(database, "replace-alpha");
    const beta = await insertTeam(database, "replace-beta");
    const matchId = await createPlayedMatch(database, alpha, beta, "replace");
    const results = resultService(database);
    await results.submit({
      identity: alpha.identity, publicId: matchId,
      body: { gols_meu_time: 1, gols_adversario: 1 }, expectedVersion: "3",
      idempotencyKey: "replace-alpha-score-0001"
    });
    await results.submit({
      identity: beta.identity, publicId: matchId,
      body: { gols_meu_time: 2, gols_adversario: 1 }, expectedVersion: "4",
      idempotencyKey: "replace-beta-score-0001"
    });
    const corrected = await results.submit({
      identity: beta.identity, publicId: matchId,
      body: { gols_meu_time: 1, gols_adversario: 1 }, expectedVersion: "5",
      idempotencyKey: "replace-beta-score-0002"
    });
    assert.equal(corrected.match.result.state, "verified");
    const versions = await database.query(`
      SELECT version, is_current FROM match_result_submissions
      WHERE submitting_team_id = $1 ORDER BY version
    `, [beta.id]);
    assert.deepEqual(versions.rows, [{ version: 1, is_current: false }, { version: 2, is_current: true }]);
  } finally { await database.close(); }
});

test("database blocks self-confirmation and protects result audit and idempotency history", async () => {
  const database = new PGlite();
  try {
    await migrate({ pool: pool(database) });
    const alpha = await insertTeam(database, "guard-score-alpha");
    const beta = await insertTeam(database, "guard-score-beta");
    const matchId = await createPlayedMatch(database, alpha, beta, "guard-score");
    const results = resultService(database);
    await results.submit({
      identity: alpha.identity, publicId: matchId,
      body: { gols_meu_time: 2, gols_adversario: 2 }, expectedVersion: "3",
      idempotencyKey: "guard-score-submit-0001"
    });
    const submission = (await database.query(`
      SELECT submission.* FROM match_result_submissions submission
      JOIN friendly_matches match ON match.id = submission.match_id
      WHERE match.public_id = $1
    `, [matchId])).rows[0];
    await assert.rejects(database.query(`
      INSERT INTO match_result_confirmations(
        match_id, confirming_team_id, submission_id, submission_version, submission_hash
      ) VALUES ($1, $2, $3, $4, $5)
    `, [submission.match_id, alpha.id, submission.id, submission.version, submission.submission_hash]));
    await assert.rejects(database.query("DELETE FROM match_result_submissions WHERE id = $1", [submission.id]));
    await assert.rejects(database.query("UPDATE radar_match_result_mutation_requests SET payload_hash = $1", ["a".repeat(64)]));
    await assert.rejects(database.query("DELETE FROM match_audit_events WHERE match_id = $1", [submission.match_id]));
    const privateData = JSON.stringify({
      audits: (await database.query("SELECT payload FROM match_audit_events WHERE match_id = $1", [submission.match_id])).rows,
      notifications: (await database.query("SELECT payload FROM notifications WHERE entity_public_id = $1", [matchId])).rows
    }).toLowerCase();
    for (const forbidden of ["whatsapp", "telefone", "contact", "address", "+5547999999999"]) {
      assert.equal(privateData.includes(forbidden), false);
    }
  } finally { await database.close(); }
});
