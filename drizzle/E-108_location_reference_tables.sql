-- E-108 — canonical location reference tables: states, cities, city_aliases.
--
-- Moves the hardcoded CITY_ALIASES / CITY_TO_STATE maps from
-- src/lib/scraper-enrichment.ts into the database so:
--   1. The AI dialer region tree can JOIN against a canonical city list and
--      bucket junk values ("MARS Mysore Auto Rickshaw Service", "M28") under
--      "Unknown" instead of polluting the dropdown.
--   2. New cities can be added without a code deploy — the scraper's
--      auto-grow path (src/lib/locations/normalize.ts) inserts new rows
--      with source='google_places' when Google's addressComponents yields
--      a city in a known state.
--   3. Aliases (Mysore→Mysuru, Bangalore→Bengaluru) are first-class data,
--      not buried in TS.
--
-- Idempotent: every CREATE has IF NOT EXISTS, every INSERT has
-- ON CONFLICT DO NOTHING. Re-running the file is a no-op. Apply via pgAdmin
-- Query Tool against AWS Postgres.
--
-- Strictly additive — no DROP / no narrowing types. Does NOT touch
-- dealer_leads at all; downstream JOINs are coded against these new tables.

BEGIN;

-- ---------------------------------------------------------------------------
-- 1. states — 28 states + 8 union territories.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS states (
    code        text PRIMARY KEY,
    name        text NOT NULL UNIQUE,
    country     text NOT NULL DEFAULT 'IN',
    is_ut       boolean NOT NULL DEFAULT false,
    created_at  timestamp DEFAULT now()
);

INSERT INTO states (code, name, is_ut) VALUES
    ('AP', 'Andhra Pradesh',       false),
    ('AR', 'Arunachal Pradesh',    false),
    ('AS', 'Assam',                false),
    ('BR', 'Bihar',                false),
    ('CG', 'Chhattisgarh',         false),
    ('GA', 'Goa',                  false),
    ('GJ', 'Gujarat',              false),
    ('HR', 'Haryana',              false),
    ('HP', 'Himachal Pradesh',     false),
    ('JH', 'Jharkhand',            false),
    ('KA', 'Karnataka',            false),
    ('KL', 'Kerala',               false),
    ('MP', 'Madhya Pradesh',       false),
    ('MH', 'Maharashtra',          false),
    ('MN', 'Manipur',              false),
    ('ML', 'Meghalaya',            false),
    ('MZ', 'Mizoram',              false),
    ('NL', 'Nagaland',             false),
    ('OD', 'Odisha',               false),
    ('PB', 'Punjab',               false),
    ('RJ', 'Rajasthan',            false),
    ('SK', 'Sikkim',               false),
    ('TN', 'Tamil Nadu',           false),
    ('TS', 'Telangana',            false),
    ('TR', 'Tripura',              false),
    ('UP', 'Uttar Pradesh',        false),
    ('UK', 'Uttarakhand',          false),
    ('WB', 'West Bengal',          false),
    -- Union territories.
    ('AN', 'Andaman and Nicobar Islands',                   true),
    ('CH', 'Chandigarh',                                    true),
    ('DN', 'Dadra and Nagar Haveli and Daman and Diu',      true),
    ('DL', 'Delhi',                                         true),
    ('JK', 'Jammu and Kashmir',                             true),
    ('LA', 'Ladakh',                                        true),
    ('LD', 'Lakshadweep',                                   true),
    ('PY', 'Puducherry',                                    true)
ON CONFLICT (code) DO NOTHING;

-- ---------------------------------------------------------------------------
-- 2. cities — seeded from src/lib/scraper-enrichment.ts CITY_TO_STATE.
--    `source='seed'` distinguishes seed rows from rows auto-grown by the
--    scraper at promote time (`source='google_places'`).
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS cities (
    id          text PRIMARY KEY,
    name        text NOT NULL,
    state_code  text NOT NULL REFERENCES states(code),
    lat         double precision,
    lng         double precision,
    source      text DEFAULT 'seed',
    created_at  timestamp DEFAULT now(),
    UNIQUE (name, state_code)
);

