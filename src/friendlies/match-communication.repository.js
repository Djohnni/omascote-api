"use strict";

const { RadarIdentityError } = require("./radar-identity.errors");
const { rowToTeam } = require("./radar-identity.repository");
const { assertRadarTeamOwnedByIdentity } = require("./radar-identity.policy");
const { decryptWhatsapp } = require("./radar-whatsapp.crypto");
const {
  accountPseudonym,
  scopeHash,
  encodeCursor
} = require("./match-communication.crypto");

function communicationError(code, status, message) {
  return new RadarIdentityError(code, status, message);
}

function normalizeDatabaseError(error) {
  if (error instanceof RadarIdentityError) return error;
  const constraint = String(error?.constraint || error?.message || "");
  if (error?.code === "23505" && constraint.includes("radar_moderation_open_message_report_idx")) {
    return communicationError("MATCH_MESSAGE_ALREADY_REPORTED", 409, "Mensagem ja denunciada.");
  }
  return error;
}

function messageSnapshot(row, viewerTeamId) {
  return Object.freeze({
    message_id: row.public_id,
    mine: row.sender_team_id === viewerTeamId,
    sender: Object.freeze({
      public_id: row.sender_public_id,
      name: row.sender_public_name || "Time"
    }),
    texto: row.body || null,
    removed: row.body === null,
    created_at: row.created_at
  });
}

async function loadOwnedTeam(client, identity) {
  const found = await client.query(
    "SELECT * FROM radar_team_profiles WHERE legacy_profile_id = $1",
    [identity.profileId]
  );
  if (found.rowCount !== 1) {
    throw communicationError("RADAR_PROFILE_NOT_FOUND", 409, "Perfil do Radar indisponivel.");
  }
  const team = rowToTeam(found.rows[0]);
  assertRadarTeamOwnedByIdentity(team, identity);
  return team;
}

const CONTEXT_SELECT = `
  SELECT conversation.id AS conversation_id,
    conversation.public_id AS conversation_public_id,
    match.id AS match_id, match.public_id AS match_public_id,
    match.team_a_id, match.team_b_id, match.scheduled_at,
    invitation.state AS invitation_state,
    opponent.public_id AS opponent_public_id,
    opponent.public_name AS opponent_public_name,
    opponent.public_slug AS opponent_public_slug,
    opponent.status AS opponent_status,
    opponent.suspended_at AS opponent_suspended_at,
    opponent.radar_departed_at AS opponent_departed_at,
    opponent.instagram_handle,
    opponent.instagram_verification_status,
    opponent.whatsapp_ciphertext,
    opponent.whatsapp_key_version,
    opponent.whatsapp_visible,
    EXISTS (
      SELECT 1 FROM team_blocks block
      WHERE (block.blocker_team_id = match.team_a_id AND block.blocked_team_id = match.team_b_id)
         OR (block.blocker_team_id = match.team_b_id AND block.blocked_team_id = match.team_a_id)
    ) AS blocked
  FROM radar_match_conversations conversation
  JOIN friendly_matches match ON match.id = conversation.match_id
  JOIN friendly_invitations invitation ON invitation.id = match.invitation_id
  JOIN radar_team_profiles opponent ON opponent.id = CASE
    WHEN match.team_a_id = $2 THEN match.team_b_id ELSE match.team_a_id
  END
  WHERE match.public_id = $1
    AND (match.team_a_id = $2 OR match.team_b_id = $2)
`;

async function loadContext(client, publicId, team, { lock = false } = {}) {
  const found = await client.query(`${CONTEXT_SELECT}${lock ? " FOR SHARE OF match, conversation" : ""}`, [publicId, team.id]);
  if (found.rowCount !== 1 || found.rows[0].invitation_state !== "accepted") {
    throw communicationError("MATCH_NOT_FOUND", 404, "Partida nao encontrada.");
  }
  return found.rows[0];
}

function canSend(team, context) {
  return team.status === "active" && !team.suspendedAt && !team.departedAt &&
    context.opponent_status === "active" && !context.opponent_suspended_at &&
    !context.opponent_departed_at && context.blocked !== true;
}

async function unreadCount(client, context, teamId) {
  const result = await client.query(`
    SELECT count(*)::integer AS total
    FROM radar_match_messages message
    LEFT JOIN radar_match_message_reads marker
      ON marker.conversation_id = message.conversation_id
      AND marker.reader_team_id = $2
    LEFT JOIN radar_match_messages last_message
      ON last_message.id = marker.last_read_message_id
    WHERE message.conversation_id = $1
      AND message.sender_team_id <> $2
      AND (
        last_message.id IS NULL
        OR (message.created_at, message.sequence) > (last_message.created_at, last_message.sequence)
      )
  `, [context.conversation_id, teamId]);
  return Number(result.rows[0]?.total || 0);
}

