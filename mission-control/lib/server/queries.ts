/**
 * Read models for the Mission Control UI. All queries are owner's rights over
 * ADE_DB (the app's own state), bound with `?` placeholders.
 */
import { iso, num, parseVariant, sql, sqlOne } from "@/lib/server/db"
import { verify, fixSealParts, reviewSealParts, type SealState } from "@/lib/server/seal"

export interface IncidentListItem {
  id: string
  number: number
  title: string
  summary: string | null
  status: string
  statusDetail: string | null
  severity: string
  category: string | null
  jobType: string
  jobFqn: string
  database: string
  errorCode: string | null
  occurrences: number
  symptoms: number
  confidence: number | null
  isBackfill: boolean
  firstSeenAt: string | null
  lastSeenAt: string | null
  updatedAt: string | null
  resolvedAt: string | null
  totalTokens: number
  totalAgentMs: number
  fixIterations: number
  leaseOwner: string | null
}

function toIncident(r: Record<string, unknown>): IncidentListItem {
  return {
    id: String(r.INCIDENT_ID),
    number: num(r.INCIDENT_NUMBER),
    title: String(r.TITLE ?? ""),
    summary: (r.SUMMARY as string) ?? null,
    status: String(r.STATUS),
    statusDetail: (r.STATUS_DETAIL as string) ?? null,
    severity: String(r.SEVERITY ?? "MEDIUM"),
    category: (r.CATEGORY as string) ?? null,
    jobType: String(r.JOB_TYPE),
    jobFqn: String(r.JOB_FQN),
    database: String(r.DATABASE_NAME),
    errorCode: (r.ERROR_CODE as string) ?? null,
    occurrences: num(r.OCCURRENCES),
    symptoms: num(r.SYMPTOM_COUNT),
    confidence: r.CONFIDENCE === null || r.CONFIDENCE === undefined ? null : num(r.CONFIDENCE),
    isBackfill: Boolean(r.IS_BACKFILL),
    firstSeenAt: iso(r.FIRST_SEEN_AT),
    lastSeenAt: iso(r.LAST_SEEN_AT),
    updatedAt: iso(r.UPDATED_AT),
    resolvedAt: iso(r.RESOLVED_AT),
    totalTokens: num(r.TOTAL_TOKENS),
    totalAgentMs: num(r.TOTAL_AGENT_MS),
    fixIterations: num(r.FIX_ITERATIONS),
    leaseOwner: (r.LEASE_OWNER as string) ?? null,
  }
}

const INCIDENT_COLS = `INCIDENT_ID, INCIDENT_NUMBER, TITLE, SUMMARY, STATUS, STATUS_DETAIL, SEVERITY, CATEGORY, JOB_TYPE, JOB_FQN, DATABASE_NAME,
  ERROR_CODE, OCCURRENCES, SYMPTOM_COUNT, CONFIDENCE, IS_BACKFILL, FIRST_SEEN_AT, LAST_SEEN_AT, UPDATED_AT, RESOLVED_AT, TOTAL_TOKENS,
  TOTAL_AGENT_MS, FIX_ITERATIONS, LEASE_OWNER, ERROR_MESSAGE, ROOT_INCIDENT_ID, JOB_ID, LAST_QUERY_ID, CURRENT_FIX_ID, GRAPH_RUN_GROUP_ID`

