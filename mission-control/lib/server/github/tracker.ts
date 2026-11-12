/**
 * Tracks pull requests and deploys for databases managed in Git. Read-only on
 * GitHub (people review, approve and merge; GitHub Actions deploys).
 *
 * Every poll (delivery.github.poll_seconds):
 *   PENDING        try to open the PR (lib/server/github/pr.ts)
 *   OPEN           approvals, new commits, merged or closed
 *   MERGED         a recorded deploy in <db>.DEPLOY.CHANGE_HISTORY of the merge
 *                  commit (or a later commit that contains it)
 *   DEPLOY_NEEDED  any deploy after the request (fixes that main already holds)
 *   DEPLOYED       the job's first run after the deploy: RESOLVED or a person
 *                  (the shared verifier in orchestrator.ts reaches the same
 *                  answer from the detector's records, up to 10 minutes later)
 *
 * GitHub and the deploy record are the source of truth; OPS.PULL_REQUESTS is a
 * cache. Updates to an incident only apply while the tracked fix is still its
 * current fix, so a re-queued incident is never moved by an old PR.
 */
import { iso, json, num, sql, sqlOne } from "@/lib/server/db"
import { nowIso, publish } from "@/lib/server/events"
import { bindDatabase } from "@/lib/server/agents/sql-guard"
import { q } from "@/lib/server/rehearsal/sql-text"
import { deliverySettings, repoClient, type DeliverySettings } from "@/lib/server/github/client"
import { normalizeSql, parseObjectFile } from "@/lib/server/github/files"
import { openPullRequest } from "@/lib/server/github/pr"
import { loadChange, productionBody } from "@/lib/server/github/source"
import { decide, summarizeReviews, type ObservedDeploy, type TrackAction, type TrackedState } from "@/lib/server/github/tracking"

const ACTIVE_STATES = ["PENDING", "OPEN", "MERGED", "DEPLOY_NEEDED", "DEPLOYED"]
const RECOUNT_MS = 5 * 60_000

const g = globalThis as unknown as {
  __adeTracker?: { running: boolean; lastRun: number; lastCount: number; countedAt: number; settings: DeliverySettings | null; settingsAt: number }
}
function state() {
  if (!g.__adeTracker) g.__adeTracker = { running: false, lastRun: 0, lastCount: 1, countedAt: 0, settings: null, settingsAt: 0 }
  return g.__adeTracker
}

/** Call after creating a tracked row so the next tick polls without waiting for a recount. */
export function noteTracked(): void {
  const s = state()
  s.lastCount = Math.max(1, s.lastCount)
  s.lastRun = 0
}

interface Row {
  PR_ID: string
  FIX_ID: string
  INCIDENT_ID: string
  REPO: string
  BASE_BRANCH: string
  BRANCH: string | null
  PATH: string | null
  STATE: TrackedState
  PR_NUMBER: number | null
  PR_URL: string | null
  HEAD_SHA: string | null
  CURRENT_HEAD_SHA: string | null
  APPROVALS: number
  CHANGES_REQUESTED: boolean
  MERGED_BY: string | null
  MERGED_AT: unknown
  MERGE_COMMIT_SHA: string | null
  DEPLOYED_AT: unknown
  DEPLOY_RUN_URL: string | null
  REVIEW_DRIFT: string | null
  LAST_ERROR: string | null
  CREATED_AT: unknown
  DATABASE_NAME: string
  JOB_TYPE: string
  JOB_FQN: string
  INCIDENT_STATUS: string
  INCIDENT_DETAIL: string | null
  CURRENT_FIX_ID: string | null
}

