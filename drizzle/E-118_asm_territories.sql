-- E-118: asm_territories — ASM ↔ state/city mapping
--
-- BRD §0.8. Drives the Transfer-to-ASM dropdown (filtered by dealer's
-- city/state). Multiple ASMs can cover the same city; admin manages.
-- Out-of-territory handoffs require an override reason — flagged in
-- Admin Dashboard alert panel (BRD §0.11).

CREATE TABLE IF NOT EXISTS asm_territories (
  territory_id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  asm_id text NOT NULL,
  state varchar(100) NOT NULL,
  city varchar(100),
  active_from date,
  active_to date,
  created_at timestamptz DEFAULT NOW(),
  updated_at timestamptz DEFAULT NOW()
);

-- Drives the handoff dropdown lookup (state OR state+city)
CREATE INDEX IF NOT EXISTS asm_territories_state_city_idx
  ON asm_territories (state, city);

-- ASM-side reverse lookup (their assigned territories)
CREATE INDEX IF NOT EXISTS asm_territories_asm_idx
  ON asm_territories (asm_id);