export async function listIncidents(filter: { view?: string; q?: string; limit?: number }): Promise<IncidentListItem[]> {
  const where: string[] = ["ROOT_INCIDENT_ID IS NULL"]
  const binds: (string | number)[] = []
  switch (filter.view) {
    case "active":
      where.push(`STATUS IN ('QUEUED', 'INVESTIGATING', 'FIXING', 'REHEARSING', 'REVIEWING', 'APPLYING', 'VERIFYING')`)
      break
    case "attention":
      where.push(`STATUS IN ('AWAITING_APPROVAL', 'APPROVED', 'NEEDS_HUMAN')`)
      break
    case "open":
      where.push(`STATUS NOT IN ('RESOLVED', 'NO_FIX', 'SUPPRESSED', 'SYMPTOM')`)
      break
    case "resolved":
      where.push(`STATUS IN ('RESOLVED', 'NO_FIX', 'SUPPRESSED')`)
      break
    case "backlog":
      where.push(`STATUS = 'DETECTED' AND IS_BACKFILL`)
      break
  }
  if (filter.q) {
    where.push(`(JOB_FQN ILIKE ? OR TITLE ILIKE ? OR TO_VARCHAR(INCIDENT_NUMBER) = ?)`)
    const like = `%${filter.q}%`
    binds.push(like, like, filter.q.replace(/^ADE-/i, ""))
  }
  const rows = await sql(
    `SELECT ${INCIDENT_COLS} FROM ADE_DB.OPS.INCIDENTS WHERE ${where.join(" AND ")}
     ORDER BY IFF(STATUS IN ('RESOLVED','NO_FIX','SUPPRESSED'), 1, 0),
              CASE SEVERITY WHEN 'CRITICAL' THEN 0 WHEN 'HIGH' THEN 1 WHEN 'MEDIUM' THEN 2 ELSE 3 END,
              UPDATED_AT DESC
     LIMIT ?`,
    [...binds, Math.min(500, filter.limit ?? 200)],
  )
  return rows.map(toIncident)
}

