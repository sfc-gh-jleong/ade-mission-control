/**
 * The orchestrator: drives each incident through the three agents.
 *
 *   DETECTED/QUEUED -> INVESTIGATING (Investigator)
 *     -> NO_FIX (transient/external) | NEEDS_HUMAN (unclear)
 *     -> FIXING (Fixer) -> REHEARSING (sandbox) -> REVIEWING (Reviewer)
 *          REVISE / rehearsal FAILED  -> FIXING again (max N iterations)
 *          REJECT                     -> NEEDS_HUMAN
 *          APPROVE                    -> AWAITING_APPROVAL (human, via GUARD)
 *   APPLY and ROLLBACK are human actions (lib/server/actions.ts + GUARD procs).
 *   VERIFYING -> RESOLVED when the job's next run succeeds (verifier below).
 *
 * Incidents are claimed with a lease (compare-and-set UPDATE on the hybrid
 * table) so a restarted process resumes cleanly; at most `max_in_flight`
 * incidents are processed at once; `pipeline.enabled` is the kill switch.
 *
 * Idle cost: the loop checks OPS.DOORBELL_SEQ with SHOW SEQUENCES (metadata
 * only, no warehouse) and queries the hybrid tables only when the doorbell
 * moved, work is queued, or every few minutes as a safety net.
 */
import os from "node:os"
import { sql, sqlOne, json, num, iso } from "@/lib/server/db"
import { nowIso, publish, type OrchestratorState } from "@/lib/server/events"
import { agentsAllowedHere } from "@/lib/server/cortex"
import { runAgentPhase } from "@/lib/server/agents/turn-runner"
import { DiagnosisSchema, FixSchema, ReviewSchema, type Diagnosis, type FixProposal, type Review } from "@/lib/server/agents/schemas"
import { screenRollback, screenStatements } from "@/lib/server/agents/sql-guard"
import { rehearse, saveRehearsal, sweepSandboxes, type RehearsalResult } from "@/lib/server/rehearsal/engine"
import { Step, savePayload, systemStep } from "@/lib/server/telemetry"
import { seal, fixSealParts, reviewSealParts } from "@/lib/server/seal"
import { briefForFixer, briefForInvestigator, briefForReviewer, revisionBrief } from "@/lib/server/agents/prompts"
import { capConfidence, type AgentRole } from "@/lib/domain"

const INSTANCE = `${os.hostname()}:${process.pid}`
const TICK_MS = 15_000
const SAFETY_POLL_MS = 5 * 60_000
const SWEEP_MS = 30 * 60_000

interface Settings {
  enabled: boolean
  maxInFlight: number
  maxFixIterations: number
  leaseSeconds: number
  maxTokensPerIncident: number
  maxMinutesPerAgent: number
  minConfidence: number
  autoRerunTransient: boolean
}

export interface IncidentRow {
  INCIDENT_ID: string
  INCIDENT_NUMBER: number
  SCOPE_ID: string
  JOB_ID: string
  JOB_TYPE: string
  JOB_FQN: string
  DATABASE_NAME: string
  TITLE: string
  STATUS: string
  SEVERITY: string
  CATEGORY: string | null
  ERROR_CODE: string | null
  ERROR_MESSAGE: string | null
  LAST_QUERY_ID: string | null
  GRAPH_RUN_GROUP_ID: string | null
  OCCURRENCES: number
  FIRST_SEEN_AT: unknown
  LAST_SEEN_AT: unknown
  FIX_ITERATIONS: number
  ATTEMPTS: number
  TOTAL_TOKENS: number
  INVESTIGATOR_THREAD_ID: string | null
  FIXER_THREAD_ID: string | null
  REVIEWER_THREAD_ID: string | null
  CURRENT_FIX_ID: string | null
}

const g = globalThis as unknown as {
  __adeOrch?: { timer: ReturnType<typeof setInterval> | null; running: Map<string, Promise<void>>; state: OrchestratorState; lastDoorbell: string | null; lastPoll: number; lastSweep: number; wake: boolean }
}

export function orchestratorState(): OrchestratorState | null {
  return g.__adeOrch?.state ?? null
}

/** Ask the loop to look for work on the next tick (e.g. after a user queues an incident). */
export function wakeOrchestrator(): void {
  if (g.__adeOrch) g.__adeOrch.wake = true
}

