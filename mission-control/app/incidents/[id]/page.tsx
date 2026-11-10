"use client"

import Link from "next/link"
import { useParams, useSearchParams } from "next/navigation"
import { Suspense, useState } from "react"
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query"
import { motion } from "motion/react"
import { diffLines } from "diff"
import {
  AlertTriangle, ArrowLeft, BadgeCheck, Ban, CheckCircle2, CircleSlash, Clock, Copy, FileCode2, FlaskConical, GitCompare, Hash, History,
  ListChecks, Loader2, Play, RotateCcw, Search, ShieldCheck, Sparkles, Timer, Undo2, Zap,
} from "lucide-react"
import { api, ago, clock, compactTokens, credits, duration } from "@/lib/client"
import { useLiveInvalidation } from "@/lib/live"
import { copyText } from "@/lib/clipboard"
import { cn } from "@/lib/utils"
import { formatIncidentNumber } from "@/lib/domain"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { Button } from "@/components/ui/button"
import { Skeleton } from "@/components/ui/skeleton"
import { EmptyState } from "@/components/empty-state"
import { AgentAvatar, AgentChip } from "@/components/ade/agent"
import { SealBadge, SeverityBadge, StatusPill, jobTypeLabel } from "@/components/ade/status"
import { ConfidenceGauge, PipelineStepper, reachedStage } from "@/components/ade/pipeline"
import { CodeBlock } from "@/components/ade/code"
import { AgentTrace, type Step } from "@/components/ade/trace"

type Detail = any

const TABS = [
  { key: "overview", label: "Overview", icon: Sparkles },
  { key: "trace", label: "Agent trace", icon: ListChecks },
  { key: "fix", label: "Fix & review", icon: FileCode2 },
  { key: "rehearsal", label: "Rehearsal", icon: FlaskConical },
  { key: "history", label: "Runs & audit", icon: History },
]

function Section({ title, icon: Icon, children, actions, className }: { title: string; icon?: typeof Sparkles; children: React.ReactNode; actions?: React.ReactNode; className?: string }) {
  return (
    <Card className={className}>
      <CardHeader className="flex flex-row items-center justify-between gap-3 pb-2">
        <CardTitle className="flex items-center gap-2">
          {Icon && <Icon className="size-4 text-primary" />} {title}
        </CardTitle>
        {actions}
      </CardHeader>
      <CardContent>{children}</CardContent>
    </Card>
  )
}

function Rubric({ rubric }: { rubric: Record<string, number> | null }) {
  if (!rubric) return null
  const labels: Record<string, string> = {
    root_cause_addressed: "Root cause addressed",
    correctness: "Correctness",
    safety: "Safety",
    minimality: "Minimality",
    rollback_quality: "Rollback quality",
    verification: "Verification",
  }
  return (
    <div className="space-y-1.5">
      {Object.entries(labels).map(([k, l]) => {
        const v = Number(rubric[k] ?? 0)
        return (
          <div key={k} className="flex items-center gap-3 text-xs">
            <span className="w-36 shrink-0 text-muted-foreground">{l}</span>
            <div className="flex flex-1 gap-1">
              {[1, 2, 3, 4, 5].map((i) => (
                <motion.span key={i} initial={{ scaleX: 0 }} animate={{ scaleX: 1 }} transition={{ delay: i * 0.04 }} className={cn("h-1.5 flex-1 origin-left rounded-full", i <= v ? (v >= 4 ? "bg-success" : v >= 3 ? "bg-warning" : "bg-danger") : "bg-muted")} />
              ))}
            </div>
            <span className="text-tabular w-6 text-right font-medium">{v || "—"}</span>
          </div>
        )
      })}
    </div>
  )
}

function DiffView({ before, after }: { before: string; after: string }) {
  const parts = diffLines(before, after)
  return (
    <div className="scrollbar-thin max-h-[420px] overflow-auto rounded-lg border bg-surface-2 font-mono text-[12px] leading-relaxed">
      {parts.map((p, i) => (
        <div key={i} className={cn("whitespace-pre-wrap px-3", p.added ? "bg-success/10 text-success" : p.removed ? "bg-danger/10 text-danger line-through decoration-danger/40" : "text-muted-foreground")}>
          {p.value.split("\n").filter((l, j, arr) => l || j < arr.length - 1).map((l, j) => (
            <div key={j}>
              <span className="mr-2 select-none opacity-60">{p.added ? "+" : p.removed ? "−" : " "}</span>
              {l}
            </div>
          ))}
        </div>
      ))}
    </div>
  )
}

