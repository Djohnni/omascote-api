"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { PGlite } = require("@electric-sql/pglite");
const { migrate } = require("./src/db/migrate");
const { createRadarConfig } = require("./src/config/radar");
const { encryptWhatsapp } = require("./src/friendlies/radar-whatsapp.crypto");
const { createInvitationRepository } = require("./src/friendlies/invitation.repository");
const { createInvitationService } = require("./src/friendlies/invitation.service");
const { createMatchCommunicationRepository } = require("./src/friendlies/match-communication.repository");
const { createMatchCommunicationService } = require("./src/friendlies/match-communication.service");
const { runRadarRetention } = require("./src/maintenance/radar-retention");
const { createRadarModerationRepository } = require("./src/friendlies/radar-moderation.repository");

const INVITE_NOW = new Date("2026-08-01T12:00:00.000Z");
const CHAT_NOW = new Date("2026-08-24T12:00:00.000Z");
const KEY = Buffer.alloc(32, 7).toString("base64");

function normalizeResult(result) {
  const last = Array.isArray(result) ? result.at(-1) : result;
  if (!last) return { rows: [], rowCount: 0 };
  return { ...last, rowCount: last.rows?.length || last.affectedRows || 0 };
}

function pool(database) {
  function client() {
    return {
      async query(sql, params) { return params ? normalizeResult(await database.query(sql, params)) : normalizeResult(await database.exec(sql)); },
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
    RADAR_MODERATION_ENABLED: "true",
    RADAR_MATCH_COMMUNICATION_ENABLED: "true",
    RADAR_INVITATIONS_SECURITY_SECRET: "invitation-secret-that-is-at-least-32-bytes",
    RADAR_MODERATION_SECURITY_SECRET: "moderation-secret-that-is-at-least-32-bytes",
    RADAR_MATCH_COMMUNICATION_SECURITY_SECRET: "communication-secret-that-is-at-least-32-bytes",
    RADAR_WHATSAPP_ENCRYPTION_KEYS: `v1:${KEY}`,
    RADAR_WHATSAPP_ACTIVE_KEY_VERSION: "v1",
    RADAR_WHATSAPP_RATE_LIMIT_SECRET: "whatsapp-rate-secret-that-is-at-least-32-bytes",
    RADAR_INVITATION_ACCOUNT_LIMIT: "500",
    RADAR_INVITATION_TEAM_LIMIT: "500",
    RADAR_INVITATION_IP_LIMIT: "1000",
    RADAR_MATCH_COMMUNICATION_ACCOUNT_LIMIT: "1000",
    RADAR_MATCH_COMMUNICATION_TEAM_LIMIT: "1000",
    RADAR_MATCH_COMMUNICATION_IP_LIMIT: "2000",
    ...overrides
  });
}

async function insertTeam(database, name, currentConfig = config(), overrides = {}) {
  const owner = identity(name);
  const encrypted = encryptWhatsapp(overrides.whatsapp || "+5547999999999", currentConfig);
  const result = await database.query(`
    INSERT INTO radar_team_profiles(
      legacy_profile_id, account_reference, public_slug, status,
      instagram_handle, instagram_verification_status,
      city_ibge_code, city_name, state_code, modalities, categories,
      declared_level, travel_radius_km, venue_preference, availability_active,
      radar_terms_accepted_at, public_name, public_profile_enabled,
      public_crest_available, suspended_at, whatsapp_ciphertext,
      whatsapp_key_version, whatsapp_visible
    ) VALUES (
      $1,$2,$3,$4,$5,$6,'4209102','Joinville','SC',
      ARRAY['society'],ARRAY['Livre'],'intermediario',25,'either',true,
      '2026-07-20T12:00:00Z',$7,true,true,$8,$9,$10,$11
    ) RETURNING id, public_id, public_slug
  `, [
    owner.profileId, owner.accountId, `${name}-fc`, overrides.status || "active",
    `${name.replace(/-/g, ".")}.fc`, overrides.verified === false ? "unverified" : "verified", `${name} FC`,
    overrides.status === "suspended" ? CHAT_NOW : null,
    encrypted.ciphertext, encrypted.keyVersion, overrides.whatsappVisible !== false
  ]);
  return { ...result.rows[0], identity: owner };
}

function invitations(database, currentConfig) {
  return createInvitationService({
    repository: createInvitationRepository({ pool: pool(database), config: currentConfig }),
    config: currentConfig, clock: () => INVITE_NOW
  });
}

function communication(database, currentConfig = config(), clock = () => CHAT_NOW) {
  return createMatchCommunicationService({
    repository: createMatchCommunicationRepository({ pool: pool(database), config: currentConfig }),
    config: currentConfig, clock
  });
}

