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

const renderConfig = Object.freeze({ trustedProxyProvider: "render", trustedProxyHops: 3 });

test("Render client identity uses the proved third address from the right", () => {
  assert.equal(clientIp(request({ forwarded: "203.0.113.9, 198.51.100.10, 192.0.2.20" }), renderConfig), "203.0.113.9");
});

test("forged forwarded prefixes cannot change the Render rate-limit identity", () => {
  const real = "203.0.113.9";
  const trustedSuffix = `${real}, 198.51.100.10, 192.0.2.20`;
  const attempts = [
    trustedSuffix,
    `1.1.1.1, ${trustedSuffix}`,
    `8.8.8.8, 192.0.2.99, ${trustedSuffix}`,
    `invalid, 2001:4860:4860::8888, ${trustedSuffix}`,
    `${Array.from({ length: 20 }, (_, index) => `198.18.0.${index + 1}`).join(", ")}, ${trustedSuffix}`
  ];
  assert.deepEqual(attempts.map(forwarded => clientIp(request({ forwarded }), renderConfig)), attempts.map(() => real));
});

test("invalid or oversized forwarded input falls back to the private socket address", () => {
  assert.equal(clientIp(request({ forwarded: "not-an-ip, 198.51.100.10, 192.0.2.20" }), renderConfig), "10.0.0.8");
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