function ApprovalPanel({ data, me, onAction, pending }: { data: Detail; me: { user: string; approver: boolean } | undefined; onAction: (body: Record<string, unknown>) => void; pending: string | null }) {
  const incident = data.incident
  const fix = data.fixes.find((f: Detail) => f.id === incident.currentFixId) ?? data.fixes[0]
  const review = fix ? data.reviews.find((r: Detail) => r.fixId === fix.id) : null
  const [note, setNote] = useState("")
  const [runAfter, setRunAfter] = useState(true)
  if (!fix) return null
  const canApprove = me?.approver && incident.status === "AWAITING_APPROVAL" && fix.status === "AWAITING_APPROVAL" && fix.seal !== "INVALID" && review?.seal !== "INVALID"
  const canApply = me?.approver && fix.status === "APPROVED" && fix.guardDecision?.decision === "APPROVED"
  const canRollback = me?.approver && ["APPLIED", "VERIFIED", "VERIFY_FAILED", "APPLY_FAILED"].includes(fix.status)
  return (
    <Card className="border-warning/40 bg-warning/[0.03]">
      <CardContent className="space-y-3 p-4">
        <div className="flex items-start gap-3">
          <ShieldCheck className="mt-0.5 size-5 text-warning" />
          <div className="min-w-0 flex-1">
            <div className="text-sm font-semibold">Human approval gate</div>
            <p className="text-xs text-muted-foreground">
              Production changes run only through <span className="font-mono">ADE_DB.GUARD</span> as you ({me?.user ?? "unknown"}), pinned to fix hash{" "}
              <span className="font-mono">{String(fix.fixHash).slice(0, 12)}…</span>. The agents cannot call it.
            </p>
          </div>
          <StatusPill status={fix.status} />
        </div>
        {!me?.approver && <div className="rounded-md bg-muted px-3 py-2 text-xs text-muted-foreground">You are not on the approver list (ADE_DB.GUARD.APPROVERS).</div>}
        {(fix.seal === "INVALID" || review?.seal === "INVALID") && (
          <div className="flex items-center gap-2 rounded-md bg-danger/10 px-3 py-2 text-xs text-danger">
            <AlertTriangle className="size-4" /> This fix or its review was modified after the app wrote it. Approval is disabled.
          </div>
        )}
        {(canApprove || incident.status === "AWAITING_APPROVAL") && (
          <textarea
            value={note}
            onChange={(e) => setNote(e.target.value)}
            placeholder="Optional note for the audit log"
            className="h-16 w-full resize-none rounded-lg border bg-card px-3 py-2 text-sm outline-none ring-primary/40 focus:ring-2"
          />
        )}
        <div className="flex flex-wrap items-center gap-2">
          {incident.status === "AWAITING_APPROVAL" && (
            <>
              <Button disabled={!canApprove || pending !== null} onClick={() => onAction({ action: "approve", fixId: fix.id, fixHash: fix.fixHash, note })} className="bg-success text-white hover:bg-success/90">
                {pending === "approve" ? <Loader2 className="size-4 animate-spin" /> : <BadgeCheck className="size-4" />} Approve fix v{fix.version}
              </Button>
              <Button variant="outline" disabled={!me?.approver || pending !== null} onClick={() => onAction({ action: "reject", fixId: fix.id, note })}>
                {pending === "reject" ? <Loader2 className="size-4 animate-spin" /> : <Ban className="size-4" />} Reject
              </Button>
            </>
          )}
          {fix.status === "APPROVED" && (
            <>
              <Button disabled={!canApply || pending !== null} onClick={() => onAction({ action: "apply", fixId: fix.id, fixHash: fix.fixHash, runAfter })} className="bg-primary text-primary-foreground hover:bg-primary/90">
                {pending === "apply" ? <Loader2 className="size-4 animate-spin" /> : <Zap className="size-4" />} Apply to production
              </Button>
              <label className="flex items-center gap-1.5 text-xs text-muted-foreground">
                <input type="checkbox" checked={runAfter} onChange={(e) => setRunAfter(e.target.checked)} /> Run the job right after
              </label>
            </>
          )}
          {canRollback && (
            <Button variant="outline" disabled={pending !== null} onClick={() => onAction({ action: "rollback", fixId: fix.id, note })}>
              {pending === "rollback" ? <Loader2 className="size-4 animate-spin" /> : <Undo2 className="size-4" />} Roll back
            </Button>
          )}
          {me?.approver && ["VERIFYING", "NEEDS_HUMAN", "RESOLVED"].includes(incident.status) && (
            <Button variant="ghost" size="sm" disabled={pending !== null} onClick={() => onAction({ action: "run_job" })}>
              {pending === "run_job" ? <Loader2 className="size-4 animate-spin" /> : <Play className="size-4" />} Run job now
            </Button>
          )}
        </div>
      </CardContent>
    </Card>
  )
}

