import { randomBytes } from 'node:crypto';
import { readdirSync, readFileSync } from 'node:fs';
import pg from 'pg';

/**
 * A real, minimal PDF with one line of text per page, built in code so tests carry no binary
 * fixture and can say exactly what each page holds.
 */
export function makePdf(pages: string[]): Buffer {
  const objects: string[] = [];
  const add = (body: string) => {
    objects.push(body);
    return objects.length;
  };
  const font = add('<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>');
  const pagesId = objects.length + 1 + pages.length * 2;
  const kids: number[] = [];
  for (const text of pages) {
    const escaped = text.replace(/[\\()]/g, (c) => `\\${c}`);
    const stream = `BT /F1 12 Tf 72 720 Td (${escaped}) Tj ET`;
    const content = add(`<< /Length ${stream.length} >>\nstream\n${stream}\nendstream`);
    kids.push(
      add(
        `<< /Type /Page /Parent ${pagesId} 0 R /MediaBox [0 0 612 792] /Contents ${content} 0 R /Resources << /Font << /F1 ${font} 0 R >> >> >>`,
      ),
    );
  }
  add(`<< /Type /Pages /Kids [${kids.map((k) => `${k} 0 R`).join(' ')}] /Count ${kids.length} >>`);
  const catalog = add(`<< /Type /Catalog /Pages ${pagesId} 0 R >>`);

  let out = '%PDF-1.4\n';
  const offsets: number[] = [];
  objects.forEach((body, i) => {
    offsets.push(Buffer.byteLength(out));
    out += `${i + 1} 0 obj\n${body}\nendobj\n`;
  });
  const xref = Buffer.byteLength(out);
  out += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  for (const offset of offsets) out += `${String(offset).padStart(10, '0')} 00000 n \n`;
  out += `trailer\n<< /Size ${objects.length + 1} /Root ${catalog} 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return Buffer.from(out, 'latin1');
}

export const TEST_DATABASE_URL = process.env.TEST_DATABASE_URL;
export const TEST_S3_ENDPOINT = process.env.TEST_S3_ENDPOINT;

const MIGRATIONS = new URL('../../../packages/db/prisma/migrations/', import.meta.url);

/** A fresh database built from the committed migrations (the api's harness does the same). */
export async function createTestDatabase(): Promise<{
  url: string;
  pgvector: boolean;
  drop: () => Promise<void>;
}> {
  const admin = new URL(TEST_DATABASE_URL!);
  const name = `sotto_wk_${randomBytes(5).toString('hex')}`;
  const root = new pg.Client({ connectionString: admin.toString() });
  await root.connect();
  await root.query(`CREATE DATABASE ${name}`);
  await root.end();
  const url = new URL(admin.toString());
  url.pathname = `/${name}`;
  const db = new pg.Client({ connectionString: url.toString() });
  await db.connect();
  for (const folder of readdirSync(MIGRATIONS, { withFileTypes: true })
    .filter((d) => d.isDirectory())
    .map((d) => d.name)
    .sort()) {
    await db.query(readFileSync(new URL(`${folder}/migration.sql`, MIGRATIONS), 'utf8'));
  }
  // Real pgvector has the hnsw access method; a sandbox stub doesn't.
  const am = await db.query(`SELECT 1 FROM pg_am WHERE amname = 'hnsw'`);
  await db.end();
  return {
    url: url.toString(),
    pgvector: am.rowCount === 1,
    drop: async () => {
      const client = new pg.Client({ connectionString: admin.toString() });
      await client.connect();
      await client.query(`DROP DATABASE IF EXISTS ${name} WITH (FORCE)`);
      await client.end();
    },
  };
}
