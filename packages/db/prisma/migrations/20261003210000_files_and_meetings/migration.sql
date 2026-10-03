-- Phase 4: files, meetings, chunks and vectors (PLAN → Data model), plus the Next tables, empty.
-- Prisma's diff, with what Prisma can't express added by hand: the generated tsvector column, its
-- GIN index, a trigram index for searching inside transcripts, and CHECK constraints.
-- Per-model HNSW indexes on chunk_embeddings are created at runtime when an embedding model is
-- first used (packages/db/src/vectors.ts), because each needs that model's dimension.

-- CreateEnum
CREATE TYPE "file_kind" AS ENUM ('DOCUMENT', 'AUDIO', 'NOTE');

-- CreateEnum
CREATE TYPE "file_status" AS ENUM ('UPLOADING', 'UPLOADED', 'TRANSCRIBING', 'INDEXING', 'READY', 'FAILED');

-- CreateEnum
CREATE TYPE "sensitivity" AS ENUM ('INTERNAL', 'CONFIDENTIAL', 'RESTRICTED');

-- CreateEnum
CREATE TYPE "file_source" AS ENUM ('UPLOAD', 'RECORDING', 'SAMPLE', 'IMPORT');

-- CreateEnum
CREATE TYPE "ai_route" AS ENUM ('PRIVATE', 'BYOK', 'MANAGED');

-- CreateEnum
CREATE TYPE "index_status" AS ENUM ('BUILDING', 'READY', 'RETIRED');

