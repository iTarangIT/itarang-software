ALTER TABLE dealer_onboarding_applications
ADD COLUMN IF NOT EXISTS owner_landline varchar(20);
