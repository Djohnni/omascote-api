ALTER TABLE team_verifications
  ADD COLUMN evidence_hash char(64),
  ADD COLUMN ai_model varchar(120),
  ADD COLUMN ai_completed_at timestamptz,
  ADD COLUMN processing_expires_at timestamptz,
  ADD COLUMN operation_metadata jsonb NOT NULL DEFAULT '{}'::jsonb;

ALTER TABLE team_verifications
  ADD CONSTRAINT team_verifications_evidence_hash_format
    CHECK (evidence_hash IS NULL OR evidence_hash ~ '^[0-9a-f]{64}$'),
  ADD CONSTRAINT team_verifications_operation_metadata_object
    CHECK (jsonb_typeof(operation_metadata) = 'object'),
  ADD CONSTRAINT team_verifications_profile_print_fields_present
    CHECK (
      method <> 'profile_print_import'
      OR (
        evidence_hash IS NOT NULL
        AND requested_by_account_reference IS NOT NULL
        AND btrim(requested_by_account_reference) <> ''
        AND evidence_delete_after IS NOT NULL
        AND processing_expires_at IS NOT NULL
        AND ai_model IS NOT NULL
        AND btrim(ai_model) <> ''
      )
    ) NOT VALID,
  ADD CONSTRAINT team_verifications_profile_print_draft_consistency
    CHECK (
      method <> 'profile_print_import'
      OR (
        ai_draft IS NULL
        OR
        (jsonb_typeof(ai_draft) = 'object' AND ai_completed_at IS NOT NULL)
      )
    ) NOT VALID;

CREATE UNIQUE INDEX team_verifications_one_processing_profile_print_idx
  ON team_verifications (team_id)
  WHERE method = 'profile_print_import' AND status = 'pending' AND ai_draft IS NULL;

CREATE INDEX team_verifications_profile_print_dedupe_idx
  ON team_verifications (team_id, evidence_hash, evidence_delete_after DESC)
  WHERE method = 'profile_print_import' AND status = 'pending' AND ai_draft IS NOT NULL;

CREATE INDEX team_verifications_profile_print_expiry_idx
  ON team_verifications (evidence_delete_after)
  WHERE method = 'profile_print_import' AND status = 'pending';

CREATE TABLE radar_profile_print_import_requests (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  account_reference text NOT NULL CHECK (btrim(account_reference) <> ''),
  radar_team_id uuid NOT NULL REFERENCES radar_team_profiles(id) ON DELETE CASCADE,
  idempotency_key varchar(200) NOT NULL,
  payload_hash char(64) NOT NULL CHECK (payload_hash ~ '^[0-9a-f]{64}$'),
  evidence_hash char(64) NOT NULL CHECK (evidence_hash ~ '^[0-9a-f]{64}$'),
  verification_id uuid REFERENCES team_verifications(id) ON DELETE SET NULL,
  state text NOT NULL DEFAULT 'processing'
    CHECK (state IN ('processing', 'completed', 'failed')),
  result_snapshot jsonb,
  failure_code varchar(80),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (account_reference, idempotency_key),
  CHECK (
    (state = 'processing' AND result_snapshot IS NULL AND failure_code IS NULL)
    OR
    (state = 'completed' AND jsonb_typeof(result_snapshot) = 'object' AND failure_code IS NULL)
    OR
    (state = 'failed' AND result_snapshot IS NULL AND failure_code IS NOT NULL)
  )
);

CREATE INDEX radar_profile_print_import_requests_team_idx
  ON radar_profile_print_import_requests (radar_team_id, created_at DESC);

CREATE TABLE radar_profile_print_rate_limits (
  scope_type text NOT NULL CHECK (scope_type IN ('account', 'team', 'ip')),
  scope_hash char(64) NOT NULL CHECK (scope_hash ~ '^[0-9a-f]{64}$'),
  window_started_at timestamptz NOT NULL,
  request_count integer NOT NULL DEFAULT 1 CHECK (request_count > 0),
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (scope_type, scope_hash, window_started_at)
);

CREATE FUNCTION radar_protect_profile_print_import_request()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'radar_profile_print_import_requests cannot be deleted';
  END IF;

  IF NEW.id <> OLD.id
    OR NEW.account_reference <> OLD.account_reference
    OR NEW.radar_team_id <> OLD.radar_team_id
    OR NEW.idempotency_key <> OLD.idempotency_key
    OR NEW.payload_hash <> OLD.payload_hash
    OR NEW.evidence_hash <> OLD.evidence_hash
    OR NEW.verification_id IS DISTINCT FROM OLD.verification_id
    OR NEW.created_at <> OLD.created_at THEN
    RAISE EXCEPTION 'profile print import request identity is immutable';
  END IF;

  IF OLD.state <> 'processing' THEN
    RAISE EXCEPTION 'terminal profile print import request is immutable';
  END IF;

  RETURN NEW;
END;
$$;

CREATE TRIGGER radar_profile_print_import_requests_protected
BEFORE UPDATE OR DELETE ON radar_profile_print_import_requests
FOR EACH ROW EXECUTE FUNCTION radar_protect_profile_print_import_request();

CREATE OR REPLACE FUNCTION radar_protect_verification_history()
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
    OR NEW.evidence_hash IS DISTINCT FROM OLD.evidence_hash
    OR NEW.ai_model IS DISTINCT FROM OLD.ai_model
    OR NEW.processing_expires_at IS DISTINCT FROM OLD.processing_expires_at
    OR NEW.evidence_delete_after IS DISTINCT FROM OLD.evidence_delete_after
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

  IF OLD.ai_draft IS NOT NULL
    AND NEW.ai_draft IS DISTINCT FROM OLD.ai_draft
    AND NOT (NEW.status = 'expired' AND NEW.ai_draft IS NULL) THEN
    RAISE EXCEPTION 'profile print import draft is immutable';
  END IF;

  IF OLD.ai_draft IS NOT NULL
    AND NEW.ai_completed_at IS DISTINCT FROM OLD.ai_completed_at THEN
    RAISE EXCEPTION 'profile print import completion is immutable';
  END IF;

  IF OLD.ai_draft IS NOT NULL
    AND NEW.operation_metadata IS DISTINCT FROM OLD.operation_metadata THEN
    RAISE EXCEPTION 'profile print import metadata is immutable';
  END IF;

  RETURN NEW;
END;
$$;
