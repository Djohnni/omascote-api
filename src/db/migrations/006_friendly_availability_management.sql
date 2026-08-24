ALTER TABLE friendly_availabilities
  ADD COLUMN public_id uuid NOT NULL DEFAULT gen_random_uuid(),
  ADD COLUMN schedule_hash char(64),
  ADD COLUMN city_name text,
  ADD COLUMN state_code char(2);

UPDATE friendly_availabilities availability
SET city_name = team.city_name,
    state_code = team.state_code,
    schedule_hash = encode(
      sha256(convert_to('legacy-friendly-availability:' || availability.id::text, 'UTF8')),
      'hex'
    )
FROM radar_team_profiles team
WHERE team.id = availability.team_id;

UPDATE friendly_availabilities
SET schedule_hash = encode(
  sha256(convert_to('legacy-friendly-availability:' || id::text, 'UTF8')),
  'hex'
)
WHERE schedule_hash IS NULL;

ALTER TABLE friendly_availabilities
  ALTER COLUMN schedule_hash SET NOT NULL,
  ADD CONSTRAINT friendly_availabilities_public_id_key UNIQUE (public_id),
  ADD CONSTRAINT friendly_availabilities_schedule_hash_format
    CHECK (schedule_hash ~ '^[0-9a-f]{64}$'),
  ADD CONSTRAINT friendly_availabilities_modality_nonempty
    CHECK (btrim(modality) <> ''),
  ADD CONSTRAINT friendly_availabilities_category_nonempty
    CHECK (btrim(category) <> ''),
  ADD CONSTRAINT friendly_availabilities_declared_level_nonempty
    CHECK (declared_level IS NOT NULL AND btrim(declared_level) <> '') NOT VALID,
  ADD CONSTRAINT friendly_availabilities_city_name_nonempty
    CHECK (city_name IS NOT NULL AND btrim(city_name) <> '') NOT VALID,
  ADD CONSTRAINT friendly_availabilities_state_code_format
    CHECK (state_code IS NOT NULL AND state_code ~ '^[A-Z]{2}$') NOT VALID,
  ADD CONSTRAINT friendly_availabilities_duration_limited
    CHECK (ends_at <= starts_at + interval '24 hours'),
  ADD CONSTRAINT friendly_availabilities_recurrence_shape
    CHECK (
      recurrence IS NULL
      OR (
        jsonb_typeof(recurrence) = 'object'
        AND recurrence ->> 'frequency' = 'weekly'
        AND jsonb_typeof(recurrence -> 'days_of_week') = 'array'
        AND recurrence ->> 'start_time' ~ '^(?:[01][0-9]|2[0-3]):[0-5][0-9]$'
        AND recurrence ->> 'end_time' ~ '^(?:[01][0-9]|2[0-3]):[0-5][0-9]$'
        AND recurrence ->> 'until' ~ '^\d{4}-\d{2}-\d{2}$'
        AND recurrence ->> 'time_zone' = 'America/Sao_Paulo'
      )
    );

CREATE UNIQUE INDEX friendly_availabilities_open_schedule_key
  ON friendly_availabilities (team_id, schedule_hash)
  WHERE status IN ('active', 'paused');

CREATE INDEX friendly_availabilities_team_state_period_idx
  ON friendly_availabilities (team_id, status, starts_at, public_id);

CREATE INDEX friendly_availabilities_expiration_idx
  ON friendly_availabilities (ends_at, team_id)
  WHERE status IN ('active', 'paused');

CREATE INDEX friendly_availabilities_future_discovery_idx
  ON friendly_availabilities (
    city_ibge_code, modality, category, declared_level, status, starts_at, public_id
  );

CREATE TABLE radar_availability_mutation_requests (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  account_reference text NOT NULL CHECK (btrim(account_reference) <> ''),
  operation text NOT NULL CHECK (operation IN ('create', 'patch', 'delete')),
  idempotency_key varchar(200) NOT NULL,
  payload_hash char(64) NOT NULL CHECK (payload_hash ~ '^[0-9a-f]{64}$'),
  radar_team_id uuid NOT NULL REFERENCES radar_team_profiles(id),
  availability_id uuid NOT NULL REFERENCES friendly_availabilities(id),
  resulting_version integer NOT NULL CHECK (resulting_version > 0),
  result_snapshot jsonb NOT NULL CHECK (jsonb_typeof(result_snapshot) = 'object'),
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (account_reference, operation, idempotency_key)
);

CREATE INDEX radar_availability_mutation_requests_team_idx
  ON radar_availability_mutation_requests (radar_team_id, created_at DESC);

CREATE FUNCTION radar_guard_friendly_availability_change()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF NEW.id <> OLD.id
     OR NEW.public_id <> OLD.public_id
     OR NEW.team_id <> OLD.team_id
     OR NEW.created_at <> OLD.created_at THEN
    RAISE EXCEPTION 'friendly availability ownership is immutable';
  END IF;

  IF NEW.version <> OLD.version + 1 THEN
    RAISE EXCEPTION 'friendly availability version must increase by one';
  END IF;

  IF OLD.status IN ('cancelled', 'expired') AND NEW.status <> OLD.status THEN
    RAISE EXCEPTION 'terminal friendly availability cannot transition';
  END IF;

  IF OLD.status IN ('active', 'paused')
     AND NEW.status NOT IN ('active', 'paused', 'cancelled', 'expired') THEN
    RAISE EXCEPTION 'invalid friendly availability transition';
  END IF;

  RETURN NEW;
END;
$$;

CREATE TRIGGER radar_guard_friendly_availability_update
BEFORE UPDATE ON friendly_availabilities
FOR EACH ROW EXECUTE FUNCTION radar_guard_friendly_availability_change();

CREATE FUNCTION radar_reject_friendly_availability_delete()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  RAISE EXCEPTION 'friendly availabilities use logical cancellation';
END;
$$;

CREATE TRIGGER radar_friendly_availability_no_delete
BEFORE DELETE ON friendly_availabilities
FOR EACH ROW EXECUTE FUNCTION radar_reject_friendly_availability_delete();

CREATE FUNCTION radar_reject_availability_mutation_request_change()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  RAISE EXCEPTION 'radar_availability_mutation_requests is append-only';
END;
$$;

CREATE TRIGGER radar_availability_mutation_requests_append_only
BEFORE UPDATE OR DELETE ON radar_availability_mutation_requests
FOR EACH ROW EXECUTE FUNCTION radar_reject_availability_mutation_request_change();
