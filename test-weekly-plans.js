"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");
const {
  WEEKLY_PLANS,
  getCycleWindow,
  getPlan,
  isWeeklyPlanEligibleProduct,
  cycleEndsAt
} = require("./src/plans/weekly-plans.catalog");
const {
  createWeeklyPlansService,
  publicSummary
} = require("./src/plans/weekly-plans.service");
const {
  weeklyPlanPendingOperational,
  weeklyPlansOperationallyRequired,
  weeklyPlansReadiness
} = require("./src/plans/weekly-plans.readiness");

test("weekly plan catalog fixes server-side prices and limits", () => {
  assert.deepEqual(
    WEEKLY_PLANS.map(plan => [plan.code, plan.weeklyLimit, plan.cycleLimit, plan.priceCents]),
    [
      ["semanal_1", 1, 4, 1890],
      ["semanal_2", 2, 8, 2890]
    ]
  );
  assert.equal(getPlan("SEMANAL_2").priceCents, 2890);
  assert.equal(getPlan("semanal_4"), null);
  assert.equal(getPlan("semanal_6"), null);
  assert.equal(getPlan("nao_existe"), null);
  assert.equal(isWeeklyPlanEligibleProduct("resultado", { priceCents: 800 }), true);
  assert.equal(isWeeklyPlanEligibleProduct("resultado", { priceCents: 801 }), false);
  assert.equal(isWeeklyPlanEligibleProduct("contratacao", {
    priceCents: 780,
    hasPaidAddon: true
  }), false);
  assert.equal(isWeeklyPlanEligibleProduct("mascote_uniforme", { priceCents: 1800 }), false);
  assert.equal(isWeeklyPlanEligibleProduct("produto_futuro", { priceCents: 400 }), false);
});

test("30-day cycle has four windows and no fifth release on day 28", () => {
  const start = new Date("2026-09-05T15:00:00.000Z");
  const end = cycleEndsAt(start);
  const cases = [
    ["2026-09-05T15:00:00.000Z", 0],
    ["2026-09-12T14:59:59.999Z", 0],
    ["2026-09-12T15:00:00.000Z", 1],
    ["2026-09-19T15:00:00.000Z", 2],
    ["2026-09-26T15:00:00.000Z", 3],
    ["2026-10-03T15:00:00.000Z", 3]
  ];
  for (const [at, expected] of cases) {
    assert.equal(getCycleWindow(start, end, new Date(at)).index, expected);
  }
  assert.equal(getCycleWindow(start, end, end), null);
});

test("pausing new purchases keeps readiness healthy for existing payments", () => {
  const paused = weeklyPlansReadiness({
    requested: true,
    database: { ok: true },
    paymentProcessingEnabled: true,
    webhookProcessingEnabled: true,
    purchasesEnabled: false
  });
  assert.equal(paused.ok, true);
  assert.equal(paused.details.weekly_plans, "purchases_paused");
  assert.equal(paused.details.weekly_plan_purchases, "paused");

  const unsafe = weeklyPlansReadiness({
    requested: true,
    database: { ok: true },
    paymentProcessingEnabled: true,
    webhookProcessingEnabled: false,
    purchasesEnabled: false
  });
  assert.equal(unsafe.ok, false);
  assert.equal(weeklyPlansOperationallyRequired({ requested: false, customers: {} }), false);
  assert.equal(weeklyPlansOperationallyRequired({
    requested: false,
    customers: {},
    persistedObligations: true
  }), true);
  assert.equal(weeklyPlansOperationallyRequired({
    requested: false,
    customers: { one: { plano_semanal_participante: true } }
  }), true);
  assert.equal(weeklyPlansOperationallyRequired({
    requested: false,
    customers: {
      one: {
        plano_semanal_pagamento_pendente: true,
        plano_semanal_pix_expira_em: "2026-09-05T15:30:00.000Z"
      }
    },
    now: new Date("2026-09-05T16:00:00.000Z")
  }), true);
  const pendingCustomer = {
    plano_semanal_pagamento_pendente: true,
    plano_semanal_pix_expira_em: "2026-09-05T15:30:00.000Z"
  };
  assert.equal(weeklyPlanPendingOperational(pendingCustomer, {
    now: new Date("2026-09-06T15:29:59.999Z")
  }), true);
  assert.equal(weeklyPlanPendingOperational(pendingCustomer, {
    now: new Date("2026-09-06T15:30:00.000Z")
  }), false);
  assert.equal(weeklyPlansOperationallyRequired({
    requested: false,
    customers: { one: pendingCustomer },
    now: new Date("2026-09-06T15:30:00.000Z")
  }), false);
});

