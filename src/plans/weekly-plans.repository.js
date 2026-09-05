"use strict";

const {
  cycleEndsAt,
  getCycleWindow,
  PAYMENT_REVERSAL_RECONCILIATION_DAYS,
  PAYMENT_PENDING_GRACE_MS
} = require("./weekly-plans.catalog");

function requirePool(pool) {
  if (!pool || typeof pool.connect !== "function" || typeof pool.query !== "function") {
    throw new TypeError("Weekly plans repository requires a PostgreSQL pool");
  }
}

function asDate(value) {
  return value instanceof Date ? new Date(value.getTime()) : new Date(value);
}

function rowToAttempt(row) {
  if (!row) return null;
  return Object.freeze({
    id: row.id,
    customerKey: row.customer_key,
    planCode: row.plan_code,
    planName: row.plan_name,
    weeklyLimit: Number(row.weekly_limit),
    cycleLimit: Number(row.cycle_limit),
    cycleDays: Number(row.cycle_days),
    expectedAmountCents: Number(row.expected_amount_cents),
    expectedCurrency: row.expected_currency,
    externalReference: row.external_reference,
    idempotencyKey: row.idempotency_key,
    clientRequestId: row.client_request_id,
    orderId: row.mp_order_id || "",
    paymentId: row.mp_payment_id || "",
    status: row.status,
    providerOrderStatus: row.provider_order_status || "",
    providerPaymentStatus: row.provider_payment_status || "",
    providerStatusDetail: row.provider_status_detail || "",
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    expiresAt: row.expires_at,
    confirmedAt: row.confirmed_at
  });
}

function rowToSubscription(row) {
  if (!row) return null;
  return Object.freeze({
    id: row.id,
    customerKey: row.customer_key,
    paymentAttemptId: row.payment_attempt_id,
    planCode: row.plan_code,
    planName: row.plan_name,
    weeklyLimit: Number(row.weekly_limit),
    cycleLimit: Number(row.cycle_limit),
    cycleDays: Number(row.cycle_days),
    priceCents: Number(row.price_cents),
    startsAt: row.starts_at,
    endsAt: row.ends_at,
    createdAt: row.created_at,
    revokedAt: row.revoked_at,
    revocationReason: row.revocation_reason || ""
  });
}

function rowToUsageAuthorization(row) {
  if (!row) return null;
  const authorized = !row.released_at && !row.revoked_at && row.payment_status === "confirmed";
  return Object.freeze({
    found: true,
    authorized,
    reason: authorized
      ? "authorized"
      : row.revocation_reason || (row.released_at ? "usage_released" : `payment_${row.payment_status || "invalid"}`),
    usageId: row.usage_id,
    orderId: row.order_id,
    customerKey: row.customer_key,
    subscriptionId: row.subscription_id,
    paymentStatus: row.payment_status
  });
}

async function rollbackQuietly(client, open) {
  if (!open) return;
  try { await client.query("ROLLBACK"); } catch {}
}

async function recordEvent(client, {
  customerKey,
  eventType,
  paymentAttemptId = null,
  subscriptionId = null,
  usageId = null,
  details = {},
  now
}) {
  await client.query(`
    INSERT INTO weekly_plan_events(
      customer_key, event_type, payment_attempt_id, subscription_id,
      usage_id, details, created_at
    ) VALUES ($1, $2, $3, $4, $5, $6::jsonb, $7)
  `, [
    customerKey,
    eventType,
    paymentAttemptId,
    subscriptionId,
    usageId,
    JSON.stringify(details || {}),
    now
  ]);
}