CREATE INDEX IF NOT EXISTS idx_cities_name_lower ON cities (LOWER(name));
CREATE INDEX IF NOT EXISTS idx_cities_state_code ON cities (state_code);

INSERT INTO cities (id, name, state_code, source) VALUES
    -- Metros + state capitals.
    ('c_bengaluru_ka',         'Bengaluru',            'KA', 'seed'),
    ('c_delhi_dl',             'Delhi',                'DL', 'seed'),
    ('c_mumbai_mh',            'Mumbai',               'MH', 'seed'),
    ('c_chennai_tn',           'Chennai',              'TN', 'seed'),
    ('c_kolkata_wb',           'Kolkata',              'WB', 'seed'),
    ('c_hyderabad_ts',         'Hyderabad',            'TS', 'seed'),
    ('c_ahmedabad_gj',         'Ahmedabad',            'GJ', 'seed'),
    ('c_pune_mh',              'Pune',                 'MH', 'seed'),
    ('c_jaipur_rj',            'Jaipur',               'RJ', 'seed'),
    ('c_lucknow_up',           'Lucknow',              'UP', 'seed'),
    ('c_patna_br',             'Patna',                'BR', 'seed'),
    ('c_indore_mp',            'Indore',               'MP', 'seed'),
    ('c_bhopal_mp',            'Bhopal',               'MP', 'seed'),
    ('c_nagpur_mh',            'Nagpur',               'MH', 'seed'),
    ('c_guwahati_as',          'Guwahati',             'AS', 'seed'),
    -- NCR satellites.
    ('c_ghaziabad_up',         'Ghaziabad',            'UP', 'seed'),
    ('c_noida_up',             'Noida',                'UP', 'seed'),
    ('c_greater_noida_up',     'Greater Noida',        'UP', 'seed'),
    ('c_gurugram_hr',          'Gurugram',             'HR', 'seed'),
    ('c_faridabad_hr',         'Faridabad',            'HR', 'seed'),
    -- Maharashtra tier-2.
    ('c_nashik_mh',            'Nashik',               'MH', 'seed'),
    ('c_thane_mh',             'Thane',                'MH', 'seed'),
    ('c_navi_mumbai_mh',       'Navi Mumbai',          'MH', 'seed'),
    -- Gujarat tier-2.
    ('c_surat_gj',             'Surat',                'GJ', 'seed'),
    ('c_vadodara_gj',          'Vadodara',             'GJ', 'seed'),
    ('c_rajkot_gj',            'Rajkot',               'GJ', 'seed'),
    -- Tamil Nadu.
    ('c_coimbatore_tn',        'Coimbatore',           'TN', 'seed'),
    ('c_madurai_tn',           'Madurai',              'TN', 'seed'),
    -- Uttar Pradesh tier-2.
    ('c_kanpur_up',            'Kanpur',               'UP', 'seed'),
    ('c_agra_up',              'Agra',                 'UP', 'seed'),
    ('c_varanasi_up',          'Varanasi',             'UP', 'seed'),
    ('c_prayagraj_up',         'Prayagraj',            'UP', 'seed'),
    ('c_meerut_up',            'Meerut',               'UP', 'seed'),
    -- Karnataka tier-2.
    ('c_mysuru_ka',            'Mysuru',               'KA', 'seed'),
    ('c_mangaluru_ka',         'Mangaluru',            'KA', 'seed'),
    ('c_hubballi_ka',          'Hubballi',             'KA', 'seed'),
    -- Andhra Pradesh.
    ('c_visakhapatnam_ap',     'Visakhapatnam',        'AP', 'seed'),
    ('c_vijayawada_ap',        'Vijayawada',           'AP', 'seed'),
    -- Kerala.
    ('c_kochi_kl',             'Kochi',                'KL', 'seed'),
    ('c_thiruvananthapuram_kl','Thiruvananthapuram',   'KL', 'seed'),
    ('c_kozhikode_kl',         'Kozhikode',            'KL', 'seed'),
    -- Punjab + Chandigarh.
    ('c_chandigarh_ch',        'Chandigarh',           'CH', 'seed'),
    ('c_ludhiana_pb',          'Ludhiana',             'PB', 'seed'),
    ('c_amritsar_pb',          'Amritsar',             'PB', 'seed'),
    -- Jharkhand.
    ('c_ranchi_jh',            'Ranchi',               'JH', 'seed'),
    ('c_jamshedpur_jh',        'Jamshedpur',           'JH', 'seed'),
    -- Chhattisgarh.
    ('c_raipur_cg',            'Raipur',               'CG', 'seed'),
    -- Odisha.
    ('c_bhubaneswar_od',       'Bhubaneswar',          'OD', 'seed'),
    ('c_cuttack_od',           'Cuttack',              'OD', 'seed'),
    -- Uttarakhand.
    ('c_dehradun_uk',          'Dehradun',             'UK', 'seed')