function IncidentInner() {
  const { id } = useParams<{ id: string }>()
  const search = useSearchParams()
  const focusStep = search.get("step")
  const [tab, setTab] = useState(focusStep ? "trace" : "overview")
  const qc = useQueryClient()
  const detail = useQuery({ queryKey: ["incident", id], queryFn: () => api<Detail>(`/api/incidents/${id}`), refetchInterval: 20_000 })
  const incidentId = detail.data?.incident?.id as string | undefined
  const steps = useQuery({
    queryKey: ["steps", incidentId],
    queryFn: () => api<{ steps: Step[] }>(`/api/incidents/${incidentId}/steps`),
    enabled: Boolean(incidentId),
    refetchInterval: 15_000,
  })
  const me = useQuery({ queryKey: ["me"], queryFn: () => api<{ user: string; approver: boolean }>("/api/me"), staleTime: 300_000 })
  useLiveInvalidation([["incident", id], ["steps", incidentId]], (e) => !incidentId || e.incidentId === incidentId)
  const [actionError, setActionError] = useState<string | null>(null)
  const [pending, setPending] = useState<string | null>(null)
  const action = useMutation({
    mutationFn: (body: Record<string, unknown>) => api(`/api/incidents/${incidentId}/actions`, { method: "POST", json: body }),
    onMutate: (body) => {
      setPending(String(body.action))
      setActionError(null)
    },
    onError: (e) => setActionError((e as Error).message),
    onSettled: () => {
      setPending(null)
      void qc.invalidateQueries({ queryKey: ["incident", id] })
      void qc.invalidateQueries({ queryKey: ["steps", incidentId] })
      void qc.invalidateQueries({ queryKey: ["overview"] })
    },
  })

  if (detail.isPending) {
    return (
      <main className="mx-auto max-w-[1400px] space-y-4 px-4 py-6 sm:px-6 lg:px-8">
        <Skeleton className="h-28" />
        <Skeleton className="h-96" />
      </main>
    )
  }
  if (detail.error || !detail.data) {
    return (
      <main className="mx-auto max-w-[1400px] px-4 py-6">
        <EmptyState variant="error" title="Incident not available" description={(detail.error as Error)?.message ?? "Not found"} />
      </main>
    )
  }
  const d = detail.data
  const i = d.incident
  const diag = d.diagnosis
  const currentFix = d.fixes.find((f: Detail) => f.id === i.currentFixId) ?? d.fixes[0]
  const currentReview = currentFix ? d.reviews.find((r: Detail) => r.fixId === currentFix.id) : null
  const stepList = steps.data?.steps ?? []
  const turns = stepList.filter((s) => s.kind === "TURN")
  const totals = {
    turns: turns.length,
    tools: stepList.filter((s) => s.kind === "TOOL_CALL").length,
    ms: turns.reduce((a, s) => a + s.durationMs, 0) + stepList.filter((s) => s.kind === "SYSTEM").reduce((a, s) => a + s.durationMs, 0),
    tokens: turns.reduce((a, s) => a + s.inputTokens + s.outputTokens, 0),
  }
  const runningActor = stepList.find((s) => s.status === "RUNNING" && s.kind === "TURN")?.actor

  return (
    <main className="mx-auto w-full max-w-[1400px] space-y-5 px-4 py-6 sm:px-6 lg:px-8">
      <Link href="/incidents" className="inline-flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground">
        <ArrowLeft className="size-3.5" /> Incidents
      </Link>

      <Card className="overflow-hidden">
        <CardContent className="space-y-4 p-5">
          <div className="flex flex-wrap items-start gap-4">
            <div className="min-w-0 flex-1">
              <div className="flex flex-wrap items-center gap-2">
                <span className="font-mono text-sm text-muted-foreground">{formatIncidentNumber(i.number)}</span>
                <SeverityBadge severity={i.severity} />
                {i.category && <span className="rounded bg-muted px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-muted-foreground">{i.category.replace(/_/g, " ")}</span>}
                <StatusPill status={i.status} />
                {i.isBackfill && <span className="rounded bg-muted px-1.5 py-0.5 text-[10px] text-muted-foreground">from history</span>}
              </div>
              <h1 className="mt-2 text-xl font-semibold leading-snug tracking-tight">{i.summary ?? i.title}</h1>
              <div className="mt-1.5 flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-muted-foreground">
                <span className="font-mono">{i.jobFqn}</span>
                <span>{jobTypeLabel(i.jobType)}</span>
                <span>×{i.occurrences} occurrences</span>
                <span>first seen {ago(i.firstSeenAt)}</span>
                <span>last seen {ago(i.lastSeenAt)}</span>
              </div>
              {i.statusDetail && (
                <div className="mt-2 flex items-center gap-2 text-sm">
                  {runningActor && <AgentAvatar actor={runningActor} size="sm" pulse />}
                  <span className="text-muted-foreground">{i.statusDetail}</span>
                </div>
              )}
            </div>
            <div className="flex items-center gap-5">
              <div className="grid grid-cols-2 gap-x-6 gap-y-2 text-xs">
                <Stat icon={Timer} label="Agent time" value={duration(totals.ms)} />
                <Stat icon={Hash} label="Tokens" value={compactTokens(totals.tokens)} />
                <Stat icon={Sparkles} label="Agent turns" value={String(totals.turns)} />
                <Stat icon={Search} label="Tool calls" value={String(totals.tools)} />
              </div>
              <ConfidenceGauge value={i.confidence} capReason={currentReview?.capReason} />
            </div>
          </div>
          <PipelineStepper status={i.status} reached={reachedStage(i)} />
          <div className="flex flex-wrap items-center gap-2">
            {(i.status === "DETECTED" || i.status === "NEEDS_HUMAN" || i.status === "NO_FIX") && (
              <Button size="sm" disabled={pending !== null} onClick={() => action.mutate({ action: "queue" })}>
                {pending === "queue" ? <Loader2 className="size-3.5 animate-spin" /> : <Play className="size-3.5" />}
                {i.status === "DETECTED" ? "Send to the agents" : "Retry with the agents"}
              </Button>
            )}
            {!["RESOLVED", "SUPPRESSED", "APPLYING", "VERIFYING"].includes(i.status) && (
              <Button size="sm" variant="ghost" disabled={pending !== null} onClick={() => action.mutate({ action: "dismiss", note: "Dismissed from Mission Control" })}>
                <CircleSlash className="size-3.5" /> Dismiss
              </Button>
            )}
          </div>
          {actionError && <div className="rounded-md bg-danger/10 px-3 py-2 text-sm text-danger">{actionError}</div>}
        </CardContent>
      </Card>

      {currentFix && ["AWAITING_APPROVAL", "APPROVED", "APPLYING", "VERIFYING", "RESOLVED", "NEEDS_HUMAN"].includes(i.status) && ["AWAITING_APPROVAL", "APPROVED", "APPLIED", "VERIFIED", "VERIFY_FAILED", "APPLY_FAILED"].includes(currentFix.status) && (
        <ApprovalPanel data={d} me={me.data} pending={pending} onAction={(body) => action.mutate(body)} />
      )}

      <div className="flex flex-wrap gap-1 rounded-lg border bg-card/60 p-1">
        {TABS.map((t) => (
          <button
            key={t.key}
            type="button"
            onClick={() => setTab(t.key)}
            className={cn("flex items-center gap-1.5 rounded-md px-3 py-1.5 text-xs font-medium transition-colors", tab === t.key ? "bg-accent text-foreground" : "text-muted-foreground hover:text-foreground")}
          >
            <t.icon className="size-3.5" /> {t.label}
            {t.key === "trace" && stepList.length > 0 && <span className="rounded bg-muted px-1 text-[10px]">{stepList.length}</span>}
          </button>
        ))}
      </div>

      {tab === "overview" && (
        <div className="grid gap-4 xl:grid-cols-3">
          <div className="space-y-4 xl:col-span-2">
            <Section title="Diagnosis" icon={Search} actions={diag ? <AgentChip actor="INVESTIGATOR" /> : null}>
              {!diag ? (
                <div className="text-sm text-muted-foreground">{["INVESTIGATING", "QUEUED"].includes(i.status) ? "The Investigator is working on it…" : "No diagnosis yet."}</div>
              ) : (
                <div className="space-y-4">
                  <p className="text-sm leading-relaxed">{diag.root_cause}</p>
                  <div className="flex flex-wrap gap-2 text-xs">
                    <span className="rounded-md bg-muted px-2 py-1">Fixability <b className="font-semibold">{String(diag.fixability ?? "").replace(/_/g, " ")}</b></span>
                    <span className="rounded-md bg-muted px-2 py-1">Investigator confidence <b className="font-semibold">{diag.confidence}</b></span>
                    {diag.is_transient && <span className="rounded-md bg-info/10 px-2 py-1 text-info">Transient</span>}
                  </div>
                  <div>
                    <div className="mb-2 text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">Evidence</div>
                    <ol className="space-y-1.5">
                      {(diag.evidence ?? []).map((e: string, idx: number) => (
                        <li key={idx} className="flex gap-2 text-[13px] leading-relaxed">
                          <span className="text-tabular mt-0.5 flex size-5 shrink-0 items-center justify-center rounded bg-investigator/12 text-[10px] font-semibold text-investigator">{idx + 1}</span>
                          <span className="text-foreground/90">{e}</span>
                        </li>
                      ))}
                    </ol>
                  </div>
                  {diag.recommendation && (
                    <div className="rounded-lg border-l-2 border-investigator bg-investigator/5 px-3 py-2 text-[13px]">
                      <span className="font-medium">Recommendation: </span>
                      {diag.recommendation}
                    </div>
                  )}
                </div>
              )}
            </Section>
            <Section title="Failure" icon={AlertTriangle}>
              <CodeBlock lang="text" code={i.errorMessage ?? i.title} maxHeight={200} />
              <div className="mt-2 flex flex-wrap gap-x-4 gap-y-1 font-mono text-[11px] text-muted-foreground">
                {i.errorCode && <span>error {i.errorCode}</span>}
                {i.lastQueryId && <span>query {i.lastQueryId}</span>}
              </div>
            </Section>
          </div>
          <div className="space-y-4">
            <Section title="Job" icon={Clock}>
              {d.job ? (
                <dl className="space-y-2 text-xs">
                  <Row label="Type" value={jobTypeLabel(d.job.type)} />
                  <Row label="Owner" value={d.job.owner} mono />
                  <Row label="Warehouse" value={d.job.warehouse} mono />
                  <Row label="Schedule" value={d.job.schedule} mono />
                  <Row label="State" value={d.job.state} />
                  <Row label="Last success" value={ago(d.job.lastSuccessAt)} />
                  <Row label="24 h runs / failures" value={`${d.job.runs24h} / ${d.job.failures24h}`} />
                  {d.job.predecessors?.length > 0 && <Row label="After" value={d.job.predecessors.join(", ")} mono />}
                </dl>
              ) : (
                <div className="text-xs text-muted-foreground">Job not in inventory.</div>
              )}
            </Section>
            {d.symptoms.length > 0 && (
              <Section title="Downstream symptoms" icon={GitCompare}>
                <ul className="space-y-1.5 text-xs">
                  {d.symptoms.map((s: Detail) => (
                    <li key={s.id}>
                      <Link href={`/incidents/${s.number}`} className="flex items-center justify-between gap-2 hover:text-primary">
                        <span className="truncate font-mono">{s.jobFqn}</span>
                        <StatusPill status={s.status} />
                      </Link>
                    </li>
                  ))}
                </ul>
              </Section>
            )}
            <Section title="Agents on this incident" icon={Sparkles}>
              <ul className="space-y-2.5">
                {d.agentRuns.length === 0 && <li className="text-xs text-muted-foreground">No agent runs yet.</li>}
                {d.agentRuns.map((r: Detail) => (
                  <li key={r.id} className="flex items-center gap-2.5">
                    <AgentAvatar actor={r.role} size="sm" pulse={r.status === "RUNNING"} />
                    <div className="min-w-0 flex-1">
                      <div className="truncate text-xs font-medium">
                        {String(r.role).charAt(0) + String(r.role).slice(1).toLowerCase()} {r.iteration > 1 ? `· v${r.iteration}` : ""}
                      </div>
                      <div className="truncate font-mono text-[10px] text-muted-foreground">{r.model ?? "—"}{r.effort ? ` · ${r.effort}` : ""}</div>
                    </div>
                    <div className="text-tabular text-right text-[10px] text-muted-foreground">
                      <div>{duration(r.durationMs)} · {r.toolCalls} tools</div>
                      <div>{compactTokens(r.inputTokens + r.outputTokens)} tok{r.credits !== null ? ` · ${credits(r.credits)} cr` : ""}</div>
                    </div>
                  </li>
                ))}
              </ul>
            </Section>
          </div>
        </div>
      )}

      {tab === "trace" && (
        <Section title="Agent trace" icon={ListChecks} actions={<span className="text-xs text-muted-foreground">Every turn, tool call and system step with time, tokens and model</span>}>
          {steps.isPending ? <Skeleton className="h-64" /> : <AgentTrace steps={stepList} focusStepId={focusStep} />}
        </Section>
      )}

      {tab === "fix" && (
        <div className="space-y-4">
          {d.fixes.length === 0 ? (
            <EmptyState title="No fix proposed yet" description={i.status === "FIXING" ? "The Fixer is writing one now." : "Fixes appear here once the Fixer submits one."} />
          ) : (
            d.fixes.map((f: Detail) => {
              const review = d.reviews.find((r: Detail) => r.fixId === f.id)
              const rehearsal = d.rehearsals.find((r: Detail) => r.fixId === f.id)
              const snapshot = Array.isArray(f.snapshot) ? f.snapshot : []
              return (
                <Card key={f.id} className={cn(f.id !== currentFix?.id && "opacity-75")}>
                  <CardHeader className="flex flex-row flex-wrap items-center justify-between gap-2 pb-2">
                    <CardTitle className="flex flex-wrap items-center gap-2">
                      <span className="font-mono text-xs text-muted-foreground">v{f.version}</span>
                      {f.title}
                      <StatusPill status={f.status} />
                      <SealBadge state={f.seal} />
                    </CardTitle>
                    <div className="flex items-center gap-2 text-xs text-muted-foreground">
                      <AgentChip actor="FIXER" />
                      <span>{String(f.strategy ?? "").replace(/_/g, " ").toLowerCase()} · risk {String(f.risk ?? "").toLowerCase()}</span>
                    </div>
                  </CardHeader>
                  <CardContent className="space-y-4">
                    <p className="text-sm text-foreground/90">{f.summary}</p>
                    <div className="grid gap-4 lg:grid-cols-2">
                      <div className="space-y-2">
                        <div className="text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">Statements ({"{{DB}}"} = {i.database})</div>
                        {f.statements.map((s: string, idx: number) => (
                          <CodeBlock key={idx} code={s} title={`${idx + 1}`} maxHeight={320} />
                        ))}
                      </div>
                      <div className="space-y-2">
                        <div className="text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">Rollback</div>
                        {f.rollback.length ? f.rollback.map((s: string, idx: number) => <CodeBlock key={idx} code={s} title={`${idx + 1}`} maxHeight={220} />) : <div className="text-xs text-muted-foreground">No rollback statements.</div>}
                        {f.assumptions?.length > 0 && (
                          <div>
                            <div className="mb-1 mt-3 text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">Assumptions</div>
                            <ul className="list-disc space-y-1 pl-4 text-xs text-muted-foreground">{f.assumptions.map((a: string, idx: number) => <li key={idx}>{a}</li>)}</ul>
                          </div>
                        )}
                        {f.verificationPlan && <div className="mt-2 rounded-md bg-muted/60 px-3 py-2 text-xs"><b>Verification:</b> {f.verificationPlan}</div>}
                      </div>
                    </div>
                    {snapshot.some((s: Detail) => s.ddl) && (
                      <div className="space-y-2">
                        <div className="text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">Production change (definition before → statements applied)</div>
                        {snapshot.filter((s: Detail) => s.ddl).map((s: Detail, idx: number) => (
                          <DiffView key={idx} before={String(s.ddl)} after={(f.appliedStatements ?? []).map((a: Detail) => a.sql).join(";\n")} />
                        ))}
                      </div>
                    )}
                    {review && (
                      <div className="grid gap-4 rounded-xl border bg-reviewer/[0.03] p-4 lg:grid-cols-[auto_1fr_1fr]">
                        <ConfidenceGauge value={review.confidence} capReason={review.capReason} size={104} />
                        <div className="space-y-2">
                          <div className="flex items-center gap-2">
                            <AgentChip actor="REVIEWER" />
                            <StatusPill status={review.verdict === "APPROVE" ? "PASSED" : review.verdict === "REJECT" ? "FAILED" : "INCONCLUSIVE"} label={review.verdict} />
                            <SealBadge state={review.seal} />
                            {review.rawConfidence !== review.confidence && <span className="text-[11px] text-muted-foreground">raw {review.rawConfidence}</span>}
                          </div>
                          <p className="text-[13px] leading-relaxed">{review.summary}</p>
                          {rehearsal && <div className="text-xs text-muted-foreground">Rehearsal: <StatusPill status={rehearsal.outcome} /></div>}
                        </div>
                        <div className="space-y-3">
                          <Rubric rubric={review.rubric} />
                          {review.concerns.length > 0 && (
                            <div>
                              <div className="mb-1 text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">Concerns</div>
                              <ul className="list-disc space-y-1 pl-4 text-xs text-foreground/85">{review.concerns.map((c: string, idx: number) => <li key={idx}>{c}</li>)}</ul>
                            </div>
                          )}
                          {review.requiredChanges.length > 0 && (
                            <div>
                              <div className="mb-1 text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">Required changes</div>
                              <ul className="list-disc space-y-1 pl-4 text-xs text-foreground/85">{review.requiredChanges.map((c: string, idx: number) => <li key={idx}>{c}</li>)}</ul>
                            </div>
                          )}
                        </div>
                      </div>
                    )}
                    <div className="flex flex-wrap items-center gap-x-4 gap-y-1 border-t pt-2 font-mono text-[10px] text-muted-foreground">
                      <button type="button" className="inline-flex items-center gap-1 hover:text-foreground" onClick={() => copyText(String(f.fixHash))}>
                        <Copy className="size-3" /> hash {String(f.fixHash).slice(0, 16)}…
                      </button>
                      <span>created {clock(f.createdAt)}</span>
                      {f.approvedBy && <span>approved by {f.approvedBy} {ago(f.approvedAt)}</span>}
                      {f.appliedBy && <span>applied by {f.appliedBy} {ago(f.appliedAt)}</span>}
                      {f.applyError && <span className="text-danger">apply error: {f.applyError}</span>}
                    </div>
                  </CardContent>
                </Card>
              )
            })
          )}
        </div>
      )}

      {tab === "rehearsal" && (
        <div className="space-y-4">
          {d.rehearsals.length === 0 ? (
            <EmptyState title="No rehearsal yet" description="Each fix is rehearsed in a zero-copy sandbox clone before review." />
          ) : (
            d.rehearsals.map((r: Detail) => {
              const log = (r.log?.steps ?? []) as Detail[]
              const fix = d.fixes.find((f: Detail) => f.id === r.fixId)
              return (
                <Section key={r.id} title={`Rehearsal of fix v${fix?.version ?? "?"}`} icon={FlaskConical} actions={<StatusPill status={r.outcome} />}>
                  <div className="mb-3 flex flex-wrap gap-x-4 gap-y-1 text-xs text-muted-foreground">
                    <span>{r.reason}</span>
                    <span className="font-mono">sandbox {r.sandbox}</span>
                    <span>{duration(r.durationMs)}</span>
                    {r.log?.reproduced !== undefined && <span>failure reproduced: {String(r.log.reproduced)}</span>}
                  </div>
                  <ol className="space-y-2">
                    {log.map((s, idx) => (
                      <li key={idx} className="grid grid-cols-[6rem_1fr_auto] items-start gap-3">
                        <span className={cn("rounded px-1.5 py-0.5 text-center text-[10px] font-semibold uppercase tracking-wider", s.step === "REPRODUCE" ? "bg-warning/15 text-warning" : s.step === "VERIFY" ? "bg-success/15 text-success" : s.step === "APPLY" ? "bg-fixer/15 text-fixer" : "bg-muted text-muted-foreground")}>{s.step}</span>
                        <div className="min-w-0 space-y-1">
                          <div className="truncate font-mono text-[11.5px] text-foreground/85" title={s.sql}>{s.sql}</div>
                          {(s.error || s.result) && <div className={cn("text-[11px]", s.ok ? "text-muted-foreground" : "text-danger")}>{s.ok ? s.result : s.error}</div>}
                        </div>
                        <span className="flex items-center gap-1.5 text-[11px] text-muted-foreground">
                          {duration(s.ms)} {s.ok ? <CheckCircle2 className="size-3.5 text-success" /> : <RotateCcw className="size-3.5 text-danger" />}
                        </span>
                      </li>
                    ))}
                  </ol>
                </Section>
              )
            })
          )}
        </div>
      )}

      {tab === "history" && (
        <div className="grid gap-4 xl:grid-cols-2">
          <Section title="Job runs" icon={History}>
            <ul className="divide-y text-xs">
              {d.runs.map((r: Detail, idx: number) => (
                <li key={idx} className="flex items-center gap-3 py-2">
                  <StatusPill status={r.state} />
                  <span className="text-muted-foreground">{clock(r.scheduledAt)}</span>
                  <span className="min-w-0 flex-1 truncate text-muted-foreground" title={r.errorMessage}>{r.errorMessage}</span>
                  <span className="text-tabular text-muted-foreground">{duration(r.durationMs)}</span>
                </li>
              ))}
            </ul>
          </Section>
          <Section title="Audit trail" icon={ShieldCheck}>
            <ul className="space-y-2 text-xs">
              {[...d.decisions.map((x: Detail) => ({ actor: x.by, action: `GUARD · ${x.decision}`, at: x.at, detail: x.comment })), ...d.audit.map((x: Detail) => ({ actor: x.actor, action: x.action, at: x.at, detail: typeof x.detail === "object" ? JSON.stringify(x.detail) : x.detail }))]
                .sort((a, b) => String(b.at).localeCompare(String(a.at)))
                .map((x, idx) => (
                  <li key={idx} className="grid grid-cols-[7.5rem_1fr] gap-3">
                    <span className="text-muted-foreground">{clock(x.at)}</span>
                    <div className="min-w-0">
                      <span className={cn("font-medium", String(x.action).startsWith("GUARD") && "text-human")}>{x.action}</span> <span className="text-muted-foreground">by {x.actor}</span>
                      {x.detail && <div className="truncate font-mono text-[10.5px] text-muted-foreground" title={String(x.detail)}>{String(x.detail)}</div>}
                    </div>
                  </li>
                ))}
            </ul>
          </Section>
        </div>
      )}
    </main>
  )
}

function Stat({ icon: Icon, label, value }: { icon: typeof Timer; label: string; value: string }) {
  return (
    <div>
      <div className="flex items-center gap-1 text-[10px] uppercase tracking-wider text-muted-foreground">
        <Icon className="size-3" /> {label}
      </div>
      <div className="text-tabular text-base font-semibold">{value}</div>
    </div>
  )
}

function Row({ label, value, mono }: { label: string; value: unknown; mono?: boolean }) {
  return (
    <div className="flex justify-between gap-3">
      <dt className="text-muted-foreground">{label}</dt>
      <dd className={cn("truncate text-right", mono && "font-mono")}>{value === null || value === undefined || value === "" ? "—" : String(value)}</dd>
    </div>
  )
}

export default function IncidentPage() {
  return (
    <Suspense fallback={<div className="p-8"><Skeleton className="h-96" /></div>}>
      <IncidentInner />
    </Suspense>
  )
}
