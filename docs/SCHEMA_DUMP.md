# Database Schema — 29 tables

_Source: live Postgres `information_schema` (matches what is deployed)._

## `accounts`

| Column | Type | Null | Default | Notes |
|---|---|---|---|---|
| `id` | varchar(255) | NOT NULL | — | **PK** |
| `business_entity_name` | text | NOT NULL | — |  |
| `gstin` | varchar(15) | NOT NULL | — |  |
| `pan` | varchar(10) | NULL | — |  |
| `address_line1` | text | NULL | — |  |
| `address_line2` | text | NULL | — |  |
| `city` | text | NULL | — |  |
| `state` | text | NULL | — |  |
| `pincode` | varchar(6) | NULL | — |  |
| `bank_name` | text | NULL | — |  |
| `bank_account_number` | text | NULL | — |  |
| `ifsc_code` | varchar(11) | NULL | — |  |
| `bank_proof_url` | text | NULL | — |  |
| `dealer_code` | varchar(50) | NULL | — |  |
| `contact_name` | text | NULL | — |  |
| `contact_email` | text | NULL | — |  |
| `contact_phone` | varchar(20) | NULL | — |  |
| `status` | varchar(20) | NOT NULL | 'active'::character varying |  |
| `onboarding_status` | varchar(30) | NOT NULL | 'pending'::character varying |  |
| `created_by` | uuid | NULL | — |  |
| `created_at` | timestamptz | NOT NULL | now() |  |
| `updated_at` | timestamptz | NOT NULL | now() |  |

## `admin_verification_queue`

| Column | Type | Null | Default | Notes |
|---|---|---|---|---|
| `id` | varchar(255) | NOT NULL | — | **PK** |
| `queue_type` | varchar(50) | NOT NULL | 'kyc_verification'::character varying |  |
| `lead_id` | text | NOT NULL | — |  |
| `priority` | varchar(20) | NOT NULL | 'normal'::character varying |  |
| `assigned_to` | uuid | NULL | — |  |
| `submitted_by` | uuid | NULL | — |  |
| `status` | varchar(50) | NOT NULL | 'pending_itarang_verification'::character varying |  |
| `submitted_at` | timestamptz | NULL | — |  |
| `reviewed_at` | timestamptz | NULL | — |  |
| `created_at` | timestamptz | NOT NULL | now() |  |
| `updated_at` | timestamptz | NOT NULL | now() |  |

## `audit_logs`

| Column | Type | Null | Default | Notes |
|---|---|---|---|---|
| `id` | varchar(255) | NOT NULL | — | **PK** |
| `entity_type` | varchar(50) | NULL | — |  |
| `entity_id` | varchar(255) | NULL | — |  |
| `action` | varchar(50) | NULL | — |  |
| `performed_by` | uuid | NULL | — |  |
| `old_data` | jsonb | NULL | — |  |
| `new_data` | jsonb | NULL | — |  |
| `created_at` | timestamptz | NOT NULL | now() |  |
| `changes` | jsonb | NULL | — |  |
| `timestamp` | timestamptz | NOT NULL | now() |  |

## `co_borrower_documents`

| Column | Type | Null | Default | Notes |
|---|---|---|---|---|
| `id` | varchar(255) | NOT NULL | — | **PK** |
| `lead_id` | varchar(255) | NOT NULL | — | FK → leads.id |
| `co_borrower_id` | varchar(255) | NULL | — | FK → co_borrowers.id |
| `document_type` | varchar(50) | NOT NULL | — |  |
| `document_url` | text | NULL | — |  |
| `status` | varchar(30) | NULL | 'pending'::character varying |  |
| `ocr_data` | jsonb | NULL | — |  |
| `uploaded_at` | timestamptz | NULL | now() |  |
| `created_at` | timestamptz | NOT NULL | now() |  |
| `updated_at` | timestamptz | NOT NULL | now() |  |
| `file_name` | text | NULL | — |  |
| `file_size` | integer | NULL | — |  |
| `verification_status` | varchar(30) | NULL | 'pending'::character varying |  |

## `co_borrowers`

| Column | Type | Null | Default | Notes |
|---|---|---|---|---|
| `id` | varchar(255) | NOT NULL | — | **PK** |
| `lead_id` | varchar(255) | NOT NULL | — | FK → leads.id |
| `full_name` | text | NULL | — |  |
| `phone` | varchar(20) | NULL | — |  |
| `aadhaar_no` | varchar(12) | NULL | — |  |
| `pan_no` | varchar(10) | NULL | — |  |
| `dob` | date | NULL | — |  |
| `relationship` | varchar(50) | NULL | — |  |
| `income` | numeric(12,2) | NULL | — |  |
| `address` | text | NULL | — |  |
| `created_at` | timestamptz | NOT NULL | now() |  |
| `updated_at` | timestamptz | NOT NULL | now() |  |
| `father_or_husband_name` | text | NULL | — |  |
| `permanent_address` | text | NULL | — |  |
| `current_address` | text | NULL | — |  |
| `is_current_same` | boolean | NULL | false |  |
| `auto_filled` | boolean | NULL | false |  |
| `kyc_status` | varchar(30) | NULL | 'not_started'::character varying |  |
| `consent_status` | varchar(30) | NULL | 'awaiting_signature'::character varying |  |
| `verification_submitted_at` | timestamptz | NULL | — |  |

## `co_borrower_requests`

