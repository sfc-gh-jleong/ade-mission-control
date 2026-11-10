"use client"

import { motion } from "motion/react"
import { Check } from "lucide-react"
import { cn } from "@/lib/utils"
import { PIPELINE_STAGES, stageIndexForStatus, type IncidentStatus } from "@/lib/domain"
import { actorOf } from "@/components/ade/agent"

/** Detect -> Investigate -> Fix -> Rehearse -> Review -> Approve -> Apply -> Verify */
export function PipelineStepper({ status, compact = false, reached }: { status: string; compact?: boolean; reached?: number }) {
  const terminalBad = ["NEEDS_HUMAN", "FAILED"].includes(status)
  const skipped = status === "NO_FIX" || status === "SUPPRESSED"
  // Escalated/closed incidents have no stage of their own: show where they stopped.
  const current = terminalBad || skipped ? (reached ?? 1) : stageIndexForStatus(status as IncidentStatus)
  const done = status === "RESOLVED"
  return (
    <ol className={cn("flex w-full items-center", compact ? "gap-1" : "gap-1.5")} aria-label="Pipeline progress">
      {PIPELINE_STAGES.map((stage, i) => {
        const state = done || i < current || (skipped && i === current) ? "done" : i === current ? (terminalBad ? "blocked" : "current") : "todo"
        const a = actorOf(stage.actor)
        return (
          <li key={stage.key} className="flex min-w-0 flex-1 flex-col gap-1.5">
            <div className="relative h-1.5 overflow-hidden rounded-full bg-muted">
              {state !== "todo" && (
                <motion.div
                  initial={{ width: 0 }}
                  animate={{ width: "100%" }}
                  transition={{ duration: 0.5, delay: i * 0.04 }}
                  className={cn("absolute inset-y-0 left-0 rounded-full", state === "done" ? "bg-success/80" : state === "blocked" ? "bg-danger" : a.dot)}
                />
              )}
              {state === "current" && <div className="shimmer absolute inset-0" />}
            </div>
            {!compact && (
              <span className={cn("flex items-center gap-1 truncate text-[11px]", state === "todo" ? "text-muted-foreground/70" : state === "current" ? cn("font-medium", a.text) : state === "blocked" ? "font-medium text-danger" : "text-muted-foreground")}>
                {state === "done" && <Check className="size-3 text-success" aria-hidden />}
                {stage.label}
              </span>
            )}
          </li>
        )
      })}
    </ol>
  )
}

/** Furthest pipeline stage an incident reached (for escalated/closed incidents). */
export function reachedStage(i: { confidence: number | null; fixIterations?: number; status: string }): number {
  if (i.confidence !== null && i.confidence !== undefined) return 4
  if ((i.fixIterations ?? 0) > 0) return 2
  return 1
}

/** Radial confidence gauge (0-100) with a tick for the approval threshold. */
export function ConfidenceGauge({ value, threshold = 80, size = 112, label = "Confidence", capReason }: { value: number | null; threshold?: number; size?: number; label?: string; capReason?: string | null }) {
  const r = (size - 14) / 2
  const c = 2 * Math.PI * r
  const v = value === null ? 0 : Math.max(0, Math.min(100, value))
  const color = value === null ? "var(--muted-foreground)" : v >= threshold ? "var(--success)" : v >= 60 ? "var(--warning)" : "var(--danger)"
  const tickAngle = (threshold / 100) * 2 * Math.PI - Math.PI / 2
  const tx = size / 2 + Math.cos(tickAngle) * r
  const ty = size / 2 + Math.sin(tickAngle) * r
  return (
    <div className="relative inline-flex flex-col items-center" style={{ width: size }}>
      <svg width={size} height={size} viewBox={`0 0 ${size} ${size}`} role="img" aria-label={`${label} ${value ?? "unknown"}`}>
        <circle cx={size / 2} cy={size / 2} r={r} fill="none" stroke="var(--muted)" strokeWidth={9} />
        <motion.circle
          cx={size / 2}
          cy={size / 2}
          r={r}
          fill="none"
          stroke={color}
          strokeWidth={9}
          strokeLinecap="round"
          strokeDasharray={c}
          initial={{ strokeDashoffset: c }}
          animate={{ strokeDashoffset: c - (v / 100) * c }}
          transition={{ duration: 0.9, ease: "easeOut" }}
          transform={`rotate(-90 ${size / 2} ${size / 2})`}
        />
        <circle cx={tx} cy={ty} r={3} fill="var(--foreground)" opacity={0.6} />
      </svg>
      <div className="absolute inset-0 flex flex-col items-center justify-center" style={{ height: size }}>
        <span className="text-tabular text-2xl font-semibold tracking-tight">{value === null ? "—" : Math.round(v)}</span>
        <span className="text-[10px] uppercase tracking-wider text-muted-foreground">{label}</span>
      </div>
      {capReason && <span className="mt-1 max-w-[12rem] text-center text-[10px] leading-tight text-warning">Capped: {capReason}</span>}
    </div>
  )
}
