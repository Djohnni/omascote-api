ALTER TABLE friendly_matches
  ADD CONSTRAINT friendly_matches_verified_result_time_coherent CHECK (
    (result_state = 'verified' AND verified_result_at IS NOT NULL)
    OR (result_state <> 'verified' AND verified_result_at IS NULL)
  ) NOT VALID;

CREATE TABLE radar_team_verified_statistics (
  team_id uuid PRIMARY KEY REFERENCES radar_team_profiles(id),
  matches_played integer NOT NULL DEFAULT 0 CHECK (matches_played >= 0),
  wins integer NOT NULL DEFAULT 0 CHECK (wins >= 0),
  draws integer NOT NULL DEFAULT 0 CHECK (draws >= 0),
  losses integer NOT NULL DEFAULT 0 CHECK (losses >= 0),
  goals_for integer NOT NULL DEFAULT 0 CHECK (goals_for >= 0),
  goals_against integer NOT NULL DEFAULT 0 CHECK (goals_against >= 0),
  version integer NOT NULL DEFAULT 1 CHECK (version > 0),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CHECK (matches_played = wins + draws + losses)
);

CREATE TABLE radar_match_statistic_applications (
  match_id uuid PRIMARY KEY REFERENCES friendly_matches(id),
  team_a_id uuid NOT NULL REFERENCES radar_team_profiles(id),
  team_b_id uuid NOT NULL REFERENCES radar_team_profiles(id),
  team_a_goals smallint NOT NULL CHECK (team_a_goals BETWEEN 0 AND 99),
  team_b_goals smallint NOT NULL CHECK (team_b_goals BETWEEN 0 AND 99),
  result_hash char(64) NOT NULL CHECK (result_hash ~ '^[0-9a-f]{64}$'),
  applied_at timestamptz NOT NULL DEFAULT now(),
  CHECK (team_a_id <> team_b_id)
);

CREATE TABLE radar_match_result_mutation_requests (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  account_reference text NOT NULL CHECK (btrim(account_reference) <> ''),
  operation text NOT NULL CHECK (operation IN ('submit_result', 'confirm_result')),
  idempotency_key varchar(200) NOT NULL,
  payload_hash char(64) NOT NULL CHECK (payload_hash ~ '^[0-9a-f]{64}$'),
  radar_team_id uuid NOT NULL REFERENCES radar_team_profiles(id),
  match_id uuid NOT NULL REFERENCES friendly_matches(id),
  result_snapshot jsonb NOT NULL CHECK (jsonb_typeof(result_snapshot) = 'object'),
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (account_reference, operation, idempotency_key)
);

CREATE INDEX radar_match_result_mutations_match_idx
  ON radar_match_result_mutation_requests (match_id, created_at DESC);

CREATE INDEX match_result_submissions_match_current_idx
  ON match_result_submissions (match_id, is_current, created_at DESC);

CREATE FUNCTION radar_guard_match_result_submission()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  match_row friendly_matches%ROWTYPE;
BEGIN
  SELECT * INTO match_row FROM friendly_matches WHERE id = NEW.match_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'friendly match not found';
  END IF;
  IF NEW.submitting_team_id NOT IN (match_row.team_a_id, match_row.team_b_id) THEN
    RAISE EXCEPTION 'result submitting team is not a match participant';
  END IF;
  IF match_row.occurrence_state <> 'played' THEN
    RAISE EXCEPTION 'result requires both occurrence confirmations';
  END IF;
  IF match_row.result_state = 'verified' THEN
    RAISE EXCEPTION 'verified result is immutable';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER radar_guard_match_result_submission_insert
BEFORE INSERT ON match_result_submissions
FOR EACH ROW EXECUTE FUNCTION radar_guard_match_result_submission();

CREATE FUNCTION radar_guard_match_result_submission_change()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'match result submissions cannot be deleted';
  END IF;
  IF OLD.is_current IS NOT true OR NEW.is_current IS NOT false
     OR NEW.id <> OLD.id
     OR NEW.match_id <> OLD.match_id
     OR NEW.submitting_team_id <> OLD.submitting_team_id
     OR NEW.team_a_goals <> OLD.team_a_goals
     OR NEW.team_b_goals <> OLD.team_b_goals
     OR NEW.version <> OLD.version
     OR NEW.submission_hash <> OLD.submission_hash
     OR NEW.show_on_own_profile <> OLD.show_on_own_profile
     OR NEW.evidence_reference IS DISTINCT FROM OLD.evidence_reference
     OR NEW.created_at <> OLD.created_at THEN
    RAISE EXCEPTION 'match result submission history is immutable';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER radar_guard_match_result_submission_update_delete
BEFORE UPDATE OR DELETE ON match_result_submissions
FOR EACH ROW EXECUTE FUNCTION radar_guard_match_result_submission_change();

CREATE FUNCTION radar_guard_match_result_confirmation()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  match_row friendly_matches%ROWTYPE;
  submission_row match_result_submissions%ROWTYPE;
