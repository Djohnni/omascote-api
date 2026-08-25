"use strict";

const { RadarIdentityError } = require("./radar-identity.errors");
const { rowToTeam } = require("./radar-identity.repository");
const {
  assertRadarTeamOwnedByIdentity,
  assertRadarTeamCanMutate
} = require("./radar-identity.policy");
const { invitationRateHash } = require("./invitation.crypto");
const { invitationError, proposalHash } = require("./invitation.schemas");

const OPEN_STATES = new Set(["pending", "counter_proposed"]);
const TERMINAL_STATES = new Set(["accepted", "declined", "cancelled", "expired"]);

async function rollbackQuietly(client, open) {
  if (!open) return;
  try { await client.query("ROLLBACK"); } catch {}
}

function safeTeam(team) {
  return Object.freeze({
    slug: team.publicSlug,
    name: team.publicName,
    city: team.cityName,
    state: team.stateCode
  });
}

function rowTeam(value) {
  if (!value) return null;
  return Object.freeze({
    id: value.id,
    publicSlug: value.public_slug,
    publicName: value.public_name,
    cityName: value.city_name,
    stateCode: value.state_code
  });
}

function rowToInvitation(row, viewerTeamId) {
  if (!row) return null;
  const requester = rowTeam(row.requester);
  const invited = rowTeam(row.invited);
  const isRequester = requester?.id === viewerTeamId;
  const opponent = isRequester ? invited : requester;
  const currentProposerId = row.current_proposer_team_id;
  return Object.freeze({
    invitation_id: row.public_id,
    state: row.state,
    version: Number(row.version),
    direction: currentProposerId === viewerTeamId ? "outgoing" : "incoming",
    opponent: safeTeam(opponent),
    proposal: Object.freeze({ ...(row.proposal || {}) }),
    expires_at: row.expires_at,
    created_at: row.created_at,
    updated_at: row.updated_at
  });
}

function rowToNotification(row) {
  return Object.freeze({
    notification_id: row.public_id,
    type: row.event_type,
    entity_type: row.entity_type,
    entity_id: row.entity_public_id,
    payload: Object.freeze({ ...(row.payload || {}) }),
    read: Boolean(row.read_at),
    read_at: row.read_at,
    version: Number(row.version),
    created_at: row.created_at
  });
}

function eligible(team) {
  return Boolean(
    team && team.status === "active" && !team.suspendedAt && team.availabilityActive &&
    team.instagramVerificationStatus === "verified" && team.termsAcceptedAt &&
    team.publicProfileEnabled && team.publicCrestAvailable && team.publicName &&
    /^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(team.publicSlug || "") &&
    /^\d{7}$/.test(team.cityIbgeCode || "") && /^[A-Z]{2}$/.test(team.stateCode || "") &&
    team.cityName && team.modalities.length && team.categories.length
  );
}

function assertEligible(team, code = "INVITATION_TEAM_NOT_ELIGIBLE") {
  if (!eligible(team)) throw invitationError(code, 409, "Time indisponivel para convites.");
}

async function loadOwnedTeam(client, identity, { lock = false } = {}) {
  const result = await client.query(
    `SELECT * FROM radar_team_profiles WHERE legacy_profile_id = $1${lock ? " FOR UPDATE" : ""}`,
    [identity.profileId]
  );
  if (result.rowCount !== 1) throw invitationError("RADAR_PROFILE_NOT_FOUND", 409, "Perfil do Radar indisponivel.");
  const team = rowToTeam(result.rows[0]);
  assertRadarTeamOwnedByIdentity(team, identity);
  assertRadarTeamCanMutate(team);
  return team;
}

async function findOwnedTeam(client, identity) {
  const result = await client.query(
    "SELECT * FROM radar_team_profiles WHERE legacy_profile_id = $1",
    [identity.profileId]
  );
  if (result.rowCount === 0) return null;
  if (result.rowCount !== 1) {
    throw invitationError("RADAR_PROFILE_INVALID", 409, "Perfil do Radar indisponivel.");
  }
  const team = rowToTeam(result.rows[0]);
  assertRadarTeamOwnedByIdentity(team, identity);
  assertRadarTeamCanMutate(team);
  return team;
}

async function lockPair(client, firstId, secondId) {
  const result = await client.query(
    "SELECT * FROM radar_team_profiles WHERE id IN ($1, $2) ORDER BY id FOR UPDATE",
    [firstId, secondId]
  );
  return new Map(result.rows.map(row => [row.id, rowToTeam(row)]));
}

