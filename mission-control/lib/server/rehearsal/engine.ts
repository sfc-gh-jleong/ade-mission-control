/**
 * Sandbox rehearsal: prove a fix before anyone approves it.
 *
 *   1. BUILD      create ADE_SBX_<incident>_<attempt> (owned by ADE_APP_ROLE),
 *                 zero-copy clone every table the job reads or writes, and
 *                 recreate the job there with its database rewritten.
 *   2. REPRODUCE  run the job in the sandbox. It must fail like production did;
 *                 if it succeeds the rehearsal can prove nothing (INCONCLUSIVE).
 *   3. APPLY      bind {{DB}} to the sandbox and run the fix statements (the
 *                 job is recreated from its new definition when the fix
 *                 changes it).
 *   4. VERIFY     run the job again. PASSED if it succeeds, FAILED if not.
 *   5. CLEANUP    drop the sandbox database.
 *
 * Everything runs as ADE_APP_ROLE, which cannot write to production at all, so
 * a missed rewrite fails on privileges instead of touching production data.
 * Jobs that call procedures/functions or use objects other than tables are
 * UNSUPPORTED (no USAGE on production routines by design).
 */
import { iso, json, sql, sqlLong } from "@/lib/server/db"
import { bindDatabase } from "@/lib/server/agents/sql-guard"
import { fqn, parseAwaitFailure, q, qualifiedRefs, rewriteDatabase, sandboxDatabaseName, type ObjectRef } from "@/lib/server/rehearsal/sql-text"
import type { RehearsalOutcome } from "@/lib/domain"

export interface RehearsalJob {
  incidentNumber: number
  incidentId: string
  jobType: string
  database: string
  schema: string
  name: string
  errorCode: string | null
  errorMessage: string | null
}

export interface RehearsalLogEntry {
  step: "BUILD" | "REPRODUCE" | "APPLY" | "VERIFY" | "CLEANUP"
  sql?: string
  ok: boolean
  ms: number
  result?: string
  error?: string
  at: string
}

export interface RehearsalResult {
  outcome: Exclude<RehearsalOutcome, "RUNNING">
  reason: string
  sandbox: string
  reproduced: boolean | null
  reproducedError?: string | null
  verifyError?: string | null
  log: RehearsalLogEntry[]
  durationMs: number
}

type Progress = (entry: RehearsalLogEntry) => void

interface JobDefinition {
  kind: "TASK" | "DYNAMIC_TABLE"
  body: string
  warehouse: string | null
  targetLag?: string
  condition?: string | null
  refreshMode?: string
}

const MAX_TABLES = 40

/** LIKE pattern literal for SHOW ... LIKE '<pattern>' (exact name). */
function likeLiteral(name: string): string {
  return `'${name.replace(/\\/g, "\\\\").replace(/([_%])/g, "\\$1").replace(/'/g, "''")}'`
}

