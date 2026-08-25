(function () {
  "use strict";

  const data = window.RadarDemoData;

  function esc(value) {
    return String(value == null ? "" : value)
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;")
      .replace(/'/g, "&#039;");
  }

  function selected(current, value) {
    return current === value ? " selected" : "";
  }

  function icon(name) {
    const paths = {
      home: '<path d="M3 10.5 12 3l9 7.5v9a1.5 1.5 0 0 1-1.5 1.5h-15A1.5 1.5 0 0 1 3 19.5z"/><path d="M9 21v-7h6v7"/>',
      radar: '<circle cx="12" cy="12" r="8"/><circle cx="12" cy="12" r="2"/><path d="M12 2v2m10 8h-2m-8 10v-2M2 12h2m8 0 5-5"/>',
      list: '<path d="M8 6h13M8 12h13M8 18h13"/><circle cx="3.5" cy="6" r=".5"/><circle cx="3.5" cy="12" r=".5"/><circle cx="3.5" cy="18" r=".5"/>',
      check: '<path d="m5 12 4 4L19 6"/>',
      shield: '<path d="M12 3 4.5 6v5.5c0 4.7 3.1 8 7.5 9.5 4.4-1.5 7.5-4.8 7.5-9.5V6z"/><path d="m8.5 12 2.2 2.2 4.8-5"/>',
      calendar: '<rect x="3" y="5" width="18" height="16" rx="2"/><path d="M16 3v4M8 3v4M3 10h18"/>',
      user: '<circle cx="12" cy="8" r="4"/><path d="M4 21a8 8 0 0 1 16 0"/>',
      arrow: '<path d="m9 18 6-6-6-6"/>',
      back: '<path d="m15 18-6-6 6-6"/>',
      upload: '<path d="M12 16V4m0 0L7 9m5-5 5 5"/><path d="M4 15v4a1 1 0 0 0 1 1h14a1 1 0 0 0 1-1v-4"/>',
      edit: '<path d="M4 20h4l11-11-4-4L4 16z"/><path d="m13.5 6.5 4 4"/>',
      more: '<circle cx="5" cy="12" r="1"/><circle cx="12" cy="12" r="1"/><circle cx="19" cy="12" r="1"/>',
      lock: '<rect x="5" y="10" width="14" height="11" rx="2"/><path d="M8 10V7a4 4 0 0 1 8 0v3"/>',
      location: '<path d="M20 10c0 5-8 11-8 11S4 15 4 10a8 8 0 1 1 16 0z"/><circle cx="12" cy="10" r="2.5"/>',
      close: '<path d="m6 6 12 12M18 6 6 18"/>',
      eye: '<path d="M2 12s3.5-6 10-6 10 6 10 6-3.5 6-10 6S2 12 2 12z"/><circle cx="12" cy="12" r="2.5"/>',
      filter: '<path d="M4 5h16M7 12h10M10 19h4"/>',
      star: '<path d="m12 3 2.8 5.7 6.2.9-4.5 4.4 1.1 6.2-5.6-2.9-5.6 2.9 1.1-6.2L3 9.6l6.2-.9z"/>',
      clock: '<circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/>',
      bell: '<path d="M18 8a6 6 0 0 0-12 0c0 7-3 7-3 9h18c0-2-3-2-3-9"/><path d="M10 21h4"/>',
      send: '<path d="m22 2-7 20-4-9-9-4z"/><path d="M22 2 11 13"/>',
      trophy: '<path d="M8 4h8v4a4 4 0 0 1-8 0z"/><path d="M8 6H5a2 2 0 0 0 2 3M16 6h3a2 2 0 0 1-2 3M12 12v5m-4 3h8M9 17h6"/>',
      alert: '<path d="M12 3 2.5 20h19z"/><path d="M12 9v5m0 3h.01"/>'
    };
    return `<svg class="icon" aria-hidden="true" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">${paths[name] || paths.radar}</svg>`;
  }

  function button(label, options) {
    const opts = options || {};
    return `<button class="button ${opts.kind ? `button--${opts.kind}` : "button--primary"}${opts.full ? " button--full" : ""}" type="${opts.type || "button"}"${opts.action ? ` data-action="${esc(opts.action)}"` : ""}${opts.target ? ` data-target="${esc(opts.target)}"` : ""}${opts.id ? ` data-id="${esc(opts.id)}"` : ""}${opts.disabled ? " disabled" : ""}>${opts.icon ? icon(opts.icon) : ""}<span>${esc(label)}</span>${opts.trailing ? icon(opts.trailing) : ""}</button>`;
  }

  function statusPill(status) {
    const labels = {
      active: ["Ativa", "success"],
      paused: ["Pausada", "warning"],
      cancelled: ["Cancelada", "neutral"],
      pending: ["Em análise", "warning"],
      verified: ["Verificado", "success"]
    };
    const item = labels[status] || [status, "neutral"];
    return `<span class="status status--${item[1]}"><span class="status__dot"></span>${esc(item[0])}</span>`;
  }

  function crest(initials, extraClass) {
    return `<span class="team-crest ${extraClass || ""}" aria-label="Escudo demonstrativo do time"><span>${esc(initials)}</span></span>`;
  }

  function screenHeader(eyebrow, title, description, actionHtml) {
    return `<header class="screen-header">
      <div>
        <p class="eyebrow">${esc(eyebrow)}</p>
        <h1>${esc(title)}</h1>
        ${description ? `<p class="screen-header__description">${esc(description)}</p>` : ""}
      </div>
      ${actionHtml ? `<div class="screen-header__action">${actionHtml}</div>` : ""}
    </header>`;
  }

  function renderHome(state) {
    const profile = state.profile;
    return `<div class="screen screen--home">
      ${screenHeader("Meu time", "Central do time", "Tudo do clube em um lugar.")}
      <section class="team-summary card" aria-label="Resumo do time">
        <div class="team-summary__identity">
          ${crest(profile.crestInitials)}
          <div><h2>${esc(profile.teamName)}</h2><p>${icon("location")} ${esc(profile.city)}, ${esc(profile.state)}</p></div>
        </div>
        <div class="team-summary__metrics" aria-label="Números do time">
          <div><strong>24</strong><span>jogadores</span></div>
          <div><strong>8</strong><span>partidas</span></div>
          <div><strong>4,8</strong><span>conduta</span></div>
        </div>
        <button class="quiet-link" type="button" data-action="preview-team">${icon("eye")} Ver perfil público</button>
      </section>

      <section class="feature-card" aria-labelledby="feature-title">
        <div class="feature-card__copy">
          <p class="eyebrow eyebrow--gold">Radar de Amistosos</p>
          <h2 id="feature-title">Ache seu próximo rival</h2>
          <p>Times compatíveis perto de você.</p>
          <div class="feature-card__actions">
            ${button("Encontrar amistoso", { action: "navigate", target: "opponents", trailing: "arrow" })}
            <span>${icon("shield")} Contato protegido</span>
          </div>
        </div>
        <div class="radar-visual" aria-hidden="true">
          <div class="radar-visual__ring radar-visual__ring--one"></div>
          <div class="radar-visual__ring radar-visual__ring--two"></div>
          <div class="radar-visual__sweep"></div>
          <span class="radar-visual__point radar-visual__point--a"></span>
          <span class="radar-visual__point radar-visual__point--b"></span>
          <span class="radar-visual__point radar-visual__point--c"></span>
          <div class="radar-visual__center">${crest("EN", "team-crest--small")}</div>
        </div>
      </section>

      <section class="quick-grid" aria-label="Atalhos do clube">
        <button class="quick-card" type="button" data-action="navigate" data-target="profile-manual"><span>${icon("user")}</span><strong>Perfil</strong></button>
        <button class="quick-card" type="button" data-action="navigate" data-target="availabilities"><span>${icon("calendar")}</span><strong>Disponibilidades</strong></button>
        <button class="quick-card" type="button" data-action="navigate" data-target="invitations"><span>${icon("send")}</span><strong>Convites</strong></button>
      </section>
    </div>`;
  }

  function eligibilityItems(state) {
    const verified = state.verification.status === "verified";
    const profileReady = state.profileReady;
    return [
      { label: "Perfil público", detail: "Visível no Radar", ready: true },
      { label: "Cidade e estado", detail: `${state.profile.city}, ${state.profile.state}`, ready: true },
      { label: "Dados esportivos", detail: profileReady ? `${state.profile.modality} · ${state.profile.category}` : "Complete os campos", ready: profileReady },
      { label: "Instagram", detail: verified ? "Verificado" : state.verification.status === "pending" ? "Em análise" : "Falta verificar", ready: verified, pending: state.verification.status === "pending" },
      { label: "Termos", detail: "Aceitos", ready: true }
    ];
  }

  function renderEligibility(state) {
    const items = eligibilityItems(state);
    const completed = items.filter((item) => item.ready).length;
    const verified = state.verification.status === "verified";
    return `<div class="screen screen--narrow">
      ${screenHeader("Radar", "Preparar o time", "Complete os itens abaixo.")}
      <section class="progress-card card">
        <div class="progress-card__top"><span>${completed} de ${items.length} etapas prontas</span><strong>${Math.round((completed / items.length) * 100)}%</strong></div>
        <div class="progress-track" aria-label="${completed} de ${items.length} etapas prontas"><span style="width:${(completed / items.length) * 100}%"></span></div>
      </section>
      <section class="checklist" aria-label="Requisitos do Radar">
        ${items.map((item) => `<article class="check-item${item.ready ? " check-item--ready" : ""}${item.pending ? " check-item--pending" : ""}">
          <span class="check-item__icon">${item.ready ? icon("check") : item.pending ? icon("more") : icon("lock")}</span>
          <div><h2>${esc(item.label)}</h2><p>${esc(item.detail)}</p></div>
          <span class="check-item__state">${item.ready ? "Pronto" : item.pending ? "Em análise" : "Pendente"}</span>
        </article>`).join("")}
      </section>
      ${verified ? `<div class="action-panel action-panel--success"><div>${icon("shield")}<strong>Time pronto</strong></div>${button("Criar disponibilidade", { action: "new-availability", full: true, trailing: "arrow" })}</div>`
        : `<div class="action-panel"><strong>Complete o perfil</strong>${button("Usar print", { action: "navigate", target: "print-import", full: true, icon: "upload" })}<details><summary>Outra opção</summary>${button("Preencher manualmente", { action: "navigate", target: "profile-manual", full: true, kind: "secondary" })}</details></div>`}
    </div>`;
  }

  function renderManualProfile(state) {
    const p = state.profile;
    return `<div class="screen screen--form">
      ${screenHeader("Cadastro", "Perfil do time", "Revise os dados públicos.")}
      <form class="form-card card" data-form="manual-profile">
        <div class="form-section-heading"><span>01</span><div><h2>Identidade</h2></div></div>
        <div class="field-grid field-grid--two">
          <label class="field field--wide"><span>Nome do time</span><input name="teamName" maxlength="70" required value="${esc(p.teamName)}"></label>
          <label class="field"><span>Instagram</span><input name="instagram" maxlength="40" required value="${esc(p.instagram)}" inputmode="text"></label>
          <label class="field"><span>Cidade</span><input name="city" maxlength="60" required value="${esc(p.city)}"></label>
          <label class="field"><span>Estado</span><select name="state" required><option value="SC"${selected(p.state, "SC")}>Santa Catarina</option><option value="PR"${selected(p.state, "PR")}>Paraná</option><option value="RS"${selected(p.state, "RS")}>Rio Grande do Sul</option></select></label>
        </div>
        <div class="form-divider"></div>
        <div class="form-section-heading"><span>02</span><div><h2>Perfil esportivo</h2></div></div>
        <div class="field-grid field-grid--three">
          <label class="field"><span>Modalidade</span><select name="modality"><option${selected(p.modality, "Futebol society")}>Futebol society</option><option${selected(p.modality, "Futsal")}>Futsal</option><option${selected(p.modality, "Campo")}>Campo</option></select></label>
          <label class="field"><span>Categoria</span><select name="category"><option${selected(p.category, "Livre")}>Livre</option><option${selected(p.category, "Veterano")}>Veterano</option><option${selected(p.category, "Sub-20")}>Sub-20</option></select></label>
          <label class="field"><span>Nível</span><select name="level"><option${selected(p.level, "Iniciante")}>Iniciante</option><option${selected(p.level, "Intermediário")}>Intermediário</option><option${selected(p.level, "Competitivo")}>Competitivo</option></select></label>
          <label class="field field--wide"><span>Sobre o time</span><textarea name="summary" rows="3" maxlength="240">${esc(p.summary)}</textarea></label>
        </div>
        <label class="consent"><input type="checkbox" required checked><span>${icon("check")}</span><span>Perfil público e termos aceitos.</span></label>
        <div class="form-actions">${button("Voltar", { action: "back", kind: "ghost" })}${button("Salvar e continuar", { type: "submit", trailing: "arrow" })}</div>
      </form>
    </div>`;
  }

  function previewMarkup(state) {
    if (!state.importedPreview) return "";
    if (state.importedPreview === "demo") {
      return `<div class="instagram-preview instagram-preview--demo" role="img" aria-label="Prévia fictícia de um perfil do Instagram">
        <div class="instagram-preview__bar"><span></span><strong>Instagram</strong><span>•••</span></div>
        <div class="instagram-preview__profile">${crest("EN", "team-crest--tiny")}<div><strong>estreladonortefc</strong><small>Estrela do Norte FC · Joinville</small></div></div>
        <div class="instagram-preview__stats"><span><strong>148</strong> publicações</span><span><strong>2,4 mil</strong> seguidores</span><span><strong>312</strong> seguindo</span></div>
        <div class="instagram-preview__tiles"><span></span><span></span><span></span></div>
      </div>`;
    }
    return `<div class="instagram-preview"><img src="${esc(state.importedPreview)}" alt="Prévia local do print selecionado"></div>`;
  }

  function renderPrintImport(state) {
    return `<div class="screen screen--narrow">
      ${screenHeader("Cadastro", "Importar print", "Crie um rascunho editável.")}
      <div class="info-strip">${icon("shield")} <span>Imagem somente neste navegador.</span></div>
      <section class="upload-card card${state.importedPreview ? " upload-card--has-preview" : ""}">
        ${previewMarkup(state) || `<div class="upload-card__empty"><span class="upload-card__icon">${icon("upload")}</span><h2>Escolha um print</h2><p>Mostre nome, bio e escudo.</p></div>`}
        <div class="upload-card__actions">
          <label class="button button--secondary button--full" for="profile-print">${icon("upload")}<span>${state.importedPreview ? "Trocar imagem" : "Escolher imagem"}</span></label>
          <input class="sr-only" id="profile-print" type="file" accept="image/png,image/jpeg,image/webp" data-input="profile-print">
          ${button("Usar print demonstrativo", { action: "demo-print", kind: "ghost", full: true })}
        </div>
      </section>
      <details class="compact-details card"><summary>Detalhes</summary><p>O rascunho precisa de revisão e não verifica o Instagram.</p></details>
      ${button("Criar rascunho do perfil", { action: "create-draft", full: true, trailing: "arrow", disabled: !state.importedPreview })}
    </div>`;
  }

  function renderDraftReview(state) {
    const d = state.draft;
    return `<div class="screen screen--form">
      ${screenHeader("Rascunho", "Revisar rascunho", "Corrija o que precisar.")}
      <div class="draft-layout">
        <aside class="draft-source card">
          <div class="draft-source__label">PRINT USADO</div>
          ${previewMarkup({ importedPreview: state.importedPreview || "demo" })}
          <div class="confidence"><div><span>Confiança do rascunho</span><strong>${d.confidence}%</strong></div><span><i style="width:${d.confidence}%"></i></span></div>
          <p>${icon("shield")} Ainda não publicado.</p>
        </aside>
        <form class="form-card card" data-form="draft-review">
          <div class="form-section-heading"><span>${icon("edit")}</span><div><h2>Dados encontrados</h2></div></div>
          <div class="field-grid field-grid--two">
            <label class="field field--wide"><span>Nome do time</span><input name="teamName" required value="${esc(d.teamName)}"></label>
            <label class="field"><span>Instagram</span><input name="instagram" required value="${esc(d.instagram)}"></label>
            <label class="field"><span>Cidade</span><input name="city" required value="${esc(d.city)}"></label>
            <label class="field"><span>Estado</span><select name="state"><option value="SC" selected>Santa Catarina</option><option value="PR">Paraná</option></select></label>
            <label class="field"><span>Modalidade</span><select name="modality"><option selected>Futebol society</option><option>Futsal</option><option>Campo</option></select></label>
            <label class="field"><span>Categoria</span><select name="category"><option selected>Livre</option><option>Veterano</option><option>Sub-20</option></select></label>
            <label class="field"><span>Nível</span><select name="level"><option>Iniciante</option><option selected>Intermediário</option><option>Competitivo</option></select></label>
            <label class="field field--wide"><span>Sobre o time</span><textarea name="summary" rows="3">${esc(d.summary)}</textarea></label>
          </div>
          <div class="review-warning">${icon("eye")} <span>Confira cidade e categoria.</span></div>
          <div class="form-actions">${button("Voltar ao print", { action: "navigate", target: "print-import", kind: "ghost" })}${button("Confirmar rascunho", { type: "submit", trailing: "arrow" })}</div>
        </form>
      </div>
    </div>`;
  }

  function renderVerification(state) {
    const verification = state.verification;
    if (verification.status === "pending") return renderPendingVerification(state);
    if (verification.status === "verified") return renderApprovedVerification(state);
    const challenge = verification.status === "challenge";
    return `<div class="screen screen--narrow">
      ${screenHeader("Segurança", "Verificar Instagram", "Comprove o controle do perfil.")}
      <section class="verification-hero card">
        <div class="instagram-mark">◎</div>
        <div><p>Perfil</p><h2>${esc(state.profile.instagram)}</h2><span>${icon("lock")} Acesso do responsável</span></div>
      </section>
      ${challenge ? `<section class="challenge-card">
        <div class="challenge-card__top"><span>SEU CÓDIGO TEMPORÁRIO</span>${statusPill("pending")}</div>
        <button class="challenge-code" type="button" data-action="copy-code" aria-label="Copiar código demonstrativo">MCF<span>-</span>4827 ${icon("edit")}</button>
        <p>Código fictício e temporário.</p>
      </section>
      <section class="steps-card card"><h2>Três passos</h2><ol>
        <li><span>1</span><div><strong>Copie o código</strong></div></li>
        <li><span>2</span><div><strong>Coloque na bio</strong></div></li>
        <li><span>3</span><div><strong>Envie para análise</strong></div></li>
      </ol></section>
      ${button("Já coloquei o código na bio", { action: "confirm-verification", full: true, trailing: "arrow" })}`
      : `<section class="explain-card card">
        <div class="explain-card__visual">${icon("shield")}<span>${icon("check")}</span></div>
        <h2>Controle do perfil</h2>
        <p>Use um código temporário na bio.</p>
        <ul><li>${icon("check")} Código protegido</li><li>${icon("check")} Revisão humana</li></ul>
      </section>
      ${button("Gerar código demonstrativo", { action: "start-verification", full: true, trailing: "arrow" })}`}
      <p class="privacy-note">${icon("lock")} Nunca pedimos sua senha.</p>
    </div>`;
  }

  function renderPendingVerification(state) {
    return `<div class="screen screen--narrow state-centered">
      ${screenHeader("Instagram", "Em análise", "A revisão está na fila.")}
      <section class="state-illustration state-illustration--pending"><span class="state-illustration__ring"></span>${icon("more")}</section>
      ${statusPill("pending")}
      <h2>${esc(state.profile.instagram)}</h2>
      <div class="review-timeline card"><div class="done">${icon("check")}<span><strong>Solicitação criada</strong></span></div><div class="done">${icon("check")}<span><strong>Bio confirmada</strong></span></div><div class="current">${icon("more")}<span><strong>Revisão</strong></span></div></div>
      <div class="demo-action-box">${button("Simular aprovação", { action: "approve-verification", full: true })}</div>
    </div>`;
  }

  function renderApprovedVerification(state) {
    return `<div class="screen screen--narrow state-centered">
      ${screenHeader("Instagram", "Time verificado", "Perfil liberado no Radar.")}
      <section class="success-seal">${icon("shield")}<span>${icon("check")}</span></section>
      ${statusPill("verified")}
      <h2>${esc(state.profile.teamName)}</h2>
      <p>${esc(state.profile.instagram)} · ${esc(state.profile.city)}, ${esc(state.profile.state)}</p>
      <div class="verified-benefits card"><div>${icon("check")} Controle aprovado</div><div>${icon("check")} Radar liberado</div><div>${icon("lock")} Contato protegido</div></div>
      ${button("Criar primeira disponibilidade", { action: "new-availability", full: true, trailing: "arrow" })}
      ${button("Voltar à elegibilidade", { action: "navigate", target: "eligibility", kind: "ghost", full: true })}
    </div>`;
  }

  function availabilityCard(item) {
    const disabled = item.status === "cancelled";
    return `<article class="availability-card card availability-card--${esc(item.status)}">
      <div class="availability-card__top"><div>${statusPill(item.status)}<span class="availability-card__type">${esc(item.category)} · ${esc(item.level)}</span></div><button class="icon-button" type="button" data-action="availability-details" data-id="${esc(item.id)}" aria-label="Ver detalhes">${icon("more")}</button></div>
      <h2>${esc(item.title)}</h2>
      <div class="availability-card__facts"><span>${icon("calendar")}<strong>${esc(item.dateLabel)}</strong><small>${esc(item.period)}</small></span><span>${icon("location")}<strong>${esc(item.city)}</strong><small>${esc(item.radius)}</small></span></div>
      <details class="compact-details"><summary>Detalhes</summary><p>${esc(item.notes)}</p></details>
      <div class="availability-card__footer"><span>${icon("shield")} ${esc(item.homeAway)}</span><div>
        ${button("Editar", { action: "edit-availability", id: item.id, kind: "small", icon: "edit", disabled })}
        ${button(item.status === "paused" ? "Reativar" : "Pausar", { action: "toggle-availability", id: item.id, kind: "small", disabled })}
        ${button("Cancelar", { action: "cancel-availability", id: item.id, kind: "danger-small", disabled })}
      </div></div>
    </article>`;
  }

  function renderAvailabilities(state) {
    const activeCount = state.availabilities.filter((item) => item.status === "active").length;
    return `<div class="screen screen--wide">
      ${screenHeader("Radar", "Disponibilidades", `${activeCount} ${activeCount === 1 ? "ativa" : "ativas"}.`, button("Nova", { action: "new-availability", icon: "calendar" }))}
      <div class="radar-indicator card"><span><i></i> Radar ativo</span><strong>${esc(state.profile.city)} · 25 km</strong></div>
      <section class="availability-grid" aria-label="Lista de disponibilidades">
        ${state.availabilities.length ? state.availabilities.map(availabilityCard).join("") : renderInlineEmpty()}
      </section>
      <section class="opponents-section">
        <div class="section-title"><div><p class="eyebrow">Por perto</p><h2>Times compatíveis</h2></div><button class="quiet-link" type="button" data-action="navigate" data-target="opponents">Ver todos</button></div>
        <div class="opponent-grid">${data.suggestedOpponents.map((team) => `<article class="opponent-card card">${crest(team.initials, "team-crest--small")}<div><h3>${esc(team.name)} ${team.verified ? `<span title="Perfil verificado">${icon("check")}</span>` : ""}</h3><p>${esc(team.distance)} · ${esc(team.level)}</p><small>${icon("shield")} ${esc(team.conduct)}</small></div><button class="icon-button" type="button" data-action="notify-opponent" aria-label="Ver ${esc(team.name)}">${icon("arrow")}</button></article>`).join("")}</div>
      </section>
    </div>`;
  }

  function filteredOpponents(state) {
    const filters = state.opponentFilters;
    return data.nearbyTeams.filter((team) => {
      if (team.publicId && state.blockedTeamIds.includes(team.publicId)) return false;
      if (filters.modality !== "Todas" && team.modality !== filters.modality) return false;
      if (filters.category !== "Todas" && team.category !== filters.category) return false;
      if (filters.level !== "Qualquer" && team.level !== filters.level) return false;
      if (!["Qualquer", "Próximos 30 dias"].includes(filters.day) && team.day !== filters.day) return false;
      if (filters.period !== "Qualquer" && team.period !== filters.period) return false;
      if (filters.venue !== "Casa ou fora" && team.venue !== filters.venue) return false;
      if (team.distanceKm !== null && team.distanceKm > Number(filters.radiusKm)) return false;
      return true;
    }).sort((first, second) => second.compatibility - first.compatibility ||
      (first.distanceKm ?? Number.MAX_SAFE_INTEGER) - (second.distanceKm ?? Number.MAX_SAFE_INTEGER) ||
      first.slug.localeCompare(second.slug, "pt-BR"));
  }

  function opponentDistance(team) {
    return team.distanceKm === null ? "mesma cidade" : `${team.distanceKm} km aproximadamente`;
  }

  function opponentCard(team) {
    return `<article class="nearby-card card" data-team-slug="${esc(team.slug)}">
      <div class="nearby-card__top">
        ${crest(team.initials, "team-crest--opponent")}
        <div class="nearby-card__identity"><h2>${esc(team.name)}</h2><p>${icon("location")} ${esc(team.city)} · ${esc(opponentDistance(team))}</p></div>
        <div class="compatibility-score"><strong>${esc(team.compatibility)}%</strong><span>compatível</span></div>
      </div>
      <div class="nearby-card__availability">${icon("calendar")}<div><span>Próximo horário</span><strong>${esc(team.availability)}</strong></div></div>
      <div class="nearby-card__footer">${button("Ver time", { action: "view-opponent", id: team.slug, trailing: "arrow", full: true })}</div>
    </article>`;
  }

  function activeOpponentFilterCount(filters) {
    return [
      filters.modality !== "Todas",
      filters.category !== "Todas",
      filters.level !== "Qualquer",
      filters.day !== "Qualquer",
      filters.period !== "Qualquer",
      Number(filters.radiusKm) < 25,
      filters.venue !== "Casa ou fora"
    ].filter(Boolean).length;
  }

  function renderOpponentEmpty() {
    return `<section class="search-empty card" aria-labelledby="search-empty-title">
      <span class="search-empty__visual">${icon("radar")}</span>
      <p class="eyebrow">Nenhum resultado</p>
      <h2 id="search-empty-title">Nenhum time compatível por perto</h2>
      <p>Tente mudar os filtros.</p>
      <details class="compact-details"><summary>Detalhes</summary><p>Nenhum convite foi criado.</p></details>
      <div class="search-empty__actions">${button("Ajustar filtros", { action: "open-opponent-filters", icon: "filter" })}${button("Limpar filtros", { action: "clear-opponent-filters", kind: "ghost" })}</div>
    </section>`;
  }

  function renderOpponents(state) {
    const teams = filteredOpponents(state);
    const visibleTeams = teams.slice(0, state.opponentVisibleLimit);
    const filterCount = activeOpponentFilterCount(state.opponentFilters);
    return `<div class="screen screen--wide opponents-screen">
      ${screenHeader("Radar", "Times por perto", `${teams.length} ${teams.length === 1 ? "resultado" : "resultados"}.`, button(`Filtros${filterCount ? ` (${filterCount})` : ""}`, { action: "open-opponent-filters", kind: "secondary", icon: "filter" }))}
      <section class="radar-indicator card"><span><i></i> Disponível</span><strong>${esc(state.profile.city)} · ${esc(state.opponentFilters.radiusKm)} km</strong></section>
      ${teams.length ? `<section class="nearby-grid" aria-label="Times próximos">${visibleTeams.map(opponentCard).join("")}</section>
        ${teams.length > visibleTeams.length ? `<div class="load-more">${button("Ver mais", { action: "load-more-opponents", kind: "secondary", trailing: "arrow" })}</div>` : ""}` : renderOpponentEmpty()}
    </div>`;
  }

  function filterChoice(name, value, current) {
    return `<label class="filter-choice"><input type="radio" name="${esc(name)}" value="${esc(value)}"${value === current ? " checked" : ""}><span>${esc(value)}</span></label>`;
  }

  function renderOpponentFilters(state) {
    const filters = state.opponentFilters;
    return `<div class="screen screen--narrow filters-screen">
      ${screenHeader("Radar", "Filtros", "Refine os resultados.")}
      <form class="filters-form" data-form="opponent-filters">
        <fieldset class="filter-section"><legend>Modalidade</legend><div class="filter-choice-grid">${["Society", "Campo", "Futsal", "Todas"].map((value) => filterChoice("modality", value, filters.modality)).join("")}</div></fieldset>
        <fieldset class="filter-section"><legend>Categoria</legend><label class="field"><span>Categoria do adversário</span><select name="category"><option${selected(filters.category, "Todas")}>Todas</option><option${selected(filters.category, "Livre")}>Livre</option><option${selected(filters.category, "Veterano")}>Veterano</option><option${selected(filters.category, "Sub-20")}>Sub-20</option></select></label></fieldset>
        <fieldset class="filter-section"><legend>Nível</legend><div class="filter-choice-grid">${["Recreativo", "Intermediário", "Competitivo", "Qualquer"].map((value) => filterChoice("level", value, filters.level)).join("")}</div></fieldset>
        <fieldset class="filter-section"><legend>Distância máxima <output class="radius-output" for="opponent-radius">${esc(filters.radiusKm)} km</output></legend><input class="radius-range" id="opponent-radius" type="range" name="radiusKm" min="5" max="25" step="5" value="${esc(filters.radiusKm)}"></fieldset>
        <fieldset class="filter-section"><legend>Quando</legend><div class="filter-choice-grid filter-choice-grid--three">${["Sábado", "Domingo", "Próximos 30 dias", "Qualquer"].map((value) => filterChoice("day", value, filters.day)).join("")}</div><label class="field"><span>Período</span><select name="period"><option${selected(filters.period, "Qualquer")}>Qualquer</option><option${selected(filters.period, "Manhã")}>Manhã</option><option${selected(filters.period, "Tarde")}>Tarde</option><option${selected(filters.period, "Noite")}>Noite</option></select></label></fieldset>
        <fieldset class="filter-section"><legend>Mando</legend><label class="field"><span>Preferência</span><select name="venue"><option${selected(filters.venue, "Casa ou fora")}>Casa ou fora</option><option${selected(filters.venue, "Mandante")}>Mandante</option><option${selected(filters.venue, "Visitante")}>Visitante</option></select></label></fieldset>
        <div class="filters-actions">${button("Aplicar filtros", { type: "submit", full: true, trailing: "arrow" })}${button("Limpar filtros", { action: "clear-opponent-filters", kind: "ghost", full: true })}</div>
      </form>
    </div>`;
  }

  function reputationBar(label, value) {
    const percent = Math.max(0, Math.min(100, Number(value) * 20));
    return `<div class="reputation-row"><span>${esc(label)}</span><i><b style="width:${percent}%"></b></i><strong>${String(value).replace(".", ",")}</strong></div>`;
  }

  function renderOpponentDetail(state) {
    const team = data.nearbyTeams.find((item) => item.slug === state.selectedOpponentSlug) || data.nearbyTeams[0];
    const publicReputation = team.reputation && team.verifiedMatches >= 3;
    return `<div class="screen screen--narrow opponent-detail">
      ${screenHeader("Time", team.name, "Perfil esportivo público.")}
      <section class="opponent-hero card">
        ${crest(team.initials, "team-crest--detail")}
        <div><span class="verified-label">${icon("shield")} Verificado</span><h2>${esc(team.name)}</h2><p>${esc(team.city)} · ${esc(opponentDistance(team))}</p></div>
        <strong class="opponent-hero__score">${esc(team.compatibility)}%<small>compatível</small></strong>
        <div class="opponent-hero__tags"><span>${esc(team.modality)}</span><span>${esc(team.category)}</span><span>${esc(team.level)}</span></div>
      </section>
      <section class="detail-availability card"><span>${icon("calendar")}</span><div><p>Próximo horário</p><h2>${esc(team.availability)}</h2><small>${esc(team.venue)}</small></div></section>
      <details class="compact-details card"><summary>Detalhes</summary>${publicReputation ? `<div class="reputation-card__heading"><strong>${team.reputation.score.toFixed(1).replace(".", ",")} ${icon("star")}</strong><span>${esc(team.verifiedMatches)} avaliações</span></div>${reputationBar("Fair play", team.reputation.fairPlay)}${reputationBar("Pontualidade", team.reputation.punctuality)}` : `<p>Reputação nova</p>`}<button class="details-link" type="button" data-action="open-reputation" data-id="${esc(team.publicId || "44444444-4444-4444-8444-444444444444")}">Ver reputação ${icon("arrow")}</button><div class="safety-inline-actions"><button type="button" data-action="begin-report-team" data-id="${esc(team.slug)}">${icon("alert")} Denunciar</button><button type="button" data-action="begin-block" data-id="${esc(team.slug)}">${icon("close")} Bloquear</button></div></details>
      <section class="contact-lock card">${icon("lock")}<div><strong>Contato protegido</strong><p>Liberado após o aceite.</p></div></section>
      <div class="detail-actions">${button("Convidar", { action: "invite-preview", id: team.slug, trailing: "arrow", full: true })}</div>
    </div>`;
  }

  function renderOpponentsLoading() {
    return `<div class="screen screen--wide opponents-screen">${screenHeader("Radar", "Buscando times", "Organizando resultados.")}<div class="search-skeleton" role="status" aria-label="Carregando times"><span></span><span></span><span></span><span></span></div></div>`;
  }

  function renderOpponentsError() {
    return `<div class="screen state-page state-page--error"><section class="state-page__visual">${icon("close")}</section><p class="eyebrow">Radar</p><h1>Busca indisponível</h1><p>Filtros preservados.</p>${button("Tentar novamente", { action: "retry-opponents", trailing: "arrow" })}</div>`;
  }

  function renderInlineEmpty() {
    return `<div class="inline-empty card">${icon("calendar")}<h2>Nenhuma disponibilidade</h2><p>Publique os melhores dias e horários para seu time jogar.</p>${button("Criar disponibilidade", { action: "new-availability" })}</div>`;
  }

  function renderAvailabilityForm(state) {
    const existing = state.availabilities.find((item) => item.id === state.editingAvailabilityId);
    const item = existing || {
      id: "", title: "Society · Sábado à tarde", dateLabel: "Sábado, 29 de agosto", period: "14h às 18h", city: `${state.profile.city}, ${state.profile.state}`,
      radius: "Até 25 km", category: state.profile.category, level: state.profile.level, homeAway: "Mandante ou visitante", notes: "Campo sintético. Podemos dividir a arbitragem."
    };
    return `<div class="screen screen--form">
      ${screenHeader("Radar", existing ? "Editar disponibilidade" : "Nova disponibilidade", "Defina quando jogar.")}
      <form class="availability-form" data-form="availability">
        <input type="hidden" name="id" value="${esc(item.id)}">
        <section class="form-card card">
          <div class="form-section-heading"><span>01</span><div><h2>Data e horário</h2></div></div>
          <div class="field-grid field-grid--two">
            <label class="field field--wide"><span>Título da publicação</span><input name="title" maxlength="70" required value="${esc(item.title)}"></label>
            <label class="field"><span>Dia</span><input name="dateLabel" maxlength="60" required value="${esc(item.dateLabel)}"></label>
            <label class="field"><span>Horário</span><select name="period"><option${selected(item.period, "8h às 12h")}>8h às 12h</option><option${selected(item.period, "14h às 18h")}>14h às 18h</option><option${selected(item.period, "19h às 22h")}>19h às 22h</option></select></label>
          </div>
        </section>
        <section class="form-card card">
          <div class="form-section-heading"><span>02</span><div><h2>Local e rival</h2></div></div>
          <div class="field-grid field-grid--two">
            <label class="field"><span>Cidade-base</span><input name="city" required value="${esc(item.city)}"></label>
            <label class="field"><span>Distância</span><select name="radius"><option${selected(item.radius, "Até 10 km")}>Até 10 km</option><option${selected(item.radius, "Até 25 km")}>Até 25 km</option><option${selected(item.radius, "Até 50 km")}>Até 50 km</option></select></label>
            <label class="field"><span>Categoria</span><select name="category"><option${selected(item.category, "Livre")}>Livre</option><option${selected(item.category, "Veterano")}>Veterano</option><option${selected(item.category, "Sub-20")}>Sub-20</option></select></label>
            <label class="field"><span>Nível desejado</span><select name="level"><option${selected(item.level, "Iniciante")}>Iniciante</option><option${selected(item.level, "Intermediário")}>Intermediário</option><option${selected(item.level, "Competitivo")}>Competitivo</option></select></label>
            <label class="field field--wide"><span>Mando de jogo</span><select name="homeAway"><option${selected(item.homeAway, "Mandante ou visitante")}>Mandante ou visitante</option><option${selected(item.homeAway, "Temos campo")}>Temos campo</option><option${selected(item.homeAway, "Precisamos de campo")}>Precisamos de campo</option></select></label>
            <label class="field field--wide"><span>Observações</span><textarea name="notes" maxlength="220" rows="3">${esc(item.notes)}</textarea></label>
          </div>
        </section>
        <div class="publish-preview card"><span>${icon("lock")}</span><div><strong>Contato protegido</strong></div></div>
        <div class="sticky-actions"><div>${button("Cancelar", { action: "navigate", target: "availabilities", kind: "ghost" })}${button(existing ? "Salvar" : "Publicar", { type: "submit", trailing: "arrow" })}</div></div>
      </form>
    </div>`;
  }

  function selectedInvitation(state) {
    return state.invitations.find((item) => item.id === state.selectedInvitationId) ||
      state.invitations.find((item) => item.direction === "incoming" && item.state === "pending") ||
      state.invitations[0];
  }

  function proposalFacts(proposal) {
    return `<div class="proposal-facts">
      <span>${icon("calendar")}<small>Data</small><strong>${esc(proposal.date)}</strong></span>
      <span>${icon("clock")}<small>Horário</small><strong>${esc(proposal.time)}</strong></span>
      <span>${icon("location")}<small>Região</small><strong>${esc(proposal.city)}</strong></span>
      <span>${icon("shield")}<small>Mando</small><strong>${esc(proposal.venue)}</strong></span>
    </div>`;
  }

  function matchup(teamName, initials, subtitle) {
    return `<section class="matchup-card card">
      <div>${crest("EN", "team-crest--small")}<strong>Estrela do Norte</strong></div>
      <span class="matchup-card__versus">×</span>
      <div>${crest(initials, "team-crest--small")}<strong>${esc(teamName)}</strong></div>
      ${subtitle ? `<p>${esc(subtitle)}</p>` : ""}
    </section>`;
  }

  function renderInvitationCompose(state) {
    const draft = state.invitationDraft || (() => {
      const team = data.nearbyTeams[0];
      return { opponentSlug: team.slug, opponentName: team.name, opponentInitials: team.initials, date: "30/08/2026", time: "15:00", modality: team.modality, category: team.category, city: `${state.profile.city}, ${state.profile.state}`, venue: "Mandante", message: "" };
    })();
    return `<div class="screen screen--narrow invitation-screen">
      ${screenHeader("Convite", "Montar convite", "Escolha data e mando.")}
      ${matchup(draft.opponentName, draft.opponentInitials, `${draft.modality} · ${draft.category}`)}
      <form class="invitation-form" data-form="invitation-compose">
        <section class="form-card card"><div class="field-grid field-grid--two">
          <label class="field"><span>Data</span><input name="date" required value="${esc(draft.date)}"></label>
          <label class="field"><span>Horário</span><input name="time" type="time" required value="${esc(draft.time)}"></label>
          <label class="field"><span>Cidade aproximada</span><input name="city" required value="${esc(draft.city)}"></label>
          <label class="field"><span>Mando</span><select name="venue"><option${selected(draft.venue, "Mandante")}>Mandante</option><option${selected(draft.venue, "Visitante")}>Visitante</option></select></label>
        </div><details class="compact-details"><summary>Mensagem opcional</summary><label class="field"><textarea name="message" rows="2" maxlength="140">${esc(draft.message || "")}</textarea></label></details></section>
        <div class="sticky-actions"><span>${icon("lock")} Sem contato</span>${button("Revisar convite", { type: "submit", trailing: "arrow" })}</div>
      </form>
    </div>`;
  }

  function renderInvitationReview(state) {
    const draft = state.invitationDraft;
    if (!draft) return renderInvitationsEmptyPage();
    return `<div class="screen screen--narrow invitation-screen">
      ${screenHeader("Convite", "Revisar convite", "Confira antes de enviar.")}
      ${matchup(draft.opponentName, draft.opponentInitials)}
      <section class="proposal-card card">${proposalFacts(draft)}<div class="proposal-chips"><span>${esc(draft.modality)}</span><span>${esc(draft.category)}</span></div>${draft.message ? `<details class="compact-details"><summary>Detalhes</summary><p>${esc(draft.message)}</p></details>` : ""}</section>
      <div class="privacy-note">${icon("lock")} Contato após aceite</div>
      <div class="sticky-actions"><div>${button("Editar", { action: "navigate", target: "invitation-compose", kind: "ghost" })}${button("Enviar convite", { action: "send-invitation", icon: "send" })}</div></div>
    </div>`;
  }

  function renderInvitationSent(state) {
    const invitation = selectedInvitation(state);
    return `<div class="screen state-page state-page--success"><section class="state-page__visual">${icon("send")}</section><p class="eyebrow">Convite</p><h1>Convite enviado</h1><p>${esc(invitation?.opponentName || "Time adversário")} · resposta em até 72h.</p>${button("Ver convites", { action: "navigate", target: "invitations", trailing: "arrow" })}</div>`;
  }

  function invitationStateLabel(value) {
    return { pending: "Aguardando", counter_proposed: "Contraproposta", accepted: "Aceito", declined: "Recusado", cancelled: "Cancelado", expired: "Expirado" }[value] || value;
  }

  function invitationCard(item) {
    const action = item.state === "pending" ? (item.direction === "incoming" ? "Responder" : "Acompanhar") :
      item.state === "counter_proposed" ? "Acompanhar" : "Ver";
    return `<article class="invitation-card card invitation-card--${esc(item.state)}">
      <div class="invitation-card__identity">${crest(item.opponentInitials, "team-crest--small")}<div><h2>${esc(item.opponentName)}</h2><p>${esc(item.proposal.date)} · ${esc(item.proposal.time)}</p></div><span class="invite-state invite-state--${esc(item.state)}">${esc(invitationStateLabel(item.state))}</span></div>
      <div class="invitation-card__meta"><span>${icon("location")} ${esc(item.proposal.city)}</span><span>v${esc(item.version)}</span><small>${esc(item.updatedLabel)}</small></div>
      ${button(action, { action: "open-invitation", id: item.id, full: true, kind: item.direction === "incoming" && item.state === "pending" ? "primary" : "secondary" })}
    </article>`;
  }

  function renderInvitations(state) {
    const box = state.invitationBox || "all";
    const items = state.invitations.filter((item) => box === "all" || item.direction === box);
    return `<div class="screen screen--wide invitations-screen">
      ${screenHeader("Radar", "Convites", `${items.length} ${items.length === 1 ? "convite" : "convites"}.`, button("Novo convite", { action: "navigate", target: "opponents", icon: "send" }))}
      <div class="segmented-control" role="group" aria-label="Caixa de convites">
        <button class="${box === "all" ? "is-active" : ""}" data-action="invitation-box" data-target="all">Todos</button>
        <button class="${box === "incoming" ? "is-active" : ""}" data-action="invitation-box" data-target="incoming">Recebidos</button>
        <button class="${box === "outgoing" ? "is-active" : ""}" data-action="invitation-box" data-target="outgoing">Enviados</button>
      </div>
      ${items.length ? `<section class="invitation-grid">${items.map(invitationCard).join("")}</section>` : renderInvitationsEmpty()}
    </div>`;
  }

  function renderInvitationDetail(state) {
    const item = selectedInvitation(state);
    if (!item) return renderInvitationsEmptyPage();
    const canReply = item.direction === "incoming" && item.state === "pending";
    const canCancel = item.direction === "outgoing" && ["pending", "counter_proposed"].includes(item.state);
    return `<div class="screen screen--narrow invitation-screen">
      ${screenHeader("Convite recebido", item.opponentName, `${invitationStateLabel(item.state)} · v${item.version}`)}
      ${matchup(item.opponentName, item.opponentInitials)}
      <section class="proposal-card card">${proposalFacts(item.proposal)}<div class="proposal-chips"><span>${esc(item.proposal.modality)}</span><span>${esc(item.proposal.category)}</span></div>${item.proposal.message ? `<details class="compact-details"><summary>Detalhes</summary><p>${esc(item.proposal.message)}</p></details>` : ""}</section>
      <div class="contact-lock card">${icon("lock")}<strong>Contato após o aceite</strong></div>
      ${item.state === "expired" ? `<div class="expired-banner">${icon("clock")} Convite expirado</div>` : ""}
      <div class="sticky-actions invitation-actions">${canReply ? `<div>${button("Recusar", { action: "decline-invitation", id: item.id, kind: "ghost" })}${button("Contrapropor", { action: "counter-invitation", id: item.id, kind: "secondary" })}${button("Aceitar", { action: "accept-invitation", id: item.id })}</div>` : canCancel ? button("Cancelar convite", { action: "cancel-invitation", id: item.id, kind: "danger" }) : button("Voltar aos convites", { action: "navigate", target: "invitations", kind: "secondary" })}</div>
    </div>`;
  }

  function renderInvitationCounter(state) {
    const item = selectedInvitation(state);
    if (!item) return renderInvitationsEmptyPage();
    return `<div class="screen screen--narrow invitation-screen">
      ${screenHeader("Convite", "Contraproposta", "Altere data, hora ou mando.")}
      ${matchup(item.opponentName, item.opponentInitials, `Versão ${item.version + 1}`)}
      <form class="invitation-form" data-form="invitation-counter">
        <section class="form-card card"><div class="field-grid field-grid--two">
          <label class="field"><span>Data</span><input name="date" required value="${esc(item.proposal.date)}"></label>
          <label class="field"><span>Horário</span><input name="time" type="time" required value="${esc(item.proposal.time)}"></label>
          <label class="field field--wide"><span>Mando</span><select name="venue"><option${selected(item.proposal.venue, "Mandante")}>Mandante</option><option${selected(item.proposal.venue, "Visitante")}>Visitante</option></select></label>
        </div><details class="compact-details"><summary>Mensagem opcional</summary><label class="field"><textarea name="message" rows="2" maxlength="140">${esc(item.proposal.message || "")}</textarea></label></details></section>
        <div class="sticky-actions">${button("Enviar contraproposta", { type: "submit", icon: "send" })}</div>
      </form>
    </div>`;
  }

  function renderMatchConfirmed(state) {
    return renderMatchDetail(state);
  }

  function selectedMatch(state) {
    return state.matches.find((item) => item.id === state.selectedMatchId) || state.confirmedMatch || null;
  }

  function matchState(value, resultState) {
    if (value === "played" && resultState === "verified") return ["Resultado", "accepted"];
    if (value === "played" && resultState === "divergent") return ["Divergente", "cancelled"];
    if (value === "played" && resultState === "waiting_other") return ["Placar pendente", "pending"];
    return {
      scheduled: ["Confirmada", "accepted"],
      awaiting_occurrence: ["Aguardando", "pending"],
      played: ["Realizada", "accepted"],
      cancelled: ["Cancelada", "cancelled"]
    }[value] || ["Em aberto", "pending"];
  }

  function matchCard(match) {
    const stateInfo = matchState(match.state, match.result?.state);
    return `<article class="match-card card match-card--${esc(match.state)}">
      <div class="match-card__top">${crest(match.opponentInitials, "team-crest--small")}<div><h2>${esc(match.opponentName)}</h2><p>${esc(match.proposal.date)} · ${esc(match.proposal.time)}</p></div><span class="invite-state invite-state--${esc(stateInfo[1])}">${esc(stateInfo[0])}</span></div>
      <div class="match-card__facts"><span>${icon("location")} ${esc(match.proposal.city)}</span><span>${esc(match.proposal.modality)}</span><small>${esc(match.updatedLabel)}</small></div>
      ${button("Abrir partida", { action: "open-match", id: match.id, full: true, kind: match.state === "scheduled" ? "primary" : "secondary" })}
    </article>`;
  }

  function renderMatches(state) {
    const box = state.matchBox || "upcoming";
    const upcoming = new Set(["scheduled", "awaiting_occurrence"]);
    const items = state.matches.filter((item) => box === "upcoming" ? upcoming.has(item.state) : !upcoming.has(item.state));
    return `<div class="screen screen--wide matches-screen">
      ${screenHeader("Amistosos", "Central de partidas", `${items.length} ${items.length === 1 ? "partida" : "partidas"}.`)}
      <div class="segmented-control match-tabs" role="group" aria-label="Filtro das partidas">
        <button class="${box === "upcoming" ? "is-active" : ""}" data-action="match-box" data-target="upcoming">Próximas</button>
        <button class="${box === "history" ? "is-active" : ""}" data-action="match-box" data-target="history">Histórico</button>
      </div>
      ${items.length ? `<section class="match-grid">${items.map(matchCard).join("")}</section>` : renderMatchState("match-empty")}
    </div>`;
  }

  function historyDateValue(label) {
    const parts = String(label || "").split("/").map(Number);
    return parts.length === 3 ? new Date(parts[2], parts[1] - 1, parts[0]).getTime() : 0;
  }

  function historyStatus(match) {
    if (match.state === "cancelled") return "cancelled";
    if (match.result?.state === "verified") return "official";
    if (match.result?.state === "divergent") return "divergent";
    return "pending";
  }

  function filteredHistory(state, opponentPublicId) {
    const filters = state.historyFilters || { period: "all", situation: "all" };
    const now = new Date(2026, 7, 24).getTime();
    const days = { "30d": 30, "90d": 90, "365d": 365 }[filters.period] || null;
    return state.matches
      .filter((match) => ["played", "cancelled", "no_show", "disputed"].includes(match.state))
      .filter((match) => !opponentPublicId || match.opponentPublicId === opponentPublicId)
      .filter((match) => days === null || historyDateValue(match.proposal.date) >= now - days * 86400000)
      .filter((match) => filters.situation === "all" || historyStatus(match) === filters.situation)
      .sort((first, second) => historyDateValue(second.proposal.date) - historyDateValue(first.proposal.date));
  }

  function historySummary(items) {
    const official = items.filter((match) => historyStatus(match) === "official" && match.result?.official);
    const result = official.reduce((summary, match) => {
      const mine = Number(match.result.official.mine);
      const opponent = Number(match.result.official.opponent);
      summary.goalsFor += mine;
      summary.goalsAgainst += opponent;
      if (mine > opponent) summary.wins += 1;
      else if (mine < opponent) summary.losses += 1;
      else summary.draws += 1;
      summary.form.push(mine > opponent ? "win" : mine < opponent ? "loss" : "draw");
      return summary;
    }, { wins: 0, draws: 0, losses: 0, goalsFor: 0, goalsAgainst: 0, form: [] });
    result.form = result.form.slice(0, 5);
    return result;
  }

  function historySummaryView(summary, compact) {
    return `<section class="history-summary card${compact ? " history-summary--compact" : ""}" aria-label="Resumo">
      <div class="history-summary__results">
        <span><strong>${summary.wins}</strong><small>V</small></span>
        <span><strong>${summary.draws}</strong><small>E</small></span>
        <span><strong>${summary.losses}</strong><small>D</small></span>
      </div>
      <div class="history-summary__goals"><span><b>${summary.goalsFor}</b> GM</span><span><b>${summary.goalsAgainst}</b> GS</span></div>
      <div class="history-form" aria-label="Forma recente">${summary.form.length ? summary.form.map((value) => `<i class="history-form__${value}">${value === "win" ? "V" : value === "draw" ? "E" : "D"}</i>`).join("") : '<small>Sem forma</small>'}</div>
    </section>`;
  }

  function historyCard(match, headToHead) {
    const status = historyStatus(match);
    const official = status === "official" ? match.result.official : null;
    const outcome = official ? (official.mine > official.opponent ? "win" : official.mine < official.opponent ? "loss" : "draw") : status;
    const labels = {
      official: "Oficial",
      divergent: "Divergente",
      cancelled: "Cancelada",
      pending: "Pendente"
    };
    return `<article class="history-card card history-card--${esc(outcome)}">
      <div class="history-card__meta"><time>${esc(match.proposal.date)}</time><span class="history-state history-state--${esc(status)}">${labels[status]}</span></div>
      <div class="history-card__score">
        <div><span>${crest("EN", "team-crest--tiny")}</span><strong>Estrela do Norte</strong></div>
        <p><b>${official ? esc(official.mine) : "—"}</b><i>×</i><b>${official ? esc(official.opponent) : "—"}</b></p>
        <div><span>${crest(match.opponentInitials, "team-crest--tiny")}</span><strong>${esc(match.opponentName)}</strong></div>
      </div>
      ${status === "divergent" ? '<div class="history-note">Placares não conferem</div>' : status === "cancelled" ? `<div class="history-note">${esc(match.cancellation?.reason || "Cancelada")}</div>` : ""}
      ${button("Abrir partida", { action: "open-history-match", id: match.id, full: true, kind: "secondary" })}
      ${!headToHead && match.opponentPublicId ? `<details class="history-card__details"><summary>Detalhes</summary><button type="button" data-action="open-head-to-head" data-id="${esc(match.opponentPublicId)}">Contra este time ${icon("arrow")}</button></details>` : ""}
    </article>`;
  }

  function historyFilters(state) {
    const filters = state.historyFilters || { period: "all", situation: "all" };
    return `<details class="history-filters compact-details card">
      <summary>Filtros <span>${filters.period === "all" ? "Todo período" : filters.period} · ${filters.situation === "all" ? "Tudo" : filters.situation}</span></summary>
      <div>
        <label><span>Período</span><select data-history-filter="period"><option value="all"${selected(filters.period, "all")}>Todo período</option><option value="30d"${selected(filters.period, "30d")}>30 dias</option><option value="90d"${selected(filters.period, "90d")}>90 dias</option><option value="365d"${selected(filters.period, "365d")}>1 ano</option></select></label>
        <label><span>Situação</span><select data-history-filter="situation"><option value="all"${selected(filters.situation, "all")}>Tudo</option><option value="official"${selected(filters.situation, "official")}>Oficiais</option><option value="pending"${selected(filters.situation, "pending")}>Pendentes</option><option value="divergent"${selected(filters.situation, "divergent")}>Divergentes</option><option value="cancelled"${selected(filters.situation, "cancelled")}>Canceladas</option></select></label>
      </div>
    </details>`;
  }

  function renderHistory(state) {
    const items = filteredHistory(state);
    const visible = items.slice(0, state.historyVisibleLimit || 4);
    const summary = historySummary(items);
    return `<div class="screen screen--wide history-screen">
      ${screenHeader("Radar", "Meus amistosos", "Resultados do seu time.")}
      ${historySummaryView(summary)}
      ${historyFilters(state)}
      ${visible.length ? `<section class="history-grid">${visible.map((match) => historyCard(match, false)).join("")}</section>` : `<section class="history-empty card">${icon("trophy")}<h2>Nenhum resultado</h2><p>Ajuste os filtros.</p></section>`}
      ${visible.length < items.length ? `<div class="history-load">${button("Carregar mais", { action: "load-more-history", kind: "secondary" })}</div>` : ""}
    </div>`;
  }

  function renderHeadToHead(state) {
    const opponentId = state.selectedHistoryOpponentId;
    const allAgainst = state.matches.filter((match) => match.opponentPublicId === opponentId);
    const opponent = allAgainst[0];
    if (!opponent) return renderHistoryState("history-empty");
    const items = filteredHistory(state, opponentId);
    const summary = historySummary(items);
    return `<div class="screen screen--narrow history-screen h2h-screen">
      ${screenHeader("Confrontos", "Contra este time", opponent.opponentName)}
      <section class="h2h-hero card">
        <div>${crest("EN", "team-crest--medium")}<strong>Estrela do Norte</strong></div>
        <b>${summary.wins + summary.draws + summary.losses}</b>
        <div>${crest(opponent.opponentInitials, "team-crest--medium")}<strong>${esc(opponent.opponentName)}</strong></div>
      </section>
      ${historySummaryView(summary, true)}
      ${historyFilters(state)}
      ${items.length ? `<section class="history-grid history-grid--single">${items.slice(0, state.historyVisibleLimit || 4).map((match) => historyCard(match, true)).join("")}</section>` : `<section class="history-empty card">${icon("trophy")}<h2>Sem confrontos</h2><p>Ajuste os filtros.</p></section>`}
      ${items.length > (state.historyVisibleLimit || 4) ? `<div class="history-load">${button("Carregar mais", { action: "load-more-history", kind: "secondary" })}</div>` : ""}
    </div>`;
  }

  function renderHistoryState(view) {
    const content = {
      "history-loading": ["more", "Carregando histórico", "Só um instante."],
      "history-empty": ["trophy", "Histórico vazio", "Nenhuma partida ainda."],
      "history-error": ["close", "Histórico indisponível", "Tente novamente."]
    }[view] || ["trophy", "Histórico vazio", "Nenhuma partida ainda."];
    return `<div class="screen state-page state-page--${view === "history-error" ? "error" : view === "history-loading" ? "loading" : "empty"}"><section class="state-page__visual">${icon(content[0])}${view === "history-loading" ? '<span class="spinner-ring"></span>' : ""}</section><h1>${content[1]}</h1><p>${content[2]}</p>${view === "history-loading" ? "" : button(view === "history-error" ? "Tentar novamente" : "Ver Radar", { action: "navigate", target: view === "history-error" ? "history" : "opponents" })}</div>`;
  }

  function confirmationPanel(match) {
    if (match.state === "played") {
      return `<section class="confirmation-panel confirmation-panel--done card">${icon("check")}<div><strong>Partida realizada</strong><span>Confirmação dos dois times</span></div><b>2/2</b></section>`;
    }
    if (match.confirmation?.mine) {
      return `<section class="confirmation-panel card">${icon("clock")}<div><strong>Você confirmou</strong><span>Aguardando o outro time</span></div><b>1/2</b></section>`;
    }
    if (match.confirmation?.opponent) {
      return `<section class="confirmation-panel card">${icon("bell")}<div><strong>Rival confirmou</strong><span>Falta sua confirmação</span></div><b>1/2</b></section>`;
    }
    return `<section class="confirmation-panel card">${icon("clock")}<div><strong>Após o jogo</strong><span>Cada time confirma</span></div><b>0/2</b></section>`;
  }

  function renderMatchDetail(state) {
    const match = selectedMatch(state);
    if (!match) return renderMatchState("match-empty");
    if (match.state === "cancelled") return renderMatchCancelled(state);
    const canConfirm = !match.confirmation?.mine && match.state !== "played";
    const canCancel = !match.confirmation?.mine && !match.confirmation?.opponent && match.state === "scheduled";
    const resultState = match.result?.state || "empty";
    const canReview = resultState === "verified" && !state.reviewedMatchIds.includes(match.id);
    const resultAction = canReview
      ? button("Avaliar adversário", { action: "begin-review", id: match.id, icon: "star", full: true })
      : match.state === "played"
      ? resultState === "empty"
        ? button("Informar placar", { action: "begin-score", id: match.id, icon: "trophy", full: true })
        : button(resultState === "verified" ? "Ver resultado" : resultState === "divergent" ? "Ver divergência" : "Ver placar", {
            action: "navigate",
            target: resultState === "verified" ? "score-verified" : resultState === "divergent" ? "score-divergent" : match.result?.opponent ? "score-confirm" : "score-waiting",
            icon: resultState === "divergent" ? "alert" : "trophy",
            full: true
          })
      : "";
    return `<div class="screen screen--narrow match-screen">
      ${screenHeader("Amistoso", "Central da partida", `${match.proposal.date} · ${match.proposal.time}`)}
      <div class="match-status-row"><span class="invite-state invite-state--${esc(matchState(match.state, resultState)[1])}">${esc(matchState(match.state, resultState)[0])}</span><small>v${esc(match.version)}</small></div>
      ${matchup(match.opponentName, match.opponentInitials)}
      <section class="proposal-card card">${proposalFacts(match.proposal)}<div class="proposal-chips"><span>${esc(match.proposal.modality)}</span><span>${esc(match.proposal.category)}</span></div></section>
      ${confirmationPanel(match)}
      ${match.contactHidden ? `<section class="contact-lock card">${icon("lock")}<div><strong>Contato oculto</strong><p>Bloqueio ativo.</p></div></section>` : `<section class="contact-revealed card"><span>${icon("user")}</span><div><small>Responsável</small><strong>${esc(match.contact.name)}</strong><a href="tel:+5547999990000">${esc(match.contact.phone)}</a></div><span class="invite-state invite-state--accepted">Liberado</span></section>`}
      <details class="compact-details card"><summary>Detalhes</summary><p>Dados fictícios.</p>${canCancel ? `<button class="details-danger" type="button" data-action="cancel-match">Cancelar partida</button>` : ""}${["verified", "divergent"].includes(resultState) ? `<button class="details-link" type="button" data-action="begin-dispute" data-id="${esc(match.id)}">Contestar resultado ${icon("arrow")}</button>` : ""}<button class="details-link" type="button" data-action="begin-report-match" data-id="${esc(match.id)}">Denunciar partida ${icon("arrow")}</button></details>
      ${resultAction ? `<div class="sticky-actions match-primary-action">${resultAction}</div>` : canConfirm ? `<div class="sticky-actions match-primary-action">${button("Confirmar realização", { action: "confirm-match", id: match.id, icon: "check", full: true })}</div>` : ""}
    </div>`;
  }

  function scoreMatch(state, kind) {
    const current = selectedMatch(state);
    const matches = state.matches.filter((item) => item.state === "played");
    if (kind === "form") {
      if (current?.state === "played" && current.result?.state !== "verified") return current;
      return matches.find((item) => (item.result?.state || "empty") === "empty") || matches[0] || null;
    }
    if (kind === "confirm") {
      if (current?.result?.opponent && current.result.state !== "verified") return current;
      return matches.find((item) => item.result?.opponent && item.result.state === "waiting_other") || null;
    }
    if (kind === "divergent") {
      if (current?.result?.state === "divergent") return current;
      return matches.find((item) => item.result?.state === "divergent") || null;
    }
    if (kind === "verified") {
      if (current?.result?.state === "verified") return current;
      return matches.find((item) => item.result?.state === "verified") || null;
    }
    if (kind === "waiting") {
      if (current?.result?.state === "waiting_other" && current.result.mine) return current;
      return matches.find((item) => item.result?.state === "waiting_other" && item.result.mine) || null;
    }
    return current?.state === "played" ? current : matches[0] || null;
  }

  function scoreTeams(match, values, editable) {
    const mine = Number(values?.mine || 0);
    const opponent = Number(values?.opponent || 0);
    return `<section class="scoreboard card${editable ? " scoreboard--editable" : ""}" aria-label="Placar">
      <div class="score-team">${crest("EN", "team-crest--small")}<strong>Estrela do Norte</strong>${editable ? `<input class="score-input" name="mine" type="number" inputmode="numeric" min="0" max="99" required value="${esc(mine)}" aria-label="Gols do Estrela do Norte">` : `<b>${esc(mine)}</b>`}</div>
      <span class="score-versus">×</span>
      <div class="score-team">${crest(match.opponentInitials, "team-crest--small")}<strong>${esc(match.opponentName)}</strong>${editable ? `<input class="score-input" name="opponent" type="number" inputmode="numeric" min="0" max="99" required value="${esc(opponent)}" aria-label="Gols do adversário">` : `<b>${esc(opponent)}</b>`}</div>
    </section>`;
  }

  function renderScoreForm(state) {
    const match = scoreMatch(state, "form");
    if (!match) return renderScoreState("score-error");
    const title = state.scoreMode === "different" ? "Outro placar" : "Informar placar";
    return `<div class="screen screen--narrow score-screen">
      ${screenHeader("Resultado", title, "Digite os gols.")}
      <form data-form="score-form" data-id="${esc(match.id)}">
        ${scoreTeams(match, state.scoreDraft, true)}
        <details class="compact-details card"><summary>Detalhes</summary><p>Enviado ao rival para confirmar.</p></details>
        <div class="sticky-actions score-actions">${button("Revisar placar", { type: "submit", icon: "trophy", full: true })}</div>
      </form>
    </div>`;
  }

  function renderScoreReview(state) {
    const match = scoreMatch(state);
    if (!match) return renderScoreState("score-error");
    return `<div class="screen screen--narrow score-screen">
      ${screenHeader("Resultado", "Revisar placar", "Confira antes de enviar.")}
      ${scoreTeams(match, state.scoreDraft, false)}
      <div class="score-status card">${icon("shield")}<span>Aguardará o rival</span></div>
      <div class="sticky-actions score-actions">${button("Enviar placar", { action: "submit-score", id: match.id, icon: "send", full: true })}</div>
    </div>`;
  }

  function renderScoreWaiting(state) {
    const match = scoreMatch(state, "waiting");
    if (!match) return renderScoreState("score-empty");
    return `<div class="screen screen--narrow score-screen">
      ${screenHeader("Resultado", "Aguardando rival", "Seu placar foi enviado.")}
      ${scoreTeams(match, match.result.mine, false)}
      <div class="score-status score-status--waiting card">${icon("clock")}<span>Confirmação pendente</span><b>1/2</b></div>
      <div class="sticky-actions score-actions">${button("Ver partida", { action: "navigate", target: "match-detail", kind: "secondary", full: true })}</div>
    </div>`;
  }

  function renderScoreConfirm(state) {
    const match = scoreMatch(state, "confirm");
    if (!match) return renderScoreState("score-empty");
    return `<div class="screen screen--narrow score-screen">
      ${screenHeader("Placar recebido", "Confirmar placar", `${match.opponentName} informou.`)}
      ${scoreTeams(match, match.result.opponent, false)}
      <div class="score-status card">${icon("bell")}<span>Aguardando você</span><b>1/2</b></div>
      <details class="compact-details card"><summary>Não confere?</summary><button class="quiet-score-action" type="button" data-action="different-score" data-id="${esc(match.id)}">Informar outro placar</button></details>
      <div class="sticky-actions score-actions">${button("Confirmar placar", { action: "confirm-score", id: match.id, icon: "check", full: true })}</div>
    </div>`;
  }

  function renderScoreDivergent(state) {
    const match = scoreMatch(state, "divergent");
    if (!match) return renderScoreState("score-empty");
    const mine = match.result.mine;
    const opponent = match.result.opponent;
    return `<div class="screen screen--narrow score-screen score-divergent-screen">
      ${screenHeader("Sem resultado oficial", "Placares diferentes", "Nenhum vencedor definido.")}
      <section class="divergence-card card">
        <div class="divergence-head">${icon("alert")}<strong>Divergência</strong><span class="invite-state invite-state--cancelled">Não verificado</span></div>
        <div class="divergence-grid">
          <article><small>Seu time</small><b>${esc(mine.mine)} × ${esc(mine.opponent)}</b></article>
          <article><small>${esc(match.opponentName)}</small><b>${esc(opponent.mine)} × ${esc(opponent.opponent)}</b></article>
        </div>
      </section>
      <div class="score-status score-status--danger card">${icon("shield")}<span>Estatísticas intactas</span></div>
      <details class="compact-details card"><summary>Detalhes</summary><p>O placar só vira oficial com consenso.</p></details>
      <div class="sticky-actions score-actions">${button("Corrigir meu placar", { action: "different-score", id: match.id, icon: "edit", full: true })}</div>
    </div>`;
  }

  function renderScoreVerified(state) {
    const match = scoreMatch(state, "verified");
    if (!match) return renderScoreState("score-empty");
    return `<div class="screen screen--narrow score-screen score-verified-screen">
      ${screenHeader("Consenso dos times", "Resultado confirmado", "Placar oficial.")}
      ${scoreTeams(match, match.result.official, false)}
      <div class="score-status score-status--verified card">${icon("trophy")}<span>Resultado oficial</span><b>2/2</b></div>
      <div class="sticky-actions score-actions">${button("Ver partida", { action: "navigate", target: "match-detail", kind: "secondary", full: true })}</div>
    </div>`;
  }

  function renderScoreState(view) {
    const content = {
      "score-loading": ["more", "Carregando placar", "Só um instante."],
      "score-empty": ["trophy", "Placar indisponível", "Volte à partida."],
      "score-error": ["close", "Erro no placar", "Tente novamente."],
      "score-access-denied": ["lock", "Acesso negado", "Somente os participantes."],
      "score-repeated": ["check", "Placar já enviado", "Nenhuma duplicação."]
    }[view] || ["close", "Erro no placar", "Tente novamente."];
    return `<div class="screen state-page state-page--${view.includes("error") ? "error" : view.includes("access") ? "denied" : view.includes("loading") ? "loading" : "empty"}"><section class="state-page__visual">${icon(content[0])}${view === "score-loading" ? '<span class="spinner-ring"></span>' : ""}</section><p class="eyebrow">Resultado</p><h1>${esc(content[1])}</h1><p>${esc(content[2])}</p>${view === "score-loading" ? "" : button("Ver partidas", { action: "navigate", target: "matches" })}</div>`;
  }

  function renderMatchCancel(state) {
    const match = selectedMatch(state);
    if (!match) return renderMatchState("match-empty");
    if (match.confirmation?.mine || match.confirmation?.opponent || match.state !== "scheduled") return renderMatchDetail(state);
    return `<div class="screen screen--narrow match-screen match-cancel-screen">
      ${screenHeader("Amistoso", "Cancelar partida", "Escolha o motivo.")}
      ${matchup(match.opponentName, match.opponentInitials, `${match.proposal.date} · ${match.proposal.time}`)}
      <form class="match-cancel-form" data-form="match-cancel">
        <section class="form-card card"><label class="field"><span>Motivo</span><select name="reason" required><option value="">Selecione</option><option value="weather">Clima</option><option value="field_unavailable">Campo indisponível</option><option value="team_unavailable">Time indisponível</option><option value="scheduling_conflict">Conflito de horário</option><option value="safety">Segurança</option><option value="other">Outro motivo</option></select></label>
        <div class="cancel-rule">${icon("shield")} Bloqueado após confirmação</div></section>
        <div class="sticky-actions match-cancel-actions"><div>${button("Manter partida", { action: "navigate", target: "match-detail", kind: "ghost" })}${button("Confirmar cancelamento", { type: "submit", kind: "danger" })}</div></div>
      </form>
    </div>`;
  }

  function renderMatchCancelled(state) {
    const match = selectedMatch(state);
    if (!match || match.state !== "cancelled") return renderMatchDetail(state);
    return `<div class="screen state-page state-page--error match-cancelled-state"><section class="state-page__visual">${icon("close")}</section><p class="eyebrow">Amistoso</p><h1>Partida cancelada</h1><p>${esc(match.opponentName)} · ${esc(match.cancellation?.reason || "Cancelada")}</p>${button("Ver partidas", { action: "navigate", target: "matches", kind: "secondary" })}</div>`;
  }

  function reviewMatch(state) {
    const selected = state.matches.find((item) => item.id === state.selectedReviewMatchId);
    if (selected?.result?.state === "verified" && !state.reviewedMatchIds.includes(selected.id)) return selected;
    return state.matches.find((item) => item.result?.state === "verified" && !state.reviewedMatchIds.includes(item.id)) || null;
  }

  function ratingField(name, label, value) {
    return `<fieldset class="review-question card"><legend>${esc(label)}</legend><div class="star-picker" aria-label="${esc(label)}">${[1, 2, 3, 4, 5].map((score) => `<label><input type="radio" name="${esc(name)}" value="${score}"${Number(value) === score ? " checked" : ""} required><span>${icon("star")}<b>${score}</b></span></label>`).join("")}</div></fieldset>`;
  }

  function renderReviewForm(state) {
    if (state.reviewedMatchIds.includes(state.selectedReviewMatchId)) return renderReviewComplete(state);
    const match = reviewMatch(state);
    if (!match) return renderReviewState("review-empty");
    return `<div class="screen screen--narrow review-screen">
      ${screenHeader("Partida verificada", "Avaliar adversário", `${match.opponentName} · ${match.proposal.date}`)}
      <div class="review-team card">${crest(match.opponentInitials, "team-crest--small")}<div><strong>${esc(match.opponentName)}</strong><span>${esc(match.result.official.mine)} × ${esc(match.result.official.opponent)}</span></div><i>${icon("shield")}</i></div>
      <form data-form="team-review" data-id="${esc(match.id)}">
        ${ratingField("pontualidade", "Pontualidade", state.reviewDraft.pontualidade)}
        ${ratingField("organizacao", "Organização", state.reviewDraft.organizacao)}
        ${ratingField("comunicacao", "Comunicação", state.reviewDraft.comunicacao)}
        ${ratingField("fair_play", "Fair play", state.reviewDraft.fair_play)}
        <fieldset class="review-question card"><legend>Jogaria novamente?</legend><div class="review-binary"><label><input type="radio" name="jogaria_novamente" value="true"${state.reviewDraft.jogaria_novamente ? " checked" : ""} required><span>${icon("check")} Sim</span></label><label><input type="radio" name="jogaria_novamente" value="false"${state.reviewDraft.jogaria_novamente ? "" : " checked"} required><span>${icon("close")} Não</span></label></div></fieldset>
        <div class="sticky-actions review-actions">${button("Revisar avaliação", { type: "submit", icon: "star", full: true })}</div>
      </form>
    </div>`;
  }

  function reviewSummary(draft) {
    const values = [
      ["Pontualidade", draft.pontualidade],
      ["Organização", draft.organizacao],
      ["Comunicação", draft.comunicacao],
      ["Fair play", draft.fair_play]
    ];
    return `<div class="review-summary">${values.map(([label, value]) => `<span><small>${esc(label)}</small><strong>${esc(value)} ${icon("star")}</strong></span>`).join("")}<span><small>Jogaria de novo</small><strong>${draft.jogaria_novamente ? "Sim" : "Não"}</strong></span></div>`;
  }

  function renderReviewConfirm(state) {
    if (state.reviewedMatchIds.includes(state.selectedReviewMatchId)) return renderReviewComplete(state);
    const match = reviewMatch(state);
    if (!match) return renderReviewState("review-empty");
    return `<div class="screen screen--narrow review-screen review-confirm-screen">
      ${screenHeader("Avaliação", "Tudo certo?", match.opponentName)}
      <section class="review-confirm-card card">${crest(match.opponentInitials, "team-crest--detail")}<h2>${esc(match.opponentName)}</h2>${reviewSummary(state.reviewDraft)}</section>
      <details class="compact-details card"><summary>Detalhes</summary><p>Envio anônimo e imutável.</p></details>
      <div class="sticky-actions review-actions"><div>${button("Editar", { action: "navigate", target: "review-form", kind: "ghost" })}${button("Enviar avaliação", { action: "submit-review", id: match.id, icon: "send" })}</div></div>
    </div>`;
  }

  function renderReviewComplete(state) {
    const match = state.matches.find((item) => item.id === state.selectedReviewMatchId) || reviewMatch(state);
    return `<div class="screen state-page state-page--success review-complete"><section class="state-page__visual">${icon("check")}</section><p class="eyebrow">Reputação</p><h1>Avaliação enviada</h1><p>${esc(match?.opponentName || "Adversário")}</p>${button("Ver partidas", { action: "navigate", target: "matches", kind: "secondary" })}</div>`;
  }

  function selectedReputationTeam(state, forceNew) {
    if (forceNew) return data.nearbyTeams.find((item) => !item.reputation) || null;
    return data.nearbyTeams.find((item) => item.publicId === state.selectedReputationTeamId) || data.nearbyTeams[0] || null;
  }

  function renderReputation(state, forceNew) {
    const team = selectedReputationTeam(state, forceNew);
    if (!team) return renderReputationState("reputation-empty");
    const established = team.reputation && team.verifiedMatches >= 3;
    if (!established) {
      return `<div class="screen screen--narrow reputation-screen reputation-screen--new">
        ${screenHeader("Time", "Reputação nova", team.name)}
        <section class="new-reputation card">${crest(team.initials, "team-crest--detail")}<span>${icon("star")}</span><h2>Reputação nova</h2><small>Menos de 3 avaliações</small></section>
        <details class="compact-details card"><summary>Detalhes</summary><p>Notas aparecem após 3 avaliações verificadas.</p></details>
        <div class="reputation-back">${button("Ver time", { action: "navigate", target: "opponent-detail", kind: "secondary", full: true })}</div>
      </div>`;
    }
    const reputation = team.reputation;
    return `<div class="screen screen--narrow reputation-screen">
      ${screenHeader("Time", "Reputação do time", team.name)}
      <section class="reputation-hero card">${crest(team.initials, "team-crest--detail")}<div><strong>${reputation.score.toFixed(1).replace(".", ",")}</strong><span>${icon("star")} ${esc(team.verifiedMatches)} avaliações</span></div><i>${icon("shield")}</i></section>
      <section class="reputation-breakdown card">
        ${reputationBar("Pontualidade", reputation.punctuality)}
        ${reputationBar("Organização", reputation.organization)}
        ${reputationBar("Comunicação", reputation.communication)}
        ${reputationBar("Fair play", reputation.fairPlay)}
      </section>
      <section class="play-again card"><strong>${esc(reputation.playAgain)}%</strong><span>jogariam novamente</span>${icon("check")}</section>
      <details class="compact-details card"><summary>Detalhes</summary><p>Média anônima de partidas verificadas.</p></details>
      <div class="reputation-back">${button("Ver time", { action: "navigate", target: "opponent-detail", kind: "secondary", full: true })}</div>
    </div>`;
  }

  function renderReviewState(view) {
    const content = {
      "review-loading": ["more", "Carregando avaliação", "Só um instante."],
      "review-empty": ["star", "Nada para avaliar", "Sem partidas pendentes."],
      "review-error": ["close", "Avaliação indisponível", "Tente novamente."]
    }[view] || ["close", "Avaliação indisponível", "Tente novamente."];
    return `<div class="screen state-page state-page--${view.includes("error") ? "error" : view.includes("loading") ? "loading" : "empty"}"><section class="state-page__visual">${icon(content[0])}${view.includes("loading") ? '<span class="spinner-ring"></span>' : ""}</section><h1>${content[1]}</h1><p>${content[2]}</p>${view.includes("loading") ? "" : button("Ver partidas", { action: "navigate", target: "matches" })}</div>`;
  }

  function renderReputationState(view) {
    const content = {
      "reputation-loading": ["more", "Carregando reputação", "Só um instante."],
      "reputation-empty": ["star", "Sem reputação", "Time indisponível."],
      "reputation-error": ["close", "Reputação indisponível", "Tente novamente."]
    }[view] || ["close", "Reputação indisponível", "Tente novamente."];
    return `<div class="screen state-page state-page--${view.includes("error") ? "error" : view.includes("loading") ? "loading" : "empty"}"><section class="state-page__visual">${icon(content[0])}${view.includes("loading") ? '<span class="spinner-ring"></span>' : ""}</section><h1>${content[1]}</h1><p>${content[2]}</p>${view.includes("loading") ? "" : button("Ver Radar", { action: "navigate", target: "opponents" })}</div>`;
  }

  function renderMatchState(view) {
    const content = {
      "match-loading": ["more", "Carregando partidas", "Só um instante.", "matches"],
      "match-empty": ["calendar", "Nenhuma partida", "Aceite um convite.", "invitations"],
      "match-error": ["close", "Partidas indisponíveis", "Tente novamente.", "matches"],
      "match-access-denied": ["lock", "Acesso negado", "Partida restrita.", "matches"]
    }[view] || ["calendar", "Nenhuma partida", "Aceite um convite.", "invitations"];
    const labels = { "match-loading": "Carregando", "match-empty": "Ver convites", "match-error": "Tentar novamente", "match-access-denied": "Voltar" };
    return `<div class="screen state-page state-page--${view === "match-error" ? "error" : view === "match-access-denied" ? "denied" : view === "match-loading" ? "loading" : "empty"}"><section class="state-page__visual">${icon(content[0])}${view === "match-loading" ? '<span class="spinner-ring"></span>' : ""}</section><p class="eyebrow">Partidas</p><h1>${esc(content[1])}</h1><p>${esc(content[2])}</p>${view === "match-loading" ? "" : button(labels[view] || "Voltar", { action: "navigate", target: content[3] })}</div>`;
  }

  function safetyOption(iconName, title, detail, target, count) {
    return `<button class="safety-option card" type="button" data-action="navigate" data-target="${esc(target)}"><span>${icon(iconName)}</span><div><strong>${esc(title)}</strong><small>${esc(detail)}</small></div>${count ? `<b>${esc(count)}</b>` : icon("arrow")}</button>`;
  }

  function renderSafety(state) {
    return `<div class="screen screen--narrow safety-screen">
      ${screenHeader("Radar", "Segurança e privacidade", "Controle seu time.")}
      <section class="safety-status card"><span>${icon("shield")}</span><div><strong>${state.exitedRadar ? "Fora do Radar" : "Perfil protegido"}</strong><small>${state.exitedRadar ? "Perfil oculto" : "Dados privados"}</small></div><i class="${state.exitedRadar ? "is-off" : ""}"></i></section>
      <section class="safety-menu" aria-label="Opções de segurança">
        ${safetyOption("alert", "Denunciar incidente", "Motivos por seleção", "safety-report")}
        ${safetyOption("close", "Times bloqueados", "Sem novos convites", "safety-blocks", state.blockedTeamIds.length || "")}
        ${safetyOption("trophy", "Contestar resultado", "Sem mudar o placar", "safety-dispute")}
        ${safetyOption("list", "Casos enviados", "Acompanhe a situação", "safety-cases", state.safetyCases.length)}
        ${safetyOption("lock", "Dados e saída", "Privacidade do Radar", "safety-privacy")}
      </section>
      <details class="compact-details card"><summary>Equipe de moderação</summary><p>Acesso restrito.</p>${button("Abrir fila demo", { action: "navigate", target: "moderation-queue", kind: "ghost", full: true })}</details>
      <section class="private-case-note">${icon("shield")}<div><strong>Denúncias são privadas</strong><span>O outro time não vê quem enviou.</span></div></section>
    </div>`;
  }

  function safetyTarget(state, type) {
    if (state.safetyTarget?.type === type) return state.safetyTarget;
    if (type === "team") {
      const team = data.nearbyTeams.find((item) => item.publicId && !state.blockedTeamIds.includes(item.publicId));
      return team ? { type: "team", slug: team.slug, publicId: team.publicId, name: team.name, initials: team.initials } : null;
    }
    const match = state.matches.find((item) => type === "dispute"
      ? ["verified", "divergent"].includes(item.result?.state)
      : true);
    return match ? { type, matchId: match.id, name: match.opponentName, initials: match.opponentInitials } : null;
  }

  function targetStrip(target) {
    if (!target) return "";
    return `<section class="safety-target card">${crest(target.initials || "FC", "team-crest--small")}<div><small>Time</small><strong>${esc(target.name)}</strong></div>${icon("shield")}</section>`;
  }

  function reasonChoices(name, values) {
    return `<div class="safety-choices">${values.map(([value, label, iconName]) => `<label><input type="radio" name="${esc(name)}" value="${esc(value)}" required><span>${icon(iconName || "alert")}<b>${esc(label)}</b></span></label>`).join("")}</div>`;
  }

  function renderSafetyReport(state) {
    const target = safetyTarget(state, state.safetyTarget?.type === "match" ? "match" : "team");
    if (!target) return renderSafetyState("safety-empty");
    return `<div class="screen screen--narrow safety-form-screen">
      ${screenHeader("Segurança", "Denunciar", "Escolha o motivo.")}
      ${targetStrip(target)}
      <form data-form="safety-report" class="safety-form">
        ${reasonChoices("category", [["unsafe_conduct", "Conduta perigosa", "alert"], ["harassment", "Assédio", "close"], ["identity_fraud", "Identidade falsa", "user"], ["spam", "Spam", "send"], ["inappropriate_content", "Conteúdo impróprio", "eye"], ["other", "Outro", "more"]])}
        <details class="compact-details card"><summary>Adicionar descrição</summary><label class="field"><span>Privada · até 500 caracteres</span><textarea name="description" maxlength="500" rows="3"></textarea></label></details>
        <div class="sticky-actions">${button("Enviar denúncia", { type: "submit", icon: "send", full: true })}</div>
      </form>
    </div>`;
  }

  function renderSafetyBlock(state) {
    const target = safetyTarget(state, "team");
    if (!target) return renderSafetyState("safety-empty");
    return `<div class="screen screen--narrow safety-form-screen">
      ${screenHeader("Segurança", "Bloquear time", "Ação imediata.")}
      ${targetStrip(target)}
      <section class="impact-list card"><div>${icon("eye")}<span>Some da busca</span></div><div>${icon("send")}<span>Convites encerrados</span></div><div>${icon("lock")}<span>Contato oculto</span></div></section>
      <form data-form="safety-block" class="safety-form">
        ${reasonChoices("reason", [["unwanted_contact", "Contato indesejado", "send"], ["conduct", "Conduta", "alert"], ["safety", "Segurança", "shield"], ["other", "Outro", "more"]])}
        <div class="sticky-actions">${button("Bloquear time", { type: "submit", icon: "close", full: true })}</div>
      </form>
    </div>`;
  }

  function renderSafetyBlocks(state) {
    const teams = data.nearbyTeams.filter((item) => item.publicId && state.blockedTeamIds.includes(item.publicId));
    return `<div class="screen screen--narrow safety-screen">
      ${screenHeader("Privacidade", "Times bloqueados", `${teams.length} ${teams.length === 1 ? "time" : "times"}.`)}
      ${teams.length ? `<section class="safety-list">${teams.map((team) => `<article class="safety-list-item card">${crest(team.initials, "team-crest--small")}<div><strong>${esc(team.name)}</strong><small>Contato oculto</small></div><button type="button" data-action="unblock-team" data-id="${esc(team.publicId)}">Desbloquear</button></article>`).join("")}</section>` : `<section class="inline-empty card">${icon("shield")}<h2>Nenhum bloqueio</h2><p>Sua lista está vazia.</p></section>`}
    </div>`;
  }

  function caseStatus(item) {
    const tone = item.status === "Resolvido" ? "accepted" : item.status === "Em análise" || item.status === "Atribuído" ? "counter" : "pending";
    return `<span class="invite-state invite-state--${tone}">${esc(item.status)}</span>`;
  }

  function renderSafetyCases(state) {
    return `<div class="screen screen--narrow safety-screen">
      ${screenHeader("Moderação", "Casos enviados", `${state.safetyCases.length} registros.`)}
      ${state.safetyCases.length ? `<section class="case-list">${state.safetyCases.map((item) => `<article class="case-card card"><div><span>${esc(item.type)}</span>${caseStatus(item)}</div><strong>${esc(item.category)}</strong><p>${esc(item.teamName)} · ${esc(item.createdLabel)}</p><details><summary>Detalhes</summary><small>Caso ${esc(item.id)} · v${esc(item.version)}</small></details></article>`).join("")}</section>` : renderSafetyState("safety-empty")}
    </div>`;
  }

  function renderSafetyDispute(state) {
    const target = safetyTarget(state, "dispute");
    if (!target) return renderSafetyState("safety-empty");
    const match = state.matches.find((item) => item.id === target.matchId);
    const score = match?.result?.official || match?.result?.mine || { mine: "–", opponent: "–" };
    return `<div class="screen screen--narrow safety-form-screen">
      ${screenHeader("Resultado", "Contestar placar", "O placar não muda agora.")}
      ${targetStrip(target)}
      <section class="dispute-score card"><strong>${esc(score.mine)}</strong><span>×</span><strong>${esc(score.opponent)}</strong></section>
      <form data-form="safety-dispute" class="safety-form">
        ${reasonChoices("reason", [["score_incorrect", "Placar incorreto", "trophy"], ["identity_fraud", "Partida incorreta", "alert"], ["other", "Outro", "more"]])}
        <details class="compact-details card"><summary>Adicionar descrição</summary><label class="field"><span>Privada · até 500 caracteres</span><textarea name="description" maxlength="500" rows="3"></textarea></label></details>
        <div class="sticky-actions">${button("Enviar contestação", { type: "submit", icon: "send", full: true })}</div>
      </form>
    </div>`;
  }

  function renderSafetyPrivacy(state) {
    return `<div class="screen screen--narrow safety-screen">
      ${screenHeader("Radar", "Dados e saída", "Controle sua presença.")}
      <section class="privacy-metrics card"><div><strong>${state.availabilities.filter((item) => item.status === "active").length}</strong><span>disponibilidades</span></div><div><strong>${state.invitations.filter((item) => ["pending", "counter_proposed"].includes(item.state)).length}</strong><span>convites abertos</span></div><div><strong>${state.safetyCases.length}</strong><span>casos</span></div></section>
      <section class="privacy-card card">${icon("eye")}<div><strong>Perfil no Radar</strong><span>${state.exitedRadar ? "Oculto" : "Visível"}</span></div>${caseStatus({ status: state.exitedRadar ? "Desativado" : "Ativo" })}</section>
      <details class="compact-details card"><summary>O que é preservado</summary><p>Histórico obrigatório e auditoria protegida.</p></details>
      ${state.exitedRadar ? `<section class="private-case-note">${icon("check")}<div><strong>Saída concluída</strong><span>Novos convites bloqueados.</span></div></section>` : `<div class="privacy-exit">${button("Sair do Radar", { action: "navigate", target: "safety-exit", kind: "danger", full: true })}</div>`}
    </div>`;
  }

  function renderSafetyExit() {
    return `<div class="screen screen--narrow safety-form-screen">
      ${screenHeader("Privacidade", "Sair do Radar", "Revise antes de sair.")}
      <section class="impact-list card"><div>${icon("eye")}<span>Perfil oculto</span></div><div>${icon("calendar")}<span>Disponibilidades canceladas</span></div><div>${icon("send")}<span>Convites encerrados</span></div></section>
      <form data-form="safety-exit" class="safety-form"><label class="consent"><input type="checkbox" name="confirm" value="yes" required><span>${icon("check")}</span><span>Confirmo a saída.</span></label><div class="sticky-actions">${button("Confirmar saída", { type: "submit", icon: "close", full: true })}</div></form>
    </div>`;
  }

  function renderModerationQueue(state) {
    return `<div class="screen screen--wide safety-screen">
      ${screenHeader("Admin", "Fila de moderação", `${state.moderationCases.filter((item) => item.status !== "Resolvido").length} pendentes.`)}
      <section class="moderation-grid">${state.moderationCases.map((item) => `<button class="moderation-card card" type="button" data-action="open-moderation-case" data-id="${esc(item.id)}"><span>${icon(item.type === "Contestação" ? "trophy" : "alert")}</span><div><small>${esc(item.type)} · ${esc(item.createdLabel)}</small><strong>${esc(item.category)}</strong><p>${esc(item.teamName)}</p></div><div>${caseStatus(item)}<small>${esc(item.priority)}</small></div></button>`).join("")}</section>
      <details class="compact-details card"><summary>Simular permissão</summary>${button("Acesso negado", { action: "navigate", target: "moderation-access-denied", kind: "ghost", full: true })}</details>
    </div>`;
  }

  function renderModerationCase(state) {
    const item = state.moderationCases.find((entry) => entry.id === state.selectedModerationCaseId);
    if (!item) return renderSafetyState("safety-empty");
    return `<div class="screen screen--narrow safety-form-screen">
      ${screenHeader("Admin", "Revisar caso", `v${item.version} · ${item.createdLabel}`)}
      <section class="case-summary card"><div>${caseStatus(item)}<small>${esc(item.type)}</small></div><h2>${esc(item.category)}</h2><p>${esc(item.teamName)}</p></section>
      ${item.status === "Aberto" ? `<div class="assign-action">${button("Atribuir a mim", { action: "assign-moderation-case", id: item.id, icon: "user", full: true })}</div>` : item.status === "Resolvido" ? `<section class="private-case-note">${icon("check")}<div><strong>${esc(item.resolution || "Caso resolvido")}</strong><span>Decisão auditada.</span></div></section>` : `<form data-form="moderation-resolve" data-id="${esc(item.id)}" class="safety-form"><fieldset class="filter-section"><legend>Decisão</legend><select name="decision" required><option value="">Selecione</option><option value="dismiss">Arquivar</option><option value="warn">Orientar time</option><option value="invalidate_review">Invalidar avaliação</option><option value="invalidate_result">Invalidar resultado</option><option value="suspend_team">Suspender time</option></select></fieldset><fieldset class="filter-section"><legend>Motivo</legend><select name="reason" required><option value="">Selecione</option><option value="no_violation">Sem violação</option><option value="insufficient_evidence">Provas insuficientes</option><option value="violation_confirmed">Violação confirmada</option><option value="invalid_review">Avaliação inválida</option><option value="invalid_result">Resultado inválido</option></select></fieldset><div class="sticky-actions">${button("Registrar decisão", { type: "submit", icon: "shield", full: true })}</div></form>`}
    </div>`;
  }

  function renderSafetyState(view) {
    const content = {
      "safety-report-success": ["check", "Denúncia enviada", "A moderação recebeu."],
      "safety-dispute-success": ["check", "Contestação enviada", "O placar segue igual."],
      "safety-exit-success": ["shield", "Saída concluída", "Perfil oculto."],
      "safety-empty": ["shield", "Nada por aqui", "Nenhum registro."],
      "safety-error": ["close", "Ação indisponível", "Tente novamente."],
      "safety-access-denied": ["lock", "Acesso negado", "Conta sem permissão."],
      "moderation-access-denied": ["lock", "Acesso restrito", "Somente moderadores."]
    }[view];
    return `<div class="screen state-page state-page--${view.includes("success") ? "success" : view.includes("denied") ? "denied" : view.includes("error") ? "error" : "empty"}"><section class="state-page__visual">${icon(content[0])}</section><p class="eyebrow">Segurança</p><h1>${esc(content[1])}</h1><p>${esc(content[2])}</p>${button("Voltar à segurança", { action: "navigate", target: "safety", trailing: "arrow" })}</div>`;
  }

  function renderNotifications(state) {
    const unread = state.notifications.filter((item) => !item.read).length;
    return `<div class="screen screen--narrow notifications-screen">
      ${screenHeader("Meu Clube", "Notificações", unread ? `${unread} novas.` : "Tudo lido.")}
      <section class="notification-list">${state.notifications.map((item) => `<article class="notification-card card${item.read ? "" : " is-unread"}"><span>${icon(["accepted", "confirmation"].includes(item.type) ? "check" : item.type === "invite" ? "send" : item.type === "cancelled" ? "close" : "calendar")}</span><div><h2>${esc(item.title)}</h2><p>${esc(item.detail)}</p></div><small>${esc(item.time)}</small></article>`).join("")}</section>
      ${unread ? button("Marcar como lidas", { action: "notifications-read", kind: "secondary", full: true }) : ""}
      ${button("Ver convites", { action: "navigate", target: "invitations", full: true })}
    </div>`;
  }

  function renderInvitationsEmpty() {
    return `<section class="inline-empty card">${icon("send")}<h2>Nenhum convite</h2><p>Encontre um time para começar.</p>${button("Encontrar time", { action: "navigate", target: "opponents" })}</section>`;
  }

  function renderInvitationsEmptyPage() {
    return `<div class="screen state-page state-page--empty"><section class="state-page__visual">${icon("send")}</section><h1>Nenhum convite</h1><p>Encontre um time para começar.</p>${button("Encontrar time", { action: "navigate", target: "opponents" })}</div>`;
  }

  function renderInvitationsError() {
    return `<div class="screen state-page state-page--error"><section class="state-page__visual">${icon("close")}</section><h1>Convites indisponíveis</h1><p>Tente novamente.</p>${button("Tentar novamente", { action: "navigate", target: "invitations" })}</div>`;
  }

  function renderStates() {
    const states = [
      ["opponents-loading", "Busca carregando", "Ordenando times"],
      ["opponents-error", "Erro na busca", "Filtros preservados"],
      ["match-loading", "Partidas carregando", "Preparando a central"],
      ["match-empty", "Sem partidas", "Aceite um convite"],
      ["match-error", "Erro nas partidas", "Tente novamente"],
      ["match-access-denied", "Partida restrita", "Acesso negado"],
      ["loading", "Carregamento", "Preparando dados"],
      ["empty", "Lista vazia", "Sem publicações"],
      ["success", "Ação concluída", "Tudo certo"],
      ["error", "Erro recuperável", "Tente novamente"],
      ["session-expired", "Sessão expirada", "Entre novamente"],
      ["access-denied", "Acesso negado", "Sem permissão"]
    ];
    return `<div class="screen screen--wide">${screenHeader("Demonstração", "Estados da tela", "Confira os retornos.")}
      <div class="states-grid">${states.map(([target, title, detail]) => `<button class="state-card card" type="button" data-action="navigate" data-target="${target}"><span>${icon(target === "success" ? "check" : target === "loading" ? "more" : target === "access-denied" ? "lock" : "radar")}</span><div><strong>${esc(title)}</strong><p>${esc(detail)}</p></div>${icon("arrow")}</button>`).join("")}</div>
    </div>`;
  }

  function renderStateView(view) {
    const content = {
      loading: { tone: "loading", icon: "more", eyebrow: "Radar", title: "Preparando dados", text: "Só um instante.", action: "Voltar", target: "states" },
      empty: { tone: "empty", icon: "calendar", eyebrow: "Radar", title: "Nenhuma disponibilidade", text: "Publique para aparecer.", action: "Criar disponibilidade", target: "availability-form" },
      success: { tone: "success", icon: "check", eyebrow: "Radar", title: "Disponibilidade publicada", text: "Publicação ativa.", action: "Ver disponibilidades", target: "availabilities" },
      error: { tone: "error", icon: "close", eyebrow: "Radar", title: "Algo deu errado", text: "Tente novamente.", action: "Tentar novamente", target: "states" },
      "session-expired": { tone: "warning", icon: "lock", eyebrow: "Segurança", title: "Sessão expirada", text: "Entre novamente.", action: "Voltar", target: "home" },
      "access-denied": { tone: "denied", icon: "shield", eyebrow: "Segurança", title: "Acesso negado", text: "Conta sem permissão.", action: "Voltar", target: "home" }
    }[view];
    return `<div class="screen state-page state-page--${content.tone}">
      <section class="state-page__visual">${icon(content.icon)}${view === "loading" ? '<span class="spinner-ring"></span>' : ""}</section>
      <p class="eyebrow">${esc(content.eyebrow)}</p><h1>${esc(content.title)}</h1><p>${esc(content.text)}</p>
      ${button(content.action, { action: "navigate", target: content.target, trailing: "arrow" })}
      ${view !== "loading" ? button("Ver todos os estados", { action: "navigate", target: "states", kind: "ghost" }) : ""}
    </div>`;
  }

  function renderScreen(state) {
    const screens = {
      home: renderHome,
      eligibility: renderEligibility,
      "profile-manual": renderManualProfile,
      "print-import": renderPrintImport,
      "draft-review": renderDraftReview,
      verification: renderVerification,
      availabilities: renderAvailabilities,
      "availability-form": renderAvailabilityForm,
      opponents: renderOpponents,
      "opponent-filters": renderOpponentFilters,
      "opponent-detail": renderOpponentDetail,
      "opponents-loading": renderOpponentsLoading,
      "opponents-error": renderOpponentsError,
      "invitation-compose": renderInvitationCompose,
      "invitation-review": renderInvitationReview,
      "invitation-sent": renderInvitationSent,
      invitations: renderInvitations,
      "invitation-detail": renderInvitationDetail,
      "invitation-counter": renderInvitationCounter,
      "match-confirmed": renderMatchConfirmed,
      matches: renderMatches,
      "match-detail": renderMatchDetail,
      "match-cancel": renderMatchCancel,
      "match-cancelled": renderMatchCancelled,
      "match-loading": () => renderMatchState("match-loading"),
      "match-empty": () => renderMatchState("match-empty"),
      "match-error": () => renderMatchState("match-error"),
      "match-access-denied": () => renderMatchState("match-access-denied"),
      "score-form": renderScoreForm,
      "score-review": renderScoreReview,
      "score-waiting": renderScoreWaiting,
      "score-confirm": renderScoreConfirm,
      "score-divergent": renderScoreDivergent,
      "score-verified": renderScoreVerified,
      "score-loading": () => renderScoreState("score-loading"),
      "score-empty": () => renderScoreState("score-empty"),
      "score-error": () => renderScoreState("score-error"),
      "score-access-denied": () => renderScoreState("score-access-denied"),
      "score-repeated": () => renderScoreState("score-repeated"),
      history: renderHistory,
      "head-to-head": renderHeadToHead,
      "history-loading": () => renderHistoryState("history-loading"),
      "history-empty": () => renderHistoryState("history-empty"),
      "history-error": () => renderHistoryState("history-error"),
      "review-form": renderReviewForm,
      "review-confirm": renderReviewConfirm,
      "review-complete": renderReviewComplete,
      "review-loading": () => renderReviewState("review-loading"),
      "review-empty": () => renderReviewState("review-empty"),
      "review-error": () => renderReviewState("review-error"),
      reputation: renderReputation,
      "reputation-new": (state) => renderReputation(state, true),
      "reputation-loading": () => renderReputationState("reputation-loading"),
      "reputation-empty": () => renderReputationState("reputation-empty"),
      "reputation-error": () => renderReputationState("reputation-error"),
      safety: renderSafety,
      "safety-report": renderSafetyReport,
      "safety-report-success": () => renderSafetyState("safety-report-success"),
      "safety-block": renderSafetyBlock,
      "safety-blocks": renderSafetyBlocks,
      "safety-cases": renderSafetyCases,
      "safety-dispute": renderSafetyDispute,
      "safety-dispute-success": () => renderSafetyState("safety-dispute-success"),
      "safety-privacy": renderSafetyPrivacy,
      "safety-exit": renderSafetyExit,
      "safety-exit-success": () => renderSafetyState("safety-exit-success"),
      "safety-empty": () => renderSafetyState("safety-empty"),
      "safety-error": () => renderSafetyState("safety-error"),
      "safety-access-denied": () => renderSafetyState("safety-access-denied"),
      "moderation-queue": renderModerationQueue,
      "moderation-case": renderModerationCase,
      "moderation-access-denied": () => renderSafetyState("moderation-access-denied"),
      notifications: renderNotifications,
      "invitations-empty": renderInvitationsEmptyPage,
      "invitations-error": renderInvitationsError,
      states: renderStates
    };
    if (screens[state.view]) return screens[state.view](state);
    return renderStateView(state.view);
  }

  function activeClass(current, views) {
    return views.includes(current) ? " is-active" : "";
  }

  function shell(state, screen) {
    const canGoBack = state.view !== "home";
    return `<div class="demo-banner"><span class="demo-banner__dot"></span><strong>Demonstração local</strong><span>— nenhum dado real</span><button type="button" data-action="reset-demo">Reiniciar</button></div>
      <header class="topbar">
        <div class="topbar__inner">
          <button class="back-button${canGoBack ? "" : " back-button--hidden"}" type="button" data-action="back" aria-label="Voltar">${icon("back")}</button>
          <button class="brand" type="button" data-action="navigate" data-target="home" aria-label="Meu Clube FC — início"><span class="brand__mark">MCF</span><span><strong>MEU CLUBE</strong><small>FUTEBOL DE VERDADE</small></span></button>
          <div class="topbar__actions"><button class="notification-button" type="button" data-action="navigate" data-target="notifications" aria-label="Notificações">${icon("bell")}${state.notifications.some((item) => !item.read) ? `<i>${state.notifications.filter((item) => !item.read).length}</i>` : ""}</button>${crest("EN", "team-crest--mini")}</div>
        </div>
      </header>
      <div class="app-layout">
        <aside class="sidebar" aria-label="Navegação do Radar">
          <nav>
            <p>MEU TIME</p>
            <button class="nav-item${activeClass(state.view, ["home"])}" type="button" data-action="navigate" data-target="home">${icon("home")}<span>Central do time</span></button>
            <button class="nav-item${activeClass(state.view, ["opponents", "opponent-filters", "opponent-detail", "opponents-loading", "opponents-error"])}" type="button" data-action="navigate" data-target="opponents">${icon("radar")}<span>Encontrar amistoso</span><i>NOVO</i></button>
            <button class="nav-item${activeClass(state.view, ["invitations", "invitation-compose", "invitation-review", "invitation-sent", "invitation-detail", "invitation-counter", "notifications", "invitations-empty", "invitations-error"])}" type="button" data-action="navigate" data-target="invitations">${icon("send")}<span>Convites</span></button>
            <button class="nav-item${activeClass(state.view, ["matches", "match-confirmed", "match-detail", "match-cancel", "match-cancelled", "match-loading", "match-empty", "match-error", "match-access-denied"])}" type="button" data-action="navigate" data-target="matches">${icon("calendar")}<span>Partidas</span></button>
            <button class="nav-item${activeClass(state.view, ["history", "head-to-head", "history-loading", "history-empty", "history-error"])}" type="button" data-action="navigate" data-target="history">${icon("trophy")}<span>Histórico</span></button>
            <button class="nav-item${activeClass(state.view, ["eligibility", "profile-manual", "print-import", "draft-review", "verification"])}" type="button" data-action="navigate" data-target="eligibility">${icon("shield")}<span>Cadastro</span></button>
            <button class="nav-item${activeClass(state.view, ["availabilities", "availability-form"])}" type="button" data-action="navigate" data-target="availabilities">${icon("calendar")}<span>Disponibilidades</span></button>
            <button class="nav-item${activeClass(state.view, ["safety", "safety-report", "safety-report-success", "safety-block", "safety-blocks", "safety-cases", "safety-dispute", "safety-dispute-success", "safety-privacy", "safety-exit", "safety-exit-success", "safety-empty", "safety-error", "safety-access-denied", "moderation-queue", "moderation-case", "moderation-access-denied"])}" type="button" data-action="navigate" data-target="safety">${icon("lock")}<span>Segurança</span></button>
            <p>DEMONSTRAÇÃO</p>
            <button class="nav-item${activeClass(state.view, ["states", "loading", "empty", "success", "error", "session-expired", "access-denied"])}" type="button" data-action="navigate" data-target="states">${icon("list")}<span>Estados da tela</span></button>
          </nav>
          <div class="sidebar__safety">${icon("shield")}<p><strong>Ambiente seguro</strong><span>Sem API e sem dados reais</span></p></div>
        </aside>
        <main class="main" id="radar-main" tabindex="-1">${screen}</main>
      </div>
      <nav class="bottom-nav" aria-label="Navegação principal">
        <button class="${activeClass(state.view, ["opponents", "opponent-filters", "opponent-detail", "opponents-loading", "opponents-error"])}" type="button" data-action="navigate" data-target="opponents">${icon("radar")}<span>Radar</span></button>
        <button class="${activeClass(state.view, ["invitations", "invitation-compose", "invitation-review", "invitation-sent", "invitation-detail", "invitation-counter", "notifications", "invitations-empty", "invitations-error"])}" type="button" data-action="navigate" data-target="invitations">${icon("send")}<span>Convites</span></button>
        <button class="${activeClass(state.view, ["history", "head-to-head", "history-loading", "history-empty", "history-error", "matches", "match-detail"])}" type="button" data-action="navigate" data-target="history">${icon("trophy")}<span>Histórico</span></button>
        <button class="${activeClass(state.view, ["home", "eligibility", "profile-manual", "print-import", "draft-review", "verification", "availabilities", "availability-form", "safety", "safety-report", "safety-block", "safety-blocks", "safety-cases", "safety-dispute", "safety-privacy", "safety-exit", "moderation-queue", "moderation-case"])}" type="button" data-action="navigate" data-target="home">${icon("user")}<span>Meu time</span></button>
      </nav>
      ${state.toast ? `<div class="toast toast--${esc(state.toast.tone)}" role="status">${icon(state.toast.tone === "success" ? "check" : "radar")}<span>${esc(state.toast.message)}</span><button type="button" data-action="dismiss-toast" aria-label="Fechar aviso">${icon("close")}</button></div>` : ""}
      ${state.busy ? `<div class="busy-overlay" role="status" aria-live="polite"><span class="loader"></span><strong>${esc(state.busyLabel)}</strong></div>` : ""}`;
  }

  function formValues(form) {
    return Object.fromEntries(new FormData(form).entries());
  }

  function create(root, store, router) {
    let currentState = store.getState();

    function render(state) {
      currentState = state;
      root.innerHTML = shell(state, renderScreen(state));
      document.title = `${root.querySelector("h1")?.textContent || "Radar de Amistosos"} — demonstração local`;
    }

    store.subscribe(render);

    root.addEventListener("click", async (event) => {
      const control = event.target.closest("[data-action]");
      if (!control || control.disabled) return;
      const action = control.dataset.action;
      const target = control.dataset.target;
      const id = control.dataset.id;

      if (action === "navigate") router.navigate(target);
      if (action === "back") router.back();
      if (action === "reset-demo") { store.reset(); router.navigate("home", { replace: true }); }
      if (action === "dismiss-toast") store.dismissToast();
      if (action === "preview-team") store.notify ? store.notify("Perfil público aberto na demonstração.", "info") : null;
      if (action === "demo-print") store.setImportedPreview("demo");
      if (action === "create-draft") { await store.prepareDraft(); router.navigate("draft-review"); }
      if (action === "start-verification") await store.startVerification();
      if (action === "confirm-verification") await store.confirmVerification();
      if (action === "approve-verification") await store.approveVerification();
      if (action === "new-availability") { store.beginAvailabilityEdit(null); router.navigate("availability-form"); }
      if (action === "edit-availability") { store.beginAvailabilityEdit(id); router.navigate("availability-form"); }
      if (action === "toggle-availability") store.toggleAvailability(id);
      if (action === "cancel-availability" && window.confirm("Cancelar esta disponibilidade demonstrativa?")) store.cancelAvailability(id);
      if (action === "open-opponent-filters") {
        store.rememberOpponentListPosition(window.scrollY);
        router.navigate("opponent-filters");
      }
      if (action === "view-opponent") {
        store.selectOpponent(id, window.scrollY);
        router.navigate("opponent-detail");
      }
      if (action === "load-more-opponents") await store.loadMoreOpponents();
      if (action === "clear-opponent-filters") {
        store.clearOpponentFilters();
        router.navigate("opponents");
      }
      if (action === "retry-opponents") router.navigate("opponents");
      if (action === "invite-preview") { store.beginInvitation(id || currentState.selectedOpponentSlug); router.navigate("invitation-compose"); }
      if (action === "send-invitation") { await store.sendInvitation(); router.navigate("invitation-sent"); }
      if (action === "invitation-box") store.setInvitationBox(target);
      if (action === "open-invitation") { store.selectInvitation(id); router.navigate("invitation-detail"); }
      if (action === "accept-invitation") { await store.acceptInvitation(id); router.navigate("match-detail"); }
      if (action === "decline-invitation") { store.declineInvitation(id); router.navigate("invitations"); }
      if (action === "cancel-invitation") { store.cancelInvitation(id); router.navigate("invitations"); }
      if (action === "counter-invitation") { store.selectInvitation(id); router.navigate("invitation-counter"); }
      if (action === "notifications-read") store.markNotificationsRead();
      if (action === "match-box") store.setMatchBox(target);
      if (action === "open-match") { store.selectMatch(id, window.scrollY); router.navigate("match-detail"); }
      if (action === "open-history-match") { store.openHistoryMatch(id, window.scrollY); router.navigate("match-detail"); }
      if (action === "open-head-to-head" && store.selectHistoryOpponent(id, window.scrollY)) router.navigate("head-to-head");
      if (action === "load-more-history") await store.loadMoreHistory();
      if (action === "cancel-match") router.navigate("match-cancel");
      if (action === "confirm-match") await store.confirmMatchOccurrence(id || currentState.selectedMatchId);
      if (action === "begin-score") { store.beginScore(id || currentState.selectedMatchId); router.navigate("score-form"); }
      if (action === "different-score") { store.beginScore(id || currentState.selectedMatchId, "different"); router.navigate("score-form"); }
      if (action === "submit-score") {
        const result = await store.submitScore(id || currentState.selectedMatchId);
        router.navigate(result === "verified" ? "score-verified" : result === "divergent" ? "score-divergent" : result === "waiting_other" ? "score-waiting" : "score-error");
      }
      if (action === "confirm-score") {
        const confirmed = await store.confirmReceivedScore(id || currentState.selectedMatchId);
        router.navigate(confirmed ? "score-verified" : "score-error");
      }
      if (action === "begin-review" && store.beginReview(id || currentState.selectedMatchId)) router.navigate("review-form");
      if (action === "submit-review") {
        const submitted = await store.submitReview(id || currentState.selectedReviewMatchId);
        router.navigate(submitted ? "review-complete" : "review-error");
      }
      if (action === "open-reputation" && store.selectReputationTeam(id)) router.navigate("reputation");
      if (action === "begin-block" && store.beginBlock(id)) router.navigate("safety-block");
      if (action === "begin-report-team" && store.beginSafetyReport("team", id)) router.navigate("safety-report");
      if (action === "begin-report-match" && store.beginSafetyReport("match", id)) router.navigate("safety-report");
      if (action === "unblock-team") store.unblockTeam(id);
      if (action === "begin-dispute" && store.beginDispute(id)) router.navigate("safety-dispute");
      if (action === "open-moderation-case" && store.selectModerationCase(id)) router.navigate("moderation-case");
      if (action === "assign-moderation-case") store.assignModerationCase(id);
      if (action === "copy-code") {
        try { await navigator.clipboard.writeText("MCF-4827"); } catch (_error) { /* A seleção manual continua disponível. */ }
        control.classList.add("is-copied");
        const live = document.getElementById("radar-live");
        if (live) live.textContent = "Código demonstrativo copiado.";
      }
      if (["notify-settings", "notify-opponents", "notify-opponent", "availability-details"].includes(action)) {
        const live = document.getElementById("radar-live");
        if (live) live.textContent = "Ação demonstrativa concluída.";
        control.classList.add("is-touched");
        window.setTimeout(() => control.classList.remove("is-touched"), 500);
      }
    });

    root.addEventListener("change", (event) => {
      const historyFilter = event.target.closest("[data-history-filter]");
      if (historyFilter) {
        store.setHistoryFilter(historyFilter.dataset.historyFilter, historyFilter.value);
        return;
      }
      const input = event.target.closest('[data-input="profile-print"]');
      if (!input || !input.files || !input.files[0]) return;
      const file = input.files[0];
      if (!/^image\/(png|jpeg|webp)$/.test(file.type) || file.size > 8 * 1024 * 1024) {
        window.alert("Escolha uma imagem PNG, JPG ou WebP de até 8 MB.");
        input.value = "";
        return;
      }
      const reader = new FileReader();
      reader.onload = () => store.setImportedPreview(String(reader.result));
      reader.readAsDataURL(file);
    });

    root.addEventListener("input", (event) => {
      const range = event.target.closest("#opponent-radius");
      if (!range) return;
      const output = root.querySelector(".radius-output");
      if (output) output.value = `${range.value} km`;
    });

    root.addEventListener("submit", async (event) => {
      const form = event.target;
      event.preventDefault();
      if (!form.reportValidity()) return;
      const values = formValues(form);
      if (form.dataset.form === "manual-profile") {
        await store.saveManualProfile(values);
        router.navigate("verification");
      }
      if (form.dataset.form === "draft-review") {
        await store.acceptDraft(values);
        router.navigate("verification");
      }
      if (form.dataset.form === "availability") {
        await store.saveAvailability(values);
        router.navigate("availabilities");
      }
      if (form.dataset.form === "opponent-filters") {
        store.applyOpponentFilters(values);
        router.navigate("opponents");
      }
      if (form.dataset.form === "invitation-compose") {
        store.reviewInvitation(values);
        router.navigate("invitation-review");
      }
      if (form.dataset.form === "invitation-counter") {
        await store.counterInvitation(currentState.selectedInvitationId, values);
        router.navigate("invitations");
      }
      if (form.dataset.form === "match-cancel") {
        await store.cancelMatch(currentState.selectedMatchId, values);
        router.navigate("match-cancelled");
      }
      if (form.dataset.form === "score-form") {
        if (store.reviewScore(values, form.dataset.id)) router.navigate("score-review");
      }
      if (form.dataset.form === "team-review") {
        if (store.reviewEvaluation(values, form.dataset.id)) router.navigate("review-confirm");
      }
      if (form.dataset.form === "safety-report") {
        if (!currentState.safetyTarget) store.beginSafetyReport("team", data.nearbyTeams[0].slug);
        if (store.submitSafetyReport(values)) router.navigate("safety-report-success");
      }
      if (form.dataset.form === "safety-block") {
        if (store.blockSelected(values)) router.navigate("safety-blocks");
      }
      if (form.dataset.form === "safety-dispute") {
        if (!currentState.safetyTarget || currentState.safetyTarget.type !== "dispute") {
          const match = currentState.matches.find((item) => ["verified", "divergent"].includes(item.result?.state));
          if (match) store.beginDispute(match.id);
        }
        if (store.submitDispute(values)) router.navigate("safety-dispute-success");
      }
      if (form.dataset.form === "safety-exit") {
        if (store.exitRadar()) router.navigate("safety-exit-success");
      }
      if (form.dataset.form === "moderation-resolve") {
        if (store.resolveModerationCase(form.dataset.id, values)) router.navigate("moderation-queue");
      }
    });

    return { render: () => render(currentState) };
  }

  window.RadarUI = { create };
})();