export async function getIncident(id: string) {
  const r = await sqlOne(`SELECT ${INCIDENT_COLS} FROM ADE_DB.OPS.INCIDENTS WHERE INCIDENT_ID = ? OR TO_VARCHAR(INCIDENT_NUMBER) = ?`, [id, id.replace(/^ADE-/i, "")])
  if (!r) return null
  const incidentId = String(r.INCIDENT_ID)
  const [diagnosis, fixes, reviews, rehearsals, runs, symptoms, audit, decisions, job, agentRuns] = await Promise.all([
    sqlOne(`SELECT * FROM ADE_DB.OPS.DIAGNOSES WHERE INCIDENT_ID = ? ORDER BY CREATED_AT DESC LIMIT 1`, [incidentId]),
    sql(`SELECT * FROM ADE_DB.OPS.FIXES WHERE INCIDENT_ID = ? ORDER BY VERSION DESC`, [incidentId]),
    sql(`SELECT * FROM ADE_DB.OPS.REVIEWS WHERE INCIDENT_ID = ? ORDER BY CREATED_AT DESC`, [incidentId]),
    sql(`SELECT * FROM ADE_DB.OPS.REHEARSALS WHERE INCIDENT_ID = ? ORDER BY STARTED_AT DESC`, [incidentId]),
    sql(
      `SELECT STATE, SCHEDULED_AT, COMPLETED_AT, DURATION_MS, ERROR_CODE, LEFT(ERROR_MESSAGE, 1000) AS ERROR_MESSAGE, QUERY_ID
       FROM ADE_DB.OPS.JOB_RUNS WHERE JOB_ID = ? ORDER BY SCHEDULED_AT DESC LIMIT 30`,
      [String(r.JOB_ID)],
    ),
    sql(`SELECT INCIDENT_ID, INCIDENT_NUMBER, JOB_FQN, STATUS, LEFT(TITLE, 200) AS TITLE FROM ADE_DB.OPS.INCIDENTS WHERE ROOT_INCIDENT_ID = ?`, [incidentId]),
    sql(`SELECT ACTOR, ACTION, DETAIL, CREATED_AT FROM ADE_DB.OPS.AUDIT_LOG WHERE INCIDENT_ID = ? ORDER BY CREATED_AT DESC LIMIT 100`, [incidentId]),
    sql(`SELECT FIX_ID, DECISION, FIX_HASH, DECIDED_BY, COMMENT, DECIDED_AT FROM ADE_DB.GUARD.DECISIONS WHERE INCIDENT_ID = ? ORDER BY DECIDED_AT DESC`, [incidentId]),
    sqlOne(`SELECT FQN, JOB_TYPE, OWNER_ROLE, WAREHOUSE, SCHEDULE, STATE, PREDECESSORS, DEFINITION, LAST_SUCCESS_AT, LAST_FAILURE_AT, RUNS_24H, FAILURES_24H FROM ADE_DB.OPS.JOBS WHERE JOB_ID = ?`, [String(r.JOB_ID)]),
    sql(`SELECT * FROM ADE_DB.OPS.AGENT_RUNS WHERE INCIDENT_ID = ? ORDER BY STARTED_AT`, [incidentId]),
  ])
  const latestApproval = new Map<string, { decision: string; hash: string }>()
  for (const d of decisions) {
    const fixId = String(d.FIX_ID)
    if (!latestApproval.has(fixId) && ["APPROVED", "REJECTED", "APPLIED", "APPLY_FAILED", "ROLLED_BACK"].includes(String(d.DECISION))) {
      latestApproval.set(fixId, { decision: String(d.DECISION), hash: String(d.FIX_HASH ?? "") })
    }
  }
  return {
    incident: { ...toIncident(r), errorMessage: (r.ERROR_MESSAGE as string) ?? null, lastQueryId: (r.LAST_QUERY_ID as string) ?? null, currentFixId: (r.CURRENT_FIX_ID as string) ?? null },
    job: job
      ? {
          fqn: job.FQN, type: job.JOB_TYPE, owner: job.OWNER_ROLE, warehouse: job.WAREHOUSE, schedule: job.SCHEDULE, state: job.STATE,
          predecessors: parseVariant<string[]>(job.PREDECESSORS) ?? [], definition: job.DEFINITION, lastSuccessAt: iso(job.LAST_SUCCESS_AT),
          lastFailureAt: iso(job.LAST_FAILURE_AT), runs24h: num(job.RUNS_24H), failures24h: num(job.FAILURES_24H),
        }
      : null,
    diagnosis: diagnosis ? { ...(parseVariant<Record<string, unknown>>(diagnosis.PAYLOAD) ?? {}), createdAt: iso(diagnosis.CREATED_AT), agentRunId: diagnosis.AGENT_RUN_ID } : null,
    fixes: fixes.map((f) => {
      const fixId = String(f.FIX_ID)
      const sealState: SealState = verify(fixSealParts({ fixId, incidentId, version: num(f.VERSION), fixHash: String(f.FIX_HASH) }), f.SEAL as string)
      return {
        id: fixId, version: num(f.VERSION), status: String(f.STATUS), title: f.TITLE, summary: f.SUMMARY, strategy: f.STRATEGY,
        statements: parseVariant<string[]>(f.STATEMENTS) ?? [], rollback: parseVariant<string[]>(f.ROLLBACK_STATEMENTS) ?? [],
        targets: parseVariant<string[]>(f.TARGET_OBJECTS) ?? [], risk: f.RISK_LEVEL, assumptions: parseVariant<string[]>(f.ASSUMPTIONS) ?? [],
        verificationPlan: f.VERIFICATION_PLAN, fixHash: f.FIX_HASH, approvedBy: f.APPROVED_BY, approvedAt: iso(f.APPROVED_AT),
        appliedBy: f.APPLIED_BY, appliedAt: iso(f.APPLIED_AT), applyError: f.APPLY_ERROR, appliedStatements: parseVariant(f.APPLIED_STATEMENTS),
        snapshot: parseVariant(f.SNAPSHOT_DDL), rolledBackAt: iso(f.ROLLED_BACK_AT), createdAt: iso(f.CREATED_AT), seal: sealState,
        guardDecision: latestApproval.get(fixId) ?? null,
      }
    }),
    reviews: reviews.map((v) => {
      const sealState: SealState = verify(
        reviewSealParts({
          reviewId: String(v.REVIEW_ID), fixId: String(v.FIX_ID), verdict: String(v.VERDICT), rawConfidence: num(v.RAW_CONFIDENCE),
          confidence: num(v.CONFIDENCE), rehearsalOutcome: (v.REHEARSAL_OUTCOME as string) ?? null,
          fixHash: String(fixes.find((f) => f.FIX_ID === v.FIX_ID)?.FIX_HASH ?? ""),
        }),
        v.SEAL as string,
      )
      return {
        id: v.REVIEW_ID, fixId: v.FIX_ID, verdict: v.VERDICT, rawConfidence: num(v.RAW_CONFIDENCE), confidence: num(v.CONFIDENCE),
        capReason: v.CAP_REASON, rubric: parseVariant(v.RUBRIC), concerns: parseVariant<string[]>(v.CONCERNS) ?? [],
        requiredChanges: parseVariant<string[]>(v.REQUIRED_CHANGES) ?? [], summary: v.SUMMARY, rehearsalOutcome: v.REHEARSAL_OUTCOME,
        createdAt: iso(v.CREATED_AT), seal: sealState,
      }
    }),
    rehearsals: rehearsals.map((h) => ({
      id: h.REHEARSAL_ID, fixId: h.FIX_ID, outcome: h.OUTCOME, reason: h.REASON, sandbox: h.SANDBOX_SCHEMA,
      log: parseVariant(h.STEPS_LOG), startedAt: iso(h.STARTED_AT), durationMs: num(h.DURATION_MS),
    })),
    runs: runs.map((x) => ({ state: x.STATE, scheduledAt: iso(x.SCHEDULED_AT), completedAt: iso(x.COMPLETED_AT), durationMs: num(x.DURATION_MS), errorCode: x.ERROR_CODE, errorMessage: x.ERROR_MESSAGE, queryId: x.QUERY_ID })),
    symptoms: symptoms.map((s) => ({ id: s.INCIDENT_ID, number: num(s.INCIDENT_NUMBER), jobFqn: s.JOB_FQN, status: s.STATUS, title: s.TITLE })),
    audit: audit.map((a) => ({ actor: a.ACTOR, action: a.ACTION, detail: parseVariant(a.DETAIL), at: iso(a.CREATED_AT) })),
    decisions: decisions.map((d) => ({ fixId: d.FIX_ID, decision: d.DECISION, by: d.DECIDED_BY, comment: d.COMMENT, at: iso(d.DECIDED_AT), hash: d.FIX_HASH })),
    agentRuns: agentRuns.map((a) => ({
      id: a.AGENT_RUN_ID, role: a.AGENT_ROLE, iteration: num(a.ITERATION), status: a.STATUS, model: a.MODEL, effort: a.THINKING_EFFORT,
      startedAt: iso(a.STARTED_AT), endedAt: iso(a.ENDED_AT), durationMs: num(a.DURATION_MS), toolCalls: num(a.TOOL_CALLS),
      inputTokens: num(a.INPUT_TOKENS), outputTokens: num(a.OUTPUT_TOKENS), cacheRead: num(a.CACHE_READ_TOKENS), cacheWrite: num(a.CACHE_WRITE_TOKENS),
      uncached: num(a.UNCACHED_INPUT_TOKENS), credits: a.CREDITS === null ? null : num(a.CREDITS), threadId: a.THREAD_ID, requestId: a.REQUEST_ID,
      error: a.ERROR_MESSAGE, specHash: a.AGENT_SPEC_HASH,
    })),
  }
}