export function startOrchestrator(): void {
  if (g.__adeOrch) return
  g.__adeOrch = {
    timer: null,
    running: new Map(),
    lastDoorbell: null,
    lastPoll: 0,
    lastSweep: 0,
    wake: true,
    state: { instance: INSTANCE, enabled: true, running: 0, maxInFlight: 2, lastTickAt: null, lastError: null, startedAt: nowIso() },
  }
  const loop = () => void tick().catch((e) => {
    g.__adeOrch!.state.lastError = e instanceof Error ? e.message : String(e)
    console.error(nowIso(), "[orchestrator] tick failed", e)
  })
  g.__adeOrch.timer = setInterval(loop, TICK_MS)
  setTimeout(loop, 3000)
  console.log(nowIso(), "[orchestrator] started", INSTANCE)
}

async function readSettings(): Promise<Settings> {
  const rows = await sql<{ K: string; V: string }>(`SELECT SETTING_KEY AS K, SETTING_VALUE::STRING AS V FROM ADE_DB.OPS.SETTINGS`)
  const m = new Map(rows.map((r) => [r.K, r.V]))
  const n = (k: string, d: number) => (Number.isFinite(Number(m.get(k))) ? Number(m.get(k)) : d)
  return {
    enabled: (m.get("pipeline.enabled") ?? "true") !== "false",
    maxInFlight: Math.max(1, Math.min(5, n("pipeline.max_in_flight", 2))),
    maxFixIterations: Math.max(1, Math.min(4, n("pipeline.max_fix_iterations", 2))),
    leaseSeconds: Math.max(300, n("pipeline.lease_seconds", 900)),
    maxTokensPerIncident: n("budget.max_tokens_per_incident", 2_500_000),
    maxMinutesPerAgent: Math.max(5, n("budget.max_minutes_per_agent", 20)),
    minConfidence: n("apply.min_confidence", 80),
    autoRerunTransient: (m.get("pipeline.auto_rerun_transient") ?? "false") === "true",
  }
}

async function doorbell(): Promise<string | null> {
  try {
    const rows = await sql<{ next_value: string }>(`SHOW SEQUENCES LIKE 'DOORBELL_SEQ' IN SCHEMA ADE_DB.OPS ->> SELECT "next_value" FROM $1`)
    return rows[0] ? String(rows[0].next_value) : null
  } catch {
    return null
  }
}

async function tick(): Promise<void> {
  const o = g.__adeOrch!
  o.state.lastTickAt = nowIso()
  if (!agentsAllowedHere().allowed) return
  const bell = await doorbell()
  const due = o.wake || bell !== o.lastDoorbell || Date.now() - o.lastPoll > SAFETY_POLL_MS || o.running.size > 0
  publish({ type: "orchestrator.heartbeat", state: { ...o.state, running: o.running.size }, at: nowIso() })
  if (!due) return
  o.wake = false
  o.lastDoorbell = bell
  o.lastPoll = Date.now()

  const settings = await readSettings()
  o.state.enabled = settings.enabled
  o.state.maxInFlight = settings.maxInFlight
  await checkVerifications().catch((e) => console.error(nowIso(), "[orchestrator] verification check failed", e))
  if (Date.now() - o.lastSweep > SWEEP_MS) {
    o.lastSweep = Date.now()
    await sweepSandboxes().catch(() => 0)
  }
  if (!settings.enabled) return

  const free = settings.maxInFlight - o.running.size
  if (free <= 0) return
  // Claim work: live DETECTED incidents and human-QUEUED ones, plus incidents
  // whose lease expired mid-flight (process restart). Severity first.
  const claimed = await claim(free, settings.leaseSeconds)
  for (const incident of claimed) {
    const p = processIncident(incident, settings)
      .catch(async (e) => {
        const message = e instanceof Error ? e.message : String(e)
        console.error(nowIso(), "[orchestrator] incident crashed", incident.INCIDENT_NUMBER, e)
        // Record the crash where people look (the trace) and park the incident.
        await systemStep(incident.INCIDENT_ID, "ORCHESTRATE", "Pipeline error", async () => ({ value: null, status: "FAILED", summary: message.slice(0, 1000) })).catch(() => {})
        await setStatus(incident.INCIDENT_ID, "NEEDS_HUMAN", `Pipeline error: ${message.slice(0, 300)}`).catch(() => {})
      })
      .finally(() => {
        o.running.delete(incident.INCIDENT_ID)
        o.state.running = o.running.size
        o.wake = true
      })
    o.running.set(incident.INCIDENT_ID, p)
  }
  o.state.running = o.running.size
}

const RESUMABLE = ["INVESTIGATING", "FIXING", "REHEARSING", "REVIEWING"]

