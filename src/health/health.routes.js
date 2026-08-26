"use strict";

const express = require("express");

function createHealthRouter({ config, buildInfo, checkDatabase, getMigrationStatus }) {
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
    const migrations = database.ok && typeof getMigrationStatus === "function"
      ? await getMigrationStatus()
      : null;
    const verificationConfigured = config.instagramVerificationConfigured === true;
    const profilePrintConfigured = config.profilePrintImportEnabled !== true ||
      config.profilePrintOpenAiConfigured === true;
    const searchConfigured = config.searchEnabled !== true || config.searchConfigured === true;
    const invitationsConfigured = config.invitationsEnabled !== true || config.invitationsConfigured === true;
    const matchCenterConfigured = config.matchCenterEnabled !== true || config.matchCenterConfigured === true;
    const matchResultsConfigured = config.matchResultsEnabled !== true || config.matchResultsConfigured === true;
    const matchHistoryConfigured = config.matchHistoryEnabled !== true || config.matchHistoryConfigured === true;
    const reputationConfigured = config.reputationEnabled !== true || config.reputationConfigured === true;
    const moderationConfigured = config.moderationEnabled !== true || config.moderationConfigured === true;
    const communicationConfigured = config.matchCommunicationEnabled !== true || config.matchCommunicationConfigured === true;
    const metricsConfigured = config.metricsEnabled !== true || config.metricsConfigured === true;
    const ready = database.ok && metricsConfigured && profilePrintConfigured && searchConfigured && invitationsConfigured && matchCenterConfigured && matchResultsConfigured && matchHistoryConfigured && reputationConfigured && moderationConfigured && communicationConfigured;
    return res.status(ready ? 200 : 503).json({
      ok: ready,
      ...metadata,
      radar_amistosos: "enabled",
      database: database.ok ? "ready" : database.reason,
      radar_participation: "automatic",
      metrics: config.metricsEnabled !== true
        ? "disabled"
        : metricsConfigured
          ? "configured"
          : "not_configured",
      ...(migrations ? {
        migrations: {
          applied: migrations.count,
          latest: migrations.latest,
          required: migrations.required
        }
      } : {}),
      instagram_verification: verificationConfigured ? "optional_configured" : "optional_disabled",
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
          : "not_configured",
      friendly_match_center: config.matchCenterEnabled !== true
        ? "disabled"
        : matchCenterConfigured
          ? "configured"
          : "not_configured",
      friendly_match_results: config.matchResultsEnabled !== true
        ? "disabled"
        : matchResultsConfigured
          ? "configured"
          : "not_configured",
      friendly_match_history: config.matchHistoryEnabled !== true
        ? "disabled"
        : matchHistoryConfigured
          ? "configured"
          : "not_configured",
      friendly_reputation: config.reputationEnabled !== true
        ? "disabled"
        : reputationConfigured
          ? "configured"
          : "not_configured",
      radar_moderation: config.moderationEnabled !== true
        ? "disabled"
        : moderationConfigured
          ? "configured"
          : "not_configured",
      match_communication: config.matchCommunicationEnabled !== true
        ? "disabled"
        : communicationConfigured
          ? "configured"
          : "not_configured"
    });
  });

  return router;
}

module.exports = { createHealthRouter };