| Column | Type | Null | Default | Notes |
|---|---|---|---|---|
| `id` | varchar(255) | NOT NULL | — | **PK** |
| `lead_id` | varchar(255) | NOT NULL | — | FK → leads.id |
| `attempt_number` | integer | NOT NULL | 1 |  |
| `reason` | text | NULL | — |  |
| `status` | varchar(30) | NOT NULL | 'open'::character varying |  |
| `created_by` | uuid | NULL | — | FK → users.id |
| `created_at` | timestamptz | NOT NULL | now() |  |
| `updated_at` | timestamptz | NOT NULL | now() |  |

## `consent_records`

| Column | Type | Null | Default | Notes |
|---|---|---|---|---|
| `id` | varchar(255) | NOT NULL | — | **PK** |
| `lead_id` | varchar(255) | NOT NULL | — | FK → leads.id |
| `consent_type` | varchar(30) | NOT NULL | — |  |
| `channel` | varchar(20) | NULL | — |  |
| `consent_token` | text | NULL | — |  |
| `consent_link_url` | text | NULL | — |  |
| `consent_status` | varchar(20) | NULL | 'awaiting_signature'::character varying |  |
| `signed_at` | timestamptz | NULL | — |  |
| `generated_pdf_url` | text | NULL | — |  |
| `created_at` | timestamptz | NOT NULL | now() |  |
| `updated_at` | timestamptz | NOT NULL | now() |  |
| `consent_for` | varchar(20) | NOT NULL | 'primary'::character varying |  |
| `consent_link_sent_at` | timestamptz | NULL | — |  |
| `signed_consent_url` | text | NULL | — |  |
| `verified_by` | uuid | NULL | — |  |
| `verified_at` | timestamptz | NULL | — |  |
| `consent_link_expires_at` | timestamptz | NULL | — |  |
| `consent_delivery_channel` | varchar(20) | NULL | — |  |
| `sign_method` | varchar(30) | NULL | — |  |
| `esign_transaction_id` | varchar(255) | NULL | — |  |
| `esign_certificate_id` | varchar(255) | NULL | — |  |
| `esign_provider` | varchar(50) | NULL | — |  |
| `esign_error_code` | varchar(50) | NULL | — |  |
| `esign_error_message` | text | NULL | — |  |
| `signer_aadhaar_masked` | varchar(20) | NULL | — |  |
| `rejected_by` | uuid | NULL | — |  |
| `rejected_at` | timestamptz | NULL | — |  |
| `rejection_reason` | varchar(255) | NULL | — |  |
| `reviewer_notes` | text | NULL | — |  |
| `consent_attempt_count` | integer | NULL | 0 |  |
| `esign_retry_count` | integer | NULL | 0 |  |
| `admin_viewed_by` | uuid | NULL | — | FK → users.id |
| `admin_viewed_at` | timestamptz | NULL | — |  |

## `coupon_audit_log`

| Column | Type | Null | Default | Notes |
|---|---|---|---|---|
| `id` | varchar(255) | NOT NULL | — | **PK** |
| `coupon_id` | varchar(255) | NOT NULL | — | FK → coupon_codes.id |
| `action` | varchar(20) | NOT NULL | — |  |
| `old_status` | varchar(20) | NULL | — |  |
| `new_status` | varchar(20) | NULL | — |  |
| `lead_id` | varchar(255) | NULL | — | FK → leads.id |
| `performed_by` | uuid | NULL | — |  |
| `ip_address` | varchar(45) | NULL | — |  |
| `notes` | text | NULL | — |  |
| `created_at` | timestamptz | NOT NULL | now() |  |

## `coupon_batches`

| Column | Type | Null | Default | Notes |
|---|---|---|---|---|
| `id` | varchar(255) | NOT NULL | — | **PK** |
| `name` | varchar(200) | NOT NULL | — |  |
| `dealer_id` | varchar(255) | NOT NULL | — | FK → accounts.id |
| `prefix` | varchar(20) | NOT NULL | — |  |
| `coupon_value` | numeric(10,2) | NOT NULL | 0 |  |
| `total_quantity` | integer | NOT NULL | — |  |
| `expiry_date` | timestamptz | NULL | — |  |
| `status` | varchar(20) | NOT NULL | 'active'::character varying |  |
| `created_by` | uuid | NULL | — |  |
| `created_at` | timestamptz | NOT NULL | now() |  |
| `updated_at` | timestamptz | NOT NULL | now() |  |

## `coupon_codes`

| Column | Type | Null | Default | Notes |
|---|---|---|---|---|
| `id` | varchar(255) | NOT NULL | — | **PK** |
| `code` | varchar(50) | NOT NULL | — |  |
| `dealer_id` | varchar(255) | NULL | — | FK → accounts.id |
| `is_used` | boolean | NULL | false |  |
| `used_by_lead_id` | varchar(255) | NULL | — | FK → leads.id |
| `used_at` | timestamptz | NULL | — |  |
| `expires_at` | timestamptz | NULL | — |  |
| `created_at` | timestamptz | NOT NULL | now() |  |
| `status` | varchar(20) | NOT NULL | 'available'::character varying |  |
| `credits_available` | integer | NULL | 1 |  |
| `used_by` | uuid | NULL | — |  |
| `validated_at` | timestamptz | NULL | — |  |
| `discount_type` | varchar(20) | NULL | 'flat'::character varying |  |
| `discount_value` | numeric(10,2) | NULL | 0 |  |
| `max_discount_cap` | numeric(10,2) | NULL | — |  |
| `min_amount` | numeric(10,2) | NULL | — |  |
| `batch_id` | varchar(255) | NULL | — | FK → coupon_batches.id |
| `reserved_at` | timestamptz | NULL | — |  |
| `reserved_by` | uuid | NULL | — |  |
| `reserved_for_lead_id` | varchar(255) | NULL | — | FK → leads.id |