export interface StepRow {
  id: string
  seq: number
  parentId: string | null
  agentRunId: string | null
  kind: string
  actor: string
  phase: string | null
  task: string
  status: string
  model: string | null
  effort: string | null
  startedAt: string | null
  endedAt: string | null
  durationMs: number
  inputTokens: number
  uncachedInputTokens: number
  cacheReadTokens: number
  cacheWriteTokens: number
  outputTokens: number
  credits: number | null
  toolName: string | null
  toolType: string | null
  summary: string | null
  error: string | null
  detail: unknown
  requestId: string | null
  threadId: string | null
  cortexRunId: string | null
}

export async function listSteps(incidentId: string): Promise<StepRow[]> {
  const rows = await sql(`SELECT * FROM ADE_DB.OPS.AGENT_STEPS WHERE INCIDENT_ID = ? ORDER BY SEQ`, [incidentId])
  return rows.map((s) => ({
    id: String(s.STEP_ID), seq: num(s.SEQ), parentId: (s.PARENT_STEP_ID as string) ?? null, agentRunId: (s.AGENT_RUN_ID as string) ?? null,
    kind: String(s.KIND), actor: String(s.ACTOR), phase: (s.PHASE as string) ?? null, task: String(s.TASK), status: String(s.STATUS),
    model: (s.MODEL as string) ?? null, effort: (s.THINKING_EFFORT as string) ?? null, startedAt: iso(s.STARTED_AT), endedAt: iso(s.ENDED_AT),
    durationMs: num(s.DURATION_MS), inputTokens: num(s.INPUT_TOKENS), uncachedInputTokens: num(s.UNCACHED_INPUT_TOKENS),
    cacheReadTokens: num(s.CACHE_READ_TOKENS), cacheWriteTokens: num(s.CACHE_WRITE_TOKENS), outputTokens: num(s.OUTPUT_TOKENS),
    credits: s.CREDITS === null || s.CREDITS === undefined ? null : num(s.CREDITS), toolName: (s.TOOL_NAME as string) ?? null,
    toolType: (s.TOOL_TYPE as string) ?? null, summary: (s.SUMMARY as string) ?? null, error: (s.ERROR_MESSAGE as string) ?? null,
    detail: parseVariant(s.DETAIL), requestId: (s.REQUEST_ID as string) ?? null, threadId: (s.THREAD_ID as string) ?? null,
    cortexRunId: (s.CORTEX_RUN_ID as string) ?? null,
  }))
}