BEGIN
  SELECT * INTO match_row FROM friendly_matches WHERE id = NEW.match_id FOR UPDATE;
  SELECT * INTO submission_row
  FROM match_result_submissions
  WHERE id = NEW.submission_id AND match_id = NEW.match_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'result submission not found';
  END IF;
  IF NEW.confirming_team_id NOT IN (match_row.team_a_id, match_row.team_b_id) THEN
    RAISE EXCEPTION 'result confirming team is not a match participant';
  END IF;
  IF NEW.confirming_team_id = submission_row.submitting_team_id THEN
    RAISE EXCEPTION 'team cannot confirm its own result submission';
  END IF;
  IF match_row.occurrence_state <> 'played' THEN
    RAISE EXCEPTION 'result confirmation requires a played match';
  END IF;
  IF match_row.result_state = 'verified' THEN
    RAISE EXCEPTION 'verified result is immutable';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER radar_guard_match_result_confirmation_insert
BEFORE INSERT ON match_result_confirmations
FOR EACH ROW EXECUTE FUNCTION radar_guard_match_result_confirmation();

CREATE FUNCTION radar_reject_match_result_confirmation_change()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  RAISE EXCEPTION 'match result confirmations are append-only';
END;
$$;

CREATE TRIGGER radar_match_result_confirmations_append_only
BEFORE UPDATE OR DELETE ON match_result_confirmations
FOR EACH ROW EXECUTE FUNCTION radar_reject_match_result_confirmation_change();

CREATE FUNCTION radar_guard_friendly_match_result_change()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  occurrence_count integer;
BEGIN
  IF NEW.result_state IS NOT DISTINCT FROM OLD.result_state
     AND NEW.verified_team_a_goals IS NOT DISTINCT FROM OLD.verified_team_a_goals
     AND NEW.verified_team_b_goals IS NOT DISTINCT FROM OLD.verified_team_b_goals
     AND NEW.verified_result_at IS NOT DISTINCT FROM OLD.verified_result_at THEN
    RETURN NEW;
  END IF;

  IF NEW.occurrence_state <> 'played' THEN
    RAISE EXCEPTION 'match result requires a played match';
  END IF;
  IF OLD.result_state = 'verified' THEN
    RAISE EXCEPTION 'verified result is immutable';
  END IF;
  IF NOT (
    (OLD.result_state = 'empty' AND NEW.result_state = 'waiting_other')
    OR (OLD.result_state = 'waiting_other' AND NEW.result_state IN ('waiting_other', 'divergent', 'verified'))
    OR (OLD.result_state = 'divergent' AND NEW.result_state IN ('divergent', 'verified'))
  ) THEN
    RAISE EXCEPTION 'invalid match result transition';
  END IF;

  SELECT count(*) INTO occurrence_count
  FROM match_occurrence_confirmations
  WHERE match_id = OLD.id AND happened = true;
  IF occurrence_count <> 2 THEN
    RAISE EXCEPTION 'match result requires both occurrence confirmations';
  END IF;

  IF NEW.result_state = 'verified' THEN
    IF NEW.verified_result_at IS NULL
       OR NEW.verified_team_a_goals IS NULL
       OR NEW.verified_team_b_goals IS NULL THEN
      RAISE EXCEPTION 'verified result requires score and timestamp';
    END IF;
    IF NOT EXISTS (
      SELECT 1
      FROM match_result_confirmations confirmation
      JOIN match_result_submissions submission
        ON submission.id = confirmation.submission_id
       AND submission.match_id = confirmation.match_id
      WHERE confirmation.match_id = OLD.id
        AND submission.team_a_goals = NEW.verified_team_a_goals
        AND submission.team_b_goals = NEW.verified_team_b_goals
    ) THEN
      RAISE EXCEPTION 'verified result requires opponent consensus';
    END IF;
  ELSIF NEW.verified_result_at IS NOT NULL
        OR NEW.verified_team_a_goals IS NOT NULL
        OR NEW.verified_team_b_goals IS NOT NULL THEN
    RAISE EXCEPTION 'unverified result cannot expose an official score';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER radar_guard_friendly_match_result_update
BEFORE UPDATE ON friendly_matches
FOR EACH ROW EXECUTE FUNCTION radar_guard_friendly_match_result_change();

CREATE FUNCTION radar_reject_match_result_ledger_change()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  RAISE EXCEPTION 'match result ledger is append-only';
END;
$$;

CREATE TRIGGER radar_match_statistic_applications_append_only
BEFORE UPDATE OR DELETE ON radar_match_statistic_applications
FOR EACH ROW EXECUTE FUNCTION radar_reject_match_result_ledger_change();

CREATE TRIGGER radar_match_result_mutation_requests_append_only
BEFORE UPDATE OR DELETE ON radar_match_result_mutation_requests
FOR EACH ROW EXECUTE FUNCTION radar_reject_match_result_ledger_change();
