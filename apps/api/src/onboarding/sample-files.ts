/**
 * The fictional sample workspace, Kestrel Labs (ADR 0013): memos and meetings that onboarding
 * turns into real files, so search, citations and permissions work on them exactly as on the
 * team's own. Every one is `source: SAMPLE`; the web labels them. Sample meetings have a
 * transcript and notes but no audio.
 *
 * Collection keys match SAMPLE_COLLECTIONS. Times are milliseconds from the start.
 */
import type { MeetingInsightsBody } from '@sotto/contracts';
import type { Sensitivity } from '@sotto/db';

export interface SampleDoc {
  key: string;
  title: string;
  collection: 'product' | 'customers' | 'board' | 'handbook';
  sensitivity: Sensitivity;
  pinned?: boolean;
  tags?: string[];
  /** Markdown. */
  body: string;
}

export interface SampleMeeting {
  key: string;
  title: string;
  collection: 'product' | 'customers' | 'board' | 'handbook';
  sensitivity: Sensitivity;
  pinned?: boolean;
  /** [mm:ss, speaker, text] */
  lines: [string, string, string][];
  notes: MeetingInsightsBody;
}

export const SAMPLE_DOCS: SampleDoc[] = [
  {
    key: 'roadmap',
    title: 'Q4 roadmap memo',
    collection: 'product',
    sensitivity: 'INTERNAL',
    pinned: true,
    tags: ['roadmap'],
    body: `# Q4 roadmap

This quarter we focus on three outcomes: first answers in under two seconds, meeting notes that need no editing, and onboarding a ten-person team in one afternoon.

## Answers first

Field teams told us they stop trusting a tool the moment it guesses. Every answer must cite the page or the minute it came from, and say plainly when the sources are thin. Target: the first token of an answer in under two seconds for a workspace of 5,000 documents.

## Meetings second

The notetaker should join on its own, capture who said what, and turn decisions into action items with owners. Editing a summary should be the exception, not the routine.

## Onboarding third

A new workspace should import the team's existing memos in one step and be useful the same day.

## Out of scope

Public sharing, a desktop app, and integrations beyond calendar and storage.`,
  },
  {
    key: 'launch',
    title: 'Lagos launch plan',
    collection: 'product',
    sensitivity: 'CONFIDENTIAL',
    tags: ['launch'],
    body: `# Lagos launch plan

The Lagos launch is planned for the first week of November with five design partners from logistics and health.

## Risks

1. Unreliable connectivity on field visits. Recording must work offline and upload when the network returns. Owner: Tunde.
2. Data residency questions from health partners. We need a clear answer on where audio and transcripts are stored. Owner: Ada.
3. Pricing in naira. Paystack covers local cards; we still need a policy for exchange-rate changes. Owner: Jonas.

## Timeline

- 6 October: partner contracts signed.
- 20 October: offline recording in the beta.
- 3 November: launch with all five partners.`,
  },
  {
    key: 'pricing',
    title: 'Pricing review notes',
    collection: 'product',
    sensitivity: 'CONFIDENTIAL',
    tags: ['pricing'],
    body: `# Pricing review

We reviewed three tiers against the interviews from August. Teams under ten people care about the monthly price; larger teams care about where their data lives.

Decision: keep the free tier at three members, move private AI into Team, and price Business per seat with an annual discount.

Open question: whether bring-your-own-key customers should pay less. Jonas will bring two customer quotes to the next workshop.`,
  },
  {
    key: 'security',
    title: 'Security questionnaire answers',
    collection: 'customers',
    sensitivity: 'CONFIDENTIAL',
    pinned: true,
    tags: ['security'],
    body: `# Security questionnaire: standard answers

## Encryption

Files, audio and transcripts are encrypted at rest with AWS-managed keys and in transit with TLS 1.2 or later.

## Data residency

Customer data is stored in the London region (eu-west-2). Backups stay in the same region.

## Access

Sign-in supports passkeys, email links, Google and Microsoft. Every change to members, roles and access is written to an audit log that admins can export.

## AI providers

In Private mode, questions are answered by models hosted in our own infrastructure and are never sent to a third-party AI provider. Restricted documents are only ever read by private models.`,
  },
  {
    key: 'support',
    title: 'Support playbook',
    collection: 'customers',
    sensitivity: 'INTERNAL',
    body: `# Support playbook

Answer every request within one working day. Say what happened, what we're doing, and when the customer will hear from us next.

Escalate to engineering when a customer can't sign in, can't upload, or sees someone else's data. The last one is a security incident: page the on-call engineer immediately.

Close a request only when the customer confirms it's fixed, or after five working days without a reply.`,
  },
  {
    key: 'board',
    title: 'Board update, September',
    collection: 'board',
    sensitivity: 'RESTRICTED',
    tags: ['board'],
    body: `# Board update: September

Revenue grew 18% on the previous quarter, driven by three new Business customers. Monthly burn is steady; runway is 21 months at the current plan.

We plan to hire two engineers and a product designer before January. The Lagos launch is on track for November; the main risk is offline recording, now a launch requirement.

We ask the board to approve the hiring plan and a budget of 40,000 pounds for the launch.`,
  },
  {
    key: 'onboarding',
    title: 'New hire onboarding checklist',
    collection: 'handbook',
    sensitivity: 'INTERNAL',
    body: `# Week one

- Day one: accounts for email, chat and Sotto; a laptop set up by Operations.
- Meet your manager and your buddy; your buddy answers the questions you don't want to ask in a channel.
- Read the Q4 roadmap memo and the brand voice guide.
- By Friday: ship one small change, and write down three things that confused you.`,
  },
  {
    key: 'voice',
    title: 'Brand voice guide',
    collection: 'handbook',
    sensitivity: 'INTERNAL',
    body: `# How we write

Plain words, short sentences, no exclamation marks. Say what something does, not how amazing it is. A button says what it does and the confirmation echoes it: "Send invite", then "Invite sent".

When something goes wrong, say what happened and what to do next. Don't apologise in error messages; fix the problem the message describes.`,
  },
];

