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

const INVITE_NOW = new Date("2026-08-01T12:00:00.000Z");
const MATCH_NOW = new Date("2026-08-24T12:00:00.000Z");
const CONTACT = "+5547999999999";

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
    RADAR_INVITATIONS_SECURITY_SECRET: "match-center-database-secret-with-32-bytes",
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
    owner.profileId, owner.accountId, `${name}-fc`, overrides.status || "active", `${name}.fc`, `${name} FC`,
    overrides.status === "suspended" ? "2026-08-20T12:00:00.000Z" : null
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
  const adapter = pool(database);
  return createInvitationService({
    repository: createInvitationRepository({ pool: adapter, config: radarConfig }),
    config: radarConfig,
    clock: () => INVITE_NOW
  });
}

function matchService(database) {
  const radarConfig = config();
  return createMatchCenterService({
    repository: createMatchCenterRepository({ pool: pool(database) }),
    config: radarConfig,
    clock: () => MATCH_NOW,
    resolveContact: async reference => reference
      ? { type: "whatsapp", value: CONTACT }
      : null
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
      modality: "society",
      category: "Livre",
      venue_preference: "home",
      message: "Jogo amistoso."
    },
    idempotencyKey: `create-${suffix}-0001`,
    ip: "203.0.113.10"
  });
  const accepted = await invitations.accept({
    identity: second.identity,
    publicId: created.invitation.invitation_id,
    body: {},
    expectedVersion: "1",
    idempotencyKey: `accept-${suffix}-0001`,
    ip: "203.0.113.11"
  });
  return accepted.match.match_id;
}

test("match migrations run twice and install protected match history", async () => {
  const database = new PGlite();
  try {
    const adapter = pool(database);
    const applied = await migrate({ pool: adapter });
    assert.equal(applied.at(-1), "011_match_history.sql");
    assert.deepEqual(await migrate({ pool: adapter }), []);
    const tables = await database.query(`
      SELECT table_name FROM information_schema.tables
      WHERE table_name = 'radar_match_mutation_requests'
    `);
    assert.equal(tables.rows.length, 1);
  } finally { await database.close(); }
});

test("participants can list and read, outsider cannot, and contact is detail-only", async () => {
  const database = new PGlite();
  try {
    await migrate({ pool: pool(database) });
    const alpha = await insertTeam(database, "alpha-match");
    const beta = await insertTeam(database, "beta-match");
    const outsider = await insertTeam(database, "outsider-match");
    const matchId = await createAcceptedMatch(database, alpha, beta, "ownership");
    const matches = matchService(database);
    const list = await matches.list({ identity: alpha.identity, query: { estado: "proximas" } });
    assert.equal(list.items.length, 1);
    assert.equal(JSON.stringify(list).includes(CONTACT), false);
    assert.equal(list.items[0].opponent.slug, beta.public_slug);
    const detail = await matches.get({ identity: beta.identity, publicId: matchId });
    assert.equal(detail.match.opponent_contact.value, CONTACT);
    assert.equal(detail.match.opponent.slug, alpha.public_slug);
    await assert.rejects(
      matches.get({ identity: outsider.identity, publicId: matchId }),
      error => error.code === "MATCH_NOT_FOUND"
    );
    await assert.rejects(
      matches.list({ identity: alpha.identity, query: { team_id: beta.id } }),
      error => error.code === "MATCH_VALIDATION_ERROR"
    );
    await database.query(
      "UPDATE radar_team_profiles SET status = 'suspended', suspended_at = $2 WHERE id = $1",
      [outsider.id, MATCH_NOW]
    );
    await assert.rejects(
      matches.list({ identity: outsider.identity, query: {} }),
      error => error.code === "RADAR_PROFILE_SUSPENDED"
    );
  } finally { await database.close(); }
});

test("independent confirmations are idempotent and only both teams mark played", async () => {
  const database = new PGlite();
  try {
    await migrate({ pool: pool(database) });
    const alpha = await insertTeam(database, "confirm-alpha");
    const beta = await insertTeam(database, "confirm-beta");
    const matchId = await createAcceptedMatch(database, alpha, beta, "confirm");
    const matches = matchService(database);
    const first = await matches.confirmOccurrence({
      identity: alpha.identity, publicId: matchId, body: {}, expectedVersion: "1",
      idempotencyKey: "confirm-alpha-match-0001", requestId: "first-confirm"
    });
    assert.equal(first.match.state, "awaiting_occurrence");
    assert.equal(first.match.confirmation.by_me, true);
    assert.equal(first.match.confirmation.by_opponent, false);
    const replay = await matches.confirmOccurrence({
      identity: alpha.identity, publicId: matchId, body: {}, expectedVersion: "1",
      idempotencyKey: "confirm-alpha-match-0001"
    });
    assert.equal(replay.replayed, true);
    assert.equal(replay.match.version, 2);
    await assert.rejects(matches.cancel({
      identity: beta.identity, publicId: matchId, body: { reason: "weather" }, expectedVersion: "2",
      idempotencyKey: "cancel-after-confirm-0001"
    }), error => error.code === "MATCH_CANCELLATION_FORBIDDEN");
    const second = await matches.confirmOccurrence({
      identity: beta.identity, publicId: matchId, body: {}, expectedVersion: "2",
      idempotencyKey: "confirm-beta-match-0001", requestId: "second-confirm"
    });
    assert.equal(second.match.state, "played");
    assert.equal(second.match.confirmation.by_me, true);
    assert.equal(second.match.confirmation.by_opponent, true);
    assert.equal(second.match.confirmation.total, 2);
    const stored = await database.query(`
      SELECT occurrence_state, version FROM friendly_matches WHERE public_id = $1
    `, [matchId]);
    assert.deepEqual(stored.rows[0], { occurrence_state: "played", version: 3 });
    assert.equal((await database.query(`
      SELECT count(*)::integer AS total FROM match_occurrence_confirmations
      WHERE match_id = (SELECT id FROM friendly_matches WHERE public_id = $1)
    `, [matchId])).rows[0].total, 2);
    const privateHistory = JSON.stringify({
      audits: (await database.query(`SELECT payload FROM match_audit_events WHERE match_id = (
        SELECT id FROM friendly_matches WHERE public_id = $1
      )`, [matchId])).rows,
      notifications: (await database.query(`SELECT payload FROM notifications WHERE entity_public_id = $1`, [matchId])).rows,
      mutations: (await database.query(`SELECT result_snapshot FROM radar_match_mutation_requests WHERE match_id = (
        SELECT id FROM friendly_matches WHERE public_id = $1
      )`, [matchId])).rows
    }).toLowerCase();
    for (const forbidden of [CONTACT, "whatsapp", "telefone", "email", "opponent_contact"]) {
      assert.equal(privateHistory.includes(forbidden.toLowerCase()), false, forbidden);
    }
  } finally { await database.close(); }
});

