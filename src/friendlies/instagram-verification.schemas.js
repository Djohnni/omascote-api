"use strict";

const { RadarIdentityError } = require("./radar-identity.errors");
const {
  normalizeInstagramHandle,
  validateIdempotencyKey
} = require("./radar-identity.schemas");

const REJECTION_REASONS = new Set([
  "bio_code_missing",
  "instagram_mismatch",
  "account_not_controlled",
  "policy_violation",
  "other"
]);

function invalid(field, message) {
  throw new RadarIdentityError("VALIDATION_ERROR", 400, `${field}: ${message}`);
}

function objectWithOnly(input, fields) {
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    invalid("body", "dados invalidos");
  }
  for (const key of Object.keys(input)) {
    if (!fields.has(key)) invalid(key, "campo nao permitido");
  }
}

function verificationPublicId(value) {
  const normalized = String(value || "").trim().toLowerCase();
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(normalized)) {
    invalid("verification_id", "identificador invalido");
  }
  return normalized;
}

function verificationCode(value, field = "code") {
  const normalized = String(value || "").trim().toUpperCase();
  if (!/^MCFC-[A-HJ-NP-Z2-9]{4}-[A-HJ-NP-Z2-9]{4}$/.test(normalized)) {
    invalid(field, "codigo invalido");
  }
  return normalized;
}

function validateInitiateInput(input) {
  objectWithOnly(input, new Set(["instagram_handle"]));
  if (!Object.hasOwn(input, "instagram_handle")) invalid("instagram_handle", "campo obrigatorio");
  return Object.freeze({
    instagramHandle: normalizeInstagramHandle(input.instagram_handle).toLowerCase()
  });
}

function validateConfirmInput(input) {
  objectWithOnly(input, new Set(["verification_id", "code"]));
  return Object.freeze({
    verificationId: verificationPublicId(input.verification_id),
    code: verificationCode(input.code)
  });
}

function validateApproveInput(input) {
  objectWithOnly(input, new Set(["observed_code"]));
  return Object.freeze({ observedCode: verificationCode(input.observed_code, "observed_code") });
}

function validateRejectInput(input) {
  objectWithOnly(input, new Set(["reason_code", "notes"]));
  const reasonCode = String(input.reason_code || "").trim().toLowerCase();
  if (!REJECTION_REASONS.has(reasonCode)) invalid("reason_code", "motivo invalido");
  const notes = String(input.notes || "").replace(/\s+/g, " ").trim();
  if (notes.length > 500) invalid("notes", "use no maximo 500 caracteres");
  if (reasonCode === "other" && notes.length < 3) invalid("notes", "explique o motivo");
  return Object.freeze({ reasonCode, notes: notes || null });
}

function validateMutationHeaders({ idempotencyKey, requestId }) {
  const normalizedRequestId = String(requestId || "").trim();
  return Object.freeze({
    idempotencyKey: validateIdempotencyKey(idempotencyKey, { required: true }),
    requestId: /^[A-Za-z0-9._:-]{1,120}$/.test(normalizedRequestId)
      ? normalizedRequestId
      : null
  });
}

module.exports = {
  validateInitiateInput,
  validateConfirmInput,
  validateApproveInput,
  validateRejectInput,
  validateMutationHeaders,
  verificationPublicId,
  verificationCode,
  REJECTION_REASONS
};
