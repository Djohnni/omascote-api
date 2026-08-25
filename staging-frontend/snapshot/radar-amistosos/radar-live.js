(function () {
  "use strict";

  const entries = [...document.querySelectorAll("[data-radar-live-entry]")];
  const entry = entries[0];
  if (!entry || !window.RadarApi) return;

  const meta = name => document.querySelector(`meta[name="${name}"]`)?.content?.trim() || "";
  const apiBase = meta("omascote-api-base");
  const environment = meta("omascote-environment") || "production";
  const root = document.createElement("div");
  root.id = "radarLiveRoot";
  root.className = "radar-live";
  root.hidden = true;
  document.body.appendChild(root);

  const state = {
    open: false,
    view: "home",
    stack: [],
    loading: false,
    busy: false,
    error: null,
    data: null,
    selected: null,
    selectedEtag: null,
    filters: { radiusKm: 25, modality: "Society", category: "Livre" },
    invitationBox: "entrada",
    traces: []
  };
  let returnFocus = null;
  let backgroundDialogs = [];

  function token() {
    try { return localStorage.getItem("omascote_token") || ""; }
    catch { return ""; }
  }

  function safeApiBase(value) {
    try {
      const parsed = new URL(value);
      if (!["http:", "https:"].includes(parsed.protocol) || parsed.username || parsed.password) return "";
      return parsed.origin;
    } catch { return ""; }
  }

  const resolvedApiBase = safeApiBase(apiBase);
  if (!resolvedApiBase) return;

  function trace(event) {
    state.traces.push({ ...event, at: new Date().toISOString() });
    if (state.traces.length > 80) state.traces.splice(0, state.traces.length - 80);
    window.dispatchEvent(new CustomEvent("radar:api-trace", { detail: event }));
  }

  const api = window.RadarApi.create({
    demoMode: false,
    baseUrl: resolvedApiBase,
    getAccessToken: token,
    onTrace: trace
  });

  const esc = value => String(value ?? "").replace(/[&<>"']/g, character => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;"
  })[character]);
  const idOf = item => item?.public_id || item?.match_id || item?.invitation_id || item?.case_id || item?.id || "";
  const versionOf = item => Number(item?.version || item?.case?.version || 1);
  const etagOf = item => item?.etag || `W/\"${versionOf(item)}\"`;
  const teamOf = item => item?.team || item?.opponent || item?.adversary || item?.opponent_team || {};
  const teamName = item => teamOf(item)?.name || teamOf(item)?.public_name || item?.opponent_name || item?.team_name || item?.name || "Time";
  const teamPublicId = item => teamOf(item)?.public_id || item?.team_public_id || item?.opponent_public_id || "";
  const teamSlug = item => teamOf(item)?.slug || teamOf(item)?.public_slug || item?.opponent_slug || "";
  const matchState = item => item?.state || item?.occurrence_state || "scheduled";
  const resultState = item => item?.result?.state || item?.result_state || "empty";
  const officialScore = item => item?.result?.placar_oficial || item?.official_score || null;
  const scoreLabel = item => {
    const score = officialScore(item);
    if (score && Number.isInteger(Number(score.gols_meu_time)) && Number.isInteger(Number(score.gols_adversario))) {
      return `${Number(score.gols_meu_time)} × ${Number(score.gols_adversario)}`;
    }
    if (item?.result && Number.isInteger(Number(item.result.goals_for)) && Number.isInteger(Number(item.result.goals_against))) {
      return `${Number(item.result.goals_for)} × ${Number(item.result.goals_against)}`;
    }
    return "";
  };
  const list = value => Array.isArray(value) ? value : [];
  const payload = response => response?.data || response || {};
  const dateLabel = value => {
    if (!value) return "Data pendente";
    const parsed = new Date(value);
    return Number.isNaN(parsed.getTime()) ? "Data pendente" : new Intl.DateTimeFormat("pt-BR", {
      day: "2-digit", month: "short", hour: "2-digit", minute: "2-digit"
    }).format(parsed);
  };
  const futureInput = (days = 10, hours = 19) => {
    const value = new Date();
    value.setDate(value.getDate() + days);
    value.setHours(hours, 0, 0, 0);
    const local = new Date(value.getTime() - value.getTimezoneOffset() * 60000);
    return local.toISOString().slice(0, 16);
  };
  const toIso = value => new Date(value).toISOString();
  const chip = (label, tone = "") => `<span class="radar-live__chip${tone ? ` radar-live__chip--${tone}` : ""}">${esc(label)}</span>`;
  const button = (label, action, kind = "", extra = "") => `<button class="radar-live__button${kind ? ` radar-live__button--${kind}` : ""}" type="button" data-action="${esc(action)}" ${extra}>${esc(label)}</button>`;
  const formButton = label => `<button class="radar-live__button" type="submit" ${state.busy ? "disabled" : ""}>${esc(label)}</button>`;

  function shell(content, options = {}) {
    const canBack = state.stack.length > 0;
    return `<section class="radar-live__panel" role="dialog" aria-modal="true" aria-labelledby="radarLiveTitle" aria-busy="${state.loading || state.busy ? "true" : "false"}">
      <header class="radar-live__top">
        <button type="button" data-action="${canBack ? "back" : "close"}" aria-label="${canBack ? "Voltar" : "Fechar"}">${canBack ? "←" : "×"}</button>
        <div class="radar-live__brand"><strong>Radar de Amistosos</strong><span><b>${environment === "local-real" ? "LOCAL REAL" : "MEU CLUBE FC"}</b> · dados da API</span></div>
        <button type="button" data-action="refresh" aria-label="Atualizar">↻</button>
      </header>
      <main class="radar-live__main" id="radarLiveMain" tabindex="-1" aria-live="polite">
        <div class="radar-live__screen${options.wide ? " radar-live__screen--wide" : ""}">${content}</div>
      </main>
    </section>`;
  }

  function heading(eyebrow, title, lead) {
    return `<p class="radar-live__eyebrow">${esc(eyebrow)}</p><h1 id="radarLiveTitle">${esc(title)}</h1>${lead ? `<p class="radar-live__lead">${esc(lead)}</p>` : ""}`;
  }

  function stateCard(icon, title, text, retry = false) {
    return `<section class="radar-live__empty${state.error ? " radar-live__error" : ""}"><b>${esc(icon)}</b><strong>${esc(title)}</strong><span>${esc(text)}</span>${retry ? `<div class="radar-live__actions" style="justify-content:center">${button("Tentar novamente", "refresh")}</div>` : ""}</section>`;
  }

  function renderLoading() {
    return shell(`${heading("Radar", "Carregando", "Buscando dados da API.")}${stateCard("↻", "Só um instante", "Conexão local segura.")}`);
  }

  function renderError() {
    const error = state.error || {};
    const session = error.status === 401;
    const denied = error.status === 403;
    const unavailable = !error.status || error.status === 503;
    const title = session ? "Sessão expirada" : denied ? "Acesso negado" : unavailable ? "API indisponível" : "Não foi possível";
    return shell(`${heading("Radar", title, error.message || "Tente novamente.")}${stateCard(session ? "⌛" : denied ? "🔒" : "!", title, error.code || "Erro seguro", !session && !denied)}`);
  }

  function renderHome() {
    const info = state.data || {};
    const eligibility = info.eligibility || {};
    const profile = info.profile || {};
    const notifications = list(info.notifications?.items);
    const menu = [
      ["⌚", "Disponibilidade", "Quando jogar", "availability"],
      ["⌖", "Times próximos", "Buscar adversário", "search"],
      ["➤", "Convites", "Entrada e saída", "invitations"],
      ["⚽", "Partidas", "Central segura", "matches"],
      ["▤", "Histórico", "Resultados oficiais", "history"],
      ["★", "Avaliações", "Pendências", "reviews"],
      ["♛", "Reputação", "Resumo anônimo", "reputation"],
      ["●", "Notificações", `${notifications.length} recentes`, "notifications"],
      ["⚑", "Segurança", "Bloquear e denunciar", "safety"],
      ["◆", "Moderação", "Acesso por função", "moderation"]
    ];
    return shell(`${heading("Meu time", "Encontrar amistoso", "Dados reais do Radar.")}
      <section class="radar-live__hero"><div class="radar-live__hero-row"><div><strong>${esc(profile.public_name || info.legacy_profile?.nome_time || "Seu time")}</strong><small>${esc(profile.city_name || "Perfil Radar")}</small></div><strong class="radar-live__number">${eligibility.eligible ? "✓" : "!"}</strong></div>
      <div class="radar-live__chips">${chip(eligibility.eligible ? "Elegível" : "Configuração pendente", eligibility.eligible ? "ok" : "warn")}${chip(eligibility.discoverable ? "Visível" : "Oculto")}${chip(profile.instagram_verification_status === "verified" ? "Instagram verificado" : "Instagram pendente", profile.instagram_verification_status === "verified" ? "ok" : "warn")}</div></section>
      <section class="radar-live__menu">${menu.map(item => `<button type="button" data-action="nav" data-view="${item[3]}"><i>${item[0]}</i><span><strong>${item[1]}</strong><small>${item[2]}</small></span><b>›</b></button>`).join("")}</section>
      <p class="radar-live__trace">${state.traces.filter(item => item.phase === "response").length} respostas da API nesta sessão</p>`, { wide: true });
  }

  function renderAvailability() {
    const items = list(state.data?.items);
    return shell(`${heading("Agenda", "Disponibilidade", "Horários do seu time.")}
      <form class="radar-live__form" data-form="availability"><div class="radar-live__fields">
        <label class="radar-live__field"><span>Início</span><input name="starts_at" type="datetime-local" value="${futureInput()}" required></label>
        <label class="radar-live__field"><span>Fim</span><input name="ends_at" type="datetime-local" value="${futureInput(10, 21)}" required></label>
        <label class="radar-live__field"><span>Modalidade</span><select name="modality"><option value="society">Society</option><option value="futsal">Futsal</option><option value="futebol_campo">Campo</option></select></label>
        <label class="radar-live__field"><span>Categoria</span><input name="category" value="Livre" maxlength="40" required></label>
        <label class="radar-live__field"><span>Raio</span><select name="travel_radius_km"><option>25</option><option selected>50</option><option>100</option></select></label>
        <label class="radar-live__field"><span>Mando</span><select name="venue_preference"><option value="either">Casa ou fora</option><option value="home">Mandante</option><option value="away">Visitante</option></select></label>
      </div><div class="radar-live__form-actions">${formButton("Salvar horário")}</div></form>
      <div class="radar-live__toolbar"><strong>${items.length} horários</strong></div>
      ${items.length ? `<section class="radar-live__list">${items.map(item => `<article class="radar-live__card"><div class="radar-live__card-top"><div><strong>${esc(item.modality)} · ${esc(item.category)}</strong><p>${dateLabel(item.starts_at)} · ${esc(item.status)}</p></div>${chip(`v${versionOf(item)}`)}</div></article>`).join("")}</section>` : stateCard("⌚", "Agenda vazia", "Cadastre o primeiro horário.")}`);
  }

  function renderSearch() {
    const items = list(state.data?.items);
    return shell(`${heading("Radar", "Times próximos", "Somente perfis elegíveis.")}
      <form class="radar-live__form" data-form="search"><div class="radar-live__fields">
        <label class="radar-live__field"><span>Modalidade</span><select name="modality"><option${state.filters.modality === "Society" ? " selected" : ""}>Society</option><option>Futsal</option><option>Campo</option></select></label>
        <label class="radar-live__field"><span>Categoria</span><select name="category"><option>Livre</option><option>Todas</option></select></label>
        <label class="radar-live__field"><span>Distância</span><select name="radiusKm"><option value="10">10 km</option><option value="25"${state.filters.radiusKm === 25 ? " selected" : ""}>25 km</option><option value="50"${state.filters.radiusKm === 50 ? " selected" : ""}>50 km</option></select></label>
      </div><div class="radar-live__form-actions">${formButton("Buscar times")}</div></form>
      <div class="radar-live__toolbar"><strong>${items.length} encontrados</strong>${state.data?.page?.has_more ? chip("Mais resultados") : ""}</div>
      ${items.length ? `<section class="radar-live__list">${items.map((item, index) => `<article class="radar-live__card"><div class="radar-live__card-top"><div><strong>${esc(teamName(item))}</strong><p>${esc(item.distance_label || item.city_name || item.team?.city || "Mesma cidade")} · ${esc(item.compatibility?.score || item.compatibility_score || "Compatível")}</p></div>${chip(item.next_availability ? dateLabel(item.next_availability.starts_at) : "Disponível", "ok")}</div><div class="radar-live__actions">${button("Convidar", "select-team", "", `data-index="${index}"`)}</div></article>`).join("")}</section>` : stateCard("⌖", "Nenhum time", "Ajuste os filtros ou horários.")}`);
  }

  function renderInvite() {
    const item = state.selected || {};
    return shell(`${heading("Convite", teamName(item), "Contato fica oculto.")}
      <form class="radar-live__form" data-form="invitation"><div class="radar-live__fields">
        <label class="radar-live__field"><span>Início</span><input name="starts_at" type="datetime-local" value="${futureInput(12)}" required></label>
        <label class="radar-live__field"><span>Fim</span><input name="ends_at" type="datetime-local" value="${futureInput(12, 21)}" required></label>
        <label class="radar-live__field"><span>Modalidade</span><select name="modality"><option value="society">Society</option><option value="futsal">Futsal</option></select></label>
        <label class="radar-live__field"><span>Categoria</span><input name="category" value="Livre" required></label>
        <label class="radar-live__field"><span>Mando</span><select name="venue_preference"><option value="either">Casa ou fora</option><option value="home">Mandante</option><option value="away">Visitante</option></select></label>
        <label class="radar-live__field radar-live__field--wide"><span>Mensagem curta</span><input name="message" maxlength="180" value="Amistoso confirmado pelo Radar"></label>
      </div><div class="radar-live__form-actions">${formButton("Enviar convite")}</div></form>`);
  }

  function renderInvitations() {
    const items = list(state.data?.items);
    return shell(`${heading("Convites", state.invitationBox === "entrada" ? "Caixa de entrada" : "Enviados", "Propostas sem contato.")}
      <div class="radar-live__toolbar"><div class="radar-live__tabs"><button type="button" data-action="invitation-box" data-box="entrada" class="${state.invitationBox === "entrada" ? "is-active" : ""}">Entrada</button><button type="button" data-action="invitation-box" data-box="saida" class="${state.invitationBox === "saida" ? "is-active" : ""}">Saída</button></div></div>
      ${items.length ? `<section class="radar-live__list">${items.map((item, index) => `<article class="radar-live__card"><div class="radar-live__card-top"><div><strong>${esc(teamName(item))}</strong><p>${dateLabel(item.proposal?.starts_at || item.starts_at)} · ${esc(item.state)}</p></div>${chip(`v${versionOf(item)}`)}</div><div class="radar-live__actions">${button("Abrir", "open-invitation", "", `data-index="${index}"`)}</div></article>`).join("")}</section>` : stateCard("➤", "Nenhum convite", "A caixa está vazia.")}`);
  }

  function renderInvitationDetail() {
    const item = state.selected || {};
    const canReceive = state.invitationBox === "entrada" && ["pending", "counter_proposed"].includes(item.state);
    const canCancel = state.invitationBox === "saida" && ["pending", "counter_proposed"].includes(item.state);
    return shell(`${heading("Convite", teamName(item), dateLabel(item.proposal?.starts_at || item.starts_at))}
      <section class="radar-live__hero"><div class="radar-live__hero-row"><div><strong>${esc(item.proposal?.modality || item.modality || "Society")}</strong><small>${esc(item.proposal?.category || item.category || "Livre")} · ${esc(item.proposal?.venue_preference || "either")}</small></div>${chip(item.state || "pending", item.state === "accepted" ? "ok" : "warn")}</div></section>
      <div class="radar-live__actions">${canReceive ? `${button("Aceitar", "accept-invitation")}${button("Contrapropor", "show-counter", "ghost")}${button("Recusar", "decline-invitation", "danger")}` : ""}${canCancel ? button("Cancelar", "cancel-invitation", "danger") : ""}</div>
      <form class="radar-live__form" data-form="counter" hidden><div class="radar-live__fields"><label class="radar-live__field"><span>Novo início</span><input name="starts_at" type="datetime-local" value="${futureInput(14)}" required></label><label class="radar-live__field"><span>Novo fim</span><input name="ends_at" type="datetime-local" value="${futureInput(14, 21)}" required></label></div><div class="radar-live__form-actions">${formButton("Enviar contraproposta")}</div></form>`);
  }

  function renderMatches() {
    const items = list(state.data?.items);
    return shell(`${heading("Partidas", "Meus amistosos", "Contato só após aceite.")}
      ${items.length ? `<section class="radar-live__list">${items.map((item, index) => `<article class="radar-live__card"><div class="radar-live__card-top"><div><strong>${esc(teamName(item))}</strong><p>${dateLabel(item.scheduled_at)} · ${esc(matchState(item))}</p></div>${scoreLabel(item) ? `<strong class="radar-live__score">${esc(scoreLabel(item))}</strong>` : chip(resultState(item) === "empty" ? "sem placar" : resultState(item))}</div><div class="radar-live__actions">${button("Abrir partida", "open-match", "", `data-index="${index}"`)}</div></article>`).join("")}</section>` : stateCard("⚽", "Nenhuma partida", "Aceite um convite primeiro.")}`);
  }

  function renderMatchDetail() {
    const item = state.selected || {};
    const contact = item.contact || item.opponent_contact;
    const played = matchState(item) === "played";
    const verified = resultState(item) === "verified";
    const myConfirmed = item.confirmation?.by_me || item.occurrence?.my_team_confirmed || item.my_team_confirmed;
    const result = resultState(item);
    const score = scoreLabel(item);
    return shell(`${heading("Partida", teamName(item), dateLabel(item.scheduled_at))}
      <section class="radar-live__hero"><div class="radar-live__hero-row"><div><strong>${esc(matchState(item))}</strong><small>${contact ? `Contato: ${esc(contact.value || contact)}` : "Contato protegido"}</small></div>${score ? `<strong class="radar-live__number">${esc(score)}</strong>` : chip(result, verified ? "ok" : "warn")}</div>${score ? `<div class="radar-live__chips">${chip("Placar oficial", "ok")}</div>` : ""}</section>
      <div class="radar-live__actions">${!played && !myConfirmed ? button("Confirmar realização", "confirm-occurrence") : ""}${played && result === "empty" ? button("Informar placar", "show-score") : ""}${played && result === "waiting_other" && !item.result?.meu_placar ? button("Confirmar placar", "confirm-score") : ""}${played && verified ? button("Avaliar adversário", "show-review") : ""}${played && ["verified", "divergent"].includes(result) ? button("Contestar", "show-dispute", "ghost") : ""}${button("Denunciar partida", "show-report-match", "ghost")}</div>
      <form class="radar-live__form" data-form="score" hidden><div class="radar-live__fields"><label class="radar-live__field"><span>Meu time</span><input name="mine" type="number" min="0" max="99" value="3" required></label><label class="radar-live__field"><span>Adversário</span><input name="other" type="number" min="0" max="99" value="1" required></label></div><div class="radar-live__form-actions">${formButton("Enviar placar")}</div></form>
      <form class="radar-live__form" data-form="review" hidden><div class="radar-live__fields">${["pontualidade", "organizacao", "comunicacao", "fair_play"].map(name => `<label class="radar-live__field"><span>${esc(name.replace("_", " "))}</span><select name="${name}"><option>5</option><option>4</option><option>3</option><option>2</option><option>1</option></select></label>`).join("")}<label class="radar-live__field"><span>Jogaria novamente</span><select name="jogaria"><option value="true">Sim</option><option value="false">Não</option></select></label></div><div class="radar-live__form-actions">${formButton("Enviar avaliação")}</div></form>
      <form class="radar-live__form" data-form="dispute" hidden><label class="radar-live__field"><span>Motivo</span><select name="reason"><option value="score_incorrect">Placar incorreto</option><option value="identity_fraud">Identidade</option><option value="other">Outro</option></select></label><div class="radar-live__form-actions">${formButton("Enviar contestação")}</div></form>
      <form class="radar-live__form" data-form="report-match" hidden><label class="radar-live__field"><span>Motivo</span><select name="category"><option value="unsafe_conduct">Conduta insegura</option><option value="harassment">Assédio</option><option value="spam">Spam</option><option value="other">Outro</option></select></label><div class="radar-live__form-actions">${formButton("Enviar denúncia")}</div></form>`);
  }

  function renderHistory() {
    const summary = state.data?.summary || {};
    const items = list(state.data?.items);
    return shell(`${heading("Histórico", "Meus amistosos", "Somente placares oficiais.")}
      <section class="radar-live__hero"><div class="radar-live__hero-row"><div><strong>${Number(summary.wins || 0)}V · ${Number(summary.draws || 0)}E · ${Number(summary.losses || 0)}D</strong><small>${Number(summary.goals_for || 0)} gols pró · ${Number(summary.goals_against || 0)} contra</small></div><strong class="radar-live__number">${Number(summary.official_matches || 0)}</strong></div></section>
      ${items.length ? `<section class="radar-live__list" style="margin-top:10px">${items.map((item, index) => `<article class="radar-live__card"><div class="radar-live__card-top"><div><strong>${esc(teamName(item))}</strong><p>${dateLabel(item.scheduled_at)} · ${esc(item.status || resultState(item))}</p></div><strong class="radar-live__score">${esc(scoreLabel(item) || "—")}</strong></div><div class="radar-live__actions">${button("Abrir", "open-history-match", "", `data-index="${index}"`)}</div></article>`).join("")}</section>` : stateCard("▤", "Sem histórico", "Partidas oficiais aparecerão aqui.")}`);
  }

  function renderReviews() {
    const items = list(state.data?.items);
    return shell(`${heading("Avaliações", "Pendentes", "Respostas anônimas.")}${items.length ? `<section class="radar-live__list">${items.map((item, index) => `<article class="radar-live__card"><div class="radar-live__card-top"><div><strong>${esc(teamName(item))}</strong><p>${dateLabel(item.scheduled_at)}</p></div>${chip("Pendente", "warn")}</div><div class="radar-live__actions">${button("Avaliar", "review-pending", "", `data-index="${index}"`)}</div></article>`).join("")}</section>` : stateCard("★", "Tudo avaliado", "Nenhuma pendência.")}`);
  }

  function renderReputation() {
    const reputation = state.data?.reputation || {};
    const metrics = reputation.criteria || reputation.metrics || reputation.scores || {};
    return shell(`${heading("Reputação", reputation.label || "Reputação nova", "Agregado verificado.")}
      <section class="radar-live__hero"><div class="radar-live__hero-row"><div><strong>${esc(reputation.team?.name || "Seu time")}</strong><small>${esc(reputation.state || "new")}</small></div><strong class="radar-live__number">${reputation.overall ? Number(reputation.overall).toFixed(1) : "—"}</strong></div><div class="radar-live__chips">${Object.entries(metrics).slice(0, 5).map(([key, value]) => chip(`${key.replaceAll("_", " ")}: ${value}`)).join("") || chip("Mínimo de 3 avaliações")}</div></section>`);
  }

  function renderNotifications() {
    const items = list(state.data?.items);
    return shell(`${heading("Avisos", "Notificações", "Atualizações internas.")}${items.length ? `<section class="radar-live__list">${items.map((item, index) => `<article class="radar-live__card"><div class="radar-live__card-top"><div><strong>${esc(item.event_type || item.type || "Radar")}</strong><p>${dateLabel(item.created_at)}</p></div>${chip(item.read_at ? "Lida" : "Nova", item.read_at ? "" : "ok")}</div>${!item.read_at ? `<div class="radar-live__actions">${button("Marcar como lida", "read-notification", "", `data-index="${index}"`)}</div>` : ""}</article>`).join("")}</section>` : stateCard("●", "Sem avisos", "Tudo em dia.")}`);
  }

  function renderSafety() {
    const blocks = list(state.data?.blocks?.items);
    const cases = list(state.data?.cases?.items);
    const searchItems = list(state.data?.teams?.items);
    return shell(`${heading("Proteção", "Segurança", "Ações privadas.")}
      <div class="radar-live__chips">${chip(`${blocks.length} bloqueados`)}${chip(`${cases.length} casos`)}</div>
      <form class="radar-live__form" data-form="block"><label class="radar-live__field"><span>Time</span><select name="team" required><option value="">Selecione</option>${searchItems.map(item => `<option value="${esc(teamPublicId(item))}">${esc(teamName(item))}</option>`).join("")}</select></label><label class="radar-live__field"><span>Motivo</span><select name="reason"><option value="conduct">Conduta</option><option value="unwanted_contact">Contato indesejado</option><option value="safety">Segurança</option><option value="other">Outro</option></select></label><div class="radar-live__form-actions">${formButton("Bloquear time")}</div></form>
      <form class="radar-live__form" data-form="report-team"><label class="radar-live__field"><span>Time</span><select name="team" required><option value="">Selecione</option>${searchItems.map(item => `<option value="${esc(teamPublicId(item))}">${esc(teamName(item))}</option>`).join("")}</select></label><label class="radar-live__field"><span>Motivo</span><select name="category"><option value="unsafe_conduct">Conduta insegura</option><option value="identity_fraud">Identidade</option><option value="spam">Spam</option><option value="other">Outro</option></select></label><div class="radar-live__form-actions">${formButton("Denunciar time")}</div></form>
      ${blocks.length ? `<section class="radar-live__list" style="margin-top:10px">${blocks.map((item, index) => `<article class="radar-live__card"><div class="radar-live__card-top"><div><strong>${esc(item.team?.name || "Time bloqueado")}</strong><p>Contato oculto</p></div>${chip("Bloqueado", "danger")}</div><div class="radar-live__actions">${button("Desbloquear", "unblock", "ghost", `data-index="${index}"`)}</div></article>`).join("")}</section>` : ""}
      ${cases.length ? `<section class="radar-live__list" style="margin-top:10px">${cases.map(item => `<article class="radar-live__card"><div class="radar-live__card-top"><div><strong>${esc(item.category)}</strong><p>${esc(item.status)} · Caso ${esc(item.case_id)}</p></div>${chip(`v${versionOf(item)}`)}</div></article>`).join("")}</section>` : ""}`);
  }

  function renderModeration() {
    const items = list(state.data?.items);
    return shell(`${heading("Admin", "Fila de moderação", "Somente funções ativas.")}${items.length ? `<section class="radar-live__list">${items.map((item, index) => `<article class="radar-live__card"><div class="radar-live__card-top"><div><strong>${esc(item.category)}</strong><p>${esc(item.type || item.case_type)} · ${esc(item.status)}</p></div>${chip(`v${versionOf(item)}`)}</div><div class="radar-live__actions">${button("Abrir caso", "open-case", "", `data-index="${index}"`)}</div></article>`).join("")}</section>` : stateCard("◆", "Fila vazia", "Nenhum caso pendente.")}`);
  }

  function renderCase() {
    const item = state.selected || {};
    return shell(`${heading("Moderação", item.category || "Caso", `Caso ${idOf(item)}`)}
      <section class="radar-live__hero"><div class="radar-live__hero-row"><div><strong>${esc(item.type || item.case_type)}</strong><small>${esc(item.description || item.private_description || "Sem descrição")}</small></div>${chip(item.status || "open", "warn")}</div></section>
      ${item.status === "open" ? `<div class="radar-live__actions">${button("Atribuir a mim", "assign-case")}</div>` : `<form class="radar-live__form" data-form="resolve-case"><label class="radar-live__field"><span>Decisão</span><select name="decision"><option value="warn">Orientar time</option><option value="dismiss">Arquivar</option><option value="suspend_team">Suspender time</option><option value="invalidate_review">Invalidar avaliação</option><option value="invalidate_result">Invalidar resultado</option></select></label><label class="radar-live__field"><span>Motivo</span><select name="reason"><option value="violation_confirmed">Violação confirmada</option><option value="no_violation">Sem violação</option><option value="insufficient_evidence">Provas insuficientes</option><option value="invalid_review">Avaliação inválida</option><option value="invalid_result">Resultado inválido</option></select></label><div class="radar-live__form-actions">${formButton("Registrar decisão")}</div></form>`}`);
  }

  function render() {
    if (!state.open) { root.hidden = true; return; }
    root.hidden = false;
    if (state.loading) root.innerHTML = renderLoading();
    else if (state.error) root.innerHTML = renderError();
    else {
      const views = {
        home: renderHome,
        availability: renderAvailability,
        search: renderSearch,
        invite: renderInvite,
        invitations: renderInvitations,
        "invitation-detail": renderInvitationDetail,
        matches: renderMatches,
        "match-detail": renderMatchDetail,
        history: renderHistory,
        reviews: renderReviews,
        reputation: renderReputation,
        notifications: renderNotifications,
        safety: renderSafety,
        moderation: renderModeration,
        "moderation-case": renderCase
      };
      root.innerHTML = (views[state.view] || renderHome)();
    }
    requestAnimationFrame(() => document.getElementById("radarLiveMain")?.focus({ preventScroll: true }));
  }

  function closeRadar() {
    state.open = false;
    root.hidden = true;
    document.body.style.overflow = "";
    for (const item of backgroundDialogs) {
      item.element.inert = item.inert;
      if (item.ariaHidden === null) item.element.removeAttribute("aria-hidden");
      else item.element.setAttribute("aria-hidden", item.ariaHidden);
    }
    backgroundDialogs = [];
    const target = returnFocus;
    returnFocus = null;
    requestAnimationFrame(() => target?.focus?.({ preventScroll: true }));
  }

  function revealForm(name) {
    const form = root.querySelector(`[data-form="${name}"]`);
    if (!form) return;
    form.removeAttribute("hidden");
    requestAnimationFrame(() => form.querySelector("input, select, textarea, button")?.focus({ preventScroll: true }));
  }

  function isolateBackgroundDialogs() {
    backgroundDialogs = [...document.querySelectorAll('[role="dialog"]')]
      .filter(item => !root.contains(item))
      .map(element => ({
        element,
        inert: element.inert,
        ariaHidden: element.getAttribute("aria-hidden")
      }));
    for (const item of backgroundDialogs) {
      item.element.inert = true;
      item.element.setAttribute("aria-hidden", "true");
    }
  }

  async function requestView(view) {
    if (view === "home") {
      const [profile, eligibility, notifications] = await Promise.all([
        api.getRadarProfile(), api.getEligibility(), api.listNotifications()
      ]);
      return { ...payload(profile), ...payload(eligibility), notifications: payload(notifications) };
    }
    if (view === "availability") return payload(await api.listAvailabilities());
    if (view === "search") return payload(await api.listNearbyTeams(state.filters));
    if (view === "invitations") return payload(await api.listInvitations(state.invitationBox));
    if (view === "matches") return payload(await api.listMatches("todas"));
    if (view === "history") return payload(await api.listMatchHistory({ periodo: "all", situacao: "all" }));
    if (view === "reviews") return payload(await api.listPendingEvaluations());
    if (view === "reputation") return payload(await api.getOwnReputation());
    if (view === "notifications") return payload(await api.listNotifications());
    if (view === "safety") {
      const [blocks, cases, teams] = await Promise.all([
        api.listRadarBlocks(), api.listRadarReports(), api.listNearbyTeams({ radiusKm: 50 })
      ]);
      return { blocks: payload(blocks), cases: payload(cases), teams: payload(teams) };
    }
    if (view === "moderation") return payload(await api.listModerationQueue());
    return state.data;
  }

  async function load(view, options = {}) {
    if (!options.replace && state.view !== view) state.stack.push(state.view);
    state.view = view;
    state.loading = true;
    state.error = null;
    render();
    try {
      state.data = await requestView(view);
    } catch (error) {
      state.error = error;
    } finally {
      state.loading = false;
      render();
    }
  }

  async function mutate(work, nextView = state.view) {
    if (state.busy) return;
    state.busy = true;
    state.error = null;
    render();
    try {
      await work();
      state.busy = false;
      await load(nextView, { replace: true });
    } catch (error) {
      state.busy = false;
      state.loading = false;
      state.error = error;
      render();
    }
  }

  async function openMatch(item) {
    state.selected = item;
    state.stack.push(state.view);
    state.view = "match-detail";
    state.loading = true;
    render();
    try {
      const response = await api.getMatch(idOf(item));
      state.selected = payload(response).match || payload(response);
      state.selectedEtag = response.etag || etagOf(state.selected);
      state.error = null;
    } catch (error) { state.error = error; }
    state.loading = false;
    render();
  }

  async function probe() {
    if (!token()) {
      entries.forEach(item => { item.hidden = true; item.dataset.radarAllowed = "false"; });
      return false;
    }
    try {
      const response = await api.getEligibility();
      const eligibility = payload(response).eligibility || {};
      entries.forEach(item => {
        item.hidden = false;
        item.querySelector("span").textContent = eligibility.eligible ? "Time elegível" : "Configurar Radar";
        item.dataset.radarAllowed = "true";
        delete item.dataset.radarError;
        delete item.dataset.radarStatus;
      });
      return true;
    } catch (error) {
      entries.forEach(item => {
        if ([401, 403, 404].includes(error.status)) item.hidden = true;
        item.dataset.radarAllowed = "false";
        item.dataset.radarError = String(error.code || "RADAR_UNAVAILABLE");
        item.dataset.radarStatus = String(Number(error.status) || 0);
      });
      return false;
    }
  }

  entries.forEach(item => item.addEventListener("click", async () => {
    if (item.dataset.radarAllowed !== "true" && !(await probe())) return;
    returnFocus = item;
    isolateBackgroundDialogs();
    state.open = true;
    state.stack = [];
    state.view = "home";
    document.body.style.overflow = "hidden";
    await load("home", { replace: true });
  }));

  root.addEventListener("click", async event => {
    const target = event.target.closest("[data-action]");
    if (!target) return;
    const action = target.dataset.action;
    if (action === "close") {
      closeRadar(); return;
    }
    if (action === "back") {
      const previous = state.stack.pop() || "home";
      await load(previous, { replace: true }); return;
    }
    if (action === "refresh") { await load(state.view, { replace: true }); return; }
    if (action === "nav") { await load(target.dataset.view); return; }
    if (action === "select-team") {
      state.selected = list(state.data?.items)[Number(target.dataset.index)];
      state.stack.push(state.view); state.view = "invite"; state.data = null; render(); return;
    }
    if (action === "invitation-box") { state.invitationBox = target.dataset.box; await load("invitations", { replace: true }); return; }
    if (action === "open-invitation") {
      state.selected = list(state.data?.items)[Number(target.dataset.index)]; state.selectedEtag = etagOf(state.selected);
      state.stack.push(state.view); state.view = "invitation-detail"; render(); return;
    }
    if (action === "show-counter") { revealForm("counter"); return; }
    if (action === "accept-invitation") await mutate(() => api.acceptInvitation(idOf(state.selected), state.selectedEtag), "matches");
    if (action === "decline-invitation") await mutate(() => api.declineInvitation(idOf(state.selected), state.selectedEtag), "invitations");
    if (action === "cancel-invitation") await mutate(() => api.cancelInvitation(idOf(state.selected), state.selectedEtag), "invitations");
    if (action === "open-match" || action === "open-history-match") { await openMatch(list(state.data?.items)[Number(target.dataset.index)]); return; }
    if (action === "confirm-occurrence") await mutate(() => api.confirmMatchOccurrence(idOf(state.selected), state.selectedEtag), "matches");
    if (action === "show-score") { revealForm("score"); return; }
    if (action === "confirm-score") await mutate(() => api.confirmMatchResult(idOf(state.selected), state.selectedEtag), "matches");
    if (action === "show-review") { revealForm("review"); return; }
    if (action === "show-dispute") { revealForm("dispute"); return; }
    if (action === "show-report-match") { revealForm("report-match"); return; }
    if (action === "review-pending") { await openMatch(list(state.data?.items)[Number(target.dataset.index)]); revealForm("review"); return; }
    if (action === "read-notification") {
      const item = list(state.data?.items)[Number(target.dataset.index)];
      await mutate(() => api.readNotification(idOf(item)), "notifications");
    }
    if (action === "unblock") {
      const item = list(state.data?.blocks?.items)[Number(target.dataset.index)];
      await mutate(() => api.unblockRadarTeam(item.team?.public_id), "safety");
    }
    if (action === "open-case") {
      state.selected = list(state.data?.items)[Number(target.dataset.index)]; state.selectedEtag = etagOf(state.selected);
      state.stack.push(state.view); state.view = "moderation-case"; render(); return;
    }
    if (action === "assign-case") await mutate(async () => {
      const response = await api.assignModerationCase(idOf(state.selected), "triage", state.selectedEtag);
      state.selected = payload(response).case; state.selectedEtag = response.etag || etagOf(state.selected);
    }, "moderation");
  });

  root.addEventListener("submit", async event => {
    event.preventDefault();
    const form = event.target;
    const values = Object.fromEntries(new FormData(form).entries());
    if (form.dataset.form === "availability") await mutate(() => api.createAvailability({
      modality: values.modality, category: values.category,
      starts_at: toIso(values.starts_at), ends_at: toIso(values.ends_at),
      travel_radius_km: Number(values.travel_radius_km), venue_preference: values.venue_preference,
      status: "active"
    }), "availability");
    if (form.dataset.form === "search") {
      state.filters = { ...state.filters, modality: values.modality, category: values.category, radiusKm: Number(values.radiusKm) };
      await load("search", { replace: true });
    }
    if (form.dataset.form === "invitation") await mutate(() => api.createInvitation({
      opponent_slug: teamSlug(state.selected), starts_at: toIso(values.starts_at), ends_at: toIso(values.ends_at),
      modality: values.modality, category: values.category,
      venue_preference: values.venue_preference, message: values.message
    }), "invitations");
    if (form.dataset.form === "counter") await mutate(() => api.counterInvitation(idOf(state.selected), {
      starts_at: toIso(values.starts_at), ends_at: toIso(values.ends_at),
      modality: state.selected.proposal?.modality || "society",
      category: state.selected.proposal?.category || "Livre",
      venue_preference: state.selected.proposal?.venue_preference || "either",
      message: "Contraproposta pelo Radar"
    }, state.selectedEtag), "invitations");
    if (form.dataset.form === "score") await mutate(() => api.submitMatchResult(idOf(state.selected), {
      gols_meu_time: Number(values.mine), gols_adversario: Number(values.other)
    }, state.selectedEtag), "matches");
    if (form.dataset.form === "review") await mutate(() => api.submitMatchEvaluation(idOf(state.selected), {
      pontualidade: Number(values.pontualidade), organizacao: Number(values.organizacao),
      comunicacao: Number(values.comunicacao), fair_play: Number(values.fair_play),
      jogaria_novamente: values.jogaria === "true"
    }), "reviews");
    if (form.dataset.form === "dispute") await mutate(() => api.disputeMatchResult(idOf(state.selected), values.reason, "Contestação local estruturada"), "safety");
    if (form.dataset.form === "report-match") await mutate(() => api.reportRadarMatch(idOf(state.selected), values.category, "Denúncia local estruturada"), "safety");
    if (form.dataset.form === "block") await mutate(() => api.blockRadarTeam(values.team, values.reason), "safety");
    if (form.dataset.form === "report-team") await mutate(() => api.reportRadarTeam(values.team, values.category, "Denúncia local estruturada"), "safety");
    if (form.dataset.form === "resolve-case") await mutate(() => api.resolveModerationCase(
      idOf(state.selected), values.decision, values.reason, state.selectedEtag
    ), "moderation");
  });

  document.getElementById("btnPerfilTime")?.addEventListener("click", () => setTimeout(probe, 120));
  window.addEventListener("focus", probe);
  window.addEventListener("radar:refresh-access", probe);
  document.addEventListener("keydown", event => {
    if (event.key === "Escape" && state.open) {
      event.preventDefault();
      if (state.stack.length) root.querySelector('[data-action="back"]')?.click();
      else root.querySelector('[data-action="close"]')?.click();
    }
    if (event.key === "Tab" && state.open) {
      const panel = root.querySelector(".radar-live__panel");
      const focusable = [...(panel?.querySelectorAll('button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [href], [tabindex]:not([tabindex="-1"])') || [])]
        .filter(item => !item.closest("[hidden]") && item.getClientRects().length > 0);
      if (!focusable.length) return;
      const first = focusable[0];
      const last = focusable[focusable.length - 1];
      if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last.focus(); }
      else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first.focus(); }
    }
  });

  window.RadarReal = Object.freeze({
    mode: "real-api",
    apiBase: resolvedApiBase,
    environment,
    probe,
    open: () => entry.click(),
    getProof: () => state.traces.map(item => ({ ...item })),
    getState: () => ({ view: state.view, open: state.open, loading: state.loading, error: state.error?.code || null })
  });

  probe();
})();
