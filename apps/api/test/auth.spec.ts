import { createPrismaClient } from '@sotto/db';
import { describe, expect, it } from 'vitest';
import { createAuth, inviteUrl } from '../src/auth/auth.js';
import { csrfToken, verifyCsrfToken } from '../src/auth/csrf.js';
import { atLeast, collectionAccess, type Grant } from '../src/auth/roles.js';
import { apiEnv } from '../src/config.js';
import { UnconfiguredMailer } from '../src/mail/mailer.js';
import { inviteEmail, magicLinkEmail } from '../src/mail/templates.js';

describe('Better Auth and the Prisma schema', () => {
  it('finds every table and column it writes', async () => {
    // Compares the generated client's data model with Better Auth's tables; no database needed.
    const config = apiEnv.parse({ DATABASE_URL: 'postgresql://x:x@localhost:5432/x' });
    const auth = createAuth({
      config,
      prisma: createPrismaClient(config.DATABASE_URL),
      mailer: new UnconfiguredMailer(),
    });
    const context = await auth.$context;
    await expect(Promise.resolve(context.checkSchema?.())).resolves.toBeUndefined();
  });
});

describe('config', () => {
  it('refuses to run production without its own secret', () => {
    const base = { NODE_ENV: 'production', DATABASE_URL: 'postgresql://x' };
    expect(apiEnv.safeParse(base).success).toBe(false);
    expect(
      apiEnv.safeParse({
        ...base,
        AUTH_SECRET: 'sotto-local-development-secret-not-for-production',
      }).success,
    ).toBe(false);
    const ok = apiEnv.parse({ ...base, AUTH_SECRET: 'x'.repeat(40) });
    expect(ok.AUTH_RATE_LIMIT).toBe('on');
  });

  it('defaults to a development secret and no rate limits locally', () => {
    const dev = apiEnv.parse({ DATABASE_URL: 'postgresql://x', SMTP_URL: '  ' });
    expect(dev.AUTH_SECRET.length).toBeGreaterThanOrEqual(32);
    expect(dev.AUTH_RATE_LIMIT).toBe('off');
    expect(dev.SMTP_URL).toBeUndefined();
  });
});

describe('roles', () => {
  it('ranks owner > admin > member > viewer', () => {
    expect(atLeast('owner', 'admin')).toBe(true);
    expect(atLeast('admin', 'owner')).toBe(false);
    expect(atLeast('member', 'member')).toBe(true);
    expect(atLeast('viewer', 'member')).toBe(false);
  });
});

describe('collectionAccess', () => {
  const open = { restricted: false };
  const closed = { restricted: true };
  const person = (role: 'owner' | 'admin' | 'member' | 'viewer') => ({ userId: 'u1', role });
  const grant = (g: Partial<Grant>): Grant => ({ userId: null, role: null, access: 'VIEW', ...g });

  it('gives owners and admins Manage everywhere', () => {
    expect(collectionAccess(person('owner'), closed, [])).toBe('MANAGE');
    expect(collectionAccess(person('admin'), closed, [])).toBe('MANAGE');
  });

  it('lets members edit open collections and viewers view them', () => {
    expect(collectionAccess(person('member'), open, [])).toBe('EDIT');
    expect(collectionAccess(person('viewer'), open, [])).toBe('VIEW');
  });

  it('opens a restricted collection only through a grant', () => {
    expect(collectionAccess(person('member'), closed, [])).toBeNull();
    expect(collectionAccess(person('member'), closed, [grant({ userId: 'u2' })])).toBeNull();
    expect(collectionAccess(person('member'), closed, [grant({ userId: 'u1' })])).toBe('VIEW');
    expect(
      collectionAccess(person('member'), closed, [grant({ role: 'member', access: 'EDIT' })]),
    ).toBe('EDIT');
    expect(collectionAccess(person('member'), closed, [grant({ role: 'viewer' })])).toBeNull();
  });

  it('takes the highest of a person grant and a role grant', () => {
    const grants = [grant({ role: 'member' }), grant({ userId: 'u1', access: 'MANAGE' })];
    expect(collectionAccess(person('member'), closed, grants)).toBe('MANAGE');
    expect(collectionAccess(person('member'), open, grants)).toBe('MANAGE');
  });

  it('never lets a viewer past View', () => {
    expect(
      collectionAccess(person('viewer'), closed, [grant({ userId: 'u1', access: 'MANAGE' })]),
    ).toBe('VIEW');
  });
});

describe('CSRF tokens', () => {
  it('match only their own session and secret', () => {
    const token = csrfToken('s'.repeat(32), 'session-1');
    expect(verifyCsrfToken('s'.repeat(32), 'session-1', token)).toBe(true);
    expect(verifyCsrfToken('s'.repeat(32), 'session-2', token)).toBe(false);
    expect(verifyCsrfToken('t'.repeat(32), 'session-1', token)).toBe(false);
    expect(verifyCsrfToken('s'.repeat(32), 'session-1', undefined)).toBe(false);
    expect(verifyCsrfToken('s'.repeat(32), 'session-1', [token])).toBe(false);
  });
});

describe('emails', () => {
  it('escape names people typed', () => {
    const mail = inviteEmail({
      to: 'tunde@kestrel.example',
      url: inviteUrl('https://sotto.test', 'inv_1'),
      workspaceName: 'Kestrel <script>alert(1)</script>',
      inviterName: 'Ada "the boss" Okafor',
      inviterEmail: 'ada@kestrel.example',
      role: 'member',
      expiresAt: new Date('2026-10-10T12:00:00Z'),
    });
    expect(mail.html).not.toContain('<script>');
    expect(mail.html).toContain('Kestrel &lt;script&gt;');
    expect(mail.subject).toBe(
      'Ada "the boss" Okafor invited you to Kestrel <script>alert(1)</script> on Sotto',
    );
    expect(mail.text).toContain('https://sotto.test/invite/inv_1');
    expect(mail.text).toContain('as a member');
    expect(mail.text).toContain('Saturday 10 October');
  });

  it('keep subjects on one line', () => {
    const mail = inviteEmail({
      to: 'a@b.c',
      url: 'https://sotto.test/invite/x',
      workspaceName: 'Two\r\nBcc: victim@example.com',
      inviterName: 'Ada',
      inviterEmail: 'ada@b.c',
      role: 'viewer',
      expiresAt: new Date(),
    });
    expect(mail.subject).not.toMatch(/[\r\n]/);
  });

  it('show the sign-in link and its expiry', () => {
    const mail = magicLinkEmail({
      email: 'ada@kestrel.example',
      url: 'https://sotto.test/x?token=t',
    });
    expect(mail.text).toContain('https://sotto.test/x?token=t');
    expect(mail.text).toContain('10 minutes');
    expect(mail.html).toContain('href="https://sotto.test/x?token=t"');
  });
});
