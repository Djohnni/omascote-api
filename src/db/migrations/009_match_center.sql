ALTER TABLE friendly_matches
  ADD COLUMN occurrence_confirmed_at timestamptz,
  ADD COLUMN cancellation_reason text,
  ADD COLUMN cancelled_by_team_id uuid REFERENCES radar_team_profiles(id),
  ADD COLUMN cancelled_at timestamptz,
  ADD CONSTRAINT friendly_matches_cancellation_reason_allowed CHECK (
    cancellation_reason IS NULL OR cancellation_reason IN (
      'weather', 'field_unavailable', 'team_unavailable',
      'scheduling_conflict', 'safety', 'other'
    )
  ),
  ADD CONSTRAINT friendly_matches_cancellation_coherent CHECK (
    (
      occurrence_state = 'cancelled'
      AND cancellation_reason IS NOT NULL
      AND cancelled_by_team_id IN (team_a_id, team_b_id)
      AND cancelled_at IS NOT NULL
      AND occurrence_confirmed_at IS NULL
    )
    OR
    (
      occurrence_state <> 'cancelled'
      AND cancellation_reason IS NULL
      AND cancelled_by_team_id IS NULL
      AND cancelled_at IS NULL
    )
  ) NOT VALID,
  ADD CONSTRAINT friendly_matches_occurrence_confirmed_coherent CHECK (
    (occurrence_state = 'played' AND occurrence_confirmed_at IS NOT NULL)
    OR (occurrence_state <> 'played' AND occurrence_confirmed_at IS NULL)
  ) NOT VALID;

CREATE INDEX friendly_matches_participant_state_idx
  ON friendly_matches (occurrence_state, scheduled_at DESC, public_id);

CREATE INDEX match_occurrence_confirmations_match_happened_idx
  ON match_occurrence_confirmations (match_id, happened, created_at);

CREATE FUNCTION radar_guard_friendly_match_insert()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  invitation_row friendly_invitations%ROWTYPE;
BEGIN
  SELECT * INTO invitation_row
  FROM friendly_invitations
  WHERE id = NEW.invitation_id;
  IF NOT FOUND OR invitation_row.state <> 'accepted' THEN
    RAISE EXCEPTION 'friendly match requires an accepted invitation';
  END IF;
  IF LEAST(NEW.team_a_id::text, NEW.team_b_id::text)
       <> LEAST(invitation_row.requester_team_id::text, invitation_row.invited_team_id::text)
     OR GREATEST(NEW.team_a_id::text, NEW.team_b_id::text)
       <> GREATEST(invitation_row.requester_team_id::text, invitation_row.invited_team_id::text) THEN
    RAISE EXCEPTION 'friendly match participants must match invitation participants';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER radar_guard_friendly_match_before_insert
BEFORE INSERT ON friendly_matches
FOR EACH ROW EXECUTE FUNCTION radar_guard_friendly_match_insert();

CREATE TABLE radar_match_mutation_requests (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  account_reference text NOT NULL CHECK (btrim(account_reference) <> ''),
  operation text NOT NULL CHECK (operation IN ('confirm_occurrence', 'cancel')),
  idempotency_key varchar(200) NOT NULL,
  payload_hash char(64) NOT NULL CHECK (payload_hash ~ '^[0-9a-f]{64}$'),
  radar_team_id uuid NOT NULL REFERENCES radar_team_profiles(id),
  match_id uuid NOT NULL REFERENCES friendly_matches(id),
  result_snapshot jsonb NOT NULL CHECK (jsonb_typeof(result_snapshot) = 'object'),
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (account_reference, operation, idempotency_key)
);

CREATE INDEX radar_match_mutations_match_idx
  ON radar_match_mutation_requests (match_id, created_at DESC);

