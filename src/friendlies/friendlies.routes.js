"use strict";

const express = require("express");

function createFriendliesRouter({ config }) {
  const router = express.Router();

  router.use((req, res, next) => {
    if (config.enabled) return next();
    return res.status(404).json({ ok: false, error: "Recurso nao encontrado." });
  });

  router.get("/status", (req, res) => {
    res.set("Cache-Control", "private, no-store");
    return res.json({
      ok: true,
      feature: "radar_amistosos",
      pilot_free: config.pilotFree,
      public_rating_minimum_matches: config.publicRatingMinimumMatches
    });
  });

  return router;
}

module.exports = { createFriendliesRouter };
