/**
 * Shared domain vocabulary for ADE Mission Control. Safe to import from both
 * server and client code (no Node APIs).
 */

export const AGENT_ROLES = ["INVESTIGATOR", "FIXER", "REVIEWER"] as const
export type AgentRole = (typeof AGENT_ROLES)[number]
export type Actor = AgentRole | "SYSTEM"

export const JOB_TYPES = ["TASK", "DYNAMIC_TABLE", "ALERT", "PIPE"] as const
export type JobType = (typeof JOB_TYPES)[number]

export const SEVERITIES = ["CRITICAL", "HIGH", "MEDIUM", "LOW"] as const
export type Severity = (typeof SEVERITIES)[number]

export const CATEGORIES = [
  "SCHEMA_DRIFT",
  "MISSING_OBJECT",
  "DATA_QUALITY",
  "LOGIC_BUG",
  "PERMISSIONS",
  "RESOURCE",
  "DEPENDENCY",
  "TRANSIENT",
  "EXTERNAL",
  "UNKNOWN",
] as const
export type Category = (typeof CATEGORIES)[number]

export const FIXABILITY = ["SQL_FIX", "DATA_FIX", "TRANSIENT_RETRY", "EXTERNAL", "NEEDS_HUMAN"] as const
export type Fixability = (typeof FIXABILITY)[number]

/**
 * Incident lifecycle. The orchestrator owns every transition except the human
 * ones (APPROVE / REJECT / ROLLBACK), which go through ADE_DB.GUARD.
 *
 *   DETECTED -> INVESTIGATING -> FIXING -> REHEARSING -> REVIEWING
 *            -> AWAITING_APPROVAL -> APPLYING -> VERIFYING -> RESOLVED
 * Side exits: NEEDS_HUMAN, NO_FIX (transient/external), FAILED, SUPPRESSED,
 * and SYMPTOM (a cascade child pointing at its root incident).
 */
export const INCIDENT_STATUSES = [
  "DETECTED",
  "QUEUED",
  "INVESTIGATING",
  "FIXING",
  "REHEARSING",
  "REVIEWING",
  "AWAITING_APPROVAL",
  "APPROVED",
  "APPLYING",
  "VERIFYING",
  "RESOLVED",
  "NEEDS_HUMAN",
  "NO_FIX",
  "FAILED",
  "SUPPRESSED",
  "SYMPTOM",
] as const
export type IncidentStatus = (typeof INCIDENT_STATUSES)[number]

/** Statuses in which an agent is actively working on the incident. */
export const ACTIVE_STATUSES: readonly IncidentStatus[] = ["INVESTIGATING", "FIXING", "REHEARSING", "REVIEWING", "APPLYING", "VERIFYING"]
/** Statuses that need no further work from the pipeline. */
export const TERMINAL_STATUSES: readonly IncidentStatus[] = ["RESOLVED", "NO_FIX", "FAILED", "SUPPRESSED", "SYMPTOM"]
/** Statuses that are waiting on a person. */
export const HUMAN_STATUSES: readonly IncidentStatus[] = ["AWAITING_APPROVAL", "NEEDS_HUMAN"]

export const PIPELINE_STAGES = [
  { key: "DETECT", label: "Detect", actor: "SYSTEM" },
  { key: "INVESTIGATE", label: "Investigate", actor: "INVESTIGATOR" },
  { key: "FIX", label: "Fix", actor: "FIXER" },
  { key: "REHEARSE", label: "Rehearse", actor: "SYSTEM" },
  { key: "REVIEW", label: "Review", actor: "REVIEWER" },
  { key: "APPROVE", label: "Approve", actor: "HUMAN" },
  { key: "APPLY", label: "Apply", actor: "SYSTEM" },
  { key: "VERIFY", label: "Verify", actor: "SYSTEM" },
] as const
export type PipelineStageKey = (typeof PIPELINE_STAGES)[number]["key"]

/** Index of the pipeline stage an incident status corresponds to. */
export function stageIndexForStatus(status: IncidentStatus): number {
  switch (status) {
    case "DETECTED":
    case "QUEUED":
      return 0
    case "INVESTIGATING":
      return 1
    case "FIXING":
      return 2
    case "REHEARSING":
      return 3
    case "REVIEWING":
      return 4
    case "AWAITING_APPROVAL":
    case "APPROVED":
      return 5
    case "APPLYING":
      return 6
    case "VERIFYING":
    case "RESOLVED":
      return 7
    default:
      return -1
  }
}

export const REHEARSAL_OUTCOMES = ["RUNNING", "PASSED", "FAILED", "INCONCLUSIVE", "UNSUPPORTED"] as const
export type RehearsalOutcome = (typeof REHEARSAL_OUTCOMES)[number]

export const VERDICTS = ["APPROVE", "REVISE", "REJECT"] as const
export type Verdict = (typeof VERDICTS)[number]

/**
 * Deterministic caps on the Reviewer's confidence. The model's score is advisory;
 * the sandbox rehearsal is evidence, so it bounds what the score may claim.
 */
export function capConfidence(
  rawConfidence: number,
  rehearsal: RehearsalOutcome | null,
): { confidence: number; capReason: string | null } {
  const raw = Math.max(0, Math.min(100, Number.isFinite(rawConfidence) ? rawConfidence : 0))
  const cap = (limit: number, reason: string) =>
    raw > limit ? { confidence: limit, capReason: reason } : { confidence: raw, capReason: null }
  switch (rehearsal) {
    case "PASSED":
      return { confidence: raw, capReason: null }
    case "FAILED":
      return cap(40, "Sandbox rehearsal failed: the job still errors with the fix applied")
    case "INCONCLUSIVE":
      return cap(70, "Sandbox rehearsal was inconclusive")
    case "UNSUPPORTED":
      return cap(70, "This job type cannot be rehearsed in the sandbox")
    default:
      return cap(60, "No sandbox rehearsal was run")
  }
}

export function severityRank(s: string | null | undefined): number {
  const i = SEVERITIES.indexOf((s ?? "MEDIUM") as Severity)
  return i < 0 ? 2 : i
}

export function formatIncidentNumber(n: number | string | null | undefined): string {
  return n === null || n === undefined || n === "" ? "ADE-?" : `ADE-${n}`
}

export type RiskLevel = "LOW" | "MEDIUM" | "HIGH"