CREATE FUNCTION radar_guard_friendly_match_change()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  confirmation_count integer;
BEGIN
  IF NEW.id <> OLD.id
     OR NEW.public_id <> OLD.public_id
     OR NEW.invitation_id <> OLD.invitation_id
     OR NEW.team_a_id <> OLD.team_a_id
     OR NEW.team_b_id <> OLD.team_b_id
     OR NEW.team_a_snapshot <> OLD.team_a_snapshot
     OR NEW.team_b_snapshot <> OLD.team_b_snapshot
     OR NEW.scheduled_at <> OLD.scheduled_at
     OR NEW.created_at <> OLD.created_at THEN
    RAISE EXCEPTION 'friendly match identity is immutable';
  END IF;

  IF NEW.version <> OLD.version + 1 THEN
    RAISE EXCEPTION 'friendly match version must increase by one';
  END IF;

  IF OLD.occurrence_state = 'cancelled' THEN
    RAISE EXCEPTION 'cancelled friendly match is immutable';
  END IF;

  IF OLD.occurrence_state = 'played' AND (
       NEW.occurrence_state IS DISTINCT FROM OLD.occurrence_state
       OR NEW.occurrence_confirmed_at IS DISTINCT FROM OLD.occurrence_confirmed_at
       OR NEW.cancellation_reason IS DISTINCT FROM OLD.cancellation_reason
       OR NEW.cancelled_by_team_id IS DISTINCT FROM OLD.cancelled_by_team_id
       OR NEW.cancelled_at IS DISTINCT FROM OLD.cancelled_at
     ) THEN
    RAISE EXCEPTION 'terminal friendly match cannot transition';
  END IF;

  IF OLD.occurrence_state = 'awaiting_occurrence'
     AND NEW.occurrence_state = 'scheduled' THEN
    RAISE EXCEPTION 'friendly match occurrence cannot move backwards';
  END IF;

  IF NEW.occurrence_state = 'cancelled' THEN
    IF EXISTS (
      SELECT 1 FROM match_occurrence_confirmations
      WHERE match_id = OLD.id AND happened = true
    ) THEN
      RAISE EXCEPTION 'confirmed friendly match cannot be cancelled unilaterally';
    END IF;
  ELSIF NEW.occurrence_state = 'played' THEN
    SELECT count(*) INTO confirmation_count
    FROM match_occurrence_confirmations
    WHERE match_id = OLD.id AND happened = true;
    IF confirmation_count <> 2 THEN
      RAISE EXCEPTION 'played friendly match requires both confirmations';
    END IF;
  ELSIF NEW.occurrence_state NOT IN ('scheduled', 'awaiting_occurrence') THEN
    RAISE EXCEPTION 'invalid friendly match occurrence transition';
  END IF;

  RETURN NEW;
END;
$$;

CREATE TRIGGER radar_guard_friendly_match_update
BEFORE UPDATE ON friendly_matches
FOR EACH ROW EXECUTE FUNCTION radar_guard_friendly_match_change();

CREATE FUNCTION radar_guard_match_occurrence_confirmation()
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
  IF NEW.confirming_team_id NOT IN (match_row.team_a_id, match_row.team_b_id) THEN
    RAISE EXCEPTION 'confirmation team is not a match participant';
  END IF;
  IF NEW.happened IS NOT true THEN
    RAISE EXCEPTION 'occurrence confirmation must confirm that the match happened';
  END IF;
  IF match_row.occurrence_state IN ('played', 'cancelled') THEN
    RAISE EXCEPTION 'terminal friendly match cannot receive confirmation';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER radar_guard_match_occurrence_confirmation_insert
BEFORE INSERT ON match_occurrence_confirmations
FOR EACH ROW EXECUTE FUNCTION radar_guard_match_occurrence_confirmation();

CREATE FUNCTION radar_reject_match_occurrence_confirmation_change()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  RAISE EXCEPTION 'match occurrence confirmations are append-only';
END;
$$;

CREATE TRIGGER radar_match_occurrence_confirmations_append_only
BEFORE UPDATE OR DELETE ON match_occurrence_confirmations
FOR EACH ROW EXECUTE FUNCTION radar_reject_match_occurrence_confirmation_change();

CREATE FUNCTION radar_reject_match_mutation_request_change()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  RAISE EXCEPTION 'radar_match_mutation_requests is append-only';
END;
$$;

CREATE TRIGGER radar_match_mutation_requests_append_only
BEFORE UPDATE OR DELETE ON radar_match_mutation_requests
FOR EACH ROW EXECUTE FUNCTION radar_reject_match_mutation_request_change();