async function consumeLimits(client, { config, identity, teamId, ip, operation, now }) {
  const windowMs = Number(config.matchCommunicationRateWindowSeconds || 60) * 1000;
  const windowStartedAt = new Date(Math.floor(now.getTime() / windowMs) * windowMs);
  const limits = [
    ["account", accountPseudonym(config, identity.accountId), config.matchCommunicationAccountLimit],
    ["team", scopeHash(config, "team", teamId), config.matchCommunicationTeamLimit],
    ["ip", scopeHash(config, "ip", ip || "unknown"), config.matchCommunicationIpLimit]
  ];
  for (const [scopeType, hash, limit] of limits) {
    const consumed = await client.query(`
      INSERT INTO radar_match_communication_rate_limits(
        scope_type, scope_hash, operation, window_started_at, request_count, updated_at
      ) VALUES ($1, $2, $3, $4, 1, $5)
      ON CONFLICT (scope_type, scope_hash, operation, window_started_at)
      DO UPDATE SET request_count = radar_match_communication_rate_limits.request_count + 1,
        updated_at = EXCLUDED.updated_at
      WHERE radar_match_communication_rate_limits.request_count < $6
      RETURNING request_count
    `, [scopeType, hash, operation, windowStartedAt, now, Number(limit)]);
    if (consumed.rowCount !== 1) {
      throw communicationError("MATCH_COMMUNICATION_RATE_LIMITED", 429, "Aguarde um pouco e tente novamente.");
    }
  }
}

async function audit(client, { context, team, identity, config, eventType, payload, requestId, now }) {
  await client.query(`
    INSERT INTO match_audit_events(
      match_id, actor_team_id, actor_reference, event_type, payload, request_id, created_at
    ) VALUES ($1, $2, $3, $4, $5::jsonb, $6, $7)
  `, [
    context.match_id, team.id,
    `communication:${accountPseudonym(config, identity.accountId)}`,
    eventType, JSON.stringify(payload), requestId || null, now
  ]);
}

async function replay(client, values) {
  const pseudonym = accountPseudonym(values.config, values.identity.accountId);
  const result = await client.query(`
    SELECT payload_hash, radar_team_id, result_snapshot
    FROM radar_match_communication_mutations
    WHERE account_pseudonym = $1 AND operation = $2 AND idempotency_key = $3
  `, [pseudonym, values.operation, values.idempotencyKey]);
  if (!result.rowCount) return null;
  const row = result.rows[0];
  if (row.payload_hash !== values.payloadHash || row.radar_team_id !== values.team.id) {
    throw communicationError("IDEMPOTENCY_KEY_REUSED", 409, "Idempotency-Key ja utilizada com outros dados.");
  }
  return Object.freeze({ ...row.result_snapshot, replayed: true });
}

async function saveMutation(client, values, result, messageId = null) {
  await client.query(`
    INSERT INTO radar_match_communication_mutations(
      account_pseudonym, operation, idempotency_key, payload_hash,
      radar_team_id, conversation_id, message_id, result_snapshot, created_at
    ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8::jsonb,$9)
  `, [
    accountPseudonym(values.config, values.identity.accountId), values.operation,
    values.idempotencyKey, values.payloadHash, values.team.id,
    values.context.conversation_id, messageId, JSON.stringify(result), values.now
  ]);
}

