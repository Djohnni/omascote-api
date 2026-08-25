"use strict";

const crypto = require("node:crypto");
const express = require("express");
const { AsyncLocalStorage } = require("node:async_hooks");

const REQUEST_ID = /^[A-Za-z0-9._:-]{8,120}$/;
const SAFE_FIELD_NAMES = new Set([
  "method", "path", "route", "status", "status_family", "duration_ms",
  "operation", "error", "code", "count", "result", "locked", "migration"
]);

function safeRequestId(value) {
  const candidate = String(value || "").trim();
  return REQUEST_ID.test(candidate) ? candidate : crypto.randomUUID();
}

function normalizeEventName(value) {
  const normalized = String(value || "radar.event")
    .toLowerCase()
    .replace(/[^a-z0-9_.-]+/g, "_")
    .slice(0, 100);
  return normalized || "radar.event";
}

function safeFields(fields) {
  if (!fields || typeof fields !== "object" || Array.isArray(fields)) return {};
  const result = {};
  for (const [key, value] of Object.entries(fields)) {
    if (!SAFE_FIELD_NAMES.has(key)) continue;
    if (["string", "number", "boolean"].includes(typeof value) || value === null) {
      result[key] = typeof value === "string" ? value.slice(0, 180) : value;
    }
  }
  return result;
}

function timingSafeToken(expected, provided) {
  const left = Buffer.from(String(expected || ""), "utf8");
  const right = Buffer.from(String(provided || ""), "utf8");
  return left.length > 0 && left.length === right.length && crypto.timingSafeEqual(left, right);
}

function classifyOperation(method, path) {
  const verb = String(method || "GET").toUpperCase();
  const route = String(path || "").split("?")[0];
  if (verb === "GET" && route === "/amistosos/times-proximos") return "search";
  if (verb === "POST" && /\/amistosos\/convites\/[^/]+\/aceitar$/.test(route)) return "acceptance";
  if (route === "/amistosos/convites" || route.startsWith("/amistosos/convites/")) return "invitation";
  if (route.startsWith("/me/time/amistosos/") && /\/resultado(?:\/confirmar)?$/.test(route)) return "score";
  if (route.includes("/denuncias") || route.endsWith("/contestacao")) return "report";
  if (route.startsWith("/admin/radar/moderacao")) return "moderation";
  if (route.startsWith("/me/time/amistosos")) return "match";
  if (route.startsWith("/me/time/radar") || route.startsWith("/me/time/verificacao")) return "radar";
  if (route.startsWith("/health/")) return "health";
  return null;
}

function metricLine(name, labels, value) {
  const parts = Object.entries(labels || {}).map(([key, item]) =>
    `${key}="${String(item).replace(/[\\"\n]/g, "_")}"`
  );
  return `${name}${parts.length ? `{${parts.join(",")}}` : ""} ${Number(value) || 0}`;
}

