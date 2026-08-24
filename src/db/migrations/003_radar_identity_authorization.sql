ALTER TABLE radar_team_profiles
  ADD COLUMN public_id uuid NOT NULL DEFAULT gen_random_uuid();

ALTER TABLE radar_team_profiles
  ADD CONSTRAINT radar_team_profiles_public_id_key UNIQUE (public_id);

ALTER TABLE radar_team_profiles
  ADD CONSTRAINT radar_team_profiles_account_reference_nonempty
  CHECK (account_reference IS NULL OR btrim(account_reference) <> '');

CREATE UNIQUE INDEX radar_team_profiles_account_reference_key
  ON radar_team_profiles (account_reference)
  WHERE account_reference IS NOT NULL;

CREATE TABLE radar_profile_mutation_requests (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  account_reference text NOT NULL,
  idempotency_key varchar(200) NOT NULL,
  payload_hash char(64) NOT NULL CHECK (payload_hash ~ '^[0-9a-f]{64}$'),
  radar_team_id uuid NOT NULL REFERENCES radar_team_profiles(id) ON DELETE CASCADE,
  resulting_version integer NOT NULL CHECK (resulting_version > 0),
  result_snapshot jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (account_reference, idempotency_key)
);

CREATE INDEX radar_profile_mutation_requests_team_idx
  ON radar_profile_mutation_requests (radar_team_id, created_at DESC);

CREATE FUNCTION radar_reject_profile_mutation_request_change()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  RAISE EXCEPTION 'radar_profile_mutation_requests is append-only';
END;
$$;

CREATE TRIGGER radar_profile_mutation_requests_append_only
BEFORE UPDATE OR DELETE ON radar_profile_mutation_requests
FOR EACH ROW EXECUTE FUNCTION radar_reject_profile_mutation_request_change();