## `dealer_agreement_events`

| Column | Type | Null | Default | Notes |
|---|---|---|---|---|
| `id` | uuid | NOT NULL | gen_random_uuid() | **PK** |
| `application_id` | uuid | NOT NULL | — | FK → dealer_onboarding_applications.id |
| `provider_document_id` | text | NULL | — |  |
| `request_id` | text | NULL | — |  |
| `event_type` | varchar(100) | NOT NULL | — |  |
| `signer_role` | varchar(50) | NULL | — |  |
| `event_status` | varchar(50) | NULL | — |  |
| `event_payload` | jsonb | NULL | '{}'::jsonb |  |
| `created_at` | timestamp | NOT NULL | now() |  |

## `dealer_agreement_signers`

| Column | Type | Null | Default | Notes |
|---|---|---|---|---|
| `id` | uuid | NOT NULL | gen_random_uuid() | **PK** |
| `application_id` | uuid | NOT NULL | — | FK → dealer_onboarding_applications.id |
| `provider_document_id` | text | NULL | — |  |
| `request_id` | text | NULL | — |  |
| `signer_role` | varchar(50) | NOT NULL | — |  |
| `signer_name` | text | NOT NULL | — |  |
| `signer_email` | text | NULL | — |  |
| `signer_mobile` | text | NULL | — |  |
| `signing_method` | varchar(50) | NULL | — |  |
| `provider_signer_identifier` | text | NULL | — |  |
| `provider_signing_url` | text | NULL | — |  |
| `signer_status` | varchar(50) | NOT NULL | 'pending'::character varying |  |
| `signed_at` | timestamp | NULL | — |  |
| `last_event_at` | timestamp | NULL | — |  |
| `provider_raw_response` | jsonb | NULL | '{}'::jsonb |  |
| `created_at` | timestamp | NOT NULL | now() |  |
| `updated_at` | timestamp | NOT NULL | now() |  |

## `dealer_correction_items`

| Column | Type | Null | Default | Notes |
|---|---|---|---|---|
| `id` | uuid | NOT NULL | gen_random_uuid() | **PK** |
| `round_id` | uuid | NOT NULL | — | FK → dealer_correction_rounds.id |
| `kind` | varchar(20) | NOT NULL | — |  |
| `key` | varchar(100) | NOT NULL | — |  |
| `previous_value` | text | NULL | — |  |
| `new_value` | text | NULL | — |  |
| `previous_document_id` | uuid | NULL | — |  |
| `new_document_id` | uuid | NULL | — |  |
| `created_at` | timestamp | NOT NULL | now() |  |

## `dealer_correction_rounds`

| Column | Type | Null | Default | Notes |
|---|---|---|---|---|
| `id` | uuid | NOT NULL | gen_random_uuid() | **PK** |
| `application_id` | uuid | NOT NULL | — | FK → dealer_onboarding_applications.id |
| `round_number` | integer | NOT NULL | — |  |
| `status` | varchar(30) | NOT NULL | 'pending'::character varying |  |
| `requested_by` | uuid | NULL | — |  |
| `remarks` | text | NOT NULL | — |  |
| `requested_fields` | jsonb | NOT NULL | '[]'::jsonb |  |
| `requested_documents` | jsonb | NOT NULL | '[]'::jsonb |  |
| `dealer_submitted_at` | timestamp | NULL | — |  |
| `dealer_note` | text | NULL | — |  |
| `applied_by` | uuid | NULL | — |  |
| `applied_at` | timestamp | NULL | — |  |
| `token_hash` | text | NOT NULL | — |  |
| `token_expires_at` | timestamp | NOT NULL | — |  |
| `created_at` | timestamp | NOT NULL | now() |  |
| `updated_at` | timestamp | NOT NULL | now() |  |

## `dealer_leads`

| Column | Type | Null | Default | Notes |
|---|---|---|---|---|
| `id` | text | NOT NULL | — | **PK** |
| `dealer_name` | text | NULL | — |  |
| `phone` | text | NULL | — |  |
| `language` | text | NULL | — |  |
| `follow_up_history` | jsonb | NULL | '[]'::jsonb |  |
| `current_status` | text | NULL | — |  |
| `total_attempts` | integer | NULL | 0 |  |
| `final_intent_score` | integer | NULL | 0 |  |
| `created_at` | timestamp | NULL | now() |  |
| `location` | text | NULL | — |  |
| `memory` | jsonb | NULL | — |  |
| `next_call_at` | timestamp | NULL | — |  |
| `shop_name` | text | NULL | — |  |
| `overall_summary` | text | NULL | — |  |
| `assigned_to` | text | NULL | — |  |
| `approved_by` | text | NULL | — |  |
| `rejected_by` | text | NULL | — |  |
| `dealer_id` | text | NULL | — |  |

## `dealer_onboarding_applications`

