/**
 * In-process event bus: the orchestrator publishes, SSE routes subscribe.
 * One app instance (min_instances = max_instances = 1), so in-memory fan-out is
 * enough; every event is also persisted to the OPS tables, so a reconnecting
 * browser recovers state from SQL and only uses the stream for live updates.
 */
import { EventEmitter } from "node:events"

export type LiveEvent =
  | { type: "incident.updated"; incidentId: string; status: string; at: string }
  | { type: "incident.created"; incidentId: string; at: string }
  | { type: "step.started"; incidentId: string; stepId: string; actor: string; kind: string; task: string; at: string }
  | { type: "step.updated"; incidentId: string; stepId: string; status: string; durationMs?: number; tokens?: number; at: string }
  | { type: "agent.delta"; incidentId: string; stepId: string; actor: string; channel: "text" | "thinking"; text: string; at: string }
  | { type: "agent.status"; incidentId: string; stepId: string; actor: string; status: string; message: string; at: string }
  | { type: "orchestrator.heartbeat"; state: OrchestratorState; at: string }
  | { type: "health.updated"; at: string }

export interface OrchestratorState {
  instance: string
  enabled: boolean
  running: number
  maxInFlight: number
  lastTickAt: string | null
  lastError: string | null
  startedAt: string
}

const g = globalThis as unknown as { __adeBus?: EventEmitter }

function bus(): EventEmitter {
  if (!g.__adeBus) {
    g.__adeBus = new EventEmitter()
    g.__adeBus.setMaxListeners(500)
  }
  return g.__adeBus
}

export function publish(event: LiveEvent): void {
  bus().emit("event", event)
}

export function subscribe(listener: (event: LiveEvent) => void): () => void {
  bus().on("event", listener)
  return () => bus().off("event", listener)
}

export function listenerCount(): number {
  return bus().listenerCount("event")
}

export function nowIso(): string {
  return new Date().toISOString()
}
