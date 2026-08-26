"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");
const { PGlite } = require("@electric-sql/pglite");
const { migrate } = require("./src/db/migrate");
const { createRadarConfig } = require("./src/config/radar");
const { createRadarIdentityRepository } = require("./src/friendlies/radar-identity.repository");
const { createRadarIdentityService } = require("./src/friendlies/radar-identity.service");
const { createRadarAccountSynchronizer } = require("./src/friendlies/radar-account-sync");

function normalizeResult(result) {
  const last = Array.isArray(result) ? result.at(-1) : result;
  if (!last) return { rows: [], rowCount: 0 };
  return { ...last, rowCount: last.rows?.length || last.affectedRows || 0 };
}

function poolFor(database) {
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

function identity(suffix, overrides = {}) {
  return Object.freeze({
    authSubject: `login-${suffix}`,
    accountId: `account-${suffix}`,
    profileId: `profile-${suffix}`,
    legacyProfile: Object.freeze({
      slug: `clube-${suffix}`,
      nome_time: `Clube ${suffix}`,
      publico: false,
      ...overrides
    })
  });
}

test("active legacy accounts join automatically exactly once without optional profile data", async () => {
  const database = new PGlite();
  const pool = poolFor(database);
  try {
    assert.equal((await migrate({ pool })).at(-1), "016_match_communication.sql");
    assert.deepEqual(await migrate({ pool }), []);
    const repository = createRadarIdentityRepository({ pool });
    const service = createRadarIdentityService({
      repository,
      config: createRadarConfig({ RADAR_AMISTOSOS_ENABLED: "true" })
    });
    const owner = identity("new");
    const first = await service.getProfile(owner);
    const second = await service.getProfile(owner);
    assert.equal(first.profile.status, "active");
    assert.equal(first.profile.radar_visible, true);
    assert.equal(first.eligibility.eligible, true);
    assert.equal(first.eligibility.discoverable, true);
    assert.equal(first.eligibility.instagram_verified, false);
    assert.equal(second.profile.public_id, first.profile.public_id);
    assert.equal((await database.query("SELECT count(*)::integer AS total FROM radar_team_profiles")).rows[0].total, 1);
    assert.equal((await database.query("SELECT count(*)::integer AS total FROM match_audit_events WHERE event_type = 'radar_profile.automatic_joined'")).rows[0].total, 1);
  } finally { await database.close(); }
});

test("backfill includes every active team, skips inactive accounts and is idempotent", async () => {
  const database = new PGlite();
  const pool = poolFor(database);
  try {
    await migrate({ pool });
    const identities = new Map([["a", identity("a")], ["b", identity("b")]]);
    const synchronizer = createRadarAccountSynchronizer({
      repository: createRadarIdentityRepository({ pool }),
      resolveIdentity: user => identities.get(user.whatsapp),
      listAccounts: () => ({ a: { ativo: true }, b: { ativo: true }, off: { ativo: false } })
    });
    const first = await synchronizer.backfill();
    const second = await synchronizer.backfill();
    assert.deepEqual(first, {
      active_accounts: 2, created: 2, reconciled: 0, unchanged: 0, skipped: 1, failed: 0
    });
    assert.deepEqual(second, {
      active_accounts: 2, created: 0, reconciled: 0, unchanged: 2, skipped: 1, failed: 0
    });
    assert.equal((await database.query("SELECT count(*)::integer AS total FROM radar_team_profiles")).rows[0].total, 2);
  } finally { await database.close(); }
});

test("login-like identifiers never become a public team name or slug", async () => {
  const database = new PGlite();
  const pool = poolFor(database);
  try {
    await migrate({ pool });
    const privateIdentity = Object.freeze({
      authSubject: "5511999999999",
      accountId: "legacy_opaque_reference",
      profileId: "profile-private-name",
      legacyProfile: Object.freeze({ slug: "5511999999999", nome_time: "5511999999999", publico: false })
    });
    const result = await createRadarIdentityRepository({ pool }).reconcileOwnedProfile({ identity: privateIdentity });
    assert.equal(result.team.publicName, "Time do Meu Clube FC");
    assert.match(result.team.publicSlug, /^time-[0-9a-f]{16}$/);
    assert.equal(JSON.stringify(result.team).includes(privateIdentity.authSubject), false);
  } finally { await database.close(); }
});

test("account login finalization rebinds the same legacy team instead of creating a duplicate", async () => {
  const database = new PGlite();
  const pool = poolFor(database);
  try {
    await migrate({ pool });
    const repository = createRadarIdentityRepository({ pool });
    const provisional = identity("provisional");
    await repository.reconcileOwnedProfile({ identity: provisional });
    const finalized = Object.freeze({
      ...provisional,
      authSubject: "final-login",
      accountId: "account-final",
      legacyProfile: Object.freeze({ ...provisional.legacyProfile, nome_time: "Clube Final" })
    });
    const rebound = await repository.reconcileOwnedProfile({
      identity: finalized,
      allowAccountRebind: true
    });
    assert.equal(rebound.created, false);
    assert.equal(rebound.changed, true);
    assert.equal(rebound.team.accountReference, finalized.accountId);
    assert.equal(rebound.team.publicName, "Clube Final");
    assert.equal((await database.query("SELECT count(*)::integer AS total FROM radar_team_profiles")).rows[0].total, 1);
  } finally { await database.close(); }
});

test("owner can explicitly hide the team without changing optional improvements", async () => {
  const database = new PGlite();
  const pool = poolFor(database);
  try {
    await migrate({ pool });
    const owner = identity("visibility");
    const service = createRadarIdentityService({
      repository: createRadarIdentityRepository({ pool }),
      config: createRadarConfig({ RADAR_AMISTOSOS_ENABLED: "true" })
    });
    const joined = await service.getProfile(owner);
    const hidden = await service.putProfile({
      identity: owner,
      body: { radar_visible: false },
      idempotencyKey: "automatic-hide-team-0001",
      expectedVersion: String(joined.profile.version)
    });
    assert.equal(hidden.profile.radar_visible, false);
    assert.equal(hidden.eligibility.eligible, true);
    assert.equal(hidden.eligibility.discoverable, false);
    assert.equal(hidden.profile.instagram_handle, null);
    assert.deepEqual(hidden.profile.modalities, []);
  } finally { await database.close(); }
});
