ALTER TABLE friendly_invitations
  ADD COLUMN current_proposer_team_id uuid REFERENCES radar_team_profiles(id),
  ADD COLUMN expired_at timestamptz;

UPDATE friendly_invitations
SET current_proposer_team_id = requester_team_id
WHERE current_proposer_team_id IS NULL;

ALTER TABLE friendly_invitations
  ALTER COLUMN current_proposer_team_id SET NOT NULL,
  ADD CONSTRAINT friendly_invitations_current_proposer_participant
    CHECK (current_proposer_team_id IN (requester_team_id, invited_team_id)),
  ADD CONSTRAINT friendly_invitations_terminal_timestamp
    CHECK (
      (state = 'accepted' AND accepted_at IS NOT NULL)
      OR (state = 'declined' AND declined_at IS NOT NULL)
      OR (state = 'cancelled' AND cancelled_at IS NOT NULL)
      OR (state = 'expired' AND expired_at IS NOT NULL)
      OR state IN ('pending', 'counter_proposed')
    ) NOT VALID;

CREATE FUNCTION radar_default_invitation_proposer()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF NEW.current_proposer_team_id IS NULL THEN
    NEW.current_proposer_team_id := NEW.requester_team_id;
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER radar_default_invitation_proposer_before_insert
BEFORE INSERT ON friendly_invitations
FOR EACH ROW EXECUTE FUNCTION radar_default_invitation_proposer();

CREATE INDEX friendly_invitations_current_inbox_idx
  ON friendly_invitations (current_proposer_team_id, state, updated_at DESC, public_id);

CREATE INDEX friendly_invitations_expiration_idx
  ON friendly_invitations (expires_at, public_id)
  WHERE state IN ('pending', 'counter_proposed');

ALTER TABLE notifications
  ADD COLUMN version integer NOT NULL DEFAULT 1 CHECK (version > 0);

CREATE INDEX notifications_recipient_cursor_idx
  ON notifications (recipient_team_id, created_at DESC, public_id DESC);

CREATE TABLE radar_invitation_mutation_requests (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  account_reference text NOT NULL CHECK (btrim(account_reference) <> ''),
  operation text NOT NULL CHECK (
    operation IN ('create', 'accept', 'decline', 'cancel', 'counter', 'notification_read')
  ),
  idempotency_key varchar(200) NOT NULL,
  payload_hash char(64) NOT NULL CHECK (payload_hash ~ '^[0-9a-f]{64}$'),
  radar_team_id uuid NOT NULL REFERENCES radar_team_profiles(id),
  invitation_id uuid REFERENCES friendly_invitations(id),
  notification_id uuid REFERENCES notifications(id),
  result_snapshot jsonb NOT NULL CHECK (jsonb_typeof(result_snapshot) = 'object'),
  created_at timestamptz NOT NULL DEFAULT now(),
  CHECK ((invitation_id IS NULL) <> (notification_id IS NULL)),
  UNIQUE (account_reference, operation, idempotency_key)
);

CREATE INDEX radar_invitation_mutations_team_idx
  ON radar_invitation_mutation_requests (radar_team_id, created_at DESC);

CREATE TABLE radar_invitation_rate_limits (
  operation text NOT NULL CHECK (btrim(operation) <> ''),
  scope_type text NOT NULL CHECK (scope_type IN ('account', 'team', 'ip')),
  scope_hash char(64) NOT NULL CHECK (scope_hash ~ '^[0-9a-f]{64}$'),
  window_started_at timestamptz NOT NULL,
  request_count integer NOT NULL DEFAULT 0 CHECK (request_count >= 0),
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (operation, scope_type, scope_hash, window_started_at)
);

CREATE INDEX radar_invitation_rate_limits_cleanup_idx
  ON radar_invitation_rate_limits (window_started_at);

CREATE FUNCTION radar_guard_friendly_invitation_change()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF NEW.id <> OLD.id
     OR NEW.public_id <> OLD.public_id
     OR NEW.requester_team_id <> OLD.requester_team_id
     OR NEW.invited_team_id <> OLD.invited_team_id
     OR NEW.created_at <> OLD.created_at THEN
    RAISE EXCEPTION 'friendly invitation identity is immutable';
  END IF;

  IF NEW.version <> OLD.version + 1 THEN
    RAISE EXCEPTION 'friendly invitation version must increase by one';
  END IF;

  IF OLD.state IN ('accepted', 'declined', 'cancelled', 'expired') THEN
    RAISE EXCEPTION 'terminal friendly invitation cannot transition';
  END IF;

  IF OLD.state NOT IN ('pending', 'counter_proposed')
     OR NEW.state NOT IN ('pending', 'counter_proposed', 'accepted', 'declined', 'cancelled', 'expired') THEN
    RAISE EXCEPTION 'invalid friendly invitation transition';
  END IF;

  RETURN NEW;
END;
$$;

CREATE TRIGGER radar_guard_friendly_invitation_update
BEFORE UPDATE ON friendly_invitations
FOR EACH ROW EXECUTE FUNCTION radar_guard_friendly_invitation_change();

CREATE FUNCTION radar_guard_notification_change()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF NEW.id <> OLD.id
     OR NEW.public_id <> OLD.public_id
     OR NEW.recipient_team_id <> OLD.recipient_team_id
     OR NEW.event_type <> OLD.event_type
     OR NEW.entity_type <> OLD.entity_type
     OR NEW.entity_public_id IS DISTINCT FROM OLD.entity_public_id
     OR NEW.payload <> OLD.payload
     OR NEW.created_at <> OLD.created_at THEN
    RAISE EXCEPTION 'notification content is immutable';
  END IF;

  IF NEW.version <> OLD.version + 1 THEN
    RAISE EXCEPTION 'notification version must increase by one';
  END IF;

  IF OLD.read_at IS NOT NULL AND NEW.read_at IS DISTINCT FROM OLD.read_at THEN
    RAISE EXCEPTION 'read notification is immutable';
  END IF;

  RETURN NEW;
END;
$$;

CREATE TRIGGER radar_guard_notification_update
BEFORE UPDATE ON notifications
FOR EACH ROW EXECUTE FUNCTION radar_guard_notification_change();

CREATE FUNCTION radar_reject_invitation_mutation_request_change()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  RAISE EXCEPTION 'radar_invitation_mutation_requests is append-only';
END;
$$;

CREATE TRIGGER radar_invitation_mutation_requests_append_only
BEFORE UPDATE OR DELETE ON radar_invitation_mutation_requests
FOR EACH ROW EXECUTE FUNCTION radar_reject_invitation_mutation_request_change();
