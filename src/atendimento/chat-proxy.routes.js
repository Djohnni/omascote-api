"use strict";

const express = require("express");

const DEFAULT_UPSTREAM = "https://omascote-atendimento-teste.djohnni1.chatgpt.site";
const SESSION_RE = /^[a-f0-9-]{36}$/;
const ALLOWED_ROUTES = new Set([
  "assistant",
  "files",
  "lab",
  "read-print",
  "share"
]);
const AI_ROUTES = new Set(["assistant", "read-print"]);
const MAX_BODY_BYTES = 13 * 1024 * 1024;
const AI_WINDOW_MS = 60 * 60 * 1000;
const AI_REQUESTS_PER_SESSION = 30;
const AI_REQUESTS_PER_IP = 120;

function requestSession(req) {
  const session = String(req.query?.session || "").trim().toLowerCase();
  return SESSION_RE.test(session) ? session : null;
}

function requestIp(req) {
  return String(req.ip || req.socket?.remoteAddress || "unknown").slice(0, 120);
}

function createAtendimentoProxyRouter(options = {}) {
  const router = express.Router();
  const upstream = String(options.upstreamUrl || process.env.OMASCOTE_ATENDIMENTO_BACKEND || DEFAULT_UPSTREAM).replace(/\/+$/, "");
  const fetchImpl = options.fetchImpl || fetch;
  const now = options.now || (() => Date.now());
  const aiUsage = new Map();

  function allowBucket(key, limit) {
    const timestamp = now();
    const current = aiUsage.get(key);
    if (!current || timestamp - current.startedAt >= AI_WINDOW_MS) {
      aiUsage.set(key, { startedAt: timestamp, count: 1 });
      return true;
    }
    if (current.count >= limit) return false;
    current.count += 1;
    return true;
  }

  function allowAiRequest(req, route) {
    if (!AI_ROUTES.has(route)) return true;
    if (aiUsage.size > 5_000) {
      const timestamp = now();
      for (const [key, value] of aiUsage) if (timestamp - value.startedAt >= AI_WINDOW_MS) aiUsage.delete(key);
    }
    return allowBucket(`session:${requestSession(req)}`, AI_REQUESTS_PER_SESSION)
      && allowBucket(`ip:${requestIp(req)}`, AI_REQUESTS_PER_IP);
  }

  router.all("/:route", async (req, res) => {
    const route = String(req.params.route || "").toLowerCase();
    if (!ALLOWED_ROUTES.has(route)) return res.status(404).json({ ok: false, error: "Recurso não encontrado." });
    if (!["GET", "POST"].includes(req.method)) return res.status(405).json({ ok: false, error: "Método não permitido." });

    const session = requestSession(req);
    if (!session) return res.status(400).json({ ok: false, error: "Atualize a página para iniciar o atendimento." });
    if (!allowAiRequest(req, route)) return res.status(429).json({ ok: false, error: "Limite do atendimento atingido. Aguarde para continuar." });

    const declaredLength = Number(req.headers["content-length"] || 0);
    if (Number.isFinite(declaredLength) && declaredLength > MAX_BODY_BYTES) {
      return res.status(413).json({ ok: false, error: "Envio muito grande." });
    }

    const target = new URL(`/api/${route}`, upstream);
    for (const [key, value] of Object.entries(req.query || {})) {
      if (key === "session" || Array.isArray(value)) continue;
      target.searchParams.set(key, String(value));
    }

    const headers = {
      Accept: String(req.headers.accept || "application/json"),
      Cookie: `omascote_lab=${session}`,
      "User-Agent": "O-Mascote-Atendimento/1.0"
    };
    const contentType = String(req.headers["content-type"] || "");
    if (contentType) headers["Content-Type"] = contentType;

    const init = { method: req.method, headers, redirect: "manual" };
    if (req.method === "POST") {
      if (contentType.startsWith("multipart/form-data")) {
        init.body = req;
        init.duplex = "half";
      } else {
        init.body = JSON.stringify(req.body || {});
        headers["Content-Type"] = "application/json";
      }
    }

    let upstreamResponse;
    try {
      upstreamResponse = await fetchImpl(target, init);
    } catch {
      return res.status(502).json({ ok: false, error: "O atendimento está temporariamente indisponível." });
    }

    res.status(upstreamResponse.status);
    res.set("Cache-Control", "no-store");
    res.set("X-Content-Type-Options", "nosniff");
    const responseType = upstreamResponse.headers.get("content-type");
    if (responseType) res.set("Content-Type", responseType);
    return res.send(Buffer.from(await upstreamResponse.arrayBuffer()));
  });

  return router;
}

module.exports = {
  ALLOWED_ROUTES,
  createAtendimentoProxyRouter,
  requestSession
};