/** Run one tracking pass if one is due. Never throws; safe to call every tick. */
export async function trackPullRequests(force = false): Promise<void> {
  const s = state()
  if (s.running) return
  const now = Date.now()
  if (!s.settings || now - s.settingsAt > RECOUNT_MS) {
    s.settings = await deliverySettings().catch(() => s.settings)
    s.settingsAt = now
  }
  const pollMs = (s.settings?.pollSeconds ?? 60) * 1000
  if (!force && now - s.lastRun < pollMs) return
  if (!force && s.lastCount === 0 && now - s.countedAt < RECOUNT_MS) return
  s.running = true
  s.lastRun = now
  try {
    const rows = await sql<Row>(
      `SELECT p.*, i.DATABASE_NAME, i.JOB_TYPE, i.JOB_FQN, i.STATUS AS INCIDENT_STATUS, i.STATUS_DETAIL AS INCIDENT_DETAIL, i.CURRENT_FIX_ID
       FROM ADE_DB.OPS.PULL_REQUESTS p JOIN ADE_DB.OPS.INCIDENTS i ON i.INCIDENT_ID = p.INCIDENT_ID
       WHERE p.STATE IN (${ACTIVE_STATES.map(() => "?").join(", ")})
         AND (p.STATE <> 'DEPLOYED' OR (i.STATUS = 'VERIFYING' AND p.DEPLOYED_AT > DATEADD(day, -1, SYSDATE())))
       ORDER BY p.CREATED_AT`,
      ACTIVE_STATES,
    )
    s.lastCount = rows.length
    s.countedAt = now
    for (const row of rows) {
      await trackOne(row, s.settings ?? (await deliverySettings())).catch(async (e) => {
        const message = e instanceof Error ? e.message : String(e)
        console.error(nowIso(), "[tracker]", row.PR_ID, message)
        await sql(`UPDATE ADE_DB.OPS.PULL_REQUESTS SET LAST_ERROR = ?, LAST_SYNCED_AT = SYSDATE() WHERE PR_ID = ?`, [message.slice(0, 4000), row.PR_ID]).catch(() => {})
      })
    }
  } catch (e) {
    console.error(nowIso(), "[tracker] pass failed", e)
  } finally {
    s.running = false
  }
}

async function trackOne(row: Row, settings: DeliverySettings): Promise<void> {
  const current = row.CURRENT_FIX_ID === row.FIX_ID
  if (row.STATE === "PENDING") {
    if (!current) {
      await sql(`UPDATE ADE_DB.OPS.PULL_REQUESTS SET STATE = 'CANCELLED', UPDATED_AT = SYSDATE() WHERE PR_ID = ?`, [row.PR_ID])
      return
    }
    const r = await openPullRequest(row.FIX_ID)
    if (r.status === "HELD") await incidentDetail(row, `Waiting to open the pull request: ${r.reason}`)
    return
  }
  if (row.STATE === "DEPLOYED") {
    if (current) await verifyAfterDeploy(row)
    return
  }

  let observed: Parameters<typeof decide>[1] = {}
  if (row.STATE === "OPEN" && row.PR_NUMBER) {
    const gh = repoClient(row.REPO)
    const [pr, reviews] = await Promise.all([gh.pull(num(row.PR_NUMBER)), gh.reviews(num(row.PR_NUMBER))])
    observed = {
      pr: {
        state: pr.state,
        merged: pr.merged,
        mergedBy: pr.merged_by?.login ?? null,
        mergedAt: pr.merged_at,
        mergeCommitSha: pr.merge_commit_sha,
        headSha: pr.head.sha,
        ...summarizeReviews(reviews.map((r) => ({ user: r.user?.login ?? null, state: r.state, submittedAt: r.submitted_at }))),
      },
    }
  } else if (row.STATE === "MERGED" || row.STATE === "DEPLOY_NEEDED") {
    const deploy = await findDeploy(row)
    if (deploy) observed = { deploy }
  }

  const action = decide(
    {
      state: row.STATE,
      headSha: row.HEAD_SHA,
      createdAt: iso(row.CREATED_AT) ?? nowIso(),
      mergedAt: iso(row.MERGED_AT),
      timedOut: (row.LAST_ERROR ?? "").startsWith("DEPLOY_TIMEOUT"),
    },
    observed,
    Date.now(),
    settings.deployTimeoutMinutes,
  )
  await apply(row, action, current)
}

