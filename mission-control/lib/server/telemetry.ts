/**
 * Per-step telemetry. Every agent turn, every tool call inside it, and every
 * orchestrator system step becomes one OPS.AGENT_STEPS row with: what was done
 * (TASK), who did it (ACTOR/PHASE), the model and thinking effort, time taken,
 * token breakdown, and details. Bulky payloads go to TELEMETRY.STEP_PAYLOADS.
 */
import { json, sql } from "@/lib/server/db"
import { nowIso, publish } from "@/lib/server/events"
import type { Actor } from "@/lib/domain"

export interface TokenCounts {
  input: number
  uncachedInput: number
  cacheRead: number
  cacheWrite: number
  output: number
}

export const zeroTokens = (): TokenCounts => ({ input: 0, uncachedInput: 0, cacheRead: 0, cacheWrite: 0, output: 0 })

/** Sum the server's per-model usage (`metadata.usage.tokens_consumed[]`). */
export function tokensFromUsage(usage: unknown): { totals: TokenCounts; perModel: Record<string, TokenCounts & { role?: string }> } {
  const totals = zeroTokens()
  const perModel: Record<string, TokenCounts & { role?: string }> = {}
  const entries = (usage as { tokens_consumed?: unknown[] } | undefined)?.tokens_consumed
  if (!Array.isArray(entries)) return { totals, perModel }
  for (const raw of entries) {
    const e = raw as { model_name?: string; model_role?: string; input_tokens?: Record<string, number>; output_tokens?: { total?: number } }
    const t: TokenCounts = {
      input: Number(e.input_tokens?.total ?? 0),
      uncachedInput: Number(e.input_tokens?.uncached ?? 0),
      cacheRead: Number(e.input_tokens?.cache_read ?? 0),
      cacheWrite: Number(e.input_tokens?.cache_write ?? 0),
      output: Number(e.output_tokens?.total ?? 0),
    }
    const key = e.model_name ?? "unknown"
    const prev = perModel[key] ?? { ...zeroTokens(), role: e.model_role }
    perModel[key] = {
      input: prev.input + t.input,
      uncachedInput: prev.uncachedInput + t.uncachedInput,
      cacheRead: prev.cacheRead + t.cacheRead,
      cacheWrite: prev.cacheWrite + t.cacheWrite,
      output: prev.output + t.output,
      role: prev.role ?? e.model_role,
    }
    totals.input += t.input
    totals.uncachedInput += t.uncachedInput
    totals.cacheRead += t.cacheRead
    totals.cacheWrite += t.cacheWrite
    totals.output += t.output
  }
  return { totals, perModel }
}

export interface StepStart {
  incidentId: string
  agentRunId?: string | null
  parentStepId?: string | null
  kind: "TURN" | "TOOL_CALL" | "SYSTEM"
  actor: Actor
  phase: string
  task: string
  model?: string | null
  toolName?: string | null
  toolType?: string | null
  toolUseId?: string | null
  threadId?: string | null
  startedAt?: Date
}

export interface StepEnd {
  status: "SUCCEEDED" | "FAILED" | "SKIPPED"
  summary?: string | null
  detail?: unknown
  error?: string | null
  tokens?: TokenCounts
  model?: string | null
  thinkingEffort?: string | null
  cortexRunId?: string | null
  requestId?: string | null
  lastEventSeq?: number | null
  endedAt?: Date
}

/** Allocates SEQ per incident (one orchestrator instance, so in-memory is safe after a DB seed). */
const g = globalThis as unknown as { __adeSeq?: Map<string, number> }
async function nextSeq(incidentId: string): Promise<number> {
  if (!g.__adeSeq) g.__adeSeq = new Map()
  let cur = g.__adeSeq.get(incidentId)
  if (cur === undefined) {
    const [row] = await sql<{ S: number }>(`SELECT COALESCE(MAX(SEQ), 0) AS S FROM ADE_DB.OPS.AGENT_STEPS WHERE INCIDENT_ID = ?`, [incidentId])
    cur = Number(row?.S ?? 0)
  }
  cur += 1
  g.__adeSeq.set(incidentId, cur)
  return cur
}

export class Step {
  readonly stepId: string
  readonly start: StepStart
  readonly startedAt: Date
  private ended = false

  private constructor(stepId: string, start: StepStart, startedAt: Date) {
    this.stepId = stepId
    this.start = start
    this.startedAt = startedAt
  }

