"use strict";

const CYCLE_DAYS = 30;
const PAYMENT_REVERSAL_RECONCILIATION_DAYS = 180;
const WEEKLY_PLAN_MAX_STANDARD_PRICE_CENTS = 800;
const WEEKLY_PLAN_ELIGIBLE_PRODUCTS = Object.freeze([
  "resultado",
  "escalacao",
  "contratacao",
  "proximo_jogo",
  "patrocinador",
  "escudo3d",
  "proximo_jogo_jogador",
  "resultado_jogo_jogador",
  "jogador_escudo"
]);
const WEEKLY_PLAN_ELIGIBLE_PRODUCT_SET = new Set(WEEKLY_PLAN_ELIGIBLE_PRODUCTS);
const CYCLE_WINDOWS = Object.freeze([
  Object.freeze({ index: 0, startDay: 0, endDay: 7 }),
  Object.freeze({ index: 1, startDay: 7, endDay: 14 }),
  Object.freeze({ index: 2, startDay: 14, endDay: 21 }),
  Object.freeze({ index: 3, startDay: 21, endDay: 30 })
]);

const WEEKLY_PLANS = Object.freeze([
  Object.freeze({ code: "semanal_1", name: "1 imagem por semana", weeklyLimit: 1, cycleLimit: 4, priceCents: 1890 }),
  Object.freeze({ code: "semanal_2", name: "2 imagens por semana", weeklyLimit: 2, cycleLimit: 8, priceCents: 2890 })
]);

const PLAN_BY_CODE = new Map(WEEKLY_PLANS.map(plan => [plan.code, plan]));
const DAY_MS = 24 * 60 * 60 * 1000;
const PAYMENT_PENDING_GRACE_MS = DAY_MS;

function getPlan(code) {
  return PLAN_BY_CODE.get(String(code || "").trim().toLowerCase()) || null;
}

function isWeeklyPlanEligibleProduct(productId, {
  hasPaidAddon = false,
  priceCents = null
} = {}) {
  const normalizedProductId = String(productId || "").trim().toLowerCase();
  if (!WEEKLY_PLAN_ELIGIBLE_PRODUCT_SET.has(normalizedProductId) || hasPaidAddon === true) {
    return false;
  }
  if (priceCents === null || priceCents === undefined) return true;
  const normalizedPriceCents = Number(priceCents);
  return Number.isFinite(normalizedPriceCents) &&
    normalizedPriceCents > 0 &&
    normalizedPriceCents <= WEEKLY_PLAN_MAX_STANDARD_PRICE_CENTS;
}

function publicPlan(plan) {
  if (!plan) return null;
  return Object.freeze({
    codigo: plan.code,
    nome: plan.name,
    imagens_por_semana: plan.weeklyLimit,
    imagens_no_ciclo: plan.cycleLimit,
    valor_centavos: plan.priceCents,
    valor: Number((plan.priceCents / 100).toFixed(2)),
    ciclo_dias: CYCLE_DAYS,
    renovacao_automatica: false,
    pagamento: "pix"
  });
}

function asDate(value, label) {
  const date = value instanceof Date ? new Date(value.getTime()) : new Date(value);
  if (!Number.isFinite(date.getTime())) throw new TypeError(`${label || "date"} is invalid`);
  return date;
}

function addDays(value, days) {
  return new Date(asDate(value, "start").getTime() + Number(days) * DAY_MS);
}

function getCycleWindow(startsAt, endsAt, at = new Date()) {
  const start = asDate(startsAt, "startsAt");
  const end = asDate(endsAt, "endsAt");
  const now = asDate(at, "at");
  if (now < start || now >= end) return null;

  const elapsedDays = (now.getTime() - start.getTime()) / DAY_MS;
  const definition = CYCLE_WINDOWS.find(window =>
    elapsedDays >= window.startDay && elapsedDays < window.endDay
  );
  if (!definition) return null;

  const windowStart = addDays(start, definition.startDay);
  const configuredEnd = addDays(start, definition.endDay);
  const windowEnd = configuredEnd < end ? configuredEnd : end;

  return Object.freeze({
    index: definition.index,
    startsAt: windowStart,
    endsAt: windowEnd
  });
}

function cycleEndsAt(startsAt) {
  return addDays(startsAt, CYCLE_DAYS);
}

module.exports = {
  CYCLE_DAYS,
  PAYMENT_REVERSAL_RECONCILIATION_DAYS,
  WEEKLY_PLAN_MAX_STANDARD_PRICE_CENTS,
  WEEKLY_PLAN_ELIGIBLE_PRODUCTS,
  CYCLE_WINDOWS,
  WEEKLY_PLANS,
  DAY_MS,
  PAYMENT_PENDING_GRACE_MS,
  getPlan,
  isWeeklyPlanEligibleProduct,
  publicPlan,
  addDays,
  getCycleWindow,
  cycleEndsAt
};
