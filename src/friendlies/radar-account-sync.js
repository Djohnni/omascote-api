"use strict";

function createRadarAccountSynchronizer({ repository, resolveIdentity, listAccounts }) {
  if (!repository || typeof repository.reconcileOwnedProfile !== "function") {
    throw new TypeError("Radar account synchronizer requires a repository");
  }
  if (typeof resolveIdentity !== "function" || typeof listAccounts !== "function") {
    throw new TypeError("Radar account synchronizer requires legacy account access");
  }

  async function syncAuthSubject(authSubject, { requestId = null } = {}) {
    const identity = await resolveIdentity({ whatsapp: String(authSubject || "") });
    return repository.reconcileOwnedProfile({ identity, requestId, allowAccountRebind: true });
  }

  async function backfill({ requestId = "radar-automatic-backfill" } = {}) {
    const entries = Object.entries(listAccounts() || {});
    const counts = {
      active_accounts: 0,
      created: 0,
      reconciled: 0,
      unchanged: 0,
      skipped: 0,
      failed: 0
    };
    for (const [authSubject, account] of entries) {
      if (account?.ativo !== true) {
        counts.skipped += 1;
        continue;
      }
      if (
        account?.suspenso === true || account?.radar_suspenso === true ||
        String(account?.status || "").toLowerCase() === "suspended"
      ) {
        counts.skipped += 1;
        continue;
      }
      counts.active_accounts += 1;
      try {
        const result = await syncAuthSubject(authSubject, { requestId });
        if (result.created) counts.created += 1;
        else if (result.changed) counts.reconciled += 1;
        else counts.unchanged += 1;
      } catch {
        counts.failed += 1;
      }
    }
    return Object.freeze({ ...counts });
  }

  return Object.freeze({ syncAuthSubject, backfill });
}

module.exports = { createRadarAccountSynchronizer };