async function claim(limit: number, leaseSeconds: number): Promise<IncidentRow[]> {
  const candidates = await sql<{ INCIDENT_ID: string }>(
    `SELECT INCIDENT_ID FROM ADE_DB.OPS.INCIDENTS
     WHERE ((STATUS = 'DETECTED' AND NOT IS_BACKFILL) OR STATUS = 'QUEUED'
            OR (STATUS IN ('INVESTIGATING', 'FIXING', 'REHEARSING', 'REVIEWING') AND COALESCE(LEASE_EXPIRES_AT, '1970-01-01'::TIMESTAMP_NTZ) < SYSDATE()))
       AND ROOT_INCIDENT_ID IS NULL
     ORDER BY CASE SEVERITY WHEN 'CRITICAL' THEN 0 WHEN 'HIGH' THEN 1 WHEN 'MEDIUM' THEN 2 ELSE 3 END, LAST_SEEN_AT DESC
     LIMIT ?`,
    [limit * 3],
  )
  const out: IncidentRow[] = []
  for (const c of candidates) {
    if (out.length >= limit) break
    const owner = `${INSTANCE}:${crypto.randomUUID().slice(0, 8)}`
    await sql(
      `UPDATE ADE_DB.OPS.INCIDENTS
       SET LEASE_OWNER = ?, LEASE_EXPIRES_AT = DATEADD(second, ?, SYSDATE()), ATTEMPTS = ATTEMPTS + 1,
           STATUS = IFF(STATUS IN ('DETECTED', 'QUEUED'), 'INVESTIGATING', STATUS), UPDATED_AT = SYSDATE()
       WHERE INCIDENT_ID = ?
         AND ((STATUS = 'DETECTED' AND NOT IS_BACKFILL) OR STATUS = 'QUEUED'
              OR (STATUS IN ('INVESTIGATING', 'FIXING', 'REHEARSING', 'REVIEWING') AND COALESCE(LEASE_EXPIRES_AT, '1970-01-01'::TIMESTAMP_NTZ) < SYSDATE()))`,
      [owner, leaseSeconds, c.INCIDENT_ID],
    )
    const row = await sqlOne<IncidentRow & { LEASE_OWNER: string }>(`SELECT * FROM ADE_DB.OPS.INCIDENTS WHERE INCIDENT_ID = ?`, [c.INCIDENT_ID])
    if (row && row.LEASE_OWNER === owner) out.push(row)
  }
  return out
}

async function setStatus(incidentId: string, status: string, detail: string, extra: Record<string, string | number | null> = {}): Promise<void> {
  const cols = Object.keys(extra)
  await sql(
    `UPDATE ADE_DB.OPS.INCIDENTS SET STATUS = ?, STATUS_DETAIL = ?, UPDATED_AT = SYSDATE()${cols.map((c) => `, ${c} = ?`).join("")}
     ${status === "RESOLVED" || status === "NO_FIX" ? ", RESOLVED_AT = SYSDATE()" : ""}
     WHERE INCIDENT_ID = ?`,
    [status, detail.slice(0, 1000), ...cols.map((c) => extra[c]), incidentId],
  )
  publish({ type: "incident.updated", incidentId, status, at: nowIso() })
}

async function renewLease(incidentId: string, leaseSeconds: number): Promise<void> {
  await sql(`UPDATE ADE_DB.OPS.INCIDENTS SET LEASE_EXPIRES_AT = DATEADD(second, ?, SYSDATE()) WHERE INCIDENT_ID = ?`, [leaseSeconds, incidentId])
}

async function audit(incidentId: string, fixId: string | null, action: string, detail: unknown): Promise<void> {
  await sql(
    `INSERT INTO ADE_DB.OPS.AUDIT_LOG (INCIDENT_ID, FIX_ID, ACTOR, ACTION, DETAIL) SELECT ?, ?, 'ORCHESTRATOR', ?, PARSE_JSON(?)`,
    [incidentId, fixId, action, json(detail)],
  ).catch(() => {})
}

async function overBudget(incidentId: string, settings: Settings): Promise<boolean> {
  const r = await sqlOne<{ T: number }>(`SELECT TOTAL_TOKENS AS T FROM ADE_DB.OPS.INCIDENTS WHERE INCIDENT_ID = ?`, [incidentId])
  return num(r?.T) > settings.maxTokensPerIncident
}

