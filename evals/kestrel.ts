/**
 * The retrieval and answer eval set (BRIEF, Tests: "about 20 fictional question-and-answer
 * pairs, scored on every change to the AI pipeline"). Every question is about the fictional
 * Kestrel Labs sample content (apps/api/src/onboarding/sample-files.ts), so it runs on any
 * workspace that loads it, and nothing real is ever needed.
 *
 * Questions are worded the way people ask, not copied from the text: many share few words with
 * the passage that answers them, so they measure the semantic half of hybrid search too.
 *
 *   expect    titles of files that hold the answer (any one counts)
 *   at        where in a meeting the answer was said ("m:ss"), checked against the passage
 *   answer    words the answer itself must contain, when a model answers (case-insensitive)
 *   restricted  the answer is only in the Board and finance collection (restricted): the owner
 *               must find it, a viewer must not, and must never see that file at all
 */

export interface EvalQuestion {
  id: string;
  question: string;
  expect: string[];
  at?: string;
  answer?: string[];
  restricted?: boolean;
}

export const BOARD_TITLE = 'Board update, September';

export const QUESTIONS: EvalQuestion[] = [
  // ── Memos ──
  {
    id: 'launch-date',
    question: 'When are we launching in Lagos?',
    expect: ['Lagos launch plan'],
    answer: ['november'],
  },
  {
    id: 'residency-owner',
    question: 'Who is responsible for the data residency risk?',
    expect: ['Lagos launch plan'],
    answer: ['ada'],
  },
  {
    id: 'free-tier',
    question: 'How many people can use the free plan?',
    expect: ['Pricing review notes'],
    answer: ['three'],
  },
  {
    id: 'byok-discount',
    question: 'Will customers who bring their own API key get a cheaper price?',
    expect: ['Pricing review notes'],
  },
  {
    id: 'encryption',
    question: 'How do we protect files and transcripts?',
    expect: ['Security questionnaire answers'],
    answer: ['encrypt'],
  },
  {
    id: 'data-location',
    question: 'In which region is customer data kept?',
    expect: ['Security questionnaire answers', 'Weekly product sync'],
    answer: ['london'],
  },
  {
    id: 'support-reply',
    question: 'How quickly must we get back to a customer who writes in?',
    expect: ['Support playbook'],
    answer: ['one working day'],
  },
  {
    id: 'support-escalate',
    question: 'When does a support request go to engineering?',
    expect: ['Support playbook'],
  },
  {
    id: 'first-day',
    question: 'What happens on a new employee’s first day?',
    expect: ['New hire onboarding checklist'],
  },
  {
    id: 'error-apology',
    question: 'Should our error messages say sorry?',
    expect: ['Brand voice guide'],
  },
  {
    id: 'quarter-outcomes',
    question: 'What are we focused on this quarter?',
    expect: ['Q4 roadmap memo'],
  },
  {
    id: 'answer-speed',
    question: 'How fast should the first part of an answer show up?',
    expect: ['Q4 roadmap memo'],
    answer: ['two seconds'],
  },
  {
    id: 'out-of-scope',
    question: 'Are we building a desktop app this quarter?',
    expect: ['Q4 roadmap memo'],
  },
  // ── Meetings ──
  {
    id: 'fifth-partner',
    question: 'What is holding up the last design partner from signing?',
    expect: ['Weekly product sync'],
    at: '0:31',
    answer: ['residency'],
  },
  {
    id: 'offline-requirement',
    question: 'Did offline recording become a must-have for launch?',
    expect: ['Weekly product sync'],
    at: '3:08',
  },
  {
    id: 'queue-uploads',
    question: 'How long will it take to queue uploads on the phone?',
    expect: ['Weekly product sync'],
    at: '3:50',
    answer: ['two weeks'],
  },
  {
    id: 'bluebird-today',
    question: 'How do the Bluebird doctors take notes right now?',
    expect: ['Customer call: Bluebird Clinics'],
    at: '0:40',
  },
  {
    id: 'bluebird-compliance',
    question: 'What does Bluebird’s compliance team need before they roll out?',
    expect: ['Customer call: Bluebird Clinics'],
    at: '1:45',
    answer: ['audit'],
  },
  {
    id: 'bluebird-pilot',
    question: 'How many clinics will be in the Bluebird pilot?',
    expect: ['Customer call: Bluebird Clinics'],
    at: '3:15',
    answer: ['two'],
  },
  {
    id: 'offsite-venue',
    question: 'Who is booking the place for the offsite?',
    expect: ['All-hands, September'],
    at: '4:30',
    answer: ['kwame'],
  },
  {
    id: 'referrals',
    question: 'Where should I send people I know for the open jobs?',
    expect: ['All-hands, September'],
    at: '1:30',
  },
  {
    id: 'revenue',
    question: 'How much did revenue grow compared with last quarter?',
    expect: ['All-hands, September', BOARD_TITLE],
    answer: ['18'],
  },
  // ── Only in the restricted Board and finance collection ──
  {
    id: 'runway',
    question: 'How many months of runway do we have?',
    expect: [BOARD_TITLE],
    answer: ['21'],
    restricted: true,
  },
  {
    id: 'launch-budget',
    question: 'What launch budget are we asking the board to approve?',
    expect: [BOARD_TITLE],
    answer: ['40,000'],
    restricted: true,
  },
];

/** Nothing in the sample content answers these: the right answer is "the sources don't say". */
export const UNANSWERABLE: string[] = [
  'What is the office wifi password?',
  'Who won the football game on Saturday?',
  'What is the recipe for jollof rice?',
];
