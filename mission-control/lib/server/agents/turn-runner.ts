/**
 * Runs one phase of one agent: a single prompt on the agent's Cortex thread,
 * ending with the agent's submit tool. Streams every event into telemetry and
 * the live UI, validates the submission, and returns it.
 *
 *   TURN step        the agent turn: model, effort, tokens, time, run/thread ids
 *     TOOL_CALL step each sandbox tool call (SQL, bash, ...) with its time and I/O
 *     TOOL_CALL step the submit tool (validated payload)
 *
 * If the submission fails validation the error is returned to the agent as the
 * tool result and the agent gets another turn on the same thread (max 2).
 */
import type { ZodType } from "zod"
import type { Conversation, Turn } from "@snowflake/cortex-agent-sdk"
import { getAgentClient, THREAD_ORIGIN } from "@/lib/server/cortex"
import { sql } from "@/lib/server/db"
import { nowIso, publish } from "@/lib/server/events"
import { Step, savePayload, tokensFromUsage, zeroTokens, type TokenCounts } from "@/lib/server/telemetry"
import { AGENT_DATABASE, AGENT_NAMES, AGENT_SCHEMA, SUBMIT_TOOL } from "@/lib/server/agents/definitions"
import { currentSpec } from "@/lib/server/agents/registry"
import { formatZodError } from "@/lib/server/agents/schemas"
import type { AgentRole } from "@/lib/domain"

export interface TurnOutcome<T> {
  value: T | null
  agentRunId: string
  threadId: string
  error?: string
  tokens: TokenCounts
  durationMs: number
  model: string | null
}

interface RunAgentOptions<T> {
  incidentId: string
  role: AgentRole
  phase: string
  task: string
  prompt: string
  schema: ZodType<T>
  /** Extra validation after the schema (e.g. SQL guard). Return an error string to reject. */
  validate?: (value: T) => string | null
  /** Existing thread for this incident+agent (continuations keep context). */
  threadId?: string | null
  iteration?: number
  maxCorrections?: number
  timeoutMs?: number
  signal?: AbortSignal
}

type Ev = Record<string, any>

