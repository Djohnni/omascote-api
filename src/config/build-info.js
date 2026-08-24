"use strict";

function firstNonEmpty(env, names) {
  for (const name of names) {
    const value = String(env[name] || "").trim();
    if (value) return value;
  }
  return null;
}

function getBuildInfo(env = process.env) {
  return Object.freeze({
    commit: firstNonEmpty(env, [
      "RENDER_GIT_COMMIT",
      "GIT_COMMIT",
      "COMMIT_SHA",
      "SOURCE_VERSION"
    ]),
    build: firstNonEmpty(env, ["BUILD_ID", "RENDER_SERVICE_ID", "RELEASE_VERSION"])
  });
}

module.exports = { getBuildInfo };
