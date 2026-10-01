-- Extensions used across the app: vector (pgvector) for embeddings, pg_trgm for fuzzy search,
-- citext for case-insensitive emails.
CREATE EXTENSION IF NOT EXISTS "citext";
CREATE EXTENSION IF NOT EXISTS "pg_trgm";
CREATE EXTENSION IF NOT EXISTS "vector";

-- CreateTable
CREATE TABLE "leads" (
    "id" TEXT NOT NULL,
    "email" CITEXT NOT NULL,
    "team_size" TEXT,
    "source" TEXT NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "leads_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "leads_email_key" ON "leads"("email");