function createMatchCommunicationRepository({ pool, config }) {
  if (!pool || typeof pool.connect !== "function") throw new TypeError("Match communication repository requires PostgreSQL");

  async function transaction(work) {
    const client = await pool.connect();
    let open = false;
    try {
      await client.query("BEGIN"); open = true;
      const result = await work(client);
      await client.query("COMMIT"); open = false;
      return result;
    } catch (error) {
      if (open) { try { await client.query("ROLLBACK"); } catch {} }
      throw normalizeDatabaseError(error);
    } finally { client.release(); }
  }

  async function getChannels({ identity, publicId, ip, now }) {
    return transaction(async client => {
      const team = await loadOwnedTeam(client, identity);
      const context = await loadContext(client, publicId, team);
      await consumeLimits(client, { config, identity, teamId: team.id, ip, operation: "channels", now });
      const open = canSend(team, context);
      let whatsapp = null;
      if (open && config.whatsappConfigured && context.whatsapp_visible === true && context.whatsapp_ciphertext) {
        const number = decryptWhatsapp(context.whatsapp_ciphertext, context.whatsapp_key_version, config).replace(/\D/g, "");
        const message = `Ola! Somos do ${team.publicName || "nosso time"}. Vamos combinar o amistoso pelo Meu Clube FC?`;
        whatsapp = Object.freeze({
          available: true,
          url: `https://wa.me/${number}?text=${encodeURIComponent(message)}`
        });
      }
      const handle = String(context.instagram_handle || "").replace(/^@/, "");
      const instagram = open && /^[a-z0-9._]{1,30}$/i.test(handle)
        ? Object.freeze({
            available: true,
            handle,
            verified: context.instagram_verification_status === "verified",
            url: `https://www.instagram.com/${encodeURIComponent(handle)}/`
          })
        : Object.freeze({ available: false, handle: null, verified: false, url: null });
      return Object.freeze({
        match_id: context.match_public_id,
        opponent: Object.freeze({ public_id: context.opponent_public_id, name: context.opponent_public_name || "Time" }),
        can_send: open,
        blocked: context.blocked === true,
        channels: Object.freeze({
          whatsapp: whatsapp || Object.freeze({ available: false, url: null }),
          instagram,
          internal: Object.freeze({ available: true, unread: await unreadCount(client, context, team.id) })
        })
      });
    });
  }

  async function listMessages({ identity, publicId, cursor, limit, ip, now }) {
    return transaction(async client => {
      const team = await loadOwnedTeam(client, identity);
      const context = await loadContext(client, publicId, team);
      await consumeLimits(client, { config, identity, teamId: team.id, ip, operation: "list", now });
      const result = await client.query(`
        SELECT message.*, sender.public_id AS sender_public_id,
          sender.public_name AS sender_public_name
        FROM radar_match_messages message
        JOIN radar_team_profiles sender ON sender.id = message.sender_team_id
        WHERE message.conversation_id = $1
          AND ($2::timestamptz IS NULL OR (message.created_at, message.sequence) < ($2::timestamptz, $3::bigint))
        ORDER BY message.created_at DESC, message.sequence DESC
        LIMIT $4
      `, [context.conversation_id, cursor?.createdAt || null, cursor?.sequence || null, limit + 1]);
      const hasMore = result.rows.length > limit;
      const selected = result.rows.slice(0, limit);
      const oldest = selected.at(-1);
      return Object.freeze({
        items: Object.freeze(selected.reverse().map(row => messageSnapshot(row, team.id))),
        page: Object.freeze({
          has_more: hasMore,
          next_cursor: hasMore && oldest ? encodeCursor(config, {
            created_at: new Date(oldest.created_at).toISOString(),
            sequence: Number(oldest.sequence)
          }) : null
        }),
        unread: await unreadCount(client, context, team.id),
        can_send: canSend(team, context)
      });
    });
  }

  async function mutationSetup(client, values, operation) {
    const team = await loadOwnedTeam(client, values.identity);
    const context = await loadContext(client, values.publicId, team, { lock: true });
    const expanded = { ...values, team, context, operation, config };
    await client.query("SELECT pg_advisory_xact_lock(hashtext($1))", [
      `${accountPseudonym(config, values.identity.accountId)}:${operation}:${values.idempotencyKey}`
    ]);
    const repeated = await replay(client, expanded);
    if (repeated) return { repeated };
    await consumeLimits(client, {
      config, identity: values.identity, teamId: team.id, ip: values.ip,
      operation: operation === "send_message" ? "send" : operation === "mark_read" ? "read" : "report",
      now: values.now
    });
    return { values: expanded };
  }

  async function sendMessage(values) {
    return transaction(async client => {
      const setup = await mutationSetup(client, values, "send_message");
      if (setup.repeated) return setup.repeated;
      const current = setup.values;
      if (!canSend(current.team, current.context)) {
        throw communicationError("MATCH_MESSAGE_SEND_FORBIDDEN", 403, "Envio indisponivel.");
      }
      const retention = new Date(current.now.getTime() + Number(config.matchCommunicationRetentionDays) * 86_400_000);
      const inserted = await client.query(`
        INSERT INTO radar_match_messages(
          conversation_id, sender_team_id, body, retention_expires_at, created_at
        ) VALUES ($1,$2,$3,$4,$5)
        RETURNING *
      `, [current.context.conversation_id, current.team.id, current.value.text, retention, current.now]);
      const row = {
        ...inserted.rows[0], sender_public_id: current.team.publicId,
        sender_public_name: current.team.publicName
      };
      const opponentId = current.context.team_a_id === current.team.id
        ? current.context.team_b_id : current.context.team_a_id;
      await client.query(`
        INSERT INTO notifications(
          recipient_team_id, event_type, entity_type, entity_public_id,
          payload, deduplication_key, created_at
        ) VALUES ($1, 'match_message_received', 'friendly_match', $2,
          $3::jsonb, $4, $5)
        ON CONFLICT (recipient_team_id, deduplication_key) DO NOTHING
      `, [
        opponentId, current.context.match_public_id,
        JSON.stringify({
          match_id: current.context.match_public_id,
          message_id: row.public_id,
          opponent_name: current.team.publicName || "Time"
        }), `match_message_received:${row.public_id}`, current.now
      ]);
      await audit(client, {
        ...current, eventType: "match_communication.message_sent",
        payload: { message_id: row.public_id, conversation_id: current.context.conversation_public_id },
        requestId: current.requestId
      });
      const result = Object.freeze({ message: messageSnapshot(row, current.team.id), replayed: false });
      await saveMutation(client, current, result, row.id);
      return result;
    });
  }

  async function markRead(values) {
    return transaction(async client => {
      const setup = await mutationSetup(client, values, "mark_read");
      if (setup.repeated) return setup.repeated;
      const current = setup.values;
      const found = await client.query(`
        SELECT * FROM radar_match_messages
        WHERE conversation_id = $1 AND public_id = $2
      `, [current.context.conversation_id, current.value.messagePublicId]);
      if (found.rowCount !== 1) throw communicationError("MATCH_MESSAGE_NOT_FOUND", 404, "Mensagem nao encontrada.");
      const target = found.rows[0];
      await client.query(`
        INSERT INTO radar_match_message_reads(
          conversation_id, reader_team_id, last_read_message_id, last_read_at
        ) VALUES ($1,$2,$3,$4)
        ON CONFLICT (conversation_id, reader_team_id) DO UPDATE SET
          last_read_message_id = EXCLUDED.last_read_message_id,
          last_read_at = EXCLUDED.last_read_at,
          version = radar_match_message_reads.version + 1
        WHERE (
          SELECT (current_message.created_at, current_message.sequence)
            < (target_message.created_at, target_message.sequence)
          FROM radar_match_messages current_message, radar_match_messages target_message
          WHERE current_message.id = radar_match_message_reads.last_read_message_id
            AND target_message.id = EXCLUDED.last_read_message_id
        ) IS TRUE
      `, [current.context.conversation_id, current.team.id, target.id, current.now]);
      await audit(client, {
        ...current, eventType: "match_communication.messages_read",
        payload: { last_message_id: target.public_id, conversation_id: current.context.conversation_public_id },
        requestId: current.requestId
      });
      const result = Object.freeze({ read: true, unread: await unreadCount(client, current.context, current.team.id), replayed: false });
      await saveMutation(client, current, result, target.id);
      return result;
    });
  }

  async function reportMessage(values) {
    return transaction(async client => {
      const setup = await mutationSetup(client, values, "report_message");
      if (setup.repeated) return setup.repeated;
      const current = setup.values;
      const found = await client.query(`
        SELECT * FROM radar_match_messages
        WHERE conversation_id = $1 AND public_id = $2
      `, [current.context.conversation_id, current.messagePublicId]);
      if (found.rowCount !== 1 || found.rows[0].sender_team_id === current.team.id) {
        throw communicationError("MATCH_MESSAGE_NOT_FOUND", 404, "Mensagem nao encontrada.");
      }
      const message = found.rows[0];
      const reportedTeamId = message.sender_team_id;
      const retention = new Date(current.now.getTime() + Number(config.moderationRetentionDays || 365) * 86_400_000);
      const due = config.moderationSlaHours
        ? new Date(current.now.getTime() + Number(config.moderationSlaHours) * 3_600_000)
        : null;
      const inserted = await client.query(`
        INSERT INTO radar_moderation_cases(
          case_type, reporter_team_id, reported_team_id, match_id, message_id,
          category, moderation_due_at, retention_expires_at, created_at, updated_at
        ) VALUES ('message_report',$1,$2,$3,$4,$5,$6,$7,$8,$8)
        RETURNING *
      `, [current.team.id, reportedTeamId, current.context.match_id, message.id, current.value.category, due, retention, current.now]);
      const caseRow = inserted.rows[0];
      await client.query(`
        INSERT INTO radar_moderation_case_events(
          case_id, actor_team_id, actor_account_reference, event_type,
          case_version, safe_payload, request_id, created_at
        ) VALUES ($1,$2,$3,'created',1,$4::jsonb,$5,$6)
      `, [
        caseRow.id, current.team.id,
        `communication:${accountPseudonym(config, current.identity.accountId)}`,
        JSON.stringify({ case_type: "message_report", category: current.value.category, message_id: message.public_id }),
        current.requestId || null, current.now
      ]);
      await audit(client, {
        ...current, eventType: "match_communication.message_reported",
        payload: { case_id: caseRow.public_id, message_id: message.public_id, category: current.value.category },
        requestId: current.requestId
      });
      const result = Object.freeze({
        case: Object.freeze({ case_id: caseRow.public_id, status: caseRow.status, category: caseRow.category, version: 1 }),
        replayed: false
      });
      await saveMutation(client, current, result, message.id);
      return result;
    });
  }

  return Object.freeze({ getChannels, listMessages, sendMessage, markRead, reportMessage });
}

module.exports = {
  createMatchCommunicationRepository,
  normalizeDatabaseError,
  messageSnapshot,
  canSend
};
