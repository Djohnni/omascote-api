"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");
const crypto = require("node:crypto");
const { PGlite } = require("@electric-sql/pglite");
const { migrate } = require("./src/db/migrate");
const { createRadarConfig } = require("./src/config/radar");
const { createTeamReputationRepository } = require("./src/friendlies/team-reputation.repository");
const { createTeamReputationService } = require("./src/friendlies/team-reputation.service");

const NOW = new Date("2026-08-24T18:00:00.000Z");

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
    RADAR_REPUTATION_ENABLED: "true",
    RADAR_REPUTATION_SECURITY_SECRET: "reputation-database-secret-at-least-32-bytes",
    ...overrides
  });
}

function service(database, overrides = {}) {
  const radarConfig = config(overrides);
  return createTeamReputationService({
    repository: createTeamReputationRepository({ pool: pool(database) }),
    config: radarConfig,
    clock: () => NOW
  });
}

async function insertTeam(database, name, status = "active") {
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
      $1, $2, $3, $4, $5, 'verified', '4209102', 'Joinville', 'SC',
      ARRAY['society'], ARRAY['Livre'], 'intermediario', 25, 'either', true,
      '2026-04-20T12:00:00.000Z', $6, true, true
    ) RETURNING id, public_id, public_slug, public_name
  `, [owner.profileId, owner.accountId, `${name}-fc`, status, `${name}.fc`, `${name} FC`]);
  return { ...result.rows[0], identity: owner };
}

async function insertMatch(database, first, second, suffix, state = "official") {
  const digest = value => crypto.createHash("sha256").update(value).digest("hex");
  const invitation = await database.query(`
    INSERT INTO friendly_invitations(
      requester_team_id, invited_team_id, state, proposal, proposal_hash,
      idempotency_key, idempotency_payload_hash, expires_at, accepted_at
    ) VALUES (
      $1, $2, 'accepted', '{"modality":"society","category":"Livre"}',
      $3, $4, $5, '2026-09-30T18:00:00.000Z', '2026-08-01T18:00:00.000Z'
    ) RETURNING id
  `, [first.id, second.id, digest(`proposal-${suffix}`), `invite-${suffix}`, digest(`payload-${suffix}`)]);
  const values = state === "official"
    ? ["played", "verified", 3, 2, "2026-08-24T16:00:00.000Z", null, null, null]
    : state === "divergent"
      ? ["played", "divergent", null, null, null, null, null, null]
      : ["cancelled", "empty", null, null, null, "weather", first.id, "2026-08-23T18:00:00.000Z"];
  const result = await database.query(`
    INSERT INTO friendly_matches(
      invitation_id, team_a_id, team_b_id, team_a_snapshot, team_b_snapshot,
      scheduled_at, occurrence_state, result_state,
      verified_team_a_goals, verified_team_b_goals, verified_result_at,
      occurrence_confirmed_at, cancellation_reason, cancelled_by_team_id, cancelled_at
    ) VALUES (
      $1, $2, $3, '{}', '{}', $4,
      $5, $6, $7, $8, $9,
      CASE WHEN $5 = 'played' THEN '2026-08-24T15:00:00.000Z'::timestamptz ELSE NULL END,
      $10, $11, $12
    ) RETURNING id, public_id
  `, [
    invitation.rows[0].id, first.id, second.id, `2026-08-${String(10 + Number(suffix.replace(/\D/g, "") || 0)).padStart(2, "0")}T18:00:00.000Z`,
    ...values
  ]);
  return result.rows[0];
}

function review(overrides = {}) {
  return {
    pontualidade: 5,
    organizacao: 4,
    comunicacao: 5,
    fair_play: 5,
    jogaria_novamente: true,
    ...overrides
  };
}

async function submit(reputations, team, match, key, values = review()) {
  return reputations.submit({
    identity: team.identity,
    publicId: match.public_id,
    body: values,
    idempotencyKey: key,
    requestId: `request-${key}`
  });
}

test("PostgreSQL reputation migration and verified anonymous aggregates", async t => {
  const database = new PGlite();
  try {
    const adapter = pool(database);
    const applied = await migrate({ pool: adapter });

    await t.test("migration 012 is incremental, renamed and idempotent", async () => {
      assert.equal(applied.at(-1), "012_team_reviews_reputation.sql");
      assert.deepEqual(await migrate({ pool: adapter }), []);
      const columns = await database.query(`
        SELECT column_name FROM information_schema.columns
        WHERE table_name = 'team_reviews'
          AND column_name IN ('communication', 'perceived_level')
      `);
      assert.deepEqual(columns.rows.map(row => row.column_name), ["communication"]);
      const tables = await database.query(`
        SELECT tablename FROM pg_tables
        WHERE tablename IN ('team_reputation_aggregates', 'team_reputation_applications')
      `);
      assert.equal(tables.rows.length, 2);
    });

    const alpha = await insertTeam(database, "review-alpha");
    const beta = await insertTeam(database, "review-beta");
    const outsider = await insertTeam(database, "review-outsider");
    const officialOne = await insertMatch(database, alpha, beta, "1");
    const officialTwo = await insertMatch(database, alpha, beta, "2");
    const officialThree = await insertMatch(database, alpha, beta, "3");
    const cancelled = await insertMatch(database, alpha, beta, "4", "cancelled");
    const divergent = await insertMatch(database, alpha, beta, "5", "divergent");
    const reputations = service(database);

    await t.test("only a participant can review an official result", async () => {
      await assert.rejects(submit(reputations, outsider, officialOne, "outsider-review-0001"), error => error.code === "MATCH_NOT_FOUND");
      await assert.rejects(submit(reputations, alpha, cancelled, "cancelled-review-0001"), error => error.code === "TEAM_REVIEW_NOT_ELIGIBLE");
      await assert.rejects(submit(reputations, alpha, divergent, "divergent-review-0001"), error => error.code === "TEAM_REVIEW_NOT_ELIGIBLE");
      assert.equal((await database.query("SELECT count(*)::integer AS total FROM team_reviews")).rows[0].total, 0);
    });

    await t.test("a submitted review is immutable, unique and idempotent", async () => {
      const first = await submit(reputations, alpha, officialOne, "review-alpha-one-0001");
      const replay = await submit(reputations, alpha, officialOne, "review-alpha-one-0001");
      assert.equal(first.replayed, false);
      assert.equal(replay.replayed, true);
      await assert.rejects(submit(reputations, alpha, officialOne, "review-alpha-one-0002"), error => error.code === "TEAM_REVIEW_ALREADY_SUBMITTED");
      const stored = (await database.query("SELECT id FROM team_reviews")).rows[0];
      await assert.rejects(database.query("UPDATE team_reviews SET fair_play = 1 WHERE id = $1", [stored.id]));
      await assert.rejects(database.query("DELETE FROM team_reviews WHERE id = $1", [stored.id]));
      assert.equal((await database.query("SELECT count(*)::integer AS total FROM team_reputation_applications")).rows[0].total, 1);
      assert.equal((await database.query("SELECT verified_review_count FROM team_reputation_aggregates WHERE team_id = $1", [beta.id])).rows[0].verified_review_count, 1);
    });

    await t.test("scores remain hidden until three verified assessments", async () => {
      const initial = await reputations.publicReputation({ teamPublicId: beta.public_id });
      assert.deepEqual(initial.reputation, {
        team: { public_id: beta.public_id, slug: beta.public_slug, name: beta.public_name },
        state: "new",
        label: "Reputacao nova"
      });
      await submit(reputations, alpha, officialTwo, "review-alpha-two-0001", review({ organizacao: 5 }));
      assert.equal((await reputations.publicReputation({ teamPublicId: beta.public_id })).reputation.state, "new");
      await submit(reputations, alpha, officialThree, "review-alpha-three-0001", review({ pontualidade: 4, comunicacao: 4, jogaria_novamente: false }));
      const published = (await reputations.publicReputation({ teamPublicId: beta.public_id })).reputation;
      assert.equal(published.state, "established");
      assert.equal(published.verified_evaluations, 3);
      assert.deepEqual(published.criteria, {
        pontualidade: 4.7,
        organizacao: 4.3,
        comunicacao: 4.7,
        fair_play: 5
      });
      assert.equal(published.overall, 4.7);
      assert.equal(published.would_play_again_percent, 67);
    });

    await t.test("pending list removes submitted matches and never exposes private data", async () => {
      const betaPending = await reputations.pending({ identity: beta.identity });
      assert.equal(betaPending.items.length, 3);
      const alphaPending = await reputations.pending({ identity: alpha.identity });
      assert.equal(alphaPending.items.length, 0);
      const serialized = JSON.stringify(betaPending);
      for (const forbidden of ["account-review", "profile-review", "reviewer", "whatsapp", "contact", "address"]) {
        assert.equal(serialized.includes(forbidden), false);
      }
    });

    await t.test("both participants aggregate independently without revealing evaluators", async () => {
      await submit(reputations, beta, officialOne, "review-beta-one-0001", review({ fair_play: 4 }));
      const own = await reputations.own({ identity: alpha.identity });
      assert.equal(own.reputation.state, "new");
      const databaseRows = await database.query(`
        SELECT verified_review_count FROM team_reputation_aggregates
        WHERE team_id IN ($1, $2) ORDER BY verified_review_count
      `, [alpha.id, beta.id]);
      assert.deepEqual(databaseRows.rows.map(row => row.verified_review_count), [1, 3]);
      const publicPayload = JSON.stringify(await reputations.publicReputation({ teamPublicId: beta.public_id }));
      assert.equal(publicPayload.includes(alpha.id), false);
      assert.equal(publicPayload.includes(alpha.identity.accountId), false);
      assert.equal(publicPayload.includes(officialOne.public_id), false);
    });

    await t.test("database guards self-review and repeated applications", async () => {
      await assert.rejects(database.query(`
        INSERT INTO team_reviews(
          match_id, reviewer_team_id, reviewed_team_id,
          fair_play, punctuality, organization, communication,
          would_play_again, idempotency_key, idempotency_payload_hash
        ) VALUES ($1, $2, $2, 5, 5, 5, 5, true, 'self-review-key', $3)
      `, [officialTwo.id, alpha.id, "a".repeat(64)]));
      const application = (await database.query("SELECT * FROM team_reputation_applications LIMIT 1")).rows[0];
      await assert.rejects(database.query(`
        INSERT INTO team_reputation_applications(review_id, reviewed_team_id)
        VALUES ($1, $2)
      `, [application.review_id, application.reviewed_team_id]));
    });

    await t.test("suspended teams cannot submit and public hidden teams cannot be enumerated", async () => {
      const suspended = await insertTeam(database, "review-suspended", "suspended");
      const suspendedMatch = await insertMatch(database, suspended, outsider, "6");
      await assert.rejects(submit(reputations, suspended, suspendedMatch, "suspended-review-0001"), error => error.code === "RADAR_PROFILE_SUSPENDED");
      await assert.rejects(reputations.publicReputation({ teamPublicId: suspended.public_id }), error => error.code === "TEAM_REPUTATION_NOT_FOUND");
    });

    await t.test("audit is append-only and contains no scores, contacts or idempotency key", async () => {
      const audit = await database.query(`
        SELECT id, event_type, payload FROM match_audit_events
        WHERE event_type = 'friendly_match.review_submitted'
      `);
      assert.equal(audit.rows.length, 4);
      const serialized = JSON.stringify(audit.rows);
      for (const forbidden of ["pontualidade", "fair_play", "jogaria", "review-alpha-one-0001", "whatsapp", "contact"]) {
        assert.equal(serialized.includes(forbidden), false);
      }
      await assert.rejects(database.query("UPDATE match_audit_events SET payload = '{}' WHERE id = $1", [audit.rows[0].id]));
    });
  } finally { await database.close(); }
});

test("competing review intents never apply reputation twice", async () => {
  const database = new PGlite();
  try {
    await migrate({ pool: pool(database) });
    const alpha = await insertTeam(database, "race-review-alpha");
    const beta = await insertTeam(database, "race-review-beta");
    const match = await insertMatch(database, alpha, beta, "7");
    const reputations = service(database);
    const first = await submit(reputations, alpha, match, "race-review-key-0001");
    assert.equal(first.replayed, false);
    await assert.rejects(submit(reputations, alpha, match, "race-review-key-0002"), error => error.code === "TEAM_REVIEW_ALREADY_SUBMITTED");
    const counts = await database.query(`
      SELECT
        (SELECT count(*)::integer FROM team_reviews) AS reviews,
        (SELECT count(*)::integer FROM team_reputation_applications) AS applications,
        (SELECT verified_review_count FROM team_reputation_aggregates WHERE team_id = $1) AS aggregate_count
    `, [beta.id]);
    assert.deepEqual(counts.rows[0], { reviews: 1, applications: 1, aggregate_count: 1 });
  } finally { await database.close(); }
});

test("database uniqueness admits only one simultaneous review insert", async () => {
  const database = new PGlite();
  try {
    await migrate({ pool: pool(database) });
    const alpha = await insertTeam(database, "parallel-review-alpha");
    const beta = await insertTeam(database, "parallel-review-beta");
    const match = await insertMatch(database, alpha, beta, "8");
    const insert = (key, hash) => database.query(`
      INSERT INTO team_reviews(
        match_id, reviewer_team_id, reviewed_team_id,
        fair_play, punctuality, organization, communication,
        would_play_again, idempotency_key, idempotency_payload_hash
      ) VALUES ($1, $2, $3, 5, 5, 5, 5, true, $4, $5)
    `, [match.id, alpha.id, beta.id, key, hash]);
    const intents = await Promise.allSettled([
      insert("parallel-review-key-0001", "a".repeat(64)),
      insert("parallel-review-key-0002", "b".repeat(64))
    ]);
    assert.equal(intents.filter(item => item.status === "fulfilled").length, 1);
    assert.equal(intents.filter(item => item.status === "rejected").length, 1);
    assert.equal((await database.query("SELECT count(*)::integer AS total FROM team_reviews")).rows[0].total, 1);
  } finally { await database.close(); }
});