export async function runAgentPhase<T>(opts: RunAgentOptions<T>): Promise<TurnOutcome<T>> {
  const client = getAgentClient()
  const agentTarget = { type: "data" as const, spec: { database: AGENT_DATABASE, schema: AGENT_SCHEMA, name: AGENT_NAMES[opts.role] } }
  const conversation: Conversation = opts.threadId
    ? await client.conversations.attach(opts.threadId, { agent: agentTarget })
    : await client.conversations.create({
        // The thread is linked to the incident in OPS.AGENT_RUNS / INCIDENTS.*_THREAD_ID;
        // the API accepted only origin_application here (external_id/metadata -> 390142).
        thread: { origin_application: THREAD_ORIGIN },
        agent: agentTarget,
      })
  const threadId = conversation.id

  const agentRunId = crypto.randomUUID()
  const spec = currentSpec(opts.role)
  await sql(
    `INSERT INTO ADE_DB.OPS.AGENT_RUNS (AGENT_RUN_ID, INCIDENT_ID, AGENT_ROLE, AGENT_FQN, AGENT_SPEC_HASH, ITERATION, STATUS, MODEL, THREAD_ID)
     SELECT ?, ?, ?, ?, ?, ?, 'RUNNING', ?, ?`,
    [agentRunId, opts.incidentId, opts.role, `${AGENT_DATABASE}.${AGENT_SCHEMA}.${AGENT_NAMES[opts.role]}`, spec?.specHash ?? null, opts.iteration ?? 1, spec?.model ?? null, threadId],
  )

  const t0 = Date.now()
  const totals = zeroTokens()
  let model: string | null = spec?.model ?? null
  let effort: string | null = null
  let lastRequestId: string | null = null
  let lastRunId: string | null = null
  let toolCalls = 0
  let value: T | null = null
  let error: string | undefined

  let input: Parameters<Conversation["send"]>[0] = opts.prompt
  let sendResults: { toolUse: { toolUseId: string; name: string; input: Record<string, unknown> }; result: unknown }[] | null = null
  const corrections = opts.maxCorrections ?? 2
  const deadline = t0 + (opts.timeoutMs ?? 20 * 60_000)

  for (let attempt = 0; attempt <= corrections; attempt++) {
    const turnStep = await Step.begin({
      incidentId: opts.incidentId,
      agentRunId,
      kind: "TURN",
      actor: opts.role,
      phase: opts.phase,
      task: attempt === 0 ? opts.task : `${opts.task} (correction ${attempt})`,
      model,
      threadId,
    })
    if (attempt === 0) await turnStep.payload("PROMPT", { prompt: opts.prompt })

    const turn: Turn = sendResults ? await conversation.sendToolResults(sendResults) : await conversation.send(input)
    sendResults = null
    const { submit, events, statusTimeline, seq, toolSteps } = await consumeTurn(turn, turnStep, opts, deadline)
    toolCalls += toolSteps

    let result
    try {
      // Falls back to the persisted thread message if the live stream is gone.
      result = await turn.result()
    } catch (e) {
      error = e instanceof Error ? e.message : String(e)
      await turnStep.end({ status: "FAILED", error, lastEventSeq: seq })
      break
    }
    const meta = result.metadata as Record<string, any>
    const { totals: t, perModel } = tokensFromUsage(meta?.usage)
    addTokens(totals, t)
    model = meta?.orchestration_model ?? model
    effort = meta?.thinking_effort ?? effort
    lastRequestId = result.requestId ?? lastRequestId
    lastRunId = result.runId ?? meta?.run_id ?? lastRunId
    await turnStep.payload("STATUS_TIMELINE", statusTimeline)
    if (events.text) await turnStep.payload("TEXT", { text: events.text })
    if (events.thinking) await turnStep.payload("THINKING", { text: events.thinking })

    if (!submit) {
      error = `${opts.role} ended its turn without calling ${SUBMIT_TOOL[opts.role]} (status ${result.status ?? "unknown"})`
      await turnStep.end({
        status: "FAILED", error, tokens: t, model, thinkingEffort: effort, cortexRunId: lastRunId, requestId: lastRequestId, lastEventSeq: seq,
        summary: events.text.slice(-500) || null, detail: { perModel, status: result.status },
      })
      if (attempt < corrections && Date.now() < deadline) {
        input = `You must finish by calling ${SUBMIT_TOOL[opts.role]} exactly once. Do that now with your best complete answer.`
        error = undefined
        continue
      }
      break
    }

    const parsed = opts.schema.safeParse(submit.input)
    const extra = parsed.success && opts.validate ? opts.validate(parsed.data) : null
    if (parsed.success && !extra) {
      value = parsed.data
      await turnStep.end({
        status: "SUCCEEDED", tokens: t, model, thinkingEffort: effort, cortexRunId: lastRunId, requestId: lastRequestId, lastEventSeq: seq,
        summary: summarize(opts.role, parsed.data), detail: { perModel, status: result.status, toolCalls: toolSteps, submitTool: submit.name },
      })
      await savePayload(turnStep.stepId, opts.incidentId, "STRUCTURED_OUTPUT", parsed.data)
      // Close the paused tool call so the thread is not left waiting on the client.
      await conversation
        .sendToolResults([{ toolUse: submit, result: { accepted: true, message: "Recorded. End your turn now without further output." } }])
        .then((closing) => closing.result())
        .then((closing) => addTokens(totals, tokensFromUsage((closing.metadata as Record<string, any>)?.usage).totals))
        .catch((e) => console.warn(nowIso(), "[agent] closing turn failed (non-fatal)", e instanceof Error ? e.message : e))
      break
    }

    const reason = parsed.success ? extra! : formatZodError(parsed.error)
    error = `Invalid ${submit.name} payload: ${reason}`
    await turnStep.end({
      status: "FAILED", error, tokens: t, model, thinkingEffort: effort, cortexRunId: lastRunId, requestId: lastRequestId, lastEventSeq: seq,
      detail: { perModel, rejectedPayload: submit.input },
    })
    if (attempt < corrections && Date.now() < deadline) {
      sendResults = [{ toolUse: submit, result: { accepted: false, error: `Rejected: ${reason}. Fix every problem and call ${submit.name} again with a complete payload.` } }]
      error = undefined
      continue
    }
    break
  }

  const durationMs = Date.now() - t0
  await sql(
    `UPDATE ADE_DB.OPS.AGENT_RUNS
     SET STATUS = ?, ENDED_AT = SYSDATE(), DURATION_MS = ?, MODEL = ?, THINKING_EFFORT = ?, CORTEX_RUN_ID = ?, REQUEST_ID = ?, TOOL_CALLS = ?,
         INPUT_TOKENS = ?, UNCACHED_INPUT_TOKENS = ?, CACHE_READ_TOKENS = ?, CACHE_WRITE_TOKENS = ?, OUTPUT_TOKENS = ?, ERROR_MESSAGE = ?
     WHERE AGENT_RUN_ID = ?`,
    [value ? "SUCCEEDED" : "FAILED", durationMs, model, effort, lastRunId, lastRequestId, toolCalls,
     totals.input, totals.uncachedInput, totals.cacheRead, totals.cacheWrite, totals.output, error?.slice(0, 4000) ?? null, agentRunId],
  )
  await sql(
    `UPDATE ADE_DB.OPS.INCIDENTS SET TOTAL_TOKENS = TOTAL_TOKENS + ?, TOTAL_AGENT_MS = TOTAL_AGENT_MS + ?, UPDATED_AT = SYSDATE() WHERE INCIDENT_ID = ?`,
    [totals.input + totals.output, durationMs, opts.incidentId],
  )
  return { value, agentRunId, threadId, error, tokens: totals, durationMs, model }
}

