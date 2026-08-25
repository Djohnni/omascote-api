"use strict";

const { validateStagingEnvironment } = require("../src/config/staging-preflight");

const result = validateStagingEnvironment(process.env);
process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
if (!result.ok) process.exitCode = 1;