async function readDefinition(job: RehearsalJob): Promise<JobDefinition | null> {
  const where = `${q(job.database)}.${q(job.schema)}`
  if (job.jobType === "TASK") {
    const rows = await sql<Record<string, string>>(
      `SHOW TASKS LIKE ${likeLiteral(job.name)} IN SCHEMA ${where} ->> SELECT "name", "definition", "warehouse", "condition" FROM $1`,
    )
    const r = rows.find((x) => x.name === job.name)
    return r ? { kind: "TASK", body: r.definition, warehouse: r.warehouse ?? null, condition: r.condition || null } : null
  }
  if (job.jobType === "DYNAMIC_TABLE") {
    const rows = await sql<Record<string, string>>(
      `SHOW DYNAMIC TABLES LIKE ${likeLiteral(job.name)} IN SCHEMA ${where} ->> SELECT "name", "text", "warehouse", "target_lag", "refresh_mode" FROM $1`,
    )
    const r = rows.find((x) => x.name === job.name)
    if (!r) return null
    // `text` is the full CREATE statement; the query starts at the first AS SELECT / AS WITH / AS (.
    const m = /\bAS\s+((?:SELECT|WITH|\()[\s\S]*)$/i.exec(r.text)
    if (!m) return null
    return { kind: "DYNAMIC_TABLE", body: m[1].trim(), warehouse: r.warehouse ?? null, targetLag: r.target_lag, refreshMode: r.refresh_mode }
  }
  return null
}

/**
 * Adapt a bound fix statement to the sandbox: run on ADE_WH (the only warehouse
 * ADE_APP_ROLE may use) and skip task scheduling changes, which only matter in
 * production (the sandbox copy is standalone and unscheduled).
 */
export function sandboxStatement(statement: string): { sql: string | null; note?: string } {
  if (/^\s*ALTER\s+TASK\b[\s\S]*\b(SUSPEND|RESUME)\s*$/i.test(statement)) {
    return { sql: null, note: "Skipped in sandbox: task scheduling only (applied in production)" }
  }
  return { sql: statement.replace(/\bWAREHOUSE\s*=\s*("[^"]+"|[A-Za-z_][A-Za-z0-9_$]*)/gi, "WAREHOUSE = ADE_WH") }
}

/** Classify each referenced object in the job's database: table we can clone, or something we cannot rehearse. */
async function classifyRefs(database: string, refs: ObjectRef[]): Promise<{ tables: ObjectRef[]; dynamicTables: ObjectRef[]; views: ObjectRef[]; missing: ObjectRef[] }> {
  const tables: ObjectRef[] = []
  const dynamicTables: ObjectRef[] = []
  const views: ObjectRef[] = []
  const missing: ObjectRef[] = []
  if (!refs.length) return { tables, dynamicTables, views, missing }
  const rows = await sql<{ S: string; N: string; T: string; D: string }>(
    `SELECT TABLE_SCHEMA AS S, TABLE_NAME AS N, TABLE_TYPE AS T, IS_DYNAMIC AS D
     FROM IDENTIFIER(?)
     WHERE (TABLE_SCHEMA, TABLE_NAME) IN (SELECT VALUE:s::STRING, VALUE:n::STRING FROM TABLE(FLATTEN(PARSE_JSON(?))))`,
    [`${q(database)}.INFORMATION_SCHEMA.TABLES`, JSON.stringify(refs.map((r) => ({ s: r.schema, n: r.name })))],
  )
  const byKey = new Map(rows.map((r) => [`${r.S}.${r.N}`, r]))
  for (const ref of refs) {
    const hit = byKey.get(`${ref.schema}.${ref.name}`)
    if (!hit) missing.push(ref)
    else if (hit.T === "VIEW") views.push(ref)
    else if (hit.D === "YES") dynamicTables.push(ref)
    else tables.push(ref)
  }
  return { tables, dynamicTables, views, missing }
}

export async function rehearse(job: RehearsalJob, fixStatements: string[], attempt: number, onProgress: Progress = () => {}): Promise<RehearsalResult> {
  const t0 = Date.now()
  const sandbox = sandboxDatabaseName(job.incidentNumber, attempt)
  const log: RehearsalLogEntry[] = []
  let reproduced: boolean | null = null
  let reproducedError: string | null = null

  const step = async (name: RehearsalLogEntry["step"], text: string, long = false): Promise<{ ok: boolean; rows: Record<string, unknown>[]; error?: string }> => {
    const s0 = Date.now()
    try {
      const rows = long ? await sqlLong(text, [], 15 * 60_000) : await sql(text)
      const entry: RehearsalLogEntry = { step: name, sql: text, ok: true, ms: Date.now() - s0, result: summarizeRows(rows), at: new Date().toISOString() }
      log.push(entry)
      onProgress(entry)
      return { ok: true, rows }
    } catch (e) {
      const error = e instanceof Error ? e.message : String(e)
      const entry: RehearsalLogEntry = { step: name, sql: text, ok: false, ms: Date.now() - s0, error, at: new Date().toISOString() }
      log.push(entry)
      onProgress(entry)
      return { ok: false, rows: [], error }
    }
  }
  const finish = async (outcome: RehearsalResult["outcome"], reason: string, verifyError: string | null = null): Promise<RehearsalResult> => {
    await step("CLEANUP", `DROP DATABASE IF EXISTS ${q(sandbox)}`)
    return { outcome, reason, sandbox, reproduced, reproducedError, verifyError, log, durationMs: Date.now() - t0 }
  }

  if (job.jobType !== "TASK" && job.jobType !== "DYNAMIC_TABLE") {
    return { outcome: "UNSUPPORTED", reason: `${job.jobType} jobs cannot be rehearsed in a sandbox`, sandbox, reproduced, log, durationMs: Date.now() - t0 }
  }
  const def = await readDefinition(job)
  if (!def) {
    return { outcome: "UNSUPPORTED", reason: "Could not read the job definition", sandbox, reproduced, log, durationMs: Date.now() - t0 }
  }
  if (/\bCALL\b|\bEXECUTE\s+(IMMEDIATE|NOTEBOOK|TASK)\b|\bSYSTEM\$/i.test(def.body)) {
    return { outcome: "UNSUPPORTED", reason: "The job calls procedures, notebooks or system functions, which cannot run in the sandbox", sandbox, reproduced, log, durationMs: Date.now() - t0 }
  }
  if (def.condition) {
    return { outcome: "UNSUPPORTED", reason: "Conditional tasks (WHEN ...) depend on streams or system state that a sandbox cannot reproduce", sandbox, reproduced, log, durationMs: Date.now() - t0 }
  }

  // Objects referenced by the job and by the fix, restricted to the job's database.
  const fixText = fixStatements.map((s) => bindDatabase(s, job.database)).join("\n")
  const refs = [...qualifiedRefs(def.body), ...qualifiedRefs(fixText)]
    .filter((r) => r.database === job.database.toUpperCase())
    .filter((r) => !(r.schema === job.schema.toUpperCase() && r.name === job.name.toUpperCase() && job.jobType === "TASK"))
  const unique = [...new Map(refs.map((r) => [`${r.schema}.${r.name}`, r])).values()]
  const classified = await classifyRefs(job.database, unique)
  if (classified.views.length) {
    return { outcome: "UNSUPPORTED", reason: `The job reads views (${classified.views.map((v) => `${v.schema}.${v.name}`).join(", ")}); view rehearsal is not supported yet`, sandbox, reproduced, log, durationMs: Date.now() - t0 }
  }
  const tables = [...classified.tables, ...classified.dynamicTables.filter((d) => !(job.jobType === "DYNAMIC_TABLE" && d.schema === job.schema.toUpperCase() && d.name === job.name.toUpperCase()))]
  if (tables.length > MAX_TABLES) {
    return { outcome: "UNSUPPORTED", reason: `The job touches ${tables.length} tables (limit ${MAX_TABLES})`, sandbox, reproduced, log, durationMs: Date.now() - t0 }
  }

  // ---- BUILD
  const created = await step("BUILD", `CREATE OR REPLACE DATABASE ${q(sandbox)} DATA_RETENTION_TIME_IN_DAYS = 0 COMMENT = 'ADE rehearsal for incident ${job.incidentNumber} attempt ${attempt} (safe to drop)'`)
  if (!created.ok) return finish("INCONCLUSIVE", `Could not create the sandbox: ${created.error}`)
  const schemas = new Set<string>([job.schema.toUpperCase(), ...tables.map((t) => t.schema), ...classified.missing.map((m) => m.schema)])
  for (const s of schemas) {
    const r = await step("BUILD", `CREATE SCHEMA IF NOT EXISTS ${q(sandbox)}.${q(s)}`)
    if (!r.ok) return finish("INCONCLUSIVE", `Could not create sandbox schema ${s}: ${r.error}`)
  }
  for (const t of classified.tables) {
    const r = await step("BUILD", `CREATE TABLE ${q(sandbox)}.${q(t.schema)}.${q(t.name)} CLONE ${fqn(t)}`)
    if (!r.ok) return finish("INCONCLUSIVE", `Could not clone ${t.schema}.${t.name}: ${r.error}`)
  }
  // Dynamic tables read by the job are materialized as plain tables (snapshot).
  for (const d of classified.dynamicTables) {
    if (job.jobType === "DYNAMIC_TABLE" && d.schema === job.schema.toUpperCase() && d.name === job.name.toUpperCase()) continue
    const r = await step("BUILD", `CREATE TABLE ${q(sandbox)}.${q(d.schema)}.${q(d.name)} AS SELECT * FROM ${fqn(d)}`)
    if (!r.ok) return finish("INCONCLUSIVE", `Could not snapshot ${d.schema}.${d.name}: ${r.error}`)
  }

  const createJob = (definitionBody: string) =>
    def.kind === "TASK"
      ? `CREATE OR REPLACE TASK ${q(sandbox)}.${q(job.schema)}.${q(job.name)} WAREHOUSE = ADE_WH SCHEDULE = '11520 MINUTE' COMMENT = 'ADE rehearsal copy of ${job.database}.${job.schema}.${job.name} (suspended)' AS ${rewriteDatabase(definitionBody, job.database, sandbox)}`
      : `CREATE OR REPLACE DYNAMIC TABLE ${q(sandbox)}.${q(job.schema)}.${q(job.name)} TARGET_LAG = '1 day' WAREHOUSE = ADE_WH REFRESH_MODE = FULL INITIALIZE = ON_SCHEDULE AS ${rewriteDatabase(definitionBody, job.database, sandbox)}`
  const runJob = () =>
    def.kind === "TASK"
      ? `EXECUTE TASK ${q(sandbox)}.${q(job.schema)}.${q(job.name)} AWAIT`
      : `ALTER DYNAMIC TABLE ${q(sandbox)}.${q(job.schema)}.${q(job.name)} REFRESH`

  // ---- REPRODUCE
  const built = await step("BUILD", createJob(def.body))
  if (!built.ok) {
    // A DT whose query no longer compiles cannot even be created: that is the reproduction.
    if (def.kind === "DYNAMIC_TABLE") {
      reproduced = true
      reproducedError = built.error ?? null
    } else {
      return finish("INCONCLUSIVE", `Could not recreate the job in the sandbox: ${built.error}`)
    }
  } else {
    const repro = await step("REPRODUCE", runJob(), true)
    reproduced = !repro.ok
    reproducedError = repro.ok ? null : normalizeError(repro.error ?? "")
  }

  // ---- APPLY (fix bound to the sandbox). Statements that alter the job itself
  // are applied to the sandbox copy, since the database is rewritten.
  for (const raw of fixStatements) {
    const adapted = sandboxStatement(bindDatabase(raw, sandbox))
    if (!adapted.sql) {
      const entry: RehearsalLogEntry = { step: "APPLY", sql: bindDatabase(raw, sandbox), ok: true, ms: 0, result: adapted.note, at: new Date().toISOString() }
      log.push(entry)
      onProgress(entry)
      continue
    }
    const r = await step("APPLY", adapted.sql)
    if (!r.ok) {
      return finish("FAILED", `Fix statement failed in the sandbox: ${r.error}`, r.error ?? null)
    }
  }
  // A fix that replaces a DT's definition creates it under the sandbox name already;
  // otherwise make sure the (possibly rewritten) job exists for verification.
  if (def.kind === "DYNAMIC_TABLE" && !built.ok) {
    const exists = await step("APPLY", `SHOW DYNAMIC TABLES LIKE '${job.name.replace(/'/g, "''")}' IN SCHEMA ${q(sandbox)}.${q(job.schema)}`)
    if (!exists.rows.length) {
      return finish("FAILED", "The fix did not create a valid dynamic table definition", reproducedError)
    }
  }

  // ---- VERIFY
  const verify = await step("VERIFY", runJob(), true)
  if (!verify.ok) {
    const err = normalizeError(verify.error ?? "")
    return finish("FAILED", `The job still fails in the sandbox after the fix: ${err}`, err)
  }
  if (reproduced === false) {
    return finish("INCONCLUSIVE", "The job also succeeded in the sandbox before the fix, so the rehearsal cannot show the fix is what made it work (the failure may depend on timing or data no longer present).")
  }
  return finish("PASSED", "The failure reproduced in the sandbox and the job succeeded after applying the fix.")
}

function normalizeError(message: string): string {
  const p = parseAwaitFailure(message)
  if (p.code) return `${p.code}: ${p.error ?? ""}`.trim()
  return message.replace(/\s+/g, " ").slice(0, 1000)
}

function summarizeRows(rows: Record<string, unknown>[]): string {
  if (!rows.length) return "ok"
  const first = rows[0]
  const text = Object.entries(first)
    .slice(0, 3)
    .map(([k, v]) => `${k}=${typeof v === "object" ? JSON.stringify(v) : String(v)}`)
    .join(", ")
  return (rows.length > 1 ? `${rows.length} rows; ` : "") + text.slice(0, 300)
}

/** Persist a rehearsal result. */
export async function saveRehearsal(rehearsalId: string, result: RehearsalResult): Promise<void> {
  await sql(
    `UPDATE ADE_DB.OPS.REHEARSALS
     SET OUTCOME = ?, REASON = ?, SANDBOX_SCHEMA = ?, STEPS_LOG = PARSE_JSON(?), ENDED_AT = SYSDATE(), DURATION_MS = ?
     WHERE REHEARSAL_ID = ?`,
    [result.outcome, result.reason.slice(0, 4000), result.sandbox, json({ reproduced: result.reproduced, reproducedError: result.reproducedError, verifyError: result.verifyError, steps: result.log.map((l) => ({ ...l, sql: l.sql?.slice(0, 4000) })) }), result.durationMs, rehearsalId],
  )
}

/** Drop sandbox databases left behind by crashed rehearsals (older than an hour). */
export async function sweepSandboxes(): Promise<number> {
  const rows = await sql<{ name: string; created_on: unknown }>(`SHOW DATABASES LIKE 'ADE\\_SBX\\_%' ->> SELECT "name", "created_on", "owner" FROM $1 WHERE "owner" = 'ADE_APP_ROLE'`)
  let dropped = 0
  for (const r of rows) {
    const created = iso(r.created_on)
    if (created && Date.now() - new Date(created).getTime() > 60 * 60_000 && /^ADE_SBX_[0-9]+_[0-9]+$/.test(r.name)) {
      await sql(`DROP DATABASE IF EXISTS ${q(r.name)}`).catch(() => {})
      dropped++
    }
  }
  return dropped
}
