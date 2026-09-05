"use strict";

const crypto = require("crypto");
const {
  WEEKLY_PLANS,
  WEEKLY_PLAN_MAX_STANDARD_PRICE_CENTS,
  WEEKLY_PLAN_ELIGIBLE_PRODUCTS,
  DAY_MS,
  getPlan,
  publicPlan
} = require("./weekly-plans.catalog");

class WeeklyPlanError extends Error {
  constructor(code, status, message, { retryable = false } = {}) {
    super(message);
    this.name = "WeeklyPlanError";
    this.code = code;
    this.status = Number(status || 500);
    this.retryable = retryable === true;
  }
}

function cents(value) {
  const number = Number(value || 0);
  return Number.isFinite(number) ? Math.round(number * 100) : 0;
}

function iso(value) {
  if (!value) return null;
  const date = value instanceof Date ? value : new Date(value);
  return Number.isFinite(date.getTime()) ? date.toISOString() : null;
}

function publicSummary(entitlement) {
  if (!entitlement?.active) {
    const next = entitlement?.nextSubscription;
    return Object.freeze({
      ativa: false,
      plano: null,
      imagens_por_semana: 0,
      disponiveis_na_semana: 0,
      usadas_na_semana: 0,
      restantes_no_ciclo: 0,
      usadas_no_ciclo: 0,
      proxima_liberacao_em: null,
      vence_em: null,
      renovacao_automatica: false,
      proximo_plano: next ? Object.freeze({
        codigo: next.planCode,
        nome: next.planName,
        inicia_em: iso(next.startsAt),
        vence_em: iso(next.endsAt)
      }) : null
    });
  }

  const subscription = entitlement.subscription;
  const nextRelease = entitlement.weekIndex < 3
    ? entitlement.weekEndsAt
    : entitlement.nextSubscription?.startsAt || null;
  return Object.freeze({
    ativa: true,
    assinatura_id: subscription.id,
    plano: Object.freeze({
      codigo: subscription.planCode,
      nome: subscription.planName
    }),
    imagens_por_semana: subscription.weeklyLimit,
    disponiveis_na_semana: entitlement.weeklyAvailable,
    usadas_na_semana: entitlement.weeklyUsed,
    restantes_no_ciclo: entitlement.cycleAvailable,
    usadas_no_ciclo: entitlement.cycleUsed,
    semana_do_ciclo: entitlement.weekIndex + 1,
    proxima_liberacao_em: iso(nextRelease),
    inicia_em: iso(subscription.startsAt),
    vence_em: iso(subscription.endsAt),
    renovacao_automatica: false,
    proximo_plano: entitlement.nextSubscription ? Object.freeze({
      codigo: entitlement.nextSubscription.planCode,
      nome: entitlement.nextSubscription.planName,
      inicia_em: iso(entitlement.nextSubscription.startsAt),
      vence_em: iso(entitlement.nextSubscription.endsAt)
    }) : null
  });
}