test("provider amount mismatch never confirms a weekly plan", async () => {
  let providerStatus = null;
  let confirmed = false;
  const attempt = {
    id: "0123456789abcdef01234567",
    customerKey: "wpc_customer_123",
    expectedAmountCents: 2890,
    expectedCurrency: "BRL",
    externalReference: "omplan_0123456789abcdef01234567",
    orderId: "ORD-PLAN-1",
    paymentId: "PAY-1"
  };
  const repository = {
    async findPaymentAttempt() { return attempt; },
    async updateProviderStatus(value) { providerStatus = value; },
    async confirmPayment() { confirmed = true; }
  };
  const order = { id: "ORD-PLAN-1" };
  const provider = {
    async getOrder() { return order; },
    normalizeState() {
      return {
        orderId: "ORD-PLAN-1",
        paymentId: "PAY-1",
        orderStatus: "processed",
        paymentStatus: "processed",
        statusDetail: "accredited",
        totalAmount: 28.89,
        totalPaidAmount: 28.89,
        paymentAmount: 28.89,
        paymentPaidAmount: 28.89,
        paymentMethodId: "pix",
        paymentMethodType: "bank_transfer",
        currency: "BRL",
        externalReference: attempt.externalReference,
        approved: true,
        terminal: false,
        terminalStatus: ""
      };
    }
  };
  const service = createWeeklyPlansService({
    enabled: true,
    repository,
    provider,
    now: () => new Date("2026-09-05T15:00:00.000Z")
  });
  const result = await service.processProviderOrder({ orderId: "ORD-PLAN-1" });
  assert.equal(result.rejected, true);
  assert.equal(result.reason, "amount_mismatch");
  assert.equal(providerStatus.status, "divergent");
  assert.equal(confirmed, false);
});

test("requested amount cannot substitute the amount actually paid", async () => {
  let confirmed = false;
  let providerStatus = null;
  const attempt = {
    id: "7123456789abcdef01234567",
    customerKey: "wpc_customer_paid_amount",
    expectedAmountCents: 2890,
    expectedCurrency: "BRL",
    externalReference: "omplan_7123456789abcdef01234567",
    orderId: "ORD-PAID-AMOUNT",
    paymentId: "PAY-PAID-AMOUNT"
  };
  const repository = {
    async findPaymentAttempt() { return attempt; },
    async updateProviderStatus(value) { providerStatus = value; },
    async confirmPayment() { confirmed = true; }
  };
  const provider = {
    async getOrder() { return { id: attempt.orderId }; },
    normalizeState() {
      return {
        orderId: attempt.orderId,
        paymentId: attempt.paymentId,
        orderStatus: "processed",
        paymentStatus: "processed",
        statusDetail: "accredited",
        totalAmount: 28.90,
        totalPaidAmount: 0,
        paymentAmount: 28.90,
        paymentPaidAmount: 0,
        paymentMethodId: "pix",
        paymentMethodType: "bank_transfer",
        currency: "BRL",
        externalReference: attempt.externalReference,
        approved: true,
        reversed: false,
        terminal: false,
        terminalStatus: ""
      };
    }
  };
  const service = createWeeklyPlansService({ enabled: true, repository, provider });
  const result = await service.processProviderOrder({ orderId: attempt.orderId });
  assert.equal(result.rejected, true);
  assert.equal(result.reason, "amount_mismatch");
  assert.equal(providerStatus.status, "divergent");
  assert.equal(confirmed, false);
});