async function acceptedMatch(database, first, second, currentConfig, suffix) {
  const service = invitations(database, currentConfig);
  const created = await service.create({
    identity: first.identity,
    body: {
      opponent_slug: second.public_slug,
      starts_at: "2026-09-10T19:00:00-03:00",
      ends_at: "2026-09-10T21:00:00-03:00",
      modality: "society", category: "Livre", venue_preference: "home",
      message: "Convite pelo Radar."
    },
    idempotencyKey: `create-chat-${suffix}-0001`, ip: "203.0.113.10"
  });
  const accepted = await service.accept({
    identity: second.identity, publicId: created.invitation.invitation_id,
    body: {}, expectedVersion: "1", idempotencyKey: `accept-chat-${suffix}-0001`, ip: "203.0.113.11"
  });
  return accepted.match.match_id;
}

function base(team, matchId, key) {
  return { identity: team.identity, publicId: matchId, ip: "203.0.113.20", idempotencyKey: key, requestId: "chat-test-request" };
}

test("migration 016 backfills accepted matches, runs once and remains idempotent", async () => {
  const database = new PGlite();
  const partial = fs.mkdtempSync(path.join(os.tmpdir(), "radar-communication-migrations-"));
  try {
    const adapter = pool(database);
    const directory = path.join(__dirname, "src", "db", "migrations");
    for (const name of fs.readdirSync(directory).filter(name => /^0(?:0[1-9]|1[0-5])_.*\.sql$/.test(name))) {
      fs.copyFileSync(path.join(directory, name), path.join(partial, name));
    }
    assert.equal((await migrate({ pool: adapter, directory: partial })).at(-1), "015_radar_automatic_participation.sql");
    const current = config();
    const alpha = await insertTeam(database, "backfill-alpha", current);
    const beta = await insertTeam(database, "backfill-beta", current);
    const matchId = await acceptedMatch(database, alpha, beta, current, "backfill");
    assert.deepEqual(await migrate({ pool: adapter }), ["016_match_communication.sql"]);
    assert.deepEqual(await migrate({ pool: adapter }), []);
    const conversation = await database.query(`
      SELECT conversation.id FROM radar_match_conversations conversation
      JOIN friendly_matches match ON match.id=conversation.match_id
      WHERE match.public_id=$1
    `, [matchId]);
    assert.equal(conversation.rows.length, 1);
    const tables = await database.query(`SELECT table_name FROM information_schema.tables WHERE table_name LIKE 'radar_match_comm%' ORDER BY table_name`);
    assert.equal(tables.rows.length, 2);
  } finally {
    fs.rmSync(partial, { recursive: true, force: true });
    await database.close();
  }
});

test("participants receive safe channels while an outsider gets a private 404", async () => {
  const database = new PGlite();
  try {
    const current = config(); await migrate({ pool: pool(database) });
    const alpha = await insertTeam(database, "channel-alpha", current, { verified: false });
    const beta = await insertTeam(database, "channel-beta", current);
    const outsider = await insertTeam(database, "channel-outsider", current);
    const matchId = await acceptedMatch(database, alpha, beta, current, "channels");
    const service = communication(database, current);
    const channels = await service.getChannels(base(alpha, matchId));
    assert.deepEqual(Object.keys(channels.channels), ["whatsapp", "instagram", "internal"]);
    assert.match(channels.channels.whatsapp.url, /^https:\/\/wa\.me\/\d+\?text=/);
    assert.equal(
      new URL(channels.channels.whatsapp.url).searchParams.get("text"),
      "Olá! Nosso amistoso foi confirmado pelo Meu Clube FC. Vamos combinar os detalhes?"
    );
    assert.equal(channels.channels.instagram.verified, true);
    assert.equal(channels.channels.internal.available, true);
    assert.equal(JSON.stringify(channels).includes("+5547"), false);
    const reverse = await service.getChannels(base(beta, matchId));
    assert.equal(reverse.channels.instagram.available, true);
    assert.equal(reverse.channels.instagram.verified, false);
    await assert.rejects(service.getChannels(base(outsider, matchId)), error => error.code === "MATCH_NOT_FOUND" && error.status === 404);
  } finally { await database.close(); }
});

