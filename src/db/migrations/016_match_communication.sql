CREATE TABLE radar_match_conversations (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  public_id uuid NOT NULL DEFAULT gen_random_uuid() UNIQUE,
  match_id uuid NOT NULL UNIQUE REFERENCES friendly_matches(id) ON DELETE CASCADE,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX radar_match_conversations_match_idx
  ON radar_match_conversations (match_id, public_id);

CREATE TABLE radar_match_messages (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  sequence bigint GENERATED ALWAYS AS IDENTITY UNIQUE,
  public_id uuid NOT NULL DEFAULT gen_random_uuid() UNIQUE,
  conversation_id uuid NOT NULL REFERENCES radar_match_conversations(id) ON DELETE CASCADE,
  sender_team_id uuid NOT NULL REFERENCES radar_team_profiles(id),
  body text,
  body_erased_at timestamptz,
  retention_expires_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  CHECK (
    (body IS NOT NULL AND char_length(body) BETWEEN 1 AND 1000 AND body_erased_at IS NULL)
    OR (body IS NULL AND body_erased_at IS NOT NULL)
  )
);

CREATE INDEX radar_match_messages_conversation_cursor_idx
  ON radar_match_messages (conversation_id, created_at DESC, sequence DESC);

CREATE INDEX radar_match_messages_retention_idx
  ON radar_match_messages (retention_expires_at, id)
  WHERE body IS NOT NULL;

CREATE TABLE radar_match_message_reads (
  conversation_id uuid NOT NULL REFERENCES radar_match_conversations(id) ON DELETE CASCADE,
  reader_team_id uuid NOT NULL REFERENCES radar_team_profiles(id) ON DELETE CASCADE,
  last_read_message_id uuid REFERENCES radar_match_messages(id),
  last_read_at timestamptz NOT NULL,
  version integer NOT NULL DEFAULT 1 CHECK (version > 0),
  PRIMARY KEY (conversation_id, reader_team_id)
);

CREATE TABLE radar_match_communication_mutations (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  account_pseudonym char(64) NOT NULL CHECK (account_pseudonym ~ '^[0-9a-f]{64}$'),
  operation text NOT NULL CHECK (operation IN ('send_message', 'mark_read', 'report_message')),
  idempotency_key varchar(200) NOT NULL,
  payload_hash char(64) NOT NULL CHECK (payload_hash ~ '^[0-9a-f]{64}$'),
  radar_team_id uuid NOT NULL REFERENCES radar_team_profiles(id),
  conversation_id uuid NOT NULL REFERENCES radar_match_conversations(id),
  message_id uuid REFERENCES radar_match_messages(id),
  result_snapshot jsonb NOT NULL CHECK (jsonb_typeof(result_snapshot) = 'object'),
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (account_pseudonym, operation, idempotency_key)
);

CREATE INDEX radar_match_communication_mutations_conversation_idx
  ON radar_match_communication_mutations (conversation_id, created_at DESC);

CREATE TABLE radar_match_communication_rate_limits (
  scope_type text NOT NULL CHECK (scope_type IN ('account', 'team', 'ip')),
  scope_hash char(64) NOT NULL CHECK (scope_hash ~ '^[0-9a-f]{64}$'),
  operation text NOT NULL CHECK (operation IN ('channels', 'list', 'send', 'read', 'report')),
  window_started_at timestamptz NOT NULL,
  request_count integer NOT NULL DEFAULT 0 CHECK (request_count >= 0),
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (scope_type, scope_hash, operation, window_started_at)
);

CREATE INDEX radar_match_communication_rate_limits_cleanup_idx
  ON radar_match_communication_rate_limits (window_started_at);

ALTER TABLE radar_moderation_cases
  ADD COLUMN message_id uuid REFERENCES radar_match_messages(id) ON DELETE SET NULL;

DO $$
DECLARE
  item record;
BEGIN
  FOR item IN
    SELECT conname
    FROM pg_constraint
    WHERE conrelid = 'radar_moderation_cases'::regclass
      AND contype = 'c'
      AND pg_get_constraintdef(oid) ILIKE '%case_type%'
  LOOP
    EXECUTE format('ALTER TABLE radar_moderation_cases DROP CONSTRAINT %I', item.conname);
  END LOOP;
END;
$$;

ALTER TABLE radar_moderation_cases
  ADD CONSTRAINT radar_moderation_cases_type_v2_check
    CHECK (case_type IN ('team_report', 'match_report', 'result_dispute', 'message_report')) NOT VALID,
  ADD CONSTRAINT radar_moderation_cases_target_v2_check CHECK (
    (case_type = 'team_report' AND match_id IS NULL AND message_id IS NULL)
    OR (case_type IN ('match_report', 'result_dispute') AND match_id IS NOT NULL AND message_id IS NULL)
    OR (case_type = 'message_report' AND match_id IS NOT NULL AND message_id IS NOT NULL)
  ) NOT VALID;

CREATE UNIQUE INDEX radar_moderation_open_message_report_idx
  ON radar_moderation_cases (reporter_team_id, message_id)
  WHERE case_type = 'message_report' AND status IN ('open', 'assigned');

CREATE FUNCTION radar_create_match_conversation()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  INSERT INTO radar_match_conversations(match_id, created_at)
  VALUES (NEW.id, NEW.created_at)
  ON CONFLICT (match_id) DO NOTHING;
  RETURN NEW;
END;
$$;

CREATE TRIGGER radar_friendly_match_create_conversation
AFTER INSERT ON friendly_matches
FOR EACH ROW EXECUTE FUNCTION radar_create_match_conversation();

INSERT INTO radar_match_conversations(match_id, created_at)
SELECT match.id, match.created_at
FROM friendly_matches match
ON CONFLICT (match_id) DO NOTHING;

CREATE FUNCTION radar_guard_match_message_insert()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  match_row friendly_matches%ROWTYPE;
BEGIN
  SELECT match.* INTO match_row
  FROM radar_match_conversations conversation
  JOIN friendly_matches match ON match.id = conversation.match_id
  JOIN friendly_invitations invitation ON invitation.id = match.invitation_id
  WHERE conversation.id = NEW.conversation_id
    AND invitation.state = 'accepted';
  IF NOT FOUND OR NEW.sender_team_id NOT IN (match_row.team_a_id, match_row.team_b_id) THEN
    RAISE EXCEPTION 'message sender is not a participant of an accepted match';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER radar_match_message_before_insert
BEFORE INSERT ON radar_match_messages
FOR EACH ROW EXECUTE FUNCTION radar_guard_match_message_insert();

CREATE FUNCTION radar_guard_match_message_change()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'match messages cannot be deleted';
  END IF;
  IF NEW.id <> OLD.id OR NEW.public_id <> OLD.public_id OR NEW.sequence <> OLD.sequence
     OR NEW.conversation_id <> OLD.conversation_id
     OR NEW.sender_team_id <> OLD.sender_team_id
     OR NEW.retention_expires_at <> OLD.retention_expires_at
     OR NEW.created_at <> OLD.created_at
     OR OLD.body IS NULL OR NEW.body IS NOT NULL
     OR OLD.body_erased_at IS NOT NULL OR NEW.body_erased_at IS NULL THEN
    RAISE EXCEPTION 'match message content is append-only except retention erasure';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER radar_match_messages_protected
BEFORE UPDATE OR DELETE ON radar_match_messages
FOR EACH ROW EXECUTE FUNCTION radar_guard_match_message_change();

CREATE FUNCTION radar_guard_message_read()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  match_row friendly_matches%ROWTYPE;
  message_conversation uuid;
BEGIN
  SELECT match.* INTO match_row
  FROM radar_match_conversations conversation
  JOIN friendly_matches match ON match.id = conversation.match_id
  WHERE conversation.id = NEW.conversation_id;
  IF NOT FOUND OR NEW.reader_team_id NOT IN (match_row.team_a_id, match_row.team_b_id) THEN
    RAISE EXCEPTION 'message reader is not a match participant';
  END IF;
  IF NEW.last_read_message_id IS NOT NULL THEN
    SELECT conversation_id INTO message_conversation
    FROM radar_match_messages WHERE id = NEW.last_read_message_id;
    IF message_conversation IS DISTINCT FROM NEW.conversation_id THEN
      RAISE EXCEPTION 'read marker message belongs to another conversation';
    END IF;
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER radar_match_message_read_guard
BEFORE INSERT OR UPDATE ON radar_match_message_reads
FOR EACH ROW EXECUTE FUNCTION radar_guard_message_read();

CREATE FUNCTION radar_reject_communication_mutation_change()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  RAISE EXCEPTION 'communication mutation records are append-only';
END;
$$;

CREATE TRIGGER radar_match_communication_mutations_append_only
BEFORE UPDATE OR DELETE ON radar_match_communication_mutations
FOR EACH ROW EXECUTE FUNCTION radar_reject_communication_mutation_change();