test("approved payment must be Pix bank transfer", async () => {
  let confirmed = false;
  const attempt = {
    id: "1123456789abcdef01234567",
    customerKey: "wpc_customer_123",
    expectedAmountCents: 2890,
    expectedCurrency: "BRL",
    externalReference: "omplan_1123456789abcdef01234567",
    orderId: "ORD-PLAN-2",
    paymentId: "PAY-2"
  };
  const repository = {
    async findPaymentAttempt() { return attempt; },
    async updateProviderStatus() {},
    async confirmPayment() { confirmed = true; }
  };
  const provider = {
    async getOrder() { return { id: "ORD-PLAN-2" }; },
    normalizeState() {
      return {
        orderId: "ORD-PLAN-2",
        paymentId: "PAY-2",
        orderStatus: "processed",
        paymentStatus: "processed",
        statusDetail: "accredited",
        totalAmount: 28.90,
        totalPaidAmount: 28.90,
        paymentAmount: 28.90,
        paymentPaidAmount: 28.90,
        paymentMethodId: "master",
        paymentMethodType: "credit_card",
        currency: "BRL",
        externalReference: attempt.externalReference,
        approved: true,
        reversed: false,
        terminal: false,
        terminalStatus: ""
      };
    }
  };
  const service = createWeeklyPlansService({ enabled: true, repository, provider });
  const result = await service.processProviderOrder({ orderId: attempt.orderId });
  assert.equal(result.rejected, true);
  assert.equal(result.reason, "payment_method_mismatch");
  assert.equal(confirmed, false);
});

test("summary reconciles a stale confirmed payment and revokes a refund", async () => {
  let revoked = false;
  let blockedOrders = [];
  const attempt = {
    id: "6123456789abcdef01234567",
    customerKey: "wpc_customer_reconcile",
    planCode: "semanal_2",
    expectedAmountCents: 2890,
    expectedCurrency: "BRL",
    externalReference: "omplan_6123456789abcdef01234567",
    orderId: "ORD-RECONCILE",
    paymentId: "PAY-RECONCILE",
    status: "confirmed"
  };
  const repository = {
    async findReconciliationAttempt() { return attempt; },
    async findPaymentAttempt() { return attempt; },
    async revokePayment() {
      revoked = true;
      return { replayed: false, orderIds: ["ORDER-TO-BLOCK"] };
    },
    async getEntitlement() { return { active: !revoked, nextSubscription: null }; }
  };
  const provider = {
    async getOrder() { return { id: attempt.orderId }; },
    normalizeState() {
      return {
        orderId: attempt.orderId,
        paymentId: attempt.paymentId,
        orderStatus: "processed",
        paymentStatus: "refunded",
        statusDetail: "refunded",
        totalAmount: 28.90,
        totalPaidAmount: 0,
        paymentAmount: 28.90,
        paymentPaidAmount: 0,
        paymentMethodId: "pix",
        paymentMethodType: "bank_transfer",
        currency: "BRL",
        externalReference: attempt.externalReference,
        approved: false,
        reversed: true,
        reversalStatus: "refunded",
        terminal: false,
        terminalStatus: ""
      };
    }
  };
  const service = createWeeklyPlansService({
    entitlementsEnabled: true,
    purchasesEnabled: false,
    paymentProcessingEnabled: true,
    repository,
    provider,
    async onPaymentReversed({ orderIds }) { blockedOrders = orderIds; },
    now: () => new Date("2026-09-05T15:10:00.000Z")
  });
  const result = await service.summary(attempt.customerKey);
  assert.equal(revoked, true);
  assert.deepEqual(blockedOrders, ["ORDER-TO-BLOCK"]);
  assert.equal(result.ativa, false);
});