export async function stepPayloads(stepId: string) {
  const rows = await sql(`SELECT PAYLOAD_KIND, PAYLOAD, BYTES, CREATED_AT FROM ADE_DB.TELEMETRY.STEP_PAYLOADS WHERE STEP_ID = ? ORDER BY CREATED_AT`, [stepId])
  return rows.map((p) => ({ kind: String(p.PAYLOAD_KIND), payload: parseVariant(p.PAYLOAD), bytes: num(p.BYTES), at: iso(p.CREATED_AT) }))
}

export async function overview() {
  const [counts, recent, agents, scopes, detector, spark] = await Promise.all([
    sqlOne(
      `SELECT
         COUNT_IF(STATUS NOT IN ('RESOLVED','NO_FIX','SUPPRESSED','SYMPTOM') AND NOT (STATUS = 'DETECTED' AND IS_BACKFILL)) AS OPEN,
         COUNT_IF(STATUS IN ('QUEUED','INVESTIGATING','FIXING','REHEARSING','REVIEWING','APPLYING','VERIFYING')) AS ACTIVE,
         COUNT_IF(STATUS IN ('AWAITING_APPROVAL','APPROVED')) AS AWAITING,
         COUNT_IF(STATUS = 'NEEDS_HUMAN') AS NEEDS_HUMAN,
         COUNT_IF(STATUS = 'DETECTED' AND IS_BACKFILL) AS BACKLOG,
         COUNT_IF(STATUS = 'RESOLVED' AND RESOLVED_AT > DATEADD(day, -7, SYSDATE())) AS RESOLVED_7D,
         COUNT_IF(CREATED_AT > DATEADD(day, -1, SYSDATE()) AND NOT IS_BACKFILL) AS NEW_24H,
         MEDIAN(IFF(STATUS = 'RESOLVED', DATEDIFF(second, FIRST_SEEN_AT, RESOLVED_AT), NULL)) AS MTTR_S
       FROM ADE_DB.OPS.INCIDENTS WHERE ROOT_INCIDENT_ID IS NULL`,
    ),
    sql(
      `SELECT s.STEP_ID, s.INCIDENT_ID, i.INCIDENT_NUMBER, s.ACTOR, s.KIND, s.TASK, s.STATUS, s.STARTED_AT, s.DURATION_MS, s.MODEL,
              s.INPUT_TOKENS + s.OUTPUT_TOKENS AS TOKENS
       FROM ADE_DB.OPS.AGENT_STEPS s JOIN ADE_DB.OPS.INCIDENTS i ON i.INCIDENT_ID = s.INCIDENT_ID
       WHERE s.STARTED_AT > DATEADD(day, -7, SYSDATE()) AND s.KIND <> 'TOOL_CALL'
       ORDER BY s.STARTED_AT DESC LIMIT 25`,
    ),
    sql(
      `SELECT AGENT_ROLE, COUNT(*) AS RUNS, COUNT_IF(STATUS = 'RUNNING') AS RUNNING, COUNT_IF(STATUS = 'SUCCEEDED') AS OK,
              SUM(INPUT_TOKENS + OUTPUT_TOKENS) AS TOKENS, MEDIAN(DURATION_MS) AS P50_MS, SUM(TOOL_CALLS) AS TOOL_CALLS,
              MAX_BY(MODEL, STARTED_AT) AS MODEL, MAX(STARTED_AT) AS LAST_AT, SUM(CREDITS) AS CREDITS
       FROM ADE_DB.OPS.AGENT_RUNS WHERE STARTED_AT > DATEADD(day, -30, SYSDATE()) GROUP BY 1`,
    ),
    sql(`SELECT SCOPE_ID, DATABASE_NAME, ENABLED, LAST_SCAN_AT, LAST_SCAN_STATUS, LAST_SCAN_MS, LAST_SCAN_ERROR, APPLY_MODE FROM ADE_DB.OPS.SCOPES ORDER BY DATABASE_NAME`),
    sqlOne(
      `SELECT STATE, SCHEDULED_TIME, COMPLETED_TIME FROM TABLE(ADE_DB.INFORMATION_SCHEMA.TASK_HISTORY(TASK_NAME => 'DETECTOR_TASK',
         SCHEDULED_TIME_RANGE_START => DATEADD(minute, -10, CURRENT_TIMESTAMP()))) WHERE STATE <> 'SCHEDULED' ORDER BY SCHEDULED_TIME DESC LIMIT 1`,
    ).catch(() => null),
    sql(
      `SELECT DATE_TRUNC('hour', STARTED_AT) AS H, COUNT_IF(KIND = 'TURN') AS TURNS, SUM(INPUT_TOKENS + OUTPUT_TOKENS) AS TOKENS
       FROM ADE_DB.OPS.AGENT_STEPS WHERE STARTED_AT > DATEADD(hour, -24, SYSDATE()) GROUP BY 1 ORDER BY 1`,
    ),
  ])
  return {
    counts: {
      open: num(counts?.OPEN), active: num(counts?.ACTIVE), awaiting: num(counts?.AWAITING), needsHuman: num(counts?.NEEDS_HUMAN),
      backlog: num(counts?.BACKLOG), resolved7d: num(counts?.RESOLVED_7D), new24h: num(counts?.NEW_24H),
      mttrSeconds: counts?.MTTR_S === null || counts?.MTTR_S === undefined ? null : num(counts?.MTTR_S),
    },
    recent: recent.map((s) => ({
      stepId: s.STEP_ID, incidentId: s.INCIDENT_ID, incidentNumber: num(s.INCIDENT_NUMBER), actor: s.ACTOR, kind: s.KIND, task: s.TASK,
      status: s.STATUS, startedAt: iso(s.STARTED_AT), durationMs: num(s.DURATION_MS), model: s.MODEL, tokens: num(s.TOKENS),
    })),
    agents: agents.map((a) => ({
      role: String(a.AGENT_ROLE), runs: num(a.RUNS), running: num(a.RUNNING), ok: num(a.OK), tokens: num(a.TOKENS), p50Ms: num(a.P50_MS),
      toolCalls: num(a.TOOL_CALLS), model: a.MODEL as string, lastAt: iso(a.LAST_AT), credits: a.CREDITS === null ? null : num(a.CREDITS),
    })),
    scopes: scopes.map((s) => ({
      id: s.SCOPE_ID, database: s.DATABASE_NAME, enabled: Boolean(s.ENABLED), lastScanAt: iso(s.LAST_SCAN_AT), lastScanStatus: s.LAST_SCAN_STATUS,
      lastScanMs: num(s.LAST_SCAN_MS), lastScanError: s.LAST_SCAN_ERROR, applyMode: s.APPLY_MODE,
    })),
    detector: detector ? { state: detector.STATE, scheduledAt: iso(detector.SCHEDULED_TIME), completedAt: iso(detector.COMPLETED_TIME) } : null,
    activity: spark.map((h) => ({ hour: iso(h.H), turns: num(h.TURNS), tokens: num(h.TOKENS) })),
  }
}

