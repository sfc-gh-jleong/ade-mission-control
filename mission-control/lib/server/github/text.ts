/**
 * Public text for pull requests. The demo repo is public, so everything here
 * is world-readable: agent-written text is escaped and capped, and nothing
 * links back to Mission Control or carries query IDs, sample rows or SQL logs.
 */

const ZWSP = "\u200b"

export interface PublicTextOptions {
  /** Strings that must never appear (e.g. the Snowflake account name), matched case-insensitively. */
  redact?: string[]
}

/**
 * Agent-written text made safe for a public GitHub page: no HTML, no
 * @mentions or #references that notify or link, no autolinked URLs, no
 * Snowflake hostnames, query IDs or redacted names; capped at `max` characters.
 */
export function publicText(value: unknown, max: number, opts: PublicTextOptions = {}): string {
  let s = String(value ?? "")
  // eslint-disable-next-line no-control-regex
  s = s.replace(/[\u0000-\u0008\u000b-\u001f\u007f\u202a-\u202e\u2066-\u2069]/g, "")
  for (const r of opts.redact ?? []) {
    if (r && r.length >= 4) s = s.replace(new RegExp(r.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "gi"), "[redacted]")
  }
  s = s
    .replace(/\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/gi, "[id]")
    .replace(/[A-Za-z0-9._-]+\.(?:privatelink\.)?snowflakecomputing\.(?:com|cn)\S*/gi, "[snowflake host]")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/\b(https?|ftp)(:\/\/)/gi, `$1${ZWSP}$2`)
    .replace(/\bwww\./gi, `www${ZWSP}.`)
    .replace(/@(?=[A-Za-z0-9_-])/g, `@${ZWSP}`)
    .replace(/#(?=\d)/g, `#${ZWSP}`)
    .replace(/\]\(/g, `]${ZWSP}(`)
  s = s.trim()
  if (s.length > max) s = `${s.slice(0, Math.max(0, max - 1)).trimEnd()}…`
  return s
}

/** One line (titles): newlines collapsed. */
export function publicLine(value: unknown, max: number, opts: PublicTextOptions = {}): string {
  return publicText(String(value ?? "").replace(/\s+/g, " "), max, opts)
}

export interface PrContent {
  incidentNumber: number
  jobType: "TASK" | "DYNAMIC_TABLE"
  objectName: string // SCHEMA.NAME
  path: string
  version: number
  fix: { title: string; summary: string; assumptions: string[]; verificationPlan: string; riskLevel: string }
  rootCause: string
  rehearsal: { outcome: string; reason: string }
  review: { verdict: string; confidence: number; summary: string; concerns: string[] }
  fixHash: string
  patchHash: string
  productionDiffered: boolean
}

export const branchName = (incidentNumber: number, version: number) => `ade/ADE-${incidentNumber}-v${version}`

export function prTitle(c: PrContent, opts: PublicTextOptions = {}): string {
  return `ADE-${c.incidentNumber}: ${publicLine(c.fix.title, 110, opts)}`
}

export function commitMessage(c: PrContent, opts: PublicTextOptions = {}): string {
  return `${prTitle(c, opts)}\n\n${publicText(c.fix.summary, 1200, opts)}\n\nFix v${c.version} for ${c.objectName}, rehearsed and reviewed by ADE.`
}

const bullets = (items: string[], max: number, opts: PublicTextOptions) =>
  items.slice(0, 8).map((a) => `- ${publicLine(a, max, opts)}`).join("\n")

export function prBody(c: PrContent, opts: PublicTextOptions = {}): string {
  const kind = c.jobType === "TASK" ? "task" : "dynamic table"
  const lines: string[] = [
    `ADE Mission Control opened this pull request for incident **ADE-${c.incidentNumber}**. A person must approve and merge it; GitHub Actions then deploys it.`,
    "",
    "### Summary",
    publicText(c.fix.summary, 1500, opts),
    "",
    "### Root cause",
    publicText(c.rootCause, 2000, opts),
    "",
    "### Change",
    `Replaces the body of the ${kind} \`${c.objectName}\` in \`${c.path}\`. Its header (warehouse, schedule, predecessors, options) is unchanged. Risk: ${publicLine(c.fix.riskLevel, 10, opts)}.`,
  ]
  if (c.productionDiffered) {
    lines.push("", "> Production's definition of this object differed from `main` before this change. Merging deploys `main` with this change.")
  }
  if (c.fix.assumptions.length) lines.push("", "### Assumptions", bullets(c.fix.assumptions, 400, opts))
  lines.push(
    "",
    "### Rehearsal",
    `**${publicLine(c.rehearsal.outcome, 20, opts)}**: ${publicText(c.rehearsal.reason, 600, opts)} The fix ran against zero-copy clones in a throwaway sandbox database; nothing in production changed.`,
    "",
    "### Review",
    `**${publicLine(c.review.verdict, 10, opts)}**, confidence ${Math.round(c.review.confidence)}/100 (reviewer agent, capped by the rehearsal result). ${publicText(c.review.summary, 1500, opts)}`,
  )
  if (c.review.concerns.length) lines.push("", "Concerns noted by the reviewer:", bullets(c.review.concerns, 400, opts))
  lines.push(
    "",
    "### Verification",
    publicText(c.fix.verificationPlan, 1200, opts),
    "",
    "After merge, the Deploy workflow applies `main`, records the deploy and runs the pipeline. ADE resolves the incident after the job's next successful run.",
    "",
    `<sub>Fix \`${c.fixHash.slice(0, 16)}\` · change \`${c.patchHash.slice(0, 16)}\` · v${c.version}</sub>`,
  )
  return lines.join("\n")
}
