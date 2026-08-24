"use strict";

const INVITATION_TRANSITIONS = Object.freeze({
  pending: new Set(["accepted", "declined", "cancelled", "expired", "counter_proposed"]),
  counter_proposed: new Set(["accepted", "declined", "cancelled", "expired", "counter_proposed"]),
  accepted: new Set(),
  declined: new Set(),
  cancelled: new Set(),
  expired: new Set()
});

const MATCH_TRANSITIONS = Object.freeze({
  scheduled: new Set(["awaiting_occurrence", "cancelled", "no_show", "disputed"]),
  awaiting_occurrence: new Set(["played", "cancelled", "no_show", "disputed"]),
  played: new Set(["disputed"]),
  cancelled: new Set(),
  no_show: new Set(["disputed"]),
  disputed: new Set(["played", "cancelled", "no_show"])
});

const RESULT_TRANSITIONS = Object.freeze({
  empty: new Set(["waiting_other", "disputed"]),
  waiting_other: new Set(["verified", "divergent", "disputed"]),
  divergent: new Set(["corrected", "disputed"]),
  corrected: new Set(["waiting_other", "verified", "divergent", "disputed"]),
  verified: new Set(),
  disputed: new Set(["corrected"])
});

function canTransition(machine, from, to) {
  return Boolean(machine[from]?.has(to));
}

function assertTransition(machine, from, to, entityName) {
  if (!canTransition(machine, from, to)) {
    const error = new Error(`Invalid ${entityName} transition: ${from} -> ${to}`);
    error.code = "INVALID_STATE_TRANSITION";
    throw error;
  }
}

module.exports = {
  INVITATION_TRANSITIONS,
  MATCH_TRANSITIONS,
  RESULT_TRANSITIONS,
  canTransition,
  assertInvitationTransition: (from, to) =>
    assertTransition(INVITATION_TRANSITIONS, from, to, "invitation"),
  assertMatchTransition: (from, to) =>
    assertTransition(MATCH_TRANSITIONS, from, to, "match"),
  assertResultTransition: (from, to) =>
    assertTransition(RESULT_TRANSITIONS, from, to, "result")
};