test("structured cancellation is terminal, repeat-safe and notifies the opponent", async () => {
  const database = new PGlite();
  try {
    await migrate({ pool: pool(database) });
    const alpha = await insertTeam(database, "cancel-alpha");
    const beta = await insertTeam(database, "cancel-beta");
    const matchId = await createAcceptedMatch(database, alpha, beta, "cancel");
    const matches = matchService(database);
    const cancelled = await matches.cancel({
      identity: alpha.identity, publicId: matchId, body: { reason: "field_unavailable" },
      expectedVersion: 'W/"1"', idempotencyKey: "cancel-match-action-0001", requestId: "cancel-request"
    });
    assert.equal(cancelled.match.state, "cancelled");
    assert.deepEqual(cancelled.match.cancellation.reason, "field_unavailable");
    const replay = await matches.cancel({
      identity: alpha.identity, publicId: matchId, body: { reason: "field_unavailable" },
      expectedVersion: "1", idempotencyKey: "cancel-match-action-0001"
    });
    assert.equal(replay.replayed, true);
    await assert.rejects(matches.confirmOccurrence({
      identity: beta.identity, publicId: matchId, body: {}, expectedVersion: "2",
      idempotencyKey: "confirm-cancelled-0001"
    }), error => error.code === "MATCH_TERMINAL");
    const notification = await database.query(`
      SELECT event_type, payload FROM notifications
      WHERE recipient_team_id = $1 AND entity_public_id = $2 AND event_type = 'match_cancelled'
    `, [beta.id, matchId]);
    assert.equal(notification.rows.length, 1);
    assert.equal(notification.rows[0].payload.reason, "field_unavailable");
  } finally { await database.close(); }
});

test("stale concurrent intent and duplicate match creation fail without extra rows", async () => {
  const database = new PGlite();
  try {
    await migrate({ pool: pool(database) });
    const alpha = await insertTeam(database, "race-alpha");
    const beta = await insertTeam(database, "race-beta");
    const matchId = await createAcceptedMatch(database, alpha, beta, "race");
    const matches = matchService(database);
    await matches.confirmOccurrence({
      identity: alpha.identity, publicId: matchId, body: {}, expectedVersion: "1",
      idempotencyKey: "race-confirm-alpha-0001"
    });
    await assert.rejects(matches.confirmOccurrence({
      identity: beta.identity, publicId: matchId, body: {}, expectedVersion: "1",
      idempotencyKey: "race-confirm-beta-stale"
    }), error => error.code === "MATCH_VERSION_CONFLICT");
    assert.equal((await database.query("SELECT count(*)::integer AS total FROM friendly_matches")).rows[0].total, 1);
    const row = (await database.query("SELECT * FROM friendly_matches WHERE public_id = $1", [matchId])).rows[0];
    await assert.rejects(database.query(`
      INSERT INTO friendly_matches(
        invitation_id, team_a_id, team_b_id, team_a_snapshot, team_b_snapshot, scheduled_at
      ) VALUES ($1, $2, $3, $4::jsonb, $5::jsonb, $6)
    `, [row.invitation_id, row.team_a_id, row.team_b_id, JSON.stringify(row.team_a_snapshot), JSON.stringify(row.team_b_snapshot), row.scheduled_at]));
    assert.equal((await database.query("SELECT count(*)::integer AS total FROM friendly_matches")).rows[0].total, 1);
  } finally { await database.close(); }
});

test("database rejects outsiders, premature matches and mutation history changes", async () => {
  const database = new PGlite();
  try {
    await migrate({ pool: pool(database) });
    const alpha = await insertTeam(database, "guard-alpha");
    const beta = await insertTeam(database, "guard-beta");
    const outsider = await insertTeam(database, "guard-outsider");
    const matchId = await createAcceptedMatch(database, alpha, beta, "guard");
    const matchRow = (await database.query("SELECT id FROM friendly_matches WHERE public_id = $1", [matchId])).rows[0];
    await assert.rejects(database.query(`
      INSERT INTO match_occurrence_confirmations(match_id, confirming_team_id, happened)
      VALUES ($1, $2, true)
    `, [matchRow.id, outsider.id]));
    const matches = matchService(database);
    await matches.cancel({
      identity: alpha.identity, publicId: matchId, body: { reason: "other" }, expectedVersion: "1",
      idempotencyKey: "guard-cancel-match-0001"
    });
    await assert.rejects(database.query("UPDATE radar_match_mutation_requests SET payload_hash = $1", ["a".repeat(64)]));
    await assert.rejects(database.query("DELETE FROM match_audit_events WHERE match_id = $1", [matchRow.id]));
  } finally { await database.close(); }
});
