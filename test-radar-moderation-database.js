"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");
const crypto = require("node:crypto");
const { PGlite } = require("@electric-sql/pglite");
const { migrate } = require("./src/db/migrate");
const { createRadarConfig } = require("./src/config/radar");
const { createRadarModerationRepository } = require("./src/friendlies/radar-moderation.repository");
const { createRadarModerationService } = require("./src/friendlies/radar-moderation.service");
const { createMatchCenterRepository } = require("./src/friendlies/match-center.repository");

const START = new Date("2026-08-25T12:00:00.000Z");
let currentTime = START;

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
    RADAR_MODERATION_ENABLED: "true",
    RADAR_MODERATION_SECURITY_SECRET: "moderation-database-secret-at-least-32-bytes",
    RADAR_MODERATION_RETENTION_DAYS: "30",
    RADAR_MODERATION_SLA_HOURS: "24",
    ...overrides
  });
}

function service(database, overrides = {}) {
  const radarConfig = config(overrides);
  return createRadarModerationService({
    repository: createRadarModerationRepository({ pool: pool(database), config: radarConfig }),
    config: radarConfig,
    clock: () => currentTime
  });
}

async function insertTeam(database, name) {
  const owner = identity(name);
  const result = await database.query(`
    INSERT INTO radar_team_profiles(
      legacy_profile_id, account_reference, public_slug, status,
      instagram_handle, instagram_verification_status,
      city_ibge_code, city_name, state_code, modalities, categories,
      declared_level, availability_active, radar_terms_accepted_at,
      public_name, public_profile_enabled, public_crest_available
    ) VALUES (
      $1, $2, $3, 'active', $4, 'verified', '4209102', 'Joinville', 'SC',
      ARRAY['society'], ARRAY['Livre'], 'intermediario', true,
      '2026-08-01T12:00:00Z', $5, true, true
    ) RETURNING id, public_id, public_slug, public_name
  `, [owner.profileId, owner.accountId, `${name}-fc`, `${name}.fc`, `${name} FC`]);
  return { ...result.rows[0], identity: owner };
}

async function insertInvitation(database, first, second, suffix, state = "pending") {
  const hash = value => crypto.createHash("sha256").update(value).digest("hex");
  const result = await database.query(`
    INSERT INTO friendly_invitations(
      requester_team_id, invited_team_id, state, proposal, proposal_hash,
      idempotency_key, idempotency_payload_hash, expires_at, accepted_at
    ) VALUES (
      $1, $2, $3, '{"modality":"society","category":"Livre"}', $4,
      $5, $6, '2026-09-01T18:00:00Z',
      CASE WHEN $3 = 'accepted' THEN '2026-08-20T12:00:00Z'::timestamptz ELSE NULL END
    ) RETURNING id, public_id
  `, [first.id, second.id, state, hash(`proposal-${suffix}`), `invite-${suffix}`, hash(`payload-${suffix}`)]);
  return result.rows[0];
}

async function insertVerifiedMatch(database, first, second) {
  const invitation = await insertInvitation(database, first, second, "verified", "accepted");
  const result = await database.query(`
    INSERT INTO friendly_matches(
      invitation_id, team_a_id, team_b_id, team_a_snapshot, team_b_snapshot,
      scheduled_at, occurrence_state, result_state,
      verified_team_a_goals, verified_team_b_goals,
      verified_result_at, occurrence_confirmed_at
    ) VALUES (
      $1, $2, $3, '{"name":"Alpha FC"}', '{"name":"Beta FC"}',
      '2026-08-24T18:00:00Z', 'played', 'verified', 3, 1,
      '2026-08-25T10:00:00Z', '2026-08-25T09:00:00Z'
    ) RETURNING id, public_id, invitation_id
  `, [invitation.id, first.id, second.id]);
  await database.query(`
    INSERT INTO radar_match_statistic_applications(
      match_id, team_a_id, team_b_id, team_a_goals, team_b_goals, result_hash
    ) VALUES ($1,$2,$3,3,1,$4)
  `, [result.rows[0].id, first.id, second.id, "a".repeat(64)]);
  await database.query(`
    INSERT INTO radar_team_verified_statistics(team_id,matches_played,wins,draws,losses,goals_for,goals_against)
    VALUES ($1,1,1,0,0,3,1), ($2,1,0,0,1,1,3)
  `, [first.id, second.id]);
  return result.rows[0];
}