ON CONFLICT (id) DO NOTHING;

-- ---------------------------------------------------------------------------
-- 3. city_aliases — every alias resolves to a canonical cities.id.
--    Includes self-aliases (lowercase canonical name maps back to its own
--    city) so the AI dialer region tree can do a single LEFT JOIN against
--    city_aliases without a separate direct-name lookup branch.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS city_aliases (
    alias_lower text PRIMARY KEY,
    city_id     text NOT NULL REFERENCES cities(id),
    created_at  timestamp DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_city_aliases_city_id ON city_aliases (city_id);

INSERT INTO city_aliases (alias_lower, city_id) VALUES
    -- Bengaluru.
    ('bengaluru',           'c_bengaluru_ka'),
    ('bangalore',           'c_bengaluru_ka'),
    ('blr',                 'c_bengaluru_ka'),
    -- Delhi.
    ('delhi',               'c_delhi_dl'),
    ('new delhi',           'c_delhi_dl'),
    ('dl',                  'c_delhi_dl'),
    -- Mumbai.
    ('mumbai',              'c_mumbai_mh'),
    ('bombay',              'c_mumbai_mh'),
    ('mum',                 'c_mumbai_mh'),
    -- Chennai.
    ('chennai',             'c_chennai_tn'),
    ('madras',              'c_chennai_tn'),
    ('chn',                 'c_chennai_tn'),
    -- Kolkata.
    ('kolkata',             'c_kolkata_wb'),
    ('calcutta',            'c_kolkata_wb'),
    ('kol',                 'c_kolkata_wb'),
    -- Hyderabad.
    ('hyderabad',           'c_hyderabad_ts'),
    ('hyd',                 'c_hyderabad_ts'),
    -- Ahmedabad.
    ('ahmedabad',           'c_ahmedabad_gj'),
    ('ahd',                 'c_ahmedabad_gj'),
    ('amd',                 'c_ahmedabad_gj'),
    -- Pune.
    ('pune',                'c_pune_mh'),
    ('pnq',                 'c_pune_mh'),
    -- Jaipur.
    ('jaipur',              'c_jaipur_rj'),
    ('jpr',                 'c_jaipur_rj'),
    -- Lucknow.
    ('lucknow',             'c_lucknow_up'),
    ('lko',                 'c_lucknow_up'),
    -- Patna.
    ('patna',               'c_patna_br'),
    ('pat',                 'c_patna_br'),
    -- Indore.
    ('indore',              'c_indore_mp'),
    ('ind',                 'c_indore_mp'),
    -- Bhopal.
    ('bhopal',              'c_bhopal_mp'),
    ('bpl',                 'c_bhopal_mp'),
    -- Nagpur.
    ('nagpur',              'c_nagpur_mh'),
    ('ngp',                 'c_nagpur_mh'),
    -- Guwahati.
    ('guwahati',            'c_guwahati_as'),
    ('ghy',                 'c_guwahati_as'),
    -- NCR satellites.
    ('ghaziabad',           'c_ghaziabad_up'),
    ('noida',               'c_noida_up'),
    ('greater noida',       'c_greater_noida_up'),
    ('gurugram',            'c_gurugram_hr'),
    ('gurgaon',             'c_gurugram_hr'),
    ('faridabad',           'c_faridabad_hr'),
    -- Maharashtra tier-2.
    ('nashik',              'c_nashik_mh'),
    ('thane',               'c_thane_mh'),
    ('navi mumbai',         'c_navi_mumbai_mh'),
    -- Gujarat tier-2.
    ('surat',               'c_surat_gj'),
    ('vadodara',            'c_vadodara_gj'),
    ('baroda',              'c_vadodara_gj'),
    ('rajkot',              'c_rajkot_gj'),
    -- Tamil Nadu.
    ('coimbatore',          'c_coimbatore_tn'),
    ('madurai',             'c_madurai_tn'),
    -- Uttar Pradesh tier-2.
    ('kanpur',              'c_kanpur_up'),
    ('agra',                'c_agra_up'),
    ('varanasi',            'c_varanasi_up'),
    ('prayagraj',           'c_prayagraj_up'),
    ('allahabad',           'c_prayagraj_up'),
    ('meerut',              'c_meerut_up'),
    -- Karnataka tier-2 (Mysore→Mysuru is the canonical demo case).
    ('mysuru',              'c_mysuru_ka'),
    ('mysore',              'c_mysuru_ka'),
    ('mangaluru',           'c_mangaluru_ka'),
    ('mangalore',           'c_mangaluru_ka'),
    ('hubballi',            'c_hubballi_ka'),
    ('hubli',               'c_hubballi_ka'),
    -- Andhra Pradesh.
    ('visakhapatnam',       'c_visakhapatnam_ap'),
    ('vizag',               'c_visakhapatnam_ap'),
    ('vijayawada',          'c_vijayawada_ap'),
    -- Kerala.
    ('kochi',               'c_kochi_kl'),
    ('cochin',              'c_kochi_kl'),
    ('thiruvananthapuram',  'c_thiruvananthapuram_kl'),
    ('trivandrum',          'c_thiruvananthapuram_kl'),
    ('kozhikode',           'c_kozhikode_kl'),
    ('calicut',             'c_kozhikode_kl'),
    -- Punjab + Chandigarh.
    ('chandigarh',          'c_chandigarh_ch'),
    ('ludhiana',            'c_ludhiana_pb'),
    ('amritsar',            'c_amritsar_pb'),
    -- Jharkhand.
    ('ranchi',              'c_ranchi_jh'),
    ('jamshedpur',          'c_jamshedpur_jh'),
    -- Chhattisgarh.
    ('raipur',              'c_raipur_cg'),
    -- Odisha.
    ('bhubaneswar',         'c_bhubaneswar_od'),
    ('cuttack',             'c_cuttack_od'),
    -- Uttarakhand.
    ('dehradun',            'c_dehradun_uk')
ON CONFLICT (alias_lower) DO NOTHING;

COMMIT;

-- Verification:
--   SELECT COUNT(*) FROM states;        -- expect 36 (28 + 8 UTs)
--   SELECT COUNT(*) FROM cities;        -- expect 50
--   SELECT COUNT(*) FROM city_aliases;  -- expect 80+
--   SELECT c.name, s.name FROM city_aliases ca
--     JOIN cities c ON c.id = ca.city_id
--     JOIN states s ON s.code = c.state_code
--    WHERE ca.alias_lower IN ('mysore','bangalore','bombay','allahabad');
--   -- expect: Mysuru/Karnataka, Bengaluru/Karnataka, Mumbai/Maharashtra, Prayagraj/Uttar Pradesh
