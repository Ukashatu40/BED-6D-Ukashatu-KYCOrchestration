-- CreateEnum
CREATE TYPE "KycTier" AS ENUM ('MINIMUM', 'FULL', 'EDD');

-- CreateEnum
CREATE TYPE "KycStatus" AS ENUM ('NOT_STARTED', 'INITIATED', 'DOCUMENTS_PENDING', 'DOCUMENTS_RECEIVED', 'VERIFICATION_IN_PROGRESS', 'VENDOR_CALLBACK_AWAITED', 'VERIFIED', 'REJECTED', 'ESCALATED_TO_MANUAL', 'EXPIRED', 'RE_VERIFICATION_REQUIRED', 'SUSPENDED');

-- CreateEnum
CREATE TYPE "VendorType" AS ENUM ('DIGILOCKER', 'CKYC', 'VIDEO_KYC', 'AML_SCREENING');

-- CreateEnum
CREATE TYPE "StepStatus" AS ENUM ('PENDING', 'IN_PROGRESS', 'COMPLETED', 'FAILED', 'SKIPPED', 'TIMED_OUT');

-- CreateEnum
CREATE TYPE "DocumentType" AS ENUM ('AADHAAR', 'PAN', 'DRIVING_LICENCE', 'ADDRESS_PROOF', 'INCOME_PROOF', 'VIDEO_RECORDING', 'PHOTOGRAPH', 'OTHER');

-- CreateEnum
CREATE TYPE "ScreeningType" AS ENUM ('SANCTIONS', 'PEP', 'ADVERSE_MEDIA', 'COMBINED');

-- CreateEnum
CREATE TYPE "ScreeningDisposition" AS ENUM ('PENDING', 'CLEARED', 'ESCALATED', 'FROZEN', 'UNDER_REVIEW');

-- CreateEnum
CREATE TYPE "AuditActorType" AS ENUM ('SYSTEM', 'USER', 'VENDOR', 'SCHEDULER');

-- CreateEnum
CREATE TYPE "ErasureStatus" AS ENUM ('RECEIVED', 'EVALUATING', 'PARTIALLY_EXECUTED', 'SCHEDULED', 'COMPLETED', 'REJECTED');

-- CreateEnum
CREATE TYPE "KeyStatus" AS ENUM ('ACTIVE', 'ROTATED', 'REVOKED');

-- CreateTable
CREATE TABLE "customers" (
    "customer_id" UUID NOT NULL,
    "external_id" TEXT NOT NULL,
    "full_name_encrypted" BYTEA NOT NULL,
    "date_of_birth_encrypted" BYTEA NOT NULL,
    "kyc_tier" "KycTier" NOT NULL,
    "kyc_status" "KycStatus" NOT NULL,
    "risk_score" INTEGER NOT NULL,
    "risk_factors" JSONB NOT NULL,
    "ckyc_kin" VARCHAR(14),
    "last_verified_at" TIMESTAMP(3),
    "next_verification_due" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,
    "deleted_at" TIMESTAMP(3),

    CONSTRAINT "customers_pkey" PRIMARY KEY ("customer_id")
);

-- CreateTable
CREATE TABLE "verification_requests" (
    "request_id" UUID NOT NULL,
    "customer_id" UUID NOT NULL,
    "tier" "KycTier" NOT NULL,
    "workflow_config_version" TEXT NOT NULL,
    "current_step" TEXT,
    "status" "KycStatus" NOT NULL,
    "initiated_by" TEXT NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "completed_at" TIMESTAMP(3),
    "expires_at" TIMESTAMP(3) NOT NULL,
    "retry_of" UUID,

    CONSTRAINT "verification_requests_pkey" PRIMARY KEY ("request_id")
);