async function processIncident(incident: IncidentRow, settings: Settings): Promise<void> {
  const id = incident.INCIDENT_ID
  const lease = setInterval(() => void renewLease(id, settings.leaseSeconds).catch(() => {}), 60_000)
  try {
    publish({ type: "incident.updated", incidentId: id, status: "INVESTIGATING", at: nowIso() })
    await audit(id, null, "CLAIMED", { instance: INSTANCE, attempt: incident.ATTEMPTS + 1, resumed_from: incident.STATUS })

    // ---------------- Investigate (skipped when resuming an incident that has a diagnosis)
    let diagnosis = await latestDiagnosis(id)
    if (!diagnosis) {
      await setStatus(id, "INVESTIGATING", "Investigator is gathering evidence")
      const evidence = await systemStep(id, "INVESTIGATE", "Collect failure context for the Investigator", async () => {
        const ctx = await failureContext(incident)
        return { value: ctx, summary: `${ctx.runs.length} failed runs, ${ctx.related.length} related incidents`, detail: { runs: ctx.runs.length } }
      })
      const out = await runAgentPhase<Diagnosis>({
        incidentId: id,
        role: "INVESTIGATOR",
        phase: "INVESTIGATE",
        task: `Diagnose ${incident.JOB_FQN}`,
        prompt: briefForInvestigator(incident, evidence),
        schema: DiagnosisSchema,
        threadId: incident.INVESTIGATOR_THREAD_ID,
        timeoutMs: settings.maxMinutesPerAgent * 60_000,
      })
      await sql(`UPDATE ADE_DB.OPS.INCIDENTS SET INVESTIGATOR_THREAD_ID = ? WHERE INCIDENT_ID = ?`, [out.threadId, id])
      if (!out.value) {
        await setStatus(id, "NEEDS_HUMAN", `Investigator could not finish: ${out.error ?? "unknown error"}`)
        return
      }
      diagnosis = out.value
      await sql(
        `INSERT INTO ADE_DB.OPS.DIAGNOSES (INCIDENT_ID, AGENT_RUN_ID, CATEGORY, SEVERITY, ROOT_CAUSE, FIXABILITY, IS_TRANSIENT, CONFIDENCE,
           RECOMMENDATION, EVIDENCE, AFFECTED_OBJECTS, PAYLOAD)
         SELECT ?, ?, ?, ?, ?, ?, ?, ?, ?, PARSE_JSON(?), PARSE_JSON(?), PARSE_JSON(?)`,
        [id, out.agentRunId, diagnosis.category, diagnosis.severity, diagnosis.root_cause, diagnosis.fixability, diagnosis.is_transient,
         diagnosis.confidence, diagnosis.recommendation, json(diagnosis.evidence), json(diagnosis.affected_objects), json(diagnosis)],
      )
      await sql(
        `UPDATE ADE_DB.OPS.INCIDENTS SET CATEGORY = ?, SEVERITY = ?, SUMMARY = ?, UPDATED_AT = SYSDATE() WHERE INCIDENT_ID = ?`,
        [diagnosis.category, diagnosis.severity, diagnosis.summary, id],
      )
    }

    if (diagnosis.fixability === "TRANSIENT_RETRY" || diagnosis.is_transient) {
      await setStatus(id, "NO_FIX", `Transient failure: ${diagnosis.summary}. A rerun is expected to succeed.`)
      await audit(id, null, "NO_FIX_TRANSIENT", { summary: diagnosis.summary })
      return
    }
    if (diagnosis.fixability === "EXTERNAL" || diagnosis.fixability === "NEEDS_HUMAN") {
      await setStatus(id, "NEEDS_HUMAN", `${diagnosis.fixability === "EXTERNAL" ? "Needs another team" : "Needs a person"}: ${diagnosis.summary}`)
      return
    }

    // ---------------- Fix -> Rehearse -> Review loop
    // A resumed incident's in-flight fix versions are stale; the loop writes a new one.
    await sql(
      `UPDATE ADE_DB.OPS.FIXES SET STATUS = 'SUPERSEDED', UPDATED_AT = SYSDATE() WHERE INCIDENT_ID = ? AND STATUS IN ('PROPOSED', 'REHEARSED', 'REVIEWED')`,
      [id],
    )
    let feedback: string | null = null
    let iteration = num(incident.FIX_ITERATIONS)
    while (iteration < settings.maxFixIterations) {
      if (await overBudget(id, settings)) {
        await setStatus(id, "NEEDS_HUMAN", `Token budget exceeded (${settings.maxTokensPerIncident.toLocaleString()} tokens)`)
        return
      }
      iteration += 1
      await setStatus(id, "FIXING", iteration === 1 ? "Fixer is writing a fix" : `Fixer is revising (iteration ${iteration})`, { FIX_ITERATIONS: iteration })
      const fixThread = await threadOf(id, "FIXER")
      const fixOut = await runAgentPhase<FixProposal>({
        incidentId: id,
        role: "FIXER",
        phase: "FIX",
        task: iteration === 1 ? `Write a fix for ${incident.JOB_FQN}` : `Revise the fix (iteration ${iteration})`,
        prompt: feedback ? revisionBrief(feedback) : briefForFixer(incident, diagnosis),
        schema: FixSchema,
        validate: (fix) => {
          if (fix.strategy === "RERUN_ONLY") return fix.statements.length ? "RERUN_ONLY fixes must have no statements" : null
          if (!fix.statements.length) return "A fix needs at least one statement (or strategy RERUN_ONLY)"
          const fwd = screenStatements(fix.statements)
          const back = screenRollback(fix.rollback_statements, fix.statements)
          const errors = [...fwd.errors, ...back.errors.map((e) => `rollback ${e}`)]
          return errors.length ? errors.join("; ") : null
        },
        threadId: fixThread,
        iteration,
        timeoutMs: settings.maxMinutesPerAgent * 60_000,
      })
      await sql(`UPDATE ADE_DB.OPS.INCIDENTS SET FIXER_THREAD_ID = ? WHERE INCIDENT_ID = ?`, [fixOut.threadId, id])
      if (!fixOut.value) {
        await setStatus(id, "NEEDS_HUMAN", `Fixer could not produce a valid fix: ${fixOut.error ?? "unknown error"}`)
        return
      }
      const fix = fixOut.value
      if (fix.strategy === "RERUN_ONLY") {
        await setStatus(id, "NO_FIX", `Fixer recommends a plain rerun: ${fix.summary}`)
        return
      }
      const stored = await storeFix(incident, fix, fixOut.agentRunId, iteration)

      // Rehearse
      await setStatus(id, "REHEARSING", "Rehearsing the fix in a sandbox clone", { CURRENT_FIX_ID: stored.fixId })
      const rehearsal = await runRehearsal(incident, stored.fixId, fix, iteration)

      // Review
      await setStatus(id, "REVIEWING", `Reviewer is scoring the fix (rehearsal ${rehearsal.outcome})`)
      const reviewThread = await threadOf(id, "REVIEWER")
      const reviewOut = await runAgentPhase<Review>({
        incidentId: id,
        role: "REVIEWER",
        phase: "REVIEW",
        task: `Review fix v${iteration} for ${incident.JOB_FQN}`,
        prompt: briefForReviewer(incident, diagnosis, fix, rehearsal, iteration),
        schema: ReviewSchema,
        threadId: reviewThread,
        iteration,
        timeoutMs: settings.maxMinutesPerAgent * 60_000,
      })
      await sql(`UPDATE ADE_DB.OPS.INCIDENTS SET REVIEWER_THREAD_ID = ? WHERE INCIDENT_ID = ?`, [reviewOut.threadId, id])
      if (!reviewOut.value) {
        await setStatus(id, "NEEDS_HUMAN", `Reviewer could not finish: ${reviewOut.error ?? "unknown error"}`)
        return
      }
      const review = reviewOut.value
      const { confidence, capReason } = capConfidence(review.confidence, rehearsal.outcome)
      await storeReview(stored, review, reviewOut.agentRunId, confidence, capReason, rehearsal.outcome)

      const verdict = rehearsal.outcome === "FAILED" && review.verdict === "APPROVE" ? "REVISE" : review.verdict
      if (verdict === "APPROVE" && confidence >= settings.minConfidence) {
        await sql(`UPDATE ADE_DB.OPS.FIXES SET STATUS = 'AWAITING_APPROVAL', UPDATED_AT = SYSDATE() WHERE FIX_ID = ?`, [stored.fixId])
        await setStatus(id, "AWAITING_APPROVAL", `Fix v${iteration} ready for approval (confidence ${confidence.toFixed(0)})`, { CONFIDENCE: confidence })
        await audit(id, stored.fixId, "READY_FOR_APPROVAL", { confidence, rehearsal: rehearsal.outcome })
        return
      }
      if (verdict === "REJECT") {
        await sql(`UPDATE ADE_DB.OPS.FIXES SET STATUS = 'REJECTED', UPDATED_AT = SYSDATE() WHERE FIX_ID = ?`, [stored.fixId])
        await setStatus(id, "NEEDS_HUMAN", `Reviewer rejected the fix: ${review.summary.slice(0, 300)}`, { CONFIDENCE: confidence })
        return
      }
      // REVISE (or APPROVE below the confidence bar): loop with feedback.
      await sql(`UPDATE ADE_DB.OPS.FIXES SET STATUS = 'SUPERSEDED', UPDATED_AT = SYSDATE() WHERE FIX_ID = ?`, [stored.fixId])
      await sql(`UPDATE ADE_DB.OPS.INCIDENTS SET CONFIDENCE = ? WHERE INCIDENT_ID = ?`, [confidence, id])
      feedback = feedbackFor(review, rehearsal, confidence, capReason, settings.minConfidence)
    }
    await setStatus(id, "NEEDS_HUMAN", `No fix reached the confidence bar after ${settings.maxFixIterations} iterations`)
  } finally {
    clearInterval(lease)
    await sql(`UPDATE ADE_DB.OPS.INCIDENTS SET LEASE_OWNER = NULL, LEASE_EXPIRES_AT = NULL WHERE INCIDENT_ID = ?`, [id]).catch(() => {})
  }
}

