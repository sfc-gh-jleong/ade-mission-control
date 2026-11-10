/**
 * Human actions. Each runs as the signed-in user (caller's rights), so GUARD
 * procedures see CURRENT_USER() = that person and apply the approver check.
 * The app's own identity has no USAGE on the GUARD procedures, so none of
 * these can happen without a person behind the request.
 *
 * Locally (no caller token) these use the developer's own connection, which
 * is also a real person.
 */
import { querySnowflake } from "@/lib/snowflake"
import { json, sql } from "@/lib/server/db"
import { nowIso, publish } from "@/lib/server/events"
import { wakeOrchestrator } from "@/lib/server/orchestrator"

function first(rows: Record<string, unknown>[]): unknown {
  const r = rows[0] ?? {}
  const v = Object.values(r)[0]
  if (typeof v === "string") {
    try {
      return JSON.parse(v)
    } catch {
      return v
    }
  }
  return v
}

async function asCaller(text: string, binds: (string | number | boolean | null)[]): Promise<Record<string, unknown>[]> {
  return querySnowflake(text, { callersRights: true, binds: binds as never })
}

export async function whoAmI(): Promise<{ user: string; role: string; approver: boolean }> {
  const rows = await asCaller(`SELECT CURRENT_USER() AS U, CURRENT_ROLE() AS R`, [])
  const user = String(rows[0]?.U ?? "")
  const approvers = await sql<{ U: string }>(`SELECT USER_NAME AS U FROM ADE_DB.GUARD.APPROVERS WHERE ACTIVE`)
  return { user, role: String(rows[0]?.R ?? ""), approver: approvers.some((a) => a.U === user.toUpperCase()) }
}

export async function approveFix(fixId: string, expectedHash: string, note: string) {
  const result = first(await asCaller(`CALL ADE_DB.GUARD.APPROVE_FIX(?, ?, ?)`, [fixId, expectedHash, note.slice(0, 2000)]))
  await notify(fixId)
  return result
}

export async function rejectFix(fixId: string, note: string) {
  const result = first(await asCaller(`CALL ADE_DB.GUARD.REJECT_FIX(?, ?)`, [fixId, note.slice(0, 2000)]))
  await notify(fixId)
  return result
}

export async function applyFix(fixId: string, expectedHash: string, runAfter: boolean) {
  const result = first(await asCaller(`CALL ADE_DB.GUARD.APPLY_FIX(?, ?, ?)`, [fixId, expectedHash, runAfter]))
  await notify(fixId)
  wakeOrchestrator()
  return result
}

export async function rollbackFix(fixId: string, note: string) {
  const result = first(await asCaller(`CALL ADE_DB.GUARD.ROLLBACK_FIX(?, ?)`, [fixId, note.slice(0, 2000)]))
  await notify(fixId)
  return result
}

export async function runJob(incidentId: string, note: string) {
  const result = first(await asCaller(`CALL ADE_DB.GUARD.RUN_JOB(?, ?)`, [incidentId, note.slice(0, 2000)]))
  publish({ type: "incident.updated", incidentId, status: "RUN_REQUESTED", at: nowIso() })
  return result
}

/** Queue a dormant/backfill incident (or retry a NEEDS_HUMAN one) for the agents. */
export async function queueIncident(incidentId: string, user: string) {
  await sql(
    `UPDATE ADE_DB.OPS.INCIDENTS
     SET STATUS = 'QUEUED', STATUS_DETAIL = 'Queued for the agents by ' || ?, QUEUED_BY = ?, FIX_ITERATIONS = 0, UPDATED_AT = SYSDATE()
     WHERE INCIDENT_ID = ? AND STATUS IN ('DETECTED', 'NEEDS_HUMAN', 'NO_FIX', 'FAILED')`,
    [user, user, incidentId],
  )
  await sql(`INSERT INTO ADE_DB.OPS.AUDIT_LOG (INCIDENT_ID, ACTOR, ACTION, DETAIL) SELECT ?, ?, 'QUEUED', PARSE_JSON(?)`, [incidentId, user, json({ by: user })])
  publish({ type: "incident.updated", incidentId, status: "QUEUED", at: nowIso() })
  wakeOrchestrator()
}

/** Dismiss an incident (no action needed). */
export async function suppressIncident(incidentId: string, user: string, note: string) {
  await sql(
    `UPDATE ADE_DB.OPS.INCIDENTS SET STATUS = 'SUPPRESSED', STATUS_DETAIL = 'Dismissed by ' || ? || ': ' || ?, UPDATED_AT = SYSDATE(), RESOLVED_AT = SYSDATE()
     WHERE INCIDENT_ID = ? AND STATUS NOT IN ('APPLYING', 'VERIFYING')`,
    [user, note.slice(0, 500), incidentId],
  )
  await sql(`INSERT INTO ADE_DB.OPS.AUDIT_LOG (INCIDENT_ID, ACTOR, ACTION, DETAIL) SELECT ?, ?, 'SUPPRESSED', PARSE_JSON(?)`, [incidentId, user, json({ note })])
  publish({ type: "incident.updated", incidentId, status: "SUPPRESSED", at: nowIso() })
}

/** Settings are changed by people (caller's rights), never by the app identity the agents share. */
export async function updateSetting(key: string, value: unknown) {
  await asCaller(
    `UPDATE ADE_DB.OPS.SETTINGS SET SETTING_VALUE = PARSE_JSON(?), UPDATED_BY = CURRENT_USER(), UPDATED_AT = SYSDATE() WHERE SETTING_KEY = ?`,
    [json(value), key],
  )
  await asCaller(
    `INSERT INTO ADE_DB.OPS.AUDIT_LOG (ACTOR, ACTION, DETAIL) SELECT CURRENT_USER(), 'SETTING_CHANGED', PARSE_JSON(?)`,
    [json({ key, value })],
  )
  wakeOrchestrator()
}

async function notify(fixId: string) {
  const rows = await sql<{ I: string; S: string }>(`SELECT i.INCIDENT_ID AS I, i.STATUS AS S FROM ADE_DB.OPS.FIXES f JOIN ADE_DB.OPS.INCIDENTS i ON i.INCIDENT_ID = f.INCIDENT_ID WHERE f.FIX_ID = ?`, [fixId])
  if (rows[0]) publish({ type: "incident.updated", incidentId: rows[0].I, status: rows[0].S, at: nowIso() })
}
