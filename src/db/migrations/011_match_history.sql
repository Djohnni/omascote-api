CREATE INDEX friendly_matches_team_a_history_idx
  ON friendly_matches (team_a_id, scheduled_at DESC, public_id DESC)
  WHERE occurrence_state IN ('played', 'cancelled', 'no_show', 'disputed');

CREATE INDEX friendly_matches_team_b_history_idx
  ON friendly_matches (team_b_id, scheduled_at DESC, public_id DESC)
  WHERE occurrence_state IN ('played', 'cancelled', 'no_show', 'disputed');

CREATE INDEX friendly_matches_verified_history_idx
  ON friendly_matches (scheduled_at DESC, public_id DESC)
  WHERE occurrence_state = 'played' AND result_state = 'verified';

CREATE TABLE radar_match_history_rate_limits (
  scope_type text NOT NULL CHECK (scope_type IN ('account', 'team', 'ip')),
  scope_hash char(64) NOT NULL CHECK (scope_hash ~ '^[0-9a-f]{64}$'),
  window_started_at timestamptz NOT NULL,
  request_count integer NOT NULL DEFAULT 0 CHECK (request_count >= 0),
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (scope_type, scope_hash, window_started_at)
);

CREATE INDEX radar_match_history_rate_cleanup_idx
  ON radar_match_history_rate_limits (window_started_at);