test("ambiguous provider failure retries the same payment idempotency key", async () => {
  const attempt = {
    id: "2123456789abcdef01234567",
    customerKey: "wpc_customer_retry",
    planCode: "semanal_2",
    status: "creating",
    expectedAmountCents: 2890,
    expectedCurrency: "BRL",
    externalReference: "omplan_2123456789abcdef01234567",
    idempotencyKey: "omascote_weekly_plan_2123456789abcdef01234567",
    orderId: "",
    paymentId: "",
    createdAt: new Date("2026-09-05T15:00:00.000Z"),
    expiresAt: new Date("2026-09-05T15:30:00.000Z")
  };
  let providerCalls = 0;
  let searchCalls = 0;
  const providerStatuses = [];
  const keys = [];
  const repository = {
    async beginPaymentAttempt() { return { attempt, reused: providerCalls > 0 }; },
    async attachProviderOrder(value) {
      return { ...attempt, orderId: value.orderId, paymentId: value.paymentId, status: "pending" };
    },
    async updateProviderStatus({ status }) { providerStatuses.push(status); }
  };
  const provider = {
    async createOrder({ attempt: current }) {
      providerCalls += 1;
      keys.push(current.idempotencyKey);
      if (providerCalls === 1) {
        const error = new Error("resource locked");
        error.code = "MP_RESOURCE_LOCKED";
        error.retryable = true;
        throw error;
      }
      return { id: "ORD-RETRY" };
    },
    extractPix() {
      return {
        orderId: "ORD-RETRY",
        paymentId: "PAY-RETRY",
        copyPaste: "PIX-RETRY",
        qrCodeBase64: "",
        ticketUrl: ""
      };
    },
    async findOrderByExternalReference() {
      searchCalls += 1;
      return null;
    }
  };
  const service = createWeeklyPlansService({
    enabled: true,
    repository,
    provider,
    now: () => new Date("2026-09-05T15:00:00.000Z")
  });
  await assert.rejects(service.createPix({
    customerKey: attempt.customerKey,
    planCode: "semanal_2",
    clientRequestId: "buy-retry-request-0001"
  }), /resource locked/);
  const result = await service.createPix({
    customerKey: attempt.customerKey,
    planCode: "semanal_2",
    clientRequestId: "buy-retry-request-0001"
  });
  assert.equal(result.order_id, "ORD-RETRY");
  assert.equal(providerCalls, 2);
  assert.equal(searchCalls, 2);
  assert.equal(providerStatuses.includes("failed"), false);
  assert.equal(keys[0], keys[1]);
});

