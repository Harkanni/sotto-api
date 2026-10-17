# Sotto — working instructions (sotto-api)

Read this first, in every session. It is permanent: how this backend is built and how to keep
building it, whatever the phase.

## What Sotto is

Private AI for a team's memos and meetings: internal teams upload documents and recordings, ask
questions, get answers with sources, and control exactly where their data goes. The owner is
Akanni Emmanuel (GitHub `Harkanni`); he reviews and merges every pull request.

Three repos, cloned side by side: `sotto-web` (Next.js app, design system), `sotto-api` (here)
and `sotto-platform` (docs hub, Compose, Terraform, demo deploys). A missing sibling:
`git clone https://github.com/Harkanni/<repo>.git ../<repo>`. This repo is public: every commit,
not just the latest files, can be read by anyone.

## Start of every session: recover, then continue

1. Read this file, then `../sotto-platform/docs/STATUS.md` (active branches and PRs).
2. Read the current phase's log: `../sotto-web/PHASE_<n>_PROGRESS.md` on the branch STATUS
   names. One log covers all three repos.
3. In all three repos: `git fetch`, `git status`, `git log --oneline -15`; read open PR
   checklists.
4. Compare the log with the code; where they disagree, investigate and correct the log first.
5. Continue from the first unfinished task. Never restart a phase, repeat finished work or
   replace working code without a clear technical reason; finish interrupted tasks.

`../sotto-platform/docs/PLAN.md` is the approved plan (it wins over `BRIEF.md`); ADRs in
`../sotto-platform/docs/adr/` record decisions a later session must not silently undo.

## Architecture

| Path                   | Holds                                                                                |
| ---------------------- | ------------------------------------------------------------------------------------ |
| `apps/api`             | NestJS 12: REST under `/api/v1` (OpenAPI from code), Better Auth under `/api/auth/*` |
| `apps/worker`          | Queue consumer: extraction, chunking, embeddings, meeting insights                   |
| `services/transcriber` | Python FastAPI; engine chosen by `TRANSCRIBER_ENGINE`; never touches the database    |
| `packages/db`          | Prisma 7 schema, migrations, client factory, tenant-scoped client                    |
| `packages/ai`          | Provider interfaces and registry (chat, embeddings, transcription, diarization, bot) |
| `packages/contracts`   | Zod schemas for queue messages and shared types                                      |
| `packages/config`      | Validated environment loading                                                        |

- The browser reaches the api only through the same origin (`/api/*` via the gateway or Next's
  rewrite). Sessions are Better Auth cookies; the active workspace lives on the session.
- Postgres 18 + pgvector, Redis (rate limits, cache), RabbitMQ (jobs), S3-compatible storage.

## Rules

- **Tenancy.** Every tenant table has `workspaceId`. Request code reads and writes tenant data
  through the tenant-scoped client (`forWorkspace(prisma, workspaceId)`), never the raw one. The
  workspace comes from the session, never from the URL or body.
- **Permissions inside SQL.** Collection access and sensitivity filters are part of the query,
  never applied to results afterwards.
- **Writes** need the session cookie and the `X-CSRF-Token` from `GET /me`, on top of Nest's
  cross-origin protection.
- **Audit.** Every change to members, invites, roles, collections, permissions and settings
  writes an `AuditLog` row (who, what, target, IP; never content).
- **Privacy.** Logs, traces and metrics never contain document text, prompts, answers, tokens,
  magic links or keys. Errors are reported by code.
- **AI vendors** are imported only inside `packages/ai` adapters.
- Ask before adding a paid service. Label every mock; never stub silently.

## Conventions

- ESM with `module: nodenext`: relative imports end in `.js`.
- Transactions on tenant data use `tenantTransaction(db, fn)` from `@sotto/db`; calling
  `$transaction` on the extended client directly makes `tsc` crawl for minutes.
- Request bodies and queries are Zod schemas passed as `@Body({ schema })` /
  `@Query({ schema })` (Nest 12 Standard Schema validation); the same schemas feed OpenAPI.
- Errors use `{ error: { code, message, requestId } }`; messages are written for people,
  because the web shows them.
- Schema changes: edit `schema.prisma`, write the migration SQL (Prisma's diff, or raw SQL for
  extensions, vectors and generated columns), commit both. Migrations never edit old files.
- `openapi.json` is generated (`pnpm openapi`) and committed; sotto-web builds its client from it.
- Comments explain why. Dockerfiles and Compose files carry short "why" notes (teaching mode).

## Tests: run before every commit

`pnpm lint`, `pnpm format:check`, `pnpm typecheck`, `pnpm test`, `pnpm build`, and `pnpm
openapi` when routes change. Integration tests (`apps/api/test/integration`) need a real
Postgres: set `TEST_DATABASE_URL` (CI starts `compose.deps.yaml`; locally `pnpm deps:up`).
New endpoints get integration tests covering each role, including the ones that must be refused.
Never claim a check ran unless it did; record runs in the phase log.

CI/CD is GitHub Actions, `.github/workflows/pipeline.yml` (ADR 0034; Jenkins is gone): secrets
scan (the files and every commit), lint, typecheck, unit and integration tests, `openapi.json`
drift, the transcriber's pytest, an arm64 image smoke test, the 30-minute ingestion check and the
eval set; on `main`, after all of them pass, the image push and the demo deploy.

Agent sandbox: run pnpm with `npm_config_manage_package_manager_versions=false`; install
dependencies with `pnpm install` and commit `pnpm-lock.yaml` with the change (`scripts/agent-deps.sh`
restores an old `dev-cache` snapshot when the registry is unreachable).

## Git and checkpoints

- `main` changes only through PRs with green CI; the owner merges. Never merge your own PR,
  force-push or rewrite history. Branches `feat/p<phase>-<slice>`, `fix/…`, `chore/…`;
  Conventional Commits.
- Work in progress lives on a pushed branch with a draft PR whose description is a checklist.
  Checkpoint after every logically complete task: checks, phase log, commit, push.
- Before each commit, read the diff for accidental changes and secrets. Only `.env.example` is
  committed. The deploy job reaches AWS with an IAM access key kept as GitHub Actions secrets
  (ADR 0007); don't reintroduce OIDC. Pull requests never get secrets: keep it that way (no
  `pull_request_target`, no secrets in PR jobs).
- API + web changes are paired PRs; this one merges first. Every PR has a companion
  `../sotto-platform/docs/STATUS.md` update.