| Column | Type | Null | Default | Notes |
|---|---|---|---|---|
| `id` | uuid | NOT NULL | gen_random_uuid() | **PK** |
| `dealer_user_id` | uuid | NULL | — |  |
| `company_name` | text | NOT NULL | — |  |
| `company_type` | text | NULL | — |  |
| `gst_number` | text | NULL | — |  |
| `pan_number` | text | NULL | — |  |
| `cin_number` | text | NULL | — |  |
| `finance_enabled` | boolean | NULL | false |  |
| `onboarding_status` | varchar(30) | NOT NULL | 'draft'::character varying |  |
| `review_status` | varchar(30) | NULL | 'pending'::character varying |  |
| `submitted_at` | timestamp | NULL | — |  |
| `approved_at` | timestamp | NULL | — |  |
| `rejected_at` | timestamp | NULL | — |  |
| `rejection_reason` | text | NULL | — |  |
| `admin_notes` | text | NULL | — |  |
| `created_at` | timestamp | NOT NULL | now() |  |
| `updated_at` | timestamp | NOT NULL | now() |  |
| `owner_name` | text | NULL | — |  |
| `owner_phone` | text | NULL | — |  |
| `owner_email` | text | NULL | — |  |
| `bank_name` | text | NULL | — |  |
| `account_number` | text | NULL | — |  |
| `beneficiary_name` | text | NULL | — |  |
| `ifsc_code` | text | NULL | — |  |
| `correction_remarks` | text | NULL | — |  |
| `rejection_remarks` | text | NULL | — |  |
| `dealer_account_status` | varchar(30) | NULL | 'inactive'::character varying |  |
| `dealer_code` | text | NULL | — |  |
| `correction_requested_at` | timestamp | NULL | — |  |
| `revalidated_at` | timestamp | NULL | — |  |
| `last_action_by` | uuid | NULL | — |  |
| `last_action_at` | timestamp | NULL | — |  |
| `approved_by` | uuid | NULL | — |  |
| `rejected_by` | uuid | NULL | — |  |
| `correction_count` | integer | NOT NULL | 0 |  |
| `is_locked` | boolean | NOT NULL | false |  |
| `business_address_new` | jsonb | NULL | '{}'::jsonb |  |
| `city` | varchar(100) | NULL | — |  |
| `state` | varchar(100) | NULL | — |  |
| `pincode` | varchar(20) | NULL | — |  |
| `contact_name` | text | NULL | — |  |
| `contact_phone` | varchar(20) | NULL | — |  |
| `contact_email` | varchar(150) | NULL | — |  |
| `agreement_id` | uuid | NULL | — |  |
| `registered_address` | jsonb | NULL | '{}'::jsonb |  |
| `business_address` | text | NULL | — |  |
| `request_id` | text | NULL | — |  |
| `provider_document_id` | text | NULL | — |  |
| `provider_signing_url` | text | NULL | — |  |
| `signed_at` | timestamp | NULL | — |  |
| `last_action_timestamp` | timestamp | NULL | — |  |
| `stamp_status` | varchar(50) | NULL | — |  |
| `completion_status` | varchar(50) | NULL | — |  |
| `agreement_audit_trail_url` | text | NULL | — |  |
| `sales_manager_name` | text | NULL | — |  |
| `sales_manager_email` | text | NULL | — |  |
| `sales_manager_mobile` | text | NULL | — |  |
| `itarang_signatory_1_name` | text | NULL | — |  |
| `itarang_signatory_1_email` | text | NULL | — |  |
| `itarang_signatory_1_mobile` | text | NULL | — |  |
| `itarang_signatory_2_name` | text | NULL | — |  |
| `itarang_signatory_2_email` | text | NULL | — |  |
| `itarang_signatory_2_mobile` | text | NULL | — |  |
| `agreement_last_initiated_at` | timestamp | NULL | — |  |
| `agreement_expired_at` | timestamp | NULL | — |  |
| `agreement_failed_at` | timestamp | NULL | — |  |
| `agreement_failure_reason` | text | NULL | — |  |
| `agreement_completed_at` | timestamp | NULL | — |  |
| `signed_agreement_storage_path` | text | NULL | — |  |
| `audit_trail_storage_path` | text | NULL | — |  |
| `agreement_status` | varchar(50) | NULL | 'not_generated'::character varying |  |
| `provider_raw_response` | jsonb | NULL | — |  |
| `signed_agreement_url` | text | NULL | — |  |
| `audit_trail_url` | text | NULL | — |  |
| `owner_landline` | varchar(20) | NULL | — |  |
| `agreement_language` | varchar(30) | NOT NULL | 'english'::character varying |  |
| `is_branch_dealer` | boolean | NOT NULL | false |  |
| `stamp_certificate_ids` | jsonb | NULL | '[]'::jsonb |  |

## `dealer_onboarding_documents`