test("ambiguous 409 and a successful response without an id recover the same Order", async () => {
  for (const mode of ["idempotency_conflict", "missing_id"]) {
    const baseAttempt = {
      id: mode === "idempotency_conflict"
        ? "6123456789abcdef01234567"
        : "7123456789abcdef01234567",
      customerKey: `wpc_customer_${mode}`,
      planCode: "semanal_2",
      status: "creating",
      expectedAmountCents: 2890,
      expectedCurrency: "BRL",
      externalReference: "",
      idempotencyKey: `omascote_weekly_plan_${mode}`,
      orderId: "",
      paymentId: "",
      createdAt: new Date("2026-09-05T15:00:00.000Z"),
      expiresAt: new Date("2026-09-05T15:30:00.000Z")
    };
    baseAttempt.externalReference = `omplan_${baseAttempt.id}`;
    let currentAttempt = { ...baseAttempt };
    const statuses = [];
    const recoveredOrder = { id: `ORD-${mode}` };
    const repository = {
      async beginPaymentAttempt() { return { attempt: currentAttempt, reused: false }; },
      async findPaymentAttempt() { return currentAttempt; },
      async attachProviderOrder({ orderId, paymentId }) {
        currentAttempt = { ...currentAttempt, orderId, paymentId, status: "pending" };
        return currentAttempt;
      },
      async updateProviderStatus({ status }) { statuses.push(status); }
    };
    const provider = {
      async createOrder() {
        if (mode === "missing_id") return {};
        const error = new Error("idempotency key already used");
        error.code = "MP_IDEMPOTENCY_KEY_ALREADY_USED";
        error.retryable = true;
        throw error;
      },
      async findOrderByExternalReference() { return recoveredOrder; },
      extractPix(order) {
        return order?.id ? {
          orderId: order.id,
          paymentId: `PAY-${mode}`,
          copyPaste: `PIX-${mode}`,
          qrCodeBase64: "",
          ticketUrl: ""
        } : { orderId: "", paymentId: "", copyPaste: "" };
      },
      normalizeState() {
        return {
          orderId: recoveredOrder.id,
          paymentId: `PAY-${mode}`,
          orderStatus: "action_required",
          paymentStatus: "action_required",
          statusDetail: "waiting_transfer",
          totalAmount: 28.90,
          totalPaidAmount: 0,
          paymentAmount: 28.90,
          paymentPaidAmount: 0,
          paymentMethodId: "pix",
          paymentMethodType: "bank_transfer",
          currency: "BRL",
          externalReference: baseAttempt.externalReference,
          approved: false,
          reversed: false,
          terminal: false,
          terminalStatus: ""
        };
      }
    };
    const service = createWeeklyPlansService({
      enabled: true,
      repository,
      provider,
      now: () => new Date("2026-09-05T15:00:00.000Z")
    });
    const result = await service.createPix({
      customerKey: baseAttempt.customerKey,
      planCode: "semanal_2",
      clientRequestId: `buy-recovery-${mode}-0001`
    });
    assert.equal(result.order_id, recoveredOrder.id);
    assert.equal(result.pix_copia_cola, `PIX-${mode}`);
    assert.equal(statuses.includes("failed"), false);
  }
});

test("concurrent plan Pix requests keep one attempt, key and provider Order", async () => {
  const attempt = {
    id: "8123456789abcdef01234567",
    customerKey: "wpc_customer_concurrent",
    planCode: "semanal_2",
    status: "creating",
    expectedAmountCents: 2890,
    expectedCurrency: "BRL",
    externalReference: "omplan_8123456789abcdef01234567",
    idempotencyKey: "omascote_weekly_plan_8123456789abcdef01234567",
    orderId: "",
    paymentId: "",
    createdAt: new Date("2026-09-05T15:00:00.000Z"),
    expiresAt: new Date("2026-09-05T15:30:00.000Z")
  };
  const order = { id: "ORD-CONCURRENT" };
  let currentAttempt = { ...attempt };
  let createCalls = 0;
  const keys = [];
  const statuses = [];
  const repository = {
    async beginPaymentAttempt() { return { attempt: currentAttempt, reused: createCalls > 0 }; },
    async findPaymentAttempt() { return currentAttempt; },
    async attachProviderOrder({ orderId, paymentId }) {
      currentAttempt = { ...currentAttempt, orderId, paymentId, status: "pending" };
      return currentAttempt;
    },
    async updateProviderStatus({ status }) { statuses.push(status); }
  };
  const provider = {
    async createOrder({ attempt: current }) {
      createCalls += 1;
      keys.push(current.idempotencyKey);
      if (createCalls === 1) {
        await Promise.resolve();
        return order;
      }
      const error = new Error("resource locked");
      error.code = "MP_RESOURCE_LOCKED";
      error.retryable = true;
      throw error;
    },
    async getOrder() { return order; },
    async findOrderByExternalReference() { return order; },
    extractPix(value) {
      return value?.id ? {
        orderId: value.id,
        paymentId: "PAY-CONCURRENT",
        copyPaste: "PIX-CONCURRENT",
        qrCodeBase64: "",
        ticketUrl: ""
      } : { orderId: "", paymentId: "", copyPaste: "" };
    },
    normalizeState() {
      return {
        orderId: order.id,
        paymentId: "PAY-CONCURRENT",
        orderStatus: "action_required",
        paymentStatus: "action_required",
        statusDetail: "waiting_transfer",
        totalAmount: 28.90,
        totalPaidAmount: 0,
        paymentAmount: 28.90,
        paymentPaidAmount: 0,
        paymentMethodId: "pix",
        paymentMethodType: "bank_transfer",
        currency: "BRL",
        externalReference: attempt.externalReference,
        approved: false,
        reversed: false,
        terminal: false,
        terminalStatus: ""
      };
    }
  };
  const service = createWeeklyPlansService({
    enabled: true,
    repository,
    provider,
    now: () => new Date("2026-09-05T15:00:00.000Z")
  });
  const results = await Promise.all([1, 2].map(index => service.createPix({
    customerKey: attempt.customerKey,
    planCode: "semanal_2",
    clientRequestId: `buy-concurrent-request-${index}`
  })));
  assert.deepEqual(results.map(result => result.order_id), [order.id, order.id]);
  assert.equal(new Set(keys).size, 1);
  assert.equal(statuses.includes("failed"), false);
});