test("two-way chat, unread state, reads and idempotent replay work without content in audit or notifications", async () => {
  const database = new PGlite();
  try {
    const current = config(); await migrate({ pool: pool(database) });
    const alpha = await insertTeam(database, "message-alpha", current);
    const beta = await insertTeam(database, "message-beta", current);
    const matchId = await acceptedMatch(database, alpha, beta, current, "messages");
    const service = communication(database, current);
    const sent = await service.sendMessage({ ...base(alpha, matchId, "send-alpha-0001"), body: { texto: "Vamos às 19h?" } });
    const replay = await service.sendMessage({ ...base(alpha, matchId, "send-alpha-0001"), body: { texto: "Vamos às 19h?" } });
    assert.equal(replay.replayed, true);
    assert.equal(replay.message.message_id, sent.message.message_id);
    const inbox = await service.listMessages({ identity: beta.identity, publicId: matchId, query: {}, ip: "203.0.113.21" });
    assert.equal(inbox.unread, 1);
    const read = await service.markRead({ ...base(beta, matchId, "read-beta-0001"), body: { ultima_mensagem_id: sent.message.message_id } });
    assert.equal(read.unread, 0);
    await service.sendMessage({ ...base(beta, matchId, "send-beta-0001"), body: { texto: "Sim, combinado." } });
    const ordered = await service.listMessages({ identity: alpha.identity, publicId: matchId, query: {}, ip: "203.0.113.22" });
    assert.deepEqual(ordered.items.map(item => item.texto), ["Vamos às 19h?", "Sim, combinado."]);
    const pageOne = await service.listMessages({ identity: alpha.identity, publicId: matchId, query: { limit: "1" }, ip: "203.0.113.22" });
    const pageTwo = await service.listMessages({ identity: alpha.identity, publicId: matchId, query: { limit: "1", cursor: pageOne.page.next_cursor }, ip: "203.0.113.22" });
    assert.equal(pageOne.page.has_more, true);
    assert.notEqual(pageOne.items[0].message_id, pageTwo.items[0].message_id);
    const audit = await database.query("SELECT payload::text AS payload FROM match_audit_events WHERE event_type LIKE 'match_communication.%'");
    const notifications = await database.query("SELECT payload::text AS payload FROM notifications WHERE event_type = 'match_message_received'");
    assert.equal(JSON.stringify(audit.rows).includes("Vamos às 19h"), false);
    assert.equal(JSON.stringify(notifications.rows).includes("Vamos às 19h"), false);
    assert.equal((await database.query("SELECT count(*)::integer AS total FROM radar_match_messages")).rows[0].total, 2);
  } finally { await database.close(); }
});

test("blocking and suspension stop new messages but preserve participant history", async () => {
  const database = new PGlite();
  try {
    const current = config(); await migrate({ pool: pool(database) });
    const alpha = await insertTeam(database, "block-alpha", current);
    const beta = await insertTeam(database, "block-beta", current);
    const matchId = await acceptedMatch(database, alpha, beta, current, "blocked");
    const service = communication(database, current);
    await service.sendMessage({ ...base(alpha, matchId, "block-send-0001"), body: { texto: "Mensagem preservada" } });
    await database.query("INSERT INTO team_blocks(blocker_team_id, blocked_team_id, private_reason) VALUES ($1,$2,'safety')", [alpha.id, beta.id]);
    const channels = await service.getChannels(base(beta, matchId));
    assert.equal(channels.can_send, false);
    assert.equal(channels.channels.whatsapp.available, false);
    assert.equal(channels.channels.instagram.available, false);
    assert.equal((await service.listMessages({ identity: beta.identity, publicId: matchId, query: {}, ip: "203.0.113.24" })).items.length, 1);
    await assert.rejects(service.sendMessage({ ...base(beta, matchId, "block-send-0002"), body: { texto: "Não envia" } }), error => error.code === "MATCH_MESSAGE_SEND_FORBIDDEN");
    await database.query("DELETE FROM team_blocks WHERE blocker_team_id = $1 AND blocked_team_id = $2", [alpha.id, beta.id]);
    await database.query("UPDATE radar_team_profiles SET status='suspended', suspended_at=$2 WHERE id=$1", [beta.id, CHAT_NOW]);
    assert.equal((await service.listMessages({ identity: beta.identity, publicId: matchId, query: {}, ip: "203.0.113.24" })).items.length, 1);
    await assert.rejects(service.sendMessage({ ...base(beta, matchId, "suspended-send-0001"), body: { texto: "Não envia" } }), error => error.code === "MATCH_MESSAGE_SEND_FORBIDDEN");
  } finally { await database.close(); }
});

