"use strict";

const { RadarIdentityError } = require("./radar-identity.errors");
const {
  assertRadarTeamOwnedByIdentity,
  assertRadarTeamCanMutate
} = require("./radar-identity.policy");

const MUTABLE_COLUMNS = Object.freeze({
  accountReference: "account_reference",
  publicSlug: "public_slug",
  status: "status",
  instagramVerificationStatus: "instagram_verification_status",
  cityIbgeCode: "city_ibge_code",
  cityName: "city_name",
  stateCode: "state_code",
  approximateLatitude: "approximate_latitude",
  approximateLongitude: "approximate_longitude",
  instagramHandle: "instagram_handle",
  modalities: "modalities",
  categories: "categories",
  travelRadiusKm: "travel_radius_km",
  venuePreference: "venue_preference",
  availabilityActive: "availability_active",
  termsAcceptedAt: "radar_terms_accepted_at",
  publicName: "public_name",
  publicProfileEnabled: "public_profile_enabled",
  publicCrestAvailable: "public_crest_available",
  whatsappCiphertext: "whatsapp_ciphertext",
  whatsappKeyVersion: "whatsapp_key_version",
  whatsappVisible: "whatsapp_visible"
});

function publicSnapshot(legacyProfile) {
  const name = String(legacyProfile?.nome_time || "").replace(/\s+/g, " ").trim();
  const hasCrest = Boolean(
    String(legacyProfile?.escudo_url || "").trim() ||
    String(legacyProfile?.escudo_path || "").trim()
  );
  return Object.freeze({
    publicName: name.length >= 2 && name.length <= 80 ? name : null,
    publicProfileEnabled: legacyProfile?.publico === true,
    publicCrestAvailable: hasCrest
  });
}

function rowToTeam(row) {
  if (!row) return null;
  if (row.legacyProfileId) return Object.freeze({ ...row });

  return Object.freeze({
    id: row.id,
    publicId: row.public_id,
    legacyProfileId: row.legacy_profile_id,
    accountReference: row.account_reference,
    publicSlug: row.public_slug,
    status: row.status,
    instagramHandle: row.instagram_handle,
    instagramVerificationStatus: row.instagram_verification_status,
    cityIbgeCode: row.city_ibge_code,
    cityName: row.city_name,
    stateCode: row.state_code,
    approximateLatitude: row.approximate_latitude,
    approximateLongitude: row.approximate_longitude,
    modalities: Array.isArray(row.modalities) ? [...row.modalities] : [],
    categories: Array.isArray(row.categories) ? [...row.categories] : [],
    travelRadiusKm: Number(row.travel_radius_km || 25),
    venuePreference: row.venue_preference,
    availabilityActive: row.availability_active === true,
    termsAcceptedAt: row.radar_terms_accepted_at,
    publicName: row.public_name,
    publicProfileEnabled: row.public_profile_enabled === true,
    publicCrestAvailable: row.public_crest_available === true,
    whatsappCiphertext: row.whatsapp_ciphertext,
    whatsappKeyVersion: row.whatsapp_key_version,
    whatsappVisible: row.whatsapp_visible === true,
    suspendedAt: row.suspended_at,
    departedAt: row.radar_departed_at,
    version: Number(row.version || 1),
    createdAt: row.created_at,
    updatedAt: row.updated_at
  });
}

function comparable(value) {
  if (value instanceof Date) return value.toISOString();
  if (Array.isArray(value)) return JSON.stringify(value);
  if (value === undefined) return "__undefined__";
  return String(value ?? "__null__");
}

function changedValues(team, proposed) {
  const result = {};
  for (const [key, value] of Object.entries(proposed || {})) {
    if (!Object.hasOwn(MUTABLE_COLUMNS, key)) continue;
    if (comparable(team?.[key]) !== comparable(value)) result[key] = value;
  }
  return result;
}

function normalizeDatabaseError(error) {
  if (error instanceof RadarIdentityError) return error;
  if (
    error?.code === "23505" &&
    String(error.constraint || error.message || "").includes("account_reference")
  ) {
    return new RadarIdentityError(
      "ACCOUNT_ALREADY_LINKED",
      409,
      "Esta conta ja esta vinculada a outro perfil do Radar."
    );
  }
  return error;
}

