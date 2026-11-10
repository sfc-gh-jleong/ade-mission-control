/**
 * Per-phase briefs sent to the agents. The agents' standing instructions live
 * in the saved agent spec (definitions.ts); these carry the incident facts.
 *
 * Anything that came from the monitored system (error messages, definitions,
 * data values) is fenced as untrusted data, so text such as "ignore previous
 * instructions" inside an error message reads as data, not as a command.
 */
import type { Diagnosis, FixProposal } from "@/lib/server/agents/schemas"
import type { RehearsalResult } from "@/lib/server/rehearsal/engine"
import type { FailureContext, IncidentRow } from "@/lib/server/orchestrator"
import { iso } from "@/lib/server/db"

function untrusted(label: string, value: unknown): string {
  const text = typeof value === "string" ? value : JSON.stringify(value, null, 2)
  const safe = String(text ?? "").replace(/<\/?untrusted[^>]*>/gi, "")
  return `<untrusted source="${label}">\n${safe.slice(0, 12000)}\n</untrusted>`
}

function incidentHeader(i: IncidentRow): string {
  return [
    `Incident ADE-${i.INCIDENT_NUMBER} (id ${i.INCIDENT_ID})`,
    `Job: ${i.JOB_TYPE} ${i.JOB_FQN}`,
    `Database: ${i.DATABASE_NAME}`,
    `Severity (initial): ${i.SEVERITY}; category (heuristic): ${i.CATEGORY ?? "unknown"}`,
    `Occurrences: ${i.OCCURRENCES}; first seen ${iso(i.FIRST_SEEN_AT)}; last seen ${iso(i.LAST_SEEN_AT)} (UTC)`,
    `Last failing query id: ${i.LAST_QUERY_ID ?? "n/a"}; graph run group: ${i.GRAPH_RUN_GROUP_ID ?? "n/a"}`,
    `Error code: ${i.ERROR_CODE ?? "n/a"}`,
  ].join("\n")
}

export function briefForInvestigator(i: IncidentRow, ctx: FailureContext): string {
  return [
    "Investigate this failed Snowflake job and submit a diagnosis.",
    "",
    incidentHeader(i),
    "",
    "Error message as recorded by Snowflake:",
    untrusted("error_message", i.ERROR_MESSAGE ?? ""),
    "",
    "Recent runs of this job (ADE's record, newest first):",
    untrusted("job_runs", ctx.runs),
    "",
    "Job inventory record:",
    untrusted("job", ctx.job),
    "",
    "Other recent incidents in the same database (may be related or cascading):",
    untrusted("related_incidents", ctx.related),
    "",
    `Useful starting points: SHOW ${i.JOB_TYPE === "DYNAMIC_TABLE" ? "DYNAMIC TABLES" : "TASKS"} LIKE '<name>' IN SCHEMA <db>.<schema>; ` +
      `${i.DATABASE_NAME}.INFORMATION_SCHEMA.TASK_HISTORY / DYNAMIC_TABLE_REFRESH_HISTORY; DESCRIBE TABLE; INFORMATION_SCHEMA.COLUMNS / TABLES (LAST_ALTERED).`,
    "Finish with submit_diagnosis.",
  ].join("\n")
}

export function briefForFixer(i: IncidentRow, d: Diagnosis): string {
  return [
    "Write a fix for this incident and submit it with submit_fix.",
    "",
    incidentHeader(i),
    "",
    "Investigator's diagnosis (produced by another agent; re-verify the facts your fix depends on):",
    untrusted("diagnosis", {
      summary: d.summary,
      root_cause: d.root_cause,
      category: d.category,
      fixability: d.fixability,
      confidence: d.confidence,
      evidence: d.evidence,
      affected_objects: d.affected_objects,
      recommendation: d.recommendation,
      open_questions: d.open_questions,
    }),
    "",
    "Error message:",
    untrusted("error_message", i.ERROR_MESSAGE ?? ""),
    "",
    `Write every reference to an object in ${i.DATABASE_NAME} as {{DB}}.<SCHEMA>.<OBJECT> (e.g. {{DB}}.${i.JOB_FQN.split(".").slice(1).join(".")}).`,
    "Each statement is one SQL statement without a trailing semicolon and without comments.",
    "target_objects lists every object your statements create or change, as {{DB}}.<SCHEMA>.<OBJECT>.",
  ].join("\n")
}

export function revisionBrief(feedback: string): string {
  return [
    "Your previous fix was not accepted. Address every point below and submit a complete replacement fix with submit_fix",
    "(full statements and rollback, not a diff). Re-check facts with read-only queries where the feedback disputes them.",
    "",
    untrusted("review_feedback", feedback),
  ].join("\n")
}

export function briefForReviewer(i: IncidentRow, d: Diagnosis, fix: FixProposal, r: RehearsalResult, iteration: number): string {
  return [
    `Review fix version ${iteration} for this incident and submit your verdict with submit_review.`,
    "",
    incidentHeader(i),
    "",
    "Error message:",
    untrusted("error_message", i.ERROR_MESSAGE ?? ""),
    "",
    "Investigator's diagnosis:",
    untrusted("diagnosis", { summary: d.summary, root_cause: d.root_cause, category: d.category, evidence: d.evidence, recommendation: d.recommendation }),
    "",
    `Proposed fix ({{DB}} = ${i.DATABASE_NAME}):`,
    untrusted("fix", {
      title: fix.title,
      summary: fix.summary,
      strategy: fix.strategy,
      risk_level: fix.risk_level,
      statements: fix.statements,
      rollback_statements: fix.rollback_statements,
      target_objects: fix.target_objects,
      assumptions: fix.assumptions,
      verification_plan: fix.verification_plan,
      addresses_feedback: fix.addresses_feedback,
    }),
    "",
    "Sandbox rehearsal (fix applied to zero-copy clones; the job was re-run there):",
    untrusted("rehearsal", {
      outcome: r.outcome,
      reason: r.reason,
      failure_reproduced_before_fix: r.reproduced,
      error_before_fix: r.reproducedError ?? null,
      error_after_fix: r.verifyError ?? null,
      steps: r.log.map((s) => ({ step: s.step, ok: s.ok, ms: s.ms, sql: s.sql?.slice(0, 600), result: s.result, error: s.error?.slice(0, 600) })),
    }),
    "",
    "Note: the final confidence is capped by the rehearsal outcome (FAILED <= 40, INCONCLUSIVE/UNSUPPORTED <= 70), but score your honest estimate.",
  ].join("\n")
}