async function insertReview(database, match, reviewer, reviewed, suffix, scores = [5, 4, 5, 5, true]) {
  const result = await database.query(`
    INSERT INTO team_reviews(
      match_id, reviewer_team_id, reviewed_team_id,
      punctuality, organization, communication, fair_play, would_play_again,
      publication_state, idempotency_key, idempotency_payload_hash
    ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,'blind',$9,$10) RETURNING *
  `, [match.id, reviewer.id, reviewed.id, ...scores, `review-${suffix}`, "b".repeat(64)]);
  const review = result.rows[0];
  await database.query("INSERT INTO team_reputation_applications(review_id, reviewed_team_id) VALUES ($1,$2)", [review.id, reviewed.id]);
  await database.query(`
    INSERT INTO team_reputation_aggregates(
      team_id, verified_review_count, punctuality_sum, organization_sum,
      communication_sum, fair_play_sum, would_play_again_count
    ) VALUES ($1,1,$2,$3,$4,$5,$6)
    ON CONFLICT (team_id) DO UPDATE SET
      verified_review_count = team_reputation_aggregates.verified_review_count + 1,
      punctuality_sum = team_reputation_aggregates.punctuality_sum + EXCLUDED.punctuality_sum,
      organization_sum = team_reputation_aggregates.organization_sum + EXCLUDED.organization_sum,
      communication_sum = team_reputation_aggregates.communication_sum + EXCLUDED.communication_sum,
      fair_play_sum = team_reputation_aggregates.fair_play_sum + EXCLUDED.fair_play_sum,
      would_play_again_count = team_reputation_aggregates.would_play_again_count + EXCLUDED.would_play_again_count,
      version = team_reputation_aggregates.version + 1
  `, [reviewed.id, ...scores.slice(0, 4), scores[4] ? 1 : 0]);
  return review;
}

function mutation(identityValue, body, key) {
  return { identity: identityValue, body, idempotencyKey: key, requestId: `request-${key}`, ip: "127.0.0.1" };
}

