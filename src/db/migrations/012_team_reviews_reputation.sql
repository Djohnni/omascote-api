DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public'
      AND table_name = 'team_reviews'
      AND column_name = 'perceived_level'
  ) AND NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public'
      AND table_name = 'team_reviews'
      AND column_name = 'communication'
  ) THEN
    ALTER TABLE team_reviews RENAME COLUMN perceived_level TO communication;
  END IF;
END;
$$;

CREATE INDEX team_reviews_reviewed_team_created_idx
  ON team_reviews (reviewed_team_id, created_at DESC);

CREATE TABLE team_reputation_aggregates (
  team_id uuid PRIMARY KEY REFERENCES radar_team_profiles(id),
  verified_review_count integer NOT NULL DEFAULT 0 CHECK (verified_review_count >= 0),
  punctuality_sum integer NOT NULL DEFAULT 0 CHECK (punctuality_sum >= 0),
  organization_sum integer NOT NULL DEFAULT 0 CHECK (organization_sum >= 0),
  communication_sum integer NOT NULL DEFAULT 0 CHECK (communication_sum >= 0),
  fair_play_sum integer NOT NULL DEFAULT 0 CHECK (fair_play_sum >= 0),
  would_play_again_count integer NOT NULL DEFAULT 0 CHECK (would_play_again_count >= 0),
  version integer NOT NULL DEFAULT 1 CHECK (version > 0),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CHECK (would_play_again_count <= verified_review_count),
  CHECK (punctuality_sum <= verified_review_count * 5),
  CHECK (organization_sum <= verified_review_count * 5),
  CHECK (communication_sum <= verified_review_count * 5),
  CHECK (fair_play_sum <= verified_review_count * 5)
);

CREATE TABLE team_reputation_applications (
  review_id uuid PRIMARY KEY REFERENCES team_reviews(id),
  reviewed_team_id uuid NOT NULL REFERENCES radar_team_profiles(id),
  applied_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX team_reputation_applications_team_idx
  ON team_reputation_applications (reviewed_team_id, applied_at DESC);

CREATE FUNCTION radar_guard_team_review_insert()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  match_row friendly_matches%ROWTYPE;
BEGIN
  SELECT * INTO match_row
  FROM friendly_matches
  WHERE id = NEW.match_id
  FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'friendly match not found';
  END IF;
  IF match_row.occurrence_state <> 'played' OR match_row.result_state <> 'verified' THEN
    RAISE EXCEPTION 'team review requires an official verified result';
  END IF;
  IF NEW.reviewer_team_id NOT IN (match_row.team_a_id, match_row.team_b_id) THEN
    RAISE EXCEPTION 'reviewer is not a match participant';
  END IF;
  IF NEW.reviewed_team_id NOT IN (match_row.team_a_id, match_row.team_b_id) THEN
    RAISE EXCEPTION 'reviewed team is not a match participant';
  END IF;
  IF NEW.reviewer_team_id = NEW.reviewed_team_id THEN
    RAISE EXCEPTION 'team cannot review itself';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER radar_guard_team_review_insert_trigger
BEFORE INSERT ON team_reviews
FOR EACH ROW EXECUTE FUNCTION radar_guard_team_review_insert();

CREATE FUNCTION radar_reject_team_review_change()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  RAISE EXCEPTION 'team reviews are immutable';
END;
$$;

CREATE TRIGGER radar_team_reviews_immutable
BEFORE UPDATE OR DELETE ON team_reviews
FOR EACH ROW EXECUTE FUNCTION radar_reject_team_review_change();

CREATE TRIGGER radar_team_reputation_applications_append_only
BEFORE UPDATE OR DELETE ON team_reputation_applications
FOR EACH ROW EXECUTE FUNCTION radar_reject_team_review_change();
