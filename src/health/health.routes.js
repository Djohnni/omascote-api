"use strict";

const express = require("express");

function createHealthRouter({ config, buildInfo, checkDatabase }) {
  const router = express.Router();
  const metadata = {
    service: "omascote-api",
    commit: buildInfo.commit,
    build: buildInfo.build
  };

  router.get("/health/live", (req, res) => {
    res.set("Cache-Control", "no-store");
    return res.json({ ok: true, ...metadata });
  });

  router.get("/health/ready", async (req, res) => {
    res.set("Cache-Control", "no-store");

    if (!config.enabled) {
      return res.json({
        ok: true,
        ...metadata,
        radar_amistosos: "disabled",
        database: "not_required"
      });
    }

    const database = await checkDatabase();
    const verificationConfigured = config.instagramVerificationConfigured === true;
    const profilePrintConfigured = config.profilePrintImportEnabled !== true ||
      config.profilePrintOpenAiConfigured === true;
    const searchConfigured = config.searchEnabled !== true || config.searchConfigured === true;
    const invitationsConfigured = config.invitationsEnabled !== true || config.invitationsConfigured === true;
    const ready = database.ok && verificationConfigured && profilePrintConfigured && searchConfigured && invitationsConfigured;
    return res.status(ready ? 200 : 503).json({
      ok: ready,
      ...metadata,
      radar_amistosos: "enabled",
      database: database.ok ? "ready" : database.reason,
      instagram_verification: verificationConfigured ? "configured" : "not_configured",
      profile_print_import: config.profilePrintImportEnabled !== true
        ? "disabled"
        : profilePrintConfigured
          ? "configured"
          : "not_configured",
      friendly_search: config.searchEnabled !== true
        ? "disabled"
        : searchConfigured
          ? "configured"
          : "not_configured",
      friendly_invitations: config.invitationsEnabled !== true
        ? "disabled"
        : invitationsConfigured
          ? "configured"
          : "not_configured"
    });
  });

  return router;
}

module.exports = { createHealthRouter };
