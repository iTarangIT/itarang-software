-- Create app_settings table for global configuration
-- Run this in Supabase SQL Editor

CREATE TABLE IF NOT EXISTS public.app_settings (
    key TEXT PRIMARY KEY,
    value JSONB NOT NULL,
    updated_at TIMESTAMPTZ DEFAULT NOW()
);

-- Insert default AI caller setting (enabled by default)
INSERT INTO public.app_settings (key, value, updated_at)
VALUES ('ai_caller_enabled', '{"enabled": true}'::jsonb, NOW())
ON CONFLICT (key) DO NOTHING;
