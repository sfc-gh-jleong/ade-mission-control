/**
 * Validation of agent submissions (client-side submit tools). Every payload is
 * parsed with zod; invalid submissions are returned to the agent as a tool
 * error so it can correct itself within the same thread.
 */
import { z } from "zod"
import { CATEGORIES, FIXABILITY, SEVERITIES } from "@/lib/domain"

const clampScore = (v: unknown) => {
  const n = typeof v === "number" ? v : Number(v)
  return Number.isFinite(n) ? Math.max(0, Math.min(100, n)) : v
}
const confidence = z.preprocess(clampScore, z.number().min(0).max(100))
const text = (max: number) => z.string().trim().min(1).max(max)
const list = (max = 30, itemMax = 4000) => z.array(z.string().trim().min(1).max(itemMax)).max(max)

export const DiagnosisSchema = z.object({
  summary: text(400),
  root_cause: text(8000),
  category: z.enum(CATEGORIES),
  severity: z.enum(SEVERITIES),
  fixability: z.enum(FIXABILITY),
  is_transient: z.boolean(),
  confidence,
  evidence: list(20).min(1),
  affected_objects: list(40, 800).default([]),
  recommendation: text(8000),
  open_questions: list(20).optional().default([]),
})
export type Diagnosis = z.infer<typeof DiagnosisSchema>

export const FixSchema = z.object({
  title: text(300),
  summary: text(4000),
  strategy: z.enum(["DDL_PATCH", "CREATE_MISSING", "TASK_GRAPH", "DATA_REPAIR", "RERUN_ONLY"]),
  statements: list(25, 60000),
  rollback_statements: list(25, 60000).default([]),
  target_objects: list(25, 800).default([]),
  risk_level: z.enum(["LOW", "MEDIUM", "HIGH"]),
  assumptions: list(20).default([]),
  verification_plan: text(4000),
  addresses_feedback: list(20).optional().default([]),
})
export type FixProposal = z.infer<typeof FixSchema>

const rubricScore = z.preprocess((v) => {
  const n = typeof v === "number" ? v : Number(v)
  return Number.isFinite(n) ? Math.max(1, Math.min(5, Math.round(n))) : v
}, z.number().int().min(1).max(5))

export const ReviewSchema = z.object({
  verdict: z.enum(["APPROVE", "REVISE", "REJECT"]),
  confidence,
  summary: text(4000),
  rubric: z.object({
    root_cause_addressed: rubricScore,
    correctness: rubricScore,
    safety: rubricScore,
    minimality: rubricScore,
    rollback_quality: rubricScore,
    verification: rubricScore,
  }),
  concerns: list(20).default([]),
  required_changes: list(20).default([]),
  checks_performed: list(30).default([]),
})
export type Review = z.infer<typeof ReviewSchema>

export function formatZodError(error: z.ZodError): string {
  return error.issues
    .slice(0, 10)
    .map((i) => `${i.path.join(".") || "(root)"}: ${i.message}`)
    .join("; ")
}