| Column | Type | Null | Default | Notes |
|---|---|---|---|---|
| `id` | uuid | NOT NULL | gen_random_uuid() | **PK** |
| `application_id` | uuid | NOT NULL | — | FK → dealer_onboarding_applications.id |
| `document_type` | varchar(100) | NOT NULL | — |  |
| `bucket_name` | text | NOT NULL | — |  |
| `storage_path` | text | NOT NULL | — |  |
| `file_name` | text | NOT NULL | — |  |
| `file_url` | text | NULL | — |  |
| `mime_type` | varchar(100) | NULL | — |  |
| `file_size` | bigint | NULL | — |  |
| `uploaded_by` | uuid | NULL | — |  |
| `uploaded_at` | timestamp | NOT NULL | now() |  |
| `doc_status` | varchar(30) | NOT NULL | 'uploaded'::character varying |  |
| `verification_status` | varchar(30) | NULL | 'pending'::character varying |  |
| `verified_at` | timestamp | NULL | — |  |
| `verified_by` | uuid | NULL | — |  |
| `rejection_reason` | text | NULL | — |  |
| `extracted_data` | jsonb | NULL | '{}'::jsonb |  |
| `api_verification_results` | jsonb | NULL | '{}'::jsonb |  |
| `metadata` | jsonb | NULL | '{}'::jsonb |  |
| `created_at` | timestamp | NOT NULL | now() |  |
| `updated_at` | timestamp | NOT NULL | now() |  |
| `admin_comment` | text | NULL | — |  |

## `kyc_documents`

| Column | Type | Null | Default | Notes |
|---|---|---|---|---|
| `id` | varchar(255) | NOT NULL | — | **PK** |
| `lead_id` | varchar(255) | NOT NULL | — | FK → leads.id |
| `doc_type` | varchar(50) | NOT NULL | — |  |
| `file_url` | text | NULL | — |  |
| `verification_status` | varchar(30) | NULL | 'pending'::character varying |  |
| `ocr_data` | jsonb | NULL | — |  |
| `api_response` | jsonb | NULL | — |  |
| `uploaded_at` | timestamptz | NULL | now() |  |
| `verified_at` | timestamptz | NULL | — |  |
| `created_at` | timestamptz | NOT NULL | now() |  |
| `updated_at` | timestamptz | NOT NULL | now() |  |
| `file_name` | text | NULL | — |  |
| `file_size` | integer | NULL | — |  |
| `failed_reason` | text | NULL | — |  |
| `file_type` | varchar(50) | NULL | — |  |
| `doc_status` | varchar(30) | NULL | 'not_uploaded'::character varying |  |
| `rejection_reason` | text | NULL | — |  |
| `uploaded_by` | uuid | NULL | — |  |
| `verified_by` | uuid | NULL | — |  |
| `doc_for` | varchar(20) | NOT NULL | 'customer'::character varying |  |

## `kyc_verification_metadata`

| Column | Type | Null | Default | Notes |
|---|---|---|---|---|
| `lead_id` | varchar(255) | NOT NULL | — | **PK** |
| `submission_timestamp` | timestamptz | NULL | — |  |
| `case_type` | varchar(20) | NULL | — |  |
| `coupon_code` | varchar(100) | NULL | — |  |
| `coupon_status` | varchar(30) | NULL | 'reserved'::character varying |  |
| `documents_count` | integer | NULL | — |  |
| `consent_verified` | boolean | NULL | false |  |
| `dealer_edits_locked` | boolean | NULL | false |  |
| `verification_started_at` | timestamptz | NULL | — |  |
| `first_api_execution_at` | timestamptz | NULL | — |  |
| `first_api_type` | varchar(50) | NULL | — |  |
| `final_decision` | varchar(20) | NULL | — |  |
| `final_decision_at` | timestamptz | NULL | — |  |
| `final_decision_by` | uuid | NULL | — |  |
| `final_decision_notes` | text | NULL | — |  |
| `created_at` | timestamptz | NOT NULL | now() |  |
| `updated_at` | timestamptz | NOT NULL | now() |  |

## `kyc_verifications`

| Column | Type | Null | Default | Notes |
|---|---|---|---|---|
| `id` | varchar(255) | NOT NULL | — | **PK** |
| `lead_id` | varchar(255) | NOT NULL | — | FK → leads.id |
| `verification_type` | varchar(50) | NOT NULL | — |  |
| `status` | varchar(30) | NULL | 'pending'::character varying |  |
| `api_provider` | varchar(50) | NULL | — |  |
| `api_request` | jsonb | NULL | — |  |
| `api_response` | jsonb | NULL | — |  |
| `failed_reason` | text | NULL | — |  |
| `submitted_at` | timestamptz | NULL | — |  |
| `completed_at` | timestamptz | NULL | — |  |
| `created_at` | timestamptz | NOT NULL | now() |  |
| `updated_at` | timestamptz | NOT NULL | now() |  |
| `match_score` | numeric(5,2) | NULL | — |  |
| `retry_count` | integer | NULL | 0 |  |
| `admin_action` | varchar(30) | NULL | — |  |
| `admin_action_by` | uuid | NULL | — |  |
| `admin_action_at` | timestamptz | NULL | — |  |
| `admin_action_notes` | text | NULL | — |  |
| `verification_for` | varchar(20) | NOT NULL | 'customer'::character varying |  |
| `applicant` | varchar(20) | NOT NULL | 'primary'::character varying |  |

## `lead_assignments`

| Column | Type | Null | Default | Notes |
|---|---|---|---|---|
| `id` | varchar(255) | NOT NULL | — | **PK** |
| `lead_id` | varchar(255) | NOT NULL | — | FK → leads.id |
| `lead_owner` | uuid | NOT NULL | — |  |
| `assigned_by` | uuid | NOT NULL | — |  |
| `assigned_at` | timestamptz | NOT NULL | now() |  |
| `lead_actor` | uuid | NULL | — |  |
| `actor_assigned_by` | uuid | NULL | — |  |
| `actor_assigned_at` | timestamptz | NULL | — |  |
| `updated_at` | timestamptz | NOT NULL | now() |  |

