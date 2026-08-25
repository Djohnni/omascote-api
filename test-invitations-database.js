"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");
const { PGlite } = require("@electric-sql/pglite");
const { migrate } = require("./src/db/migrate");
const { createRadarConfig } = require("./src/config/radar");
const { createInvitationRepository } = require("./src/friendlies/invitation.repository");
const { createInvitationService } = require("./src/friendlies/invitation.service");

const BASE_NOW = new Date("2026-08-24T12:00:00.000Z");

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
    RADAR_INVITATIONS_SECURITY_SECRET: "invitation-test-secret-with-at-least-32-bytes",
    RADAR_INVITATION_RATE_WINDOW_SECONDS: "3600",
    RADAR_INVITATION_ACCOUNT_LIMIT: "200",
    RADAR_INVITATION_TEAM_LIMIT: "200",
    RADAR_INVITATION_IP_LIMIT: "500",
    RADAR_NOTIFICATION_PAGE_DEFAULT: "2",
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
      $1, $2, $3, $4, $5, $6, '4209102', 'Joinville', 'SC',
      ARRAY['society'], ARRAY['Livre'], 'intermediario', 25, 'either', $7,
      $8, $9, $10, $11, $12
    ) RETURNING id, public_slug
  `, [
    owner.profileId, owner.accountId, `${name}-fc`, overrides.status || "active", `${name}.fc`,
    overrides.verified === false ? "unverified" : "verified",
    overrides.available === false ? false : true,
    overrides.terms === false ? null : "2026-08-20T12:00:00.000Z",
    `${name} FC`, overrides.public === false ? false : true, overrides.crest === false ? false : true,
    overrides.status === "suspended" ? "2026-08-23T12:00:00.000Z" : null
  ]);
  const team = result.rows[0];
  if (overrides.slot !== false) {
    await database.query(`
      INSERT INTO friendly_availabilities(
        team_id, modality, category, declared_level, starts_at, ends_at,
        city_ibge_code, city_name, state_code, travel_radius_km,
        venue_preference, status, schedule_hash
      ) VALUES ($1, 'society', 'Livre', 'intermediario',
        '2026-09-05T18:00:00.000Z', '2026-09-05T21:00:00.000Z',
        '4209102', 'Joinville', 'SC', 25, 'either', 'active', $2)
    `, [team.id, name.padEnd(64, "0").slice(0, 64).replace(/[^0-9a-f]/g, "a")]);
  }
  return { ...team, identity: owner };
}

function proposal(opponentSlug, overrides = {}) {
  return {
    opponent_slug: opponentSlug,
    starts_at: "2026-09-05T19:00:00-03:00",
    ends_at: "2026-09-05T21:00:00-03:00",
    modality: "society",
    category: "Livre",
    venue_preference: "home",
    message: "Jogo amistoso no sabado.",
    ...overrides
  };
}

function service(database, clock = () => BASE_NOW, overrides = {}) {
  const radarConfig = config(overrides);
  const adapter = pool(database);
  return createInvitationService({
    repository: createInvitationRepository({ pool: adapter, config: radarConfig }),
    config: radarConfig,
    clock
  });
}

test("migration 008 runs twice and protects invitation, notification and idempotency history", async () => {
  const database = new PGlite();
  try {
    const adapter = pool(database);
    const applied = await migrate({ pool: adapter });
    assert.equal(applied.at(-1), "012_team_reviews_reputation.sql");
    assert.deepEqual(await migrate({ pool: adapter }), []);
    const tables = await database.query(`
      SELECT table_name FROM information_schema.tables
      WHERE table_name IN ('radar_invitation_mutation_requests', 'radar_invitation_rate_limits')
      ORDER BY table_name
    `);
    assert.equal(tables.rows.length, 2);
  } finally { await database.close(); }
});

test("invite, counter, accept and notifications are owned, idempotent and create one match", async () => {
  const database = new PGlite();
  try {
    await migrate({ pool: pool(database) });
    const alpha = await insertTeam(database, "alpha");
    const beta = await insertTeam(database, "beta");
    const api = service(database);
    const created = await api.create({
      identity: alpha.identity, body: proposal(beta.public_slug),
      idempotencyKey: "invite-create-0001", ip: "203.0.113.10", requestId: "req-create"
    });
    assert.equal(created.invitation.state, "pending");
    assert.equal(created.invitation.direction, "outgoing");
    assert.equal(created.invitation.opponent.slug, beta.public_slug);
    const replay = await api.create({
      identity: alpha.identity, body: proposal(beta.public_slug),
      idempotencyKey: "invite-create-0001", ip: "203.0.113.10"
    });
    assert.equal(replay.replayed, true);
    assert.equal(replay.invitation.invitation_id, created.invitation.invitation_id);
    await assert.rejects(api.create({
      identity: alpha.identity, body: proposal(beta.public_slug),
      idempotencyKey: "invite-duplicate-0002", ip: "203.0.113.10"
    }), error => error.code === "INVITATION_DUPLICATE");

    const inbox = await api.list({ identity: beta.identity, query: { caixa: "entrada" }, ip: "203.0.113.11" });
    assert.equal(inbox.items.length, 1);
    const counterBody = proposal(undefined, {
      opponent_slug: undefined,
      starts_at: "2026-09-06T09:30:00-03:00",
      ends_at: "2026-09-06T11:30:00-03:00",
      message: "Domingo cedo funciona melhor."
    });
    delete counterBody.opponent_slug;
    const countered = await api.counter({
      identity: beta.identity, publicId: created.invitation.invitation_id, body: counterBody,
      expectedVersion: 'W/"1"', idempotencyKey: "invite-counter-0001", ip: "203.0.113.11"
    });
    assert.equal(countered.invitation.state, "counter_proposed");
    assert.equal(countered.invitation.version, 2);
    await assert.rejects(api.accept({
      identity: beta.identity, publicId: created.invitation.invitation_id, body: {},
      expectedVersion: "2", idempotencyKey: "invite-self-accept-0001", ip: "203.0.113.11"
    }), error => error.code === "INVITATION_ACTION_FORBIDDEN");

    const accepted = await api.accept({
      identity: alpha.identity, publicId: created.invitation.invitation_id, body: {},
      expectedVersion: "2", idempotencyKey: "invite-accept-0001", ip: "203.0.113.10"
    });
    assert.equal(accepted.invitation.state, "accepted");
    assert.match(accepted.match.match_id, /^[0-9a-f-]{36}$/i);
    const acceptedReplay = await api.accept({
      identity: alpha.identity, publicId: created.invitation.invitation_id, body: {},
      expectedVersion: "2", idempotencyKey: "invite-accept-0001", ip: "203.0.113.10"
    });
    assert.equal(acceptedReplay.replayed, true);
    assert.equal((await database.query("SELECT count(*)::integer AS total FROM friendly_matches")).rows[0].total, 1);
    const notifications = await api.listNotifications({ identity: alpha.identity, query: {}, ip: "203.0.113.10" });
    assert.ok(notifications.items.some(item => item.type === "invitation_counter_proposed"));
    assert.ok(notifications.items.some(item => item.type === "match_confirmed"));
    const first = notifications.items[0];
    const read = await api.readNotification({
      identity: alpha.identity, publicId: first.notification_id, body: {},
      idempotencyKey: "notification-read-0001", ip: "203.0.113.10"
    });
    assert.equal(read.notification.read, true);
    const readReplay = await api.readNotification({
      identity: alpha.identity, publicId: first.notification_id, body: {},
      idempotencyKey: "notification-read-0001", ip: "203.0.113.10"
    });
    assert.equal(readReplay.replayed, true);

    const serialized = JSON.stringify({ created, inbox, countered, accepted, notifications }).toLowerCase();
    for (const forbidden of ["team_id", "account-", "profile-", "telefone", "whatsapp", "email", "latitude", "longitude", "address"]) {
      assert.equal(serialized.includes(forbidden), false, forbidden);
    }
    const audits = await database.query("SELECT event_type, payload::text AS payload FROM match_audit_events WHERE invitation_id IS NOT NULL");
    assert.deepEqual(new Set(audits.rows.map(row => row.event_type)), new Set([
      "friendly_invitation.created", "friendly_invitation.counter_proposed", "friendly_invitation.accepted"
    ]));
    assert.equal(audits.rows.some(row => row.payload.includes("Domingo cedo")), false);
    const rateRows = await database.query("SELECT scope_hash::text FROM radar_invitation_rate_limits");
    assert.ok(rateRows.rows.length > 0);
    assert.ok(rateRows.rows.every(row => /^[0-9a-f]{64}$/.test(row.scope_hash)));
  } finally { await database.close(); }
});

test("authorization, blocks, suspension, expiration and repeated acceptance fail safely", async () => {
  const database = new PGlite();
  try {
    await migrate({ pool: pool(database) });
    const alpha = await insertTeam(database, "owner");
    const beta = await insertTeam(database, "rival");
    const outsider = await insertTeam(database, "outsider");
    const suspended = await insertTeam(database, "suspended", { status: "suspended" });
    const api = service(database);
    await assert.rejects(api.create({
      identity: alpha.identity, body: proposal(alpha.public_slug),
      idempotencyKey: "invite-self-0001", ip: "198.51.100.1"
    }), error => error.code === "INVITATION_SELF_FORBIDDEN");
    await assert.rejects(api.create({
      identity: alpha.identity, body: proposal(suspended.public_slug),
      idempotencyKey: "invite-suspended-0001", ip: "198.51.100.1"
    }), error => error.code === "INVITATION_OPPONENT_NOT_ELIGIBLE");
    await database.query("INSERT INTO team_blocks(blocker_team_id, blocked_team_id) VALUES ($1, $2)", [beta.id, alpha.id]);
    await assert.rejects(api.create({
      identity: alpha.identity, body: proposal(beta.public_slug),
      idempotencyKey: "invite-blocked-0001", ip: "198.51.100.1"
    }), error => error.code === "INVITATION_BLOCKED");
    await database.query("DELETE FROM team_blocks WHERE blocker_team_id = $1", [beta.id]);
    const created = await api.create({
      identity: alpha.identity, body: proposal(beta.public_slug),
      idempotencyKey: "invite-race-create", ip: "198.51.100.1"
    });
    await assert.rejects(api.accept({
      identity: outsider.identity, publicId: created.invitation.invitation_id, body: {},
      expectedVersion: "1", idempotencyKey: "outsider-accept", ip: "198.51.100.3"
    }), error => error.code === "INVITATION_NOT_FOUND");
    await api.accept({
      identity: beta.identity, publicId: created.invitation.invitation_id, body: {},
      expectedVersion: "1", idempotencyKey: "race-accept-a", ip: "198.51.100.2"
    });
    await assert.rejects(api.accept({
      identity: beta.identity, publicId: created.invitation.invitation_id, body: {},
      expectedVersion: "1", idempotencyKey: "race-accept-b", ip: "198.51.100.2"
    }), error => ["INVITATION_VERSION_CONFLICT", "INVITATION_TERMINAL"].includes(error.code));
    assert.equal((await database.query("SELECT count(*)::integer AS total FROM friendly_matches")).rows[0].total, 1);

    const lateAlpha = await insertTeam(database, "late-owner");
    const lateBeta = await insertTeam(database, "late-rival");
    const short = service(database, () => BASE_NOW, { RADAR_INVITATION_EXPIRATION_HOURS: "1" });
    const expiring = await short.create({
      identity: lateAlpha.identity, body: proposal(lateBeta.public_slug),
      idempotencyKey: "expiring-create", ip: "192.0.2.10"
    });
    const later = service(database, () => new Date("2026-08-24T14:00:00.000Z"), { RADAR_INVITATION_EXPIRATION_HOURS: "1" });
    await assert.rejects(later.accept({
      identity: lateBeta.identity, publicId: expiring.invitation.invitation_id, body: {},
      expectedVersion: "1", idempotencyKey: "expired-accept", ip: "192.0.2.11"
    }), error => error.code === "INVITATION_EXPIRED");
    assert.equal((await database.query(
      "SELECT state FROM friendly_invitations WHERE public_id = $1",
      [expiring.invitation.invitation_id]
    )).rows[0].state, "expired");
  } finally { await database.close(); }
});

test("decline and cancellation are terminal and notify only the other participant", async () => {
  const database = new PGlite();
  try {
    await migrate({ pool: pool(database) });
    const alpha = await insertTeam(database, "decline-owner");
    const beta = await insertTeam(database, "decline-rival");
    const gamma = await insertTeam(database, "cancel-owner");
    const delta = await insertTeam(database, "cancel-rival");
    const api = service(database);
    const declineInvite = await api.create({
      identity: alpha.identity, body: proposal(beta.public_slug),
      idempotencyKey: "decline-create-0001", ip: "203.0.113.51"
    });
    const declined = await api.decline({
      identity: beta.identity, publicId: declineInvite.invitation.invitation_id, body: {},
      expectedVersion: "1", idempotencyKey: "decline-action-0001", ip: "203.0.113.52"
    });
    assert.equal(declined.invitation.state, "declined");
    await assert.rejects(api.accept({
      identity: beta.identity, publicId: declineInvite.invitation.invitation_id, body: {},
      expectedVersion: "2", idempotencyKey: "decline-terminal-0001", ip: "203.0.113.52"
    }), error => error.code === "INVITATION_TERMINAL");

    const cancelInvite = await api.create({
      identity: gamma.identity, body: proposal(delta.public_slug),
      idempotencyKey: "cancel-create-0001", ip: "203.0.113.53"
    });
    await assert.rejects(api.cancel({
      identity: delta.identity, publicId: cancelInvite.invitation.invitation_id, body: {},
      expectedVersion: "1", idempotencyKey: "cancel-wrong-actor-0001", ip: "203.0.113.54"
    }), error => error.code === "INVITATION_ACTION_FORBIDDEN");
    const cancelled = await api.cancel({
      identity: gamma.identity, publicId: cancelInvite.invitation.invitation_id, body: {},
      expectedVersion: "1", idempotencyKey: "cancel-action-0001", ip: "203.0.113.53"
    });
    assert.equal(cancelled.invitation.state, "cancelled");
    const alphaNotifications = await api.listNotifications({ identity: alpha.identity, query: {}, ip: "203.0.113.51" });
    const deltaNotifications = await api.listNotifications({ identity: delta.identity, query: {}, ip: "203.0.113.54" });
    assert.ok(alphaNotifications.items.some(item => item.type === "invitation_declined"));
    assert.ok(deltaNotifications.items.some(item => item.type === "invitation_cancelled"));
  } finally { await database.close(); }
});

test("persistent limits stop repeated invitation mutations and retain only opaque hashes", async () => {
  const database = new PGlite();
  try {
    await migrate({ pool: pool(database) });
    const alpha = await insertTeam(database, "limited-owner");
    const beta = await insertTeam(database, "limited-rival");
    const limited = service(database, () => BASE_NOW, {
      RADAR_INVITATION_ACCOUNT_LIMIT: "1",
      RADAR_INVITATION_TEAM_LIMIT: "1",
      RADAR_INVITATION_IP_LIMIT: "1"
    });
    await limited.create({
      identity: alpha.identity, body: proposal(beta.public_slug),
      idempotencyKey: "limited-create-0001", ip: "192.0.2.90"
    });
    await assert.rejects(limited.create({
      identity: alpha.identity,
      body: proposal(beta.public_slug, {
        starts_at: "2026-09-06T19:00:00-03:00",
        ends_at: "2026-09-06T21:00:00-03:00"
      }),
      idempotencyKey: "limited-create-0002", ip: "192.0.2.90"
    }), error => error.code === "INVITATION_RATE_LIMITED" && error.status === 429);
    const rows = await database.query("SELECT scope_hash::text FROM radar_invitation_rate_limits");
    assert.equal(rows.rows.length, 3);
    const serialized = JSON.stringify(rows.rows);
    assert.equal(serialized.includes(alpha.identity.accountId), false);
    assert.equal(serialized.includes(alpha.id), false);
  } finally { await database.close(); }
});
