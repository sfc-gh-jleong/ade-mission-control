"use client"

/**
 * Live updates: one EventSource per tab, shared through a tiny pub/sub.
 * Components subscribe to orchestrator/agent events and invalidate their
 * React Query caches; the server state itself always comes from the API.
 */
import { useEffect, useRef, useState } from "react"
import { useQueryClient } from "@tanstack/react-query"

export type LiveEvent = { type: string; incidentId?: string; stepId?: string; actor?: string; [k: string]: unknown }
type Listener = (e: LiveEvent) => void

const listeners = new Set<Listener>()
let source: EventSource | null = null
let status: "connecting" | "live" | "offline" = "connecting"
const statusListeners = new Set<(s: typeof status) => void>()

function setStatus(s: typeof status) {
  status = s
  for (const l of statusListeners) l(s)
}

function ensureSource() {
  if (source || typeof window === "undefined") return
  source = new EventSource("/api/stream")
  source.onopen = () => setStatus("live")
  source.onerror = () => setStatus(source?.readyState === EventSource.OPEN ? "live" : "offline")
  const types = ["hello", "incident.updated", "incident.created", "step.started", "step.updated", "agent.delta", "agent.status", "orchestrator.heartbeat", "health.updated"]
  for (const t of types) {
    source.addEventListener(t, (msg) => {
      try {
        const data = JSON.parse((msg as MessageEvent).data) as LiveEvent
        if (status !== "live") setStatus("live")
        for (const l of listeners) l(data)
      } catch {
        // ignore malformed events
      }
    })
  }
}

export function useLiveEvents(listener: Listener) {
  const ref = useRef(listener)
  ref.current = listener
  useEffect(() => {
    ensureSource()
    const l: Listener = (e) => ref.current(e)
    listeners.add(l)
    return () => {
      listeners.delete(l)
    }
  }, [])
}

export function useLiveStatus() {
  const [s, setS] = useState(status)
  useEffect(() => {
    ensureSource()
    statusListeners.add(setS)
    setS(status)
    return () => {
      statusListeners.delete(setS)
    }
  }, [])
  return s
}

/** Invalidate the given query keys when incidents/steps change (debounced). */
export function useLiveInvalidation(keys: unknown[][], filter?: (e: LiveEvent) => boolean) {
  const qc = useQueryClient()
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null)
  useLiveEvents((e) => {
    if (!["incident.updated", "incident.created", "step.started", "step.updated", "health.updated"].includes(e.type)) return
    if (filter && !filter(e)) return
    if (timer.current) clearTimeout(timer.current)
    timer.current = setTimeout(() => {
      for (const k of keys) void qc.invalidateQueries({ queryKey: k })
    }, 400)
  })
}
