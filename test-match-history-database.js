"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");
const crypto = require("node:crypto");
const { PGlite } = require("@electric-sql/pglite");
const { migrate } = require("./src/db/migrate");
const { createRadarConfig } = require("./src/config/radar");
const { createInvitationRepository } = require("./src/friendlies/invitation.repository");
const { createInvitationService } = require("./src/friendlies/invitation.service");
const { createMatchCenterRepository } = require("./src/friendlies/match-center.repository");
const { createMatchCenterService } = require("./src/friendlies/match-center.service");
const { createMatchResultRepository } = require("./src/friendlies/match-result.repository");
const { createMatchResultService } = require("./src/friendlies/match-result.service");
const { createMatchHistoryRepository } = require("./src/friendlies/match-history.repository");
const { createMatchHistoryService } = require("./src/friendlies/match-history.service");

const INVITE_NOW = new Date("2026-05-01T12:00:00.000Z");
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
    RADAR_MATCH_HISTORY_ENABLED: "true",
    RADAR_INVITATIONS_SECURITY_SECRET: "history-database-invitation-secret-at-least-32-bytes",
    RADAR_MATCH_RESULTS_SECURITY_SECRET: "history-database-result-secret-at-least-32-bytes",
    RADAR_MATCH_HISTORY_CURSOR_SECRET: "history-database-cursor-secret-at-least-32-bytes",
    RADAR_MATCH_HISTORY_RATE_LIMIT_SECRET: "history-database-rate-secret-at-least-32-bytes",
    RADAR_INVITATION_ACCOUNT_LIMIT: "500",
    RADAR_INVITATION_TEAM_LIMIT: "500",
    RADAR_INVITATION_IP_LIMIT: "1000",
    RADAR_MATCH_HISTORY_ACCOUNT_LIMIT: "500",
    RADAR_MATCH_HISTORY_TEAM_LIMIT: "500",
    RADAR_MATCH_HISTORY_IP_LIMIT: "1000",
    ...overrides
  });
}

