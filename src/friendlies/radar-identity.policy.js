"use strict";

const crypto = require("node:crypto");
const { RadarIdentityError } = require("./radar-identity.errors");

function accountReference(account, authSubject) {
  const candidate = String(account?.cliente_id || account?.id || "").trim();
  const candidateDigits = candidate.replace(/\D/g, "");
  const subjectDigits = String(authSubject || "").replace(/\D/g, "");
  if (candidate && (!candidateDigits || candidateDigits !== subjectDigits)) return candidate;

  return `legacy_${crypto
    .createHash("sha256")
    .update(`omascote-radar-account:${authSubject}`)
    .digest("hex")}`;
}

function createLegacyRadarIdentityResolver({ getAccountRecord, ensureLegacyProfile }) {
  if (typeof getAccountRecord !== "function" || typeof ensureLegacyProfile !== "function") {
    throw new TypeError("Radar identity resolver dependencies are required");
  }

  return function resolveRadarIdentity(authUser) {
    const authSubject = String(authUser?.whatsapp || "").trim();
    if (!authSubject) {
      throw new RadarIdentityError("SESSION_INVALID", 401, "Sessao invalida.");
    }

    const account = getAccountRecord(authSubject);
    if (!account) {
      throw new RadarIdentityError("ACCOUNT_NOT_FOUND", 401, "Conta nao encontrada.");
    }
    if (account.ativo !== true) {
      throw new RadarIdentityError("ACCOUNT_INACTIVE", 403, "Conta inativa.");
    }
    if (
      account.suspenso === true ||
      account.radar_suspenso === true ||
      String(account.status || "").toLowerCase() === "suspended"
    ) {
      throw new RadarIdentityError("ACCOUNT_SUSPENDED", 403, "Conta suspensa.");
    }

    const profileInfo = ensureLegacyProfile(authSubject);
    const profileId = String(profileInfo?.perfil_id || "").trim();
    if (!profileId) {
      throw new RadarIdentityError("PROFILE_NOT_FOUND", 409, "Perfil do time indisponivel.");
    }

    const accountId = accountReference(account, authSubject);
    if (!accountId) {
      throw new RadarIdentityError("ACCOUNT_ID_MISSING", 409, "Identidade da conta indisponivel.");
    }

    return Object.freeze({
      authSubject,
      accountId,
      profileId,
      accountActive: true,
      legacyProfile: Object.freeze({ ...(profileInfo.perfil || {}) })
    });
  };
}

function createPilotGatedRadarIdentityResolver({ resolveIdentity, config }) {
  if (typeof resolveIdentity !== "function") {
    throw new TypeError("Radar identity resolver is required");
  }

  const allowed = new Set(config?.pilotAccountAllowlist || []);
  return function resolvePilotRadarIdentity(authUser) {
    const identity = resolveIdentity(authUser);
    if (config?.enabled === true && allowed.size === 0) {
      throw new RadarIdentityError(
        "RADAR_PILOT_CONFIGURATION_UNAVAILABLE",
        503,
        "O piloto do Radar esta temporariamente indisponivel."
      );
    }
    if (allowed.size > 0 && !allowed.has(String(identity.accountId || ""))) {
      throw new RadarIdentityError(
        "RADAR_PILOT_ACCESS_DENIED",
        403,
        "Esta conta nao participa do piloto do Radar."
      );
    }
    return identity;
  };
}

function assertRadarTeamOwnedByIdentity(team, identity, { allowUnclaimed = false } = {}) {
  if (!team || !identity) {
    throw new RadarIdentityError("RADAR_PROFILE_NOT_FOUND", 404, "Perfil do Radar nao encontrado.");
  }

  if (String(team.legacyProfileId || "") !== String(identity.profileId || "")) {
    throw new RadarIdentityError("RADAR_PROFILE_FORBIDDEN", 403, "Acesso negado ao perfil do Radar.");
  }

  const ownerReference = String(team.accountReference || "").trim();
  if (!ownerReference && allowUnclaimed) return;
  if (!ownerReference || ownerReference !== String(identity.accountId || "").trim()) {
    throw new RadarIdentityError("RADAR_PROFILE_FORBIDDEN", 403, "Acesso negado ao perfil do Radar.");
  }
}

function assertRadarTeamCanMutate(team) {
  if (team?.departedAt) {
    throw new RadarIdentityError("RADAR_PROFILE_DEPARTED", 403, "Este time saiu do Radar.");
  }
  if (
    String(team?.status || "").toLowerCase() === "suspended" ||
    Boolean(team?.suspendedAt)
  ) {
    throw new RadarIdentityError("RADAR_PROFILE_SUSPENDED", 403, "Perfil do Radar suspenso.");
  }
}

module.exports = {
  createLegacyRadarIdentityResolver,
  createPilotGatedRadarIdentityResolver,
  accountReference,
  assertRadarTeamOwnedByIdentity,
  assertRadarTeamCanMutate
};
