import type { Role } from '@sotto/db';
import type { MailMessage } from './mailer.js';

/**
 * The app's emails. Calm and short, in the product's voice: one action, plain words, the
 * system font, the indigo accent. Plain-text versions carry the same content. Every value that
 * came from a person (names, workspace names) is escaped.
 */

const MINUTES_TO_SIGN_IN = 10;

export const MAGIC_LINK_EXPIRES_IN_SECONDS = MINUTES_TO_SIGN_IN * 60;

function escapeHtml(value: string): string {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');
}

/** One line, no control characters: safe in a subject header. */
function oneLine(value: string, max = 80): string {
  const clean = value.replace(/[\r\n\t]+/g, ' ').trim();
  return clean.length > max ? `${clean.slice(0, max - 1)}…` : clean;
}

const ROLE_PHRASE: Record<Role, string> = {
  owner: 'an owner',
  admin: 'an admin',
  member: 'a member',
  viewer: 'a viewer',
};

function layout({
  preheader,
  title,
  paragraphs,
  action,
  footer,
}: {
  preheader: string;
  title: string;
  paragraphs: string[];
  action: { label: string; url: string };
  footer: string;
}): string {
  const font =
    "-apple-system, BlinkMacSystemFont, 'Segoe UI', Inter, system-ui, Roboto, Helvetica, Arial, sans-serif";
  const body = paragraphs
    .map(
      (p) =>
        `<p style="margin:0 0 16px;font:400 16px/24px ${font};color:#3a3a3c">${escapeHtml(p)}</p>`,
    )
    .join('');
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="color-scheme" content="light">
<title>${escapeHtml(title)}</title>
</head>
<body style="margin:0;padding:0;background:#f2f2f7">
<span style="display:none;max-height:0;overflow:hidden;opacity:0">${escapeHtml(preheader)}</span>
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#f2f2f7">
<tr><td align="center" style="padding:40px 16px">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:480px">
<tr><td style="padding:0 8px 20px;font:600 17px/22px ${font};color:#000">Sotto</td></tr>
<tr><td style="background:#fff;border-radius:16px;padding:32px 28px">
<h1 style="margin:0 0 16px;font:700 22px/28px ${font};color:#000">${escapeHtml(title)}</h1>
${body}
<table role="presentation" cellpadding="0" cellspacing="0" style="margin:8px 0 24px"><tr>
<td style="border-radius:10px;background:#5856d6">
<a href="${escapeHtml(action.url)}" style="display:inline-block;padding:13px 22px;font:600 16px/20px ${font};color:#fff;text-decoration:none;border-radius:10px">${escapeHtml(action.label)}</a>
</td></tr></table>
<p style="margin:0;font:400 13px/18px ${font};color:#6c6c70">Or open this link: <a href="${escapeHtml(action.url)}" style="color:#5856d6;word-break:break-all">${escapeHtml(action.url)}</a></p>
</td></tr>
<tr><td style="padding:20px 8px 0;font:400 13px/18px ${font};color:#6c6c70">${escapeHtml(footer)}</td></tr>
</table>
</td></tr>
</table>
</body>
</html>`;
}

export function magicLinkEmail({ email, url }: { email: string; url: string }): MailMessage {
  const title = 'Sign in to Sotto';
  const lines = [
    `Tap the button to sign in as ${email}. The link works once and expires in ${MINUTES_TO_SIGN_IN} minutes.`,
  ];
  const footer =
    'If you didn’t ask to sign in, ignore this email. Nobody can sign in without the link.';
  return {
    to: email,
    subject: title,
    text: `${title}\n\n${lines.join('\n\n')}\n\n${url}\n\n${footer}\n`,
    html: layout({
      preheader: `Your sign-in link expires in ${MINUTES_TO_SIGN_IN} minutes.`,
      title,
      paragraphs: lines,
      action: { label: 'Sign in', url },
      footer,
    }),
  };
}

export function inviteEmail({
  to,
  url,
  workspaceName,
  inviterName,
  inviterEmail,
  role,
  expiresAt,
}: {
  to: string;
  url: string;
  workspaceName: string;
  inviterName: string;
  inviterEmail: string;
  role: Role;
  expiresAt: Date;
}): MailMessage {
  const workspace = oneLine(workspaceName);
  const inviter = oneLine(inviterName || inviterEmail, 60);
  const title = `Join ${workspace} on Sotto`;
  const expires = expiresAt.toLocaleDateString('en-GB', {
    weekday: 'long',
    day: 'numeric',
    month: 'long',
    timeZone: 'UTC',
  });
  const lines = [
    `${inviter} (${inviterEmail}) invited you to join ${workspace} as ${ROLE_PHRASE[role]}.`,
    'Sotto keeps a team’s memos and meetings in one private place and answers questions with sources.',
    `The invite expires on ${expires}.`,
  ];
  const footer = 'Not expecting this? Ignore it. You won’t join unless you accept.';
  return {
    to,
    subject: `${inviter} invited you to ${workspace} on Sotto`,
    text: `${title}\n\n${lines.join('\n\n')}\n\n${url}\n\n${footer}\n`,
    html: layout({
      preheader: `${inviter} invited you to ${workspace}.`,
      title,
      paragraphs: lines,
      action: { label: 'Accept invite', url },
      footer,
    }),
  };
}
