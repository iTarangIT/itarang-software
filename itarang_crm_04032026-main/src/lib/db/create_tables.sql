
-- Create users table if not exists (simplified for dependency)
CREATE TABLE IF NOT EXISTS users (
    id varchar(255) PRIMARY KEY,
    name text NOT NULL,
    email text NOT NULL UNIQUE,
    role varchar(50) NOT NULL,
    status varchar(20) DEFAULT 'active',
    created_at timestamp DEFAULT now() NOT NULL
);

-- Create product_catalog table
CREATE TABLE IF NOT EXISTS product_catalog (
    id varchar(255) PRIMARY KEY,
    hsn_code varchar(8) NOT NULL,
    asset_category varchar(20) NOT NULL,
    asset_type varchar(50) NOT NULL,
    model_type text NOT NULL,
    is_serialized boolean DEFAULT true NOT NULL,
    warranty_months integer NOT NULL,
    status varchar(20) DEFAULT 'active' NOT NULL,
    created_by varchar(255) REFERENCES users(id),
    created_at timestamp DEFAULT now() NOT NULL,
    updated_at timestamp DEFAULT now() NOT NULL
);
