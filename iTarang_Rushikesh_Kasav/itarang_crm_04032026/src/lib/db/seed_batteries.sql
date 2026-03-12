
INSERT INTO product_catalog (id, hsn_code, asset_category, asset_type, model_type, is_serialized, warranty_months, status)
VALUES
('PCAT-20250117-BAT-001', '85076000', '3W', 'Battery', 'With IOT 51.2 V-105AH', true, 36, 'active'),
('PCAT-20250117-BAT-002', '85076000', '3W', 'Battery', 'Without IOT 51.2 V-105AH', true, 36, 'active'),
('PCAT-20250117-BAT-003', '85076000', '3W', 'Battery', 'With IOT 48 V-40AH', true, 36, 'active'),
('PCAT-20250117-BAT-004', '85076000', '3W', 'Battery', 'Without IOT 48 V-40AH', true, 36, 'active'),
('PCAT-20250117-BAT-005', '85076000', '3W', 'Battery', 'With IOT 60 V-30AH', true, 36, 'active'),
('PCAT-20250117-BAT-006', '85076000', '3W', 'Battery', 'Without IOT 60 V-30AH', true, 36, 'active'),
('PCAT-20250117-BAT-007', '85076000', '3W', 'Battery', 'With IOT 60 V-50AH', true, 36, 'active'),
('PCAT-20250117-BAT-008', '85076000', '3W', 'Battery', 'Without IOT 60 V-50AH', true, 36, 'active'),
('PCAT-20250117-BAT-009', '85076000', '3W', 'Battery', 'With IOT 72 V-50AH', true, 36, 'active'),
('PCAT-20250117-BAT-010', '85076000', '3W', 'Battery', 'Without IOT 72 V-50AH', true, 36, 'active'),
('PCAT-20250117-BAT-011', '85076000', '3W', 'Battery', 'With IOT 48 V-100AH', true, 36, 'active'),
('PCAT-20250117-BAT-012', '85076000', '3W', 'Battery', 'Without IOT 48 V-100AH', true, 36, 'active'),
('PCAT-20250117-BAT-013', '85076000', '3W', 'Battery', 'With IOT 60 V-100AH', true, 36, 'active'),
('PCAT-20250117-BAT-014', '85076000', '3W', 'Battery', 'Without IOT 60 V-100AH', true, 36, 'active'),
('PCAT-20250117-BAT-015', '85076000', '3W', 'Battery', 'With IOT 72 V-100AH', true, 36, 'active'),
('PCAT-20250117-BAT-016', '85076000', '3W', 'Battery', 'Without IOT 72 V-100AH', true, 36, 'active'),
('PCAT-20250117-BAT-017', '85076000', '3W', 'Battery', 'With IOT 51.2 V-80AH', true, 36, 'active'),
('PCAT-20250117-BAT-018', '85076000', '3W', 'Battery', 'Without IOT 51.2 V-80AH', true, 36, 'active')
ON CONFLICT (id) DO NOTHING;
