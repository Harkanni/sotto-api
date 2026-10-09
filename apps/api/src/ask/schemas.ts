import { z } from 'zod';
import { AskScope } from './scope.js';

export const CitationSchema = z
  .object({
    /** The number shown in the answer, [1], [2]… in order of first use. */
    n: z.number(),
    /** False once the file is deleted or you can no longer open it: no title or passage then. */
    available: z.boolean(),
    fileId: z.string().nullable(),
    kind: z.enum(['document', 'audio', 'note']).nullable(),
    title: z.string().nullable(),
    page: z.number().nullable(),
    startMs: z.number().nullable(),
    endMs: z.number().nullable(),
    /** The passage the answer drew on, for highlighting it at the source. */
    quote: z.string().nullable(),
  })
  .meta({ id: 'Citation' });
export type CitationOut = z.infer<typeof CitationSchema>;

export const MessageSchema = z
  .object({
    id: z.string(),
    role: z.enum(['user', 'assistant']),
    /** The question, or the answer with [n] markers matching `citations`. */
    content: z.string(),
    status: z.enum(['streaming', 'done', 'stopped', 'failed']),
    /** "provider:model" that answered; "none" for passages only (no chat model configured). */
    model: z.string().nullable(),
    /** Where the answer was made: the data-route badge. Null on questions. */
    route: z
      .object({
        kind: z.enum(['private', 'byok', 'managed']).nullable(),
        label: z.string(),
      })
      .nullable(),
    /** Made by a labelled mock: say so on screen. */
    isMock: z.boolean(),
    /** No model answered: `citations` are the passages that match best. */
    passagesOnly: z.boolean(),
    /** Relevant sources the answering model wasn't allowed to read. */
    hidden: z.object({ restricted: z.number(), confidential: z.number() }),
    /** The sources didn't hold the answer. */
    notFound: z.boolean(),
    followUps: z.array(z.string()),
    error: z.object({ code: z.string(), message: z.string() }).nullable(),
    feedback: z.number().nullable(),
    citations: z.array(CitationSchema),
    createdAt: z.iso.datetime(),
  })
  .meta({ id: 'Message' });
export type MessageOut = z.infer<typeof MessageSchema>;

export const ConversationSummary = z
  .object({
    id: z.string(),
    title: z.string(),
    scope: AskScope,
    /** The start of the latest answer, without citation markers. */
    preview: z.string().nullable(),
    createdAt: z.iso.datetime(),
    updatedAt: z.iso.datetime(),
  })
  .meta({ id: 'ConversationSummary' });

export const ConversationPage = z
  .object({ items: z.array(ConversationSummary), nextCursor: z.string().nullable() })
  .meta({ id: 'ConversationPage' });

export const ConversationSchema = ConversationSummary.extend({
  messages: z.array(MessageSchema),
}).meta({ id: 'Conversation' });

export const ListConversationsQuery = z.object({
  /** Searches chat titles, questions and answers. */
  q: z.string().trim().min(1).max(200).optional(),
  cursor: z.string().max(500).optional(),
  limit: z.coerce.number().int().min(1).max(50).default(30),
});

export const CreateConversation = z
  .object({ scope: AskScope.default({}), title: z.string().trim().min(1).max(120).optional() })
  .meta({ id: 'CreateConversation' });

export const UpdateConversation = z
  .object({ title: z.string().trim().min(1).max(120).optional(), scope: AskScope.optional() })
  .refine((b) => b.title !== undefined || b.scope !== undefined, 'Change the title or the scope.')
  .meta({ id: 'UpdateConversation' });

export const AskBody = z
  .object({ content: z.string().trim().min(1, 'Ask a question first.').max(4_000) })
  .meta({ id: 'AskBody' });

export const FeedbackBody = z
  .object({ value: z.union([z.literal(-1), z.literal(0), z.literal(1)]) })
  .meta({ id: 'FeedbackBody' });

/**
 * The answer stream (`text/event-stream`), in order:
 *   start  { conversationId, question: Message, answer: Message }  — the answer as it begins
 *   cite   { citation }                                             — a source, first time cited
 *   token  { text }                                                 — more of the answer
 *   done   { answer: Message }                                      — final, as saved
 *   error  { code, message }                                        — the answer failed (saved)
 */
export const AnswerEvent = z
  .discriminatedUnion('type', [
    z.object({
      type: z.literal('start'),
      conversationId: z.string(),
      question: MessageSchema.nullable(),
      answer: MessageSchema,
    }),
    z.object({ type: z.literal('cite'), citation: CitationSchema }),
    z.object({ type: z.literal('token'), text: z.string() }),
    z.object({ type: z.literal('done'), answer: MessageSchema }),
    z.object({ type: z.literal('error'), code: z.string(), message: z.string() }),
  ])
  .meta({ id: 'AnswerEvent' });
export type AnswerEvent = z.infer<typeof AnswerEvent>;