async function hasAvailability(client, teamId, now) {
  const result = await client.query(`
    SELECT EXISTS(
      SELECT 1 FROM friendly_availabilities
      WHERE team_id = $1 AND status = 'active' AND ends_at > $2
    ) AS available
  `, [teamId, now]);
  return result.rows[0]?.available === true;
}

async function assertPairAllowed(client, origin, opponent, now) {
  if (origin.id === opponent.id) throw invitationError("INVITATION_SELF_FORBIDDEN", 409, "Nao e possivel convidar o proprio time.");
  assertEligible(origin, "INVITATION_ORIGIN_NOT_ELIGIBLE");
  assertEligible(opponent, "INVITATION_OPPONENT_NOT_ELIGIBLE");
  const [originAvailable, opponentAvailable, block] = await Promise.all([
    hasAvailability(client, origin.id, now),
    hasAvailability(client, opponent.id, now),
    client.query(`
      SELECT 1 FROM team_blocks
      WHERE (blocker_team_id = $1 AND blocked_team_id = $2)
         OR (blocker_team_id = $2 AND blocked_team_id = $1)
      LIMIT 1
    `, [origin.id, opponent.id])
  ]);
  if (!originAvailable || !opponentAvailable) throw invitationError("INVITATION_TEAM_UNAVAILABLE", 409, "Um dos times nao esta disponivel.");
  if (block.rowCount) throw invitationError("INVITATION_BLOCKED", 404, "Time indisponivel para convite.");
}

function normalizedSet(values) {
  return new Set((values || []).map(value => String(value).toLocaleLowerCase("pt-BR")));
}

function canonicalProposal(value, proposer, opponent) {
  if (!normalizedSet(proposer.modalities).has(value.modality) || !normalizedSet(opponent.modalities).has(value.modality)) {
    throw invitationError("INVITATION_MODALITY_INCOMPATIBLE", 409, "Modalidade indisponivel para os times.");
  }
  const category = value.category.toLocaleLowerCase("pt-BR");
  if (!normalizedSet(proposer.categories).has(category) || !normalizedSet(opponent.categories).has(category)) {
    throw invitationError("INVITATION_CATEGORY_INCOMPATIBLE", 409, "Categoria indisponivel para os times.");
  }
  const host = value.venuePreference === "away" ? opponent : proposer;
  return Object.freeze({
    starts_at: value.startsAt,
    ends_at: value.endsAt,
    modality: value.modality,
    category: value.category,
    city: host.cityName,
    state: host.stateCode,
    venue_preference: value.venuePreference,
    message: value.message
  });
}

async function consumeLimits(client, { identity, teamId, ip, operation, now, config }) {
  const windowMs = config.invitationRateWindowSeconds * 1000;
  const windowStartedAt = new Date(Math.floor(now.getTime() / windowMs) * windowMs);
  const scopes = [
    ["account", invitationRateHash(config, "account", identity.accountId), config.invitationAccountLimit],
    ["team", invitationRateHash(config, "team", teamId), config.invitationTeamLimit],
    ["ip", invitationRateHash(config, "ip", ip), config.invitationIpLimit]
  ];
  for (const [type, hash, limit] of scopes) {
    const result = await client.query(`
      INSERT INTO radar_invitation_rate_limits(
        operation, scope_type, scope_hash, window_started_at, request_count, updated_at
      ) VALUES ($1, $2, $3, $4, 1, $5)
      ON CONFLICT (operation, scope_type, scope_hash, window_started_at)
      DO UPDATE SET request_count = radar_invitation_rate_limits.request_count + 1, updated_at = EXCLUDED.updated_at
      RETURNING request_count
    `, [operation, type, hash, windowStartedAt, now]);
    if (Number(result.rows[0].request_count) > limit) {
      throw invitationError("INVITATION_RATE_LIMITED", 429, "Muitas solicitacoes. Tente novamente mais tarde.");
    }
  }
}

async function audit(client, { invitationId, matchId = null, actorTeamId, actorReference, type, version, requestId, state }) {
  await client.query(`
    INSERT INTO match_audit_events(
      match_id, invitation_id, actor_team_id, actor_reference,
      event_type, entity_version, payload, request_id
    ) VALUES ($1, $2, $3, $4, $5, $6, $7::jsonb, $8)
  `, [matchId, invitationId, actorTeamId, actorReference, type, version, JSON.stringify({ state }), requestId || null]);
}

