#!/bin/sh
# Apply pending database migrations. Runs once per deploy, before the new api starts:
#   docker run --rm -e DATABASE_URL=... <api image> sh scripts/migrate.sh
# Why a script: in the slim runtime image the Prisma CLI is a nested dependency of @sotto/db,
# so we call it by path instead of relying on a global binary.
set -e
cd /app/node_modules/@sotto/db
exec node /app/node_modules/.pnpm/prisma@*/node_modules/prisma/build/index.js migrate deploy
