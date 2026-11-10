/**
 * Self-tests written to ADE_DB.TELEMETRY.HEALTH_CHECKS so the platform's
 * assumptions can be verified with plain SQL:
 *
 *   SQL_IDENTITY    the app's own session: user, role, warehouse, hybrid read
 *   AGENT_SANDBOX   a Cortex Code agent run under the app's service identity:
 *                   sandbox SQL works, reads a monitored database, and a write
 *                   into a monitored database is refused
 *
 * AGENT_SANDBOX costs one short agent turn, so it runs once per app instance
 * start (and on demand from the System page).
 */
import os from "node:os"
import { agentsAllowedHere, getAgentClient, THREAD_ORIGIN } from "@/lib/server/cortex"
import { json, sql } from "@/lib/server/db"
import { nowIso, publish } from "@/lib/server/events"

export type CheckStatus = "PASS" | "WARN" | "FAIL"

export interface CheckResult {
  name: string
  status: CheckStatus
  durationMs: number
  summary: string
  detail?: unknown
}

const INSTANCE = `${os.hostname()}:${process.pid}`

async function record(result: CheckResult): Promise<CheckResult> {
  try {
    await sql(
      `INSERT INTO ADE_DB.TELEMETRY.HEALTH_CHECKS (CHECK_NAME, STATUS, DURATION_MS, SUMMARY, DETAIL, INSTANCE)
       SELECT ?, ?, ?, ?, PARSE_JSON(?), ?`,
      [result.name, result.status, result.durationMs, result.summary.slice(0, 4000), json(result.detail ?? null), INSTANCE],
    )
  } catch (e) {
    console.error(nowIso(), "[selftest] could not record", result.name, e)
  }
  publish({ type: "health.updated", at: nowIso() })
  return result
}

export async function checkSqlIdentity(): Promise<CheckResult> {
  const t0 = Date.now()
  try {
    const [who] = await sql<{ U: string; R: string; W: string; S: number }>(
      `SELECT CURRENT_USER() AS U, CURRENT_ROLE() AS R, CURRENT_WAREHOUSE() AS W,
              (SELECT COUNT(*) FROM ADE_DB.OPS.SETTINGS) AS S`,
    )
    const ok = who.R === "ADE_APP_ROLE" || !process.env.SNOWFLAKE_HOST
    return record({
      name: "SQL_IDENTITY",
      status: ok ? "PASS" : "WARN",
      durationMs: Date.now() - t0,
      summary: `Connected as ${who.U} / ${who.R} on ${who.W ?? "no warehouse"}; ${who.S} settings readable from hybrid tables`,
      detail: who,
    })
  } catch (e) {
    return record({ name: "SQL_IDENTITY", status: "FAIL", durationMs: Date.now() - t0, summary: errorText(e) })
  }
}

const SELFTEST_TOOL = {
  tool_spec: {
    type: "generic",
    name: "submit_selftest",
    description: "Report the outcome of each probe. Call exactly once after running all three probes.",
    input_schema: {
      type: "object",
      properties: {
        identity: { type: "string", description: "Result of probe 1 (user, role, warehouse) or its error" },
        read_monitored: { type: "string", description: "Result of probe 2 (row count) or its error" },
        write_probe: { type: "string", description: "Verbatim error (or result) of probe 3" },
        write_refused: { type: "boolean", description: "True if probe 3 was refused or failed" },
      },
      required: ["identity", "read_monitored", "write_probe", "write_refused"],
    },
  },
}

export async function checkAgentSandbox(model = "claude-sonnet-5"): Promise<CheckResult> {
  const t0 = Date.now()
  const gate = agentsAllowedHere()
  if (!gate.allowed) {
    return record({ name: "AGENT_SANDBOX", status: "WARN", durationMs: 0, summary: gate.reason ?? "Agents disabled here" })
  }
  const tools: string[] = []
  try {
    const conversation = await getAgentClient().conversations.create({
      thread: { origin_application: THREAD_ORIGIN },
      agent: {
        type: "coding",
        spec: {
          models: { orchestration: model },
          thinkingEffort: "low",
          permissionPolicy: "always_allow",
          orchestration: { budget: { seconds: 240, tokens: 300000 } },
          instructions: {
            system:
              "You are a platform self-test. Run exactly these three SQL probes with your SQL tool, one at a time, then call submit_selftest. Do not run anything else and do not retry failures.",
          },
          tools: [SELFTEST_TOOL as never],
          client_metadata: { purpose: "selftest" } as never,
        },
      },
    })
    const turn = await conversation.send(
      [
        "Probe 1: SELECT CURRENT_USER(), CURRENT_ROLE(), CURRENT_WAREHOUSE()",
        "Probe 2: SELECT COUNT(*) FROM ADE_DEMO_RETAIL.RAW.ORDERS",
        "Probe 3: CREATE TABLE ADE_DEMO_RETAIL.RAW.ADE_WRITE_PROBE (X INT)",
        "Report each result verbatim with submit_selftest.",
      ].join("\n"),
    )
    let submitted: Record<string, unknown> | null = null
    let submitUse: { toolUseId: string; name: string; input: Record<string, unknown> } | null = null
    const sqlResults: string[] = []
    for await (const ev of turn.events()) {
      const e = ev as Record<string, any>
      if (e.event === "response.tool_use") {
        tools.push(`${e.type}:${e.name}`)
        if (e.client_side_execute) {
          submitted = e.input
          submitUse = { toolUseId: e.tool_use_id, name: e.name, input: e.input }
        }
      }
      if (e.event === "response.tool_result") {
        sqlResults.push(`${e.status}: ${(e.content ?? []).map((c: any) => c.text ?? "").join(" ").slice(0, 400)}`)
      }
    }
    const result = await turn.result()
    if (submitUse) {
      // Close the paused turn so the thread does not stay waiting on the client.
      await conversation.sendToolResults([{ toolUse: submitUse, result: "Recorded." }]).catch(() => {})
    }
    const detail = { submitted, tools, sqlResults, requestId: result.requestId, runId: result.runId, threadId: conversation.id, usage: result.usage, model: result.metadata?.orchestration_model }
    if (!submitted) {
      return record({ name: "AGENT_SANDBOX", status: "FAIL", durationMs: Date.now() - t0, summary: "Agent did not submit probe results", detail })
    }
    const identity = String(submitted.identity ?? "")
    const readOk = /\d/.test(String(submitted.read_monitored ?? "")) && !/error|denied|not authorized|does not exist/i.test(String(submitted.read_monitored))
    const writeRefused = submitted.write_refused === true
    const status: CheckStatus = readOk && writeRefused && !/error|USER\$/i.test(identity) ? "PASS" : writeRefused ? "WARN" : "FAIL"
    return record({
      name: "AGENT_SANDBOX",
      status,
      durationMs: Date.now() - t0,
      summary: `Sandbox identity: ${identity.slice(0, 200)} | read: ${String(submitted.read_monitored).slice(0, 120)} | write refused: ${writeRefused}`,
      detail,
    })
  } catch (e) {
    return record({ name: "AGENT_SANDBOX", status: "FAIL", durationMs: Date.now() - t0, summary: errorText(e), detail: { tools } })
  }
}

export function errorText(e: unknown): string {
  return e instanceof Error ? e.message : String(e)
}
