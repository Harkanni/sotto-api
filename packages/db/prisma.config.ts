// Prisma 7 reads connection settings from this file instead of schema.prisma.
// `prisma generate` needs no database, so a placeholder URL keeps it working in CI and Docker
// builds; migrate and runtime always get the real DATABASE_URL from the environment.
import { defineConfig } from 'prisma/config';

export default defineConfig({
  schema: 'prisma/schema.prisma',
  migrations: {
    path: 'prisma/migrations',
  },
  datasource: {
    url:
      process.env.DATABASE_URL ?? 'postgresql://placeholder:placeholder@localhost:5432/placeholder',
  },
});