async function insertTeam(database, name) {
  const owner = identity(name);
  const result = await database.query(`
    INSERT INTO radar_team_profiles(
      legacy_profile_id, account_reference, public_slug, status,
      instagram_handle, instagram_verification_status,
      city_ibge_code, city_name, state_code, modalities, categories,
      declared_level, travel_radius_km, venue_preference, availability_active,
      radar_terms_accepted_at, public_name, public_profile_enabled,
      public_crest_available
    ) VALUES (
      $1, $2, $3, 'active', $4, 'verified', '4209102', 'Joinville', 'SC',
      ARRAY['society'], ARRAY['Livre'], 'intermediario', 25, 'either', true,
      '2026-04-20T12:00:00.000Z', $5, true, true
    ) RETURNING id, public_id, public_slug
  `, [owner.profileId, owner.accountId, `${name}-fc`, `${name}.fc`, `${name} FC`]);
  const team = result.rows[0];
  await database.query(`
    INSERT INTO friendly_availabilities(
      team_id, modality, category, declared_level, starts_at, ends_at,
      city_ibge_code, city_name, state_code, travel_radius_km,
      venue_preference, status, schedule_hash
    ) VALUES (
      $1, 'society', 'Livre', 'intermediario',
      '2026-08-10T13:00:00.000Z', '2026-08-10T23:00:00.000Z',
      '4209102', 'Joinville', 'SC', 25, 'either', 'active', $2
    )
  `, [team.id, crypto.createHash("sha256").update(name).digest("hex")]);
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

function resultService(database) {
  const radarConfig = config();
  return createMatchResultService({
    repository: createMatchResultRepository({ pool: pool(database), config: radarConfig }),
    config: radarConfig,
    clock: () => RESULT_NOW
  });
}

function historyService(database, overrides = {}) {
  const radarConfig = config(overrides);
  return createMatchHistoryService({
    repository: createMatchHistoryRepository({ pool: pool(database), config: radarConfig }),
    config: radarConfig,
    clock: () => MATCH_NOW
  });
}

async function createAcceptedMatch(database, first, second, suffix, startsAt) {
  const invitations = invitationService(database);
  const starts = new Date(startsAt);
  const ends = new Date(starts.getTime() + 2 * 60 * 60 * 1000);
  const created = await invitations.create({
    identity: first.identity,
    body: {
      opponent_slug: second.public_slug,
      starts_at: starts.toISOString(),
      ends_at: ends.toISOString(),
      modality: "society",
      category: "Livre",
      venue_preference: "home",
      message: `Amistoso ${suffix}.`
    },
    idempotencyKey: `history-create-${suffix}-0001`,
    ip: "203.0.113.10"
  });
  const accepted = await invitations.accept({
    identity: second.identity,
    publicId: created.invitation.invitation_id,
    body: {}, expectedVersion: "1",
    idempotencyKey: `history-accept-${suffix}-0001`,
    ip: "203.0.113.11"
  });
  return accepted.match.match_id;
}

async function makePlayed(database, first, second, suffix, startsAt) {
  const matchId = await createAcceptedMatch(database, first, second, suffix, startsAt);
  const matches = matchService(database);
  await matches.confirmOccurrence({
    identity: first.identity, publicId: matchId, body: {}, expectedVersion: "1",
    idempotencyKey: `history-occur-a-${suffix}-0001`
  });
  await matches.confirmOccurrence({
    identity: second.identity, publicId: matchId, body: {}, expectedVersion: "2",
    idempotencyKey: `history-occur-b-${suffix}-0001`
  });
  return matchId;
}

async function makeOfficial(database, first, second, suffix, startsAt, firstGoals, secondGoals) {
  const matchId = await makePlayed(database, first, second, suffix, startsAt);
  const results = resultService(database);
  await results.submit({
    identity: first.identity, publicId: matchId,
    body: { gols_meu_time: firstGoals, gols_adversario: secondGoals },
    expectedVersion: "3", idempotencyKey: `history-score-${suffix}-0001`
  });
  await results.confirm({
    identity: second.identity, publicId: matchId, body: {},
    expectedVersion: "4", idempotencyKey: `history-confirm-${suffix}-0001`
  });
  return matchId;
}

async function makeDivergent(database, first, second, suffix, startsAt) {
  const matchId = await makePlayed(database, first, second, suffix, startsAt);
  const results = resultService(database);
  await results.submit({
    identity: first.identity, publicId: matchId,
    body: { gols_meu_time: 2, gols_adversario: 1 },
    expectedVersion: "3", idempotencyKey: `history-diff-a-${suffix}-0001`
  });
  await results.submit({
    identity: second.identity, publicId: matchId,
    body: { gols_meu_time: 1, gols_adversario: 1 },
    expectedVersion: "4", idempotencyKey: `history-diff-b-${suffix}-0001`
  });
  return matchId;
}

async function makeCancelled(database, first, second, suffix, startsAt) {
  const matchId = await createAcceptedMatch(database, first, second, suffix, startsAt);
  await matchService(database).cancel({
    identity: first.identity, publicId: matchId,
    body: { reason: "weather" }, expectedVersion: "1",
    idempotencyKey: `history-cancel-${suffix}-0001`
  });
  return matchId;
}

test("PostgreSQL history migration, privacy, pagination and statistics", async t => {
  const database = new PGlite();
  try {
    const adapter = pool(database);
    const applied = await migrate({ pool: adapter });

    await t.test("migration 013 runs once and the full migration runner is idempotent", async () => {
      assert.equal(applied.at(-1), "016_match_communication.sql");
      assert.deepEqual(await migrate({ pool: adapter }), []);
      const indexes = await database.query(`
        SELECT indexname FROM pg_indexes
        WHERE indexname IN (
          'friendly_matches_team_a_history_idx',
          'friendly_matches_team_b_history_idx',
          'friendly_matches_verified_history_idx',
          'radar_match_history_rate_cleanup_idx'
        )
      `);
      assert.equal(indexes.rows.length, 4);
    });

    const alpha = await insertTeam(database, "history-alpha");
    const beta = await insertTeam(database, "history-beta");
    const gamma = await insertTeam(database, "history-gamma");
    const winId = await makeOfficial(database, alpha, beta, "win", "2026-08-10T22:00:00.000Z", 3, 1);
    await makeOfficial(database, alpha, beta, "draw", "2026-07-10T22:00:00.000Z", 2, 2);
    await makeOfficial(database, gamma, alpha, "loss", "2026-06-10T22:00:00.000Z", 2, 0);
    await makeDivergent(database, alpha, beta, "divergent", "2026-08-12T22:00:00.000Z");
    await makeCancelled(database, alpha, gamma, "cancelled", "2026-08-13T22:00:00.000Z");
    const history = historyService(database);

    await t.test("official statistics orient scores for both participant sides", async () => {
      const alphaView = await history.list({
        identity: alpha.identity, query: { limit: "20" }, requestContext: { ip: "203.0.113.1" }
      });
      assert.deepEqual(
        {
          official: alphaView.summary.official_matches,
          wins: alphaView.summary.wins,
          draws: alphaView.summary.draws,
          losses: alphaView.summary.losses,
          goalsFor: alphaView.summary.goals_for,
          goalsAgainst: alphaView.summary.goals_against
        },
        { official: 3, wins: 1, draws: 1, losses: 1, goalsFor: 5, goalsAgainst: 5 }
      );
      assert.deepEqual(alphaView.summary.recent_form, ["win", "draw", "loss"]);
      const betaView = await history.list({
        identity: beta.identity, query: { situacao: "official" }, requestContext: { ip: "203.0.113.2" }
      });
      const betaWin = betaView.items.find(item => item.match_id === winId);
      assert.deepEqual(betaWin.result, { goals_for: 1, goals_against: 3, outcome: "loss" });
      assert.equal(betaView.summary.losses, 1);
      assert.equal(betaView.summary.draws, 1);
    });

    await t.test("divergent and cancelled records remain visible but never enter statistics", async () => {
      const view = await history.list({
        identity: alpha.identity, query: {}, requestContext: { ip: "203.0.113.3" }
      });
      assert.equal(view.items.some(item => item.status === "divergent" && item.result === null), true);
      assert.equal(view.items.some(item => item.status === "cancelled" && item.result === null), true);
      assert.equal(view.summary.records, 5);
      assert.equal(view.summary.official_matches, 3);
      const serialized = JSON.stringify(view);
      for (const forbidden of ["account-history", "profile-history", "whatsapp", "contact", "address", "venue_details"]) {
        assert.equal(serialized.includes(forbidden), false);
      }
    });

    await t.test("period and situation filters apply to rows and aggregate calculations", async () => {
      const recent = await history.list({
        identity: alpha.identity,
        query: { periodo: "30d", situacao: "official" },
        requestContext: { ip: "203.0.113.4" }
      });
      assert.equal(recent.items.length, 1);
      assert.equal(recent.summary.wins, 1);
      assert.equal(recent.summary.draws, 0);
      const cancelled = await history.list({
        identity: alpha.identity,
        query: { situacao: "cancelled" },
        requestContext: { ip: "203.0.113.5" }
      });
      assert.equal(cancelled.items.length, 1);
      assert.equal(cancelled.summary.official_matches, 0);
      assert.deepEqual(cancelled.summary.recent_form, []);
    });

    await t.test("signed keyset pages are stable and never repeat a match", async () => {
      const first = await history.list({
        identity: alpha.identity, query: { limit: "2" }, requestContext: { ip: "203.0.113.6" }
      });
      const second = await history.list({
        identity: alpha.identity,
        query: { limit: "2", cursor: first.page.next_cursor },
        requestContext: { ip: "203.0.113.6" }
      });
      assert.equal(first.page.has_more, true);
      assert.equal(new Set([...first.items, ...second.items].map(item => item.match_id)).size, 4);
      assert.equal(first.items.some(item => second.items.some(next => next.match_id === item.match_id)), false);
      await assert.rejects(history.list({
        identity: beta.identity,
        query: { limit: "2", cursor: first.page.next_cursor },
        requestContext: { ip: "203.0.113.7" }
      }), error => error.code === "MATCH_HISTORY_CURSOR_OWNER_MISMATCH");
    });

    await t.test("head-to-head requires an encountered opaque opponent and summarizes only that pair", async () => {
      const againstBeta = await history.against({
        identity: alpha.identity,
        opponentPublicId: beta.public_id,
        query: {}, requestContext: { ip: "203.0.113.8" }
      });
      assert.equal(againstBeta.opponent.public_id, beta.public_id);
      assert.equal(againstBeta.summary.records, 3);
      assert.equal(againstBeta.summary.official_matches, 2);
      assert.equal(againstBeta.items.every(item => item.opponent.public_id === beta.public_id), true);
      await assert.rejects(history.against({
        identity: gamma.identity,
        opponentPublicId: beta.public_id,
        query: {}, requestContext: { ip: "203.0.113.9" }
      }), error => error.code === "MATCH_HISTORY_OPPONENT_NOT_FOUND");
    });

    await t.test("suspended teams are denied and persistent account limits fail closed", async () => {
      const limited = historyService(database, {
        RADAR_MATCH_HISTORY_ACCOUNT_LIMIT: "1",
        RADAR_MATCH_HISTORY_CURSOR_SECRET: "limited-cursor-secret-at-least-thirty-two-bytes",
        RADAR_MATCH_HISTORY_RATE_LIMIT_SECRET: "limited-rate-secret-at-least-thirty-two-bytes"
      });
      await limited.list({ identity: beta.identity, query: {}, requestContext: { ip: "198.51.100.1" } });
      await assert.rejects(
        limited.list({ identity: beta.identity, query: {}, requestContext: { ip: "198.51.100.2" } }),
        error => error.code === "MATCH_HISTORY_RATE_LIMITED"
      );
      await database.query(
        "UPDATE radar_team_profiles SET status = 'suspended', suspended_at = $2 WHERE id = $1",
        [alpha.id, MATCH_NOW]
      );
      await assert.rejects(
        history.list({ identity: alpha.identity, query: {}, requestContext: { ip: "203.0.113.10" } }),
        error => error.code === "RADAR_PROFILE_SUSPENDED"
      );
    });
  } finally { await database.close(); }
});