-- CreateTable
CREATE TABLE "files" (
    "id" TEXT NOT NULL,
    "workspace_id" TEXT NOT NULL,
    "collection_id" TEXT,
    "owner_id" TEXT,
    "kind" "file_kind" NOT NULL,
    "source" "file_source" NOT NULL DEFAULT 'UPLOAD',
    "title" TEXT NOT NULL,
    "status" "file_status" NOT NULL DEFAULT 'UPLOADING',
    "progress" DOUBLE PRECISION,
    "sensitivity" "sensitivity" NOT NULL DEFAULT 'INTERNAL',
    "storage_key" TEXT NOT NULL,
    "mime" TEXT NOT NULL,
    "size_bytes" BIGINT NOT NULL,
    "checksum" TEXT,
    "duration_ms" INTEGER,
    "page_count" INTEGER,
    "pinned" BOOLEAN NOT NULL DEFAULT false,
    "tags" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "error" TEXT,
    "upload_id" TEXT,
    "part_size" INTEGER,
    "integration_id" TEXT,
    "deleted_at" TIMESTAMP(3),
    "status_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "files_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "transcripts" (
    "id" TEXT NOT NULL,
    "workspace_id" TEXT NOT NULL,
    "file_id" TEXT NOT NULL,
    "language" TEXT NOT NULL,
    "engine" TEXT NOT NULL,
    "model" TEXT NOT NULL,
    "is_mock" BOOLEAN NOT NULL DEFAULT false,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "transcripts_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "transcript_segments" (
    "id" TEXT NOT NULL,
    "workspace_id" TEXT NOT NULL,
    "transcript_id" TEXT NOT NULL,
    "idx" INTEGER NOT NULL,
    "speaker" TEXT,
    "start_ms" INTEGER NOT NULL,
    "end_ms" INTEGER NOT NULL,
    "text" TEXT NOT NULL,

    CONSTRAINT "transcript_segments_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "meeting_insights" (
    "id" TEXT NOT NULL,
    "workspace_id" TEXT NOT NULL,
    "file_id" TEXT NOT NULL,
    "summary" TEXT NOT NULL,
    "decisions" JSONB NOT NULL,
    "action_items" JSONB NOT NULL,
    "open_questions" JSONB NOT NULL,
    "chapters" JSONB NOT NULL,
    "model" TEXT NOT NULL,
    "route" "ai_route" NOT NULL,
    "is_mock" BOOLEAN NOT NULL DEFAULT false,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "meeting_insights_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "playback_positions" (
    "user_id" TEXT NOT NULL,
    "file_id" TEXT NOT NULL,
    "workspace_id" TEXT NOT NULL,
    "position_ms" INTEGER NOT NULL,
    "updated_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "playback_positions_pkey" PRIMARY KEY ("user_id","file_id")
);

-- CreateTable
CREATE TABLE "chunks" (
    "id" TEXT NOT NULL,
    "workspace_id" TEXT NOT NULL,
    "file_id" TEXT NOT NULL,
    "collection_id" TEXT,
    "sensitivity" "sensitivity" NOT NULL,
    "idx" INTEGER NOT NULL,
    "text" TEXT NOT NULL,
    "token_count" INTEGER NOT NULL,
    "page" INTEGER,
    "start_ms" INTEGER,
    "end_ms" INTEGER,
    -- Keyword search (Phase 5): kept in step with "text" by Postgres itself. 'simple' rather than
    -- 'english' so names, codes and other languages aren't stemmed away.
    "tsv" tsvector GENERATED ALWAYS AS (to_tsvector('simple', "text")) STORED,

    CONSTRAINT "chunks_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "chunk_embeddings" (
    "chunk_id" TEXT NOT NULL,
    "model" TEXT NOT NULL,
    "workspace_id" TEXT NOT NULL,
    "dims" INTEGER NOT NULL,
    "embedding" vector NOT NULL,

    CONSTRAINT "chunk_embeddings_pkey" PRIMARY KEY ("chunk_id","model")
);

-- CreateTable
CREATE TABLE "embedding_indexes" (
    "model" TEXT NOT NULL,
    "dims" INTEGER NOT NULL,
    "status" "index_status" NOT NULL DEFAULT 'BUILDING',
    "serving" BOOLEAN NOT NULL DEFAULT false,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "embedding_indexes_pkey" PRIMARY KEY ("model")
);

-- CreateTable
CREATE TABLE "integrations" (
    "id" TEXT NOT NULL,
    "workspace_id" TEXT NOT NULL,
    "provider" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'disconnected',
    "config" JSONB,
    "created_by_id" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "integrations_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "retention_policies" (
    "id" TEXT NOT NULL,
    "workspace_id" TEXT NOT NULL,
    "collection_id" TEXT,
    "keep_days" INTEGER NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "retention_policies_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "legal_holds" (
    "id" TEXT NOT NULL,
    "workspace_id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "file_ids" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "created_by_id" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "released_at" TIMESTAMP(3),

    CONSTRAINT "legal_holds_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "files_storage_key_key" ON "files"("storage_key");

-- CreateIndex
CREATE INDEX "files_workspace_id_deleted_at_created_at_idx" ON "files"("workspace_id", "deleted_at", "created_at" DESC);

-- CreateIndex
CREATE INDEX "files_workspace_id_collection_id_idx" ON "files"("workspace_id", "collection_id");

-- CreateIndex
CREATE INDEX "files_workspace_id_status_idx" ON "files"("workspace_id", "status");

-- CreateIndex
CREATE INDEX "files_workspace_id_checksum_idx" ON "files"("workspace_id", "checksum");

-- CreateIndex
CREATE UNIQUE INDEX "transcripts_file_id_key" ON "transcripts"("file_id");

-- CreateIndex
CREATE INDEX "transcript_segments_transcript_id_start_ms_idx" ON "transcript_segments"("transcript_id", "start_ms");

-- CreateIndex
CREATE UNIQUE INDEX "transcript_segments_transcript_id_idx_key" ON "transcript_segments"("transcript_id", "idx");

-- CreateIndex
CREATE UNIQUE INDEX "meeting_insights_file_id_key" ON "meeting_insights"("file_id");

-- CreateIndex
CREATE INDEX "playback_positions_workspace_id_user_id_updated_at_idx" ON "playback_positions"("workspace_id", "user_id", "updated_at" DESC);

-- CreateIndex
CREATE INDEX "chunks_workspace_id_collection_id_sensitivity_idx" ON "chunks"("workspace_id", "collection_id", "sensitivity");

-- CreateIndex
CREATE UNIQUE INDEX "chunks_file_id_idx_key" ON "chunks"("file_id", "idx");

-- CreateIndex
CREATE INDEX "chunk_embeddings_workspace_id_model_idx" ON "chunk_embeddings"("workspace_id", "model");

-- CreateIndex
CREATE INDEX "integrations_workspace_id_idx" ON "integrations"("workspace_id");

-- CreateIndex
CREATE INDEX "retention_policies_workspace_id_idx" ON "retention_policies"("workspace_id");

-- CreateIndex
CREATE INDEX "legal_holds_workspace_id_idx" ON "legal_holds"("workspace_id");

-- AddForeignKey
ALTER TABLE "files" ADD CONSTRAINT "files_workspace_id_fkey" FOREIGN KEY ("workspace_id") REFERENCES "workspaces"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "files" ADD CONSTRAINT "files_collection_id_fkey" FOREIGN KEY ("collection_id") REFERENCES "collections"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "files" ADD CONSTRAINT "files_owner_id_fkey" FOREIGN KEY ("owner_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "files" ADD CONSTRAINT "files_integration_id_fkey" FOREIGN KEY ("integration_id") REFERENCES "integrations"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "transcripts" ADD CONSTRAINT "transcripts_workspace_id_fkey" FOREIGN KEY ("workspace_id") REFERENCES "workspaces"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "transcripts" ADD CONSTRAINT "transcripts_file_id_fkey" FOREIGN KEY ("file_id") REFERENCES "files"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "transcript_segments" ADD CONSTRAINT "transcript_segments_workspace_id_fkey" FOREIGN KEY ("workspace_id") REFERENCES "workspaces"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "transcript_segments" ADD CONSTRAINT "transcript_segments_transcript_id_fkey" FOREIGN KEY ("transcript_id") REFERENCES "transcripts"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "meeting_insights" ADD CONSTRAINT "meeting_insights_workspace_id_fkey" FOREIGN KEY ("workspace_id") REFERENCES "workspaces"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "meeting_insights" ADD CONSTRAINT "meeting_insights_file_id_fkey" FOREIGN KEY ("file_id") REFERENCES "files"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "playback_positions" ADD CONSTRAINT "playback_positions_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "playback_positions" ADD CONSTRAINT "playback_positions_file_id_fkey" FOREIGN KEY ("file_id") REFERENCES "files"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "playback_positions" ADD CONSTRAINT "playback_positions_workspace_id_fkey" FOREIGN KEY ("workspace_id") REFERENCES "workspaces"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "chunks" ADD CONSTRAINT "chunks_workspace_id_fkey" FOREIGN KEY ("workspace_id") REFERENCES "workspaces"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "chunks" ADD CONSTRAINT "chunks_file_id_fkey" FOREIGN KEY ("file_id") REFERENCES "files"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "chunk_embeddings" ADD CONSTRAINT "chunk_embeddings_chunk_id_fkey" FOREIGN KEY ("chunk_id") REFERENCES "chunks"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "chunk_embeddings" ADD CONSTRAINT "chunk_embeddings_workspace_id_fkey" FOREIGN KEY ("workspace_id") REFERENCES "workspaces"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "integrations" ADD CONSTRAINT "integrations_workspace_id_fkey" FOREIGN KEY ("workspace_id") REFERENCES "workspaces"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "retention_policies" ADD CONSTRAINT "retention_policies_workspace_id_fkey" FOREIGN KEY ("workspace_id") REFERENCES "workspaces"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "legal_holds" ADD CONSTRAINT "legal_holds_workspace_id_fkey" FOREIGN KEY ("workspace_id") REFERENCES "workspaces"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- Hand-written ----------------------------------------------------------------------------------

CREATE INDEX "chunks_tsv_idx" ON "chunks" USING GIN ("tsv");

-- "Search in transcript" matches substrings anywhere in a line, so trigrams rather than tsvector.
CREATE INDEX "transcript_segments_text_trgm_idx" ON "transcript_segments" USING GIN ("text" gin_trgm_ops);

ALTER TABLE "files" ADD CONSTRAINT "files_progress_range" CHECK ("progress" IS NULL OR ("progress" >= 0 AND "progress" <= 1));
ALTER TABLE "files" ADD CONSTRAINT "files_size_nonnegative" CHECK ("size_bytes" >= 0);
ALTER TABLE "transcript_segments" ADD CONSTRAINT "transcript_segments_times" CHECK ("start_ms" >= 0 AND "end_ms" >= "start_ms");
ALTER TABLE "chunk_embeddings" ADD CONSTRAINT "chunk_embeddings_dims_positive" CHECK ("dims" > 0);