async function threadOf(incidentId: string, role: AgentRole): Promise<string | null> {
  const col = role === "INVESTIGATOR" ? "INVESTIGATOR_THREAD_ID" : role === "FIXER" ? "FIXER_THREAD_ID" : "REVIEWER_THREAD_ID"
  const r = await sqlOne<{ T: string | null }>(`SELECT ${col} AS T FROM ADE_DB.OPS.INCIDENTS WHERE INCIDENT_ID = ?`, [incidentId])
  return r?.T ?? null
}

async function latestDiagnosis(incidentId: string): Promise<Diagnosis | null> {
  const r = await sqlOne<{ P: unknown }>(`SELECT PAYLOAD AS P FROM ADE_DB.OPS.DIAGNOSES WHERE INCIDENT_ID = ? ORDER BY CREATED_AT DESC LIMIT 1`, [incidentId])
  if (!r?.P) return null
  const parsed = DiagnosisSchema.safeParse(typeof r.P === "string" ? JSON.parse(r.P) : r.P)
  return parsed.success ? parsed.data : null
}

export interface FailureContext {
  runs: Record<string, unknown>[]
  job: Record<string, unknown> | null
  related: Record<string, unknown>[]
}

async function failureContext(incident: IncidentRow): Promise<FailureContext> {
  const [runs, job, related] = await Promise.all([
    sql(
      `SELECT STATE, SCHEDULED_AT, COMPLETED_AT, ERROR_CODE, LEFT(ERROR_MESSAGE, 2000) AS ERROR_MESSAGE, QUERY_ID, GRAPH_RUN_GROUP_ID, ATTEMPT_NUMBER
       FROM ADE_DB.OPS.JOB_RUNS WHERE JOB_ID = ? ORDER BY SCHEDULED_AT DESC LIMIT 8`,
      [incident.JOB_ID],
    ),
    sqlOne(
      `SELECT FQN, JOB_TYPE, OWNER_ROLE, WAREHOUSE, SCHEDULE, STATE, PREDECESSORS, LAST_SUCCESS_AT, LAST_FAILURE_AT, RUNS_24H, FAILURES_24H
       FROM ADE_DB.OPS.JOBS WHERE JOB_ID = ?`,
      [incident.JOB_ID],
    ),
    sql(
      `SELECT INCIDENT_NUMBER, JOB_FQN, STATUS, ERROR_CODE, LEFT(TITLE, 200) AS TITLE, LAST_SEEN_AT
       FROM ADE_DB.OPS.INCIDENTS
       WHERE DATABASE_NAME = ? AND INCIDENT_ID <> ? AND LAST_SEEN_AT > DATEADD(day, -2, SYSDATE())
       ORDER BY LAST_SEEN_AT DESC LIMIT 10`,
      [incident.DATABASE_NAME, incident.INCIDENT_ID],
    ),
  ])
  return { runs, job, related }
}