const WEEKLY: [string, string, string][] = [
  ['0:12', 'Amaka', 'Let’s start with the launch. Where are we on the design partners?'],
  ['0:31', 'Ada', 'Four of five have signed. The fifth wants an answer on data residency first.'],
  [
    '0:58',
    'Tunde',
    'Audio and transcripts stay in London. I can put that in writing for them this week.',
  ],
  ['1:20', 'Amaka', 'Good. Send it to Ada and she’ll forward it with the contract.'],
  [
    '1:36',
    'Sofia',
    'On the app, the Ask composer is ready for review. I’d like ten minutes with the field team.',
  ],
  [
    '2:20',
    'Priya',
    'Two interviews mentioned offline recording again. It’s the most common request.',
  ],
  ['3:08', 'Amaka', 'Then offline recording is a launch requirement, not a nice-to-have.'],
  ['3:50', 'Tunde', 'Agreed. It means queueing uploads on the device. Two weeks of work.'],
  ['4:28', 'Ada', 'I’ll update the launch plan and flag the risk in the board update.'],
  ['5:02', 'Priya', 'Should we test offline mode with the health partners before launch?'],
  ['5:30', 'Amaka', 'Yes, if Tunde has a build by the twentieth. Let’s decide next week.'],
];

const CUSTOMER: [string, string, string][] = [
  ['0:05', 'Jonas', 'Thanks for making time. Can you tell us how your clinics handle notes today?'],
  [
    '0:40',
    'Bluebird',
    'Doctors record voice memos on their phones and a nurse types them up at night.',
  ],
  ['1:32', 'Ada', 'And who needs to find them later?'],
  [
    '1:45',
    'Bluebird',
    'Our compliance team. They need to see who opened what, so audit logs are a must before rollout.',
  ],
  ['2:40', 'Jonas', 'Audit logs ship today, with an export for your compliance team.'],
  ['3:15', 'Bluebird', 'Then we’d like to pilot with two clinics in November.'],
  ['3:42', 'Ada', 'I’ll send a pilot plan by Friday, with the data residency answer in writing.'],
];