  static async begin(start: StepStart): Promise<Step> {
    const stepId = crypto.randomUUID()
    const startedAt = start.startedAt ?? new Date()
    const seq = await nextSeq(start.incidentId)
    await sql(
      `INSERT INTO ADE_DB.OPS.AGENT_STEPS (STEP_ID, INCIDENT_ID, AGENT_RUN_ID, PARENT_STEP_ID, SEQ, KIND, ACTOR, PHASE, TASK, STATUS,
         MODEL, STARTED_AT, TOOL_NAME, TOOL_TYPE, TOOL_USE_ID, THREAD_ID)
       SELECT ?, ?, ?, ?, ?, ?, ?, ?, ?, 'RUNNING', ?, CONVERT_TIMEZONE('UTC', ?::TIMESTAMP_TZ)::TIMESTAMP_NTZ, ?, ?, ?, ?`,
      [
        stepId, start.incidentId, start.agentRunId ?? null, start.parentStepId ?? null, seq, start.kind, start.actor, start.phase,
        start.task.slice(0, 1000), start.model ?? null, startedAt.toISOString(), start.toolName ?? null, start.toolType ?? null,
        start.toolUseId ?? null, start.threadId ?? null,
      ],
    )
    publish({ type: "step.started", incidentId: start.incidentId, stepId, actor: start.actor, kind: start.kind, task: start.task, at: nowIso() })
    return new Step(stepId, start, startedAt)
  }

  async end(end: StepEnd): Promise<number> {
    if (this.ended) return 0
    this.ended = true
    const endedAt = end.endedAt ?? new Date()
    const durationMs = Math.max(0, endedAt.getTime() - this.startedAt.getTime())
    const t = end.tokens ?? zeroTokens()
    await sql(
      `UPDATE ADE_DB.OPS.AGENT_STEPS
       SET STATUS = ?, ENDED_AT = CONVERT_TIMEZONE('UTC', ?::TIMESTAMP_TZ)::TIMESTAMP_NTZ, DURATION_MS = ?,
           INPUT_TOKENS = ?, UNCACHED_INPUT_TOKENS = ?, CACHE_READ_TOKENS = ?, CACHE_WRITE_TOKENS = ?, OUTPUT_TOKENS = ?,
           MODEL = COALESCE(?, MODEL), THINKING_EFFORT = ?, CORTEX_RUN_ID = ?, REQUEST_ID = ?, LAST_EVENT_SEQ = ?,
           SUMMARY = ?, DETAIL = PARSE_JSON(?), ERROR_MESSAGE = ?
       WHERE STEP_ID = ?`,
      [
        end.status, endedAt.toISOString(), durationMs, t.input, t.uncachedInput, t.cacheRead, t.cacheWrite, t.output,
        end.model ?? null, end.thinkingEffort ?? null, end.cortexRunId ?? null, end.requestId ?? null, end.lastEventSeq ?? null,
        end.summary?.slice(0, 4000) ?? null, json(end.detail ?? null), end.error?.slice(0, 4000) ?? null, this.stepId,
      ],
    )
    publish({ type: "step.updated", incidentId: this.start.incidentId, stepId: this.stepId, status: end.status, durationMs, tokens: t.input + t.output, at: nowIso() })
    return durationMs
  }

  /** Store a bulky payload for this step (tool input/output, reasoning, prompts). */
  async payload(kind: string, payload: unknown): Promise<void> {
    await savePayload(this.stepId, this.start.incidentId, kind, payload)
  }
}

export async function savePayload(stepId: string, incidentId: string, kind: string, payload: unknown): Promise<void> {
  const text = json(payload)
  if (text === null) return
  // Keep payloads under ~4 MB (VARIANT limit is 16 MB; leave headroom).
  const bounded = text.length > 4_000_000 ? json({ truncated: true, bytes: text.length, head: text.slice(0, 200_000) }) : text
  await sql(
    `INSERT INTO ADE_DB.TELEMETRY.STEP_PAYLOADS (STEP_ID, INCIDENT_ID, PAYLOAD_KIND, PAYLOAD, BYTES) SELECT ?, ?, ?, PARSE_JSON(?), ?`,
    [stepId, incidentId, kind, bounded, text.length],
  ).catch((e) => console.error(nowIso(), "[telemetry] payload insert failed", kind, e))
}

/** Convenience: run a SYSTEM step around an async function. */
export async function systemStep<T>(
  incidentId: string,
  phase: string,
  task: string,
  fn: (step: Step) => Promise<{ value: T; summary?: string; detail?: unknown; status?: StepEnd["status"] }>,
): Promise<T> {
  const step = await Step.begin({ incidentId, kind: "SYSTEM", actor: "SYSTEM", phase, task })
  try {
    const r = await fn(step)
    await step.end({ status: r.status ?? "SUCCEEDED", summary: r.summary, detail: r.detail })
    return r.value
  } catch (e) {
    await step.end({ status: "FAILED", error: e instanceof Error ? e.message : String(e) })
    throw e
  }
}
