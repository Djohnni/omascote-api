CREATE TABLE radar_team_profiles (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  legacy_profile_id text NOT NULL UNIQUE,
  account_reference text,
  public_slug text UNIQUE,
  status text NOT NULL DEFAULT 'draft'
    CHECK (status IN ('draft', 'pending_verification', 'active', 'paused', 'suspended')),
  instagram_handle text,
  instagram_verification_status text NOT NULL DEFAULT 'unverified'
    CHECK (instagram_verification_status IN ('unverified', 'pending', 'verified', 'rejected', 'expired')),
  city_ibge_code varchar(7),
  city_name text,
  state_code varchar(2),
  approximate_latitude numeric(9,6)
    CHECK (approximate_latitude IS NULL OR approximate_latitude BETWEEN -90 AND 90),
  approximate_longitude numeric(9,6)
    CHECK (approximate_longitude IS NULL OR approximate_longitude BETWEEN -180 AND 180),
  modalities text[] NOT NULL DEFAULT '{}',
  categories text[] NOT NULL DEFAULT '{}',
  declared_level text,
  travel_radius_km integer NOT NULL DEFAULT 25
    CHECK (travel_radius_km BETWEEN 1 AND 500),
  venue_preference text NOT NULL DEFAULT 'either'
    CHECK (venue_preference IN ('home', 'away', 'either')),
  availability_active boolean NOT NULL DEFAULT false,
  radar_terms_accepted_at timestamptz,
  suspended_at timestamptz,
  suspension_reason text,
  version integer NOT NULL DEFAULT 1 CHECK (version > 0),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX radar_team_profiles_discovery_idx
  ON radar_team_profiles (city_ibge_code, status, availability_active);

CREATE TABLE team_verifications (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  team_id uuid NOT NULL REFERENCES radar_team_profiles(id) ON DELETE CASCADE,
  method text NOT NULL CHECK (method IN ('instagram_bio_code', 'manual_review', 'profile_print_import')),
  status text NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending', 'verified', 'rejected', 'expired', 'cancelled')),
  challenge_hash char(64),
  challenge_expires_at timestamptz,
  attempt_count integer NOT NULL DEFAULT 0 CHECK (attempt_count >= 0),
  ai_draft jsonb,
  human_decision_by text,
  human_decision_reason text,
  evidence_delete_after timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  decided_at timestamptz
);

CREATE INDEX team_verifications_team_status_idx
  ON team_verifications (team_id, status, created_at DESC);

CREATE TABLE friendly_availabilities (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  team_id uuid NOT NULL REFERENCES radar_team_profiles(id) ON DELETE CASCADE,
  modality text NOT NULL,
  category text NOT NULL,
  declared_level text,
  starts_at timestamptz NOT NULL,
  ends_at timestamptz NOT NULL,
  recurrence jsonb,
  city_ibge_code varchar(7) NOT NULL,
  travel_radius_km integer NOT NULL CHECK (travel_radius_km BETWEEN 1 AND 500),
  venue_preference text NOT NULL CHECK (venue_preference IN ('home', 'away', 'either')),
  notes text CHECK (notes IS NULL OR char_length(notes) <= 1000),
  status text NOT NULL DEFAULT 'active'
    CHECK (status IN ('active', 'paused', 'expired', 'cancelled')),
  version integer NOT NULL DEFAULT 1 CHECK (version > 0),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CHECK (ends_at > starts_at)
);

CREATE INDEX friendly_availabilities_search_idx
  ON friendly_availabilities (city_ibge_code, modality, category, status, starts_at, ends_at);

CREATE TABLE friendly_invitations (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  public_id uuid NOT NULL DEFAULT gen_random_uuid() UNIQUE,
  requester_team_id uuid NOT NULL REFERENCES radar_team_profiles(id),
  invited_team_id uuid NOT NULL REFERENCES radar_team_profiles(id),
  availability_id uuid REFERENCES friendly_availabilities(id) ON DELETE SET NULL,
  state text NOT NULL DEFAULT 'pending'
    CHECK (state IN ('pending', 'counter_proposed', 'accepted', 'declined', 'cancelled', 'expired')),
  version integer NOT NULL DEFAULT 1 CHECK (version > 0),
  proposal jsonb NOT NULL,
  proposal_hash char(64) NOT NULL CHECK (proposal_hash ~ '^[0-9a-f]{64}$'),
  idempotency_key varchar(200) NOT NULL,
  idempotency_payload_hash char(64) NOT NULL
    CHECK (idempotency_payload_hash ~ '^[0-9a-f]{64}$'),
  expires_at timestamptz NOT NULL,
  accepted_at timestamptz,
  declined_at timestamptz,
  cancelled_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CHECK (requester_team_id <> invited_team_id),
  UNIQUE (requester_team_id, idempotency_key)
);

CREATE UNIQUE INDEX friendly_invitations_open_equivalent_idx
  ON friendly_invitations (
    LEAST(requester_team_id::text, invited_team_id::text),
    GREATEST(requester_team_id::text, invited_team_id::text),
    proposal_hash
  )
  WHERE state IN ('pending', 'counter_proposed');

CREATE INDEX friendly_invitations_inbox_idx
  ON friendly_invitations (invited_team_id, state, created_at DESC);

CREATE INDEX friendly_invitations_outbox_idx
  ON friendly_invitations (requester_team_id, state, created_at DESC);

CREATE TABLE friendly_matches (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  public_id uuid NOT NULL DEFAULT gen_random_uuid() UNIQUE,
  invitation_id uuid NOT NULL UNIQUE REFERENCES friendly_invitations(id),
  team_a_id uuid NOT NULL REFERENCES radar_team_profiles(id),
  team_b_id uuid NOT NULL REFERENCES radar_team_profiles(id),
  team_a_snapshot jsonb NOT NULL,
  team_b_snapshot jsonb NOT NULL,
  scheduled_at timestamptz NOT NULL,
  venue_details_encrypted text,
  occurrence_state text NOT NULL DEFAULT 'scheduled'
    CHECK (occurrence_state IN ('scheduled', 'awaiting_occurrence', 'played', 'cancelled', 'no_show', 'disputed')),
  result_state text NOT NULL DEFAULT 'empty'
    CHECK (result_state IN ('empty', 'waiting_other', 'verified', 'divergent', 'corrected', 'disputed')),
  verified_team_a_goals smallint CHECK (verified_team_a_goals BETWEEN 0 AND 99),
  verified_team_b_goals smallint CHECK (verified_team_b_goals BETWEEN 0 AND 99),
  verified_result_at timestamptz,
  version integer NOT NULL DEFAULT 1 CHECK (version > 0),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CHECK (team_a_id <> team_b_id),
  CHECK (
    (result_state = 'verified' AND verified_team_a_goals IS NOT NULL AND verified_team_b_goals IS NOT NULL)
    OR
    (result_state <> 'verified' AND verified_team_a_goals IS NULL AND verified_team_b_goals IS NULL)
  )
);

CREATE INDEX friendly_matches_team_a_idx ON friendly_matches (team_a_id, scheduled_at DESC);
CREATE INDEX friendly_matches_team_b_idx ON friendly_matches (team_b_id, scheduled_at DESC);

CREATE TABLE match_occurrence_confirmations (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  match_id uuid NOT NULL REFERENCES friendly_matches(id) ON DELETE CASCADE,
  confirming_team_id uuid NOT NULL REFERENCES radar_team_profiles(id),
  happened boolean NOT NULL,
  version integer NOT NULL DEFAULT 1 CHECK (version > 0),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (match_id, confirming_team_id)
);

CREATE TABLE match_result_submissions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  match_id uuid NOT NULL REFERENCES friendly_matches(id) ON DELETE CASCADE,
  submitting_team_id uuid NOT NULL REFERENCES radar_team_profiles(id),
  team_a_goals smallint NOT NULL CHECK (team_a_goals BETWEEN 0 AND 99),
  team_b_goals smallint NOT NULL CHECK (team_b_goals BETWEEN 0 AND 99),
  version integer NOT NULL CHECK (version > 0),
  submission_hash char(64) NOT NULL CHECK (submission_hash ~ '^[0-9a-f]{64}$'),
  show_on_own_profile boolean NOT NULL DEFAULT false,
  evidence_reference text,
  is_current boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (match_id, submitting_team_id, version),
  UNIQUE (id, version, submission_hash)
);