-- CreateTable
CREATE TABLE "verification_steps" (
    "step_id" UUID NOT NULL,
    "request_id" UUID NOT NULL,
    "vendor_type" "VendorType" NOT NULL,
    "vendor_adapter_version" TEXT NOT NULL,
    "step_order" INTEGER NOT NULL,
    "status" "StepStatus" NOT NULL,
    "input_payload_encrypted" BYTEA,
    "output_payload_encrypted" BYTEA,
    "vendor_reference_id" TEXT,
    "started_at" TIMESTAMP(3),
    "completed_at" TIMESTAMP(3),
    "retry_count" INTEGER NOT NULL DEFAULT 0,
    "error_code" TEXT,
    "error_message_encrypted" BYTEA,

    CONSTRAINT "verification_steps_pkey" PRIMARY KEY ("step_id")
);

-- CreateTable
CREATE TABLE "documents" (
    "document_id" UUID NOT NULL,
    "customer_id" UUID NOT NULL,
    "document_type" "DocumentType" NOT NULL,
    "storage_path" TEXT NOT NULL,
    "encryption_dek_encrypted" BYTEA NOT NULL,
    "encryption_iv" BYTEA NOT NULL,
    "encryption_auth_tag" BYTEA NOT NULL,
    "encryption_kek_version" TEXT NOT NULL,
    "hash_sha256" VARCHAR(64) NOT NULL,
    "file_size_bytes" BIGINT NOT NULL,
    "mime_type" TEXT NOT NULL,
    "uploaded_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "expires_at" TIMESTAMP(3),
    "is_active" BOOLEAN NOT NULL DEFAULT true,
    "uploaded_by" TEXT NOT NULL,

    CONSTRAINT "documents_pkey" PRIMARY KEY ("document_id")
);

-- CreateTable
CREATE TABLE "aml_screening_results" (
    "screening_id" UUID NOT NULL,
    "customer_id" UUID NOT NULL,
    "vendor_reference_id" TEXT,
    "screening_type" "ScreeningType" NOT NULL,
    "match_count" INTEGER NOT NULL,
    "highest_risk_score" INTEGER NOT NULL,
    "highest_confidence" DECIMAL(5,2) NOT NULL,
    "disposition" "ScreeningDisposition" NOT NULL DEFAULT 'PENDING',
    "disposition_by" TEXT,
    "disposition_at" TIMESTAMP(3),
    "disposition_justification_encrypted" BYTEA,
    "ongoing_monitoring_active" BOOLEAN NOT NULL DEFAULT false,
    "monitoring_webhook_id" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "aml_screening_results_pkey" PRIMARY KEY ("screening_id")
);

-- CreateTable
CREATE TABLE "aml_match_details" (
    "match_id" UUID NOT NULL,
    "screening_id" UUID NOT NULL,
    "matched_list" TEXT NOT NULL,
    "matched_name" TEXT NOT NULL,
    "match_confidence" DECIMAL(5,2) NOT NULL,
    "matched_attributes" JSONB NOT NULL,
    "risk_score" INTEGER NOT NULL,
    "disposition" "ScreeningDisposition" NOT NULL,
    "disposition_by" TEXT,
    "disposition_justification_encrypted" BYTEA,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "aml_match_details_pkey" PRIMARY KEY ("match_id")
);