function createRadarObservability(options = {}) {
  const output = options.output || console;
  const service = String(options.service || "omascote-api");
  const storage = new AsyncLocalStorage();
  const counters = new Map();
  const durations = new Map();
  const database = { queries: 0, errors: 0, durationMs: 0, active: 0, maxActive: 0 };

  function increment(name, labels = {}, amount = 1) {
    const key = `${name}|${JSON.stringify(labels)}`;
    const current = counters.get(key) || { name, labels, value: 0 };
    current.value += amount;
    counters.set(key, current);
  }

  function recordDuration(operation, durationMs) {
    const value = Math.max(0, Number(durationMs) || 0);
    const current = durations.get(operation) || [];
    current.push(value);
    if (current.length > 10_000) current.splice(0, current.length - 10_000);
    durations.set(operation, current);
  }

  function write(level, event, fields) {
    const context = storage.getStore() || {};
    const payload = {
      timestamp: new Date().toISOString(),
      level,
      service,
      event: normalizeEventName(event),
      ...(context.requestId ? { request_id: context.requestId } : {}),
      ...safeFields(fields)
    };
    const method = level === "error" ? "error" : level === "warn" ? "warn" : "info";
    output[method]?.(JSON.stringify(payload));
  }

  const logger = Object.freeze({
    info: (event, fields) => write("info", event, fields),
    log: (event, fields) => write("info", event, fields),
    warn: (event, fields) => write("warn", event, fields),
    error: (event, fields) => write("error", event, fields)
  });

  function requestContext(req, res, next) {
    const requestId = safeRequestId(req.get("X-Request-Id"));
    req.requestId = requestId;
    res.set("X-Request-Id", requestId);
    return storage.run({ requestId }, next);
  }

  function httpMetrics(req, res, next) {
    const operation = classifyOperation(req.method, req.originalUrl || req.url);
    if (!operation) return next();
    const started = process.hrtime.bigint();
    res.once("finish", () => {
      const durationMs = Number(process.hrtime.bigint() - started) / 1_000_000;
      const statusFamily = `${Math.floor(res.statusCode / 100)}xx`;
      increment("radar_http_requests_total", { operation, status_family: statusFamily });
      recordDuration(operation, durationMs);
      if (res.statusCode >= 400) increment("radar_errors_total", { operation, status_family: statusFamily });
      if (res.statusCode >= 200 && res.statusCode < 300 && !["radar", "health"].includes(operation)) {
        increment(`radar_${operation}_events_total`);
      }
      logger.info("radar.http.completed", {
        method: req.method,
        route: String(req.route?.path || req.path || "").slice(0, 160),
        status: res.statusCode,
        status_family: statusFamily,
        operation,
        duration_ms: Number(durationMs.toFixed(2))
      });
    });
    return next();
  }

  function observeDatabaseQuery({ durationMs, error = false, activeDelta = 0 }) {
    if (activeDelta) {
      database.active = Math.max(0, database.active + activeDelta);
      database.maxActive = Math.max(database.maxActive, database.active);
      return;
    }
    database.queries += 1;
    database.durationMs += Math.max(0, Number(durationMs) || 0);
    if (error) database.errors += 1;
  }

  function snapshot() {
    const result = {
      counters: [...counters.values()].map(item => ({ ...item })),
      durations: {},
      database: { ...database }
    };
    for (const [operation, values] of durations.entries()) {
      const sorted = [...values].sort((a, b) => a - b);
      const percentile = value => sorted.length ? sorted[Math.min(sorted.length - 1, Math.ceil(sorted.length * value) - 1)] : 0;
      result.durations[operation] = {
        count: sorted.length,
        p50_ms: Number(percentile(0.5).toFixed(2)),
        p95_ms: Number(percentile(0.95).toFixed(2)),
        p99_ms: Number(percentile(0.99).toFixed(2)),
        max_ms: Number((sorted.at(-1) || 0).toFixed(2))
      };
    }
    return result;
  }

  function renderPrometheus() {
    const lines = [];
    for (const item of counters.values()) lines.push(metricLine(item.name, item.labels, item.value));
    for (const [operation, summary] of Object.entries(snapshot().durations)) {
      lines.push(metricLine("radar_http_duration_p50_ms", { operation }, summary.p50_ms));
      lines.push(metricLine("radar_http_duration_p95_ms", { operation }, summary.p95_ms));
      lines.push(metricLine("radar_http_duration_p99_ms", { operation }, summary.p99_ms));
    }
    lines.push(metricLine("radar_database_queries_total", {}, database.queries));
    lines.push(metricLine("radar_database_errors_total", {}, database.errors));
    lines.push(metricLine("radar_database_query_duration_ms_total", {}, Number(database.durationMs.toFixed(2))));
    lines.push(metricLine("radar_database_active_queries", {}, database.active));
    lines.push(metricLine("radar_database_max_active_queries", {}, database.maxActive));
    return `${lines.join("\n")}\n`;
  }

  function metricsRouter({ enabled, token }) {
    const router = express.Router();
    router.get("/internal/radar/metrics", (req, res) => {
      res.set("Cache-Control", "private, no-store");
      if (!enabled || !token) return res.status(404).json({ ok: false, error: "Recurso nao encontrado." });
      const provided = String(req.get("Authorization") || "").replace(/^Bearer\s+/i, "");
      if (!timingSafeToken(token, provided)) return res.status(401).json({ ok: false, error: "Nao autorizado." });
      res.type("text/plain; version=0.0.4").send(renderPrometheus());
    });
    return router;
  }

  return Object.freeze({
    logger, requestContext, httpMetrics, observeDatabaseQuery, metricsRouter,
    snapshot, renderPrometheus, classifyOperation
  });
}

module.exports = {
  createRadarObservability,
  classifyOperation,
  safeRequestId,
  timingSafeToken
};
