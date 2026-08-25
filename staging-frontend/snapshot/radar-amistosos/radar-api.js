(function () {
  "use strict";

  const ENDPOINTS = Object.freeze({
    radarProfile: "/me/time/radar",
    eligibility: "/me/time/radar/elegibilidade",
    importPrint: "/me/time/perfil/importar-print",
    verification: "/me/time/verificacao",
    startInstagramVerification: "/me/time/verificacoes/instagram",
    confirmInstagramVerification: "/me/time/verificacoes/instagram/confirmar",
    availabilities: "/me/time/amistosos/disponibilidades",
    nearbyTeams: "/amistosos/times-proximos",
    invitations: "/amistosos/convites",
    teamInvitations: "/me/time/amistosos/convites",
    matches: "/me/time/amistosos",
    matchHistory: "/me/time/amistosos/historico",
    pendingEvaluations: "/me/time/avaliacoes/pendentes",
    ownReputation: "/me/time/reputacao",
    publicTeamReputation: "/radar/times",
    radarBlocks: "/me/time/radar/bloqueios",
    radarReports: "/me/time/radar/denuncias",
    radarExit: "/me/time/radar/exclusao",
    moderationQueue: "/admin/radar/moderacao",
    notifications: "/me/notificacoes"
  });

  const ERROR_MESSAGES = Object.freeze({
    401: "Sua sessão expirou. Entre novamente para continuar.",
    403: "Sua conta não tem acesso a esta ação.",
    409: "Esta alteração conflita com uma atualização recente.",
    412: "Os dados mudaram. Atualize a tela antes de tentar novamente.",
    428: "Atualize a partida antes de continuar.",
    429: "Muitas tentativas. Aguarde um pouco e tente novamente.",
    503: "O Radar está temporariamente indisponível."
  });

  class RadarApiError extends Error {
    constructor(code, status, message, details) {
      super(message);
      this.name = "RadarApiError";
      this.code = code;
      this.status = status || 0;
      this.details = details || null;
    }
  }

  function createIdempotencyKey() {
    if (!window.crypto || typeof window.crypto.randomUUID !== "function") {
      throw new RadarApiError("IDEMPOTENCY_UNAVAILABLE", 0, "Não foi possível proteger esta operação.");
    }
    return window.crypto.randomUUID();
  }

  function safeAvailabilityPath(id) {
    if (typeof id !== "string" || !/^[a-zA-Z0-9_-]{1,96}$/.test(id)) {
      throw new RadarApiError("INVALID_RESOURCE_REFERENCE", 0, "Referência de disponibilidade inválida.");
    }
    return `${ENDPOINTS.availabilities}/${encodeURIComponent(id)}`;
  }

  function safeOpaquePath(base, id, suffix) {
    if (typeof id !== "string" || !/^[a-zA-Z0-9_-]{1,96}$/.test(id)) {
      throw new RadarApiError("INVALID_RESOURCE_REFERENCE", 0, "Referência inválida.");
    }
    return `${base}/${encodeURIComponent(id)}${suffix || ""}`;
  }

  function buildNearbyTeamsPath(filters) {
    const input = filters || {};
    const parameters = new URLSearchParams();
    const modality = { Society: "society", Campo: "futebol_campo", Futsal: "futsal" }[input.modality];
    const level = { Recreativo: "iniciante", Intermediário: "intermediario", Competitivo: "competitivo" }[input.level];
    const day = { Sábado: "saturday", Domingo: "sunday" }[input.day];
    const period = { Manhã: "morning", Tarde: "afternoon", Noite: "evening" }[input.period];
    const venue = { Mandante: "home", Visitante: "away" }[input.venue];
    if (modality) parameters.set("modality", modality);
    if (input.category && input.category !== "Todas") parameters.set("category", input.category);
    if (level) parameters.set("level", level);
    if (day) parameters.set("day", day);
    if (period) parameters.set("period", period);
    if (venue) parameters.set("venue_preference", venue);
    const radius = Number(input.radiusKm);
    if (Number.isInteger(radius) && radius > 0) parameters.set("radius_km", String(radius));
    const limit = Number(input.limit);
    if (Number.isInteger(limit) && limit > 0) parameters.set("limit", String(limit));
    if (typeof input.cursor === "string" && input.cursor) parameters.set("cursor", input.cursor);
    const query = parameters.toString();
    return `${ENDPOINTS.nearbyTeams}${query ? `?${query}` : ""}`;
  }

  function buildMatchHistoryPath(filters, opponentPublicId) {
    const input = filters || {};
    const parameters = new URLSearchParams();
    if (["30d", "90d", "365d", "all"].includes(input.periodo)) parameters.set("periodo", input.periodo);
    if (["official", "divergent", "cancelled", "pending", "all"].includes(input.situacao)) parameters.set("situacao", input.situacao);
    if (Number.isInteger(Number(input.limit)) && Number(input.limit) > 0) parameters.set("limit", String(input.limit));
    if (typeof input.cursor === "string" && input.cursor) parameters.set("cursor", input.cursor);
    const base = opponentPublicId
      ? safeOpaquePath(ENDPOINTS.matchHistory, opponentPublicId)
      : ENDPOINTS.matchHistory;
    const query = parameters.toString();
    return `${base}${query ? `?${query}` : ""}`;
  }

  function create(options) {
    const settings = { demoMode: true, timeoutMs: 12000, ...(options || {}) };
    if (!settings.demoMode && !settings.baseUrl) {
      throw new RadarApiError("API_BASE_REQUIRED", 0, "A origem segura da API precisa ser configurada.");
    }

    async function request(path, requestOptions) {
      if (settings.demoMode) {
        throw new RadarApiError(
          "DEMO_NETWORK_BLOCKED",
          0,
          "A demonstração local não pode chamar serviços externos."
        );
      }

      const config = { method: "GET", ...(requestOptions || {}) };
      const startedAt = Date.now();
      const controller = new AbortController();
      const timeout = window.setTimeout(() => controller.abort(), settings.timeoutMs);
      const headers = new Headers({ Accept: "application/json", ...(config.headers || {}) });
      const token = typeof settings.getAccessToken === "function" ? await settings.getAccessToken() : null;

      if (token) headers.set("Authorization", `Bearer ${token}`);
      if (config.etag) headers.set("If-Match", config.etag);
      if (config.idempotent) headers.set("Idempotency-Key", config.idempotencyKey || createIdempotencyKey());

      let body = config.body;
      if (body && !(body instanceof FormData)) {
        headers.set("Content-Type", "application/json");
        body = JSON.stringify(body);
      }

      try {
        const fetchImpl = typeof settings.fetchImpl === "function" ? settings.fetchImpl : window.fetch.bind(window);
        if (typeof settings.onTrace === "function") {
          settings.onTrace({ phase: "request", method: config.method, path });
        }
        const response = await fetchImpl(new URL(path, settings.baseUrl), {
          method: config.method,
          headers,
          body,
          credentials: "omit",
          cache: "no-store",
          redirect: "error",
          signal: controller.signal
        });

        const contentType = response.headers.get("content-type") || "";
        const payload = contentType.includes("application/json") ? await response.json() : null;
        if (typeof settings.onTrace === "function") {
          settings.onTrace({
            phase: "response",
            method: config.method,
            path,
            status: response.status,
            ok: response.ok,
            etag: response.headers.get("etag"),
            duration_ms: Date.now() - startedAt
          });
        }
        if (!response.ok) {
          const publicCode = payload && typeof payload.code === "string" ? payload.code : `HTTP_${response.status}`;
          throw new RadarApiError(
            publicCode,
            response.status,
            ERROR_MESSAGES[response.status] || "Não foi possível concluir esta ação.",
            payload && payload.details ? payload.details : null
          );
        }

        return {
          data: payload,
          etag: response.headers.get("etag"),
          cacheControl: response.headers.get("cache-control")
        };
      } catch (error) {
        if (error && error.name === "AbortError") {
          throw new RadarApiError("TIMEOUT", 0, "A solicitação demorou além do esperado.");
        }
        if (error instanceof RadarApiError) throw error;
        throw new RadarApiError("NETWORK_ERROR", 0, "Não foi possível conectar ao Radar.");
      } finally {
        window.clearTimeout(timeout);
      }
    }

    return Object.freeze({
      getRadarProfile: () => request(ENDPOINTS.radarProfile),
      getEligibility: () => request(ENDPOINTS.eligibility),
      updateRadarProfile: (values, etag, idempotencyKey) => request(ENDPOINTS.radarProfile, {
        method: "PATCH", body: values, etag, idempotent: true, idempotencyKey
      }),
      importProfilePrint: (file, idempotencyKey) => {
        const form = new FormData();
        form.set("print", file);
        return request(ENDPOINTS.importPrint, { method: "POST", body: form, idempotent: true, idempotencyKey });
      },
      getVerification: () => request(ENDPOINTS.verification),
      startInstagramVerification: (values, idempotencyKey) => request(ENDPOINTS.startInstagramVerification, {
        method: "POST", body: values, idempotent: true, idempotencyKey
      }),
      confirmInstagramVerification: (values, etag, idempotencyKey) => request(ENDPOINTS.confirmInstagramVerification, {
        method: "POST", body: values, etag, idempotent: true, idempotencyKey
      }),
      listAvailabilities: (filters) => {
        const input = filters || {};
        const parameters = new URLSearchParams();
        if (["active", "paused", "expired", "cancelled"].includes(input.status)) parameters.set("status", input.status);
        if (input.cursor) parameters.set("cursor", String(input.cursor));
        if (Number.isInteger(Number(input.limit)) && Number(input.limit) > 0) parameters.set("limit", String(input.limit));
        const query = parameters.toString();
        return request(`${ENDPOINTS.availabilities}${query ? `?${query}` : ""}`);
      },
      listNearbyTeams: (filters) => request(buildNearbyTeamsPath(filters)),
      listInvitations: (box) => request(`${ENDPOINTS.teamInvitations}?caixa=${box === "saida" ? "saida" : "entrada"}`),
      createInvitation: (values, idempotencyKey) => request(ENDPOINTS.invitations, {
        method: "POST", body: values, idempotent: true, idempotencyKey
      }),
      acceptInvitation: (id, etag, idempotencyKey) => request(safeOpaquePath(ENDPOINTS.invitations, id, "/aceitar"), {
        method: "POST", body: {}, etag, idempotent: true, idempotencyKey
      }),
      declineInvitation: (id, etag, idempotencyKey) => request(safeOpaquePath(ENDPOINTS.invitations, id, "/recusar"), {
        method: "POST", body: {}, etag, idempotent: true, idempotencyKey
      }),
      cancelInvitation: (id, etag, idempotencyKey) => request(safeOpaquePath(ENDPOINTS.invitations, id, "/cancelar"), {
        method: "POST", body: {}, etag, idempotent: true, idempotencyKey
      }),
      counterInvitation: (id, values, etag, idempotencyKey) => request(safeOpaquePath(ENDPOINTS.invitations, id, "/contrapropor"), {
        method: "POST", body: values, etag, idempotent: true, idempotencyKey
      }),
      listNotifications: (cursor) => request(`${ENDPOINTS.notifications}${cursor ? `?cursor=${encodeURIComponent(cursor)}` : ""}`),
      readNotification: (id, idempotencyKey) => request(safeOpaquePath(ENDPOINTS.notifications, id, "/lida"), {
        method: "POST", body: {}, idempotent: true, idempotencyKey
      }),
      listMatches: (state) => request(`${ENDPOINTS.matches}?estado=${state === "historico" ? "historico" : state === "proximas" ? "proximas" : "todas"}`),
      listMatchHistory: (filters) => request(buildMatchHistoryPath(filters)),
      getMatchHistoryAgainst: (opponentPublicId, filters) => request(buildMatchHistoryPath(filters, opponentPublicId)),
      getMatch: (id) => request(safeOpaquePath(ENDPOINTS.matches, id)),
      confirmMatchOccurrence: (id, etag, idempotencyKey) => request(safeOpaquePath(ENDPOINTS.matches, id, "/confirmar-realizacao"), {
        method: "POST", body: {}, etag, idempotent: true, idempotencyKey
      }),
      cancelMatch: (id, reason, etag, idempotencyKey) => request(safeOpaquePath(ENDPOINTS.matches, id, "/cancelar"), {
        method: "POST", body: { reason }, etag, idempotent: true, idempotencyKey
      }),
      submitMatchResult: (id, goals, etag, idempotencyKey) => request(safeOpaquePath(ENDPOINTS.matches, id, "/resultado"), {
        method: "POST",
        body: {
          gols_meu_time: goals.gols_meu_time,
          gols_adversario: goals.gols_adversario
        },
        etag,
        idempotent: true,
        idempotencyKey
      }),
      confirmMatchResult: (id, etag, idempotencyKey) => request(safeOpaquePath(ENDPOINTS.matches, id, "/resultado/confirmar"), {
        method: "POST", body: {}, etag, idempotent: true, idempotencyKey
      }),
      listPendingEvaluations: () => request(ENDPOINTS.pendingEvaluations),
      submitMatchEvaluation: (id, values, idempotencyKey) => request(safeOpaquePath(ENDPOINTS.matches, id, "/avaliacao"), {
        method: "POST",
        body: {
          pontualidade: values.pontualidade,
          organizacao: values.organizacao,
          comunicacao: values.comunicacao,
          fair_play: values.fair_play,
          jogaria_novamente: values.jogaria_novamente
        },
        idempotent: true,
        idempotencyKey
      }),
      getOwnReputation: () => request(ENDPOINTS.ownReputation),
      getTeamReputation: (teamPublicId) => request(safeOpaquePath(ENDPOINTS.publicTeamReputation, teamPublicId, "/reputacao")),
      listRadarBlocks: () => request(ENDPOINTS.radarBlocks),
      blockRadarTeam: (teamPublicId, reason, idempotencyKey) => request(ENDPOINTS.radarBlocks, {
        method: "POST", body: { team_public_id: teamPublicId, motivo: reason }, idempotent: true, idempotencyKey
      }),
      unblockRadarTeam: (teamPublicId, idempotencyKey) => request(safeOpaquePath(ENDPOINTS.radarBlocks, teamPublicId), {
        method: "DELETE", idempotent: true, idempotencyKey
      }),
      reportRadarTeam: (teamPublicId, category, description, idempotencyKey) => request(ENDPOINTS.radarReports, {
        method: "POST", body: {
          tipo: "time", team_public_id: teamPublicId, categoria: category,
          ...(description ? { descricao: description } : {})
        }, idempotent: true, idempotencyKey
      }),
      reportRadarMatch: (matchId, category, description, idempotencyKey) => request(ENDPOINTS.radarReports, {
        method: "POST", body: {
          tipo: "partida", match_id: matchId, categoria: category,
          ...(description ? { descricao: description } : {})
        }, idempotent: true, idempotencyKey
      }),
      listRadarReports: () => request(ENDPOINTS.radarReports),
      disputeMatchResult: (matchId, reason, description, idempotencyKey) => request(safeOpaquePath(ENDPOINTS.matches, matchId, "/contestacao"), {
        method: "POST", body: { motivo: reason, ...(description ? { descricao: description } : {}) },
        idempotent: true, idempotencyKey
      }),
      exitRadar: (idempotencyKey) => request(ENDPOINTS.radarExit, {
        method: "POST", body: { confirmacao: "SAIR_DO_RADAR" }, idempotent: true, idempotencyKey
      }),
      listModerationQueue: () => request(ENDPOINTS.moderationQueue),
      assignModerationCase: (caseId, reason, etag, idempotencyKey) => request(safeOpaquePath(ENDPOINTS.moderationQueue, caseId, "/atribuir"), {
        method: "POST", body: { motivo: reason }, etag, idempotent: true, idempotencyKey
      }),
      resolveModerationCase: (caseId, decision, reason, etag, idempotencyKey) => request(safeOpaquePath(ENDPOINTS.moderationQueue, caseId, "/resolver"), {
        method: "POST", body: { decisao: decision, motivo: reason }, etag, idempotent: true, idempotencyKey
      }),
      createAvailability: (values, idempotencyKey) => request(ENDPOINTS.availabilities, {
        method: "POST", body: values, idempotent: true, idempotencyKey
      }),
      updateAvailability: (id, values, etag, idempotencyKey) => request(safeAvailabilityPath(id), {
        method: "PATCH", body: values, etag, idempotent: true, idempotencyKey
      }),
      deleteAvailability: (id, etag, idempotencyKey) => request(safeAvailabilityPath(id), {
        method: "DELETE", etag, idempotent: true, idempotencyKey
      })
    });
  }

  window.RadarApi = { ENDPOINTS, ERROR_MESSAGES, RadarApiError, buildNearbyTeamsPath, buildMatchHistoryPath, create, createIdempotencyKey };
})();
