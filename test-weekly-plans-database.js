"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");
const { PGlite } = require("@electric-sql/pglite");
const { migrate } = require("./src/db/migrate");
const { createWeeklyPlansRepository } = require("./src/plans/weekly-plans.repository");
const { getPlan } = require("./src/plans/weekly-plans.catalog");

function normalizeResult(result) {
  const last = Array.isArray(result) ? result.at(-1) : result;
  if (!last) return { rows: [], rowCount: 0 };
  return {
    ...last,
    rows: Array.isArray(last.rows) ? last.rows : [],
    rowCount: Array.isArray(last.rows) ? last.rows.length : Number(last.affectedRows || 0)
  };
}

function createPoolAdapter(database) {
  let queue = Promise.resolve();
  function execute(sql, params) {
    return params
      ? database.query(sql, params).then(normalizeResult)
      : database.exec(sql).then(normalizeResult);
  }
  return {
    query(sql, params) {
      const run = queue.then(() => execute(sql, params));
      queue = run.catch(() => {});
      return run;
    },
    async connect() {
      let release;
      const previous = queue;
      queue = new Promise(resolve => { release = resolve; });
      await previous;
      return { query: execute, release };
    }
  };
}

async function activate(repository, {
  customerKey,
  planCode = "semanal_2",
  attemptId,
  now,
  clientRequestId
}) {
  const plan = getPlan(planCode);
  await repository.beginPaymentAttempt({
    customerKey,
    plan,
    attemptId,
    externalReference: `omplan_${attemptId}`,
    idempotencyKey: `provider_${attemptId}`,
    clientRequestId,
    now,
    expiresAt: new Date(now.getTime() + 30 * 60 * 1000)
  });
  await repository.attachProviderOrder({
    attemptId,
    orderId: `ORD-${attemptId}`,
    paymentId: `PAY-${attemptId}`,
    now
  });
  return repository.confirmPayment({
    attemptId,
    state: {
      orderId: `ORD-${attemptId}`,
      paymentId: `PAY-${attemptId}`,
      orderStatus: "processed",
      paymentStatus: "processed",
      statusDetail: "accredited"
    },
    now
  });
}