test("message reports stay anonymous to the opponent and enter moderation", async () => {
  const database = new PGlite();
  try {
    const current = config(); await migrate({ pool: pool(database) });
    const alpha = await insertTeam(database, "report-alpha", current);
    const beta = await insertTeam(database, "report-beta", current);
    const moderator = await insertTeam(database, "report-moderator", current);
    await database.query("INSERT INTO radar_account_roles(account_reference, role, granted_by_account_reference) VALUES ($1,'radar_moderator',$1)", [moderator.identity.accountId]);
    const matchId = await acceptedMatch(database, alpha, beta, current, "report");
    const service = communication(database, current);
    const sent = await service.sendMessage({ ...base(beta, matchId, "report-send-0001"), body: { texto: "Conteúdo denunciado" } });
    const report = await service.reportMessage({ ...base(alpha, matchId, "report-message-0001"), messagePublicId: sent.message.message_id, body: { categoria: "harassment" } });
    assert.equal(report.case.status, "open");
    const row = await database.query("SELECT case_type, reporter_team_id, reported_team_id FROM radar_moderation_cases WHERE public_id=$1", [report.case.case_id]);
    assert.equal(row.rows[0].case_type, "message_report");
    assert.equal(row.rows[0].reporter_team_id, alpha.id);
    assert.equal(row.rows[0].reported_team_id, beta.id);
    const queue = await createRadarModerationRepository({ pool: pool(database), config: current }).adminQueue({
      identity: moderator.identity, limit: 20, now: CHAT_NOW
    });
    const messageCase = queue.items.find(item => item.case_id === report.case.case_id);
    assert.equal(messageCase.reported_message.texto, "Conteúdo denunciado");
    const opponentNotifications = await database.query("SELECT payload::text AS payload FROM notifications WHERE recipient_team_id=$1", [beta.id]);
    assert.equal(JSON.stringify(opponentNotifications.rows).includes(report.case.case_id), false);
  } finally { await database.close(); }
});

test("persistent rate limits and database uniqueness protect repeated and concurrent mutations", async () => {
  const database = new PGlite();
  try {
    const current = config({
      RADAR_MATCH_COMMUNICATION_ACCOUNT_LIMIT: "1",
      RADAR_MATCH_COMMUNICATION_TEAM_LIMIT: "1",
      RADAR_MATCH_COMMUNICATION_IP_LIMIT: "1"
    });
    await migrate({ pool: pool(database) });
    const alpha = await insertTeam(database, "limit-alpha", current);
    const beta = await insertTeam(database, "limit-beta", current);
    const matchId = await acceptedMatch(database, alpha, beta, current, "limits");
    const service = communication(database, current);
    await service.listMessages({ identity: alpha.identity, publicId: matchId, query: {}, ip: "203.0.113.40" });
    await assert.rejects(
      service.listMessages({ identity: alpha.identity, publicId: matchId, query: {}, ip: "203.0.113.40" }),
      error => error.code === "MATCH_COMMUNICATION_RATE_LIMITED"
    );
    const context = (await database.query(`
      SELECT conversation.id AS conversation_id, team.id AS team_id
      FROM radar_match_conversations conversation
      JOIN friendly_matches match ON match.id=conversation.match_id
      JOIN radar_team_profiles team ON team.id=match.team_a_id
      WHERE match.public_id=$1
    `, [matchId])).rows[0];
    const insert = suffix => database.query(`
      INSERT INTO radar_match_communication_mutations(
        account_pseudonym, operation, idempotency_key, payload_hash,
        radar_team_id, conversation_id, result_snapshot
      ) VALUES ($1,'send_message','concurrent-key',$2,$3,$4,'{}'::jsonb)
    `, ["a".repeat(64), suffix.repeat(64).slice(0, 64), context.team_id, context.conversation_id]);
    const attempts = await Promise.allSettled([insert("b"), insert("c")]);
    assert.equal(attempts.filter(item => item.status === "fulfilled").length, 1);
    assert.equal(attempts.filter(item => item.status === "rejected").length, 1);
  } finally { await database.close(); }
});

test("retention erases expired unreported content and never deletes audit", async () => {
  const database = new PGlite();
  try {
    const current = config({ RADAR_MATCH_COMMUNICATION_RETENTION_DAYS: "1" }); await migrate({ pool: pool(database) });
    const alpha = await insertTeam(database, "retention-alpha", current);
    const beta = await insertTeam(database, "retention-beta", current);
    const matchId = await acceptedMatch(database, alpha, beta, current, "retention");
    const service = communication(database, current);
    const sent = await service.sendMessage({ ...base(beta, matchId, "retention-send-0001"), body: { texto: "Apagar por retenção" } });
    const auditBefore = (await database.query("SELECT count(*)::integer AS total FROM match_audit_events")).rows[0].total;
    const result = await runRadarRetention({ pool: pool(database), config: current, now: new Date("2026-08-26T12:00:00Z"), logger: { info() {}, error() {} } });
    assert.equal(result.match_messages_erased, 1);
    const erased = await database.query("SELECT body, body_erased_at FROM radar_match_messages WHERE public_id=$1", [sent.message.message_id]);
    assert.equal(erased.rows[0].body, null);
    assert.equal((await database.query("SELECT count(*)::integer AS total FROM match_audit_events")).rows[0].total >= auditBefore, true);
  } finally { await database.close(); }
});