async function apply(row: Row, action: TrackAction, current: boolean): Promise<void> {
  const prRef = row.PR_NUMBER ? `Pull request #${row.PR_NUMBER}` : "The deploy request"
  switch (action.kind) {
    case "NONE":
      await sql(`UPDATE ADE_DB.OPS.PULL_REQUESTS SET LAST_SYNCED_AT = SYSDATE() WHERE PR_ID = ?`, [row.PR_ID])
      return
    case "REVIEW_UPDATE": {
      const drift = action.changedAfterPush ? "CHANGED_AFTER_REVIEW" : row.REVIEW_DRIFT
      await sql(
        `UPDATE ADE_DB.OPS.PULL_REQUESTS SET APPROVALS = ?, APPROVED_BY = PARSE_JSON(?), CHANGES_REQUESTED = ?, CURRENT_HEAD_SHA = ?, REVIEW_DRIFT = ?,
           LAST_ERROR = NULL, LAST_SYNCED_AT = SYSDATE(), UPDATED_AT = SYSDATE() WHERE PR_ID = ?`,
        [action.approvals.length, json(action.approvals), action.changesRequested, action.currentHead, drift, row.PR_ID],
      )
      if (!current) return
      const who = action.approvals.length ? `approved by ${action.approvals.join(", ")}; waiting for merge` : action.changesRequested ? "changes requested" : "waiting for review"
      await incidentDetail(row, `${prRef} on GitHub: ${who}${drift === "CHANGED_AFTER_REVIEW" ? " (commits were pushed after ADE's review)" : ""}`)
      return
    }
    case "MERGED": {
      let drift = action.changedAfterPush ? "CHANGED_AFTER_REVIEW" : row.REVIEW_DRIFT
      const change = await loadChange(row.FIX_ID)
      if (change && row.PATH) {
        const merged = await repoClient(row.REPO).file(row.PATH, action.mergeCommitSha).catch(() => null)
        if (merged && merged.sha !== change.newBlobSha) drift = "CHANGED_AFTER_REVIEW"
      }
      await sql(
        `UPDATE ADE_DB.OPS.PULL_REQUESTS SET STATE = 'MERGED', MERGED_BY = ?, MERGED_AT = CONVERT_TIMEZONE('UTC', ?::TIMESTAMP_TZ)::TIMESTAMP_NTZ,
           MERGE_COMMIT_SHA = ?, REVIEW_DRIFT = ?, LAST_ERROR = NULL, LAST_SYNCED_AT = SYSDATE(), UPDATED_AT = SYSDATE() WHERE PR_ID = ?`,
        [action.mergedBy, action.mergedAt, action.mergeCommitSha, drift, row.PR_ID],
      )
      await audit(row, "PR_MERGED", { number: row.PR_NUMBER, merged_by: action.mergedBy, merge_commit: action.mergeCommitSha, drift })
      if (!current) return
      await sql(`UPDATE ADE_DB.OPS.FIXES SET STATUS = 'MERGED', UPDATED_AT = SYSDATE() WHERE FIX_ID = ?`, [row.FIX_ID])
      await incidentStatus(row, "DEPLOYING", `${prRef} was merged by ${action.mergedBy ?? "someone"}${drift === "CHANGED_AFTER_REVIEW" ? " with changes made after ADE's review" : ""}; waiting for the Deploy workflow`)
      return
    }
    case "CLOSED":
      await sql(`UPDATE ADE_DB.OPS.PULL_REQUESTS SET STATE = 'CLOSED', CLOSED_AT = SYSDATE(), LAST_SYNCED_AT = SYSDATE(), UPDATED_AT = SYSDATE() WHERE PR_ID = ?`, [row.PR_ID])
      await audit(row, "PR_CLOSED", { number: row.PR_NUMBER })
      if (!current) return
      await sql(`UPDATE ADE_DB.OPS.FIXES SET STATUS = 'PR_CLOSED', UPDATED_AT = SYSDATE() WHERE FIX_ID = ?`, [row.FIX_ID])
      await incidentStatus(row, "NEEDS_HUMAN", `${prRef} was closed without merging. Queue the incident again for a new fix.`)
      return
    case "DEPLOY_TIMEOUT": {
      const run = row.MERGE_COMMIT_SHA ? await repoClient(row.REPO).runFor(row.MERGE_COMMIT_SHA) : null
      await sql(`UPDATE ADE_DB.OPS.PULL_REQUESTS SET LAST_ERROR = ?, DEPLOY_RUN_URL = COALESCE(?, DEPLOY_RUN_URL), LAST_SYNCED_AT = SYSDATE() WHERE PR_ID = ?`, [
        "DEPLOY_TIMEOUT: merged but no deploy was recorded",
        run,
        row.PR_ID,
      ])
      if (!current) return
      await incidentStatus(row, "NEEDS_HUMAN", `${prRef} was merged but no deploy has been recorded yet. Check the Deploy workflow${run ? ` (${run})` : ""}; ADE keeps watching and continues when the deploy is recorded.`)
      return
    }
    case "DEPLOYED":
      await deployed(row, action.deploy, current)
      return
  }
}

