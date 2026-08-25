"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");
const { PGlite } = require("@electric-sql/pglite");
const { migrate } = require("./src/db/migrate");
const { createRadarConfig } = require("./src/config/radar");
const {
  createAvailabilityRepository
} = require("./src/friendlies/availability.repository");
const {
  createAvailabilityService
} = require("./src/friendlies/availability.service");

const BASE_NOW = new Date("2026-08-24T12:00:00.000Z");

function normalizeResult(result) {
  const lastResult = Array.isArray(result) ? result[result.length - 1] : result;
  if (!lastResult) return { rows: [], rowCount: 0 };
  return {
    ...lastResult,
    rowCount: lastResult.rows?.length || lastResult.affectedRows || 0
  };
}

function createPoolAdapter(database) {
  function client() {
    return {
      async query(sql, params) {
        if (params) return normalizeResult(await database.query(sql, params));
        return normalizeResult(await database.exec(sql));
      },
      release() {}
    };
  }
  return {
    connect: async () => client(),
    query: (sql, params) => client().query(sql, params)
  };
}

function owner(suffix = "owner") {
  return Object.freeze({
    accountId: `account-${suffix}`,
    profileId: `profile-${suffix}`,
    legacyProfile: Object.freeze({
      nome_time: `${suffix} FC`,
      publico: true,
      escudo_url: `/escudos/${suffix}.png`
    })
  });
}

function radarConfig(overrides = {}) {
  return createRadarConfig({
    RADAR_AMISTOSOS_ENABLED: "true",
    RADAR_PILOT_CITY_IBGE_CODE: "4209102",
    RADAR_AVAILABILITY_MAX_FUTURE_PER_TEAM: "20",
    RADAR_AVAILABILITY_PAGE_DEFAULT: "2",
    RADAR_AVAILABILITY_PAGE_MAXIMUM: "10",
    ...overrides
  });
}

async function insertTeam(database, identity, overrides = {}) {
  const status = overrides.status || "paused";
  const verification = overrides.verification || "verified";
  await database.query(`
    INSERT INTO radar_team_profiles(
      legacy_profile_id, account_reference, public_slug, status,
      instagram_handle, instagram_verification_status,
      city_ibge_code, city_name, state_code, modalities, categories,
      declared_level, travel_radius_km, venue_preference,
      availability_active, radar_terms_accepted_at, suspended_at
    ) VALUES (
      $1, $2, $3, $4, $5, $6,
      $7, $8, $9, ARRAY['society', 'futsal'], ARRAY['Livre', 'Veterano'],
      'intermediario', 25, 'either', false, $10, $11
    )
  `, [
    identity.profileId,
    identity.accountId,
    `${identity.profileId}-slug`,
    status,
    `${identity.profileId}.fc`,
    verification,
    overrides.cityIbgeCode || "4209102",
    overrides.cityName || "Joinville",
    overrides.stateCode || "SC",
    overrides.termsAccepted === false ? null : "2026-08-20T12:00:00.000Z",
    status === "suspended" ? "2026-08-23T12:00:00.000Z" : null
  ]);
}

function slot(day, overrides = {}) {
  const dd = String(day).padStart(2, "0");
  return {
    modality: "society",
    category: "Livre",
    starts_at: `2026-09-${dd}T19:00:00-03:00`,
    ends_at: `2026-09-${dd}T21:00:00-03:00`,
    status: "active",
    ...overrides
  };
}

function service(pool, overrides = {}, now = BASE_NOW) {
  return createAvailabilityService({
    repository: createAvailabilityRepository({ pool }),
    config: radarConfig(overrides),
    now: () => now
  });
}

test("migrations through 009 run twice safely and preserve immutable availability history", async () => {
  const database = new PGlite();
  const pool = createPoolAdapter(database);
  try {
    const first = await migrate({ pool });
    assert.equal(first.at(-1), "014_radar_smart_onboarding.sql");
    assert.deepEqual(await migrate({ pool }), []);
    const applied = await database.query(
      "SELECT name FROM schema_migrations WHERE name = '006_friendly_availability_management.sql'"
    );
    assert.equal(applied.rows.length, 1);

    const identity = owner("constraints");
    await insertTeam(database, identity);
    const created = await service(pool).create({
      identity,
      body: slot(10, { status: "paused" }),
      idempotencyKey: "constraints-create-0001"
    });
    const publicId = created.availability.availability_id;
    const row = (await database.query(
      "SELECT id, team_id, public_id, schedule_hash FROM friendly_availabilities WHERE public_id = $1",
      [publicId]
    )).rows[0];
    assert.match(row.public_id, /^[0-9a-f-]{36}$/i);
    assert.match(row.schedule_hash, /^[0-9a-f]{64}$/);

    await assert.rejects(
      database.query(
        "UPDATE friendly_availabilities SET team_id = gen_random_uuid(), version = version + 1 WHERE id = $1",
        [row.id]
      ),
      /ownership is immutable/
    );
    await assert.rejects(
      database.query(
        "UPDATE friendly_availabilities SET notes = 'x' WHERE id = $1",
        [row.id]
      ),
      /version must increase by one/
    );
    await assert.rejects(
      database.query("DELETE FROM friendly_availabilities WHERE id = $1", [row.id]),
      /logical cancellation/
    );
    await assert.rejects(
      database.query(
        "UPDATE radar_availability_mutation_requests SET resulting_version = 99 WHERE availability_id = $1",
        [row.id]
      ),
      /append-only/
    );
  } finally {
    await database.close();
  }
});