test("weekly plans persist, renew safely and enforce concurrent weekly quota", async () => {
  const database = new PGlite();
  const pool = createPoolAdapter(database);
  const repository = createWeeklyPlansRepository({ pool });
  const start = new Date("2026-09-05T15:00:00.000Z");
  const customerKey = "wpc_test_customer_0001";

  try {
    const applied = await migrate({ pool });
    assert.equal(applied.at(-1), "017_weekly_image_plans.sql");
    assert.deepEqual(await migrate({ pool }), []);
    assert.equal(await repository.hasOperationalRecords({ now: start }), false);

    const abandonedAttemptId = "000000000000000000000001";
    await repository.beginPaymentAttempt({
      customerKey: "wpc_abandoned_customer",
      plan: getPlan("semanal_1"),
      attemptId: abandonedAttemptId,
      externalReference: `omplan_${abandonedAttemptId}`,
      idempotencyKey: `provider_${abandonedAttemptId}`,
      clientRequestId: "buy-plan-abandoned-0001",
      now: start,
      expiresAt: new Date(start.getTime() + 30 * 60 * 1000)
    });
    assert.equal(await repository.hasOperationalRecords({ now: start }), true);
    assert.equal(await repository.hasOperationalRecords({
      now: new Date(start.getTime() + (24 * 60 + 31) * 60 * 1000)
    }), false);

    const first = await activate(repository, {
      customerKey,
      attemptId: "111111111111111111111111",
      now: start,
      clientRequestId: "buy-plan-request-0001"
    });
    assert.equal(first.replayed, false);
    assert.equal(await repository.hasOperationalRecords({ now: start }), true);

    const samePayment = await repository.confirmPayment({
      attemptId: "111111111111111111111111",
      state: { paymentId: "PAY-111111111111111111111111" },
      now: start
    });
    assert.equal(samePayment.replayed, true);
    assert.equal(samePayment.subscription.id, first.subscription.id);

    const reservations = await Promise.all([1, 2, 3].map(index =>
      repository.reserveUsage({
        customerKey,
        orderId: `ORDER-W1-${index}`,
        clientRequestId: `order-request-w1-${index}`,
        payloadHash: String(index).padStart(64, "0"),
        productId: "resultado",
        now: new Date(start.getTime() + 60_000)
      })
    ));
    assert.equal(reservations.filter(item => item.used).length, 2);
    assert.equal(reservations.filter(item => item.reason === "weekly_limit_reached").length, 1);
    const batchAuthorizations = await repository.getUsageAuthorizations({
      orderIds: ["ORDER-W1-1", "ORDER-W1-2", "ORDER-UNKNOWN"]
    });
    assert.equal(batchAuthorizations.length, 2);
    assert.equal(batchAuthorizations.every(item => item.authorized), true);

    const replay = await repository.reserveUsage({
      customerKey,
      orderId: "ORDER-W1-RETRY",
      clientRequestId: "order-request-w1-1",
      payloadHash: String(1).padStart(64, "0"),
      productId: "resultado",
      now: new Date(start.getTime() + 61_000)
    });
    assert.equal(replay.replayed, true);
    assert.equal(replay.orderId, "ORDER-W1-1");

    await assert.rejects(
      repository.reserveUsage({
        customerKey,
        orderId: "ORDER-W1-CONFLICT",
        clientRequestId: "order-request-w1-1",
        payloadHash: "f".repeat(64),
        productId: "resultado",
        now: new Date(start.getTime() + 62_000)
      }),
      error => error?.code === "WEEKLY_PLAN_USAGE_IDEMPOTENCY_CONFLICT"
    );

    const secondWeek = await repository.reserveUsage({
      customerKey,
      orderId: "ORDER-W2-1",
      clientRequestId: "order-request-w2-1",
      payloadHash: "a".repeat(64),
      productId: "escalacao",
      now: new Date(start.getTime() + 7 * 24 * 60 * 60 * 1000)
    });
    assert.equal(secondWeek.used, true);
    assert.equal(secondWeek.weekIndex, 1);

    const released = await repository.releaseUsage({
      customerKey,
      orderId: "ORDER-W2-1",
      reason: "erro_pipeline",
      now: new Date(start.getTime() + 7 * 24 * 60 * 60 * 1000 + 1)
    });
    assert.equal(released, true);
    assert.equal(await repository.releaseUsage({
      customerKey,
      orderId: "ORDER-W2-1",
      reason: "erro_pipeline",
      now: new Date(start.getTime() + 7 * 24 * 60 * 60 * 1000 + 2)
    }), false);

    const day28 = await repository.getEntitlement({
      customerKey,
      now: new Date(start.getTime() + 28 * 24 * 60 * 60 * 1000)
    });
    assert.equal(day28.weekIndex, 3);
    const day30 = await repository.getEntitlement({
      customerKey,
      now: new Date(start.getTime() + 30 * 24 * 60 * 60 * 1000)
    });
    assert.equal(day30.active, false);
    const afterCycle = new Date(start.getTime() + 31 * 24 * 60 * 60 * 1000);
    assert.equal((await repository.getUsageAuthorization({
      orderId: "ORDER-W1-1"
    })).authorized, true);
    const reconciliationAfterCycle = await repository.findReconciliationAttempt({
      customerKey,
      now: afterCycle,
      staleBefore: new Date(afterCycle.getTime() - 5 * 60 * 1000)
    });
    assert.equal(reconciliationAfterCycle.id, "111111111111111111111111");
    const afterReversalWindow = new Date(start.getTime() + 181 * 24 * 60 * 60 * 1000);
    assert.equal(await repository.findReconciliationAttempt({
      customerKey,
      now: afterReversalWindow,
      staleBefore: new Date(afterReversalWindow.getTime() - 5 * 60 * 1000)
    }), null);

    const renewal = await activate(repository, {
      customerKey,
      planCode: "semanal_4",
      attemptId: "222222222222222222222222",
      now: new Date(start.getTime() + 24 * 60 * 60 * 1000),
      clientRequestId: "buy-plan-request-0002"
    });
    assert.equal(
      new Date(renewal.subscription.startsAt).toISOString(),
      new Date(first.subscription.endsAt).toISOString()
    );
    await assert.rejects(
      repository.beginPaymentAttempt({
        customerKey,
        plan: getPlan("semanal_6"),
        attemptId: "444444444444444444444444",
        externalReference: "omplan_444444444444444444444444",
        idempotencyKey: "provider_444444444444444444444444",
        clientRequestId: "buy-plan-request-0003",
        now: new Date(start.getTime() + 2 * 24 * 60 * 60 * 1000),
        expiresAt: new Date(start.getTime() + 2 * 24 * 60 * 60 * 1000 + 30 * 60 * 1000)
      }),
      error => error?.code === "WEEKLY_PLAN_RENEWAL_ALREADY_SCHEDULED"
    );

    const refundedCustomerKey = "wpc_test_customer_refunded";
    await activate(repository, {
      customerKey: refundedCustomerKey,
      attemptId: "333333333333333333333333",
      now: start,
      clientRequestId: "buy-plan-request-refunded"
    });
    const refundedUsage = await repository.reserveUsage({
      customerKey: refundedCustomerKey,
      orderId: "ORDER-REFUNDED-1",
      clientRequestId: "order-request-refunded-1",
      payloadHash: "b".repeat(64),
      productId: "resultado",
      now: new Date(start.getTime() + 60_000)
    });
    assert.equal(refundedUsage.used, true);
    assert.equal((await repository.getUsageAuthorization({
      orderId: "ORDER-REFUNDED-1"
    })).authorized, true);
    const revoked = await repository.revokePayment({
      attemptId: "333333333333333333333333",
      state: {
        orderId: "ORD-333333333333333333333333",
        paymentId: "PAY-333333333333333333333333",
        orderStatus: "processed",
        paymentStatus: "refunded",
        statusDetail: "refunded"
      },
      reason: "refunded",
      now: new Date(start.getTime() + 2 * 60 * 60 * 1000)
    });
    assert.equal(revoked.subscription.revocationReason, "refunded");
    assert.deepEqual(revoked.orderIds, ["ORDER-REFUNDED-1"]);
    assert.equal((await repository.getUsageAuthorization({
      orderId: "ORDER-REFUNDED-1"
    })).authorized, false);
    const refundedReplay = await repository.reserveUsage({
      customerKey: refundedCustomerKey,
      orderId: "ORDER-REFUNDED-1",
      clientRequestId: "order-request-refunded-1",
      payloadHash: "b".repeat(64),
      productId: "resultado",
      now: new Date(start.getTime() + 3 * 60 * 60 * 1000)
    });
    assert.equal(refundedReplay.used, false);
    assert.equal(refundedReplay.reason, "refunded");
    assert.equal((await repository.getEntitlement({
      customerKey: refundedCustomerKey,
      now: new Date(start.getTime() + 3 * 60 * 60 * 1000)
    })).active, false);

    const refundBeforeApprovalCustomer = "wpc_test_customer_refund_first";
    const refundFirstAttemptId = "555555555555555555555555";
    await repository.beginPaymentAttempt({
      customerKey: refundBeforeApprovalCustomer,
      plan: getPlan("semanal_2"),
      attemptId: refundFirstAttemptId,
      externalReference: `omplan_${refundFirstAttemptId}`,
      idempotencyKey: `provider_${refundFirstAttemptId}`,
      clientRequestId: "buy-plan-refund-before-approval",
      now: start,
      expiresAt: new Date(start.getTime() + 30 * 60 * 1000)
    });
    await repository.attachProviderOrder({
      attemptId: refundFirstAttemptId,
      orderId: `ORD-${refundFirstAttemptId}`,
      paymentId: `PAY-${refundFirstAttemptId}`,
      now: start
    });
    await repository.revokePayment({
      attemptId: refundFirstAttemptId,
      state: {
        orderId: `ORD-${refundFirstAttemptId}`,
        paymentId: `PAY-${refundFirstAttemptId}`,
        orderStatus: "processed",
        paymentStatus: "refunded",
        statusDetail: "refunded"
      },
      reason: "refunded",
      now: new Date(start.getTime() + 1_000)
    });
    const delayedApproval = await repository.confirmPayment({
      attemptId: refundFirstAttemptId,
      state: {
        orderId: `ORD-${refundFirstAttemptId}`,
        paymentId: `PAY-${refundFirstAttemptId}`,
        orderStatus: "processed",
        paymentStatus: "processed",
        statusDetail: "accredited"
      },
      now: new Date(start.getTime() + 2_000)
    });
    assert.equal(delayedApproval.blocked, true);
    assert.equal((await repository.getEntitlement({
      customerKey: refundBeforeApprovalCustomer,
      now: new Date(start.getTime() + 3_000)
    })).active, false);
  } finally {
    await database.close();
  }
});