test("PostgreSQL Radar moderation, privacy and compensations", async t => {
  const database = new PGlite();
  try {
    const adapter = pool(database);
    const applied = await migrate({ pool: adapter });
    const radar = service(database);
    const alpha = await insertTeam(database, "alpha");
    const beta = await insertTeam(database, "beta");
    const moderator = identity("moderator");
    const admin = identity("admin");

    await t.test("migration 013 is incremental and the runner is idempotent", async () => {
      assert.equal(applied.at(-1), "013_radar_safety_privacy_moderation.sql");
      assert.deepEqual(await migrate({ pool: adapter }), []);
      const tables = await database.query(`
        SELECT table_name FROM information_schema.tables
        WHERE table_name IN ('radar_moderation_cases','radar_match_statistic_compensations','radar_departure_records')
      `);
      assert.equal(tables.rows.length, 3);
    });

    const pending = await insertInvitation(database, alpha, beta, "pending");
    await t.test("a block is bilateral and closes pending invitations", async () => {
      const result = await radar.block(mutation(alpha.identity, {
        team_public_id: beta.public_id, motivo: "safety"
      }, "block-key-1"));
      assert.equal(result.blocked, true);
      assert.equal(result.pending_invitations_closed, 1);
      assert.equal((await database.query("SELECT state FROM friendly_invitations WHERE id=$1", [pending.id])).rows[0].state, "cancelled");
      const bilateral = await database.query(`
        SELECT 1 FROM team_blocks WHERE
          (blocker_team_id=$1 AND blocked_team_id=$2) OR (blocker_team_id=$2 AND blocked_team_id=$1)
      `, [alpha.id, beta.id]);
      assert.equal(bilateral.rows.length, 1);
    });

    await t.test("contact is hidden again while either participant blocks", async () => {
      const match = await insertVerifiedMatch(database, alpha, beta);
      const center = createMatchCenterRepository({ pool: adapter });
      const detail = await center.getOwned({ identity: alpha.identity, publicId: match.public_id });
      assert.equal(detail.match.contact_unlocked, false);
      assert.equal(detail.opponentAccountReference, null);
    });

    await t.test("unblock removes only the owner's relation and is idempotent", async () => {
      const first = await radar.unblock({
        identity: alpha.identity, teamPublicId: beta.public_id,
        idempotencyKey: "unblock-1", requestId: "request-unblock", ip: "127.0.0.1"
      });
      const repeated = await radar.unblock({
        identity: alpha.identity, teamPublicId: beta.public_id,
        idempotencyKey: "unblock-1", requestId: "request-unblock", ip: "127.0.0.1"
      });
      assert.equal(first.was_blocked, true);
      assert.equal(repeated.replayed, true);
    });

    let teamCase;
    await t.test("reports are private and never identify the reporter to the target", async () => {
      const created = await radar.report(mutation(alpha.identity, {
        tipo: "time", team_public_id: beta.public_id,
        categoria: "harassment", descricao: "Mensagem privada de prova"
      }, "report-team"));
      teamCase = created.case;
      const mine = await radar.listCases({ identity: alpha.identity });
      const targetView = await radar.listCases({ identity: beta.identity });
      assert.equal(mine.items.length, 1);
      assert.equal(targetView.items.length, 0);
      assert.equal(JSON.stringify(mine).includes("account-alpha"), false);
      const audit = await database.query("SELECT payload::text FROM match_audit_events WHERE event_type LIKE 'radar_moderation.%_created'");
      assert.equal(JSON.stringify(audit.rows).includes("Mensagem privada de prova"), false);
    });

    await t.test("false administrators cannot read the queue", async () => {
      await assert.rejects(radar.adminQueue({ identity: identity("fake"), query: {} }), error => error.code === "RADAR_MODERATION_FORBIDDEN");
    });

    await database.query(`
      INSERT INTO radar_account_roles(account_reference, role, granted_by_account_reference)
      VALUES ($1,'radar_moderator',$3), ($2,'radar_admin',$3)
    `, [moderator.accountId, admin.accountId, admin.accountId]);

    await t.test("active moderator and administrator roles can access the queue", async () => {
      assert.equal((await radar.adminQueue({ identity: moderator, query: {} })).items.length, 1);
      assert.equal((await radar.adminQueue({ identity: admin, query: {} })).items.length, 1);
    });

    await database.query(`
      INSERT INTO radar_account_roles(account_reference, role, granted_by_account_reference)
      VALUES ($1,'radar_moderator',$2)
    `, [alpha.identity.accountId, admin.accountId]);
    await t.test("a moderator cannot take a case related to the own team", async () => {
      await assert.rejects(radar.assign({
        ...mutation(alpha.identity, { motivo: "triage" }, "self-assign"),
        casePublicId: teamCase.case_id, ifMatch: '"1"'
      }), error => error.code === "RADAR_MODERATION_SELF_CASE_FORBIDDEN");
    });

    await t.test("assignment uses version and idempotency against repeated decisions", async () => {
      const assigned = await radar.assign({
        ...mutation(moderator, { motivo: "triage" }, "assign-1"),
        casePublicId: teamCase.case_id, ifMatch: 'W/"1"'
      });
      const replayed = await radar.assign({
        ...mutation(moderator, { motivo: "triage" }, "assign-1"),
        casePublicId: teamCase.case_id, ifMatch: 'W/"1"'
      });
      assert.equal(assigned.case.version, 2);
      assert.equal(replayed.replayed, true);
      await assert.rejects(radar.assign({
        ...mutation(admin, { motivo: "workload" }, "assign-stale"),
        casePublicId: teamCase.case_id, ifMatch: '"1"'
      }), error => error.code === "RADAR_MODERATION_VERSION_CONFLICT");
    });

    const match = (await database.query("SELECT id, public_id FROM friendly_matches LIMIT 1")).rows[0];
    await insertReview(database, match, beta, alpha, "beta-alpha");
    await insertReview(database, match, alpha, beta, "alpha-beta", [4, 4, 4, 4, false]);

    let reviewCase;
    await t.test("invalid review is compensated exactly once without rewriting it", async () => {
      reviewCase = (await radar.report(mutation(alpha.identity, {
        tipo: "partida", match_id: match.public_id,
        categoria: "other", descricao: "Avaliacao sob analise"
      }, "report-review"))).case;
      const resolved = await radar.resolve({
        ...mutation(admin, { decisao: "invalidate_review", motivo: "invalid_review" }, "resolve-review"),
        casePublicId: reviewCase.case_id, ifMatch: '"1"'
      });
      const replayed = await radar.resolve({
        ...mutation(admin, { decisao: "invalidate_review", motivo: "invalid_review" }, "resolve-review"),
        casePublicId: reviewCase.case_id, ifMatch: '"1"'
      });
      assert.equal(resolved.case.status, "resolved");
      assert.equal(replayed.replayed, true);
      assert.equal((await database.query("SELECT verified_review_count FROM team_reputation_aggregates WHERE team_id=$1", [alpha.id])).rows[0].verified_review_count, 0);
      assert.equal((await database.query("SELECT count(*)::int AS total FROM team_reviews WHERE reviewed_team_id=$1", [alpha.id])).rows[0].total, 1);
      assert.equal((await database.query("SELECT count(*)::int AS total FROM radar_review_moderation_compensations WHERE case_id=(SELECT id FROM radar_moderation_cases WHERE public_id=$1)", [reviewCase.case_id])).rows[0].total, 1);
    });

    await t.test("result dispute does not change the score before an administrative decision", async () => {
      const dispute = await radar.dispute({
        ...mutation(alpha.identity, { motivo: "score_incorrect", descricao: "Placar informado incorretamente" }, "dispute-1"),
        matchPublicId: match.public_id
      });
      assert.equal(dispute.case.type, "result_dispute");
      const original = await database.query("SELECT verified_team_a_goals, result_state FROM friendly_matches WHERE id=$1", [match.id]);
      assert.deepEqual(original.rows[0], { verified_team_a_goals: 3, result_state: "verified" });
      await assert.rejects(radar.dispute({
        ...mutation(alpha.identity, { motivo: "score_incorrect" }, "dispute-2"), matchPublicId: match.public_id
      }), error => error.code === "RADAR_DISPUTE_ALREADY_OPEN");
      const resolved = await radar.resolve({
        ...mutation(admin, { decisao: "invalidate_result", motivo: "invalid_result" }, "resolve-result"),
        casePublicId: dispute.case.case_id, ifMatch: '"1"'
      });
      assert.equal(resolved.case.status, "resolved");
    });

    await t.test("invalid result removes statistics and related reputation transactionally", async () => {
      const stats = await database.query("SELECT team_id, matches_played FROM radar_team_verified_statistics ORDER BY team_id");
      assert.deepEqual(stats.rows.map(row => row.matches_played), [0, 0]);
      assert.equal((await database.query("SELECT count(*)::int AS total FROM radar_match_statistic_compensations")).rows[0].total, 1);
      assert.equal((await database.query("SELECT verified_review_count FROM team_reputation_aggregates WHERE team_id=$1", [beta.id])).rows[0].verified_review_count, 0);
      assert.equal((await database.query("SELECT verified_team_a_goals FROM friendly_matches WHERE id=$1", [match.id])).rows[0].verified_team_a_goals, 3);
    });

    await t.test("retention erases only the private description and appends an event", async () => {
      await database.query("UPDATE radar_moderation_cases SET retention_expires_at=$1 WHERE public_id=$2", [new Date(START.getTime() - 1000), teamCase.case_id]);
      await radar.listCases({ identity: alpha.identity });
      const retained = await database.query("SELECT private_description, description_erased_at FROM radar_moderation_cases WHERE public_id=$1", [teamCase.case_id]);
      assert.equal(retained.rows[0].private_description, null);
      assert.ok(retained.rows[0].description_erased_at);
      const events = await database.query("SELECT count(*)::int AS total FROM radar_moderation_case_events WHERE event_type='description_erased'");
      assert.equal(events.rows[0].total, 1);
    });

    await t.test("Radar exit hides and minimizes the profile while closing availability", async () => {
      await database.query(`
        INSERT INTO friendly_availabilities(
          team_id, modality, category, declared_level, starts_at, ends_at,
          city_ibge_code, city_name, state_code, travel_radius_km,
          venue_preference, schedule_hash
        ) VALUES ($1,'society','Livre','intermediario','2026-08-27T18:00:00Z',
          '2026-08-27T20:00:00Z','4209102','Joinville','SC',25,'either',$2)
      `, [alpha.id, "c".repeat(64)]);
      const exited = await radar.exitRadar(mutation(alpha.identity, { confirmacao: "SAIR_DO_RADAR" }, "exit-key-1"));
      assert.equal(exited.profile_hidden, true);
      const profile = (await database.query(`
        SELECT public_slug, public_name, public_profile_enabled, instagram_handle,
          city_name, availability_active, radar_departed_at
        FROM radar_team_profiles WHERE id=$1
      `, [alpha.id])).rows[0];
      assert.equal(profile.public_slug, null);
      assert.equal(profile.public_name, "Time removido");
      assert.equal(profile.public_profile_enabled, false);
      assert.equal(profile.instagram_handle, null);
      assert.equal(profile.city_name, null);
      assert.equal(profile.availability_active, false);
      assert.ok(profile.radar_departed_at);
      assert.equal((await database.query("SELECT status FROM friendly_availabilities WHERE team_id=$1", [alpha.id])).rows[0].status, "cancelled");
      assert.equal((await database.query("SELECT count(*)::int AS total FROM radar_departure_records WHERE team_id=$1", [alpha.id])).rows[0].total, 1);
      await assert.rejects(radar.listBlocks({ identity: alpha.identity }), error => error.code === "RADAR_PROFILE_DEPARTED");
    });
  } finally {
    await database.close();
    currentTime = START;
  }
});
