"use strict";

const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");
const express = require("express");
const { clientIp, firstForwardedAddress, normalizeAddress } = require("../security/client-ip");

const EXPECTED_SOURCE_COMMIT = "89e45c6bc9ba2a9643c690ffffabd3c2449b7f3f";
const CONTENT_SECURITY_POLICY = [
  "default-src 'self'",
  "base-uri 'self'",
  "object-src 'none'",
  "frame-ancestors 'none'",
  "form-action 'self'",
  "script-src 'self' 'unsafe-inline' https://accounts.google.com https://www.googletagmanager.com",
  "style-src 'self' 'unsafe-inline' https://accounts.google.com",
  "img-src 'self' data: blob: https:",
  "font-src 'self' data:",
  "connect-src 'self' https://accounts.google.com https://analytics.google.com https://www.google-analytics.com",
  "frame-src https://accounts.google.com",
  "worker-src 'self' blob:",
  "manifest-src 'self'",
  "media-src 'self' blob:"
].join("; ");

function truthy(value) {
  return ["1", "true", "on", "yes"].includes(String(value || "").trim().toLowerCase());
}

function isStagingFrontendEnabled(env = process.env) {
  const serviceId = String(env.RENDER_SERVICE_ID || "").trim();
  const allowedServiceId = String(env.RADAR_STAGING_SERVICE_ID || "").trim();
  return String(env.NODE_ENV || "").trim().toLowerCase() === "staging" &&
    truthy(env.RENDER) &&
    truthy(env.RADAR_STAGING_FRONTEND_ENABLED) &&
    serviceId.length > 0 &&
    serviceId === allowedServiceId;
}

function sha256(content) {
  return crypto.createHash("sha256").update(content).digest("hex");
}

function readVerifiedManifest({ snapshotRoot, manifestPath }) {
  const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
  if (manifest.source_commit !== EXPECTED_SOURCE_COMMIT) {
    throw new Error("Unexpected staging frontend source commit");
  }
  if (!Array.isArray(manifest.files) || manifest.files.length !== manifest.file_count) {
    throw new Error("Invalid staging frontend source manifest");
  }

  let totalBytes = 0;
  const treePayload = [];
  for (const file of manifest.files) {
    if (
      !file || typeof file.path !== "string" || file.path.length === 0 ||
      file.path.length > 512 || file.path.includes("\\") || file.path.includes("\0") ||
      file.path.startsWith("/") || file.path.split("/").some(segment => !segment || segment === "." || segment === "..")
    ) {
      throw new Error("Unsafe path in staging frontend source manifest");
    }
    const absolute = path.resolve(snapshotRoot, ...file.path.split("/"));
    const relative = path.relative(snapshotRoot, absolute);
    if (relative.startsWith("..") || path.isAbsolute(relative)) {
      throw new Error("Staging frontend file escapes snapshot root");
    }
    const stat = fs.lstatSync(absolute);
    if (!stat.isFile() || stat.isSymbolicLink()) throw new Error("Invalid staging frontend file type");
    const content = fs.readFileSync(absolute);
    const exactMatch = content.length === file.bytes && sha256(content) === file.sha256;
    const canonicalContent = !exactMatch && process.platform === "win32" && content.includes(13)
      ? Buffer.from(content.toString("utf8").replace(/\r\n/g, "\n"), "utf8")
      : content;
    if (canonicalContent.length !== file.bytes || sha256(canonicalContent) !== file.sha256) {
      throw new Error(`Staging frontend integrity mismatch: ${file.path}`);
    }
    totalBytes += canonicalContent.length;
    treePayload.push(`${file.sha256}  ${file.path}\n`);
  }
  if (totalBytes !== manifest.total_bytes || sha256(Buffer.from(treePayload.join(""), "utf8")) !== manifest.tree_sha256) {
    throw new Error("Staging frontend tree integrity mismatch");
  }
  return Object.freeze(manifest);
}

function setSecurityHeaders(res) {
  res.set({
    "Cache-Control": "private, no-store, max-age=0",
    Pragma: "no-cache",
    "Content-Security-Policy": CONTENT_SECURITY_POLICY,
    "X-Robots-Tag": "noindex, nofollow, noarchive, nosnippet",
    "X-Content-Type-Options": "nosniff",
    "Referrer-Policy": "no-referrer",
    "Permissions-Policy": "camera=(), microphone=(), geolocation=(), payment=(), usb=()",
    "Cross-Origin-Opener-Policy": "same-origin",
    "Cross-Origin-Resource-Policy": "same-origin"
  });
}

function createRadarStagingFrontendRouter(options = {}) {
  const env = options.env || process.env;
  if (!isStagingFrontendEnabled(env)) return null;

  const snapshotRoot = path.resolve(options.snapshotRoot || path.join(__dirname, "..", "..", "staging-frontend", "snapshot"));
  const manifestPath = path.resolve(options.manifestPath || path.join(snapshotRoot, "..", "source-manifest.json"));
  const manifest = readVerifiedManifest({ snapshotRoot, manifestPath });
  const router = express.Router();
  const proxyProbeStartedAt = Date.now();
  const proxyProbeSalt = crypto.randomBytes(32);

  router.use((req, res, next) => {
    setSecurityHeaders(res);
    next();
  });
  router.get("/source-manifest.json", (req, res) => res.json(manifest));
  if (truthy(env.RADAR_PROXY_PROBE_ENABLED)) {
    router.get("/_temporary-proxy-proof", (req, res) => {
      if (Date.now() - proxyProbeStartedAt > 10 * 60 * 1000) {
        return res.status(404).type("text/plain").send("Not found");
      }
      const forwarded = String(req.get("X-Forwarded-For") || "")
        .split(",").map(value => value.trim()).filter(Boolean).slice(0, 16);
      const fingerprint = value => value
        ? crypto.createHmac("sha256", proxyProbeSalt).update(value).digest("hex").slice(0, 20)
        : null;
      const socketAddress = normalizeAddress(req.socket?.remoteAddress);
      const firstAddress = firstForwardedAddress(req);
      const resolvedAddress = clientIp(req, {
        trustedProxyProvider: "render",
        trustedProxyHops: 1
      });
      return res.json({
        edge_hops: 1,
        forwarded_entries: forwarded.length,
        forwarded_hashes: forwarded.map(value => fingerprint(normalizeAddress(value) || "invalid")),
        forwarded_first_hash: fingerprint(firstAddress),
        socket_hash: fingerprint(socketAddress),
        resolved_hash: fingerprint(resolvedAddress),
        resolved_from_forwarded_first: firstAddress === resolvedAddress,
        socket_differs_from_client: Boolean(socketAddress && resolvedAddress && socketAddress !== resolvedAddress)
      });
    });
  }
  router.use(express.static(snapshotRoot, {
    dotfiles: "deny",
    fallthrough: true,
    index: false,
    etag: true,
    lastModified: false,
    maxAge: 0,
    setHeaders: setSecurityHeaders
  }));
  router.use((req, res) => res.status(404).type("text/plain").send("Not found"));
  return router;
}

module.exports = {
  CONTENT_SECURITY_POLICY,
  EXPECTED_SOURCE_COMMIT,
  createRadarStagingFrontendRouter,
  isStagingFrontendEnabled,
  readVerifiedManifest,
  setSecurityHeaders
};
