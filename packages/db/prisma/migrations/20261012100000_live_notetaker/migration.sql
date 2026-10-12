-- Phase 7: the live notetaker.
-- Listen sessions and their live transcript, calendar connections and the notetaker bot's
-- assignments; FileSource LIVE and BOT; the workspace's switch for bots.
-- Generated with `prisma migrate diff` (minus the hand-written indexes it always reports); the
-- CHECKs at the end are hand-written. (Edited before merge: live_sessions.notes_error. Never
-- deployed before that.)

-- Adding enum values inside the migration's transaction is fine on PostgreSQL 12+; they are
-- only used by later statements' rows, never in this file.
ALTER TYPE "file_source" ADD VALUE IF NOT EXISTS 'LIVE';
ALTER TYPE "file_source" ADD VALUE IF NOT EXISTS 'BOT';

-- CreateEnum
CREATE TYPE "live_source" AS ENUM ('LISTEN', 'BOT');

-- CreateEnum
CREATE TYPE "live_status" AS ENUM ('CONNECTING', 'LIVE', 'ENDED', 'FAILED');

-- CreateEnum
CREATE TYPE "meet_platform" AS ENUM ('MEET', 'ZOOM', 'TEAMS');

-- CreateEnum
CREATE TYPE "bot_status" AS ENUM ('SCHEDULED', 'JOINING', 'IN_CALL', 'DONE', 'SKIPPED', 'FAILED');

-- AlterTable
ALTER TABLE "workspaces" ADD COLUMN     "meeting_bots" BOOLEAN NOT NULL DEFAULT true;

-- CreateTable
CREATE TABLE "live_sessions" (
    "id" TEXT NOT NULL,
    "workspace_id" TEXT NOT NULL,
    "file_id" TEXT NOT NULL,
    "started_by_id" TEXT,
    "source" "live_source" NOT NULL,
    "status" "live_status" NOT NULL DEFAULT 'CONNECTING',
    "inputs" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "next_seq" INTEGER NOT NULL DEFAULT 0,
    "duration_ms" INTEGER NOT NULL DEFAULT 0,
    "notes" JSONB,
    "notes_at" TIMESTAMP(3),
    "notes_model" TEXT,
    "notes_error" TEXT,
    "error" TEXT,
    "last_chunk_at" TIMESTAMP(3),
    "started_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "ended_at" TIMESTAMP(3),

    CONSTRAINT "live_sessions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "live_segments" (
    "id" TEXT NOT NULL,
    "workspace_id" TEXT NOT NULL,
    "session_id" TEXT NOT NULL,
    "seq" INTEGER NOT NULL,
    "idx" INTEGER NOT NULL,
    "start_ms" INTEGER NOT NULL,
    "end_ms" INTEGER NOT NULL,
    "text" TEXT NOT NULL,
    "speaker" TEXT,

    CONSTRAINT "live_segments_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "calendar_connections" (
    "id" TEXT NOT NULL,
    "workspace_id" TEXT NOT NULL,
    "user_id" TEXT NOT NULL,
    "provider" TEXT NOT NULL,
    "account_email" TEXT,
    "encrypted_refresh_token" BYTEA,
    "wrapped_dek" BYTEA,
    "key_wrapper" TEXT,
    "scopes" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "auto_join" BOOLEAN NOT NULL DEFAULT false,
    "last_error" TEXT,
    "synced_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "calendar_connections_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "bot_assignments" (
    "id" TEXT NOT NULL,
    "workspace_id" TEXT NOT NULL,
    "connection_id" TEXT NOT NULL,
    "event_id" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "meeting_url" TEXT NOT NULL,
    "platform" "meet_platform" NOT NULL,
    "status" "bot_status" NOT NULL DEFAULT 'SCHEDULED',
    "provider_ref" TEXT,
    "join_at" TIMESTAMP(3) NOT NULL,
    "ends_at" TIMESTAMP(3),
    "live_session_id" TEXT,
    "error" TEXT,
    "updated_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "bot_assignments_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "live_sessions_file_id_key" ON "live_sessions"("file_id");

-- CreateIndex
CREATE INDEX "live_sessions_workspace_id_status_idx" ON "live_sessions"("workspace_id", "status");

-- CreateIndex
CREATE UNIQUE INDEX "live_segments_session_id_seq_idx_key" ON "live_segments"("session_id", "seq", "idx");

-- CreateIndex
CREATE UNIQUE INDEX "calendar_connections_workspace_id_user_id_provider_key" ON "calendar_connections"("workspace_id", "user_id", "provider");

-- CreateIndex
CREATE UNIQUE INDEX "bot_assignments_live_session_id_key" ON "bot_assignments"("live_session_id");

-- CreateIndex
CREATE INDEX "bot_assignments_status_join_at_idx" ON "bot_assignments"("status", "join_at");

-- CreateIndex
CREATE UNIQUE INDEX "bot_assignments_connection_id_event_id_key" ON "bot_assignments"("connection_id", "event_id");

-- AddForeignKey
ALTER TABLE "live_sessions" ADD CONSTRAINT "live_sessions_workspace_id_fkey" FOREIGN KEY ("workspace_id") REFERENCES "workspaces"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "live_sessions" ADD CONSTRAINT "live_sessions_file_id_fkey" FOREIGN KEY ("file_id") REFERENCES "files"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "live_segments" ADD CONSTRAINT "live_segments_workspace_id_fkey" FOREIGN KEY ("workspace_id") REFERENCES "workspaces"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "live_segments" ADD CONSTRAINT "live_segments_session_id_fkey" FOREIGN KEY ("session_id") REFERENCES "live_sessions"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "calendar_connections" ADD CONSTRAINT "calendar_connections_workspace_id_fkey" FOREIGN KEY ("workspace_id") REFERENCES "workspaces"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "calendar_connections" ADD CONSTRAINT "calendar_connections_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "bot_assignments" ADD CONSTRAINT "bot_assignments_workspace_id_fkey" FOREIGN KEY ("workspace_id") REFERENCES "workspaces"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "bot_assignments" ADD CONSTRAINT "bot_assignments_connection_id_fkey" FOREIGN KEY ("connection_id") REFERENCES "calendar_connections"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "bot_assignments" ADD CONSTRAINT "bot_assignments_live_session_id_fkey" FOREIGN KEY ("live_session_id") REFERENCES "live_sessions"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- Hand-written: values the code relies on.
ALTER TABLE "live_sessions" ADD CONSTRAINT "live_sessions_counters_check"
    CHECK ("next_seq" >= 0 AND "duration_ms" >= 0);
ALTER TABLE "live_segments" ADD CONSTRAINT "live_segments_times_check"
    CHECK ("seq" >= 0 AND "idx" >= 0 AND "start_ms" >= 0 AND "end_ms" >= "start_ms");
-- A refresh token is stored whole (ciphertext, wrapped data key, wrapper) or not at all.
ALTER TABLE "calendar_connections" ADD CONSTRAINT "calendar_connections_token_whole_check"
    CHECK (("encrypted_refresh_token" IS NULL) = ("wrapped_dek" IS NULL)
       AND ("wrapped_dek" IS NULL) = ("key_wrapper" IS NULL));
-- The bot only ever opens HTTPS meeting links.
ALTER TABLE "bot_assignments" ADD CONSTRAINT "bot_assignments_https_check"
    CHECK ("meeting_url" LIKE 'https://%');
