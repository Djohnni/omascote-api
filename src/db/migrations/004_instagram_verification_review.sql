ALTER TABLE team_verifications
  ADD COLUMN public_id uuid NOT NULL DEFAULT gen_random_uuid(),
  ADD COLUMN instagram_handle_snapshot text,
  ADD COLUMN requested_by_account_reference text,
  ADD COLUMN confirmation_claimed_at timestamptz,
  ADD COLUMN decision_details jsonb,
  ADD COLUMN version integer NOT NULL DEFAULT 1 CHECK (version > 0),
  ADD COLUMN updated_at timestamptz NOT NULL DEFAULT now();

ALTER TABLE team_verifications
  ADD CONSTRAINT team_verifications_public_id_key UNIQUE (public_id),
  ADD CONSTRAINT team_verifications_challenge_hash_format
    CHECK (challenge_hash IS NULL OR challenge_hash ~ '^[0-9a-f]{64}$'),
  ADD CONSTRAINT team_verifications_instagram_fields_present
    CHECK (
      method <> 'instagram_bio_code'
      OR (
        challenge_hash IS NOT NULL
        AND instagram_handle_snapshot IS NOT NULL
        AND btrim(instagram_handle_snapshot) <> ''
        AND requested_by_account_reference IS NOT NULL
        AND btrim(requested_by_account_reference) <> ''
        AND challenge_expires_at IS NOT NULL
      )
    ) NOT VALID,
  ADD CONSTRAINT team_verifications_terminal_decision_time
    CHECK (status = 'pending' OR decided_at IS NOT NULL) NOT VALID;

CREATE UNIQUE INDEX team_verifications_one_open_instagram_challenge_idx
  ON team_verifications (team_id)
  WHERE method = 'instagram_bio_code' AND status = 'pending';

CREATE INDEX team_verifications_review_queue_idx
  ON team_verifications (status, confirmation_claimed_at, created_at)
  WHERE method = 'instagram_bio_code';

CREATE TABLE radar_verification_mutation_requests (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  account_reference text NOT NULL CHECK (btrim(account_reference) <> ''),
  operation text NOT NULL CHECK (operation IN ('initiate', 'confirm', 'approve', 'reject')),
  idempotency_key varchar(200) NOT NULL,
  payload_hash char(64) NOT NULL CHECK (payload_hash ~ '^[0-9a-f]{64}$'),
  verification_id uuid REFERENCES team_verifications(id) ON DELETE SET NULL,
  result_snapshot jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (account_reference, operation, idempotency_key)
);

CREATE TABLE radar_verification_rate_limits (
  scope_type text NOT NULL CHECK (scope_type IN ('account', 'team', 'ip')),
  scope_hash char(64) NOT NULL CHECK (scope_hash ~ '^[0-9a-f]{64}$'),
  operation text NOT NULL CHECK (operation IN ('initiate', 'confirm')),
  window_started_at timestamptz NOT NULL,
  request_count integer NOT NULL DEFAULT 1 CHECK (request_count > 0),
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (scope_type, scope_hash, operation, window_started_at)
);

CREATE TABLE radar_account_roles (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  account_reference text NOT NULL CHECK (btrim(account_reference) <> ''),
  role text NOT NULL CHECK (role IN ('verification_reviewer', 'radar_admin')),
  active boolean NOT NULL DEFAULT true,
  granted_by_account_reference text NOT NULL CHECK (btrim(granted_by_account_reference) <> ''),
  granted_at timestamptz NOT NULL DEFAULT now(),
  revoked_by_account_reference text,
  revoked_at timestamptz,
  CHECK (
    (active AND revoked_at IS NULL AND revoked_by_account_reference IS NULL)
    OR
    (NOT active AND revoked_at IS NOT NULL AND revoked_by_account_reference IS NOT NULL)
  ),
  UNIQUE (account_reference, role)
);

CREATE INDEX radar_account_roles_active_idx
  ON radar_account_roles (account_reference, role)
  WHERE active;

CREATE FUNCTION radar_reject_verification_mutation_request_change()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  RAISE EXCEPTION 'radar_verification_mutation_requests is append-only';
END;
$$;

CREATE TRIGGER radar_verification_mutation_requests_append_only
BEFORE UPDATE OR DELETE ON radar_verification_mutation_requests
FOR EACH ROW EXECUTE FUNCTION radar_reject_verification_mutation_request_change();

CREATE FUNCTION radar_protect_verification_history()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF OLD.status <> 'pending' THEN
    RAISE EXCEPTION 'terminal team verification is immutable';
  END IF;

  IF NEW.id <> OLD.id
    OR NEW.public_id <> OLD.public_id
    OR NEW.team_id <> OLD.team_id
    OR NEW.method <> OLD.method
    OR NEW.challenge_hash IS DISTINCT FROM OLD.challenge_hash
    OR NEW.challenge_expires_at IS DISTINCT FROM OLD.challenge_expires_at
    OR NEW.instagram_handle_snapshot IS DISTINCT FROM OLD.instagram_handle_snapshot
    OR NEW.requested_by_account_reference IS DISTINCT FROM OLD.requested_by_account_reference
    OR NEW.created_at <> OLD.created_at THEN
    RAISE EXCEPTION 'team verification identity is immutable';
  END IF;

  IF NEW.attempt_count < OLD.attempt_count THEN
    RAISE EXCEPTION 'team verification attempts cannot decrease';
  END IF;

  IF OLD.confirmation_claimed_at IS NOT NULL
    AND NEW.confirmation_claimed_at IS DISTINCT FROM OLD.confirmation_claimed_at THEN
    RAISE EXCEPTION 'team verification confirmation is immutable';
  END IF;

  RETURN NEW;
END;
$$;

CREATE TRIGGER team_verifications_protected_history
BEFORE UPDATE ON team_verifications
FOR EACH ROW EXECUTE FUNCTION radar_protect_verification_history();

CREATE FUNCTION radar_reject_team_verification_delete()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  RAISE EXCEPTION 'team verification history cannot be deleted';
END;
$$;

CREATE TRIGGER team_verifications_no_delete
BEFORE DELETE ON team_verifications
FOR EACH ROW EXECUTE FUNCTION radar_reject_team_verification_delete();
