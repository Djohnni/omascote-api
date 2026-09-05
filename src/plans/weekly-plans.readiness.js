"use strict";

const { PAYMENT_PENDING_GRACE_MS } = require("./weekly-plans.catalog");

function weeklyPlanPendingOperational(customer, {
  now = new Date(),
  graceMs = PAYMENT_PENDING_GRACE_MS
} = {}) {
  if (!customer || customer.plano_semanal_pagamento_pendente !== true) return false;
  const expiresAt = new Date(customer.plano_semanal_pix_expira_em || "").getTime();
  const checkedAt = now instanceof Date ? now.getTime() : new Date(now).getTime();
  return Number.isFinite(expiresAt) &&
    Number.isFinite(checkedAt) &&
    expiresAt + Math.max(0, Number(graceMs) || 0) > checkedAt;
}

function weeklyPlansOperationallyRequired({
  requested,
  customers,
  persistedObligations = false,
  now = new Date()
}) {
  if (requested === true || persistedObligations === true) return true;
  if (!customers || typeof customers !== "object" || Array.isArray(customers)) return false;
  return Object.values(customers).some(customer =>
    customer &&
    typeof customer === "object" &&
    (
      customer.plano_semanal_participante === true ||
      weeklyPlanPendingOperational(customer, { now })
    )
  );
}

function weeklyPlansReadiness({
  requested,
  database,
  paymentProcessingEnabled,
  webhookProcessingEnabled,
  purchasesEnabled
}) {
  if (requested !== true) {
    return Object.freeze({ ok: true, details: { weekly_plans: "disabled" } });
  }

  const databaseReady = database?.ok === true;
  const canProtectExistingPayments = databaseReady &&
    paymentProcessingEnabled === true &&
    webhookProcessingEnabled === true;
  const purchaseStatus = purchasesEnabled === true
    ? "ready"
    : canProtectExistingPayments
      ? "paused"
      : "unavailable";

  return Object.freeze({
    ok: canProtectExistingPayments,
    database: databaseReady ? "ready" : database?.reason || "database_unavailable",
    details: Object.freeze({
      weekly_plans: canProtectExistingPayments
        ? (purchasesEnabled === true ? "ready" : "purchases_paused")
        : "not_configured",
      weekly_plan_database: databaseReady
        ? "ready"
        : database?.reason || "database_unavailable",
      weekly_plan_mercado_pago: paymentProcessingEnabled === true
        ? "configured"
        : "not_configured",
      weekly_plan_webhook: webhookProcessingEnabled === true
        ? "configured"
        : "not_configured",
      weekly_plan_purchases: purchaseStatus
    })
  });
}

module.exports = {
  weeklyPlanPendingOperational,
  weeklyPlansOperationallyRequired,
  weeklyPlansReadiness
};