const deployTable = (database: string) => `${q(database)}.DEPLOY.CHANGE_HISTORY`

/** The deploy that carries this change, from the repo's own deploy record. */
async function findDeploy(row: Row): Promise<ObservedDeploy | null> {
  const since = row.STATE === "MERGED" ? iso(row.MERGED_AT) : iso(row.CREATED_AT)
  if (!since) return null
  const rows = await sql<Record<string, unknown>>(
    `SELECT DEPLOY_ID, COMMIT_SHA, ACTOR, RUN_URL, DEPLOYED_AT, PIPELINE_STATUS FROM IDENTIFIER(?)
     WHERE DEPLOYED_AT >= DATEADD(minute, -2, CONVERT_TIMEZONE('UTC', ?::TIMESTAMP_TZ)::TIMESTAMP_NTZ)
     ORDER BY DEPLOYED_AT LIMIT 20`,
    [deployTable(row.DATABASE_NAME), since],
  )
  const toDeploy = (r: Record<string, unknown>): ObservedDeploy => ({
    deployId: String(r.DEPLOY_ID), commitSha: String(r.COMMIT_SHA), deployedAt: iso(r.DEPLOYED_AT) ?? nowIso(),
    actor: (r.ACTOR as string) ?? null, runUrl: (r.RUN_URL as string) ?? null, pipelineStatus: (r.PIPELINE_STATUS as string) ?? null,
  })
  if (row.STATE === "DEPLOY_NEEDED") return rows.length ? toDeploy(rows[0]) : null
  const merge = row.MERGE_COMMIT_SHA
  if (!merge) return null
  const exact = rows.find((r) => r.COMMIT_SHA === merge)
  if (exact) return toDeploy(exact)
  const gh = repoClient(row.REPO)
  for (const r of rows.slice(0, 3)) {
    const status = await gh.compare(merge, String(r.COMMIT_SHA)).catch(() => "")
    if (status === "ahead" || status === "identical") return toDeploy(r)
  }
  return null
}