interface StoredFix {
  fixId: string
  incidentId: string
  version: number
  fixHash: string
}

async function storeFix(incident: IncidentRow, fix: FixProposal, agentRunId: string, version: number): Promise<StoredFix> {
  const fixId = crypto.randomUUID()
  const statements = fix.statements.map((s) => s.trim())
  const rollback = fix.rollback_statements.map((s) => s.trim())
  // The same canonical hash GUARD recomputes before approve/apply.
  const [h] = await sql<{ H: string }>(`SELECT ADE_DB.GUARD.FIX_HASH(?, PARSE_JSON(?), PARSE_JSON(?)) AS H`, [incident.DATABASE_NAME, json(statements), json(rollback)])
  const fixHash = h.H
  const stored = { fixId, incidentId: incident.INCIDENT_ID, version, fixHash }
  await sql(
    `INSERT INTO ADE_DB.OPS.FIXES (FIX_ID, INCIDENT_ID, VERSION, AGENT_RUN_ID, STATUS, TITLE, SUMMARY, STRATEGY, STATEMENTS, ROLLBACK_STATEMENTS,
       TARGET_OBJECTS, RISK_LEVEL, ASSUMPTIONS, VERIFICATION_PLAN, FIX_HASH, SEAL)
     SELECT ?, ?, ?, ?, 'PROPOSED', ?, ?, ?, PARSE_JSON(?), PARSE_JSON(?), PARSE_JSON(?), ?, PARSE_JSON(?), ?, ?, ?`,
    [fixId, incident.INCIDENT_ID, version, agentRunId, fix.title, fix.summary, fix.strategy, json(statements), json(rollback),
     json(fix.target_objects), fix.risk_level, json(fix.assumptions), fix.verification_plan, fixHash, seal(fixSealParts(stored))],
  )
  await audit(incident.INCIDENT_ID, fixId, "FIX_PROPOSED", { version, strategy: fix.strategy, statements: statements.length, risk: fix.risk_level })
  return stored
}