test("owned lifecycle is idempotent, duplicate-safe, private, optimistic and terminal", async () => {
  const database = new PGlite();
  const pool = createPoolAdapter(database);
  const identity = owner();
  const outsider = owner("outsider");
  try {
    await migrate({ pool });
    await insertTeam(database, identity);
    await insertTeam(database, outsider);
    const availabilityService = service(pool);
    const outsiderList = await availabilityService.list({ identity: outsider, query: {} });
    assert.deepEqual(outsiderList.items, []);

    const first = await availabilityService.create({
      identity,
      body: slot(10),
      idempotencyKey: "lifecycle-create-0001",
      requestId: "req-lifecycle-create"
    });
    assert.equal(first.availability.status, "active");
    assert.equal(first.availability.travel_radius_km, 25);
    assert.equal(Object.hasOwn(first.availability, "team_id"), false);
    assert.equal(Object.hasOwn(first.availability, "account_reference"), false);
    const replay = await availabilityService.create({
      identity,
      body: slot(10),
      idempotencyKey: "lifecycle-create-0001"
    });
    assert.equal(replay.replayed, true);
    assert.equal(replay.availability.availability_id, first.availability.availability_id);
    await assert.rejects(
      availabilityService.create({
        identity,
        body: slot(11),
        idempotencyKey: "lifecycle-create-0001"
      }),
      error => error.code === "IDEMPOTENCY_KEY_REUSED"
    );
    await assert.rejects(
      availabilityService.create({
        identity,
        body: slot(10),
        idempotencyKey: "lifecycle-duplicate-0001"
      }),
      error => error.code === "AVAILABILITY_DUPLICATE"
    );
    await assert.rejects(
      availabilityService.update({
        identity: outsider,
        publicId: first.availability.availability_id,
        body: { status: "paused" },
        expectedVersion: "1",
        idempotencyKey: "outsider-patch-0001"
      }),
      error => error.code === "AVAILABILITY_NOT_FOUND"
    );

    const updated = await availabilityService.update({
      identity,
      publicId: first.availability.availability_id,
      body: { status: "paused", notes: "Gramado sintetico" },
      expectedVersion: 'W/"1"',
      idempotencyKey: "lifecycle-patch-0001"
    });
    assert.equal(updated.availability.version, 2);
    const patchReplay = await availabilityService.update({
      identity,
      publicId: first.availability.availability_id,
      body: { status: "paused", notes: "Gramado sintetico" },
      expectedVersion: 'W/"1"',
      idempotencyKey: "lifecycle-patch-0001"
    });
    assert.equal(patchReplay.replayed, true);
    assert.equal(patchReplay.availability.version, 2);
    await assert.rejects(
      availabilityService.update({
        identity,
        publicId: first.availability.availability_id,
        body: { status: "paused", notes: "Outro conteudo" },
        expectedVersion: 'W/"1"',
        idempotencyKey: "lifecycle-patch-0001"
      }),
      error => error.code === "IDEMPOTENCY_KEY_REUSED"
    );
    const winner = await availabilityService.update({
      identity,
      publicId: first.availability.availability_id,
      body: { notes: "Campo coberto" },
      expectedVersion: "2",
      idempotencyKey: "concurrent-winner-0001"
    });
    assert.equal(winner.availability.version, 3);
    await assert.rejects(
      availabilityService.update({
        identity,
        publicId: first.availability.availability_id,
        body: { notes: "Tentativa atrasada" },
        expectedVersion: "2",
        idempotencyKey: "concurrent-loser-0001"
      }),
      error => error.code === "AVAILABILITY_VERSION_CONFLICT"
    );

    const cancelled = await availabilityService.cancel({
      identity,
      publicId: first.availability.availability_id,
      expectedVersion: "3",
      idempotencyKey: "lifecycle-delete-0001"
    });
    assert.equal(cancelled.availability.status, "cancelled");
    assert.equal(cancelled.availability.version, 4);
    const cancelReplay = await availabilityService.cancel({
      identity,
      publicId: first.availability.availability_id,
      expectedVersion: "3",
      idempotencyKey: "lifecycle-delete-0001"
    });
    assert.equal(cancelReplay.replayed, true);
    assert.equal(cancelReplay.availability.version, 4);
    assert.equal((await database.query(
      "SELECT count(*)::integer AS total FROM friendly_availabilities WHERE public_id = $1",
      [first.availability.availability_id]
    )).rows[0].total, 1);
    await assert.rejects(
      availabilityService.update({
        identity,
        publicId: first.availability.availability_id,
        body: { status: "active" },
        expectedVersion: "4",
        idempotencyKey: "terminal-reactivate-0001"
      }),
      error => error.code === "AVAILABILITY_TERMINAL"
    );

    const audits = await database.query(`
      SELECT event_type, payload::text AS payload
      FROM match_audit_events
      WHERE event_type LIKE 'friendly_availability.%'
      ORDER BY id
    `);
    assert.deepEqual(audits.rows.map(row => row.event_type), [
      "friendly_availability.created",
      "friendly_availability.updated",
      "friendly_availability.updated",
      "friendly_availability.cancelled"
    ]);
    assert.equal(audits.rows.some(row => /Gramado sintetico|Campo coberto/.test(row.payload)), false);
  } finally {
    await database.close();
  }
});

