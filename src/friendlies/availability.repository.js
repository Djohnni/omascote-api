"use strict";

const { RadarIdentityError } = require("./radar-identity.errors");
const { rowToTeam } = require("./radar-identity.repository");
const {
  assertRadarTeamOwnedByIdentity,
  assertRadarTeamCanMutate
} = require("./radar-identity.policy");

function rowToAvailability(row) {
  if (!row) return null;
  if (row.publicId) {
    return Object.freeze({
      ...row,
      recurrence: row.recurrence ? Object.freeze({ ...row.recurrence }) : null
    });
  }
  return Object.freeze({
    id: row.id,
    publicId: row.public_id,
    teamId: row.team_id,
    modality: row.modality,
    category: row.category,
    declaredLevel: row.declared_level,
    startsAt: row.starts_at,
    endsAt: row.ends_at,
    recurrence: row.recurrence ? Object.freeze({ ...row.recurrence }) : null,
    cityIbgeCode: row.city_ibge_code,
    cityName: row.city_name,
    stateCode: row.state_code,
    travelRadiusKm: Number(row.travel_radius_km),
    venuePreference: row.venue_preference,
    notes: row.notes,
    status: row.status,
    scheduleHash: row.schedule_hash,
    version: Number(row.version),
    createdAt: row.created_at,
    updatedAt: row.updated_at
  });
}

async function rollbackQuietly(client, open) {
  if (!open) return;
  try {
    await client.query("ROLLBACK");
  } catch {}
}

async function loadOwnedTeam(client, identity, { lock = true } = {}) {
  const result = await client.query(
    `SELECT * FROM radar_team_profiles WHERE legacy_profile_id = $1${lock ? " FOR UPDATE" : ""}`,
    [identity.profileId]
  );
  if (result.rowCount !== 1) {
    throw new RadarIdentityError(
      "RADAR_PROFILE_NOT_FOUND",
      409,
      "Crie o perfil do Radar antes de cadastrar disponibilidades."
    );
  }
  const team = rowToTeam(result.rows[0]);
  assertRadarTeamOwnedByIdentity(team, identity);
  assertRadarTeamCanMutate(team);
  return team;
}

async function recordAudit(client, {
  teamId,
  actorReference,
  eventType,
  version,
  publicId,
  status,
  requestId = null,
  changedFields = []
}) {
  await client.query(`
    INSERT INTO match_audit_events(
      actor_team_id, actor_reference, event_type, entity_version, payload, request_id
    ) VALUES ($1, $2, $3, $4, $5::jsonb, $6)
  `, [
    teamId,
    actorReference,
    eventType,
    version,
    JSON.stringify({
      availability_public_id: publicId,
      status,
      changed_fields: changedFields
    }),
    requestId
  ]);
}

async function expireOwned(client, team, now) {
  const expired = await client.query(`
    UPDATE friendly_availabilities
    SET status = 'expired', version = version + 1, updated_at = $2
    WHERE team_id = $1
      AND status IN ('active', 'paused')
      AND ends_at <= $2
    RETURNING *
  `, [team.id, now]);
  for (const row of expired.rows) {
    await recordAudit(client, {
      teamId: team.id,
      actorReference: "system:availability-expiration",
      eventType: "friendly_availability.expired",
      version: Number(row.version),
      publicId: row.public_id,
      status: "expired",
      changedFields: ["status"]
    });
  }
  return expired.rowCount;
}

function availabilityError(code, status, message) {
  return new RadarIdentityError(code, status, message);
}

async function replayMutation(client, {
  identity,
  team,
  operation,
  idempotencyKey,
  payloadHash
}) {
  const result = await client.query(`
    SELECT payload_hash, radar_team_id, result_snapshot
    FROM radar_availability_mutation_requests
    WHERE account_reference = $1 AND operation = $2 AND idempotency_key = $3
  `, [identity.accountId, operation, idempotencyKey]);
  if (result.rowCount !== 1) return null;
  const replay = result.rows[0];
  if (replay.payload_hash !== payloadHash || replay.radar_team_id !== team.id) {
    throw availabilityError(
      "IDEMPOTENCY_KEY_REUSED",
      409,
      "Idempotency-Key ja utilizada com outros dados."
    );
  }
  return Object.freeze({
    availability: rowToAvailability(replay.result_snapshot),
    replayed: true
  });
}

