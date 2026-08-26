"use strict";

const { RadarIdentityError } = require("./radar-identity.errors");
const { rowToTeam } = require("./radar-identity.repository");
const {
  assertRadarTeamOwnedByIdentity,
  assertRadarTeamCanMutate
} = require("./radar-identity.policy");

function searchError(code, status, message) {
  return new RadarIdentityError(code, status, message);
}

function rowToCandidate(row) {
  return Object.freeze({
    teamId: row.team_id,
    accountReference: row.account_reference,
    publicId: row.public_id,
    publicSlug: row.public_slug,
    publicName: row.public_name,
    publicCrestAvailable: row.public_crest_available === true,
    instagramVerified: row.instagram_verification_status === "verified",
    joinedAt: row.joined_at,
    cityIbgeCode: row.city_ibge_code,
    cityName: row.city_name,
    stateCode: row.state_code,
    approximateLatitude: row.approximate_latitude,
    approximateLongitude: row.approximate_longitude,
    modalities: Array.isArray(row.modalities) ? [...row.modalities] : [],
    categories: Array.isArray(row.categories) ? [...row.categories] : [],
    modality: row.modality,
    category: row.category,
    whatsappAvailable: row.whatsapp_available === true,
    startsAt: row.starts_at,
    endsAt: row.ends_at,
    venuePreference: row.venue_preference,
    availabilityOverlap: row.availability_overlap === true,
    verifiedMatchCount: Number(row.verified_match_count || 0),
    wins: Number(row.wins || 0),
    draws: Number(row.draws || 0),
    losses: Number(row.losses || 0),
    verifiedReviewCount: Number(row.verified_review_count || 0),
    punctualitySum: Number(row.punctuality_sum || 0),
    organizationSum: Number(row.organization_sum || 0),
    communicationSum: Number(row.communication_sum || 0),
    fairPlaySum: Number(row.fair_play_sum || 0),
    wouldPlayAgainCount: Number(row.would_play_again_count || 0)
  });
}

async function rollbackQuietly(client, transactionOpen) {
  if (!transactionOpen) return;
  try {
    await client.query("ROLLBACK");
  } catch {}
}

function normalizeDatabaseError(error) {
  if (error instanceof RadarIdentityError) return error;
  if (error?.code === "57014") {
    return searchError(
      "FRIENDLY_SEARCH_TIMEOUT",
      503,
      "A busca demorou mais que o esperado. Tente novamente."
    );
  }
  return error;
}

