/**
 * Opening the pull request for an approved fix to a database managed in Git.
 *
 * Nothing an agent can write decides what is pushed. The new file is derived
 * again from the fix's statements (pinned by FIX_HASH, which GUARD's FIX_HASH
 * recomputes, and sealed) and the base file; it must match the sealed change in
 * OPS.SOURCE_CHANGES, and the blob GitHub stores must have the same SHA.
 *
 * Idempotent: a retry after a crash reuses the branch and the open PR. Errors
 * leave the row PENDING with LAST_ERROR; the tracker retries on its next poll.
 */
import { json, num, parseVariant, sql, sqlOne } from "@/lib/server/db"
import { nowIso, publish } from "@/lib/server/events"
import { fixSealParts, sealingAvailable, verify } from "@/lib/server/seal"
import { deliverySettings, githubConfigured, repoClient } from "@/lib/server/github/client"
import { buildChange, classifyGitFix, parseObjectFile } from "@/lib/server/github/files"
import { gitTarget, loadChange } from "@/lib/server/github/source"
import { commitMessage, prBody, prTitle, type PrContent } from "@/lib/server/github/text"

export type OpenResult =
  | { status: "OPEN"; number: number; url: string }
  | { status: "HELD"; reason: string }
  | { status: "BLOCKED"; reason: string }

async function audit(incidentId: string, fixId: string, action: string, detail: unknown): Promise<void> {
  await sql(`INSERT INTO ADE_DB.OPS.AUDIT_LOG (INCIDENT_ID, FIX_ID, ACTOR, ACTION, DETAIL) SELECT ?, ?, 'ORCHESTRATOR', ?, PARSE_JSON(?)`, [incidentId, fixId, action, json(detail)]).catch(() => {})
}

async function setIncident(incidentId: string, status: string, detail: string): Promise<void> {
  await sql(`UPDATE ADE_DB.OPS.INCIDENTS SET STATUS = ?, STATUS_DETAIL = ?, UPDATED_AT = SYSDATE() WHERE INCIDENT_ID = ?`, [status, detail.slice(0, 1000), incidentId])
  publish({ type: "incident.updated", incidentId, status, at: nowIso() })
}

/** Stop this attempt for good: the incident goes to a person, who can queue it again. */
async function block(prId: string, fixId: string, incidentId: string, reason: string): Promise<OpenResult> {
  await sql(`UPDATE ADE_DB.OPS.PULL_REQUESTS SET STATE = 'CANCELLED', LAST_ERROR = ?, UPDATED_AT = SYSDATE() WHERE PR_ID = ?`, [reason.slice(0, 4000), prId])
  await sql(`UPDATE ADE_DB.OPS.FIXES SET STATUS = 'SUPERSEDED', UPDATED_AT = SYSDATE() WHERE FIX_ID = ? AND STATUS = 'PR_PENDING'`, [fixId])
  await setIncident(incidentId, "NEEDS_HUMAN", reason)
  await audit(incidentId, fixId, "PR_BLOCKED", { reason })
  return { status: "BLOCKED", reason }
}

let redactCache: string[] | null = null
/** Account identifiers that must never reach the public repo. */
async function redactions(): Promise<string[]> {
  if (redactCache) return redactCache
  const r = await sqlOne<{ A: string; O: string; L: string }>(`SELECT CURRENT_ACCOUNT_NAME() AS A, CURRENT_ORGANIZATION_NAME() AS O, CURRENT_ACCOUNT() AS L`).catch(() => null)
  redactCache = r ? [`${r.O}-${r.A}`, `${r.O}.${r.A}`, r.A, r.L].filter((s) => s && s.length >= 4) : []
  return redactCache
}