async function deployed(row: Row, d: ObservedDeploy, current: boolean): Promise<void> {
  // Does production now run the merged file? (Someone could deploy other code.)
  let drift = row.REVIEW_DRIFT
  const change = await loadChange(row.FIX_ID).catch(() => null)
  const [, schema, name] = row.JOB_FQN.split(".")
  if (change && (row.JOB_TYPE === "TASK" || row.JOB_TYPE === "DYNAMIC_TABLE")) {
    const file = row.PATH ? await repoClient(row.REPO).file(row.PATH, d.commitSha).catch(() => null) : null
    const parsed = file ? parseObjectFile(file.content) : null
    const prod = await productionBody(row.DATABASE_NAME, { type: row.JOB_TYPE, schema, name }).catch(() => null)
    if (parsed && prod !== null && normalizeSql(prod) !== normalizeSql(bindDatabase(parsed.body, row.DATABASE_NAME))) drift = "PRODUCTION_DIFFERS"
  }
  await sql(
    `UPDATE ADE_DB.OPS.PULL_REQUESTS SET STATE = 'DEPLOYED', DEPLOY_ID = ?, DEPLOY_COMMIT_SHA = ?, DEPLOYED_AT = CONVERT_TIMEZONE('UTC', ?::TIMESTAMP_TZ)::TIMESTAMP_NTZ,
       DEPLOY_RUN_URL = ?, PIPELINE_STATUS = ?, REVIEW_DRIFT = ?, LAST_ERROR = NULL, LAST_SYNCED_AT = SYSDATE(), UPDATED_AT = SYSDATE() WHERE PR_ID = ?`,
    [d.deployId, d.commitSha, d.deployedAt, d.runUrl, d.pipelineStatus, drift, row.PR_ID],
  )
  await audit(row, "DEPLOYED", { deploy_id: d.deployId, commit: d.commitSha, run_url: d.runUrl, pipeline: d.pipelineStatus, drift })
  if (!current) return
  await sql(
    `UPDATE ADE_DB.OPS.FIXES SET STATUS = 'APPLIED', APPLIED_AT = CONVERT_TIMEZONE('UTC', ?::TIMESTAMP_TZ)::TIMESTAMP_NTZ, APPLIED_BY = ?, UPDATED_AT = SYSDATE()
     WHERE FIX_ID = ?`,
    [d.deployedAt, `github:${row.MERGED_BY ?? d.actor ?? "deploy"}`, row.FIX_ID],
  )
  await incidentStatus(
    row,
    "VERIFYING",
    `Deployed by GitHub Actions (commit ${d.commitSha.slice(0, 7)})${drift === "PRODUCTION_DIFFERS" ? "; production's definition differs from the merged file" : ""}. Waiting for the job's next successful run.`,
  )
}