function createRadarIdentityRepository({ pool }) {
  if (!pool || typeof pool.query !== "function" || typeof pool.connect !== "function") {
    throw new TypeError("Radar identity repository requires a PostgreSQL pool");
  }

  async function findOwnedByIdentity(identity) {
    const result = await pool.query(
      "SELECT * FROM radar_team_profiles WHERE legacy_profile_id = $1",
      [identity.profileId]
    );
    if (result.rowCount !== 1) return null;
    const team = rowToTeam(result.rows[0]);
    assertRadarTeamOwnedByIdentity(team, identity, { allowUnclaimed: true });
    return team;
  }

  async function mutateOwnedProfile({
    identity,
    idempotencyKey,
    payloadHash,
    expectedVersion,
    requestId,
    buildMutation
  }) {
    const client = await pool.connect();
    let transactionOpen = false;

    try {
      await client.query("BEGIN");
      transactionOpen = true;
      const snapshot = publicSnapshot(identity.legacyProfile);

      const inserted = await client.query(`
        INSERT INTO radar_team_profiles(
          legacy_profile_id, account_reference, public_slug,
          public_name, public_profile_enabled, public_crest_available
        ) VALUES ($1, $2, $3, $4, $5, $6)
        ON CONFLICT (legacy_profile_id) DO NOTHING
        RETURNING *
      `, [
        identity.profileId,
        identity.accountId,
        String(identity.legacyProfile?.slug || "").trim() || null,
        snapshot.publicName,
        snapshot.publicProfileEnabled,
        snapshot.publicCrestAvailable
      ]);

      const created = inserted.rowCount === 1;
      const locked = created
        ? inserted
        : await client.query(
          "SELECT * FROM radar_team_profiles WHERE legacy_profile_id = $1 FOR UPDATE",
          [identity.profileId]
        );

      if (locked.rowCount !== 1) {
        throw new RadarIdentityError(
          "RADAR_PROFILE_NOT_FOUND",
          409,
          "Nao foi possivel vincular o perfil ao Radar."
        );
      }

      let team = rowToTeam(locked.rows[0]);
      assertRadarTeamOwnedByIdentity(team, identity, { allowUnclaimed: true });

      const replayResult = await client.query(`
        SELECT payload_hash, radar_team_id, resulting_version, result_snapshot
        FROM radar_profile_mutation_requests
        WHERE account_reference = $1 AND idempotency_key = $2
      `, [identity.accountId, idempotencyKey]);

      if (replayResult.rowCount === 1) {
        const replay = replayResult.rows[0];
        if (replay.payload_hash !== payloadHash || replay.radar_team_id !== team.id) {
          throw new RadarIdentityError(
            "IDEMPOTENCY_KEY_REUSED",
            409,
            "Idempotency-Key ja utilizada com outros dados."
          );
        }

        await client.query("COMMIT");
        transactionOpen = false;
        return Object.freeze({ team: rowToTeam(replay.result_snapshot), replayed: true });
      }

      if (!created && expectedVersion === null) {
        throw new RadarIdentityError(
          "PROFILE_VERSION_REQUIRED",
          428,
          "Informe a versao atual do perfil em If-Match."
        );
      }
      if (!created && expectedVersion !== team.version) {
        throw new RadarIdentityError(
          "PROFILE_VERSION_CONFLICT",
          409,
          "O perfil foi alterado em outro acesso. Atualize e tente novamente."
        );
      }

      assertRadarTeamCanMutate(team);
      if (typeof buildMutation !== "function") {
        throw new TypeError("buildMutation is required");
      }

      const proposed = buildMutation(team);
      const values = changedValues(team, {
        ...proposed,
        accountReference: identity.accountId,
        publicSlug: team.publicSlug || String(identity.legacyProfile?.slug || "").trim() || null,
        ...snapshot
      });
      const changedFields = Object.keys(values);

      if (changedFields.length > 0) {
        const parameters = [];
        const assignments = changedFields.map((key) => {
          parameters.push(values[key]);
          return `${MUTABLE_COLUMNS[key]} = $${parameters.length}`;
        });
        parameters.push(team.id);
        const versionExpression = created ? "version" : "version + 1";

        const updated = await client.query(`
          UPDATE radar_team_profiles
          SET ${assignments.join(", ")}, version = ${versionExpression}, updated_at = now()
          WHERE id = $${parameters.length}
          RETURNING *
        `, parameters);
        team = rowToTeam(updated.rows[0]);
      }

      if (changedFields.includes("instagramHandle")) {
        const invalidated = await client.query(`
          UPDATE team_verifications
          SET status = 'cancelled',
              decided_at = now(),
              decision_details = '{"source":"system","reason_code":"instagram_changed"}'::jsonb,
              version = version + 1,
              updated_at = now()
          WHERE team_id = $1
            AND method = 'instagram_bio_code'
            AND status = 'pending'
          RETURNING id
        `, [team.id]);
        if (invalidated.rowCount > 0) {
          await client.query(`
            INSERT INTO match_audit_events(
              actor_team_id, actor_reference, event_type, entity_version, payload, request_id
            ) VALUES ($1, $2, 'instagram_verification.invalidated_by_profile_change', $3, $4::jsonb, $5)
          `, [
            team.id,
            identity.accountId,
            team.version,
            JSON.stringify({ invalidated_count: invalidated.rowCount }),
            requestId || null
          ]);
        }
      }

      await client.query(`
        INSERT INTO radar_profile_mutation_requests(
          account_reference, idempotency_key, payload_hash,
          radar_team_id, resulting_version, result_snapshot
        ) VALUES ($1, $2, $3, $4, $5, $6::jsonb)
      `, [
        identity.accountId,
        idempotencyKey,
        payloadHash,
        team.id,
        team.version,
        JSON.stringify(team)
      ]);

      await client.query(`
        INSERT INTO match_audit_events(
          actor_team_id, actor_reference, event_type, entity_version, payload, request_id
        ) VALUES ($1, $2, $3, $4, $5::jsonb, $6)
      `, [
        team.id,
        identity.accountId,
        created
          ? "radar_profile.created"
          : changedFields.length > 0
            ? "radar_profile.updated"
            : "radar_profile.unchanged",
        team.version,
        JSON.stringify({ changed_fields: changedFields, status: team.status }),
        requestId || null
      ]);

      await client.query("COMMIT");
      transactionOpen = false;
      return Object.freeze({ team, replayed: false });
    } catch (error) {
      if (transactionOpen) {
        try {
          await client.query("ROLLBACK");
        } catch {}
      }
      throw normalizeDatabaseError(error);
    } finally {
      client.release();
    }
  }

  return Object.freeze({ findOwnedByIdentity, mutateOwnedProfile });
}

module.exports = { createRadarIdentityRepository, rowToTeam, publicSnapshot };
