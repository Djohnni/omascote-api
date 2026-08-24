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
    return res.status(database.ok ? 200 : 503).json({
      ok: database.ok,
      ...metadata,
      radar_amistosos: "enabled",
      database: database.ok ? "ready" : database.reason
    });
  });

  return router;
}

module.exports = { createHealthRouter };