/** Stream one turn's events into child steps and the live bus. */
async function consumeTurn<T>(turn: Turn, turnStep: Step, opts: RunAgentOptions<T>, deadline: number) {
  const openTools = new Map<string, Step>()
  const toolInputs = new Map<string, unknown>()
  const statusTimeline: { at: string; status: string; message?: string }[] = []
  const events = { text: "", thinking: "" }
  const pending = { text: "", thinking: "" }
  let submit: { toolUseId: string; name: string; input: Record<string, unknown> } | null = null
  let seq = 0
  let toolSteps = 0
  let lastPublish = 0
  const flush = () => {
    for (const channel of ["thinking", "text"] as const) {
      if (pending[channel]) {
        publish({ type: "agent.delta", incidentId: opts.incidentId, stepId: turnStep.stepId, actor: opts.role, channel, text: pending[channel], at: nowIso() })
        pending[channel] = ""
      }
    }
    lastPublish = Date.now()
  }

  for await (const raw of turn.events()) {
    const ev = raw as Ev
    if (typeof ev.sequence_number === "number") seq = ev.sequence_number
    if (Date.now() > deadline) {
      await turn.cancel().catch(() => {})
      throw new Error(`${opts.role} exceeded its time budget`)
    }
    switch (ev.event) {
      case "response.status":
        statusTimeline.push({ at: nowIso(), status: ev.status, message: ev.message })
        publish({ type: "agent.status", incidentId: opts.incidentId, stepId: turnStep.stepId, actor: opts.role, status: ev.status, message: ev.message ?? "", at: nowIso() })
        break
      case "response.thinking.delta":
      case "response.text.delta": {
        const channel = ev.event === "response.text.delta" ? "text" : "thinking"
        const piece = String(ev.text ?? "")
        events[channel] += piece
        pending[channel] += piece
        // Coalesce token deltas to ~4 updates/second for the live trace.
        if (Date.now() - lastPublish > 250) flush()
        break
      }
      case "response.tool_use": {
        flush()
        const id = String(ev.tool_use_id)
        toolInputs.set(id, ev.input)
        if (ev.client_side_execute && ev.name === SUBMIT_TOOL[opts.role]) {
          submit = { toolUseId: id, name: ev.name, input: (ev.input ?? {}) as Record<string, unknown> }
          const s = await Step.begin({ incidentId: opts.incidentId, agentRunId: turnStep.start.agentRunId, parentStepId: turnStep.stepId, kind: "TOOL_CALL", actor: opts.role, phase: opts.phase, task: `Submitted ${ev.name}`, toolName: ev.name, toolType: "client", toolUseId: id })
          await s.payload("TOOL_INPUT", ev.input)
          await s.end({ status: "SUCCEEDED", summary: "Structured output submitted" })
          toolSteps++
        } else {
          const s = await Step.begin({
            incidentId: opts.incidentId, agentRunId: turnStep.start.agentRunId, parentStepId: turnStep.stepId, kind: "TOOL_CALL", actor: opts.role,
            phase: opts.phase, task: describeTool(ev), toolName: ev.name, toolType: ev.type, toolUseId: id,
          })
          openTools.set(id, s)
          toolSteps++
        }
        break
      }
      case "response.tool_result": {
        const id = String(ev.tool_use_id)
        const s = openTools.get(id)
        if (s) {
          openTools.delete(id)
          const output = (ev.content ?? []).map((c: Ev) => (c.type === "text" ? c.text : c.json ?? c)).slice(0, 50)
          const textOut = output.map((o: unknown) => (typeof o === "string" ? o : JSON.stringify(o))).join("\n")
          await s.payload("TOOL_INPUT", toolInputs.get(id) ?? null)
          await s.payload("TOOL_OUTPUT", output)
          const ok = String(ev.status ?? "success").toLowerCase() === "success"
          const queryId = /([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})/.exec(textOut)?.[1] ?? null
          await s.end({
            status: ok ? "SUCCEEDED" : "FAILED",
            summary: textOut.replace(/\s+/g, " ").slice(0, 300),
            error: ok ? null : textOut.slice(0, 2000),
            detail: { webAccess: ev.name === "web_fetch" || ev.name === "web_search", queryId },
          })
        }
        break
      }
      case "error":
        statusTimeline.push({ at: nowIso(), status: "error", message: `${ev.code}: ${ev.message}` })
        break
    }
  }
  flush()
  for (const s of openTools.values()) await s.end({ status: "FAILED", error: "Tool call did not return a result" })
  return { submit, events, statusTimeline, seq, toolSteps }
}