## `lead_documents`

| Column | Type | Null | Default | Notes |
|---|---|---|---|---|
| `id` | varchar(255) | NOT NULL | — | **PK** |
| `lead_id` | varchar(255) | NOT NULL | — | FK → leads.id |
| `document_type` | varchar(50) | NOT NULL | — |  |
| `document_url` | text | NOT NULL | — |  |
| `status` | varchar(20) | NULL | 'uploaded'::character varying |  |
| `created_at` | timestamptz | NOT NULL | now() |  |
| `dealer_id` | varchar(255) | NULL | — |  |
| `user_id` | uuid | NULL | — |  |
| `doc_type` | varchar(100) | NULL | — |  |
| `storage_path` | text | NULL | — |  |

## `leads`

| Column | Type | Null | Default | Notes |
|---|---|---|---|---|
| `id` | varchar(255) | NOT NULL | — | **PK** |
| `dealer_id` | varchar(255) | NULL | — | FK → accounts.id |
| `assigned_to` | uuid | NULL | — |  |
| `owner_name` | text | NULL | — |  |
| `owner_contact` | varchar(20) | NULL | — |  |
| `phone` | varchar(20) | NULL | — |  |
| `mobile` | varchar(20) | NULL | — |  |
| `permanent_address` | text | NULL | — |  |
| `local_address` | text | NULL | — |  |
| `vehicle_ownership` | varchar(50) | NULL | — |  |
| `battery_type` | varchar(50) | NULL | — |  |
| `asset_model` | text | NULL | — |  |
| `asset_price` | numeric(12,2) | NULL | — |  |
| `family_members` | integer | NULL | — |  |
| `driving_experience` | integer | NULL | — |  |
| `loan_required` | boolean | NULL | false |  |
| `interest_level` | varchar(20) | NULL | 'cold'::character varying |  |
| `lead_score` | integer | NULL | 0 |  |
| `status` | varchar(30) | NULL | 'new'::character varying |  |
| `kyc_status` | varchar(30) | NULL | 'pending'::character varying |  |
| `kyc_score` | integer | NULL | 0 |  |
| `kyc_completed_at` | timestamptz | NULL | — |  |
| `payment_method` | varchar(20) | NULL | — |  |
| `consent_status` | varchar(20) | NULL | 'pending'::character varying |  |
| `has_co_borrower` | boolean | NULL | false |  |
| `has_additional_docs_required` | boolean | NULL | false |  |
| `interim_step_status` | varchar(20) | NULL | 'pending'::character varying |  |
| `kyc_draft_data` | jsonb | NULL | — |  |
| `step_status` | jsonb | NULL | — |  |
| `source` | varchar(50) | NULL | — |  |
| `remarks` | text | NULL | — |  |
| `created_at` | timestamptz | NOT NULL | now() |  |
| `updated_at` | timestamptz | NOT NULL | now() |  |
| `lead_source` | varchar(50) | NOT NULL | — |  |
| `lead_status` | varchar(50) | NOT NULL | 'new'::character varying |  |
| `business_name` | text | NULL | — |  |
| `owner_email` | text | NULL | — |  |
| `state` | varchar(100) | NULL | — |  |
| `city` | varchar(100) | NULL | — |  |
| `shop_address` | text | NULL | — |  |
| `lead_type` | varchar(20) | NULL | — |  |
| `vehicle_rc` | varchar(50) | NULL | — |  |
| `full_name` | text | NULL | — |  |
| `father_or_husband_name` | text | NULL | — |  |
| `dob` | timestamptz | NULL | — |  |
| `current_address` | text | NULL | — |  |
| `is_current_same` | boolean | NOT NULL | false |  |
| `product_category_id` | varchar(255) | NULL | — |  |
| `product_type_id` | varchar(255) | NULL | — |  |
| `vehicle_owner_name` | text | NULL | — |  |
| `vehicle_owner_phone` | varchar(20) | NULL | — |  |
| `auto_filled` | boolean | NOT NULL | false |  |
| `ocr_status` | varchar(20) | NULL | — |  |
| `ocr_error` | text | NULL | — |  |
| `reference_id` | varchar(255) | NULL | — |  |
| `interested_in` | jsonb | NULL | — |  |
| `battery_order_expected` | integer | NULL | — |  |
| `investment_capacity` | numeric(12,2) | NULL | — |  |
| `business_type` | varchar(50) | NULL | — |  |
| `qualified_by` | uuid | NULL | — |  |
| `qualified_at` | timestamptz | NULL | — |  |
| `qualification_notes` | text | NULL | — |  |
| `converted_deal_id` | varchar(255) | NULL | — |  |
| `converted_at` | timestamptz | NULL | — |  |
| `total_ai_calls` | integer | NULL | 0 |  |
| `last_ai_call_at` | timestamptz | NULL | — |  |
| `last_call_outcome` | text | NULL | — |  |
| `ai_priority_score` | numeric(5,2) | NULL | — |  |
| `next_call_after` | timestamptz | NULL | — |  |
| `do_not_call` | boolean | NULL | false |  |
| `workflow_step` | integer | NOT NULL | 1 |  |
| `primary_product_id` | uuid | NULL | — | FK → products.id |
| `uploader_id` | uuid | NOT NULL | — |  |
| `ai_managed` | boolean | NULL | false |  |
| `ai_owner` | text | NULL | — |  |
| `manual_takeover` | boolean | NULL | false |  |
| `last_ai_action_at` | timestamptz | NULL | — |  |
| `intent_score` | integer | NULL | — |  |
| `intent_reason` | text | NULL | — |  |
| `next_call_at` | timestamptz | NULL | — |  |
| `call_priority` | integer | NULL | 0 |  |
| `conversation_summary` | text | NULL | — |  |
| `last_call_status` | text | NULL | — |  |
| `sm_review_status` | varchar(30) | NULL | 'not_submitted'::character varying |  |
| `submitted_to_sm_at` | timestamptz | NULL | — |  |
| `sm_assigned_to` | uuid | NULL | — |  |
| `consent_link_url` | text | NULL | — |  |
| `consent_link_sent_at` | timestamptz | NULL | — |  |
| `consent_link_expires_at` | timestamptz | NULL | — |  |
| `consent_delivery_channel` | varchar(50) | NULL | — |  |
| `esign_transaction_id` | varchar(255) | NULL | — |  |
| `esign_certificate_id` | varchar(255) | NULL | — |  |
| `esign_completed_at` | timestamptz | NULL | — |  |
| `esign_failed_at` | timestamptz | NULL | — |  |
| `esign_error_code` | varchar(100) | NULL | — |  |
| `esign_error_message` | text | NULL | — |  |
| `consent_verified_by` | uuid | NULL | — |  |
| `consent_verified_at` | timestamptz | NULL | — |  |
| `consent_verification_notes` | text | NULL | — |  |
| `consent_final` | boolean | NULL | false |  |
| `consent_rejection_reason` | varchar(255) | NULL | — |  |
| `consent_rejection_notes` | text | NULL | — |  |
| `consent_rejected_by` | uuid | NULL | — |  |
| `consent_rejected_at` | timestamptz | NULL | — |  |
| `consent_attempt_count` | integer | NULL | 0 |  |
| `google_place_id` | varchar(255) | NULL | — |  |
| `website` | text | NULL | — |  |
| `google_maps_uri` | text | NULL | — |  |
| `google_rating` | numeric(3,1) | NULL | — |  |
| `google_ratings_count` | integer | NULL | — |  |
| `google_business_status` | varchar(50) | NULL | — |  |
| `google_business_types` | jsonb | NULL | — |  |
| `raw_source_payload` | jsonb | NULL | — |  |
| `scrape_query` | text | NULL | — |  |
| `scrape_batch_id` | varchar(255) | NULL | — |  |
| `scraped_at` | timestamptz | NULL | — |  |
| `phone_quality` | varchar(20) | NULL | 'valid'::character varying |  |
| `normalized_phone` | varchar(20) | NULL | — |  |
| `intent_band` | varchar(20) | NULL | — |  |
| `intent_scored_at` | timestamptz | NULL | — |  |
| `intent_details` | jsonb | NULL | — |  |
| `coupon_code` | varchar(20) | NULL | — |  |
| `coupon_status` | varchar(20) | NULL | — |  |
| `borrower_consent_status` | varchar(30) | NULL | 'awaiting_signature'::character varying |  |
| `sold_at` | timestamptz | NULL | — |  |