function createFriendlySearchRepository({ pool, config }) {
  if (!pool || typeof pool.connect !== "function" || typeof pool.query !== "function") {
    throw new TypeError("Friendly search repository requires a PostgreSQL pool");
  }

  async function getOrigin(identity) {
    const result = await pool.query(
      "SELECT * FROM radar_team_profiles WHERE legacy_profile_id = $1",
      [identity.profileId]
    );
    if (result.rowCount !== 1) {
      throw searchError(
        "RADAR_PROFILE_NOT_FOUND",
        409,
        "Crie o perfil do Radar antes de procurar amistosos."
      );
    }
    const team = rowToTeam(result.rows[0]);
    assertRadarTeamOwnedByIdentity(team, identity);
    assertRadarTeamCanMutate(team);
    return team;
  }

  async function consumeRateLimits({ scopes, now }) {
    const client = await pool.connect();
    let transactionOpen = false;
    try {
      await client.query("BEGIN");
      transactionOpen = true;
      const windowMs = config.searchRateWindowSeconds * 1_000;
      const windowStartedAt = new Date(Math.floor(now.getTime() / windowMs) * windowMs);
      for (const scope of scopes) {
        const result = await client.query(`
          INSERT INTO radar_search_rate_limits(
            scope_type, scope_hash, window_started_at, request_count, updated_at
          ) VALUES ($1, $2, $3, 1, $4)
          ON CONFLICT (scope_type, scope_hash, window_started_at)
          DO UPDATE SET
            request_count = radar_search_rate_limits.request_count + 1,
            updated_at = EXCLUDED.updated_at
          WHERE radar_search_rate_limits.request_count < $5
          RETURNING request_count
        `, [scope.type, scope.hash, windowStartedAt, now, scope.limit]);
        if (result.rowCount !== 1) {
          throw searchError(
            "FRIENDLY_SEARCH_RATE_LIMITED",
            429,
            "Limite de buscas atingido. Aguarde um pouco e tente novamente."
          );
        }
      }
      await client.query(`
        DELETE FROM radar_search_rate_limits
        WHERE window_started_at < $1
      `, [new Date(now.getTime() - windowMs * 2)]);
      await client.query("COMMIT");
      transactionOpen = false;
    } catch (error) {
      await rollbackQuietly(client, transactionOpen);
      throw normalizeDatabaseError(error);
    } finally {
      client.release();
    }
  }

  async function searchCandidates({ origin, filters, snapshot, now }) {
    const client = await pool.connect();
    let transactionOpen = false;
    try {
      await client.query("BEGIN READ ONLY");
      transactionOpen = true;
      await client.query(
        "SELECT set_config('statement_timeout', $1, true)",
        [`${config.searchQueryTimeoutMs}ms`]
      );
      const result = await client.query(`
        SELECT
          candidate.id AS team_id,
          candidate.account_reference,
          candidate.public_id,
          candidate.public_slug,
          candidate.public_name,
          candidate.public_crest_available,
          candidate.instagram_verification_status,
          candidate.created_at AS joined_at,
          candidate.city_ibge_code,
          candidate.city_name,
          candidate.state_code,
          candidate.approximate_latitude,
          candidate.approximate_longitude,
          candidate.modalities,
          candidate.categories,
          (candidate.whatsapp_visible = true AND candidate.whatsapp_ciphertext IS NOT NULL) AS whatsapp_available,
          availability.modality,
          availability.category,
          availability.starts_at,
          availability.ends_at,
          availability.venue_preference,
          EXISTS (
            SELECT 1
            FROM friendly_availabilities own_availability
            WHERE own_availability.team_id = $1
              AND own_availability.status = 'active'
              AND own_availability.ends_at > $2
              AND own_availability.updated_at <= $3
              AND lower(own_availability.modality) = lower(availability.modality)
              AND lower(own_availability.category) = lower(availability.category)
              AND own_availability.starts_at < availability.ends_at
              AND own_availability.ends_at > availability.starts_at
          ) AS availability_overlap,
          COALESCE(statistics.matches_played, 0) AS verified_match_count,
          COALESCE(statistics.wins, 0) AS wins,
          COALESCE(statistics.draws, 0) AS draws,
          COALESCE(statistics.losses, 0) AS losses,
          COALESCE(reputation.verified_review_count, 0) AS verified_review_count,
          COALESCE(reputation.punctuality_sum, 0) AS punctuality_sum,
          COALESCE(reputation.organization_sum, 0) AS organization_sum,
          COALESCE(reputation.communication_sum, 0) AS communication_sum,
          COALESCE(reputation.fair_play_sum, 0) AS fair_play_sum,
          COALESCE(reputation.would_play_again_count, 0) AS would_play_again_count
        FROM radar_team_profiles candidate
        LEFT JOIN LATERAL (
          SELECT item.modality, item.category,
                 item.starts_at, item.ends_at, item.venue_preference
          FROM friendly_availabilities item
          WHERE item.team_id = candidate.id
            AND item.status = 'active'
            AND item.ends_at > $2
            AND item.created_at <= $3
            AND item.updated_at <= $3
            AND ($4::text IS NULL OR lower(item.modality) = lower($4))
            AND ($5::text IS NULL OR lower(item.category) = lower($5))
            AND ($6::integer IS NULL OR EXTRACT(ISODOW FROM item.starts_at AT TIME ZONE 'America/Sao_Paulo') = $6)
            AND (
              $7::text IS NULL
              OR ($7 = 'morning' AND EXTRACT(HOUR FROM item.starts_at AT TIME ZONE 'America/Sao_Paulo') BETWEEN 5 AND 11)
              OR ($7 = 'afternoon' AND EXTRACT(HOUR FROM item.starts_at AT TIME ZONE 'America/Sao_Paulo') BETWEEN 12 AND 17)
              OR ($7 = 'evening' AND (
                EXTRACT(HOUR FROM item.starts_at AT TIME ZONE 'America/Sao_Paulo') >= 18
                OR EXTRACT(HOUR FROM item.starts_at AT TIME ZONE 'America/Sao_Paulo') < 5
              ))
            )
            AND ($8::text IS NULL OR item.venue_preference = $8)
          ORDER BY item.starts_at ASC, item.public_id ASC
          LIMIT 1
        ) availability ON true
        LEFT JOIN radar_team_verified_statistics statistics ON statistics.team_id = candidate.id
        LEFT JOIN team_reputation_aggregates reputation ON reputation.team_id = candidate.id
        WHERE candidate.id <> $1
          AND candidate.status = 'active'
          AND candidate.suspended_at IS NULL
          AND candidate.radar_departed_at IS NULL
          AND candidate.radar_visible = true
          AND candidate.updated_at <= $3
          AND (
            $4::text IS NULL
            OR EXISTS (
              SELECT 1 FROM unnest(candidate.modalities) profile_modality(value)
              WHERE lower(profile_modality.value) = lower($4)
            )
            OR availability.modality IS NOT NULL
          )
          AND (
            $5::text IS NULL
            OR EXISTS (
              SELECT 1 FROM unnest(candidate.categories) profile_category(value)
              WHERE lower(profile_category.value) = lower($5)
            )
            OR availability.category IS NOT NULL
          )
          AND ($6::integer IS NULL OR availability.starts_at IS NOT NULL)
          AND ($7::text IS NULL OR availability.starts_at IS NOT NULL)
          AND ($8::text IS NULL OR availability.venue_preference IS NOT NULL)
          AND NOT EXISTS (
            SELECT 1
            FROM team_blocks block
            WHERE (block.blocker_team_id = $1 AND block.blocked_team_id = candidate.id)
               OR (block.blocker_team_id = candidate.id AND block.blocked_team_id = $1)
          )
        ORDER BY candidate.public_slug ASC
        LIMIT $9
      `, [
        origin.id,
        now,
        snapshot,
        filters.modality,
        filters.category,
        filters.dayNumber,
        filters.period,
        filters.venuePreference,
        config.searchCandidateMaximum
      ]);
      await client.query("COMMIT");
      transactionOpen = false;
      return Object.freeze(result.rows.map(rowToCandidate));
    } catch (error) {
      await rollbackQuietly(client, transactionOpen);
      throw normalizeDatabaseError(error);
    } finally {
      client.release();
    }
  }

  async function recordMetric({ outcome, returnedCount, now }) {
    await pool.query(`
      INSERT INTO radar_search_metrics(metric_date, outcome, request_count, returned_count, updated_at)
      VALUES ($1, $2, 1, $3, $4)
      ON CONFLICT (metric_date, outcome)
      DO UPDATE SET
        request_count = radar_search_metrics.request_count + 1,
        returned_count = radar_search_metrics.returned_count + EXCLUDED.returned_count,
        updated_at = EXCLUDED.updated_at
    `, [now.toISOString().slice(0, 10), outcome, returnedCount, now]);
  }

  return Object.freeze({ getOrigin, consumeRateLimits, searchCandidates, recordMetric });
}

module.exports = {
  createFriendlySearchRepository,
  rowToCandidate,
  normalizeDatabaseError
};