CREATE UNIQUE INDEX match_result_submissions_current_idx
  ON match_result_submissions (match_id, submitting_team_id)
  WHERE is_current;

CREATE TABLE match_result_confirmations (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  match_id uuid NOT NULL REFERENCES friendly_matches(id) ON DELETE CASCADE,
  confirming_team_id uuid NOT NULL REFERENCES radar_team_profiles(id),
  submission_id uuid NOT NULL,
  submission_version integer NOT NULL,
  submission_hash char(64) NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (match_id, confirming_team_id),
  FOREIGN KEY (submission_id, submission_version, submission_hash)
    REFERENCES match_result_submissions(id, version, submission_hash)
);

CREATE TABLE team_reviews (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  match_id uuid NOT NULL REFERENCES friendly_matches(id) ON DELETE CASCADE,
  reviewer_team_id uuid NOT NULL REFERENCES radar_team_profiles(id),
  reviewed_team_id uuid NOT NULL REFERENCES radar_team_profiles(id),
  fair_play smallint NOT NULL CHECK (fair_play BETWEEN 1 AND 5),
  punctuality smallint NOT NULL CHECK (punctuality BETWEEN 1 AND 5),
  organization smallint NOT NULL CHECK (organization BETWEEN 1 AND 5),
  perceived_level smallint NOT NULL CHECK (perceived_level BETWEEN 1 AND 5),
  would_play_again boolean NOT NULL,
  publication_state text NOT NULL DEFAULT 'blind'
    CHECK (publication_state IN ('blind', 'eligible', 'published', 'withheld', 'moderation')),
  idempotency_key varchar(200) NOT NULL,
  idempotency_payload_hash char(64) NOT NULL
    CHECK (idempotency_payload_hash ~ '^[0-9a-f]{64}$'),
  created_at timestamptz NOT NULL DEFAULT now(),
  published_at timestamptz,
  CHECK (reviewer_team_id <> reviewed_team_id),
  UNIQUE (match_id, reviewer_team_id),
  UNIQUE (reviewer_team_id, idempotency_key)
);

