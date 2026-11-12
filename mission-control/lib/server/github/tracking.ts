/**
 * How a tracked pull request moves, decided from what GitHub and the deploy
 * record (DEPLOY.CHANGE_HISTORY) currently say. Pure, so every transition is
 * unit-tested (__tests__/lib/github-tracking.test.ts); lib/server/github/tracker.ts
 * gathers the observations and applies the result.
 *
 *   OPEN ── merged ──> MERGED ── deploy recorded ──> DEPLOYED (fix APPLIED, incident VERIFYING)
 *     └── closed ──> CLOSED (incident needs a person)
 *   MERGED ── no deploy after the timeout ──> needs a person (still tracked)
 *   DEPLOY_NEEDED ── any deploy after it was raised ──> DEPLOYED
 */

export type TrackedState = "PENDING" | "OPEN" | "MERGED" | "DEPLOYED" | "CLOSED" | "DEPLOY_NEEDED" | "CANCELLED"

export interface TrackedPr {
  state: TrackedState
  headSha: string | null // the commit ADE pushed
  createdAt: string
  mergedAt: string | null
  timedOut: boolean // the deploy timeout was already reported
}

export interface ObservedPr {
  state: "open" | "closed"
  merged: boolean
  mergedBy: string | null
  mergedAt: string | null
  mergeCommitSha: string | null
  headSha: string
  approvals: string[]
  changesRequested: boolean
}

export interface ObservedDeploy {
  deployId: string
  commitSha: string
  deployedAt: string
  actor: string | null
  runUrl: string | null
  pipelineStatus: string | null
}

export type TrackAction =
  | { kind: "NONE" }
  | { kind: "REVIEW_UPDATE"; approvals: string[]; changesRequested: boolean; currentHead: string; changedAfterPush: boolean }
  | { kind: "MERGED"; mergedBy: string | null; mergedAt: string; mergeCommitSha: string; changedAfterPush: boolean }
  | { kind: "CLOSED" }
  | { kind: "DEPLOYED"; deploy: ObservedDeploy }
  | { kind: "DEPLOY_TIMEOUT" }

const time = (v: string | null | undefined) => (v ? new Date(v).getTime() : Number.NaN)

/**
 * @param pr      GitHub's view of the PR (OPEN rows)
 * @param deploy  for MERGED: a recorded deploy of the merge commit or a later
 *                commit that contains it; for DEPLOY_NEEDED: the first deploy
 *                after the row was created
 */
export function decide(row: TrackedPr, observed: { pr?: ObservedPr; deploy?: ObservedDeploy }, nowMs: number, deployTimeoutMinutes: number): TrackAction {
  if (row.state === "OPEN") {
    const pr = observed.pr
    if (!pr) return { kind: "NONE" }
    const changedAfterPush = Boolean(row.headSha) && pr.headSha !== row.headSha
    if (pr.merged && pr.mergeCommitSha) {
      return { kind: "MERGED", mergedBy: pr.mergedBy, mergedAt: pr.mergedAt ?? new Date(nowMs).toISOString(), mergeCommitSha: pr.mergeCommitSha, changedAfterPush }
    }
    if (pr.state === "closed") return { kind: "CLOSED" }
    return { kind: "REVIEW_UPDATE", approvals: pr.approvals, changesRequested: pr.changesRequested, currentHead: pr.headSha, changedAfterPush }
  }
  if (row.state === "MERGED") {
    if (observed.deploy) return { kind: "DEPLOYED", deploy: observed.deploy }
    const merged = time(row.mergedAt)
    if (!row.timedOut && Number.isFinite(merged) && nowMs - merged > deployTimeoutMinutes * 60_000) return { kind: "DEPLOY_TIMEOUT" }
    return { kind: "NONE" }
  }
  if (row.state === "DEPLOY_NEEDED") {
    const d = observed.deploy
    if (d && time(d.deployedAt) > time(row.createdAt)) return { kind: "DEPLOYED", deploy: d }
    return { kind: "NONE" }
  }
  return { kind: "NONE" }
}

/** Latest review state per reviewer: who currently approves, and whether anyone requests changes. */
export function summarizeReviews(reviews: { user: string | null; state: string; submittedAt: string | null }[]): { approvals: string[]; changesRequested: boolean } {
  const latest = new Map<string, { state: string; at: number }>()
  for (const r of reviews) {
    if (!r.user || !["APPROVED", "CHANGES_REQUESTED", "DISMISSED"].includes(r.state)) continue
    const at = time(r.submittedAt)
    const prev = latest.get(r.user)
    if (!prev || !(prev.at > at)) latest.set(r.user, { state: r.state, at })
  }
  const approvals = [...latest].filter(([, v]) => v.state === "APPROVED").map(([u]) => u).sort()
  return { approvals, changesRequested: [...latest.values()].some((v) => v.state === "CHANGES_REQUESTED") }
}