test("an old unlinked attempt never creates another provider Order", async () => {
  for (const searchMode of ["empty", "error"]) {
    const attempt = {
      id: searchMode === "empty"
        ? "9123456789abcdef01234567"
        : "a123456789abcdef01234567",
      customerKey: `wpc_customer_old_${searchMode}`,
      planCode: "semanal_2",
      status: "creating",
      expectedAmountCents: 2890,
      expectedCurrency: "BRL",
      externalReference: "",
      idempotencyKey: `omascote_weekly_plan_old_${searchMode}`,
      orderId: "",
      paymentId: "",
      createdAt: new Date("2026-09-04T13:00:00.000Z"),
      expiresAt: new Date("2026-09-04T13:30:00.000Z")
    };
    attempt.externalReference = `omplan_${attempt.id}`;
    let createCalls = 0;
    const repository = {
      async beginPaymentAttempt() { return { attempt, reused: true }; },
      async findPaymentAttempt() { return attempt; },
      async updateProviderStatus() {}
    };
    const provider = {
      async createOrder() { createCalls += 1; return { id: "MUST-NOT-HAPPEN" }; },
      async findOrderByExternalReference() {
        if (searchMode === "error") throw new Error("search unavailable");
        return null;
      },
      extractPix() { return { orderId: "", paymentId: "", copyPaste: "" }; }
    };
    const service = createWeeklyPlansService({
      enabled: true,
      repository,
      provider,
      now: () => new Date("2026-09-05T15:00:00.000Z")
    });
    await assert.rejects(
      service.createPix({
        customerKey: attempt.customerKey,
        planCode: "semanal_2",
        clientRequestId: `buy-old-${searchMode}-request-0001`
      }),
      error => [
        "WEEKLY_PLAN_PIX_MANUAL_REVIEW",
        "WEEKLY_PLAN_PIX_RECONCILIATION_PENDING"
      ].includes(error?.code)
    );
    assert.equal(createCalls, 0);
  }
});

test("payment status keeps an overdue Pix reconcilable while the provider says pending", async () => {
  let currentStatus = "pending";
  const attempt = {
    id: "3123456789abcdef01234567",
    customerKey: "wpc_customer_status",
    expectedAmountCents: 2890,
    expectedCurrency: "BRL",
    externalReference: "omplan_3123456789abcdef01234567",
    orderId: "ORD-STATUS",
    paymentId: "PAY-STATUS",
    status: "pending",
    expiresAt: new Date("2026-09-05T14:30:00.000Z")
  };
  const repository = {
    async getOwnedPaymentAttempt() { return { ...attempt, status: currentStatus }; },
    async findPaymentAttempt() { return { ...attempt, status: currentStatus }; },
    async updateProviderStatus({ status }) { currentStatus = status; }
  };
  const provider = {
    async getOrder() { return { id: "ORD-STATUS" }; },
    extractPix() { return { copyPaste: "", qrCodeBase64: "", ticketUrl: "" }; },
    normalizeState() {
      return {
        orderId: "ORD-STATUS",
        paymentId: "PAY-STATUS",
        orderStatus: "action_required",
        paymentStatus: "action_required",
        statusDetail: "waiting_transfer",
        totalAmount: 28.90,
        paymentAmount: 0,
        paymentMethodId: "",
        paymentMethodType: "",
        currency: "BRL",
        externalReference: attempt.externalReference,
        approved: false,
        reversed: false,
        terminal: false,
        terminalStatus: ""
      };
    }
  };
  const service = createWeeklyPlansService({
    enabled: true,
    repository,
    provider,
    now: () => new Date("2026-09-05T15:00:00.000Z")
  });
  const result = await service.paymentStatus({
    customerKey: attempt.customerKey,
    attemptId: attempt.id
  });
  assert.equal(result.status, "pending");
  assert.equal(result.expirado_localmente, true);
  assert.equal(result.confirmado, false);
});

