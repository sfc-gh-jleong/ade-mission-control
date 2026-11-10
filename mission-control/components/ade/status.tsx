"use client"

import { AlertTriangle, CheckCircle2, CircleDashed, CircleDot, Clock, Hand, Loader2, ShieldAlert, XCircle } from "lucide-react"
import { cn } from "@/lib/utils"

type Tone = "neutral" | "info" | "active" | "success" | "warning" | "danger" | "muted"

const STATUS: Record<string, { label: string; tone: Tone; spin?: boolean }> = {
  DETECTED: { label: "Detected", tone: "info" },
  QUEUED: { label: "Queued", tone: "info" },
  INVESTIGATING: { label: "Investigating", tone: "active", spin: true },
  FIXING: { label: "Fixing", tone: "active", spin: true },
  REHEARSING: { label: "Rehearsing", tone: "active", spin: true },
  REVIEWING: { label: "Reviewing", tone: "active", spin: true },
  AWAITING_APPROVAL: { label: "Awaiting approval", tone: "warning" },
  APPROVED: { label: "Approved", tone: "warning" },
  APPLYING: { label: "Applying", tone: "active", spin: true },
  VERIFYING: { label: "Verifying", tone: "active", spin: true },
  RESOLVED: { label: "Resolved", tone: "success" },
  NEEDS_HUMAN: { label: "Needs a person", tone: "danger" },
  NO_FIX: { label: "No fix needed", tone: "muted" },
  FAILED: { label: "Failed", tone: "danger" },
  SUPPRESSED: { label: "Dismissed", tone: "muted" },
  SYMPTOM: { label: "Symptom", tone: "muted" },
  // fixes
  PROPOSED: { label: "Proposed", tone: "info" },
  REHEARSED: { label: "Rehearsed", tone: "info" },
  REVIEWED: { label: "Reviewed", tone: "info" },
  APPLIED: { label: "Applied", tone: "success" },
  VERIFIED: { label: "Verified", tone: "success" },
  VERIFY_FAILED: { label: "Failed after apply", tone: "danger" },
  APPLY_FAILED: { label: "Apply failed", tone: "danger" },
  ROLLED_BACK: { label: "Rolled back", tone: "warning" },
  REJECTED: { label: "Rejected", tone: "muted" },
  SUPERSEDED: { label: "Superseded", tone: "muted" },
  // runs / steps
  SUCCEEDED: { label: "Succeeded", tone: "success" },
  RUNNING: { label: "Running", tone: "active", spin: true },
  SKIPPED: { label: "Skipped", tone: "muted" },
  CANCELLED: { label: "Cancelled", tone: "muted" },
  FAILED_AND_AUTO_SUSPENDED: { label: "Failed · suspended", tone: "danger" },
  UPSTREAM_FAILED: { label: "Upstream failed", tone: "warning" },
  // rehearsals
  PASSED: { label: "Passed", tone: "success" },
  INCONCLUSIVE: { label: "Inconclusive", tone: "warning" },
  UNSUPPORTED: { label: "Unsupported", tone: "muted" },
}

const TONE: Record<Tone, string> = {
  neutral: "bg-secondary text-secondary-foreground ring-border",
  info: "bg-info/10 text-info ring-info/25",
  active: "bg-primary/12 text-primary ring-primary/30",
  success: "bg-success/10 text-success ring-success/25",
  warning: "bg-warning/10 text-warning ring-warning/30",
  danger: "bg-danger/10 text-danger ring-danger/30",
  muted: "bg-muted text-muted-foreground ring-border",
}

function IconFor({ tone, spin }: { tone: Tone; spin?: boolean }) {
  const c = "size-3"
  if (spin) return <Loader2 className={cn(c, "animate-spin motion-reduce:animate-none")} aria-hidden />
  switch (tone) {
    case "success":
      return <CheckCircle2 className={c} aria-hidden />
    case "danger":
      return <XCircle className={c} aria-hidden />
    case "warning":
      return <Hand className={c} aria-hidden />
    case "info":
      return <CircleDot className={c} aria-hidden />
    case "muted":
      return <CircleDashed className={c} aria-hidden />
    default:
      return <Clock className={c} aria-hidden />
  }
}

export function StatusPill({ status, className, label }: { status: string; className?: string; label?: string }) {
  const s = STATUS[status] ?? { label: status.replace(/_/g, " ").toLowerCase(), tone: "neutral" as Tone }
  return (
    <span className={cn("inline-flex items-center gap-1 whitespace-nowrap rounded-full px-2 py-0.5 text-[11px] font-medium ring-1 ring-inset", TONE[s.tone], className)}>
      <IconFor tone={s.tone} spin={s.spin} />
      {label ?? s.label}
    </span>
  )
}

const SEVERITY: Record<string, string> = {
  CRITICAL: "bg-danger text-white",
  HIGH: "bg-warning/90 text-black",
  MEDIUM: "bg-info/15 text-info ring-1 ring-inset ring-info/30",
  LOW: "bg-muted text-muted-foreground ring-1 ring-inset ring-border",
}

export function SeverityBadge({ severity, className }: { severity: string; className?: string }) {
  return (
    <span className={cn("inline-flex items-center rounded px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wide", SEVERITY[severity] ?? SEVERITY.MEDIUM, className)}>
      {severity}
    </span>
  )
}

export function SealBadge({ state }: { state: "VALID" | "INVALID" | "UNSEALED" }) {
  if (state === "VALID") return null
  return (
    <span
      className={cn(
        "inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-[11px] font-medium ring-1 ring-inset",
        state === "INVALID" ? "bg-danger/10 text-danger ring-danger/30" : "bg-muted text-muted-foreground ring-border",
      )}
      title={state === "INVALID" ? "This record was changed after the app wrote it. Do not trust it." : "This record has no integrity seal."}
    >
      {state === "INVALID" ? <ShieldAlert className="size-3" /> : <AlertTriangle className="size-3" />}
      {state === "INVALID" ? "Tampered" : "Unsealed"}
    </span>
  )
}

export function jobTypeLabel(t: string) {
  return t === "DYNAMIC_TABLE" ? "Dynamic table" : t === "TASK" ? "Task" : t === "ALERT" ? "Alert" : t === "PIPE" ? "Pipe" : t
}