export async function openPullRequest(fixId: string): Promise<OpenResult> {
  const row = await sqlOne<Record<string, string>>(`SELECT * FROM ADE_DB.OPS.PULL_REQUESTS WHERE FIX_ID = ? AND STATE = 'PENDING'`, [fixId])
  if (!row) return { status: "HELD", reason: "No pending pull request for this fix" }
  const prId = row.PR_ID
  const incidentId = row.INCIDENT_ID
  try {
    const { ok, problem, settings } = await githubConfigured()
    if (!ok) return { status: "HELD", reason: `Git delivery is not configured: ${problem}` }
    if (!settings.enabled) return { status: "HELD", reason: "Git delivery is switched off (Settings)" }

    const [fix, incident, change] = await Promise.all([
      sqlOne<Record<string, unknown>>(`SELECT * FROM ADE_DB.OPS.FIXES WHERE FIX_ID = ?`, [fixId]),
      sqlOne<Record<string, unknown>>(`SELECT INCIDENT_NUMBER, DATABASE_NAME, JOB_TYPE, JOB_FQN FROM ADE_DB.OPS.INCIDENTS WHERE INCIDENT_ID = ?`, [incidentId]),
      loadChange(fixId),
    ])
    if (!fix || !incident || !change) return block(prId, fixId, incidentId, "The fix or its file change is missing")
    const database = String(incident.DATABASE_NAME)
    const statements = parseVariant<string[]>(fix.STATEMENTS) ?? []
    const rollback = parseVariant<string[]>(fix.ROLLBACK_STATEMENTS) ?? []

    // 1. The fix and its file change are exactly what the app stored.
    const [h] = await sql<{ H: string }>(`SELECT ADE_DB.GUARD.FIX_HASH(?, PARSE_JSON(?), PARSE_JSON(?)) AS H`, [database, json(statements), json(rollback)])
    const fixSeal = verify(fixSealParts({ fixId, incidentId, version: num(fix.VERSION), fixHash: String(fix.FIX_HASH) }), fix.SEAL as string)
    const strict = sealingAvailable()
    if (h.H !== fix.FIX_HASH || fixSeal === "INVALID" || (strict && fixSeal !== "VALID")) return block(prId, fixId, incidentId, "The fix was changed after it was reviewed; no pull request was opened")
    if (change.seal === "INVALID" || (strict && change.seal !== "VALID")) return block(prId, fixId, incidentId, "The file change was changed after it was reviewed; no pull request was opened")

    // 2. Derive the new file again from the statements and the base file.
    const target = await gitTarget(database, String(incident.JOB_TYPE), String(incident.JOB_FQN))
    if (!target || target.repo !== change.repo || target.path !== change.path) return block(prId, fixId, incidentId, "The job's repo mapping changed since the fix was written; queue the incident again")
    const baseFile = parseObjectFile(change.baseContent)
    const shape = baseFile ? classifyGitFix(statements, target.job, target.repoDefined, baseFile.header) : null
    if (!baseFile || !shape || shape.kind !== "BODY") return block(prId, fixId, incidentId, "The fix no longer maps to a body change of the job's file")
    const rebuilt = buildChange({ path: change.path, baseContent: change.baseContent, baseBlobSha: change.baseBlobSha, file: baseFile }, shape.body)
    if (rebuilt.newBlobSha !== change.newBlobSha) return block(prId, fixId, incidentId, "The stored file change does not match the reviewed fix; no pull request was opened")

    // 3. One ADE pull request per file at a time.
    const other = await sqlOne<{ N: number; U: string }>(
      `SELECT PR_NUMBER AS N, PR_URL AS U FROM ADE_DB.OPS.PULL_REQUESTS WHERE REPO = ? AND PATH = ? AND STATE = 'OPEN' AND FIX_ID <> ? LIMIT 1`,
      [change.repo, change.path, fixId],
    )
    if (other) return block(prId, fixId, incidentId, `Another ADE pull request (#${other.N}, ${other.U}) is open for ${change.path}. Queue this incident again after it is merged or closed.`)

    // 4. main must still have the file the fix was written against.
    const gh = repoClient(change.repo)
    const head = await gh.headSha(change.baseBranch)
    let base = change.baseCommitSha
    if (head !== base) {
      const now = await gh.file(change.path, head)
      if (now.sha !== change.baseBlobSha) return block(prId, fixId, incidentId, `${change.path} changed on ${change.baseBranch} after the fix was written. Queue the incident again to fix the current code.`)
      base = head
    }

    const [diag, review, rehearsal] = await Promise.all([
      sqlOne<{ P: unknown }>(`SELECT PAYLOAD AS P FROM ADE_DB.OPS.DIAGNOSES WHERE INCIDENT_ID = ? ORDER BY CREATED_AT DESC LIMIT 1`, [incidentId]),
      sqlOne<Record<string, unknown>>(`SELECT VERDICT, CONFIDENCE, SUMMARY, CONCERNS FROM ADE_DB.OPS.REVIEWS WHERE FIX_ID = ? ORDER BY CREATED_AT DESC LIMIT 1`, [fixId]),
      sqlOne<Record<string, unknown>>(`SELECT OUTCOME, REASON FROM ADE_DB.OPS.REHEARSALS WHERE FIX_ID = ? ORDER BY STARTED_AT DESC LIMIT 1`, [fixId]),
    ])
    const diagnosis = parseVariant<Record<string, unknown>>(diag?.P) ?? {}
    const content: PrContent = {
      incidentNumber: num(incident.INCIDENT_NUMBER),
      jobType: target.job.type,
      objectName: `${target.job.schema}.${target.job.name}`,
      path: change.path,
      version: num(fix.VERSION),
      fix: {
        title: String(fix.TITLE ?? "Fix"),
        summary: String(fix.SUMMARY ?? ""),
        assumptions: parseVariant<string[]>(fix.ASSUMPTIONS) ?? [],
        verificationPlan: String(fix.VERIFICATION_PLAN ?? ""),
        riskLevel: String(fix.RISK_LEVEL ?? ""),
      },
      rootCause: String(diagnosis.root_cause ?? diagnosis.summary ?? ""),
      rehearsal: { outcome: String(rehearsal?.OUTCOME ?? "NOT_RUN"), reason: String(rehearsal?.REASON ?? "") },
      review: { verdict: String(review?.VERDICT ?? ""), confidence: num(review?.CONFIDENCE), summary: String(review?.SUMMARY ?? ""), concerns: parseVariant<string[]>(review?.CONCERNS) ?? [] },
      fixHash: String(fix.FIX_HASH),
      patchHash: change.patchHash,
      productionDiffered: row.REVIEW_DRIFT === "PRODUCTION_DIFFERS",
    }
    const opts = { redact: await redactions() }
    const branch = row.BRANCH

    // 5. Reuse an open PR for this branch (retry), else commit and open one.
    let pr = await gh.openPullFor(branch)
    let commit: string
    if (pr) {
      commit = pr.head.sha
      if ((await gh.file(change.path, commit)).sha !== change.newBlobSha) return block(prId, fixId, incidentId, `Branch ${branch} already has a different change; close its pull request and queue the incident again`)
    } else {
      const blob = await gh.createBlob(change.newContent)
      if (blob !== change.newBlobSha) throw new Error(`GitHub stored a different blob (${blob}) than expected (${change.newBlobSha})`)
      const tree = await gh.createTree(await gh.commitTree(base), change.path, blob)
      commit = await gh.createCommit(commitMessage(content, opts), tree, base)
      await gh.setBranch(branch, commit)
      if ((await gh.file(change.path, commit)).sha !== change.newBlobSha) throw new Error("The pushed file does not match the reviewed change")
    }

    // 6. Informational statuses (validate is the required check).
    const passed = content.rehearsal.outcome === "PASSED"
    await gh.setStatus(commit, "ade/rehearsal", passed ? "success" : "failure", `Sandbox rehearsal ${content.rehearsal.outcome}`).catch(() => {})
    await gh.setStatus(commit, "ade/review", "success", `Reviewer ${content.review.verdict}, confidence ${Math.round(content.review.confidence)}`).catch(() => {})

    if (!pr) {
      try {
        const created = await gh.createPull(prTitle(content, opts), branch, change.baseBranch, prBody(content, opts))
        pr = { number: created.number, html_url: created.html_url, head: { sha: commit } }
      } catch (e) {
        pr = await gh.openPullFor(branch)
        if (!pr) throw e
      }
    }
    await gh.addLabels(pr.number, ["ade"]).catch(() => {})

    await sql(
      `UPDATE ADE_DB.OPS.PULL_REQUESTS SET STATE = 'OPEN', PR_NUMBER = ?, PR_URL = ?, HEAD_SHA = ?, CURRENT_HEAD_SHA = ?, LAST_ERROR = NULL,
         LAST_SYNCED_AT = SYSDATE(), UPDATED_AT = SYSDATE() WHERE PR_ID = ?`,
      [pr.number, pr.html_url, commit, commit, prId],
    )
    await sql(`UPDATE ADE_DB.OPS.FIXES SET STATUS = 'PR_OPEN', UPDATED_AT = SYSDATE() WHERE FIX_ID = ?`, [fixId])
    await setIncident(incidentId, "PR_OPEN", `Pull request #${pr.number} is waiting for review on GitHub`)
    await audit(incidentId, fixId, "PR_OPENED", { number: pr.number, url: pr.html_url, branch, commit, patch_hash: change.patchHash })
    return { status: "OPEN", number: pr.number, url: pr.html_url }
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e)
    await sql(`UPDATE ADE_DB.OPS.PULL_REQUESTS SET LAST_ERROR = ?, UPDATED_AT = SYSDATE() WHERE PR_ID = ?`, [message.slice(0, 4000), prId]).catch(() => {})
    return { status: "HELD", reason: message }
  }
}

/** Settings that decide whether a pending PR can be opened now (for status text). */
export async function deliveryState(): Promise<{ configured: boolean; enabled: boolean; problem: string | null }> {
  const { ok, problem } = await githubConfigured()
  const s = await deliverySettings()
  return { configured: ok, enabled: s.enabled, problem }
}