async function saveMutation(client, {
  identity,
  team,
  operation,
  idempotencyKey,
  payloadHash,
  availability
}) {
  await client.query(`
    INSERT INTO radar_availability_mutation_requests(
      account_reference, operation, idempotency_key, payload_hash,
      radar_team_id, availability_id, resulting_version, result_snapshot
    ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8::jsonb)
  `, [
    identity.accountId,
    operation,
    idempotencyKey,
    payloadHash,
    team.id,
    availability.id,
    availability.version,
    JSON.stringify(availability)
  ]);
}

function normalizeDatabaseError(error) {
  if (error instanceof RadarIdentityError) return error;
  if (
    error?.code === "23505" &&
    String(error.constraint || error.message || "").includes("friendly_availabilities_open_schedule_key")
  ) {
    return availabilityError(
      "AVAILABILITY_DUPLICATE",
      409,
      "Ja existe uma disponibilidade equivalente para este time."
    );
  }
  return error;
}

function createAvailabilityRepository({ pool }) {
  if (!pool || typeof pool.connect !== "function" || typeof pool.query !== "function") {
    throw new TypeError("Availability repository requires a PostgreSQL pool");
  }

  async function getOwnedTeam(identity) {
    const client = await pool.connect();
    let transactionOpen = false;
    try {
      await client.query("BEGIN");
      transactionOpen = true;
      const team = await loadOwnedTeam(client, identity);
      await expireOwned(client, team, new Date());
      await client.query("COMMIT");
      transactionOpen = false;
      return team;
    } catch (error) {
      await rollbackQuietly(client, transactionOpen);
      throw normalizeDatabaseError(error);
    } finally {
      client.release();
    }
  }

  async function listOwned({ identity, status, cursor, limit, now }) {
    const client = await pool.connect();
    let transactionOpen = false;
    try {
      await client.query("BEGIN");
      transactionOpen = true;
      const team = await loadOwnedTeam(client, identity);
      await expireOwned(client, team, now);

      const parameters = [team.id];
      const filters = ["team_id = $1"];
      if (status) {
        parameters.push(status);
        filters.push(`status = $${parameters.length}`);
      }
      if (cursor) {
        parameters.push(cursor.startsAt, cursor.publicId);
        filters.push(`(starts_at, public_id) > ($${parameters.length - 1}::timestamptz, $${parameters.length}::uuid)`);
      }
      parameters.push(limit + 1);
      const result = await client.query(`
        SELECT * FROM friendly_availabilities
        WHERE ${filters.join(" AND ")}
        ORDER BY starts_at ASC, public_id ASC
        LIMIT $${parameters.length}
      `, parameters);
      await client.query("COMMIT");
      transactionOpen = false;
      return Object.freeze({
        rows: Object.freeze(result.rows.map(rowToAvailability)),
        limit
      });
    } catch (error) {
      await rollbackQuietly(client, transactionOpen);
      throw normalizeDatabaseError(error);
    } finally {
      client.release();
    }
  }

  async function createOwned({
    identity,
    idempotencyKey,
    payloadHash,
    now,
    requestId,
    maxFuture,
    buildAvailability
  }) {
    const client = await pool.connect();
    let transactionOpen = false;
    try {
      await client.query("BEGIN");
      transactionOpen = true;
      const team = await loadOwnedTeam(client, identity);
      await expireOwned(client, team, now);
      const replay = await replayMutation(client, {
        identity, team, operation: "create", idempotencyKey, payloadHash
      });
      if (replay) {
        await client.query("COMMIT");
        transactionOpen = false;
        return replay;
      }

      const count = await client.query(`
        SELECT count(*)::integer AS total
        FROM friendly_availabilities
        WHERE team_id = $1 AND status IN ('active', 'paused') AND ends_at > $2
      `, [team.id, now]);
      if (Number(count.rows[0]?.total || 0) >= maxFuture) {
        throw availabilityError(
          "AVAILABILITY_LIMIT_REACHED",
          409,
          "O time atingiu o limite de disponibilidades futuras."
        );
      }
      const value = buildAvailability(team);
      const inserted = await client.query(`
        INSERT INTO friendly_availabilities(
          team_id, modality, category, declared_level, starts_at, ends_at,
          recurrence, city_ibge_code, city_name, state_code, travel_radius_km,
          venue_preference, notes, status, schedule_hash
        ) VALUES (
          $1, $2, $3, $4, $5, $6, $7::jsonb, $8, $9, $10, $11, $12, $13, $14, $15
        ) RETURNING *
      `, [
        team.id,
        value.modality,
        value.category,
        value.declaredLevel,
        value.startsAt,
        value.endsAt,
        value.recurrence ? JSON.stringify(value.recurrence) : null,
        value.cityIbgeCode,
        value.cityName,
        value.stateCode,
        value.travelRadiusKm,
        value.venuePreference,
        value.notes,
        value.status,
        value.scheduleHash
      ]);
      const availability = rowToAvailability(inserted.rows[0]);
      await saveMutation(client, {
        identity, team, operation: "create", idempotencyKey, payloadHash, availability
      });
      await recordAudit(client, {
        teamId: team.id,
        actorReference: identity.accountId,
        eventType: "friendly_availability.created",
        version: availability.version,
        publicId: availability.publicId,
        status: availability.status,
        requestId,
        changedFields: [
          "modality", "category", "starts_at", "ends_at", "recurrence",
          "travel_radius_km", "venue_preference", "notes", "status"
        ]
      });
      await client.query("COMMIT");
      transactionOpen = false;
      return Object.freeze({ availability, replayed: false });
    } catch (error) {
      await rollbackQuietly(client, transactionOpen);
      throw normalizeDatabaseError(error);
    } finally {
      client.release();
    }
  }

  async function updateOwned({
    identity,
    publicId,
    expectedVersion,
    idempotencyKey,
    payloadHash,
    now,
    requestId,
    changedFields,
    buildAvailability
  }) {
    const client = await pool.connect();
    let transactionOpen = false;
    try {
      await client.query("BEGIN");
      transactionOpen = true;
      const team = await loadOwnedTeam(client, identity);
      await expireOwned(client, team, now);
      const replay = await replayMutation(client, {
        identity, team, operation: "patch", idempotencyKey, payloadHash
      });
      if (replay) {
        await client.query("COMMIT");
        transactionOpen = false;
        return replay;
      }
      const found = await client.query(`
        SELECT * FROM friendly_availabilities
        WHERE team_id = $1 AND public_id = $2
        FOR UPDATE
      `, [team.id, publicId]);
      if (found.rowCount !== 1) {
        throw availabilityError("AVAILABILITY_NOT_FOUND", 404, "Disponibilidade nao encontrada.");
      }
      const current = rowToAvailability(found.rows[0]);
      if (current.version !== expectedVersion) {
        throw availabilityError(
          "AVAILABILITY_VERSION_CONFLICT",
          409,
          "A disponibilidade foi alterada em outro acesso. Atualize e tente novamente."
        );
      }
      if (["expired", "cancelled"].includes(current.status)) {
        throw availabilityError(
          "AVAILABILITY_TERMINAL",
          409,
          "Disponibilidade encerrada nao pode ser reativada ou alterada."
        );
      }
      const value = buildAvailability(team, current);
      const updated = await client.query(`
        UPDATE friendly_availabilities
        SET modality = $3,
            category = $4,
            declared_level = $5,
            starts_at = $6,
            ends_at = $7,
            recurrence = $8::jsonb,
            city_ibge_code = $9,
            city_name = $10,
            state_code = $11,
            travel_radius_km = $12,
            venue_preference = $13,
            notes = $14,
            status = $15,
            schedule_hash = $16,
            version = version + 1,
            updated_at = $17
        WHERE team_id = $1 AND public_id = $2
        RETURNING *
      `, [
        team.id,
        publicId,
        value.modality,
        value.category,
        value.declaredLevel,
        value.startsAt,
        value.endsAt,
        value.recurrence ? JSON.stringify(value.recurrence) : null,
        value.cityIbgeCode,
        value.cityName,
        value.stateCode,
        value.travelRadiusKm,
        value.venuePreference,
        value.notes,
        value.status,
        value.scheduleHash,
        now
      ]);
      const availability = rowToAvailability(updated.rows[0]);
      await saveMutation(client, {
        identity, team, operation: "patch", idempotencyKey, payloadHash, availability
      });
      await recordAudit(client, {
        teamId: team.id,
        actorReference: identity.accountId,
        eventType: "friendly_availability.updated",
        version: availability.version,
        publicId: availability.publicId,
        status: availability.status,
        requestId,
        changedFields
      });
      await client.query("COMMIT");
      transactionOpen = false;
      return Object.freeze({ availability, replayed: false });
    } catch (error) {
      await rollbackQuietly(client, transactionOpen);
      throw normalizeDatabaseError(error);
    } finally {
      client.release();
    }
  }

  async function cancelOwned({
    identity,
    publicId,
    expectedVersion,
    idempotencyKey,
    payloadHash,
    now,
    requestId
  }) {
    const client = await pool.connect();
    let transactionOpen = false;
    try {
      await client.query("BEGIN");
      transactionOpen = true;
      const team = await loadOwnedTeam(client, identity);
      await expireOwned(client, team, now);
      const replay = await replayMutation(client, {
        identity, team, operation: "delete", idempotencyKey, payloadHash
      });
      if (replay) {
        await client.query("COMMIT");
        transactionOpen = false;
        return replay;
      }
      const found = await client.query(`
        SELECT * FROM friendly_availabilities
        WHERE team_id = $1 AND public_id = $2
        FOR UPDATE
      `, [team.id, publicId]);
      if (found.rowCount !== 1) {
        throw availabilityError("AVAILABILITY_NOT_FOUND", 404, "Disponibilidade nao encontrada.");
      }
      let availability = rowToAvailability(found.rows[0]);
      if (availability.version !== expectedVersion) {
        throw availabilityError(
          "AVAILABILITY_VERSION_CONFLICT",
          409,
          "A disponibilidade foi alterada em outro acesso. Atualize e tente novamente."
        );
      }
      if (availability.status === "expired") {
        throw availabilityError(
          "AVAILABILITY_TERMINAL",
          409,
          "Disponibilidade expirada nao pode ser cancelada."
        );
      }
      let changed = false;
      if (availability.status !== "cancelled") {
        const updated = await client.query(`
          UPDATE friendly_availabilities
          SET status = 'cancelled', version = version + 1, updated_at = $3
          WHERE team_id = $1 AND public_id = $2
          RETURNING *
        `, [team.id, publicId, now]);
        availability = rowToAvailability(updated.rows[0]);
        changed = true;
      }
      await saveMutation(client, {
        identity, team, operation: "delete", idempotencyKey, payloadHash, availability
      });
      if (changed) {
        await recordAudit(client, {
          teamId: team.id,
          actorReference: identity.accountId,
          eventType: "friendly_availability.cancelled",
          version: availability.version,
          publicId: availability.publicId,
          status: availability.status,
          requestId,
          changedFields: ["status"]
        });
      }
      await client.query("COMMIT");
      transactionOpen = false;
      return Object.freeze({ availability, replayed: false });
    } catch (error) {
      await rollbackQuietly(client, transactionOpen);
      throw normalizeDatabaseError(error);
    } finally {
      client.release();
    }
  }

  return Object.freeze({ getOwnedTeam, listOwned, createOwned, updateOwned, cancelOwned });
}

module.exports = {
  createAvailabilityRepository,
  rowToAvailability,
  loadOwnedTeam,
  expireOwned
};
