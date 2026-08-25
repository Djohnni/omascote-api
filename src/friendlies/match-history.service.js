"use strict";

const {
  historyError,
  validateOpponentPublicId,
  validateHistoryQuery,
  boundHistoryFilters
} = require("./match-history.schemas");
const {
  requireHistorySecrets,
  fingerprint,
  ownerScope,
  rateScopeHash,
  encodeHistoryCursor,
  decodeHistoryCursor
} = require("./match-history.crypto");

function validClock(clock) {
  const value = clock();
  if (!(value instanceof Date) || Number.isNaN(value.getTime())) {
    throw new TypeError("Match history clock must return a valid Date");
  }
  return value;
}

function createMatchHistoryService({ repository, config, clock = () => new Date() }) {
  if (!repository || typeof repository.read !== "function") {
    throw new TypeError("Match history service requires a repository");
  }

  function ensureAvailable() {
    if (config?.enabled !== true || config?.matchHistoryEnabled !== true) {
      throw historyError("MATCH_HISTORY_DISABLED", 404, "Recurso nao encontrado.");
    }
    return requireHistorySecrets(config);
  }

  async function read({ identity, query, opponentPublicId = null, requestContext = {} }) {
    const secrets = ensureAvailable();
    const now = validClock(clock);
    const filters = validateHistoryQuery(query, config, now);
    const opponentId = opponentPublicId ? validateOpponentPublicId(opponentPublicId) : null;
    const scope = opponentId ? `opponent:${opponentId}` : "all";
    const filterFingerprint = fingerprint(boundHistoryFilters(filters));
    let decoded = null;
    if (filters.cursor) {
      decoded = decodeHistoryCursor(secrets.cursor, filters.cursor);
      if (decoded.filtersFingerprint !== filterFingerprint || decoded.scope !== scope) {
        throw historyError(
          "MATCH_HISTORY_CURSOR_FILTER_MISMATCH",
          400,
          "O cursor pertence a outra consulta."
        );
      }
      const age = now.getTime() - decoded.issuedAt.getTime();
      if (age < -60_000 || age > config.matchHistoryCursorTtlMinutes * 60_000) {
        throw historyError("MATCH_HISTORY_CURSOR_EXPIRED", 400, "O cursor expirou.");
      }
    }

    const result = await repository.read({
      identity,
      filters,
      opponentPublicId: opponentId,
      afterKey: decoded?.key || null,
      now,
      rateScopes: team => [
        {
          type: "account",
          hash: rateScopeHash(secrets.rate, "account", identity.accountId),
          limit: config.matchHistoryAccountLimit
        },
        {
          type: "team",
          hash: rateScopeHash(secrets.rate, "team", team.id),
          limit: config.matchHistoryTeamLimit
        },
        {
          type: "ip",
          hash: rateScopeHash(secrets.rate, "ip", requestContext.ip || "unknown"),
          limit: config.matchHistoryIpLimit
        }
      ]
    });

    const expectedOwner = ownerScope(secrets.cursor, result.teamId);
    if (decoded && decoded.ownerScope !== expectedOwner) {
      throw historyError(
        "MATCH_HISTORY_CURSOR_OWNER_MISMATCH",
        400,
        "O cursor nao pertence a este time."
      );
    }
    const items = Object.freeze(result.rows.map(repository.rowToHistoryItem));
    const last = result.rows.at(-1);
    const nextCursor = result.hasMore && last
      ? encodeHistoryCursor(secrets.cursor, {
          f: filterFingerprint,
          o: expectedOwner,
          s: scope,
          i: now.toISOString(),
          k: {
            scheduled_at: new Date(last.scheduled_at).toISOString(),
            match_id: last.match_public_id
          }
        })
      : null;
    return Object.freeze({
      ...(result.opponent ? { opponent: result.opponent } : {}),
      summary: result.summary,
      items,
      page: Object.freeze({
        limit: filters.limit,
        has_more: result.hasMore,
        next_cursor: nextCursor
      })
    });
  }

  return Object.freeze({
    list: values => read(values),
    against: values => read({ ...values, opponentPublicId: values.opponentPublicId })
  });
}

module.exports = { createMatchHistoryService, validClock };
