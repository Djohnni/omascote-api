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
    const ready = database.ok && verificationConfigured;
    return res.status(ready ? 200 : 503).json({
      ok: ready,
      ...metadata,
      radar_amistosos: "enabled",
      database: database.ok ? "ready" : database.reason,
      instagram_verification: verificationConfigured ? "configured" : "not_configured"
    });
  });

  return router;
}

module.exports = { createHealthRouter };