function describeTool(ev: Ev): string {
  const input = (ev.input ?? {}) as Record<string, unknown>
  if (ev.name === "snowflake_sql_execute") return `SQL: ${String(input.description ?? input.sql ?? "").replace(/\s+/g, " ").slice(0, 200)}`
  if (ev.name === "bash") return `Shell: ${String(input.description ?? input.command ?? "").slice(0, 200)}`
  if (ev.name === "web_fetch" || ev.name === "web_search") return `Web access (${ev.name}): ${String(input.url ?? input.query ?? "").slice(0, 200)}`
  return `${ev.name}${input.description ? `: ${String(input.description).slice(0, 200)}` : ""}`
}

function summarize(role: AgentRole, v: unknown): string {
  const o = v as Record<string, any>
  if (role === "INVESTIGATOR") return `${o.category} · ${o.fixability} · confidence ${o.confidence}: ${o.summary}`
  if (role === "FIXER") return `${o.strategy} · risk ${o.risk_level} · ${o.statements?.length ?? 0} statements: ${o.title}`
  return `${o.verdict} · confidence ${o.confidence}: ${String(o.summary ?? "").slice(0, 300)}`
}

function addTokens(target: TokenCounts, t: TokenCounts): void {
  target.input += t.input
  target.uncachedInput += t.uncachedInput
  target.cacheRead += t.cacheRead
  target.cacheWrite += t.cacheWrite
  target.output += t.output
}
