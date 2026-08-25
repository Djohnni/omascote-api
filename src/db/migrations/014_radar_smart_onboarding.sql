-- Fase 7C: cadastro inteligente, modalidades multiplas e contato opcional protegido.

ALTER TABLE radar_team_profiles
  ADD COLUMN IF NOT EXISTS whatsapp_ciphertext text,
  ADD COLUMN IF NOT EXISTS whatsapp_key_version varchar(16),
  ADD COLUMN IF NOT EXISTS whatsapp_visible boolean NOT NULL DEFAULT false;

ALTER TABLE radar_team_profiles
  DROP CONSTRAINT IF EXISTS radar_team_profiles_whatsapp_consistency;
ALTER TABLE radar_team_profiles
  ADD CONSTRAINT radar_team_profiles_whatsapp_consistency CHECK (
    (whatsapp_ciphertext IS NULL AND whatsapp_key_version IS NULL AND whatsapp_visible = false)
    OR
    (whatsapp_ciphertext IS NOT NULL AND btrim(whatsapp_ciphertext) <> ''
      AND whatsapp_key_version ~ '^v[1-9][0-9]{0,3}$')
  ) NOT VALID;
ALTER TABLE radar_team_profiles
  VALIDATE CONSTRAINT radar_team_profiles_whatsapp_consistency;

ALTER TABLE radar_profile_print_import_requests
  ALTER COLUMN radar_team_id DROP NOT NULL,
  ADD COLUMN IF NOT EXISTS public_id uuid NOT NULL DEFAULT gen_random_uuid(),
  ADD COLUMN IF NOT EXISTS ai_draft jsonb,
  ADD COLUMN IF NOT EXISTS ai_model varchar(120),
  ADD COLUMN IF NOT EXISTS ai_completed_at timestamptz,
  ADD COLUMN IF NOT EXISTS processing_expires_at timestamptz,
  ADD COLUMN IF NOT EXISTS evidence_delete_after timestamptz,
  ADD COLUMN IF NOT EXISTS operation_metadata jsonb NOT NULL DEFAULT '{}'::jsonb;

CREATE UNIQUE INDEX IF NOT EXISTS radar_profile_print_import_requests_public_id_idx
  ON radar_profile_print_import_requests (public_id);

ALTER TABLE radar_profile_print_import_requests
  DROP CONSTRAINT IF EXISTS radar_profile_print_import_requests_state_check;
ALTER TABLE radar_profile_print_import_requests
  ADD CONSTRAINT radar_profile_print_import_requests_state_check
    CHECK (state IN ('processing', 'completed', 'failed', 'expired'));

ALTER TABLE radar_profile_print_import_requests
  DROP CONSTRAINT IF EXISTS radar_profile_print_import_requests_check;
ALTER TABLE radar_profile_print_import_requests
  ADD CONSTRAINT radar_profile_print_import_requests_outcome_check CHECK (
    (state = 'processing' AND result_snapshot IS NULL AND failure_code IS NULL)
    OR
    (state = 'completed' AND jsonb_typeof(result_snapshot) = 'object' AND failure_code IS NULL)
    OR
    (state = 'failed' AND result_snapshot IS NULL AND failure_code IS NOT NULL)
    OR
    (state = 'expired' AND result_snapshot = '{"outcome":"expired"}'::jsonb AND failure_code IS NULL)
  );

CREATE UNIQUE INDEX IF NOT EXISTS radar_profile_print_one_processing_account_idx
  ON radar_profile_print_import_requests (account_reference)
  WHERE state = 'processing';
CREATE INDEX IF NOT EXISTS radar_profile_print_request_dedupe_idx
  ON radar_profile_print_import_requests (account_reference, evidence_hash, evidence_delete_after DESC)
  WHERE state = 'completed';
CREATE INDEX IF NOT EXISTS radar_profile_print_request_expiry_idx
  ON radar_profile_print_import_requests (evidence_delete_after)
  WHERE state = 'completed';