## `other_document_requests`

| Column | Type | Null | Default | Notes |
|---|---|---|---|---|
| `id` | varchar(255) | NOT NULL | — | **PK** |
| `lead_id` | varchar(255) | NOT NULL | — | FK → leads.id |
| `requested_by` | uuid | NULL | — |  |
| `doc_label` | text | NOT NULL | — |  |
| `description` | text | NULL | — |  |
| `file_url` | text | NULL | — |  |
| `upload_status` | varchar(20) | NULL | 'pending'::character varying |  |
| `uploaded_at` | timestamptz | NULL | — |  |
| `created_at` | timestamptz | NOT NULL | now() |  |
| `updated_at` | timestamptz | NOT NULL | now() |  |
| `upload_token` | varchar(255) | NULL | — |  |
| `token_expires_at` | timestamptz | NULL | — |  |
| `doc_for` | varchar(20) | NOT NULL | 'primary'::character varying |  |
| `doc_key` | varchar(100) | NOT NULL | 'other'::character varying |  |
| `is_required` | boolean | NULL | true |  |
| `rejection_reason` | text | NULL | — |  |
| `reviewed_by` | uuid | NULL | — | FK → users.id |
| `reviewed_at` | timestamptz | NULL | — |  |
| `document_name` | text | NULL | — |  |
| `document_url` | text | NULL | — |  |
| `status` | varchar(20) | NULL | 'pending'::character varying |  |

## `personal_details`

