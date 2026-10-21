/**
 * `questions@1`: the agent asking the user something (dsh's built-in
 * `ask_user_question` tool): a choice, a confirmation, or missing information.
 * The gateway answers dsh's `user-questions/request` waterfall and puts the
 * question to every client (and to chat channels, like approvals); the first
 * answer wins.
 */
import { z } from 'zod'

export const QUESTIONS_CAPABILITY = 'questions'

export const QuestionOption = z.object({
  label: z.string(),
  description: z.string().optional(),
})
export type QuestionOption = z.infer<typeof QuestionOption>

export const QuestionItem = z.object({
  /** Stable id within the request, echoed in the answer. */
  id: z.string(),
  question: z.string(),
  /** Supporting detail (markdown). */
  detail: z.string().optional(),
  /** Short heading. */
  header: z.string().optional(),
  options: z.array(QuestionOption).optional(),
  multiSelect: z.boolean().optional(),
})
export type QuestionItem = z.infer<typeof QuestionItem>

export const QuestionRequested = z.object({
  questionId: z.string(),
  sessionId: z.string(),
  /** The `ask_user_question` tool call, when known. */
  callId: z.string().optional(),
  questions: z.array(QuestionItem),
})
export type QuestionRequested = z.infer<typeof QuestionRequested>

/** One question's answer: chosen option labels, and/or text typed instead. Empty means skipped. */
export const QuestionAnswerItem = z.object({
  id: z.string(),
  selected: z.array(z.string()),
  custom: z.string().optional(),
})
export type QuestionAnswerItem = z.infer<typeof QuestionAnswerItem>

/** `answered`, `cancelled` (the agent stopped waiting) or `unavailable` (the host went away). */
export const QuestionOutcome = z.enum(['answered', 'cancelled', 'unavailable'])
export type QuestionOutcome = z.infer<typeof QuestionOutcome>

export const QuestionsRequests = {
  /** Answer a question; items left out count as skipped. */
  'question/respond': {
    capability: QUESTIONS_CAPABILITY,
    params: z.object({ questionId: z.string(), answers: z.array(QuestionAnswerItem) }),
    result: z.object({}),
  },
} as const

export const QuestionsNotifications = {
  'question/requested': QuestionRequested,
  'question/resolved': z.object({ questionId: z.string(), outcome: QuestionOutcome, answers: z.array(QuestionAnswerItem).optional() }),
} as const