/** First run of the job after the deploy decides the outcome. */
async function verifyAfterDeploy(row: Row): Promise<void> {
  const deployedAt = iso(row.DEPLOYED_AT)
  if (!deployedAt || row.INCIDENT_STATUS !== "VERIFYING") return
  const [db, schema, name] = row.JOB_FQN.split(".")
  let outcome: { state: string; at: string | null } | null = null
  if (row.JOB_TYPE === "TASK") {
    const r = await sqlOne<{ S: string; T: unknown }>(
      `SELECT STATE AS S, SCHEDULED_TIME AS T FROM TABLE(${q(db)}.INFORMATION_SCHEMA.TASK_HISTORY(
         SCHEDULED_TIME_RANGE_START => DATEADD(hour, -6, CURRENT_TIMESTAMP()), TASK_NAME => ?, RESULT_LIMIT => 200))
       WHERE DATABASE_NAME = ? AND SCHEMA_NAME = ? AND STATE IN ('SUCCEEDED', 'FAILED', 'FAILED_AND_AUTO_SUSPENDED')
         AND SCHEDULED_TIME > ?::TIMESTAMP_TZ
       ORDER BY SCHEDULED_TIME LIMIT 1`,
      [name, db, schema, deployedAt],
    )
    outcome = r ? { state: r.S, at: iso(r.T) } : null
  } else if (row.JOB_TYPE === "DYNAMIC_TABLE") {
    const r = await sqlOne<{ S: string; T: unknown }>(
      `SELECT STATE AS S, REFRESH_START_TIME AS T FROM TABLE(${q(db)}.INFORMATION_SCHEMA.DYNAMIC_TABLE_REFRESH_HISTORY(NAME => ?, RESULT_LIMIT => 100))
       WHERE STATE IN ('SUCCEEDED', 'FAILED', 'UPSTREAM_FAILED') AND REFRESH_START_TIME > ?::TIMESTAMP_TZ
       ORDER BY REFRESH_START_TIME LIMIT 1`,
      [`${db}.${schema}.${name}`, deployedAt],
    )
    outcome = r ? { state: r.S, at: iso(r.T) } : null
  }
  if (!outcome) return
  // The shared verifier (orchestrator.ts) may have decided first; it runs earlier in the same tick.
  const fix = await sqlOne<{ S: string }>(`SELECT STATUS AS S FROM ADE_DB.OPS.FIXES WHERE FIX_ID = ?`, [row.FIX_ID])
  if (fix?.S !== "APPLIED") return
  const prRef = row.PR_NUMBER ? `pull request #${row.PR_NUMBER}` : "the deploy"
  if (outcome.state === "SUCCEEDED") {
    await sql(`UPDATE ADE_DB.OPS.FIXES SET STATUS = 'VERIFIED', UPDATED_AT = SYSDATE() WHERE FIX_ID = ? AND STATUS = 'APPLIED'`, [row.FIX_ID])
    await incidentStatus(row, "RESOLVED", `Verified: the job succeeded after ${prRef} was deployed`)
    await audit(row, "VERIFIED", { run_at: outcome.at, via: "deploy" })
  } else {
    await sql(`UPDATE ADE_DB.OPS.FIXES SET STATUS = 'VERIFY_FAILED', UPDATED_AT = SYSDATE() WHERE FIX_ID = ? AND STATUS = 'APPLIED'`, [row.FIX_ID])
    await incidentStatus(row, "NEEDS_HUMAN", `The job failed again after ${prRef} was deployed. Revert it on GitHub, or queue the incident again.`)
    await audit(row, "VERIFY_FAILED", { run_at: outcome.at, via: "deploy" })
  }
}

async function incidentStatus(row: Row, status: string, detail: string): Promise<void> {
  await sql(
    `UPDATE ADE_DB.OPS.INCIDENTS SET STATUS = ?, STATUS_DETAIL = ?, UPDATED_AT = SYSDATE()${status === "RESOLVED" ? ", RESOLVED_AT = SYSDATE()" : ""}
     WHERE INCIDENT_ID = ? AND CURRENT_FIX_ID = ?`,
    [status, detail.slice(0, 1000), row.INCIDENT_ID, row.FIX_ID],
  )
  publish({ type: "incident.updated", incidentId: row.INCIDENT_ID, status, at: nowIso() })
}

/** Update only the detail text, and only when it changed (avoids a write per poll). */
async function incidentDetail(row: Row, detail: string): Promise<void> {
  if (row.INCIDENT_DETAIL === detail.slice(0, 1000)) return
  await sql(`UPDATE ADE_DB.OPS.INCIDENTS SET STATUS_DETAIL = ?, UPDATED_AT = SYSDATE() WHERE INCIDENT_ID = ? AND CURRENT_FIX_ID = ?`, [detail.slice(0, 1000), row.INCIDENT_ID, row.FIX_ID])
  publish({ type: "incident.updated", incidentId: row.INCIDENT_ID, status: row.INCIDENT_STATUS, at: nowIso() })
}

async function audit(row: Row, action: string, detail: unknown): Promise<void> {
  await sql(`INSERT INTO ADE_DB.OPS.AUDIT_LOG (INCIDENT_ID, FIX_ID, ACTOR, ACTION, DETAIL) SELECT ?, ?, 'GITHUB_TRACKER', ?, PARSE_JSON(?)`, [row.INCIDENT_ID, row.FIX_ID, action, json(detail)]).catch(() => {})
}
