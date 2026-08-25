(function () {
  "use strict";

  const allowedViews = new Set([
    "home", "eligibility", "profile-manual", "print-import", "draft-review", "verification",
    "availabilities", "availability-form", "opponents", "opponent-filters", "opponent-detail",
    "invitation-compose", "invitation-review", "invitation-sent", "invitations",
    "invitation-detail", "invitation-counter", "match-confirmed", "matches", "match-detail",
    "match-cancel", "match-cancelled", "match-loading", "match-empty", "match-error",
    "match-access-denied", "score-form", "score-review", "score-waiting", "score-confirm",
    "score-divergent", "score-verified", "score-loading", "score-empty", "score-error",
    "score-access-denied", "score-repeated", "history", "head-to-head",
    "history-loading", "history-empty", "history-error", "notifications",
    "review-form", "review-confirm", "review-complete", "review-loading", "review-empty",
    "review-error", "reputation", "reputation-new", "reputation-loading",
    "reputation-empty", "reputation-error",
    "safety", "safety-report", "safety-report-success", "safety-block",
    "safety-blocks", "safety-cases", "safety-dispute", "safety-dispute-success",
    "safety-privacy", "safety-exit", "safety-exit-success", "safety-empty",
    "safety-error", "safety-access-denied", "moderation-queue", "moderation-case",
    "moderation-access-denied",
    "invitations-empty", "invitations-error",
    "opponents-loading", "opponents-error", "states", "loading", "empty", "success", "error",
    "session-expired", "access-denied"
  ]);

  function viewFromLocation() {
    const requested = new URL(window.location.href).searchParams.get("view") || "home";
    return allowedViews.has(requested) ? requested : "home";
  }

  function createRouter(store) {
    function buildUrl(view) {
      const url = new URL(window.location.href);
      url.search = "";
      url.searchParams.set("demo", "1");
      url.searchParams.set("view", allowedViews.has(view) ? view : "home");
      const original = new URL(window.location.href).searchParams;
      if (original.get("omascote_app") === "1") url.searchParams.set("omascote_app", "1");
      if (original.get("capture") === "1") url.searchParams.set("capture", "1");
      return url;
    }

    function navigate(view, options) {
      const safeView = allowedViews.has(view) ? view : "home";
      const method = options && options.replace ? "replaceState" : "pushState";
      const currentDepth = Number(window.history.state?.radarDemoDepth || 0);
      const nextDepth = method === "replaceState" ? currentDepth : currentDepth + 1;
      store.dismissToast();
      window.history[method]({ radarDemo: true, radarDemoDepth: nextDepth, view: safeView }, "", buildUrl(safeView));
      store.setView(safeView);
      window.scrollTo({ top: 0, behavior: "auto" });
      window.requestAnimationFrame(() => {
        window.scrollTo({ top: 0, behavior: "auto" });
        document.getElementById("radar-main")?.focus({ preventScroll: true });
      });
    }

    function back() {
      if (Number(window.history.state?.radarDemoDepth || 0) > 0) {
        window.history.back();
      } else {
        const current = store.getState().view;
        const fallback = ["opponent-detail", "opponent-filters", "opponents-loading", "opponents-error", "invitation-compose", "invitation-review", "invitation-sent"].includes(current)
          ? "opponents"
          : ["invitation-detail", "invitation-counter", "notifications", "invitations-empty", "invitations-error"].includes(current)
            ? "invitations"
            : ["match-confirmed", "match-detail", "match-cancel", "match-cancelled", "match-loading", "match-empty", "match-error", "match-access-denied"].includes(current)
              ? "matches"
            : ["score-form", "score-review", "score-waiting", "score-confirm", "score-divergent", "score-verified", "score-loading", "score-empty", "score-error", "score-access-denied", "score-repeated"].includes(current)
              ? "match-detail"
            : ["head-to-head", "history-loading", "history-empty", "history-error"].includes(current)
              ? "history"
            : ["review-form", "review-confirm", "review-complete", "review-loading", "review-empty", "review-error"].includes(current)
              ? "match-detail"
            : ["reputation", "reputation-new", "reputation-loading", "reputation-empty", "reputation-error"].includes(current)
              ? "opponent-detail"
            : ["safety-report", "safety-report-success", "safety-block", "safety-blocks", "safety-cases", "safety-privacy", "safety-exit", "safety-exit-success", "safety-empty", "safety-error", "safety-access-denied", "moderation-queue", "moderation-access-denied"].includes(current)
              ? "safety"
            : ["safety-dispute", "safety-dispute-success"].includes(current)
              ? "match-detail"
            : current === "moderation-case"
              ? "moderation-queue"
            : "home";
        navigate(fallback, { replace: true });
      }
    }

    window.addEventListener("popstate", () => {
      const view = viewFromLocation();
      store.setView(view);
      const currentState = store.getState();
      const top = view === "opponents"
        ? currentState.opponentListScrollY
        : view === "matches"
          ? currentState.matchListScrollY
          : view === "history"
            ? currentState.historyListScrollY
          : 0;
      window.requestAnimationFrame(() => window.scrollTo({ top, behavior: "auto" }));
    });

    return { navigate, back };
  }

  function boot() {
    const root = document.getElementById("radar-demo-app");
    if (!root || !window.RadarCore || !window.RadarApi || !window.RadarUI) return;

    const params = new URL(window.location.href).searchParams;
    document.documentElement.classList.toggle("capture-mode", params.get("capture") === "1");
    if (params.get("demo") !== "1") {
      root.innerHTML = '<main class="demo-locked"><span>MCF</span><h1>Demonstração local protegida</h1><p>Abra este checkpoint usando a chave local fornecida pela equipe.</p></main>';
      return;
    }
    const store = window.RadarCore.store;
    if (params.get("reset") === "1") store.reset();
    const initialView = viewFromLocation();
    store.setView(initialView);
    window.history.replaceState({ radarDemo: true, radarDemoDepth: 0, view: initialView }, "", window.location.href);

    const router = createRouter(store);
    const api = window.RadarApi.create({ demoMode: true });
    const ui = window.RadarUI.create(root, store, router);

    window.RadarDemo = Object.freeze({
      mode: "local-demo",
      networkEnabled: false,
      api,
      router,
      store,
      ui
    });
  }

  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", boot, { once: true });
  else boot();
})();
