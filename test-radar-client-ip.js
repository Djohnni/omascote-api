"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");
const { clientIp, firstForwardedAddress, normalizeAddress } = require("./src/security/client-ip");
const fs = require("node:fs");
const path = require("node:path");

function request({ forwarded, remoteAddress = "10.0.0.8", expressIp = "10.0.0.8" } = {}) {
  const headers = forwarded === undefined ? {} : { "x-forwarded-for": forwarded };
  return {
    headers,
    ip: expressIp,
    socket: { remoteAddress },
    get(name) { return this.headers[String(name).toLowerCase()]; }
  };
}

const renderConfig = Object.freeze({ trustedProxyProvider: "render", trustedProxyHops: 1 });

test("Render client identity uses the edge-written first forwarded address", () => {
  assert.equal(clientIp(request({ forwarded: "203.0.113.9, 198.51.100.10" }), renderConfig), "203.0.113.9");
});

test("forged forwarded suffixes cannot change the Render rate-limit identity", () => {
  const real = "203.0.113.9";
  const attempts = [
    `${real}, 1.1.1.1`,
    `${real}, 8.8.8.8`,
    `${real}, 2001:4860:4860::8888`,
    `${real}, invalid, 192.0.2.1`
  ];
  assert.deepEqual(attempts.map(forwarded => clientIp(request({ forwarded }), renderConfig)), attempts.map(() => real));
});

test("invalid or oversized forwarded input falls back to the private socket address", () => {
  assert.equal(clientIp(request({ forwarded: "not-an-ip" }), renderConfig), "10.0.0.8");
  assert.equal(clientIp(request({ forwarded: "1".repeat(2_049) }), renderConfig), "10.0.0.8");
});

test("unproved providers never trust a raw forwarded header", () => {
  assert.equal(clientIp(request({ forwarded: "203.0.113.9", expressIp: "10.0.0.8" }), {
    trustedProxyProvider: null,
    trustedProxyHops: 0
  }), "10.0.0.8");
});

test("address parsing accepts valid IPv4 and IPv6 without accepting arbitrary text", () => {
  assert.equal(normalizeAddress("::ffff:192.0.2.44"), "192.0.2.44");
  assert.equal(normalizeAddress("FE80::1%eth0"), "fe80::1");
  assert.equal(normalizeAddress("203.0.113.4:1234"), null);
  assert.equal(firstForwardedAddress(request({ forwarded: '"2001:db8::1", 192.0.2.1' })), "2001:db8::1");
});

test("application logs never retain full forwarded chains or full client addresses", () => {
  const source = fs.readFileSync(path.join(__dirname, "server.js"), "utf8");
  assert.doesNotMatch(source, /x_forwarded_for\s*:/);
  assert.doesNotMatch(source, /\bip\s*:\s*getPreviewLimiterIp\(/);
});