CREATE TABLE team_incident_reports (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  public_id uuid NOT NULL DEFAULT gen_random_uuid() UNIQUE,
  match_id uuid REFERENCES friendly_matches(id) ON DELETE SET NULL,
  reporter_team_id uuid NOT NULL REFERENCES radar_team_profiles(id),
  reported_team_id uuid NOT NULL REFERENCES radar_team_profiles(id),
  category text NOT NULL,
  private_description text NOT NULL CHECK (char_length(private_description) BETWEEN 10 AND 4000),
  status text NOT NULL DEFAULT 'open'
    CHECK (status IN ('open', 'triage', 'investigating', 'resolved', 'dismissed', 'appealed')),
  moderation_due_at timestamptz,
  resolution text,
  created_at timestamptz NOT NULL DEFAULT now(),
  resolved_at timestamptz,
  CHECK (reporter_team_id <> reported_team_id)
);

CREATE TABLE team_blocks (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  blocker_team_id uuid NOT NULL REFERENCES radar_team_profiles(id) ON DELETE CASCADE,
  blocked_team_id uuid NOT NULL REFERENCES radar_team_profiles(id) ON DELETE CASCADE,
  private_reason text,
  created_at timestamptz NOT NULL DEFAULT now(),
  CHECK (blocker_team_id <> blocked_team_id),
  UNIQUE (blocker_team_id, blocked_team_id)
);

CREATE TABLE match_audit_events (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  match_id uuid REFERENCES friendly_matches(id) ON DELETE SET NULL,
  invitation_id uuid REFERENCES friendly_invitations(id) ON DELETE SET NULL,
  actor_team_id uuid REFERENCES radar_team_profiles(id) ON DELETE SET NULL,
  actor_reference text,
  event_type text NOT NULL,
  entity_version integer,
  payload jsonb NOT NULL DEFAULT '{}',
  request_id text,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX match_audit_events_match_idx ON match_audit_events (match_id, created_at);
CREATE INDEX match_audit_events_invitation_idx ON match_audit_events (invitation_id, created_at);

CREATE TABLE notifications (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  public_id uuid NOT NULL DEFAULT gen_random_uuid() UNIQUE,
  recipient_team_id uuid NOT NULL REFERENCES radar_team_profiles(id) ON DELETE CASCADE,
  event_type text NOT NULL,
  entity_type text NOT NULL,
  entity_public_id uuid,
  payload jsonb NOT NULL DEFAULT '{}',
  deduplication_key text NOT NULL,
  read_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (recipient_team_id, deduplication_key)
);

CREATE INDEX notifications_inbox_idx
  ON notifications (recipient_team_id, read_at, created_at DESC);

CREATE FUNCTION radar_reject_audit_mutation()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  RAISE EXCEPTION 'match_audit_events is append-only';
END;
$$;

CREATE TRIGGER match_audit_events_append_only
BEFORE UPDATE OR DELETE ON match_audit_events
FOR EACH ROW EXECUTE FUNCTION radar_reject_audit_mutation();

CREATE FUNCTION radar_protect_verified_result()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF OLD.result_state = 'verified' AND (
    NEW.result_state <> OLD.result_state
    OR NEW.verified_team_a_goals IS DISTINCT FROM OLD.verified_team_a_goals
    OR NEW.verified_team_b_goals IS DISTINCT FROM OLD.verified_team_b_goals
  ) THEN
    RAISE EXCEPTION 'verified result is immutable; use an audited correction workflow';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER friendly_matches_verified_result_immutable
BEFORE UPDATE ON friendly_matches
FOR EACH ROW EXECUTE FUNCTION radar_protect_verified_result();