CREATE OR REPLACE FUNCTION radar_protect_profile_print_import_request()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'radar_profile_print_import_requests cannot be deleted';
  END IF;
  IF NEW.id <> OLD.id
    OR NEW.public_id <> OLD.public_id
    OR NEW.account_reference <> OLD.account_reference
    OR NEW.radar_team_id IS DISTINCT FROM OLD.radar_team_id
    OR NEW.idempotency_key <> OLD.idempotency_key
    OR NEW.payload_hash <> OLD.payload_hash
    OR NEW.evidence_hash <> OLD.evidence_hash
    OR NEW.verification_id IS DISTINCT FROM OLD.verification_id
    OR NEW.created_at <> OLD.created_at THEN
    RAISE EXCEPTION 'profile print import request identity is immutable';
  END IF;
  IF OLD.state = 'completed' AND NEW.state = 'expired'
    AND NEW.ai_draft IS NULL
    AND NEW.result_snapshot = '{"outcome":"expired"}'::jsonb THEN
    RETURN NEW;
  END IF;
  IF OLD.state <> 'processing' THEN
    RAISE EXCEPTION 'terminal profile print import request is immutable';
  END IF;
  RETURN NEW;
END;
$$;

ALTER TABLE radar_profile_print_rate_limits
  DROP CONSTRAINT IF EXISTS radar_profile_print_rate_limits_scope_type_check;
ALTER TABLE radar_profile_print_rate_limits
  ADD CONSTRAINT radar_profile_print_rate_limits_scope_type_check
    CHECK (scope_type IN ('account', 'team', 'ip', 'global'));

ALTER TABLE friendly_availabilities
  DROP CONSTRAINT IF EXISTS friendly_availabilities_declared_level_nonempty;
DROP INDEX IF EXISTS friendly_availabilities_future_discovery_idx;
DROP INDEX IF EXISTS radar_team_profiles_safe_discovery_idx;
DROP INDEX IF EXISTS radar_team_profiles_eligibility_discovery_idx;
DROP INDEX IF EXISTS friendly_availabilities_active_discovery_idx;

CREATE INDEX IF NOT EXISTS friendly_availabilities_future_discovery_v2_idx
  ON friendly_availabilities (
    city_ibge_code, modality, category, status, starts_at, public_id
  );
CREATE INDEX IF NOT EXISTS radar_team_profiles_safe_discovery_v2_idx
  ON radar_team_profiles (
    status, availability_active, instagram_verification_status,
    city_ibge_code, public_slug
  )
  WHERE public_profile_enabled = true
    AND public_crest_available = true
    AND radar_terms_accepted_at IS NOT NULL
    AND suspended_at IS NULL;
CREATE INDEX IF NOT EXISTS radar_team_profiles_eligibility_discovery_v2_idx
  ON radar_team_profiles (
    status, availability_active, instagram_verification_status,
    city_ibge_code, public_slug
  )
  WHERE radar_terms_accepted_at IS NOT NULL
    AND suspended_at IS NULL;
CREATE INDEX IF NOT EXISTS friendly_availabilities_active_discovery_v2_idx
  ON friendly_availabilities (team_id, modality, category, starts_at, public_id)
  WHERE status = 'active';

CREATE TABLE IF NOT EXISTS radar_whatsapp_release_limits (
  scope_type text NOT NULL CHECK (scope_type IN ('account', 'team', 'ip')),
  scope_hash char(64) NOT NULL CHECK (scope_hash ~ '^[0-9a-f]{64}$'),
  window_started_at timestamptz NOT NULL,
  request_count integer NOT NULL DEFAULT 0 CHECK (request_count >= 0),
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (scope_type, scope_hash, window_started_at)
);
CREATE INDEX IF NOT EXISTS radar_whatsapp_release_limits_cleanup_idx
  ON radar_whatsapp_release_limits (window_started_at);
