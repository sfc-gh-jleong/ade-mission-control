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

/** The job's file when its code lives in Git (lib/server/github/source.ts). */
export interface GitBrief {
  repo: string
  path: string
  header: string
  body: string
  productionMatches: boolean | null
  jobType: "TASK" | "DYNAMIC_TABLE"
}

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

export function briefForFixer(i: IncidentRow, d: Diagnosis, git: GitBrief | null = null): string {
  const target = `{{DB}}.${i.JOB_FQN.split(".").slice(1).join(".")}`
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
    `Write every reference to an object in ${i.DATABASE_NAME} as {{DB}}.<SCHEMA>.<OBJECT> (e.g. ${target}).`,
    "Each statement is one SQL statement without a trailing semicolon and without comments.",
    "target_objects lists every object your statements create or change, as {{DB}}.<SCHEMA>.<OBJECT>.",
    ...(git ? gitRules(git, target) : []),
  ].join("\n")
}

function gitRules(git: GitBrief, target: string): string[] {
  const shape =
    git.jobType === "TASK"
      ? `ALTER TASK ${target} SUSPEND, then ALTER TASK ${target} MODIFY AS <new body>, then ALTER TASK ${target} RESUME`
      : `one CREATE OR REPLACE DYNAMIC TABLE ${target} with TARGET_LAG, WAREHOUSE and REFRESH_MODE exactly as in the file header, AS <new query>`
  return [
    "",
    `## This job's code lives in Git (${git.repo}, ${git.path})`,
    "Your fix becomes a pull request that replaces only the body of that file. A person reviews and merges it; GitHub Actions deploys it.",
    `- Write the fix as: ${shape}. No other statements: the header (warehouse, schedule, predecessors, condition, comment), other objects and data stay as they are.`,
    "- Start from the current body below and change only what the fix needs. Keep its formatting and line breaks so the pull request's diff stays small.",
    "- rollback_statements restore the current body the same way.",
    "- If the failure is a missing object that the repo defines (for example a dropped table), submit only CREATE TABLE IF NOT EXISTS for it: ADE then asks for a deploy of main, which recreates it, instead of a pull request.",
    ...(git.productionMatches === false ? ["- Production's definition differs from this file. The pull request is based on the file; say so in assumptions if it matters."] : []),
    "",
    "File header (stays unchanged):",
    untrusted("repo_file_header", git.header),
    "",
    "Current body in the file ({{DB}} as written in the repo):",
    untrusted("repo_file_body", git.body),
  ]
}

export function revisionBrief(feedback: string): string {
  return [
    "Your previous fix was not accepted. Address every point below and submit a complete replacement fix with submit_fix",
    "(full statements and rollback, not a diff). Re-check facts with read-only queries where the feedback disputes them.",
    "",
    untrusted("review_feedback", feedback),
  ].join("\n")
}

export function briefForReviewer(
  i: IncidentRow,
  d: Diagnosis,
  fix: FixProposal,
  r: RehearsalResult,
  iteration: number,
  git: { repo: string; path: string; diff: string } | null = null,
): string {
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
    ...(git
      ? [
          "",
          `This job's code lives in Git. If you approve, ADE opens a pull request to ${git.repo} with exactly this change to ${git.path}`,
          "(the rehearsed body, copied into the file; a person reviews and merges it, and GitHub Actions deploys it). Review the diff as part of the fix:",
          untrusted("pull_request_diff", git.diff),
        ]
      : []),
  ].join("\n")
}
