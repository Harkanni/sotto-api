-- Phase 5: Ask and search. Chats (conversations, messages, citations) and notes.
-- Prisma's diff, with what Prisma can't express added by hand at the end: trigram indexes for
-- searching chat history and file titles, and CHECK constraints.

-- AlterEnum: notes are written in Sotto.
ALTER TYPE "file_source" ADD VALUE 'WRITTEN';

-- CreateEnum
CREATE TYPE "message_role" AS ENUM ('USER', 'ASSISTANT');

-- CreateEnum
CREATE TYPE "message_status" AS ENUM ('STREAMING', 'DONE', 'STOPPED', 'FAILED');

-- CreateTable
CREATE TABLE "conversations" (
    "id" TEXT NOT NULL,
    "workspace_id" TEXT NOT NULL,
    "user_id" TEXT NOT NULL,
    "title" TEXT NOT NULL DEFAULT '',
    "scope" JSONB NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "conversations_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "messages" (
    "id" TEXT NOT NULL,
    "workspace_id" TEXT NOT NULL,
    "conversation_id" TEXT NOT NULL,
    "role" "message_role" NOT NULL,
    "content" TEXT NOT NULL DEFAULT '',
    "status" "message_status" NOT NULL DEFAULT 'DONE',
    "model" TEXT,
    "route" "ai_route",
    "route_label" TEXT,
    "is_mock" BOOLEAN NOT NULL DEFAULT false,
    "hidden_restricted" INTEGER NOT NULL DEFAULT 0,
    "hidden_confidential" INTEGER NOT NULL DEFAULT 0,
    "not_found" BOOLEAN NOT NULL DEFAULT false,
    "follow_ups" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "error" TEXT,
    "input_tokens" INTEGER,
    "output_tokens" INTEGER,
    "feedback" INTEGER,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "messages_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "citations" (
    "id" TEXT NOT NULL,
    "workspace_id" TEXT NOT NULL,
    "message_id" TEXT NOT NULL,
    "n" INTEGER NOT NULL,
    "chunk_id" TEXT,
    "file_id" TEXT,
    "title" TEXT NOT NULL,
    "page" INTEGER,
    "start_ms" INTEGER,
    "end_ms" INTEGER,
    "quote" TEXT NOT NULL,

    CONSTRAINT "citations_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "notes" (
    "id" TEXT NOT NULL,
    "workspace_id" TEXT NOT NULL,
    "file_id" TEXT NOT NULL,
    "body" TEXT NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "notes_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "conversations_workspace_id_user_id_updated_at_idx" ON "conversations"("workspace_id", "user_id", "updated_at" DESC);

-- CreateIndex
CREATE INDEX "messages_conversation_id_created_at_idx" ON "messages"("conversation_id", "created_at");

-- CreateIndex
CREATE INDEX "citations_file_id_idx" ON "citations"("file_id");

-- CreateIndex
CREATE UNIQUE INDEX "citations_message_id_n_key" ON "citations"("message_id", "n");

-- CreateIndex
CREATE UNIQUE INDEX "notes_file_id_key" ON "notes"("file_id");

-- AddForeignKey
ALTER TABLE "conversations" ADD CONSTRAINT "conversations_workspace_id_fkey" FOREIGN KEY ("workspace_id") REFERENCES "workspaces"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "conversations" ADD CONSTRAINT "conversations_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "messages" ADD CONSTRAINT "messages_workspace_id_fkey" FOREIGN KEY ("workspace_id") REFERENCES "workspaces"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "messages" ADD CONSTRAINT "messages_conversation_id_fkey" FOREIGN KEY ("conversation_id") REFERENCES "conversations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "citations" ADD CONSTRAINT "citations_workspace_id_fkey" FOREIGN KEY ("workspace_id") REFERENCES "workspaces"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "citations" ADD CONSTRAINT "citations_message_id_fkey" FOREIGN KEY ("message_id") REFERENCES "messages"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "citations" ADD CONSTRAINT "citations_chunk_id_fkey" FOREIGN KEY ("chunk_id") REFERENCES "chunks"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "citations" ADD CONSTRAINT "citations_file_id_fkey" FOREIGN KEY ("file_id") REFERENCES "files"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "notes" ADD CONSTRAINT "notes_workspace_id_fkey" FOREIGN KEY ("workspace_id") REFERENCES "workspaces"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "notes" ADD CONSTRAINT "notes_file_id_fkey" FOREIGN KEY ("file_id") REFERENCES "files"("id") ON DELETE CASCADE ON UPDATE CASCADE;


-- Hand-written ----------------------------------------------------------------------------------

-- "Search your chats" matches words anywhere in a title or a message, so trigrams.
CREATE INDEX "conversations_title_trgm_idx" ON "conversations" USING GIN ("title" gin_trgm_ops);
CREATE INDEX "messages_content_trgm_idx" ON "messages" USING GIN ("content" gin_trgm_ops);

-- Search finds files by title too; trigrams make "pricing" find "Pricing review notes".
CREATE INDEX "files_title_trgm_idx" ON "files" USING GIN ("title" gin_trgm_ops);

ALTER TABLE "messages" ADD CONSTRAINT "messages_feedback_range" CHECK ("feedback" IS NULL OR "feedback" IN (-1, 0, 1));
ALTER TABLE "messages" ADD CONSTRAINT "messages_hidden_nonnegative" CHECK ("hidden_restricted" >= 0 AND "hidden_confidential" >= 0);
ALTER TABLE "citations" ADD CONSTRAINT "citations_n_positive" CHECK ("n" > 0);