async function notify(client, { teamId, type, invitationPublicId, version, opponent, matchPublicId = null }) {
  const payload = {
    invitation_id: invitationPublicId,
    invitation_version: version,
    opponent_slug: opponent.publicSlug,
    opponent_name: opponent.publicName,
    ...(matchPublicId ? { match_id: matchPublicId } : {})
  };
  await client.query(`
    INSERT INTO notifications(
      recipient_team_id, event_type, entity_type, entity_public_id,
      payload, deduplication_key
    ) VALUES ($1, $2, 'friendly_invitation', $3, $4::jsonb, $5)
    ON CONFLICT (recipient_team_id, deduplication_key) DO NOTHING
  `, [teamId, type, invitationPublicId, JSON.stringify(payload), `${type}:${invitationPublicId}:v${version}`]);
}

const INVITATION_SELECT = `
  SELECT invitation.*,
    json_build_object(
      'id', requester.id, 'public_slug', requester.public_slug,
      'public_name', requester.public_name, 'city_name', requester.city_name, 'state_code', requester.state_code
    ) AS requester,
    json_build_object(
      'id', invited.id, 'public_slug', invited.public_slug,
      'public_name', invited.public_name, 'city_name', invited.city_name, 'state_code', invited.state_code
    ) AS invited
  FROM friendly_invitations invitation
  JOIN radar_team_profiles requester ON requester.id = invitation.requester_team_id
  JOIN radar_team_profiles invited ON invited.id = invitation.invited_team_id
`;

async function replay(client, { identity, teamId, operation, key, payloadHash }) {
  const result = await client.query(`
    SELECT payload_hash, radar_team_id, result_snapshot
    FROM radar_invitation_mutation_requests
    WHERE account_reference = $1 AND operation = $2 AND idempotency_key = $3
  `, [identity.accountId, operation, key]);
  if (!result.rowCount) return null;
  const row = result.rows[0];
  if (row.payload_hash !== payloadHash || row.radar_team_id !== teamId) {
    throw invitationError("IDEMPOTENCY_KEY_REUSED", 409, "Idempotency-Key ja utilizada com outros dados.");
  }
  return Object.freeze({ ...row.result_snapshot, replayed: true });
}

async function saveMutation(client, { identity, teamId, operation, key, payloadHash, invitationId, notificationId, result }) {
  await client.query(`
    INSERT INTO radar_invitation_mutation_requests(
      account_reference, operation, idempotency_key, payload_hash,
      radar_team_id, invitation_id, notification_id, result_snapshot
    ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8::jsonb)
  `, [identity.accountId, operation, key, payloadHash, teamId, invitationId || null, notificationId || null, JSON.stringify(result)]);
}

function normalizeDatabaseError(error) {
  if (error instanceof RadarIdentityError) return error;
  const constraint = String(error?.constraint || error?.message || "");
  if (error?.code === "23505" && constraint.includes("friendly_invitations_open_equivalent_idx")) {
    return invitationError("INVITATION_DUPLICATE", 409, "Ja existe um convite equivalente em aberto.");
  }
  if (error?.code === "23505" && constraint.includes("friendly_matches_invitation_id_key")) {
    return invitationError("INVITATION_ALREADY_ACCEPTED", 409, "Este convite ja criou uma partida.");
  }
  return error;
}

