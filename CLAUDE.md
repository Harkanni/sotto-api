# Sotto — agent context (sotto-api)

Backend monorepo for **Sotto**: NestJS api, Node worker, Python transcriber and the Prisma database package.

This repo is one of three, cloned side by side under one folder:
`sotto-platform/` (docs hub, infra), `sotto-api/`, `sotto-web/`.

## Read first

1. `../sotto-platform/docs/STATUS.md` — where the build is and the exact next step. **Start here.**
2. `../sotto-platform/docs/PLAN.md` — the approved plan (wins over the brief where they differ).
3. `../sotto-platform/docs/BRIEF.md` — product, design system, UX rules, quality bar.
4. `../sotto-platform/CLAUDE.md` — working rules shared by all three repos.

If `../sotto-platform` isn't there, clone it: `git clone https://github.com/Harkanni/sotto-platform.git ../sotto-platform`.

## Layout

| Path | Holds |
| --- | --- |
| `apps/api` | NestJS REST + SSE/WebSocket API (`/api/v1`), OpenAPI generated from code |
| `apps/worker` | Queue consumer: extraction, chunking, embeddings, meeting insights |
| `services/transcriber` | Python FastAPI service; engine chosen by `TRANSCRIBER_ENGINE`; never touches the DB |
| `packages/db` | Prisma 7 schema, migrations, seed, tenant extension |
| `packages/ai` | Provider interfaces + registry (chat, embeddings, transcription, diarization, meeting bot) |
| `packages/contracts` | Zod schemas for queue messages and shared types |
| `packages/config` | Env parsing and shared tooling config |

## Rules for this repo

- Every tenant table has `workspaceId`; queries go through the tenant-scoped Prisma client, never the raw one.
- Permission and sensitivity filters are applied **inside** SQL for retrieval, never after.
- Logs, traces and metrics never contain document text, prompts, answers or keys.
- No AI vendor is imported outside `packages/ai` adapters.
- Relative imports use `.js` extensions (ESM, `module: nodenext`).
- `main` only changes through PRs with green CI; the owner merges.
- Every PR also updates `sotto-platform/docs/STATUS.md` (companion PR or note).
- Only `.env.example` is committed. Never secrets.
