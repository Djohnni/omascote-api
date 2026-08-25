ALTER TABLE radar_team_profiles
  ADD COLUMN IF NOT EXISTS radar_departed_at timestamptz;

ALTER TABLE radar_account_roles
  DROP CONSTRAINT IF EXISTS radar_account_roles_role_check;

ALTER TABLE radar_account_roles
  ADD CONSTRAINT radar_account_roles_role_check
    CHECK (role IN ('verification_reviewer', 'radar_moderator', 'radar_admin')) NOT VALID;

CREATE TABLE radar_moderation_cases (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  public_id uuid NOT NULL DEFAULT gen_random_uuid() UNIQUE,
  case_type text NOT NULL
    CHECK (case_type IN ('team_report', 'match_report', 'result_dispute')),
  reporter_team_id uuid REFERENCES radar_team_profiles(id) ON DELETE SET NULL,
  reported_team_id uuid NOT NULL REFERENCES radar_team_profiles(id),
  match_id uuid REFERENCES friendly_matches(id) ON DELETE SET NULL,
  category text NOT NULL CHECK (category IN (
    'unsafe_conduct', 'harassment', 'identity_fraud', 'spam',
    'inappropriate_content', 'score_incorrect', 'other'
  )),
  private_description text
    CHECK (private_description IS NULL OR char_length(private_description) BETWEEN 1 AND 500),
  status text NOT NULL DEFAULT 'open'
    CHECK (status IN ('open', 'assigned', 'resolved', 'dismissed')),
  assigned_to_account_reference text,
  resolution_action text CHECK (resolution_action IS NULL OR resolution_action IN (
    'dismiss', 'warn', 'invalidate_review', 'invalidate_result', 'suspend_team'
  )),
  resolution_reason text CHECK (resolution_reason IS NULL OR resolution_reason IN (
    'no_violation', 'insufficient_evidence', 'violation_confirmed',
    'invalid_review', 'invalid_result'
  )),
  version integer NOT NULL DEFAULT 1 CHECK (version > 0),
  moderation_due_at timestamptz,
  retention_expires_at timestamptz NOT NULL,
  description_erased_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  resolved_at timestamptz,
  CHECK (reporter_team_id IS NULL OR reporter_team_id <> reported_team_id),
  CHECK (
    (case_type = 'team_report' AND match_id IS NULL)
    OR (case_type IN ('match_report', 'result_dispute') AND match_id IS NOT NULL)
  ),
  CHECK (
    (status IN ('open', 'assigned') AND resolved_at IS NULL AND resolution_action IS NULL)
    OR (status IN ('resolved', 'dismissed') AND resolved_at IS NOT NULL AND resolution_action IS NOT NULL)
  )
);

CREATE INDEX radar_moderation_cases_queue_idx
  ON radar_moderation_cases (status, moderation_due_at, created_at, public_id);

CREATE INDEX radar_moderation_cases_reporter_idx
  ON radar_moderation_cases (reporter_team_id, created_at DESC, public_id DESC);

CREATE INDEX radar_moderation_cases_retention_idx
  ON radar_moderation_cases (retention_expires_at)
  WHERE description_erased_at IS NULL AND private_description IS NOT NULL;

CREATE UNIQUE INDEX radar_moderation_open_dispute_idx
  ON radar_moderation_cases (reporter_team_id, match_id)
  WHERE case_type = 'result_dispute' AND status IN ('open', 'assigned');

