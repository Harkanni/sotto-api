-- Phase 6: AI modes, providers and billing.
-- BYOK keys (envelope-encrypted), the workspace AI policy, metering and the subscription.
-- Generated with `prisma migrate diff`; the CHECKs at the end are hand-written.
-- (Edited before merge: usage_events.subject_id. Never deployed before that.)

-- CreateEnum
CREATE TYPE "usage_kind" AS ENUM ('AI_INPUT_TOKENS', 'AI_OUTPUT_TOKENS', 'TRANSCRIPTION_SECONDS', 'STORAGE_BYTES');

-- CreateEnum
CREATE TYPE "plan" AS ENUM ('FREE', 'PRO', 'BUSINESS', 'ENTERPRISE');

-- CreateEnum
CREATE TYPE "subscription_status" AS ENUM ('ACTIVE', 'PAST_DUE', 'CANCELLED');

-- CreateTable
CREATE TABLE "ai_provider_configs" (
    "id" TEXT NOT NULL,
    "workspace_id" TEXT NOT NULL,
    "provider" TEXT NOT NULL,
    "label" TEXT NOT NULL,
    "encrypted_key" BYTEA,
    "wrapped_dek" BYTEA,
    "key_wrapper" TEXT,
    "key_last4" TEXT,
    "base_url" TEXT,
    "models" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "verified_at" TIMESTAMP(3),
    "last_error" TEXT,
    "created_by_id" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ai_provider_configs_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "workspace_ai_policies" (
    "workspace_id" TEXT NOT NULL,
    "allowed_modes" "ai_route"[] DEFAULT ARRAY['PRIVATE']::"ai_route"[],
    "default_mode" "ai_route" NOT NULL DEFAULT 'PRIVATE',
    "default_model" TEXT,
    "confidential_modes" "ai_route"[] DEFAULT ARRAY[]::"ai_route"[],
    "disabled_models" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "updated_by_id" TEXT,
    "updated_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "workspace_ai_policies_pkey" PRIMARY KEY ("workspace_id")
);

-- CreateTable
CREATE TABLE "usage_events" (
    "id" TEXT NOT NULL,
    "workspace_id" TEXT NOT NULL,
    "user_id" TEXT,
    "kind" "usage_kind" NOT NULL,
    "quantity" BIGINT NOT NULL,
    "route" "ai_route",
    "model" TEXT,
    "subject_id" TEXT,
    "at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "usage_events_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "subscriptions" (
    "workspace_id" TEXT NOT NULL,
    "plan" "plan" NOT NULL DEFAULT 'FREE',
    "status" "subscription_status" NOT NULL DEFAULT 'ACTIVE',
    "provider" TEXT NOT NULL,
    "customer_ref" TEXT,
    "external_id" TEXT,
    "current_period_end" TIMESTAMP(3),
    "updated_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "subscriptions_pkey" PRIMARY KEY ("workspace_id")
);

-- CreateTable
CREATE TABLE "billing_events" (
    "id" TEXT NOT NULL,
    "provider" TEXT NOT NULL,
    "type" TEXT NOT NULL,
    "workspace_id" TEXT,
    "received_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "billing_events_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "ai_provider_configs_workspace_id_idx" ON "ai_provider_configs"("workspace_id");

-- CreateIndex
CREATE UNIQUE INDEX "usage_events_kind_subject_id_key" ON "usage_events"("kind", "subject_id");

-- CreateIndex
CREATE INDEX "usage_events_workspace_id_kind_at_idx" ON "usage_events"("workspace_id", "kind", "at");

-- AddForeignKey
ALTER TABLE "ai_provider_configs" ADD CONSTRAINT "ai_provider_configs_workspace_id_fkey" FOREIGN KEY ("workspace_id") REFERENCES "workspaces"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "workspace_ai_policies" ADD CONSTRAINT "workspace_ai_policies_workspace_id_fkey" FOREIGN KEY ("workspace_id") REFERENCES "workspaces"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "usage_events" ADD CONSTRAINT "usage_events_workspace_id_fkey" FOREIGN KEY ("workspace_id") REFERENCES "workspaces"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "subscriptions" ADD CONSTRAINT "subscriptions_workspace_id_fkey" FOREIGN KEY ("workspace_id") REFERENCES "workspaces"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- A key is stored with everything needed to decrypt it, or not at all.
ALTER TABLE "ai_provider_configs" ADD CONSTRAINT "ai_provider_configs_key_complete"
  CHECK ((encrypted_key IS NULL) = (wrapped_dek IS NULL) AND (encrypted_key IS NULL) = (key_wrapper IS NULL));

-- Usage rows are never empty; only storage can go down (a permanent delete).
ALTER TABLE "usage_events" ADD CONSTRAINT "usage_events_quantity"
  CHECK (quantity <> 0 AND (quantity > 0 OR kind = 'STORAGE_BYTES'));

-- Restricted is Private-only in code; the policy can't even name Private as a "confidential mode"
-- twice or list a mode it doesn't allow.
ALTER TABLE "workspace_ai_policies" ADD CONSTRAINT "workspace_ai_policies_default_allowed"
  CHECK (default_mode = ANY (allowed_modes));
ALTER TABLE "workspace_ai_policies" ADD CONSTRAINT "workspace_ai_policies_confidential_allowed"
  CHECK (confidential_modes <@ allowed_modes);