export async function fleet() {
  const [jobs, runs] = await Promise.all([
    sql(
      `SELECT j.JOB_ID, j.JOB_TYPE, j.DATABASE_NAME, j.SCHEMA_NAME, j.JOB_NAME, j.FQN, j.OWNER_ROLE, j.WAREHOUSE, j.SCHEDULE, j.STATE,
              j.LAST_RUN_AT, j.LAST_STATUS, j.LAST_SUCCESS_AT, j.LAST_FAILURE_AT, j.RUNS_24H, j.FAILURES_24H, j.IS_ACTIVE, j.PREDECESSORS,
              (SELECT COUNT(*) FROM ADE_DB.OPS.INCIDENTS i WHERE i.JOB_ID = j.JOB_ID AND i.STATUS NOT IN ('RESOLVED','NO_FIX','SUPPRESSED')) AS OPEN_INCIDENTS
       FROM ADE_DB.OPS.JOBS j
       WHERE j.IS_ACTIVE
       ORDER BY j.DATABASE_NAME, j.SCHEMA_NAME, j.JOB_NAME`,
    ),
    sql(
      `SELECT JOB_ID, DATE_TRUNC('hour', SCHEDULED_AT) AS H,
              COUNT_IF(STATE = 'SUCCEEDED') AS OK, COUNT_IF(STATE NOT IN ('SUCCEEDED', 'SKIPPED')) AS BAD
       FROM ADE_DB.OPS.JOB_RUNS WHERE SCHEDULED_AT > DATEADD(day, -3, SYSDATE()) GROUP BY 1, 2`,
    ),
  ])
  const byJob = new Map<string, { hour: string | null; ok: number; bad: number }[]>()
  for (const r of runs) {
    const k = String(r.JOB_ID)
    if (!byJob.has(k)) byJob.set(k, [])
    byJob.get(k)!.push({ hour: iso(r.H), ok: num(r.OK), bad: num(r.BAD) })
  }
  return jobs.map((j) => ({
    id: String(j.JOB_ID), type: String(j.JOB_TYPE), database: String(j.DATABASE_NAME), schema: String(j.SCHEMA_NAME), name: String(j.JOB_NAME),
    fqn: String(j.FQN), owner: j.OWNER_ROLE, warehouse: j.WAREHOUSE, schedule: j.SCHEDULE, state: j.STATE, lastRunAt: iso(j.LAST_RUN_AT),
    lastStatus: j.LAST_STATUS, lastSuccessAt: iso(j.LAST_SUCCESS_AT), lastFailureAt: iso(j.LAST_FAILURE_AT), runs24h: num(j.RUNS_24H),
    failures24h: num(j.FAILURES_24H), openIncidents: num(j.OPEN_INCIDENTS), predecessors: parseVariant<string[]>(j.PREDECESSORS) ?? [],
    history: byJob.get(String(j.JOB_ID)) ?? [],
  }))
}