async function runRehearsal(incident: IncidentRow, fixId: string, fix: FixProposal, attempt: number): Promise<RehearsalResult> {
  const rehearsalId = crypto.randomUUID()
  await sql(`INSERT INTO ADE_DB.OPS.REHEARSALS (REHEARSAL_ID, FIX_ID, INCIDENT_ID) SELECT ?, ?, ?`, [rehearsalId, fixId, incident.INCIDENT_ID])
  const step = await Step.begin({ incidentId: incident.INCIDENT_ID, kind: "SYSTEM", actor: "SYSTEM", phase: "REHEARSE", task: `Rehearse fix v${attempt} in a sandbox clone` })
  const [schema, name] = incident.JOB_FQN.split(".").slice(1)
  let result: RehearsalResult
  try {
    result = await rehearse(
      {
        incidentNumber: incident.INCIDENT_NUMBER,
        incidentId: incident.INCIDENT_ID,
        jobType: incident.JOB_TYPE,
        database: incident.DATABASE_NAME,
        schema,
        name,
        errorCode: incident.ERROR_CODE,
        errorMessage: incident.ERROR_MESSAGE,
      },
      fix.statements,
      attempt,
      (entry) =>
        publish({ type: "agent.status", incidentId: incident.INCIDENT_ID, stepId: step.stepId, actor: "SYSTEM", status: `rehearsal.${entry.step.toLowerCase()}`, message: entry.ok ? (entry.result ?? "ok") : (entry.error ?? "failed"), at: nowIso() }),
    )
  } catch (e) {
    result = { outcome: "INCONCLUSIVE", reason: `Rehearsal error: ${e instanceof Error ? e.message : String(e)}`, sandbox: "", reproduced: null, log: [], durationMs: 0 }
  }
  await saveRehearsal(rehearsalId, result)
  await savePayload(step.stepId, incident.INCIDENT_ID, "SQL_LOG", result.log)
  await step.end({
    status: result.outcome === "PASSED" ? "SUCCEEDED" : result.outcome === "FAILED" ? "FAILED" : "SKIPPED",
    summary: `${result.outcome}: ${result.reason}`,
    detail: { outcome: result.outcome, reproduced: result.reproduced, sandbox: result.sandbox, steps: result.log.length },
  })
  await sql(`UPDATE ADE_DB.OPS.FIXES SET STATUS = 'REHEARSED', UPDATED_AT = SYSDATE() WHERE FIX_ID = ?`, [fixId])
  return result
}