test("an overdue Pix is cancelled authoritatively before another charge is allowed", async () => {
  let currentStatus = "pending";
  let providerOrderStatus = "action_required";
  let cancelKey = "";
  const attempt = {
    id: "4123456789abcdef01234567",
    customerKey: "wpc_customer_cancel",
    planCode: "semanal_2",
    expectedAmountCents: 2890,
    expectedCurrency: "BRL",
    externalReference: "omplan_4123456789abcdef01234567",
    orderId: "ORD-CANCEL",
    paymentId: "PAY-CANCEL",
    status: "pending",
    expiresAt: new Date("2026-09-05T14:30:00.000Z")
  };
  const repository = {
    async getOwnedPaymentAttempt() { return { ...attempt, status: currentStatus }; },
    async findPaymentAttempt() { return { ...attempt, status: currentStatus }; },
    async updateProviderStatus({ status }) { currentStatus = status; }
  };
  const provider = {
    async getOrder() { return { status: providerOrderStatus }; },
    async cancelOrder({ idempotencyKey }) {
      cancelKey = idempotencyKey;
      providerOrderStatus = "canceled";
      return { status: "canceled" };
    },
    extractPix() { return { copyPaste: "", qrCodeBase64: "", ticketUrl: "" }; },
    normalizeState() {
      const terminal = providerOrderStatus === "canceled";
      return {
        orderId: attempt.orderId,
        paymentId: attempt.paymentId,
        orderStatus: providerOrderStatus,
        paymentStatus: providerOrderStatus,
        statusDetail: terminal ? "canceled" : "waiting_transfer",
        totalAmount: 28.90,
        paymentAmount: 28.90,
        paymentMethodId: "pix",
        paymentMethodType: "bank_transfer",
        currency: "BRL",
        externalReference: attempt.externalReference,
        approved: false,
        reversed: false,
        terminal,
        terminalStatus: terminal ? "canceled" : ""
      };
    }
  };
  const service = createWeeklyPlansService({
    enabled: true,
    repository,
    provider,
    now: () => new Date("2026-09-05T15:00:00.000Z")
  });
  const result = await service.paymentStatus({
    customerKey: attempt.customerKey,
    attemptId: attempt.id
  });
  assert.equal(result.status, "cancelled");
  assert.equal(result.confirmado, false);
  assert.equal(cancelKey, `omascote_weekly_plan_cancel_${attempt.id}`);
});

test("fourth window does not promise a new quota without a renewal", () => {
  const start = new Date("2026-09-05T15:00:00.000Z");
  const end = cycleEndsAt(start);
  const summary = publicSummary({
    active: true,
    subscription: {
      id: "subscription-1",
      planCode: "semanal_2",
      planName: "2 imagens por semana",
      weeklyLimit: 2,
      cycleLimit: 8,
      startsAt: start,
      endsAt: end
    },
    nextSubscription: null,
    weeklyUsed: 0,
    weeklyAvailable: 2,
    cycleUsed: 6,
    cycleAvailable: 2,
    weekIndex: 3,
    weekStartsAt: new Date(start.getTime() + 21 * 24 * 60 * 60 * 1000),
    weekEndsAt: end
  });
  assert.equal(summary.proxima_liberacao_em, null);
});