-- CreateTable
CREATE TABLE "audit_events" (
    "event_id" UUID NOT NULL,
    "customer_id" UUID,
    "event_type" VARCHAR(100) NOT NULL,
    "event_version" INTEGER NOT NULL DEFAULT 1,
    "actor_type" "AuditActorType" NOT NULL,
    "actor_id" TEXT NOT NULL,
    "correlation_id" UUID NOT NULL,
    "event_payload_encrypted" BYTEA NOT NULL,
    "previous_event_hash" VARCHAR(64),
    "event_hash" VARCHAR(64) NOT NULL,
    "created_at" TIMESTAMP(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "audit_events_pkey" PRIMARY KEY ("event_id")
);

-- CreateTable
CREATE TABLE "data_erasure_requests" (
    "request_id" UUID NOT NULL,
    "customer_id" UUID NOT NULL,
    "requestor_id" TEXT NOT NULL,
    "request_date" TIMESTAMP(3) NOT NULL,
    "status" "ErasureStatus" NOT NULL,
    "legal_holds" JSONB NOT NULL,
    "eligible_data_categories" JSONB NOT NULL,
    "anonymised_data_categories" JSONB,
    "scheduled_completion_date" TIMESTAMP(3),
    "response_sent_at" TIMESTAMP(3),
    "completed_at" TIMESTAMP(3),

    CONSTRAINT "data_erasure_requests_pkey" PRIMARY KEY ("request_id")
);

-- CreateTable
CREATE TABLE "encryption_key_metadata" (
    "key_id" TEXT NOT NULL,
    "kek_version" TEXT NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "rotated_at" TIMESTAMP(3),
    "status" "KeyStatus" NOT NULL,
    "document_count" INTEGER NOT NULL DEFAULT 0,

    CONSTRAINT "encryption_key_metadata_pkey" PRIMARY KEY ("key_id")
);

-- CreateIndex
CREATE UNIQUE INDEX "customers_external_id_key" ON "customers"("external_id");

-- CreateIndex
CREATE INDEX "idx_customers_external_id" ON "customers"("external_id");

-- CreateIndex
CREATE INDEX "idx_customers_ckyc_kin" ON "customers"("ckyc_kin");

-- CreateIndex
CREATE INDEX "idx_customers_status_next_verification" ON "customers"("kyc_status", "next_verification_due");

-- CreateIndex
CREATE INDEX "idx_verification_requests_customer_latest" ON "verification_requests"("customer_id", "created_at" DESC);

-- CreateIndex
CREATE INDEX "idx_verification_requests_status_expiry" ON "verification_requests"("status", "expires_at");

-- CreateIndex
CREATE INDEX "idx_verification_steps_request_order" ON "verification_steps"("request_id", "step_order");

-- CreateIndex
CREATE INDEX "idx_documents_customer_type_active" ON "documents"("customer_id", "document_type", "is_active");

-- CreateIndex
CREATE INDEX "idx_aml_screening_customer_latest" ON "aml_screening_results"("customer_id", "created_at" DESC);

-- CreateIndex
CREATE INDEX "idx_aml_screening_disposition_monitoring" ON "aml_screening_results"("disposition", "ongoing_monitoring_active");

-- CreateIndex
CREATE INDEX "idx_audit_events_customer_trail" ON "audit_events"("customer_id", "created_at");

-- CreateIndex
CREATE INDEX "idx_audit_events_type_analysis" ON "audit_events"("event_type", "created_at");

-- CreateIndex
CREATE INDEX "idx_audit_events_correlation" ON "audit_events"("correlation_id");

-- CreateIndex
CREATE INDEX "idx_erasure_requests_customer_status" ON "data_erasure_requests"("customer_id", "status");

-- CreateIndex
CREATE INDEX "idx_erasure_requests_due_scheduled" ON "data_erasure_requests"("scheduled_completion_date", "status");

-- AddForeignKey
ALTER TABLE "verification_requests" ADD CONSTRAINT "verification_requests_customer_id_fkey" FOREIGN KEY ("customer_id") REFERENCES "customers"("customer_id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "verification_steps" ADD CONSTRAINT "verification_steps_request_id_fkey" FOREIGN KEY ("request_id") REFERENCES "verification_requests"("request_id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "documents" ADD CONSTRAINT "documents_customer_id_fkey" FOREIGN KEY ("customer_id") REFERENCES "customers"("customer_id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "aml_screening_results" ADD CONSTRAINT "aml_screening_results_customer_id_fkey" FOREIGN KEY ("customer_id") REFERENCES "customers"("customer_id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "aml_match_details" ADD CONSTRAINT "aml_match_details_screening_id_fkey" FOREIGN KEY ("screening_id") REFERENCES "aml_screening_results"("screening_id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "audit_events" ADD CONSTRAINT "audit_events_customer_id_fkey" FOREIGN KEY ("customer_id") REFERENCES "customers"("customer_id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "data_erasure_requests" ADD CONSTRAINT "data_erasure_requests_customer_id_fkey" FOREIGN KEY ("customer_id") REFERENCES "customers"("customer_id") ON DELETE RESTRICT ON UPDATE CASCADE;
