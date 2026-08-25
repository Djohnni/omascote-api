"use strict";

const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const express = require("express");
const {
  EXPECTED_SOURCE_COMMIT,
  createRadarStagingFrontendRouter,
  isStagingFrontendEnabled,
  readVerifiedManifest
} = require("./src/staging/radar-staging-frontend");

const snapshotRoot = path.join(__dirname, "staging-frontend", "snapshot");
const manifestPath = path.join(__dirname, "staging-frontend", "source-manifest.json");
const enabledEnvironment = Object.freeze({
  NODE_ENV: "staging",
  RENDER: "true",
  RENDER_SERVICE_ID: "srv-staging-test",
  RADAR_STAGING_SERVICE_ID: "srv-staging-test",
  RADAR_STAGING_FRONTEND_ENABLED: "true"
});

async function request(app, route) {
  const server = app.listen(0, "127.0.0.1");
  await new Promise(resolve => server.once("listening", resolve));
  try {
    const response = await fetch(`http://127.0.0.1:${server.address().port}${route}`);
    const body = Buffer.from(await response.arrayBuffer());
    return Object.freeze({ status: response.status, headers: response.headers, body });
  } finally {
    await new Promise(resolve => server.close(resolve));
  }
}

function appWithSnapshot() {
  const app = express();
  app.use("/radar-staging", createRadarStagingFrontendRouter({
    env: enabledEnvironment,
    snapshotRoot,
    manifestPath
  }));
  return app;
}

test("staging frontend fails closed outside the exact Render staging service", () => {
  assert.equal(isStagingFrontendEnabled({ ...enabledEnvironment, NODE_ENV: "production" }), false);
  assert.equal(isStagingFrontendEnabled({ ...enabledEnvironment, RADAR_STAGING_FRONTEND_ENABLED: "false" }), false);
  assert.equal(isStagingFrontendEnabled({ ...enabledEnvironment, RENDER_SERVICE_ID: "srv-production" }), false);
  assert.equal(createRadarStagingFrontendRouter({ env: { NODE_ENV: "production" } }), null);
});

test("packaged frontend matches commit 89e45c6 and every declared SHA-256", () => {
  const manifest = readVerifiedManifest({ snapshotRoot, manifestPath });
  assert.equal(manifest.source_commit, EXPECTED_SOURCE_COMMIT);
  assert.equal(manifest.file_count, 121);
  assert.equal(manifest.total_bytes, 8_839_954);
  assert.equal(manifest.tree_sha256, "6bcf69499fede8eb3d9efa02bd2cbe61cdc0162ffe2cfd0b836ea4dda4c67571");
});

test("staging app serves exact bytes with no-store, CSP and no-index headers", async () => {
  const response = await request(appWithSnapshot(), "/radar-staging/app.html");
  assert.equal(response.status, 200);
  assert.equal(crypto.createHash("sha256").update(response.body).digest("hex"), "893fe44cd7f951249583023926869d9fc62383a783e639d4c44deb5aaa82ad81");
  assert.match(response.headers.get("cache-control"), /no-store/);
  assert.match(response.headers.get("content-security-policy"), /frame-ancestors 'none'/);
  assert.match(response.headers.get("x-robots-tag"), /noindex.*noarchive/);
  assert.equal(response.headers.get("x-content-type-options"), "nosniff");
});

test("source manifest is public proof only and contains no credential material", async () => {
  const response = await request(appWithSnapshot(), "/radar-staging/source-manifest.json");
  const body = response.body.toString("utf8");
  const parsed = JSON.parse(body);
  assert.equal(response.status, 200);
  assert.equal(parsed.source_commit, EXPECTED_SOURCE_COMMIT);
  assert.doesNotMatch(body, /(?:password|authorization|bearer|database_url|jwt_secret)/i);
  assert.equal(parsed.files.find(file => file.path === "app.html").sha256, "893fe44cd7f951249583023926869d9fc62383a783e639d4c44deb5aaa82ad81");
});

test("unknown and traversal-style staging paths disclose no files", async () => {
  assert.equal((await request(appWithSnapshot(), "/radar-staging/not-present.txt")).status, 404);
  assert.equal((await request(appWithSnapshot(), "/radar-staging/%2e%2e/package.json")).status, 404);
  assert.equal(fs.existsSync(path.join(snapshotRoot, ".env")), false);
});
