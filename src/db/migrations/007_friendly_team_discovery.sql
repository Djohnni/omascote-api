ALTER TABLE radar_team_profiles
  ADD COLUMN public_name text,
  ADD COLUMN public_profile_enabled boolean NOT NULL DEFAULT false,
  ADD COLUMN public_crest_available boolean NOT NULL DEFAULT false;

ALTER TABLE radar_team_profiles
  ADD CONSTRAINT radar_team_profiles_public_name_safe
    CHECK (
      public_name IS NULL
      OR (
        char_length(public_name) BETWEEN 2 AND 80
        AND public_name = btrim(public_name)
        AND public_name !~ '[[:cntrl:]]'
      )
    ) NOT VALID;

CREATE INDEX radar_team_profiles_safe_discovery_idx
  ON radar_team_profiles (
    status, availability_active, instagram_verification_status,
    city_ibge_code, declared_level, public_slug
  )
  WHERE public_profile_enabled = true
    AND public_crest_available = true
    AND radar_terms_accepted_at IS NOT NULL
    AND suspended_at IS NULL;

CREATE INDEX radar_team_profiles_eligibility_discovery_idx
  ON radar_team_profiles (
    status, availability_active, instagram_verification_status,
    city_ibge_code, declared_level, public_slug
  )
  WHERE radar_terms_accepted_at IS NOT NULL
    AND suspended_at IS NULL;

CREATE INDEX friendly_availabilities_active_discovery_idx
  ON friendly_availabilities (
    team_id, modality, category, declared_level, starts_at, public_id
  )
  WHERE status = 'active';

CREATE INDEX team_blocks_blocked_lookup_idx
  ON team_blocks (blocked_team_id, blocker_team_id);

CREATE TABLE radar_search_rate_limits (
  scope_type text NOT NULL CHECK (scope_type IN ('account', 'team', 'ip')),
  scope_hash char(64) NOT NULL CHECK (scope_hash ~ '^[0-9a-f]{64}$'),
  window_started_at timestamptz NOT NULL,
  request_count integer NOT NULL DEFAULT 0 CHECK (request_count >= 0),
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (scope_type, scope_hash, window_started_at)
);

CREATE INDEX radar_search_rate_limits_cleanup_idx
  ON radar_search_rate_limits (window_started_at);

CREATE TABLE radar_search_metrics (
  metric_date date NOT NULL,
  outcome text NOT NULL CHECK (outcome IN ('success', 'empty', 'timeout', 'error')),
  request_count bigint NOT NULL DEFAULT 0 CHECK (request_count >= 0),
  returned_count bigint NOT NULL DEFAULT 0 CHECK (returned_count >= 0),
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (metric_date, outcome)
);