async function storeReview(fix: StoredFix, review: Review, agentRunId: string, confidence: number, capReason: string | null, rehearsalOutcome: string): Promise<void> {
  const reviewId = crypto.randomUUID()
  const sealValue = seal(reviewSealParts({ reviewId, fixId: fix.fixId, verdict: review.verdict, rawConfidence: review.confidence, confidence, rehearsalOutcome, fixHash: fix.fixHash }))
  await sql(
    `INSERT INTO ADE_DB.OPS.REVIEWS (REVIEW_ID, FIX_ID, INCIDENT_ID, AGENT_RUN_ID, VERDICT, RAW_CONFIDENCE, CONFIDENCE, CAP_REASON, RUBRIC,
       CONCERNS, REQUIRED_CHANGES, SUMMARY, REHEARSAL_OUTCOME, SEAL)
     SELECT ?, ?, ?, ?, ?, ?, ?, ?, PARSE_JSON(?), PARSE_JSON(?), PARSE_JSON(?), ?, ?, ?`,
    [reviewId, fix.fixId, fix.incidentId, agentRunId, review.verdict, review.confidence, confidence, capReason, json(review.rubric),
     json(review.concerns), json(review.required_changes), review.summary, rehearsalOutcome, sealValue],
  )
  await sql(`UPDATE ADE_DB.OPS.FIXES SET STATUS = 'REVIEWED', REVIEWED_HASH = ?, UPDATED_AT = SYSDATE() WHERE FIX_ID = ?`, [fix.fixHash, fix.fixId])
  await audit(fix.incidentId, fix.fixId, "REVIEWED", { verdict: review.verdict, raw_confidence: review.confidence, confidence, cap: capReason })
}

function feedbackFor(review: Review, rehearsal: RehearsalResult, confidence: number, capReason: string | null, minConfidence: number): string {
  const lines = [
    `Reviewer verdict: ${review.verdict} (confidence ${confidence.toFixed(0)}${capReason ? `, capped: ${capReason}` : ""}; approval needs ${minConfidence}).`,
    `Review summary: ${review.summary}`,
  ]
  if (review.required_changes.length) lines.push("Required changes:", ...review.required_changes.map((c) => `- ${c}`))
  if (review.concerns.length) lines.push("Concerns:", ...review.concerns.map((c) => `- ${c}`))
  lines.push(`Sandbox rehearsal: ${rehearsal.outcome}. ${rehearsal.reason}`)
  if (rehearsal.verifyError) lines.push(`Error after applying your fix in the sandbox: ${rehearsal.verifyError}`)
  return lines.join("\n")
}

// ---------------------------------------------------------------------------
// Verification: an applied fix is VERIFIED when the job's next run succeeds,
// VERIFY_FAILED when it fails again.
// ---------------------------------------------------------------------------
async function checkVerifications(): Promise<void> {
  const rows = await sql<{ INCIDENT_ID: string; FIX_ID: string; JOB_ID: string; APPLIED_AT: unknown; LAST_STATUS: string; LAST_RUN_AT: unknown; LAST_SUCCESS_AT: unknown; LAST_FAILURE_AT: unknown; INCIDENT_NUMBER: number }>(
    `SELECT i.INCIDENT_ID, f.FIX_ID, i.JOB_ID, f.APPLIED_AT, j.LAST_STATUS, j.LAST_RUN_AT, j.LAST_SUCCESS_AT, j.LAST_FAILURE_AT, i.INCIDENT_NUMBER
     FROM ADE_DB.OPS.INCIDENTS i
     JOIN ADE_DB.OPS.FIXES f ON f.FIX_ID = i.CURRENT_FIX_ID
     JOIN ADE_DB.OPS.JOBS j ON j.JOB_ID = i.JOB_ID
     WHERE i.STATUS = 'VERIFYING' AND f.STATUS = 'APPLIED'`,
  )
  for (const r of rows) {
    const t = (v: unknown) => (iso(v) ? new Date(iso(v)!).getTime() : 0)
    const applied = t(r.APPLIED_AT)
    const ok = t(r.LAST_SUCCESS_AT)
    const bad = t(r.LAST_FAILURE_AT)
    if (ok > applied && ok >= bad) {
      await sql(`UPDATE ADE_DB.OPS.FIXES SET STATUS = 'VERIFIED', UPDATED_AT = SYSDATE() WHERE FIX_ID = ?`, [r.FIX_ID])
      await setStatus(r.INCIDENT_ID, "RESOLVED", "Verified: the job succeeded after the fix")
      await audit(r.INCIDENT_ID, r.FIX_ID, "VERIFIED", { last_success_at: r.LAST_SUCCESS_AT })
    } else if (bad > applied) {
      await sql(`UPDATE ADE_DB.OPS.FIXES SET STATUS = 'VERIFY_FAILED', UPDATED_AT = SYSDATE() WHERE FIX_ID = ?`, [r.FIX_ID])
      await setStatus(r.INCIDENT_ID, "NEEDS_HUMAN", "The job failed again after the fix; consider rolling back")
      await audit(r.INCIDENT_ID, r.FIX_ID, "VERIFY_FAILED", { last_failure_at: r.LAST_FAILURE_AT })
    }
  }
}
