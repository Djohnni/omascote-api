"use strict";

class RadarIdentityError extends Error {
  constructor(code, status, message, details = null) {
    super(message);
    this.name = "RadarIdentityError";
    this.code = code;
    this.status = status;
    this.details = details;
  }
}

function isRadarIdentityError(error) {
  return error instanceof RadarIdentityError;
}

module.exports = { RadarIdentityError, isRadarIdentityError };
