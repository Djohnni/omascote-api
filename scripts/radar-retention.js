"use strict";

const { createRadarConfig } = require("../src/config/radar");
const { createPool } = require("../src/db/pool");
const { createRadarObservability } = require("../src/observability/radar-observability");
const { runRadarRetention } = require("../src/maintenance/radar-retention");

async function main() {
  const config = createRadarConfig();
  const observability = createRadarObservability({ service: "omascote-api-retention" });
  const pool = createPool(config, { observer: observability });
  if (!pool) throw new Error("DATABASE_URL is required for Radar retention");
  try {
    const result = await runRadarRetention({ pool, config, logger: observability.logger });
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  } finally {
    await pool.end();
  }
}

main().catch(error => {
  process.stderr.write(`Radar retention failed: ${error.message}\n`);
  process.exitCode = 1;
});