async function loadEntitlement(client, customerKey, now, { lock = false } = {}) {
  const activeResult = await client.query(`
    SELECT *
    FROM weekly_plan_subscriptions
    WHERE customer_key = $1 AND starts_at <= $2 AND ends_at > $2
      AND revoked_at IS NULL
    ORDER BY starts_at DESC
    LIMIT 1
    ${lock ? "FOR UPDATE" : ""}
  `, [customerKey, now]);
  const subscription = rowToSubscription(activeResult.rows?.[0]);

  const nextResult = await client.query(`
    SELECT *
    FROM weekly_plan_subscriptions
    WHERE customer_key = $1 AND starts_at > $2
      AND revoked_at IS NULL
    ORDER BY starts_at ASC
    LIMIT 1
  `, [customerKey, now]);
  const nextSubscription = rowToSubscription(nextResult.rows?.[0]);

  if (!subscription) {
    return Object.freeze({
      active: false,
      subscription: null,
      nextSubscription,
      weeklyUsed: 0,
      weeklyAvailable: 0,
      cycleUsed: 0,
      cycleAvailable: 0,
      weekIndex: null,
      weekStartsAt: null,
      weekEndsAt: null
    });
  }

  const window = getCycleWindow(subscription.startsAt, subscription.endsAt, now);
  if (!window) throw new Error("ACTIVE_WEEKLY_PLAN_WITHOUT_WINDOW");
  const usage = await client.query(`
    SELECT
      COUNT(*)::integer AS cycle_used,
      COUNT(*) FILTER (
        WHERE week_index = $2 AND reserved_at >= $3 AND reserved_at < $4
      )::integer AS weekly_used
    FROM weekly_plan_usage
    WHERE subscription_id = $1 AND released_at IS NULL
  `, [subscription.id, window.index, window.startsAt, window.endsAt]);
  const cycleUsed = Number(usage.rows?.[0]?.cycle_used || 0);
  const weeklyUsed = Number(usage.rows?.[0]?.weekly_used || 0);

  return Object.freeze({
    active: true,
    subscription,
    nextSubscription,
    weeklyUsed,
    weeklyAvailable: Math.max(0, subscription.weeklyLimit - weeklyUsed),
    cycleUsed,
    cycleAvailable: Math.max(0, subscription.cycleLimit - cycleUsed),
    weekIndex: window.index,
    weekStartsAt: window.startsAt,
    weekEndsAt: window.endsAt
  });
}

