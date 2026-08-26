-- Participacao automatica: toda conta ativa de time entra no Radar por padrao.

ALTER TABLE radar_team_profiles
  ADD COLUMN IF NOT EXISTS radar_visible boolean NOT NULL DEFAULT true;

UPDATE radar_team_profiles
SET radar_visible = false,
    updated_at = now()
WHERE radar_departed_at IS NOT NULL
  AND radar_visible = true;

UPDATE radar_team_profiles
SET status = 'active',
    updated_at = now()
WHERE radar_departed_at IS NULL
  AND suspended_at IS NULL
  AND status IN ('draft', 'pending_verification', 'paused');

DROP INDEX IF EXISTS radar_team_profiles_safe_discovery_v2_idx;
DROP INDEX IF EXISTS radar_team_profiles_eligibility_discovery_v2_idx;

CREATE INDEX IF NOT EXISTS radar_team_profiles_automatic_discovery_idx
  ON radar_team_profiles (radar_visible, status, created_at, public_id)
  WHERE radar_departed_at IS NULL
    AND suspended_at IS NULL;

