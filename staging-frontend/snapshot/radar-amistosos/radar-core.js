(function () {
  "use strict";

  const source = window.RadarDemoData;
  const listeners = new Set();

  function copy(value) {
    return JSON.parse(JSON.stringify(value));
  }

  function defaultOpponentFilters() {
    return {
      modality: "Todas",
      category: "Todas",
      level: "Qualquer",
      day: "Qualquer",
      period: "Qualquer",
      radiusKm: 25,
      venue: "Casa ou fora"
    };
  }

  function defaultState() {
    return {
      view: "home",
      busy: false,
      busyLabel: "",
      toast: null,
      profile: copy(source.profile),
      draft: copy(source.draft),
      profileReady: false,
      importedPreview: null,
      verification: {
        status: "unverified",
        challenge: null,
        requestedAt: null,
        approvedAt: null
      },
      availabilities: copy(source.availabilities),
      editingAvailabilityId: null,
      opponentFilters: defaultOpponentFilters(),
      opponentVisibleLimit: 6,
      selectedOpponentSlug: null,
      opponentListScrollY: 0,
      invitationDraft: null,
      selectedInvitationId: null,
      invitationBox: "all",
      invitations: copy(source.invitations),
      notifications: copy(source.notifications),
      matches: copy(source.matches || []),
      selectedMatchId: source.matches?.[0]?.id || null,
      matchBox: "upcoming",
      matchListScrollY: 0,
      historyFilters: { period: "all", situation: "all" },
      historyVisibleLimit: 4,
      historyListScrollY: 0,
      selectedHistoryOpponentId: "11111111-1111-4111-8111-111111111111",
      scoreDraft: { mine: 0, opponent: 0 },
      scoreMode: "new",
      selectedReviewMatchId: "demo-resultado-confirmado",
      reviewDraft: {
        pontualidade: 5,
        organizacao: 5,
        comunicacao: 5,
        fair_play: 5,
        jogaria_novamente: true
      },
      reviewedMatchIds: [],
      selectedReputationTeamId: "11111111-1111-4111-8111-111111111111",
      blockedTeamIds: [],
      safetyCases: copy(source.safetyCases || []),
      safetyTarget: null,
      moderationCases: copy(source.moderationCases || []),
      selectedModerationCaseId: source.moderationCases?.[0]?.id || null,
      exitedRadar: false,
      confirmedMatch: null,
      sequence: 2
    };
  }

  function loadState() {
    const fresh = defaultState();
    try {
      const saved = window.localStorage.getItem(source.storageKey);
      if (!saved) return fresh;
      const parsed = JSON.parse(saved);
      return {
        ...fresh,
        profile: { ...fresh.profile, ...(parsed.profile || {}) },
        draft: { ...fresh.draft, ...(parsed.draft || {}) },
        profileReady: Boolean(parsed.profileReady),
        verification: { ...fresh.verification, ...(parsed.verification || {}), challenge: null },
        availabilities: Array.isArray(parsed.availabilities) ? parsed.availabilities : fresh.availabilities,
        opponentFilters: { ...fresh.opponentFilters, ...(parsed.opponentFilters || {}) },
        invitations: Array.isArray(parsed.invitations) ? parsed.invitations : fresh.invitations,
        notifications: Array.isArray(parsed.notifications) ? parsed.notifications : fresh.notifications,
        matches: Array.isArray(parsed.matches) ? parsed.matches : fresh.matches,
        selectedMatchId: parsed.selectedMatchId || fresh.selectedMatchId,
        matchBox: ["upcoming", "history"].includes(parsed.matchBox) ? parsed.matchBox : fresh.matchBox,
        historyFilters: { ...fresh.historyFilters, ...(parsed.historyFilters || {}) },
        selectedHistoryOpponentId: parsed.selectedHistoryOpponentId || fresh.selectedHistoryOpponentId,
        scoreDraft: { ...fresh.scoreDraft, ...(parsed.scoreDraft || {}) },
        scoreMode: parsed.scoreMode === "different" ? "different" : "new",
        selectedReviewMatchId: parsed.selectedReviewMatchId || fresh.selectedReviewMatchId,
        reviewDraft: { ...fresh.reviewDraft, ...(parsed.reviewDraft || {}) },
        reviewedMatchIds: Array.isArray(parsed.reviewedMatchIds) ? parsed.reviewedMatchIds : [],
        selectedReputationTeamId: parsed.selectedReputationTeamId || fresh.selectedReputationTeamId,
        blockedTeamIds: Array.isArray(parsed.blockedTeamIds) ? parsed.blockedTeamIds : [],
        safetyCases: Array.isArray(parsed.safetyCases) ? parsed.safetyCases : fresh.safetyCases,
        safetyTarget: parsed.safetyTarget || null,
        moderationCases: Array.isArray(parsed.moderationCases) ? parsed.moderationCases : fresh.moderationCases,
        selectedModerationCaseId: parsed.selectedModerationCaseId || fresh.selectedModerationCaseId,
        exitedRadar: Boolean(parsed.exitedRadar),
        confirmedMatch: parsed.confirmedMatch || null,
        sequence: Number.isInteger(parsed.sequence) ? parsed.sequence : fresh.sequence
      };
    } catch (_error) {
      return fresh;
    }
  }

  let state = loadState();

  function persist() {
    const safeState = {
      profile: state.profile,
      draft: state.draft,
      profileReady: state.profileReady,
      verification: { ...state.verification, challenge: null },
      availabilities: state.availabilities,
      opponentFilters: state.opponentFilters,
      invitations: state.invitations,
      notifications: state.notifications,
      matches: state.matches,
      selectedMatchId: state.selectedMatchId,
      matchBox: state.matchBox,
      historyFilters: state.historyFilters,
      selectedHistoryOpponentId: state.selectedHistoryOpponentId,
      scoreDraft: state.scoreDraft,
      scoreMode: state.scoreMode,
      selectedReviewMatchId: state.selectedReviewMatchId,
      reviewDraft: state.reviewDraft,
      reviewedMatchIds: state.reviewedMatchIds,
      selectedReputationTeamId: state.selectedReputationTeamId,
      blockedTeamIds: state.blockedTeamIds,
      safetyCases: state.safetyCases,
      safetyTarget: state.safetyTarget,
      moderationCases: state.moderationCases,
      selectedModerationCaseId: state.selectedModerationCaseId,
      exitedRadar: state.exitedRadar,
      confirmedMatch: state.confirmedMatch,
      sequence: state.sequence
    };
    try {
      window.localStorage.setItem(source.storageKey, JSON.stringify(safeState));
    } catch (_error) {
      // A demonstração segue funcional em memória quando o armazenamento está indisponível.
    }
  }

  function emit(options) {
    if (!options || options.persist !== false) persist();
    listeners.forEach((listener) => listener(copy(state)));
  }

  function announce(message) {
    const live = document.getElementById("radar-live");
    if (!live) return;
    live.textContent = "";
    window.setTimeout(() => { live.textContent = message; }, 30);
  }

  function notify(message, tone) {
    state.toast = { message, tone: tone || "success", nonce: Date.now() };
    announce(message);
    emit({ persist: false });
  }

  function setBusy(isBusy, label) {
    state.busy = isBusy;
    state.busyLabel = isBusy ? (label || "Carregando") : "";
    emit({ persist: false });
  }

  function delay(label, work, duration) {
    setBusy(true, label);
    return new Promise((resolve) => {
      window.setTimeout(() => {
        try {
          const result = work();
          emit();
          resolve(result);
        } finally {
          setBusy(false);
        }
      }, duration || 520);
    });
  }

  const store = {
    subscribe(listener) {
      listeners.add(listener);
      listener(copy(state));
      return () => listeners.delete(listener);
    },

    getState() {
      return copy(state);
    },

    setView(view) {
      state.view = view;
      emit({ persist: false });
    },

    reset() {
      state = defaultState();
      persist();
      emit({ persist: false });
      notify("Demonstração reiniciada.", "info");
    },

    dismissToast() {
      state.toast = null;
      emit({ persist: false });
    },

    notify(message, tone) {
      notify(message, tone);
    },

    saveManualProfile(values) {
      return delay("Salvando o perfil", () => {
        state.profile = { ...state.profile, ...values, publicProfile: true, termsAccepted: true };
        state.profileReady = true;
        state.draft = { ...state.draft, ...values };
        notify("Perfil do time salvo para a demonstração.");
      });
    },

    setImportedPreview(dataUrl) {
      state.importedPreview = dataUrl || "demo";
      emit({ persist: false });
    },

    prepareDraft() {
      return delay("A IA está preparando um rascunho fictício", () => {
        state.draft = { ...copy(source.draft), summary: state.profile.summary };
      }, 750);
    },

    acceptDraft(values) {
      return delay("Aplicando o rascunho", () => {
        state.draft = { ...state.draft, ...values };
        state.profile = {
          ...state.profile,
          teamName: values.teamName,
          instagram: values.instagram,
          city: values.city,
          state: values.state,
          modality: values.modality,
          category: values.category,
          level: values.level,
          summary: values.summary,
          publicProfile: true,
          termsAccepted: true
        };
        state.profileReady = true;
        notify("Rascunho revisado. Nenhum dado foi publicado.");
      }, 620);
    },

    startVerification() {
      return delay("Criando desafio demonstrativo", () => {
        state.verification = {
          status: "challenge",
          challenge: "MCF-4827",
          requestedAt: new Date().toISOString(),
          approvedAt: null
        };
        notify("Código demonstrativo criado.", "info");
      });
    },

    confirmVerification() {
      return delay("Enviando para revisão", () => {
        state.verification = {
          ...state.verification,
          status: "pending",
          challenge: null
        };
        notify("Comprovação enviada para revisão.");
      }, 650);
    },

    approveVerification() {
      return delay("Simulando revisão segura", () => {
        state.verification = {
          ...state.verification,
          status: "verified",
          challenge: null,
          approvedAt: new Date().toISOString()
        };
        notify("Instagram aprovado nesta demonstração.");
      }, 700);
    },

    beginAvailabilityEdit(id) {
      state.editingAvailabilityId = id || null;
      emit({ persist: false });
    },

    saveAvailability(values) {
      return delay(values.id ? "Atualizando disponibilidade" : "Publicando disponibilidade", () => {
        if (values.id) {
          state.availabilities = state.availabilities.map((item) => item.id === values.id
            ? { ...item, ...values, status: item.status === "cancelled" ? "active" : item.status }
            : item);
          notify("Disponibilidade atualizada.");
        } else {
          const created = {
            ...values,
            id: `demo-disponibilidade-${state.sequence++}`,
            status: "active"
          };
          state.availabilities = [created, ...state.availabilities];
          notify("Disponibilidade publicada na lista.");
        }
        state.editingAvailabilityId = null;
      }, 580);
    },

    toggleAvailability(id) {
      const item = state.availabilities.find((entry) => entry.id === id);
      if (!item || item.status === "cancelled") return;
      item.status = item.status === "paused" ? "active" : "paused";
      emit();
      notify(item.status === "paused" ? "Disponibilidade pausada." : "Disponibilidade reativada.", "info");
    },

    cancelAvailability(id) {
      const item = state.availabilities.find((entry) => entry.id === id);
      if (!item) return;
      item.status = "cancelled";
      emit();
      notify("Disponibilidade cancelada.", "info");
    },

    applyOpponentFilters(values) {
      const allowed = {
        modality: new Set(["Todas", "Society", "Campo", "Futsal"]),
        category: new Set(["Todas", "Livre", "Veterano", "Sub-20"]),
        level: new Set(["Qualquer", "Recreativo", "Intermediário", "Competitivo"]),
        day: new Set(["Qualquer", "Sábado", "Domingo", "Próximos 30 dias"]),
        period: new Set(["Qualquer", "Manhã", "Tarde", "Noite"]),
        venue: new Set(["Casa ou fora", "Mandante", "Visitante"])
      };
      const next = defaultOpponentFilters();
      for (const key of Object.keys(allowed)) {
        if (allowed[key].has(values?.[key])) next[key] = values[key];
      }
      const radius = Number(values?.radiusKm);
      next.radiusKm = Number.isFinite(radius) ? Math.max(5, Math.min(25, Math.round(radius))) : 25;
      state.opponentFilters = next;
      state.opponentVisibleLimit = 6;
      state.opponentListScrollY = 0;
      emit();
      announce("Filtros aplicados à lista de times.");
    },

    clearOpponentFilters() {
      state.opponentFilters = defaultOpponentFilters();
      state.opponentVisibleLimit = 6;
      state.opponentListScrollY = 0;
      emit();
      announce("Filtros removidos.");
    },

    selectOpponent(slug, scrollY) {
      const exists = source.nearbyTeams.some((team) => team.slug === slug);
      state.selectedOpponentSlug = exists ? slug : null;
      state.opponentListScrollY = Math.max(0, Number(scrollY) || 0);
      emit({ persist: false });
    },

    rememberOpponentListPosition(scrollY) {
      state.opponentListScrollY = Math.max(0, Number(scrollY) || 0);
    },

    loadMoreOpponents() {
      return delay("Buscando mais times compatíveis", () => {
        state.opponentVisibleLimit += 4;
        announce("Mais times adicionados à lista.");
      }, 420);
    },

    beginInvitation(slug) {
      const team = source.nearbyTeams.find((item) => item.slug === slug) || source.nearbyTeams[0];
      state.selectedOpponentSlug = team.slug;
      state.invitationDraft = {
        opponentSlug: team.slug,
        opponentName: team.name,
        opponentInitials: team.initials,
        distance: team.distanceKm === null ? "mesma cidade" : `${team.distanceKm} km`,
        date: "30/08/2026",
        time: "15:00",
        duration: "2h",
        modality: team.modality,
        category: team.category,
        city: `${state.profile.city}, ${state.profile.state}`,
        venue: "Mandante",
        message: "Campo disponível domingo à tarde."
      };
      emit({ persist: false });
    },

    reviewInvitation(values) {
      if (!state.invitationDraft) return;
      state.invitationDraft = { ...state.invitationDraft, ...values };
      emit({ persist: false });
    },

    sendInvitation() {
      return delay("Enviando convite", () => {
        const draft = state.invitationDraft;
        if (!draft) return;
        const invitation = {
          id: `demo-convite-${state.sequence++}`,
          direction: "outgoing",
          state: "pending",
          version: 1,
          opponentSlug: draft.opponentSlug,
          opponentName: draft.opponentName,
          opponentInitials: draft.opponentInitials,
          distance: draft.distance,
          proposal: {
            date: draft.date, time: draft.time, duration: draft.duration,
            modality: draft.modality, category: draft.category, city: draft.city,
            venue: draft.venue, message: draft.message || null
          },
          updatedLabel: "agora"
        };
        state.invitations = [invitation, ...state.invitations];
        state.selectedInvitationId = invitation.id;
        state.notifications = [{
          id: `demo-aviso-${state.sequence++}`, type: "sent", title: "Convite enviado",
          detail: invitation.opponentName, read: false, time: "agora"
        }, ...state.notifications];
        notify("Convite enviado.");
      }, 560);
    },

    selectInvitation(id) {
      state.selectedInvitationId = state.invitations.some((item) => item.id === id) ? id : null;
      emit({ persist: false });
    },

    setInvitationBox(box) {
      state.invitationBox = ["all", "incoming", "outgoing"].includes(box) ? box : "all";
      emit({ persist: false });
    },

    acceptInvitation(id) {
      return delay("Confirmando amistoso", () => {
        const invitation = state.invitations.find((item) => item.id === id);
        if (!invitation || invitation.state !== "pending") return;
        invitation.state = "accepted";
        invitation.version += 1;
        invitation.updatedLabel = "agora";
        const createdMatch = {
          id: `demo-partida-${state.sequence++}`,
          state: "scheduled",
          version: 1,
          opponentName: invitation.opponentName,
          opponentInitials: invitation.opponentInitials,
          proposal: copy(invitation.proposal),
          contact: { name: "Carlos, responsável", phone: "(47) 99999-0000" },
          confirmation: { mine: false, opponent: false },
          result: { state: "empty", mine: null, opponent: null, official: null },
          cancellation: null,
          updatedLabel: "agora"
        };
        state.confirmedMatch = createdMatch;
        state.matches = [createdMatch, ...state.matches];
        state.selectedMatchId = createdMatch.id;
        state.notifications = [{
          id: `demo-aviso-${state.sequence++}`, type: "accepted", title: "Amistoso confirmado",
          detail: invitation.opponentName, read: false, time: "agora"
        }, ...state.notifications];
        notify("Amistoso confirmado.");
      }, 620);
    },

    declineInvitation(id) {
      const invitation = state.invitations.find((item) => item.id === id);
      if (!invitation || invitation.state !== "pending") return;
      invitation.state = "declined";
      invitation.version += 1;
      invitation.updatedLabel = "agora";
      emit();
      notify("Convite recusado.", "info");
    },

    cancelInvitation(id) {
      const invitation = state.invitations.find((item) => item.id === id);
      if (!invitation || !["pending", "counter_proposed"].includes(invitation.state)) return;
      invitation.state = "cancelled";
      invitation.version += 1;
      invitation.updatedLabel = "agora";
      emit();
      notify("Convite cancelado.", "info");
    },

    counterInvitation(id, values) {
      return delay("Enviando contraproposta", () => {
        const invitation = state.invitations.find((item) => item.id === id);
        if (!invitation || invitation.state !== "pending") return;
        invitation.proposal = { ...invitation.proposal, ...values };
        invitation.state = "counter_proposed";
        invitation.direction = "outgoing";
        invitation.version += 1;
        invitation.updatedLabel = "agora";
        notify("Contraproposta enviada.");
      }, 520);
    },

    selectMatch(id, scrollY) {
      state.selectedMatchId = state.matches.some((item) => item.id === id) ? id : null;
      state.matchListScrollY = Math.max(0, Number(scrollY) || 0);
      emit({ persist: false });
    },

    rememberMatchListPosition(scrollY) {
      state.matchListScrollY = Math.max(0, Number(scrollY) || 0);
    },

    setMatchBox(box) {
      state.matchBox = box === "history" ? "history" : "upcoming";
      state.matchListScrollY = 0;
      emit();
    },

    setHistoryFilter(name, value) {
      if (name === "period" && ["30d", "90d", "365d", "all"].includes(value)) {
        state.historyFilters.period = value;
      }
      if (name === "situation" && ["official", "divergent", "cancelled", "pending", "all"].includes(value)) {
        state.historyFilters.situation = value;
      }
      state.historyVisibleLimit = 4;
      state.historyListScrollY = 0;
      emit();
    },

    loadMoreHistory() {
      return delay("Carregando partidas", () => {
        state.historyVisibleLimit += 3;
        announce("Mais partidas carregadas.");
      }, 360);
    },

    openHistoryMatch(id, scrollY) {
      state.selectedMatchId = state.matches.some((item) => item.id === id) ? id : null;
      state.historyListScrollY = Math.max(0, Number(scrollY) || 0);
      emit({ persist: false });
    },

    selectHistoryOpponent(publicId, scrollY) {
      const exists = state.matches.some((item) => item.opponentPublicId === publicId);
      if (!exists) return false;
      state.selectedHistoryOpponentId = publicId;
      state.historyListScrollY = Math.max(0, Number(scrollY) || 0);
      emit();
      return true;
    },

    confirmMatchOccurrence(id) {
      return delay("Salvando confirmação", () => {
        const match = state.matches.find((item) => item.id === id);
        if (!match || ["played", "cancelled"].includes(match.state) || match.confirmation?.mine) return;
        match.confirmation = { ...(match.confirmation || {}), mine: true };
        match.version += 1;
        match.state = match.confirmation.opponent ? "played" : "awaiting_occurrence";
        match.updatedLabel = match.state === "played" ? "realizada" : "aguardando rival";
        state.notifications = [{
          id: `demo-aviso-${state.sequence++}`,
          type: "confirmation",
          title: match.state === "played" ? "Partida realizada" : "Confirmação enviada",
          detail: match.opponentName,
          read: false,
          time: "agora"
        }, ...state.notifications];
        notify(match.state === "played" ? "Partida realizada." : "Aguardando o outro time.");
      }, 520);
    },

    cancelMatch(id, values) {
      const reasons = {
        weather: "Clima",
        field_unavailable: "Campo indisponível",
        team_unavailable: "Time indisponível",
        scheduling_conflict: "Conflito de horário",
        safety: "Segurança",
        other: "Outro motivo"
      };
      return delay("Cancelando partida", () => {
        const match = state.matches.find((item) => item.id === id);
        const reason = String(values?.reason || "");
        if (!match || !reasons[reason] || match.confirmation?.mine || match.confirmation?.opponent || ["played", "cancelled"].includes(match.state)) return;
        match.state = "cancelled";
        match.version += 1;
        match.cancellation = { reason: reasons[reason], byMe: true, at: "agora" };
        match.updatedLabel = "cancelada";
        state.notifications = [{
          id: `demo-aviso-${state.sequence++}`,
          type: "cancelled",
          title: "Partida cancelada",
          detail: match.opponentName,
          read: false,
          time: "agora"
        }, ...state.notifications];
        notify("Partida cancelada.", "info");
      }, 520);
    },

    beginScore(id, mode) {
      const match = state.matches.find((item) => item.id === id);
      if (!match || match.state !== "played" || match.result?.state === "verified") return;
      state.selectedMatchId = match.id;
      state.scoreMode = mode === "different" ? "different" : "new";
      state.scoreDraft = match.result?.mine
        ? { mine: match.result.mine.mine, opponent: match.result.mine.opponent }
        : { mine: 0, opponent: 0 };
      emit({ persist: false });
    },

    reviewScore(values, id) {
      const match = state.matches.find((item) => item.id === id);
      const mine = Number(values?.mine);
      const opponent = Number(values?.opponent);
      if (!match || match.state !== "played" || match.result?.state === "verified") return false;
      if (!Number.isInteger(mine) || !Number.isInteger(opponent) || mine < 0 || opponent < 0 || mine > 99 || opponent > 99) {
        notify("Use gols entre 0 e 99.", "error");
        return false;
      }
      state.selectedMatchId = match.id;
      state.scoreDraft = { mine, opponent };
      emit({ persist: false });
      return true;
    },

    submitScore(id) {
      return delay("Enviando placar", () => {
        const match = state.matches.find((item) => item.id === id);
        if (!match || match.state !== "played" || match.result?.state === "verified") return "error";
        match.result = match.result || { state: "empty", mine: null, opponent: null, official: null };
        match.result.mine = { ...state.scoreDraft, at: "agora" };
        const received = match.result.opponent;
        if (!received) {
          match.result.state = "waiting_other";
          match.updatedLabel = "aguardando placar";
        } else if (received.mine === state.scoreDraft.mine && received.opponent === state.scoreDraft.opponent) {
          match.result.state = "verified";
          match.result.official = { ...state.scoreDraft, at: "agora" };
          match.updatedLabel = "resultado oficial";
        } else {
          match.result.state = "divergent";
          match.result.official = null;
          match.updatedLabel = "placares diferentes";
        }
        match.version += 1;
        state.notifications = [{
          id: `demo-aviso-${state.sequence++}`,
          type: match.result.state === "verified" ? "result" : match.result.state === "divergent" ? "divergent" : "score",
          title: match.result.state === "verified" ? "Resultado confirmado" : match.result.state === "divergent" ? "Placar divergente" : "Placar enviado",
          detail: match.opponentName, read: false, time: "agora"
        }, ...state.notifications];
        notify(match.result.state === "verified" ? "Resultado confirmado." : match.result.state === "divergent" ? "Placares diferentes." : "Placar enviado.", match.result.state === "divergent" ? "info" : "success");
        return match.result.state;
      }, 560);
    },

    confirmReceivedScore(id) {
      return delay("Confirmando placar", () => {
        const match = state.matches.find((item) => item.id === id);
        const received = match?.result?.opponent;
        if (!match || match.state !== "played" || !received || match.result.state === "verified") return false;
        match.result.state = "verified";
        match.result.official = { mine: received.mine, opponent: received.opponent, at: "agora" };
        match.version += 1;
        match.updatedLabel = "resultado oficial";
        state.notifications = [{
          id: `demo-aviso-${state.sequence++}`, type: "result", title: "Resultado confirmado",
          detail: match.opponentName, read: false, time: "agora"
        }, ...state.notifications];
        notify("Resultado confirmado.");
        return true;
      }, 560);
    },

    beginReview(id) {
      const match = state.matches.find((item) => item.id === id && item.result?.state === "verified");
      if (!match || state.reviewedMatchIds.includes(match.id)) return false;
      state.selectedMatchId = match.id;
      state.selectedReviewMatchId = match.id;
      state.reviewDraft = {
        pontualidade: 5,
        organizacao: 5,
        comunicacao: 5,
        fair_play: 5,
        jogaria_novamente: true
      };
      emit({ persist: false });
      return true;
    },

    reviewEvaluation(values, id) {
      const match = state.matches.find((item) => item.id === id && item.result?.state === "verified");
      const fields = ["pontualidade", "organizacao", "comunicacao", "fair_play"];
      const scores = Object.fromEntries(fields.map((field) => [field, Number(values?.[field])]));
      if (!match || state.reviewedMatchIds.includes(match.id) || fields.some((field) => !Number.isInteger(scores[field]) || scores[field] < 1 || scores[field] > 5)) {
        notify("Complete a avaliação.", "error");
        return false;
      }
      if (!["true", "false"].includes(String(values?.jogaria_novamente))) {
        notify("Escolha sim ou não.", "error");
        return false;
      }
      state.selectedReviewMatchId = match.id;
      state.reviewDraft = {
        ...scores,
        jogaria_novamente: String(values.jogaria_novamente) === "true"
      };
      emit({ persist: false });
      return true;
    },

    submitReview(id) {
      return delay("Enviando avaliação", () => {
        const match = state.matches.find((item) => item.id === id && item.result?.state === "verified");
        if (!match || state.reviewedMatchIds.includes(match.id)) return false;
        state.reviewedMatchIds = [...state.reviewedMatchIds, match.id];
        state.notifications = [{
          id: `demo-aviso-${state.sequence++}`,
          type: "review",
          title: "Avaliação enviada",
          detail: match.opponentName,
          read: false,
          time: "agora"
        }, ...state.notifications];
        notify("Avaliação enviada.");
        return true;
      }, 520);
    },

    selectReputationTeam(publicId) {
      const exists = state.matches.some((item) => item.opponentPublicId === publicId) ||
        source.nearbyTeams.some((item) => item.publicId === publicId);
      if (!exists) return false;
      state.selectedReputationTeamId = publicId;
      emit({ persist: false });
      return true;
    },

    beginBlock(slug) {
      const team = source.nearbyTeams.find((item) => item.slug === slug);
      if (!team?.publicId) return false;
      state.safetyTarget = { type: "team", slug: team.slug, publicId: team.publicId, name: team.name, initials: team.initials };
      emit({ persist: false });
      return true;
    },

    blockSelected() {
      const target = state.safetyTarget;
      if (!target?.publicId) return false;
      if (!state.blockedTeamIds.includes(target.publicId)) state.blockedTeamIds = [...state.blockedTeamIds, target.publicId];
      state.invitations = state.invitations.map((item) => item.opponentSlug === target.slug && ["pending", "counter_proposed"].includes(item.state)
        ? { ...item, state: "cancelled", version: item.version + 1, updatedLabel: "bloqueado" }
        : item);
      state.matches = state.matches.map((item) => item.opponentPublicId === target.publicId
        ? { ...item, contactHidden: true }
        : item);
      emit();
      notify("Time bloqueado.", "info");
      return true;
    },

    unblockTeam(publicId) {
      state.blockedTeamIds = state.blockedTeamIds.filter((id) => id !== publicId);
      state.matches = state.matches.map((item) => item.opponentPublicId === publicId
        ? { ...item, contactHidden: false }
        : item);
      emit();
      notify("Bloqueio removido.", "info");
    },

    beginSafetyReport(type, reference) {
      if (type === "team") {
        const team = source.nearbyTeams.find((item) => item.slug === reference);
        if (!team?.publicId) return false;
        state.safetyTarget = { type, slug: team.slug, publicId: team.publicId, name: team.name, initials: team.initials };
      } else {
        const match = state.matches.find((item) => item.id === reference);
        if (!match) return false;
        state.safetyTarget = { type: "match", matchId: match.id, name: match.opponentName, initials: match.opponentInitials };
      }
      emit({ persist: false });
      return true;
    },

    submitSafetyReport(values) {
      const categories = {
        unsafe_conduct: "Conduta perigosa", harassment: "Assédio", identity_fraud: "Identidade falsa",
        spam: "Spam", inappropriate_content: "Conteúdo impróprio", other: "Outro"
      };
      const target = state.safetyTarget;
      if (!target || !categories[values?.category]) return false;
      const item = {
        id: `caso-demo-${state.sequence++}`, type: target.type === "match" ? "Denúncia de partida" : "Denúncia",
        category: categories[values.category], status: "Recebida", version: 1,
        teamName: target.name, matchId: target.matchId || null, createdLabel: "agora"
      };
      state.safetyCases = [item, ...state.safetyCases];
      state.notifications = [{
        id: `demo-aviso-${state.sequence++}`, type: "safety", title: "Caso recebido",
        detail: item.category, read: false, time: "agora"
      }, ...state.notifications];
      emit();
      notify("Denúncia enviada.");
      return true;
    },

    beginDispute(matchId) {
      const match = state.matches.find((item) => item.id === matchId && ["verified", "divergent"].includes(item.result?.state));
      if (!match) return false;
      state.safetyTarget = { type: "dispute", matchId: match.id, name: match.opponentName, initials: match.opponentInitials };
      emit({ persist: false });
      return true;
    },

    submitDispute(values) {
      const reasons = { score_incorrect: "Placar incorreto", identity_fraud: "Partida incorreta", other: "Outro" };
      const target = state.safetyTarget;
      if (target?.type !== "dispute" || !reasons[values?.reason]) return false;
      state.safetyCases = [{
        id: `caso-demo-${state.sequence++}`, type: "Contestação", category: reasons[values.reason],
        status: "Recebida", version: 1, teamName: target.name, matchId: target.matchId, createdLabel: "agora"
      }, ...state.safetyCases];
      emit();
      notify("Contestação enviada.");
      return true;
    },

    exitRadar() {
      if (state.exitedRadar) return false;
      state.exitedRadar = true;
      state.profile = { ...state.profile, publicProfile: false };
      state.availabilities = state.availabilities.map((item) => ({ ...item, status: "cancelled" }));
      state.invitations = state.invitations.map((item) => ["pending", "counter_proposed"].includes(item.state)
        ? { ...item, state: "cancelled", version: item.version + 1 }
        : item);
      emit();
      notify("Saída do Radar concluída.", "info");
      return true;
    },

    selectModerationCase(id) {
      if (!state.moderationCases.some((item) => item.id === id)) return false;
      state.selectedModerationCaseId = id;
      emit({ persist: false });
      return true;
    },

    assignModerationCase(id) {
      state.moderationCases = state.moderationCases.map((item) => item.id === id
        ? { ...item, status: "Atribuído", version: item.version + 1 }
        : item);
      emit();
      notify("Caso atribuído.");
    },

    resolveModerationCase(id, values) {
      const labels = {
        dismiss: "Arquivado", warn: "Orientação aplicada", invalidate_review: "Avaliação invalidada",
        invalidate_result: "Resultado invalidado", suspend_team: "Time suspenso"
      };
      if (!labels[values?.decision]) return false;
      state.moderationCases = state.moderationCases.map((item) => item.id === id
        ? { ...item, status: "Resolvido", resolution: labels[values.decision], version: item.version + 1 }
        : item);
      emit();
      notify("Decisão registrada.");
      return true;
    },

    markNotificationsRead() {
      state.notifications.forEach((item) => { item.read = true; });
      emit();
      announce("Notificações marcadas como lidas.");
    }
  };

  window.RadarCore = { store, copy };
})();