function createWeeklyPlansRepository({ pool }) {
  requirePool(pool);

  async function beginPaymentAttempt({
    customerKey,
    plan,
    attemptId,
    externalReference,
    idempotencyKey,
    clientRequestId,
    now,
    expiresAt
  }) {
    const client = await pool.connect();
    let open = false;
    try {
      await client.query("BEGIN");
      open = true;
      await client.query("SELECT pg_advisory_xact_lock(hashtext($1))", [
        `weekly-plan-payment:${customerKey}`
      ]);
      const clientReplay = await client.query(`
        SELECT * FROM weekly_plan_payment_attempts
        WHERE customer_key = $1 AND client_request_id = $2
        LIMIT 1
        FOR UPDATE
      `, [customerKey, clientRequestId]);
      if (clientReplay.rowCount === 1) {
        if (clientReplay.rows[0].plan_code !== plan.code) {
          const error = new Error("WEEKLY_PLAN_CLIENT_IDEMPOTENCY_CONFLICT");
          error.code = "WEEKLY_PLAN_CLIENT_IDEMPOTENCY_CONFLICT";
          throw error;
        }
        await client.query("COMMIT");
        open = false;
        return Object.freeze({ attempt: rowToAttempt(clientReplay.rows[0]), reused: true });
      }
      const existing = await client.query(`
        SELECT * FROM weekly_plan_payment_attempts
        WHERE customer_key = $1
          AND status IN ('creating', 'pending')
        ORDER BY created_at DESC
        LIMIT 1
        FOR UPDATE
      `, [customerKey]);
      if (existing.rowCount === 1) {
        await client.query("COMMIT");
        open = false;
        return Object.freeze({ attempt: rowToAttempt(existing.rows[0]), reused: true });
      }

      const scheduled = await client.query(`
        SELECT 1
        FROM weekly_plan_subscriptions
        WHERE customer_key = $1
          AND starts_at > $2
          AND ends_at > $2
          AND revoked_at IS NULL
        LIMIT 1
        FOR UPDATE
      `, [customerKey, now]);
      if (scheduled.rowCount === 1) {
        const error = new Error("WEEKLY_PLAN_RENEWAL_ALREADY_SCHEDULED");
        error.code = "WEEKLY_PLAN_RENEWAL_ALREADY_SCHEDULED";
        throw error;
      }

      const inserted = await client.query(`
        INSERT INTO weekly_plan_payment_attempts(
          id, customer_key, plan_code, plan_name, weekly_limit, cycle_limit,
          cycle_days, expected_amount_cents, expected_currency,
          external_reference, idempotency_key, client_request_id, status,
          created_at, updated_at, expires_at
        ) VALUES ($1, $2, $3, $4, $5, $6, 30, $7, 'BRL', $8, $9, $10, 'creating', $11, $11, $12)
        RETURNING *
      `, [
        attemptId,
        customerKey,
        plan.code,
        plan.name,
        plan.weeklyLimit,
        plan.cycleLimit,
        plan.priceCents,
        externalReference,
        idempotencyKey,
        clientRequestId,
        now,
        expiresAt
      ]);
      await recordEvent(client, {
        customerKey,
        eventType: "payment_attempt.created",
        paymentAttemptId: attemptId,
        details: { plan_code: plan.code, expected_amount_cents: plan.priceCents },
        now
      });
      await client.query("COMMIT");
      open = false;
      return Object.freeze({ attempt: rowToAttempt(inserted.rows[0]), reused: false });
    } catch (error) {
      await rollbackQuietly(client, open);
      throw error;
    } finally {
      client.release();
    }
  }

  async function attachProviderOrder({ attemptId, orderId, paymentId = "", now }) {
    const result = await pool.query(`
      UPDATE weekly_plan_payment_attempts
      SET mp_order_id = COALESCE(mp_order_id, $2),
          mp_payment_id = COALESCE(mp_payment_id, NULLIF($3, '')),
          status = CASE WHEN status = 'creating' THEN 'pending' ELSE status END,
          updated_at = $4
      WHERE id = $1
        AND status IN ('creating', 'pending')
        AND (mp_order_id IS NULL OR mp_order_id = $2)
        AND (mp_payment_id IS NULL OR $3 = '' OR mp_payment_id = $3)
      RETURNING *
    `, [attemptId, orderId, paymentId, now]);
    if (result.rowCount !== 1) throw new Error("WEEKLY_PLAN_PROVIDER_ORDER_CONFLICT");
    return rowToAttempt(result.rows[0]);
  }

  async function findPaymentAttempt({ orderId = "", externalReference = "", attemptId = "" }) {
    if (!orderId && !externalReference && !attemptId) return null;
    const result = await pool.query(`
      SELECT * FROM weekly_plan_payment_attempts
      WHERE ($1 <> '' AND mp_order_id = $1)
         OR ($2 <> '' AND external_reference = $2)
         OR ($3 <> '' AND id = $3)
      ORDER BY created_at DESC
      LIMIT 1
    `, [String(orderId), String(externalReference), String(attemptId)]);
    return rowToAttempt(result.rows?.[0]);
  }

  async function getOwnedPaymentAttempt({ customerKey, attemptId }) {
    const result = await pool.query(`
      SELECT * FROM weekly_plan_payment_attempts
      WHERE id = $1 AND customer_key = $2
      LIMIT 1
    `, [attemptId, customerKey]);
    return rowToAttempt(result.rows?.[0]);
  }

  async function findReconciliationAttempt({ customerKey, now, staleBefore }) {
    const reversalCutoff = new Date(
      asDate(now).getTime() - PAYMENT_REVERSAL_RECONCILIATION_DAYS * 24 * 60 * 60 * 1000
    );
    const result = await pool.query(`
      SELECT attempt.*
      FROM weekly_plan_payment_attempts attempt
      LEFT JOIN weekly_plan_subscriptions subscription
        ON subscription.payment_attempt_id = attempt.id
      WHERE attempt.customer_key = $1
        AND attempt.mp_order_id IS NOT NULL
        AND (
          (
            attempt.status IN ('creating', 'pending')
          )
          OR (
            attempt.status = 'confirmed'
            AND attempt.updated_at <= $2
            AND subscription.revoked_at IS NULL
            AND COALESCE(attempt.confirmed_at, attempt.created_at) >= $3
          )
        )
      ORDER BY
        CASE WHEN attempt.status = 'confirmed' THEN 0 ELSE 1 END,
        attempt.updated_at ASC
      LIMIT 1
    `, [customerKey, staleBefore, reversalCutoff]);
    return rowToAttempt(result.rows?.[0]);
  }

  async function updateProviderStatus({ attemptId, status, state, now }) {
    const result = await pool.query(`
      UPDATE weekly_plan_payment_attempts
      SET status = CASE
            WHEN status IN ('confirmed', 'refunded', 'charged_back') THEN status
            ELSE $2
          END,
          mp_order_id = COALESCE(mp_order_id, NULLIF($3, '')),
          mp_payment_id = COALESCE(mp_payment_id, NULLIF($4, '')),
          provider_order_status = $5,
          provider_payment_status = $6,
          provider_status_detail = $7,
          updated_at = $8
      WHERE id = $1
        AND (mp_order_id IS NULL OR $3 = '' OR mp_order_id = $3)
        AND (mp_payment_id IS NULL OR $4 = '' OR mp_payment_id = $4)
      RETURNING *
    `, [
      attemptId,
      status,
      state.orderId || "",
      state.paymentId || "",
      state.orderStatus || "",
      state.paymentStatus || "",
      state.statusDetail || "",
      now
    ]);
    return rowToAttempt(result.rows?.[0]);
  }

  async function confirmPayment({ attemptId, state, now }) {
    const client = await pool.connect();
    let open = false;
    try {
      await client.query("BEGIN");
      open = true;
      const attemptResult = await client.query(`
        SELECT * FROM weekly_plan_payment_attempts WHERE id = $1 FOR UPDATE
      `, [attemptId]);
      if (attemptResult.rowCount !== 1) throw new Error("WEEKLY_PLAN_ATTEMPT_NOT_FOUND");
      const attempt = rowToAttempt(attemptResult.rows[0]);
      if (["refunded", "charged_back"].includes(attempt.status)) {
        await client.query("COMMIT");
        open = false;
        return Object.freeze({
          subscription: null,
          replayed: true,
          blocked: true,
          status: attempt.status
        });
      }
      await client.query("SELECT pg_advisory_xact_lock(hashtext($1))", [
        `weekly-plan-subscription:${attempt.customerKey}`
      ]);

      const replay = await client.query(`
        SELECT * FROM weekly_plan_subscriptions WHERE payment_attempt_id = $1
      `, [attemptId]);
      if (replay.rowCount === 1) {
        const subscription = rowToSubscription(replay.rows[0]);
        if (!subscription?.revokedAt) {
          await client.query(`
            UPDATE weekly_plan_payment_attempts
            SET mp_order_id = COALESCE(mp_order_id, NULLIF($2, '')),
                mp_payment_id = COALESCE(mp_payment_id, NULLIF($3, '')),
                provider_order_status = $4,
                provider_payment_status = $5,
                provider_status_detail = $6,
                updated_at = $7
            WHERE id = $1
          `, [
            attempt.id,
            state.orderId || "",
            state.paymentId || "",
            state.orderStatus || "",
            state.paymentStatus || "",
            state.statusDetail || "",
            now
          ]);
        }
        await client.query("COMMIT");
        open = false;
        return Object.freeze({
          subscription,
          replayed: true,
          blocked: Boolean(subscription?.revokedAt),
          status: subscription?.revocationReason || attempt.status
        });
      }

      const latest = await client.query(`
        SELECT * FROM weekly_plan_subscriptions
        WHERE customer_key = $1 AND ends_at > $2 AND revoked_at IS NULL
        ORDER BY ends_at DESC
        LIMIT 1
        FOR UPDATE
      `, [attempt.customerKey, now]);
      const lastEnd = latest.rows?.[0]?.ends_at ? asDate(latest.rows[0].ends_at) : null;
      const startsAt = lastEnd && lastEnd > now ? lastEnd : asDate(now);
      const endsAt = cycleEndsAt(startsAt);
      const inserted = await client.query(`
        INSERT INTO weekly_plan_subscriptions(
          customer_key, payment_attempt_id, plan_code, plan_name,
          weekly_limit, cycle_limit, cycle_days, price_cents,
          starts_at, ends_at, created_at
        ) VALUES ($1, $2, $3, $4, $5, $6, 30, $7, $8, $9, $10)
        RETURNING *
      `, [
        attempt.customerKey,
        attempt.id,
        attempt.planCode,
        attempt.planName,
        attempt.weeklyLimit,
        attempt.cycleLimit,
        attempt.expectedAmountCents,
        startsAt,
        endsAt,
        now
      ]);
      const subscription = rowToSubscription(inserted.rows[0]);
      await client.query(`
        UPDATE weekly_plan_payment_attempts
        SET status = 'confirmed',
            mp_order_id = COALESCE(mp_order_id, NULLIF($2, '')),
            mp_payment_id = COALESCE(mp_payment_id, NULLIF($3, '')),
            provider_order_status = $4, provider_payment_status = $5,
            provider_status_detail = $6, confirmed_at = COALESCE(confirmed_at, $7), updated_at = $7
        WHERE id = $1
      `, [
        attempt.id,
        state.orderId || "",
        state.paymentId || "",
        state.orderStatus || "",
        state.paymentStatus || "",
        state.statusDetail || "",
        now
      ]);
      await recordEvent(client, {
        customerKey: attempt.customerKey,
        eventType: "subscription.activated",
        paymentAttemptId: attempt.id,
        subscriptionId: subscription.id,
        details: {
          plan_code: attempt.planCode,
          starts_at: startsAt.toISOString(),
          ends_at: endsAt.toISOString(),
          scheduled: startsAt > now
        },
        now
      });
      await client.query("COMMIT");
      open = false;
      return Object.freeze({ subscription, replayed: false });
    } catch (error) {
      await rollbackQuietly(client, open);
      throw error;
    } finally {
      client.release();
    }
  }

  async function revokePayment({ attemptId, state, reason, now }) {
    const client = await pool.connect();
    let open = false;
    try {
      await client.query("BEGIN");
      open = true;
      const attemptResult = await client.query(
        "SELECT * FROM weekly_plan_payment_attempts WHERE id = $1 FOR UPDATE",
        [attemptId]
      );
      if (attemptResult.rowCount !== 1) throw new Error("WEEKLY_PLAN_ATTEMPT_NOT_FOUND");
      const attempt = rowToAttempt(attemptResult.rows[0]);
      const normalizedReason = String(reason || "refunded").slice(0, 40);
      await client.query(`
        UPDATE weekly_plan_payment_attempts
        SET status = $2,
            mp_order_id = COALESCE(mp_order_id, NULLIF($3, '')),
            mp_payment_id = COALESCE(mp_payment_id, NULLIF($4, '')),
            provider_order_status = $5,
            provider_payment_status = $6,
            provider_status_detail = $7,
            updated_at = $8
        WHERE id = $1
      `, [
        attemptId,
        normalizedReason,
        state.orderId || "",
        state.paymentId || "",
        state.orderStatus || "",
        state.paymentStatus || "",
        state.statusDetail || "",
        now
      ]);
      const subscriptionResult = await client.query(`
        SELECT * FROM weekly_plan_subscriptions
        WHERE payment_attempt_id = $1
        LIMIT 1
        FOR UPDATE
      `, [attemptId]);
      const existingSubscription = subscriptionResult.rows?.[0] || null;
      let subscription = rowToSubscription(existingSubscription);
      const replayed = ["refunded", "charged_back"].includes(attempt.status) ||
        Boolean(existingSubscription?.revoked_at);

      if (existingSubscription && !existingSubscription.revoked_at) {
        const revoked = await client.query(`
          UPDATE weekly_plan_subscriptions
          SET revoked_at = $2, revocation_reason = $3
          WHERE payment_attempt_id = $1 AND revoked_at IS NULL
          RETURNING *
        `, [attemptId, now, normalizedReason]);
        subscription = rowToSubscription(revoked.rows?.[0] || existingSubscription);
        await recordEvent(client, {
          customerKey: attempt.customerKey,
          eventType: "subscription.revoked",
          paymentAttemptId: attemptId,
          subscriptionId: subscription?.id || null,
          details: { reason: normalizedReason },
          now
        });
      }

      const usages = await client.query(`
        SELECT order_id
        FROM weekly_plan_usage
        WHERE subscription_id = $1 AND released_at IS NULL
        ORDER BY reserved_at ASC, order_id ASC
      `, [existingSubscription?.id || null]);
      const orderIds = usages.rows.map(row => String(row.order_id || "")).filter(Boolean);

      await client.query("COMMIT");
      open = false;
      return Object.freeze({ subscription, replayed, orderIds: Object.freeze(orderIds) });
    } catch (error) {
      await rollbackQuietly(client, open);
      throw error;
    } finally {
      client.release();
    }
  }

  async function getEntitlement({ customerKey, now }) {
    return loadEntitlement(pool, customerKey, now);
  }

  async function hasOperationalRecords({ now }) {
    const pendingAfter = new Date(asDate(now).getTime() - PAYMENT_PENDING_GRACE_MS);
    const result = await pool.query(`
      SELECT (
        EXISTS (
          SELECT 1
          FROM weekly_plan_payment_attempts
          WHERE status = 'confirmed'
             OR status = 'pending'
             OR (
               status = 'creating'
               AND (mp_order_id IS NOT NULL OR expires_at > $2)
             )
        )
        OR EXISTS (
          SELECT 1
          FROM weekly_plan_subscriptions
          WHERE revoked_at IS NULL AND ends_at > $1
        )
        OR EXISTS (
          SELECT 1
          FROM weekly_plan_usage
        )
      ) AS required
    `, [now, pendingAfter]);
    return result.rows?.[0]?.required === true;
  }

  async function getCustomerOperationalState({ customerKey, now }) {
    const pendingAfter = new Date(asDate(now).getTime() - PAYMENT_PENDING_GRACE_MS);
    const result = await pool.query(`
      SELECT
        EXISTS (
          SELECT 1
          FROM weekly_plan_subscriptions
          WHERE customer_key = $1
            AND revoked_at IS NULL
            AND ends_at > $2
        ) AS has_entitlement,
        EXISTS (
          SELECT 1
          FROM weekly_plan_payment_attempts
          WHERE customer_key = $1
            AND (
              status = 'pending'
              OR (
                status = 'creating'
                AND (mp_order_id IS NOT NULL OR expires_at > $3)
              )
            )
        ) AS payment_pending
    `, [customerKey, now, pendingAfter]);
    return Object.freeze({
      hasEntitlement: result.rows?.[0]?.has_entitlement === true,
      paymentPending: result.rows?.[0]?.payment_pending === true
    });
  }

  async function getUsageAuthorization({ orderId }) {
    const result = await pool.query(`
      SELECT usage.id AS usage_id,
             usage.order_id,
             usage.customer_key,
             usage.subscription_id,
             usage.released_at,
             subscription.revoked_at,
             subscription.revocation_reason,
             attempt.status AS payment_status
      FROM weekly_plan_usage usage
      JOIN weekly_plan_subscriptions subscription ON subscription.id = usage.subscription_id
      JOIN weekly_plan_payment_attempts attempt ON attempt.id = subscription.payment_attempt_id
      WHERE usage.order_id = $1
      LIMIT 1
    `, [String(orderId || "")]);
    return rowToUsageAuthorization(result.rows?.[0]) ||
      Object.freeze({ found: false, authorized: false, reason: "usage_not_found" });
  }

  async function getUsageAuthorizations({ orderIds }) {
    const ids = [...new Set((Array.isArray(orderIds) ? orderIds : [])
      .map(value => String(value || "").trim())
      .filter(Boolean))];
    if (!ids.length) return Object.freeze([]);
    const result = await pool.query(`
      SELECT usage.id AS usage_id,
             usage.order_id,
             usage.customer_key,
             usage.subscription_id,
             usage.released_at,
             subscription.revoked_at,
             subscription.revocation_reason,
             attempt.status AS payment_status
      FROM weekly_plan_usage usage
      JOIN weekly_plan_subscriptions subscription ON subscription.id = usage.subscription_id
      JOIN weekly_plan_payment_attempts attempt ON attempt.id = subscription.payment_attempt_id
      WHERE usage.order_id = ANY($1::text[])
    `, [ids]);
    return Object.freeze(result.rows.map(rowToUsageAuthorization).filter(Boolean));
  }

  async function reserveUsage({ customerKey, orderId, clientRequestId, payloadHash, productId, now }) {
    const client = await pool.connect();
    let open = false;
    try {
      await client.query("BEGIN");
      open = true;
      await client.query("SELECT pg_advisory_xact_lock(hashtext($1))", [
        `weekly-plan-usage:${customerKey}`
      ]);
      await client.query("SELECT pg_advisory_xact_lock(hashtext($1))", [
        `weekly-plan-subscription:${customerKey}`
      ]);

      const existing = await client.query(`
        SELECT usage.*, subscription.plan_code, subscription.plan_name,
               subscription.weekly_limit, subscription.cycle_limit,
               subscription.starts_at, subscription.ends_at,
               subscription.revoked_at, subscription.revocation_reason,
               attempt.status AS payment_status
        FROM weekly_plan_usage usage
        JOIN weekly_plan_subscriptions subscription ON subscription.id = usage.subscription_id
        JOIN weekly_plan_payment_attempts attempt ON attempt.id = subscription.payment_attempt_id
        WHERE usage.customer_key = $2
          AND usage.released_at IS NULL
          AND (usage.order_id = $1 OR usage.client_request_id = $3)
        ORDER BY usage.reserved_at DESC
        LIMIT 1
      `, [orderId, customerKey, clientRequestId]);
      if (existing.rowCount === 1) {
        const row = existing.rows[0];
        if (row.payload_hash !== payloadHash || row.product_id !== productId) {
          const error = new Error("WEEKLY_PLAN_USAGE_IDEMPOTENCY_CONFLICT");
          error.code = "WEEKLY_PLAN_USAGE_IDEMPOTENCY_CONFLICT";
          throw error;
        }
        if (row.revoked_at || row.payment_status !== "confirmed") {
          await client.query("COMMIT");
          open = false;
          return Object.freeze({
            used: false,
            replayed: true,
            reason: row.revocation_reason || `payment_${row.payment_status || "invalid"}`,
            orderId: row.order_id
          });
        }
        await client.query("COMMIT");
        open = false;
        return Object.freeze({
          used: true,
          replayed: true,
          orderId: row.order_id,
          usageId: row.id,
          subscriptionId: row.subscription_id,
          planCode: row.plan_code,
          planName: row.plan_name,
          weeklyLimit: Number(row.weekly_limit),
          cycleLimit: Number(row.cycle_limit),
          weekIndex: Number(row.week_index),
          startsAt: row.starts_at,
          endsAt: row.ends_at
        });
      }

      const entitlement = await loadEntitlement(client, customerKey, now, { lock: true });
      if (!entitlement.active) {
        const pendingAfter = new Date(asDate(now).getTime() - PAYMENT_PENDING_GRACE_MS);
        const pendingPayment = await client.query(`
          SELECT 1
          FROM weekly_plan_payment_attempts
          WHERE customer_key = $1
            AND (
              status = 'pending'
              OR (
                status = 'creating'
                AND (mp_order_id IS NOT NULL OR expires_at > $2)
              )
            )
          LIMIT 1
        `, [customerKey, pendingAfter]);
        await client.query("COMMIT");
        open = false;
        return Object.freeze({
          used: false,
          reason: pendingPayment.rowCount === 1 ? "payment_pending" : "no_active_plan"
        });
      }
      if (entitlement.weeklyAvailable <= 0) {
        await client.query("COMMIT");
        open = false;
        return Object.freeze({ used: false, reason: "weekly_limit_reached", entitlement });
      }
      if (entitlement.cycleAvailable <= 0) {
        await client.query("COMMIT");
        open = false;
        return Object.freeze({ used: false, reason: "cycle_limit_reached", entitlement });
      }

      const inserted = await client.query(`
        INSERT INTO weekly_plan_usage(
          subscription_id, customer_key, order_id, client_request_id,
          payload_hash, product_id, week_index, reserved_at
        ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
        RETURNING *
      `, [
        entitlement.subscription.id,
        customerKey,
        orderId,
        clientRequestId,
        payloadHash,
        productId,
        entitlement.weekIndex,
        now
      ]);
      const usage = inserted.rows[0];
      await recordEvent(client, {
        customerKey,
        eventType: "quota.reserved",
        subscriptionId: entitlement.subscription.id,
        usageId: usage.id,
        details: { order_id: orderId, product_id: productId, week_index: entitlement.weekIndex },
        now
      });
      await client.query("COMMIT");
      open = false;
      return Object.freeze({
        used: true,
        replayed: false,
        orderId,
        usageId: usage.id,
        subscriptionId: entitlement.subscription.id,
        planCode: entitlement.subscription.planCode,
        planName: entitlement.subscription.planName,
        weeklyLimit: entitlement.subscription.weeklyLimit,
        cycleLimit: entitlement.subscription.cycleLimit,
        weekIndex: entitlement.weekIndex,
        startsAt: entitlement.subscription.startsAt,
        endsAt: entitlement.subscription.endsAt
      });
    } catch (error) {
      await rollbackQuietly(client, open);
      throw error;
    } finally {
      client.release();
    }
  }

  async function releaseUsage({ customerKey, orderId, reason, now }) {
    const client = await pool.connect();
    let open = false;
    try {
      await client.query("BEGIN");
      open = true;
      await client.query("SELECT pg_advisory_xact_lock(hashtext($1))", [
        `weekly-plan-usage:${customerKey}`
      ]);
      const released = await client.query(`
        UPDATE weekly_plan_usage
        SET released_at = $3, release_reason = $4
        WHERE customer_key = $1 AND order_id = $2 AND released_at IS NULL
        RETURNING *
      `, [customerKey, orderId, now, String(reason || "technical_failure").slice(0, 120)]);
      if (released.rowCount === 1) {
        const usage = released.rows[0];
        await recordEvent(client, {
          customerKey,
          eventType: "quota.released",
          subscriptionId: usage.subscription_id,
          usageId: usage.id,
          details: { order_id: orderId, reason: usage.release_reason },
          now
        });
      }
      await client.query("COMMIT");
      open = false;
      return released.rowCount === 1;
    } catch (error) {
      await rollbackQuietly(client, open);
      throw error;
    } finally {
      client.release();
    }
  }

  return Object.freeze({
    beginPaymentAttempt,
    attachProviderOrder,
    findPaymentAttempt,
    getOwnedPaymentAttempt,
    findReconciliationAttempt,
    updateProviderStatus,
    confirmPayment,
    revokePayment,
    getEntitlement,
    hasOperationalRecords,
    getCustomerOperationalState,
    getUsageAuthorization,
    getUsageAuthorizations,
    reserveUsage,
    releaseUsage
  });
}

module.exports = {
  createWeeklyPlansRepository,
  rowToAttempt,
  rowToSubscription,
  rowToUsageAuthorization
};