const ALLHANDS: [string, string, string][] = [
  [
    '0:10',
    'Amaka',
    'Welcome, everyone. Quick numbers first: revenue is up eighteen percent on last quarter.',
  ],
  ['0:48', 'Amaka', 'Three Business customers signed, and churn stayed under two percent.'],
  [
    '1:30',
    'Kwame',
    'Hiring: two engineers and a designer before January. Please send referrals my way.',
  ],
  [
    '2:25',
    'Tunde',
    'Engineering shipped accounts and permissions; ingestion and meetings are next.',
  ],
  ['3:10', 'Sofia', 'Design is focused on the phone first. Everything should work with one hand.'],
  ['4:02', 'Priya', 'What happens to the offsite budget if we hire three people?'],
  ['4:30', 'Amaka', 'The offsite stays. Kwame will book the venue this month.'],
];

export const SAMPLE_MEETINGS: SampleMeeting[] = [
  {
    key: 'weekly',
    title: 'Weekly product sync',
    collection: 'product',
    sensitivity: 'INTERNAL',
    pinned: true,
    lines: WEEKLY,
    notes: {
      summary:
        'Four of five Lagos design partners have signed; the fifth is waiting on data residency. Audio and transcripts stay in London, and offline recording is now a launch requirement.',
      decisions: [
        'Offline recording is a launch requirement.',
        'Tunde confirms data residency in writing this week.',
      ],
      actionItems: [
        {
          text: 'Confirm data residency in writing for the fifth partner',
          owner: 'Tunde',
          due: 'this week',
          atMs: 58_000,
        },
        {
          text: 'Update the launch plan and flag the offline risk in the board update',
          owner: 'Ada',
          due: null,
          atMs: 268_000,
        },
        {
          text: 'Review the Ask composer with the field team',
          owner: 'Sofia',
          due: null,
          atMs: 96_000,
        },
      ],
      openQuestions: ['Should offline mode be tested with the health partners before launch?'],
      chapters: [
        { title: 'Launch status', startMs: 0 },
        { title: 'Ask composer review', startMs: 96_000 },
        { title: 'Offline recording', startMs: 140_000 },
        { title: 'Next steps', startMs: 268_000 },
      ],
    },
  },
  {
    key: 'customer',
    title: 'Customer call: Bluebird Clinics',
    collection: 'customers',
    sensitivity: 'CONFIDENTIAL',
    lines: CUSTOMER,
    notes: {
      summary:
        'Bluebird Clinics transcribe doctors’ voice memos by hand. Their compliance team needs audit logs before rollout; they want a two-clinic pilot in November.',
      decisions: ['Pilot with two clinics in November.'],
      actionItems: [
        {
          text: 'Send the pilot plan with the data residency answer',
          owner: 'Ada',
          due: 'Friday',
          atMs: 222_000,
        },
      ],
      openQuestions: [],
      chapters: [
        { title: 'How they work today', startMs: 0 },
        { title: 'Requirements', startMs: 92_000 },
        { title: 'Pilot', startMs: 195_000 },
      ],
    },
  },
  {
    key: 'allhands',
    title: 'All-hands, September',
    collection: 'handbook',
    sensitivity: 'INTERNAL',
    lines: ALLHANDS,
    notes: {
      summary:
        'Revenue is up 18% on last quarter with churn under 2%. The company is hiring two engineers and a designer before January, and the offsite goes ahead.',
      decisions: ['The offsite goes ahead.'],
      actionItems: [
        { text: 'Book a venue for the offsite', owner: 'Kwame', due: 'this month', atMs: 270_000 },
      ],
      openQuestions: [],
      chapters: [
        { title: 'Numbers', startMs: 0 },
        { title: 'Hiring', startMs: 90_000 },
        { title: 'Teams', startMs: 145_000 },
        { title: 'Questions', startMs: 242_000 },
      ],
    },
  },
];

/** "4:28" → 268000 */
export function stampMs(stamp: string): number {
  const [m, s] = stamp.split(':').map(Number);
  return (m! * 60 + s!) * 1000;
}

/** Transcript segments for a sample meeting: each line lasts until the next begins. */
export function sampleSegments(lines: SampleMeeting['lines']) {
  return lines.map(([stamp, speaker, text], i) => {
    const startMs = stampMs(stamp);
    const next = lines[i + 1];
    const endMs = next ? stampMs(next[0]) - 500 : startMs + Math.max(4_000, text.length * 60);
    return { startMs, endMs, speaker, text };
  });
}