CREATE TABLE radar_moderation_case_events (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  case_id uuid NOT NULL REFERENCES radar_moderation_cases(id),
  actor_team_id uuid REFERENCES radar_team_profiles(id) ON DELETE SET NULL,
  actor_account_reference text,
  event_type text NOT NULL CHECK (event_type IN (
    'created', 'assigned', 'resolved', 'dismissed', 'description_erased'
  )),
  case_version integer NOT NULL CHECK (case_version > 0),
  safe_payload jsonb NOT NULL DEFAULT '{}' CHECK (jsonb_typeof(safe_payload) = 'object'),
  request_id text,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX radar_moderation_case_events_case_idx
  ON radar_moderation_case_events (case_id, created_at, id);

CREATE TABLE radar_moderation_mutation_requests (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  account_reference text NOT NULL CHECK (btrim(account_reference) <> ''),
  operation text NOT NULL CHECK (operation IN (
    'block', 'unblock', 'report', 'dispute', 'radar_exit',
    'assign_case', 'resolve_case'
  )),
  idempotency_key varchar(200) NOT NULL,
  payload_hash char(64) NOT NULL CHECK (payload_hash ~ '^[0-9a-f]{64}$'),
  radar_team_id uuid REFERENCES radar_team_profiles(id),
  case_id uuid REFERENCES radar_moderation_cases(id),
  result_snapshot jsonb NOT NULL CHECK (jsonb_typeof(result_snapshot) = 'object'),
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (account_reference, operation, idempotency_key)
);

CREATE TABLE radar_moderation_rate_limits (
  operation text NOT NULL CHECK (btrim(operation) <> ''),
  scope_type text NOT NULL CHECK (scope_type IN ('account', 'team', 'ip')),
  scope_hash char(64) NOT NULL CHECK (scope_hash ~ '^[0-9a-f]{64}$'),
  window_started_at timestamptz NOT NULL,
  request_count integer NOT NULL DEFAULT 1 CHECK (request_count > 0),
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (operation, scope_type, scope_hash, window_started_at)
);

CREATE INDEX radar_moderation_rate_limits_cleanup_idx
  ON radar_moderation_rate_limits (window_started_at);

CREATE TABLE radar_review_moderation_compensations (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  case_id uuid NOT NULL REFERENCES radar_moderation_cases(id),
  review_id uuid NOT NULL UNIQUE REFERENCES team_reviews(id),
  reviewed_team_id uuid NOT NULL REFERENCES radar_team_profiles(id),
  punctuality smallint NOT NULL CHECK (punctuality BETWEEN 1 AND 5),
  organization smallint NOT NULL CHECK (organization BETWEEN 1 AND 5),
  communication smallint NOT NULL CHECK (communication BETWEEN 1 AND 5),
  fair_play smallint NOT NULL CHECK (fair_play BETWEEN 1 AND 5),
  would_play_again boolean NOT NULL,
  applied_by_account_reference text NOT NULL,
  applied_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE radar_match_statistic_compensations (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  case_id uuid NOT NULL UNIQUE REFERENCES radar_moderation_cases(id),
  match_id uuid NOT NULL UNIQUE REFERENCES friendly_matches(id),
  team_a_id uuid NOT NULL REFERENCES radar_team_profiles(id),
  team_b_id uuid NOT NULL REFERENCES radar_team_profiles(id),
  team_a_goals smallint NOT NULL CHECK (team_a_goals BETWEEN 0 AND 99),
  team_b_goals smallint NOT NULL CHECK (team_b_goals BETWEEN 0 AND 99),
  applied_by_account_reference text NOT NULL,
  applied_at timestamptz NOT NULL DEFAULT now(),
  CHECK (team_a_id <> team_b_id)
);

CREATE TABLE radar_departure_records (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  public_id uuid NOT NULL DEFAULT gen_random_uuid() UNIQUE,
  team_id uuid NOT NULL UNIQUE REFERENCES radar_team_profiles(id),
  account_pseudonym char(64) NOT NULL CHECK (account_pseudonym ~ '^[0-9a-f]{64}$'),
  invitation_count integer NOT NULL DEFAULT 0 CHECK (invitation_count >= 0),
  availability_count integer NOT NULL DEFAULT 0 CHECK (availability_count >= 0),
  requested_at timestamptz NOT NULL DEFAULT now()
);

CREATE FUNCTION radar_reject_moderation_ledger_change()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  RAISE EXCEPTION 'radar moderation ledgers are append-only';
END;
$$;

CREATE TRIGGER radar_moderation_case_events_append_only
BEFORE UPDATE OR DELETE ON radar_moderation_case_events
FOR EACH ROW EXECUTE FUNCTION radar_reject_moderation_ledger_change();

CREATE TRIGGER radar_moderation_mutation_requests_append_only
BEFORE UPDATE OR DELETE ON radar_moderation_mutation_requests
FOR EACH ROW EXECUTE FUNCTION radar_reject_moderation_ledger_change();

CREATE TRIGGER radar_review_moderation_compensations_append_only
BEFORE UPDATE OR DELETE ON radar_review_moderation_compensations
FOR EACH ROW EXECUTE FUNCTION radar_reject_moderation_ledger_change();

CREATE TRIGGER radar_match_statistic_compensations_append_only
BEFORE UPDATE OR DELETE ON radar_match_statistic_compensations
FOR EACH ROW EXECUTE FUNCTION radar_reject_moderation_ledger_change();

CREATE TRIGGER radar_departure_records_append_only
BEFORE UPDATE OR DELETE ON radar_departure_records
FOR EACH ROW EXECUTE FUNCTION radar_reject_moderation_ledger_change();
