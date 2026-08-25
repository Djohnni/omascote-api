"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");

const root = path.resolve(__dirname, "..");
const app = fs.readFileSync(path.join(root, "app.html"), "utf8");
const live = fs.readFileSync(path.join(__dirname, "radar-live.js"), "utf8");
const demo = fs.readFileSync(path.join(__dirname, "demo.html"), "utf8");
const preview = fs.readFileSync(path.join(__dirname, "local-preview-server.js"), "utf8");

test("production entry stays hidden until the authenticated eligibility probe succeeds", () => {
  assert.match(app, /meta name="omascote-api-base" content="https:\/\/api\.omascote\.com\.br"/);
  assert.match(app, /data-radar-live-entry[^>]*hidden/);
  assert.match(live, /api\.getEligibility\(\)/);
  assert.match(live, /item\.dataset\.radarAllowed = "true"/);
  assert.doesNotMatch(live, /URLSearchParams|location\.search|[?&]demo=/);
});

test("real mode uses the API as its Radar data source", () => {
  assert.match(live, /demoMode: false/);
  assert.match(live, /api\.listNearbyTeams/);
  assert.match(live, /api\.createInvitation/);
  assert.match(live, /api\.confirmMatchOccurrence/);
  assert.match(live, /api\.submitMatchResult/);
  assert.match(live, /api\.submitMatchEvaluation/);
  assert.match(live, /api\.resolveModerationCase/);
  assert.doesNotMatch(live, /localStorage\.setItem|localStorage\.removeItem/);
});

test("modal supports keyboard containment, escape and focus restoration", () => {
  assert.match(live, /role="dialog" aria-modal="true" aria-labelledby="radarLiveTitle"/);
  assert.match(live, /aria-live="polite"/);
  assert.match(live, /event\.key === "Escape"/);
  assert.match(live, /event\.key === "Tab"/);
  assert.match(live, /returnFocus = item/);
  assert.match(live, /target\?\.focus/);
  assert.match(live, /isolateBackgroundDialogs/);
  assert.match(live, /item\.element\.inert = true/);
});

test("demonstrator and local origin substitution remain explicitly isolated", () => {
  assert.match(demo, /demo=1|Demonstra[cç][aã]o local/i);
  assert.match(demo, /connect-src\s+'none'/i);
  assert.match(preview, /OMASCOTE_LOCAL_API_BASE/);
  assert.match(preview, /local-real/);
  assert.doesNotMatch(app, /127\.0\.0\.1|localhost/);
});