function createInvitationRepository({ pool, config }) {
  if (!pool || typeof pool.connect !== "function") throw new TypeError("Invitation repository requires PostgreSQL");

  async function withTransaction(work) {
    const client = await pool.connect();
    let open = false;
    try {
      await client.query("BEGIN");
      open = true;
      const result = await work(client);
      await client.query("COMMIT");
      open = false;
      return result;
    } catch (error) {
      await rollbackQuietly(client, open);
      throw normalizeDatabaseError(error);
    } finally { client.release(); }
  }

  async function expireInvitation(client, row, now) {
    const changed = await client.query(`
      UPDATE friendly_invitations
      SET state = 'expired', expired_at = $2, version = version + 1, updated_at = $2
      WHERE id = $1 AND state IN ('pending', 'counter_proposed')
      RETURNING *
    `, [row.id, now]);
    if (!changed.rowCount) return;
    const version = Number(changed.rows[0].version);
    const requester = rowToTeam(row.requester);
    const invited = rowToTeam(row.invited);
    await audit(client, {
      invitationId: row.id, actorTeamId: null, actorReference: "system:invitation-expiration",
      type: "friendly_invitation.expired", version, state: "expired"
    });
    await notify(client, { teamId: requester.id, type: "invitation_expired", invitationPublicId: row.public_id, version, opponent: invited });
    await notify(client, { teamId: invited.id, type: "invitation_expired", invitationPublicId: row.public_id, version, opponent: requester });
  }

  async function expireForTeam(client, teamId, now) {
    const result = await client.query(`${INVITATION_SELECT}
      WHERE (invitation.requester_team_id = $1 OR invitation.invited_team_id = $1)
        AND invitation.state IN ('pending', 'counter_proposed') AND invitation.expires_at <= $2
      FOR UPDATE OF invitation
    `, [teamId, now]);
    for (const row of result.rows) await expireInvitation(client, row, now);
  }

  async function createOwned({ identity, value, idempotencyKey, payloadHash, now, ip, requestId }) {
    return withTransaction(async client => {
      const initialOrigin = await loadOwnedTeam(client, identity);
      const candidateResult = await client.query("SELECT * FROM radar_team_profiles WHERE public_slug = $1", [value.opponentSlug]);
      if (candidateResult.rowCount !== 1) throw invitationError("INVITATION_OPPONENT_NOT_FOUND", 404, "Time indisponivel para convite.");
      const initialOpponent = rowToTeam(candidateResult.rows[0]);
      const locked = await lockPair(client, initialOrigin.id, initialOpponent.id);
      const origin = locked.get(initialOrigin.id);
      const opponent = locked.get(initialOpponent.id);
      assertRadarTeamOwnedByIdentity(origin, identity);
      assertRadarTeamCanMutate(origin);
      await consumeLimits(client, { identity, teamId: origin.id, ip, operation: "create", now, config });
      const replayed = await replay(client, { identity, teamId: origin.id, operation: "create", key: idempotencyKey, payloadHash });
      if (replayed) return replayed;
      await assertPairAllowed(client, origin, opponent, now);
      const proposal = canonicalProposal(value, origin, opponent);
      const hash = proposalHash(proposal);
      const expiresAt = new Date(Math.min(
        now.getTime() + config.invitationExpirationHours * 60 * 60 * 1000,
        new Date(value.startsAt).getTime()
      ));
      const inserted = await client.query(`
        INSERT INTO friendly_invitations(
          requester_team_id, invited_team_id, current_proposer_team_id,
          state, proposal, proposal_hash, idempotency_key,
          idempotency_payload_hash, expires_at
        ) VALUES ($1, $2, $1, 'pending', $3::jsonb, $4, $5, $6, $7)
        RETURNING id, public_id, state, version, proposal, current_proposer_team_id,
                  expires_at, created_at, updated_at
      `, [origin.id, opponent.id, JSON.stringify(proposal), hash, idempotencyKey, payloadHash, expiresAt]);
      const row = { ...inserted.rows[0], requester: {
        id: origin.id, public_slug: origin.publicSlug, public_name: origin.publicName,
        city_name: origin.cityName, state_code: origin.stateCode
      }, invited: {
        id: opponent.id, public_slug: opponent.publicSlug, public_name: opponent.publicName,
        city_name: opponent.cityName, state_code: opponent.stateCode
      }};
      const invitation = rowToInvitation(row, origin.id);
      const result = Object.freeze({ invitation, replayed: false });
      await saveMutation(client, {
        identity, teamId: origin.id, operation: "create", key: idempotencyKey,
        payloadHash, invitationId: inserted.rows[0].id, result
      });
      await audit(client, {
        invitationId: inserted.rows[0].id, actorTeamId: origin.id, actorReference: identity.accountId,
        type: "friendly_invitation.created", version: 1, requestId, state: "pending"
      });
      await notify(client, {
        teamId: opponent.id, type: "invitation_received", invitationPublicId: invitation.invitation_id,
        version: 1, opponent: origin
      });
      return result;
    });
  }

  async function listOwned({ identity, box, limit, now, ip }) {
    return withTransaction(async client => {
      const team = await loadOwnedTeam(client, identity);
      assertEligible(team, "INVITATION_ORIGIN_NOT_ELIGIBLE");
      await consumeLimits(client, { identity, teamId: team.id, ip, operation: `list_${box}`, now, config });
      await expireForTeam(client, team.id, now);
      const direction = box === "saida"
        ? "invitation.current_proposer_team_id = $1"
        : "invitation.current_proposer_team_id <> $1";
      const result = await client.query(`${INVITATION_SELECT}
        WHERE (invitation.requester_team_id = $1 OR invitation.invited_team_id = $1)
          AND ${direction}
        ORDER BY invitation.updated_at DESC, invitation.public_id DESC
        LIMIT $2
      `, [team.id, limit]);
      return Object.freeze({ items: Object.freeze(result.rows.map(row => rowToInvitation(row, team.id))) });
    });
  }

  async function mutateOwned({ identity, publicId, expectedVersion, operation, value, idempotencyKey, payloadHash, now, ip, requestId }) {
    const outcome = await withTransaction(async client => {
      const initialTeam = await loadOwnedTeam(client, identity);
      await consumeLimits(client, { identity, teamId: initialTeam.id, ip, operation, now, config });
      const replayed = await replay(client, { identity, teamId: initialTeam.id, operation, key: idempotencyKey, payloadHash });
      if (replayed) return replayed;
      const found = await client.query(`${INVITATION_SELECT}
        WHERE invitation.public_id = $1
          AND (invitation.requester_team_id = $2 OR invitation.invited_team_id = $2)
        FOR UPDATE OF invitation
      `, [publicId, initialTeam.id]);
      if (found.rowCount !== 1) throw invitationError("INVITATION_NOT_FOUND", 404, "Convite nao encontrado.");
      const row = found.rows[0];
      if (OPEN_STATES.has(row.state) && new Date(row.expires_at) <= now) {
        await expireInvitation(client, row, now);
        return Object.freeze({ expired: true });
      }
      if (Number(row.version) !== expectedVersion) throw invitationError("INVITATION_VERSION_CONFLICT", 409, "O convite mudou. Atualize e tente novamente.");
      if (TERMINAL_STATES.has(row.state)) throw invitationError("INVITATION_TERMINAL", 409, "Convite encerrado.");
      const requester = rowToTeam(row.requester);
      const invited = rowToTeam(row.invited);
      const locked = await lockPair(client, requester.id, invited.id);
      const team = locked.get(initialTeam.id);
      const other = locked.get(requester.id === team.id ? invited.id : requester.id);
      if (!team || !other) throw invitationError("INVITATION_OPPONENT_NOT_FOUND", 404, "Time indisponivel para convite.");
      assertRadarTeamOwnedByIdentity(team, identity);
      assertRadarTeamCanMutate(team);
      const currentRecipientId = row.current_proposer_team_id === requester.id ? invited.id : requester.id;
      if (["accept", "decline", "counter"].includes(operation) && team.id !== currentRecipientId) {
        throw invitationError("INVITATION_ACTION_FORBIDDEN", 403, "Somente quem recebeu a proposta atual pode responder.");
      }
      if (operation === "cancel" && team.id !== row.current_proposer_team_id) {
        throw invitationError("INVITATION_ACTION_FORBIDDEN", 403, "Somente quem enviou a proposta atual pode cancelar.");
      }
      if (["accept", "counter"].includes(operation)) {
        await assertPairAllowed(client, team, other, now);
      }

      let updated;
      let match = null;
      if (operation === "counter") {
        const proposal = canonicalProposal(value, team, other);
        updated = await client.query(`
          UPDATE friendly_invitations
          SET state = 'counter_proposed', proposal = $2::jsonb, proposal_hash = $3,
              current_proposer_team_id = $4, version = version + 1, updated_at = $5
          WHERE id = $1 RETURNING *
        `, [row.id, JSON.stringify(proposal), proposalHash(proposal), team.id, now]);
      } else {
        const state = { accept: "accepted", decline: "declined", cancel: "cancelled" }[operation];
        const timeColumn = { accept: "accepted_at", decline: "declined_at", cancel: "cancelled_at" }[operation];
        updated = await client.query(`
          UPDATE friendly_invitations
          SET state = $2, ${timeColumn} = $3, version = version + 1, updated_at = $3
          WHERE id = $1 RETURNING *
        `, [row.id, state, now]);
        if (operation === "accept") {
          const createdMatch = await client.query(`
            INSERT INTO friendly_matches(
              invitation_id, team_a_id, team_b_id, team_a_snapshot, team_b_snapshot, scheduled_at
            ) VALUES ($1, $2, $3, $4::jsonb, $5::jsonb, $6)
            ON CONFLICT (invitation_id) DO NOTHING
            RETURNING id, public_id
          `, [row.id, requester.id, invited.id, JSON.stringify(safeTeam(requester)), JSON.stringify(safeTeam(invited)), row.proposal.starts_at]);
          if (createdMatch.rowCount !== 1) throw invitationError("INVITATION_ALREADY_ACCEPTED", 409, "Este convite ja criou uma partida.");
          match = Object.freeze({ match_id: createdMatch.rows[0].public_id, state: "scheduled" });
        }
      }
      const merged = { ...row, ...updated.rows[0] };
      const invitation = rowToInvitation(merged, team.id);
      const result = Object.freeze({ invitation, ...(match ? { match } : {}), replayed: false });
      await saveMutation(client, {
        identity, teamId: team.id, operation, key: idempotencyKey, payloadHash,
        invitationId: row.id, result
      });
      await audit(client, {
        invitationId: row.id, matchId: match ? (await client.query("SELECT id FROM friendly_matches WHERE invitation_id = $1", [row.id])).rows[0].id : null,
        actorTeamId: team.id, actorReference: identity.accountId,
        type: `friendly_invitation.${operation === "accept" ? "accepted" : operation === "decline" ? "declined" : operation === "cancel" ? "cancelled" : "counter_proposed"}`,
        version: invitation.version, requestId, state: invitation.state
      });
      const notificationType = {
        accept: "invitation_accepted", decline: "invitation_declined",
        cancel: "invitation_cancelled", counter: "invitation_counter_proposed"
      }[operation];
      await notify(client, {
        teamId: other.id, type: notificationType, invitationPublicId: invitation.invitation_id,
        version: invitation.version, opponent: team, matchPublicId: match?.match_id
      });
      if (operation === "accept") {
        await notify(client, {
          teamId: team.id, type: "match_confirmed", invitationPublicId: invitation.invitation_id,
          version: invitation.version, opponent: other, matchPublicId: match.match_id
        });
      }
      return result;
    });
    if (outcome?.expired) throw invitationError("INVITATION_EXPIRED", 409, "Convite expirado.");
    return outcome;
  }

  async function listNotifications({ identity, cursor, limit, now, ip }) {
    return withTransaction(async client => {
      const team = await findOwnedTeam(client, identity);
      if (!team) {
        return Object.freeze({ rows: Object.freeze([]), limit });
      }
      await consumeLimits(client, { identity, teamId: team.id, ip, operation: "notifications_list", now, config });
      const params = [team.id];
      const cursorSql = cursor
        ? "AND (created_at, public_id) < ($2::timestamptz, $3::uuid)"
        : "";
      if (cursor) params.push(cursor.createdAt, cursor.publicId);
      params.push(limit + 1);
      const result = await client.query(`
        SELECT * FROM notifications
        WHERE recipient_team_id = $1 ${cursorSql}
        ORDER BY created_at DESC, public_id DESC
        LIMIT $${params.length}
      `, params);
      return Object.freeze({ rows: Object.freeze(result.rows.map(rowToNotification)), limit });
    });
  }

  async function readNotification({ identity, publicId, idempotencyKey, payloadHash, now, ip }) {
    return withTransaction(async client => {
      const team = await loadOwnedTeam(client, identity, { lock: true });
      await consumeLimits(client, { identity, teamId: team.id, ip, operation: "notification_read", now, config });
      const replayed = await replay(client, {
        identity, teamId: team.id, operation: "notification_read", key: idempotencyKey, payloadHash
      });
      if (replayed) return replayed;
      const found = await client.query(`
        SELECT * FROM notifications
        WHERE public_id = $1 AND recipient_team_id = $2
        FOR UPDATE
      `, [publicId, team.id]);
      if (found.rowCount !== 1) throw invitationError("NOTIFICATION_NOT_FOUND", 404, "Notificacao nao encontrada.");
      let row = found.rows[0];
      if (!row.read_at) {
        const updated = await client.query(`
          UPDATE notifications SET read_at = $3, version = version + 1
          WHERE public_id = $1 AND recipient_team_id = $2 RETURNING *
        `, [publicId, team.id, now]);
        row = updated.rows[0];
      }
      const result = Object.freeze({ notification: rowToNotification(row), replayed: false });
      await saveMutation(client, {
        identity, teamId: team.id, operation: "notification_read", key: idempotencyKey,
        payloadHash, notificationId: row.id, result
      });
      return result;
    });
  }

  return Object.freeze({ createOwned, listOwned, mutateOwned, listNotifications, readNotification });
}

module.exports = {
  createInvitationRepository,
  rowToInvitation,
  rowToNotification,
  eligible,
  canonicalProposal,
  normalizeDatabaseError
};