function createWeeklyPlansService({
  enabled,
  entitlementsEnabled = enabled,
  purchasesEnabled = enabled,
  paymentProcessingEnabled = purchasesEnabled,
  repository,
  provider,
  onPaymentReversed = null,
  now = () => new Date(),
  randomBytes = crypto.randomBytes
}) {
  const canHonorEntitlements = entitlementsEnabled === true && Boolean(repository);
  const canProcessPayments = paymentProcessingEnabled === true &&
    canHonorEntitlements &&
    Boolean(provider);
  const canSellPlans = purchasesEnabled === true && canProcessPayments;

  function assertEntitlementsAvailable() {
    if (!canHonorEntitlements) {
      throw new WeeklyPlanError(
        "WEEKLY_PLAN_ENTITLEMENTS_UNAVAILABLE",
        503,
        "Nao foi possivel consultar sua cota agora. Tente novamente.",
        { retryable: true }
      );
    }
  }

  function assertPaymentProcessingAvailable() {
    if (!canProcessPayments) {
      throw new WeeklyPlanError(
        "WEEKLY_PLAN_PAYMENTS_UNAVAILABLE",
        503,
        "Os pagamentos de planos estao temporariamente indisponiveis.",
        { retryable: true }
      );
    }
  }

  function assertPurchasesAvailable() {
    if (!canSellPlans) {
      throw new WeeklyPlanError(
        "WEEKLY_PLAN_PURCHASES_DISABLED",
        404,
        "A compra de planos ainda nao esta disponivel."
      );
    }
  }

  function catalog() {
    return Object.freeze({
      disponivel: canSellPlans,
      compras_disponiveis: canSellPlans,
      ciclo_dias: 30,
      renovacao_automatica: false,
      pagamento: "pix",
      regras: Object.freeze({
        valor_maximo_por_arte_centavos: WEEKLY_PLAN_MAX_STANDARD_PRICE_CENTS,
        produtos_elegiveis: WEEKLY_PLAN_ELIGIBLE_PRODUCTS,
        adicionais_incluidos: false
      }),
      planos: canSellPlans ? Object.freeze(WEEKLY_PLANS.map(publicPlan)) : Object.freeze([])
    });
  }

  async function summary(customerKey) {
    assertEntitlementsAvailable();
    if (
      canProcessPayments &&
      typeof repository.findReconciliationAttempt === "function"
    ) {
      const checkedAt = now();
      try {
        const attempt = await repository.findReconciliationAttempt({
          customerKey,
          now: checkedAt,
          staleBefore: new Date(checkedAt.getTime() - 5 * 60 * 1000)
        });
        if (attempt?.orderId) {
          await processProviderOrder({
            orderId: attempt.orderId,
            expectedCustomerKey: customerKey,
            expectedAttemptId: attempt.id
          });
        }
      } catch {}
    }
    const entitlement = await repository.getEntitlement({
      customerKey,
      now: now()
    });
    return publicSummary(entitlement);
  }

  async function processProviderOrder({
    orderId,
    expectedCustomerKey = "",
    expectedAttemptId = "",
    prefetchedOrder = null,
    allowExpiredCancellation = true
  }) {
    assertPaymentProcessingAvailable();
    const order = prefetchedOrder || await provider.getOrder(orderId);
    const state = provider.normalizeState(order);
    const attempt = await repository.findPaymentAttempt({
      orderId: state.orderId || orderId,
      externalReference: state.externalReference,
      attemptId: expectedAttemptId
    });
    if (!attempt) return Object.freeze({ handled: false, prefetchedOrder: order });
    if (expectedCustomerKey && attempt.customerKey !== expectedCustomerKey) {
      throw new WeeklyPlanError("WEEKLY_PLAN_OWNER_MISMATCH", 403, "Pagamento nao pertence a esta conta.");
    }
    if (expectedAttemptId && attempt.id !== expectedAttemptId) {
      throw new WeeklyPlanError("WEEKLY_PLAN_ATTEMPT_MISMATCH", 409, "Tentativa de pagamento divergente.");
    }

    const identityOk =
      state.orderId === String(orderId) &&
      (!attempt.orderId || attempt.orderId === state.orderId) &&
      attempt.externalReference === state.externalReference;
    const requiresSettledPaymentValidation = state.approved || state.reversed;
    const amountOk =
      attempt.expectedAmountCents > 0 &&
      cents(state.totalAmount) === attempt.expectedAmountCents &&
      (!requiresSettledPaymentValidation ||
        (
          cents(state.paymentAmount) === attempt.expectedAmountCents &&
          (
            state.reversed ||
            (
              cents(state.totalPaidAmount) === attempt.expectedAmountCents &&
              cents(state.paymentPaidAmount) === attempt.expectedAmountCents
            )
          )
        ));
    const currencyOk = attempt.expectedCurrency === "BRL" && state.currency === "BRL";
    const paymentOk = !requiresSettledPaymentValidation || (
      Boolean(state.paymentId) &&
      (!attempt.paymentId || attempt.paymentId === state.paymentId)
    );
    const paymentMethodOk = !requiresSettledPaymentValidation || (
      state.paymentMethodId === "pix" &&
      state.paymentMethodType === "bank_transfer"
    );
    const checkedAt = now();
    const expiresAtMs = new Date(attempt.expiresAt || "").getTime();
    const locallyExpired = !state.approved &&
      !state.reversed &&
      Number.isFinite(expiresAtMs) &&
      expiresAtMs <= checkedAt.getTime();

    if (!identityOk || !amountOk || !currencyOk || !paymentOk || !paymentMethodOk) {
      await repository.updateProviderStatus({
        attemptId: attempt.id,
        status: "divergent",
        state,
        now: checkedAt
      });
      return Object.freeze({
        handled: true,
        attemptId: attempt.id,
        customerKey: attempt.customerKey,
        confirmed: false,
        rejected: true,
        reason: !identityOk
          ? "identity_mismatch"
          : !amountOk
            ? "amount_mismatch"
            : !currencyOk
              ? "currency_mismatch"
              : !paymentOk
                ? "payment_mismatch"
                : "payment_method_mismatch"
      });
    }

    if (state.reversed) {
      const reversalStatus = state.reversalStatus === "charged_back"
        ? "charged_back"
        : "refunded";
      const revoked = await repository.revokePayment({
        attemptId: attempt.id,
        state,
        reason: reversalStatus,
        now: checkedAt
      });
      if (typeof onPaymentReversed === "function" && revoked.orderIds?.length) {
        await onPaymentReversed({
          customerKey: attempt.customerKey,
          attemptId: attempt.id,
          subscription: revoked.subscription,
          orderIds: revoked.orderIds,
          reason: reversalStatus,
          at: checkedAt
        });
      }
      return Object.freeze({
        handled: true,
        attemptId: attempt.id,
        customerKey: attempt.customerKey,
        confirmed: false,
        reversed: true,
        status: reversalStatus,
        replayed: revoked.replayed,
        revokedOrderIds: revoked.orderIds || Object.freeze([])
      });
    }

    if (state.terminal) {
      await repository.updateProviderStatus({
        attemptId: attempt.id,
        status: state.terminalStatus === "expired" ? "expired" : "cancelled",
        state,
        now: checkedAt
      });
      return Object.freeze({
        handled: true,
        attemptId: attempt.id,
        customerKey: attempt.customerKey,
        confirmed: false,
        terminal: true,
        status: state.terminalStatus
      });
    }

    if (
      locallyExpired &&
      allowExpiredCancellation &&
      ["action_required", "created"].includes(state.orderStatus) &&
      typeof provider.cancelOrder === "function"
    ) {
      const cancelledOrder = await provider.cancelOrder({
        orderId: attempt.orderId || state.orderId,
        idempotencyKey: `omascote_weekly_plan_cancel_${attempt.id}`
      });
      return processProviderOrder({
        orderId: attempt.orderId || state.orderId,
        expectedCustomerKey,
        expectedAttemptId: attempt.id,
        prefetchedOrder: cancelledOrder,
        allowExpiredCancellation: false
      });
    }

    if (!state.approved) {
      await repository.updateProviderStatus({
        attemptId: attempt.id,
        status: "pending",
        state,
        now: checkedAt
      });
      return Object.freeze({
        handled: true,
        attemptId: attempt.id,
        customerKey: attempt.customerKey,
        confirmed: false,
        pending: true,
        expiredLocally: locallyExpired
      });
    }

    const confirmed = await repository.confirmPayment({
      attemptId: attempt.id,
      state,
      now: checkedAt
    });
    if (confirmed.blocked) {
      return Object.freeze({
        handled: true,
        attemptId: attempt.id,
        customerKey: attempt.customerKey,
        confirmed: false,
        reversed: true,
        status: confirmed.status || "refunded",
        replayed: true
      });
    }
    return Object.freeze({
      handled: true,
      attemptId: attempt.id,
      customerKey: attempt.customerKey,
      confirmed: true,
      replayed: confirmed.replayed,
      subscription: confirmed.subscription
    });
  }

  async function recoverAmbiguousProviderOrder(attempt, { strict = false } = {}) {
    let currentAttempt = attempt;
    if (typeof repository.findPaymentAttempt === "function") {
      try {
        currentAttempt = await repository.findPaymentAttempt({ attemptId: attempt.id }) || attempt;
      } catch (error) {
        if (strict) throw error;
      }
    }
    if (currentAttempt.orderId) {
      try {
        return Object.freeze({
          attempt: currentAttempt,
          order: await provider.getOrder(currentAttempt.orderId)
        });
      } catch (error) {
        if (strict) throw error;
      }
    }
    if (typeof provider.findOrderByExternalReference !== "function") return null;
    try {
      const order = await provider.findOrderByExternalReference({ attempt: currentAttempt });
      return order ? Object.freeze({ attempt: currentAttempt, order }) : null;
    } catch (error) {
      if (strict) throw error;
      return null;
    }
  }

  async function createPix({ customerKey, planCode, clientRequestId }) {
    assertPurchasesAvailable();
    const plan = getPlan(planCode);
    if (!plan) throw new WeeklyPlanError("WEEKLY_PLAN_INVALID", 400, "Plano invalido.");
    const requestId = String(clientRequestId || "").trim();
    if (requestId.length < 12 || requestId.length > 180) {
      throw new WeeklyPlanError(
        "WEEKLY_PLAN_IDEMPOTENCY_REQUIRED",
        400,
        "Identificador seguro da compra ausente. Tente novamente."
      );
    }
    const createdAt = now();
    const attemptId = randomBytes(12).toString("hex");
    const externalReference = `omplan_${attemptId}`;
    let started;
    try {
      started = await repository.beginPaymentAttempt({
        customerKey,
        plan,
        attemptId,
        externalReference,
        idempotencyKey: `omascote_weekly_plan_${attemptId}`,
        clientRequestId: requestId,
        now: createdAt,
        expiresAt: new Date(createdAt.getTime() + 30 * 60 * 1000)
      });
    } catch (error) {
      if (error?.code === "WEEKLY_PLAN_CLIENT_IDEMPOTENCY_CONFLICT") {
        throw new WeeklyPlanError(
          "WEEKLY_PLAN_CLIENT_IDEMPOTENCY_CONFLICT",
          409,
          "Esta compra ja foi usada para outro plano."
        );
      }
      if (error?.code === "WEEKLY_PLAN_RENEWAL_ALREADY_SCHEDULED") {
        throw new WeeklyPlanError(
          "WEEKLY_PLAN_RENEWAL_ALREADY_SCHEDULED",
          409,
          "Voce ja tem uma renovacao agendada."
        );
      }
      throw error;
    }
    let attempt = started.attempt;
    let order;
    let recoveredAmbiguousCreation = false;
    const terminalStatuses = new Set([
      "confirmed", "expired", "cancelled", "rejected",
      "divergent", "failed", "refunded", "charged_back"
    ]);

    if (!attempt.orderId && terminalStatuses.has(attempt.status)) {
      throw new WeeklyPlanError(
        attempt.status === "confirmed"
          ? "WEEKLY_PLAN_ALREADY_PAID"
          : "WEEKLY_PLAN_PIX_EXPIRED",
        409,
        attempt.status === "confirmed"
          ? "Este PIX ja foi confirmado."
          : "Este PIX nao pode mais ser usado. Gere uma nova chave PIX."
      );
    }

    if (attempt.orderId) {
      order = await provider.getOrder(attempt.orderId);
      const processed = await processProviderOrder({
        orderId: attempt.orderId,
        expectedCustomerKey: customerKey,
        expectedAttemptId: attempt.id,
        prefetchedOrder: order
      });
      if (processed.confirmed) {
        throw new WeeklyPlanError("WEEKLY_PLAN_ALREADY_PAID", 409, "Este PIX ja foi confirmado.");
      }
      if (processed.terminal || processed.rejected || processed.reversed) {
        throw new WeeklyPlanError(
          "WEEKLY_PLAN_PIX_EXPIRED",
          409,
          "Este PIX nao pode mais ser usado. Gere uma nova chave PIX."
        );
      }
      if (processed.pending && processed.expiredLocally) {
        throw new WeeklyPlanError(
          "WEEKLY_PLAN_PIX_CONFIRMATION_PENDING",
          409,
          "O PIX anterior ainda esta sendo confirmado. Aguarde antes de gerar outro."
        );
      }
      if (attempt.planCode !== plan.code) {
        throw new WeeklyPlanError(
          "WEEKLY_PLAN_OTHER_PIX_PENDING",
          409,
          "Ja existe um Pix pendente para outro plano."
        );
      }
    } else if (attempt.planCode !== plan.code) {
      throw new WeeklyPlanError(
        "WEEKLY_PLAN_OTHER_PIX_PENDING",
        409,
        "Ja existe um Pix pendente para outro plano."
      );
    } else {
      if (started.reused === true) {
        let recovered;
        try {
          recovered = await recoverAmbiguousProviderOrder(attempt, { strict: true });
        } catch {
          throw new WeeklyPlanError(
            "WEEKLY_PLAN_PIX_RECONCILIATION_PENDING",
            503,
            "Ainda estamos conferindo seu PIX anterior. Tente novamente.",
            { retryable: true }
          );
        }
        if (recovered) {
          attempt = recovered.attempt;
          order = recovered.order;
          recoveredAmbiguousCreation = true;
        } else {
          const createdAtMs = new Date(attempt.createdAt || "").getTime();
          const retryAgeMs = Number.isFinite(createdAtMs)
            ? createdAt.getTime() - createdAtMs
            : Number.POSITIVE_INFINITY;
          if (retryAgeMs >= 23 * 60 * 60 * 1000) {
            throw new WeeklyPlanError(
              "WEEKLY_PLAN_PIX_MANUAL_REVIEW",
              503,
              "Seu PIX anterior precisa ser conferido antes de gerar outro.",
              { retryable: true }
            );
          }
        }
      }
      if (!order) {
        try {
          order = await provider.createOrder({ attempt, plan });
        } catch (error) {
          const recovered = error?.retryable === true
            ? await recoverAmbiguousProviderOrder(attempt)
            : null;
          if (recovered) {
            attempt = recovered.attempt;
            order = recovered.order;
            recoveredAmbiguousCreation = true;
          } else if (error?.retryable !== true) {
            await repository.updateProviderStatus({
              attemptId: attempt.id,
              status: "failed",
              state: {
                orderId: "",
                paymentId: "",
                orderStatus: "",
                paymentStatus: "",
                statusDetail: error?.code || "provider_create_failed"
              },
              now: now()
            });
          }
          if (!recovered) throw error;
        }
      }
      let pixCreated = provider.extractPix(order);
      if (!pixCreated.orderId) {
        const recovered = await recoverAmbiguousProviderOrder(attempt);
        if (recovered) {
          attempt = recovered.attempt;
          order = recovered.order;
          pixCreated = provider.extractPix(order);
          recoveredAmbiguousCreation = true;
        }
      }
      if (!pixCreated.orderId) {
        throw new WeeklyPlanError(
          "WEEKLY_PLAN_PIX_CONFIRMATION_PENDING",
          503,
          "O Mercado Pago ainda esta confirmando o PIX. Tente novamente.",
          { retryable: true }
        );
      }
      attempt = await repository.attachProviderOrder({
        attemptId: attempt.id,
        orderId: pixCreated.orderId,
        paymentId: pixCreated.paymentId,
        now: now()
      });
      if (recoveredAmbiguousCreation) {
        const processed = await processProviderOrder({
          orderId: pixCreated.orderId,
          expectedCustomerKey: customerKey,
          expectedAttemptId: attempt.id,
          prefetchedOrder: order
        });
        if (processed.confirmed) {
          throw new WeeklyPlanError("WEEKLY_PLAN_ALREADY_PAID", 409, "Este PIX ja foi confirmado.");
        }
        if (processed.terminal || processed.rejected || processed.reversed) {
          throw new WeeklyPlanError(
            "WEEKLY_PLAN_PIX_INVALID",
            409,
            "Este PIX nao pode ser usado. Tente novamente mais tarde."
          );
        }
        if (processed.pending && processed.expiredLocally) {
          throw new WeeklyPlanError(
            "WEEKLY_PLAN_PIX_CONFIRMATION_PENDING",
            409,
            "O PIX anterior ainda esta sendo confirmado. Aguarde antes de gerar outro."
          );
        }
      }
    }

    const pix = provider.extractPix(order);
    if (!pix.copyPaste) {
      throw new WeeklyPlanError(
        "WEEKLY_PLAN_PIX_NOT_READY",
        503,
        "O codigo PIX ainda nao ficou disponivel. Tente novamente.",
        { retryable: true }
      );
    }
    return Object.freeze({
      tentativa_id: attempt.id,
      plano: publicPlan(plan),
      pix_copia_cola: pix.copyPaste,
      qr_code_base64: pix.qrCodeBase64,
      ticket_url: pix.ticketUrl,
      order_id: pix.orderId,
      payment_id: pix.paymentId,
      reutilizado: started.reused === true,
      expira_em: iso(attempt.expiresAt)
    });
  }

  async function paymentStatus({ customerKey, attemptId }) {
    assertPaymentProcessingAvailable();
    let attempt = await repository.getOwnedPaymentAttempt({ customerKey, attemptId });
    if (!attempt) throw new WeeklyPlanError("WEEKLY_PLAN_PAYMENT_NOT_FOUND", 404, "Pagamento nao encontrado.");
    let providerOrder = null;
    if (!attempt.orderId && attempt.status === "creating") {
      const recovered = await recoverAmbiguousProviderOrder(attempt);
      const pixRecovered = recovered?.order ? provider.extractPix(recovered.order) : null;
      if (pixRecovered?.orderId) {
        attempt = await repository.attachProviderOrder({
          attemptId: attempt.id,
          orderId: pixRecovered.orderId,
          paymentId: pixRecovered.paymentId,
          now: now()
        });
        providerOrder = recovered.order;
      }
    }
    if (attempt.orderId && ![
      "expired", "cancelled", "rejected", "divergent",
      "failed", "refunded", "charged_back"
    ].includes(attempt.status)) {
      providerOrder = providerOrder || await provider.getOrder(attempt.orderId);
      await processProviderOrder({
        orderId: attempt.orderId,
        expectedCustomerKey: customerKey,
        expectedAttemptId: attempt.id,
        prefetchedOrder: providerOrder
      });
      attempt = await repository.getOwnedPaymentAttempt({ customerKey, attemptId });
    }
    const confirmed = attempt?.status === "confirmed";
    const open = ["creating", "pending"].includes(attempt?.status);
    const expiresAtMs = new Date(attempt?.expiresAt || "").getTime();
    const expiredLocally = open && Number.isFinite(expiresAtMs) && expiresAtMs <= now().getTime();
    const pix = open && providerOrder ? provider.extractPix(providerOrder) : null;
    return Object.freeze({
      tentativa_id: attempt.id,
      status: attempt.status,
      confirmado: confirmed,
      expirado_localmente: expiredLocally,
      plano: publicPlan(getPlan(attempt.planCode)),
      expira_em: iso(attempt.expiresAt),
      ...(pix?.copyPaste ? {
        pix_copia_cola: pix.copyPaste,
        qr_code_base64: pix.qrCodeBase64,
        ticket_url: pix.ticketUrl,
        order_id: pix.orderId,
        payment_id: pix.paymentId
      } : {}),
      plano_semanal: confirmed ? await summary(customerKey) : null
    });
  }

  async function reserve({ customerKey, orderId, clientRequestId, payloadHash, productId }) {
    assertEntitlementsAvailable();
    const requestId = String(clientRequestId || "").trim();
    const hash = String(payloadHash || "").trim().toLowerCase();
    if (requestId.length < 12 || requestId.length > 180 || !/^[0-9a-f]{64}$/.test(hash)) {
      throw new WeeklyPlanError(
        "WEEKLY_PLAN_USAGE_IDEMPOTENCY_REQUIRED",
        400,
        "Nao foi possivel validar esta solicitacao. Tente novamente."
      );
    }
    try {
      return await repository.reserveUsage({
        customerKey,
        orderId,
        clientRequestId: requestId,
        payloadHash: hash,
        productId,
        now: now()
      });
    } catch (error) {
      if (error?.code === "WEEKLY_PLAN_USAGE_IDEMPOTENCY_CONFLICT") {
        throw new WeeklyPlanError(
          "WEEKLY_PLAN_USAGE_IDEMPOTENCY_CONFLICT",
          409,
          "Esta solicitacao ja foi usada com outro conteudo."
        );
      }
      throw error;
    }
  }

  async function release({ customerKey, orderId, reason }) {
    assertEntitlementsAvailable();
    return repository.releaseUsage({ customerKey, orderId, reason, now: now() });
  }

  async function authorizeOrderUsage({ orderId }) {
    assertEntitlementsAvailable();
    return repository.getUsageAuthorization({ orderId: String(orderId || "") });
  }

  async function authorizeOrderUsages({ orderIds }) {
    assertEntitlementsAvailable();
    const ids = [...new Set((Array.isArray(orderIds) ? orderIds : [])
      .map(value => String(value || "").trim())
      .filter(Boolean))];
    const authorizations = await repository.getUsageAuthorizations({ orderIds: ids });
    return new Map(authorizations.map(item => [String(item.orderId), item]));
  }

  async function customerOperationalState({ customerKey }) {
    assertEntitlementsAvailable();
    return repository.getCustomerOperationalState({ customerKey, now: now() });
  }

  return Object.freeze({
    enabled: canSellPlans,
    purchasesEnabled: canSellPlans,
    paymentProcessingEnabled: canProcessPayments,
    entitlementsEnabled: canHonorEntitlements,
    catalog,
    summary,
    createPix,
    paymentStatus,
    processProviderOrder,
    reserve,
    release,
    authorizeOrderUsage,
    authorizeOrderUsages,
    customerOperationalState
  });
}

module.exports = {
  WeeklyPlanError,
  createWeeklyPlansService,
  publicSummary,
  cents,
  iso,
  DAY_MS
};