export async function analytics(days: number) {
  const d = Math.max(1, Math.min(90, days))
  const [daily, perf, funnel, calibration, cost, categories] = await Promise.all([
    sql(`SELECT * FROM ADE_DB.TELEMETRY.V_DAILY_USAGE WHERE USAGE_DATE > DATEADD(day, -?, CURRENT_DATE()) ORDER BY USAGE_DATE`, [d]),
    sql(`SELECT * FROM ADE_DB.TELEMETRY.V_AGENT_PERFORMANCE ORDER BY AGENT_ROLE`),
    sqlOne(`SELECT * FROM ADE_DB.TELEMETRY.V_INCIDENT_FUNNEL`),
    sql(`SELECT * FROM ADE_DB.TELEMETRY.V_CONFIDENCE_CALIBRATION ORDER BY CONFIDENCE_BUCKET`),
    sql(`SELECT * FROM ADE_DB.TELEMETRY.V_INCIDENT_COST WHERE FIRST_SEEN_AT > DATEADD(day, -?, SYSDATE()) AND AGENT_RUNS > 0 ORDER BY FIRST_SEEN_AT DESC LIMIT 100`, [d]),
    sql(`SELECT COALESCE(CATEGORY, 'UNKNOWN') AS CATEGORY, COUNT(*) AS N FROM ADE_DB.OPS.INCIDENTS WHERE ROOT_INCIDENT_ID IS NULL AND FIRST_SEEN_AT > DATEADD(day, -?, SYSDATE()) GROUP BY 1 ORDER BY 2 DESC`, [d]),
  ])
  const lower = (r: Record<string, unknown>) => Object.fromEntries(Object.entries(r).map(([k, v]) => [k.toLowerCase(), v instanceof Date ? v.toISOString() : v]))
  return {
    daily: daily.map(lower),
    performance: perf.map(lower),
    funnel: funnel ? lower(funnel) : null,
    calibration: calibration.map(lower),
    cost: cost.map(lower),
    categories: categories.map(lower),
  }
}