| Column | Type | Null | Default | Notes |
|---|---|---|---|---|
| `id` | varchar(255) | NOT NULL | — | **PK** |
| `lead_id` | varchar(255) | NOT NULL | — | FK → leads.id |
| `aadhaar_no` | varchar(12) | NULL | — |  |
| `pan_no` | varchar(10) | NULL | — |  |
| `dob` | timestamptz | NULL | — |  |
| `email` | text | NULL | — |  |
| `income` | numeric(12,2) | NULL | — |  |
| `father_husband_name` | text | NULL | — |  |
| `marital_status` | varchar(20) | NULL | — |  |
| `spouse_name` | text | NULL | — |  |
| `created_at` | timestamptz | NOT NULL | now() |  |
| `updated_at` | timestamptz | NOT NULL | now() |  |
| `finance_type` | varchar(50) | NULL | — |  |
| `financier` | varchar(100) | NULL | — |  |
| `asset_type` | varchar(50) | NULL | — |  |
| `vehicle_rc` | varchar(50) | NULL | — |  |
| `loan_type` | varchar(100) | NULL | — |  |
| `local_address` | text | NULL | — |  |
| `dob_confidence` | numeric(5,2) | NULL | — |  |
| `name_confidence` | numeric(5,2) | NULL | — |  |
| `address_confidence` | numeric(5,2) | NULL | — |  |
| `ocr_processed_at` | timestamptz | NULL | — |  |
| `permanent_address` | text | NULL | — |  |
| `bank_account_number` | varchar(50) | NULL | — |  |
| `bank_ifsc` | varchar(20) | NULL | — |  |
| `bank_name` | varchar(100) | NULL | — |  |
| `bank_branch` | varchar(100) | NULL | — |  |

## `product_categories`

| Column | Type | Null | Default | Notes |
|---|---|---|---|---|
| `id` | uuid | NOT NULL | gen_random_uuid() | **PK** |
| `name` | text | NOT NULL | — |  |
| `slug` | text | NOT NULL | — |  |
| `is_active` | boolean | NOT NULL | true |  |
| `created_at` | timestamptz | NOT NULL | now() |  |
| `updated_at` | timestamptz | NOT NULL | now() |  |

## `product_selections`

| Column | Type | Null | Default | Notes |
|---|---|---|---|---|
| `id` | varchar(255) | NOT NULL | — | **PK** |
| `lead_id` | varchar(255) | NOT NULL | — | FK → leads.id |
| `battery_serial` | varchar(255) | NULL | — |  |
| `charger_serial` | varchar(255) | NULL | — |  |
| `paraphernalia` | jsonb | NULL | — |  |
| `category` | varchar(100) | NULL | — |  |
| `sub_category` | varchar(100) | NULL | — |  |
| `battery_price` | numeric(12,2) | NULL | — |  |
| `charger_price` | numeric(12,2) | NULL | — |  |
| `paraphernalia_cost` | numeric(12,2) | NULL | — |  |
| `dealer_margin` | numeric(12,2) | NULL | — |  |
| `final_price` | numeric(12,2) | NULL | — |  |
| `payment_mode` | varchar(20) | NULL | — |  |
| `admin_decision` | varchar(30) | NULL | 'pending'::character varying |  |
| `submitted_by` | uuid | NULL | — |  |
| `submitted_at` | timestamptz | NULL | now() |  |
| `created_at` | timestamptz | NOT NULL | now() |  |
| `updated_at` | timestamptz | NOT NULL | now() |  |
| `battery_gross` | numeric(12,2) | NULL | — |  |
| `battery_gst_percent` | numeric(5,2) | NULL | — |  |
| `battery_gst_amount` | numeric(12,2) | NULL | — |  |
| `battery_net` | numeric(12,2) | NULL | — |  |
| `charger_gross` | numeric(12,2) | NULL | — |  |
| `charger_gst_percent` | numeric(5,2) | NULL | — |  |
| `charger_gst_amount` | numeric(12,2) | NULL | — |  |
| `charger_net` | numeric(12,2) | NULL | — |  |
| `paraphernalia_lines` | jsonb | NULL | — |  |
| `gross_subtotal` | numeric(12,2) | NULL | — |  |
| `gst_subtotal` | numeric(12,2) | NULL | — |  |
| `net_subtotal` | numeric(12,2) | NULL | — |  |

## `products`

| Column | Type | Null | Default | Notes |
|---|---|---|---|---|
| `id` | uuid | NOT NULL | gen_random_uuid() | **PK** |
| `category_id` | uuid | NOT NULL | — | FK → product_categories.id |
| `name` | text | NOT NULL | — |  |
| `slug` | text | NOT NULL | — |  |
| `voltage_v` | integer | NOT NULL | — |  |
| `capacity_ah` | integer | NOT NULL | — |  |
| `sku` | text | NOT NULL | — |  |
| `sort_order` | integer | NOT NULL | 0 |  |
| `is_active` | boolean | NOT NULL | true |  |
| `created_at` | timestamptz | NOT NULL | now() |  |
| `updated_at` | timestamptz | NOT NULL | now() |  |
| `hsn_code` | varchar(8) | NULL | — |  |
| `asset_type` | varchar(50) | NULL | — |  |
| `is_serialized` | boolean | NOT NULL | true |  |
| `warranty_months` | integer | NOT NULL | 0 |  |
| `status` | varchar(20) | NOT NULL | 'active'::character varying |  |
| `price` | integer | NULL | — |  |

## `users`

| Column | Type | Null | Default | Notes |
|---|---|---|---|---|
| `id` | uuid | NOT NULL | — | **PK** |
| `email` | text | NOT NULL | — |  |
| `name` | text | NOT NULL | — |  |
| `role` | varchar(50) | NOT NULL | — |  |
| `dealer_id` | varchar(255) | NULL | — |  |
| `phone` | text | NULL | — |  |
| `avatar_url` | text | NULL | — |  |
| `is_active` | boolean | NOT NULL | true |  |
| `created_at` | timestamptz | NOT NULL | now() |  |
| `updated_at` | timestamptz | NOT NULL | now() |  |
| `password_hash` | text | NULL | — |  |
| `must_change_password` | boolean | NOT NULL | false |  |
