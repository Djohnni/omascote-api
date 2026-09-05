CREATE TABLE weekly_plan_payment_attempts (
  id varchar(24) PRIMARY KEY CHECK (id ~ '^[0-9a-f]{24}$'),
  customer_key varchar(120) NOT NULL CHECK (char_length(customer_key) BETWEEN 8 AND 120),
  plan_code varchar(32) NOT NULL CHECK (plan_code IN ('semanal_1', 'semanal_2', 'semanal_4', 'semanal_6')),
  plan_name varchar(80) NOT NULL,
  weekly_limit integer NOT NULL CHECK (weekly_limit IN (1, 2, 4, 6)),
  cycle_limit integer NOT NULL CHECK (cycle_limit = weekly_limit * 4),
  cycle_days integer NOT NULL DEFAULT 30 CHECK (cycle_days = 30),
  expected_amount_cents integer NOT NULL CHECK (expected_amount_cents > 0),
  expected_currency char(3) NOT NULL DEFAULT 'BRL' CHECK (expected_currency = 'BRL'),
  external_reference varchar(80) NOT NULL UNIQUE,
  idempotency_key varchar(120) NOT NULL UNIQUE,
  client_request_id varchar(180) NOT NULL,
  mp_order_id varchar(120) UNIQUE,
  mp_payment_id varchar(120) UNIQUE,
  status varchar(24) NOT NULL CHECK (status IN ('creating', 'pending', 'confirmed', 'expired', 'cancelled', 'rejected', 'divergent', 'failed', 'refunded', 'charged_back')),
  provider_order_status varchar(40),
  provider_payment_status varchar(40),
  provider_status_detail varchar(80),
  created_at timestamptz NOT NULL,
  updated_at timestamptz NOT NULL,
  expires_at timestamptz NOT NULL,
  confirmed_at timestamptz,
  CHECK (expires_at > created_at)
);

CREATE UNIQUE INDEX weekly_plan_payment_client_request_idx
  ON weekly_plan_payment_attempts(customer_key, client_request_id);

CREATE UNIQUE INDEX weekly_plan_one_open_payment_idx
  ON weekly_plan_payment_attempts(customer_key)
  WHERE status IN ('creating', 'pending');

CREATE INDEX weekly_plan_payment_customer_idx
  ON weekly_plan_payment_attempts(customer_key, created_at DESC);

CREATE TABLE weekly_plan_subscriptions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  customer_key varchar(120) NOT NULL CHECK (char_length(customer_key) BETWEEN 8 AND 120),
  payment_attempt_id varchar(24) NOT NULL UNIQUE REFERENCES weekly_plan_payment_attempts(id),
  plan_code varchar(32) NOT NULL CHECK (plan_code IN ('semanal_1', 'semanal_2', 'semanal_4', 'semanal_6')),
  plan_name varchar(80) NOT NULL,
  weekly_limit integer NOT NULL CHECK (weekly_limit IN (1, 2, 4, 6)),
  cycle_limit integer NOT NULL CHECK (cycle_limit = weekly_limit * 4),
  cycle_days integer NOT NULL DEFAULT 30 CHECK (cycle_days = 30),
  price_cents integer NOT NULL CHECK (price_cents > 0),
  starts_at timestamptz NOT NULL,
  ends_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL,
  revoked_at timestamptz,
  revocation_reason varchar(40),
  CHECK ((revoked_at IS NULL AND revocation_reason IS NULL) OR (revoked_at IS NOT NULL AND revocation_reason IS NOT NULL)),
  CHECK (ends_at > starts_at)
);

CREATE INDEX weekly_plan_subscription_customer_cycle_idx
  ON weekly_plan_subscriptions(customer_key, starts_at DESC, ends_at DESC);

CREATE TABLE weekly_plan_usage (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  subscription_id uuid NOT NULL REFERENCES weekly_plan_subscriptions(id),
  customer_key varchar(120) NOT NULL CHECK (char_length(customer_key) BETWEEN 8 AND 120),
  order_id varchar(120) NOT NULL UNIQUE,
  client_request_id varchar(180) NOT NULL,
  payload_hash char(64) NOT NULL CHECK (payload_hash ~ '^[0-9a-f]{64}$'),
  product_id varchar(80) NOT NULL,
  week_index integer NOT NULL CHECK (week_index BETWEEN 0 AND 3),
  reserved_at timestamptz NOT NULL,
  released_at timestamptz,
  release_reason varchar(120),
  CHECK ((released_at IS NULL AND release_reason IS NULL) OR (released_at IS NOT NULL AND release_reason IS NOT NULL))
);

CREATE INDEX weekly_plan_usage_quota_idx
  ON weekly_plan_usage(subscription_id, week_index, reserved_at)
  WHERE released_at IS NULL;

CREATE UNIQUE INDEX weekly_plan_usage_client_request_idx
  ON weekly_plan_usage(customer_key, client_request_id)
  WHERE released_at IS NULL;

CREATE TABLE weekly_plan_events (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  customer_key varchar(120) NOT NULL,
  event_type varchar(60) NOT NULL,
  payment_attempt_id varchar(24),
  subscription_id uuid,
  usage_id uuid,
  details jsonb NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(details) = 'object'),
  created_at timestamptz NOT NULL
);

CREATE INDEX weekly_plan_events_customer_idx
  ON weekly_plan_events(customer_key, created_at DESC, id DESC);