test("pagination is stable, expiration automatic and filters leak no internal ownership", async () => {
  const database = new PGlite();
  const pool = createPoolAdapter(database);
  const identity = owner("pagination");
  try {
    await migrate({ pool });
    await insertTeam(database, identity, { verification: "unverified", termsAccepted: false });
    const availabilityService = service(pool);
    for (const day of [10, 11, 12]) {
      await availabilityService.create({
        identity,
        body: slot(day, { status: "paused" }),
        idempotencyKey: `pagination-create-${day}`
      });
    }
    const first = await availabilityService.list({ identity, query: { status: "paused", limit: "2" } });
    assert.equal(first.items.length, 2);
    assert.equal(first.pagination.has_more, true);
    assert.ok(first.pagination.next_cursor);
    const second = await availabilityService.list({
      identity,
      query: { status: "paused", limit: "2", cursor: first.pagination.next_cursor }
    });
    assert.equal(second.items.length, 1);
    assert.equal(second.pagination.has_more, false);
    const ids = [...first.items, ...second.items].map(item => item.availability_id);
    assert.equal(new Set(ids).size, 3);
    const serialized = JSON.stringify([first, second]);
    for (const forbidden of ["team_id", "account_id", "account_reference", "profile_id", "whatsapp", "telefone"]) {
      assert.equal(serialized.includes(forbidden), false);
    }

    const afterAll = service(pool, {}, new Date("2026-10-01T12:00:00.000Z"));
    const expired = await afterAll.list({ identity, query: { status: "expired", limit: "10" } });
    assert.equal(expired.items.length, 3);
    assert.ok(expired.items.every(item => item.status === "expired"));
    const auditCount = await database.query(
      "SELECT count(*)::integer AS total FROM match_audit_events WHERE event_type = 'friendly_availability.expired'"
    );
    assert.equal(auditCount.rows[0].total, 3);
  } finally {
    await database.close();
  }
});

test("future limit, suspended team and pilot eligibility fail closed", async () => {
  const database = new PGlite();
  const pool = createPoolAdapter(database);
  const limited = owner("limited");
  const suspended = owner("suspended");
  const outside = owner("outside");
  try {
    await migrate({ pool });
    await insertTeam(database, limited);
    await insertTeam(database, suspended, { status: "suspended" });
    await insertTeam(database, outside, { cityIbgeCode: "3550308", cityName: "Sao Paulo", stateCode: "SP" });

    const oneOnly = service(pool, { RADAR_AVAILABILITY_MAX_FUTURE_PER_TEAM: "1" });
    await oneOnly.create({
      identity: limited,
      body: slot(10, { status: "paused" }),
      idempotencyKey: "limit-create-0001"
    });
    await assert.rejects(
      oneOnly.create({
        identity: limited,
        body: slot(11, { status: "paused" }),
        idempotencyKey: "limit-create-0002"
      }),
      error => error.code === "AVAILABILITY_LIMIT_REACHED"
    );
    await assert.rejects(
      service(pool).list({ identity: suspended, query: {} }),
      error => error.code === "RADAR_PROFILE_SUSPENDED"
    );
    await assert.rejects(
      service(pool).create({
        identity: outside,
        body: slot(12),
        idempotencyKey: "outside-pilot-active"
      }),
      error => error.code === "AVAILABILITY_NOT_ELIGIBLE" && error.details.missing.includes("outside_pilot_city")
    );
    await assert.doesNotReject(
      service(pool).create({
        identity: outside,
        body: slot(12, { status: "paused" }),
        idempotencyKey: "outside-pilot-paused"
      })
    );
  } finally {
    await database.close();
  }
});
