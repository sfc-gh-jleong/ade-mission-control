"use client"

import Link from "next/link"
import { useQuery } from "@tanstack/react-query"
import { motion } from "motion/react"
import { Area, AreaChart, ResponsiveContainer, Tooltip, XAxis, YAxis } from "recharts"
import { AlertOctagon, ArrowRight, CheckCircle2, Clock3, Hand, Radar, RefreshCw, Sparkles, Timer, Zap } from "lucide-react"
import { api, ago, compactTokens, duration } from "@/lib/client"
import { useLiveEvents, useLiveInvalidation } from "@/lib/live"
import { cn } from "@/lib/utils"
import { formatIncidentNumber } from "@/lib/domain"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { Button } from "@/components/ui/button"
import { Skeleton } from "@/components/ui/skeleton"
import { EmptyState } from "@/components/empty-state"
import { AgentAvatar, ACTORS } from "@/components/ade/agent"
import { SeverityBadge, StatusPill } from "@/components/ade/status"
import { PipelineStepper } from "@/components/ade/pipeline"
import { useState } from "react"

interface OverviewData {
  counts: { open: number; active: number; awaiting: number; needsHuman: number; backlog: number; resolved7d: number; new24h: number; mttrSeconds: number | null }
  recent: { stepId: string; incidentId: string; incidentNumber: number; actor: string; kind: string; task: string; status: string; startedAt: string; durationMs: number; model: string | null; tokens: number }[]
  agents: { role: string; runs: number; running: number; ok: number; tokens: number; p50Ms: number; toolCalls: number; model: string; lastAt: string | null; credits: number | null }[]
  scopes: { id: string; database: string; enabled: boolean; lastScanAt: string | null; lastScanStatus: string | null; lastScanMs: number }[]
  detector: { state: string; scheduledAt: string | null; completedAt: string | null } | null
  activity: { hour: string; turns: number; tokens: number }[]
  orchestrator: { enabled: boolean; running: number; maxInFlight: number; lastTickAt: string | null } | null
}

interface IncidentItem {
  id: string
  number: number
  title: string
  summary: string | null
  status: string
  statusDetail: string | null
  severity: string
  jobFqn: string
  jobType: string
  confidence: number | null
  updatedAt: string | null
  lastSeenAt: string | null
  occurrences: number
  totalTokens: number
}

function Kpi({ label, value, hint, icon: Icon, tone, href }: { label: string; value: string | number; hint?: string; icon: typeof Zap; tone?: string; href?: string }) {
  const body = (
    <Card className="group relative h-full overflow-hidden transition-colors hover:border-primary/40">
      <CardContent className="flex items-start justify-between gap-3 p-4">
        <div className="min-w-0">
          <div className="text-[11px] font-medium uppercase tracking-wider text-muted-foreground">{label}</div>
          <div className={cn("text-tabular mt-1.5 text-3xl font-semibold tracking-tight", tone)}>{value}</div>
          {hint && <div className="mt-1 line-clamp-2 text-xs text-muted-foreground">{hint}</div>}
        </div>
        <div className={cn("rounded-lg bg-muted p-2", tone)}>
          <Icon className="size-4" aria-hidden />
        </div>
      </CardContent>
    </Card>
  )
  return href ? <Link href={href} className="block min-w-0">{body}</Link> : body
}

function LiveTicker() {
  const [lines, setLines] = useState<{ id: string; actor: string; text: string; at: number }[]>([])
  useLiveEvents((e) => {
    if (e.type !== "agent.status" && e.type !== "step.started") return
    const text = e.type === "step.started" ? String(e.task ?? "") : `${String(e.status ?? "").replace(/_/g, " ")}${e.message ? ` — ${e.message}` : ""}`
    if (!text) return
    setLines((prev) => [{ id: `${Date.now()}-${Math.random()}`, actor: String(e.actor ?? "SYSTEM"), text, at: Date.now() }, ...prev].slice(0, 6))
  })
  if (!lines.length) {
    return <div className="flex h-full items-center justify-center text-xs text-muted-foreground">Agent activity appears here in real time.</div>
  }
  return (
    <ul className="space-y-1.5">
      {lines.map((l) => {
        const a = ACTORS[l.actor] ?? ACTORS.SYSTEM
        return (
          <motion.li key={l.id} initial={{ opacity: 0, y: -4 }} animate={{ opacity: 1, y: 0 }} className="flex items-center gap-2 text-xs">
            <span className={cn("size-1.5 shrink-0 rounded-full", a.dot)} />
            <span className={cn("w-20 shrink-0 font-medium", a.text)}>{a.label}</span>
            <span className="truncate text-muted-foreground">{l.text}</span>
          </motion.li>
        )
      })}
    </ul>
  )
}

export default function CommandCenter() {
  const overview = useQuery({ queryKey: ["overview"], queryFn: () => api<OverviewData>("/api/overview"), refetchInterval: 30_000 })
  const attention = useQuery({ queryKey: ["incidents", "attention"], queryFn: () => api<{ incidents: IncidentItem[] }>("/api/incidents?view=attention") })
  const active = useQuery({ queryKey: ["incidents", "active"], queryFn: () => api<{ incidents: IncidentItem[] }>("/api/incidents?view=active"), refetchInterval: 20_000 })
  useLiveInvalidation([["overview"], ["incidents"]])
  const [scanning, setScanning] = useState(false)
  const d = overview.data

  return (
    <main className="mx-auto w-full max-w-[1400px] space-y-6 px-4 py-6 sm:px-6 lg:px-8">
      <div className="flex flex-wrap items-end justify-between gap-4">
        <div>
          <div className="flex items-center gap-2 text-xs font-medium uppercase tracking-wider text-primary">
            <Radar className="size-3.5" /> Command Center
          </div>
          <h1 className="mt-1 text-2xl font-semibold tracking-tight">Autonomous job operations</h1>
          <p className="mt-1 max-w-2xl text-sm text-muted-foreground">
            Failed jobs are detected within a minute. The Investigator diagnoses, the Fixer writes and rehearses a fix, and the Reviewer scores it before anyone approves a change.
          </p>
        </div>
        <div className="flex items-center gap-2">
          <span className="hidden text-xs text-muted-foreground md:inline">
            Detector {d?.detector ? `${d.detector.state.toLowerCase()} ${ago(d.detector.completedAt ?? d.detector.scheduledAt)}` : "—"}
          </span>
          <Button
            variant="outline"
            size="sm"
            disabled={scanning}
            onClick={async () => {
              setScanning(true)
              await api("/api/scan", { method: "POST" }).catch(() => {})
              setTimeout(() => setScanning(false), 4000)
            }}
          >
            <RefreshCw className={cn("size-3.5", scanning && "animate-spin")} /> Scan now
          </Button>
        </div>
      </div>

      <section className="grid gap-4 sm:grid-cols-2 xl:grid-cols-5">
        {d ? (
          <>
            <Kpi label="Agents working" value={d.counts.active} hint={d.orchestrator ? `${d.orchestrator.running}/${d.orchestrator.maxInFlight} slots in use` : undefined} icon={Zap} tone="text-primary" href="/incidents?view=active" />
            <Kpi label="Awaiting approval" value={d.counts.awaiting} hint="Rehearsed and reviewed" icon={Hand} tone={d.counts.awaiting ? "text-warning" : undefined} href="/incidents?view=attention" />
            <Kpi label="Needs a person" value={d.counts.needsHuman} hint="Escalated by the agents" icon={AlertOctagon} tone={d.counts.needsHuman ? "text-danger" : undefined} href="/incidents?view=attention" />
            <Kpi label="Resolved · 7 days" value={d.counts.resolved7d} hint={d.counts.mttrSeconds ? `Median time to resolve ${duration(d.counts.mttrSeconds * 1000)}` : "Verified by a successful rerun"} icon={CheckCircle2} tone="text-success" href="/incidents?view=resolved" />
            <Kpi label="History backlog" value={d.counts.backlog} hint="Found in the 14-day backfill" icon={Clock3} href="/incidents?view=backlog" />
          </>
        ) : (
          Array.from({ length: 5 }, (_, i) => <Skeleton key={i} className="h-[104px] rounded-xl" />)
        )}
      </section>

      <section className="grid gap-4 xl:grid-cols-3">
        <Card className="xl:col-span-2">
          <CardHeader className="flex flex-row items-center justify-between pb-2">
            <CardTitle className="flex items-center gap-2">
              <Sparkles className="size-4 text-primary" /> In flight
            </CardTitle>
            <Link href="/incidents?view=active" className="text-xs text-muted-foreground hover:text-foreground">
              All active <ArrowRight className="inline size-3" />
            </Link>
          </CardHeader>
          <CardContent className="space-y-2">
            {active.isPending ? (
              <Skeleton className="h-24" />
            ) : active.error ? (
              <EmptyState variant="error" title="Could not load incidents" description={(active.error as Error).message} />
            ) : !active.data?.incidents.length ? (
              <div className="rounded-lg border border-dashed p-6 text-center text-sm text-muted-foreground">
                No agents are working right now. Break something in the <Link className="text-primary underline-offset-2 hover:underline" href="/chaos">Chaos Lab</Link> to watch them.
              </div>
            ) : (
              active.data.incidents.map((i) => (
                <Link key={i.id} href={`/incidents/${i.number}`} className="block rounded-lg border bg-card/60 p-3 transition-colors hover:border-primary/40">
                  <div className="flex flex-wrap items-center gap-2">
                    <span className="font-mono text-xs text-muted-foreground">{formatIncidentNumber(i.number)}</span>
                    <SeverityBadge severity={i.severity} />
                    <span className="min-w-0 flex-1 truncate text-sm font-medium">{i.title}</span>
                    <StatusPill status={i.status} />
                  </div>
                  <div className="mt-2.5">
                    <PipelineStepper status={i.status} />
                  </div>
                  <div className="mt-2 flex items-center justify-between text-[11px] text-muted-foreground">
                    <span className="truncate">{i.statusDetail}</span>
                    <span className="text-tabular shrink-0">{compactTokens(i.totalTokens)} tokens</span>
                  </div>
                </Link>
              ))
            )}
          </CardContent>
        </Card>

        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="flex items-center gap-2">
              <Timer className="size-4 text-primary" /> Live
            </CardTitle>
          </CardHeader>
          <CardContent className="h-[180px]">
            <LiveTicker />
          </CardContent>
        </Card>
      </section>

      <section className="grid gap-4 xl:grid-cols-3">
        <Card className="xl:col-span-2">
          <CardHeader className="flex flex-row items-center justify-between pb-2">
            <CardTitle className="flex items-center gap-2">
              <Hand className="size-4 text-warning" /> Needs your attention
            </CardTitle>
            <Link href="/incidents?view=attention" className="text-xs text-muted-foreground hover:text-foreground">
              Open queue <ArrowRight className="inline size-3" />
            </Link>
          </CardHeader>
          <CardContent className="p-0">
            {attention.isPending ? (
              <div className="p-4"><Skeleton className="h-20" /></div>
            ) : !attention.data?.incidents.length ? (
              <div className="px-4 pb-6 pt-2 text-sm text-muted-foreground">Nothing is waiting on a person.</div>
            ) : (
              <ul className="divide-y">
                {attention.data.incidents.slice(0, 8).map((i) => (
                  <li key={i.id}>
                    <Link href={`/incidents/${i.number}`} className="flex items-center gap-3 px-4 py-3 transition-colors hover:bg-accent/50">
                      <span className="font-mono text-xs text-muted-foreground">{formatIncidentNumber(i.number)}</span>
                      <div className="min-w-0 flex-1">
                        <div className="truncate text-sm font-medium">{i.summary ?? i.title}</div>
                        <div className="truncate text-xs text-muted-foreground">{i.jobFqn} · {i.statusDetail}</div>
                      </div>
                      {i.confidence !== null && (
                        <span className={cn("text-tabular text-sm font-semibold", i.confidence >= 80 ? "text-success" : i.confidence >= 60 ? "text-warning" : "text-danger")}>
                          {Math.round(i.confidence)}
                        </span>
                      )}
                      <StatusPill status={i.status} />
                    </Link>
                  </li>
                ))}
              </ul>
            )}
          </CardContent>
        </Card>

        <Card>
          <CardHeader className="pb-2">
            <CardTitle>Agent workload · 24 h</CardTitle>
          </CardHeader>
          <CardContent>
            {d?.activity.length ? (
              <div className="h-[150px]">
                <ResponsiveContainer width="100%" height="100%">
                  <AreaChart data={d.activity} margin={{ top: 4, right: 4, left: -24, bottom: 0 }}>
                    <defs>
                      <linearGradient id="tok" x1="0" y1="0" x2="0" y2="1">
                        <stop offset="0%" stopColor="var(--chart-1)" stopOpacity={0.45} />
                        <stop offset="100%" stopColor="var(--chart-1)" stopOpacity={0} />
                      </linearGradient>
                    </defs>
                    <XAxis dataKey="hour" tickFormatter={(h) => new Date(h).getHours().toString().padStart(2, "0")} tick={{ fontSize: 10, fill: "var(--chart-axis)" }} axisLine={false} tickLine={false} />
                    <YAxis tickFormatter={(v) => compactTokens(v)} tick={{ fontSize: 10, fill: "var(--chart-axis)" }} axisLine={false} tickLine={false} />
                    <Tooltip
                      contentStyle={{ background: "var(--popover)", border: "1px solid var(--border)", borderRadius: 8, fontSize: 12 }}
                      labelFormatter={(h) => new Date(String(h)).toLocaleString()}
                      formatter={(v) => [compactTokens(Number(v ?? 0)), "tokens"]}
                    />
                    <Area type="monotone" dataKey="tokens" stroke="var(--chart-1)" strokeWidth={2} fill="url(#tok)" />
                  </AreaChart>
                </ResponsiveContainer>
              </div>
            ) : (
              <div className="flex h-[150px] items-center justify-center text-xs text-muted-foreground">No agent activity in the last 24 hours.</div>
            )}
            <div className="mt-3 space-y-2">
              {(["INVESTIGATOR", "FIXER", "REVIEWER"] as const).map((role) => {
                const a = d?.agents.find((x) => x.role === role)
                return (
                  <div key={role} className="flex items-center gap-2.5">
                    <AgentAvatar actor={role} size="sm" pulse={(a?.running ?? 0) > 0} />
                    <div className="min-w-0 flex-1">
                      <div className="text-xs font-medium">{ACTORS[role].label}</div>
                      <div className="truncate text-[11px] text-muted-foreground">{a?.model ?? "idle"}</div>
                    </div>
                    <div className="text-tabular text-right text-[11px] text-muted-foreground">
                      <div>{a?.runs ?? 0} runs · p50 {duration(a?.p50Ms)}</div>
                      <div>{compactTokens(a?.tokens)} tokens</div>
                    </div>
                  </div>
                )
              })}
            </div>
          </CardContent>
        </Card>
      </section>

      <Card>
        <CardHeader className="flex flex-row items-center justify-between pb-2">
          <CardTitle>Recent agent steps</CardTitle>
          <span className="text-xs text-muted-foreground">Every turn and system step, with time and tokens</span>
        </CardHeader>
        <CardContent className="p-0">
          {!d?.recent.length ? (
            <div className="px-4 pb-6 pt-2 text-sm text-muted-foreground">No steps recorded yet.</div>
          ) : (
            <ul className="divide-y">
              {d.recent.map((s) => (
                <li key={s.stepId}>
                  <Link href={`/incidents/${s.incidentNumber}?step=${s.stepId}`} className="flex items-center gap-3 px-4 py-2.5 text-sm transition-colors hover:bg-accent/50">
                    <AgentAvatar actor={s.actor} size="sm" />
                    <span className="font-mono text-xs text-muted-foreground">{formatIncidentNumber(s.incidentNumber)}</span>
                    <span className="min-w-0 flex-1 truncate">{s.task}</span>
                    <span className="hidden text-xs text-muted-foreground md:inline">{s.model ?? ""}</span>
                    <span className="text-tabular w-16 text-right text-xs text-muted-foreground">{duration(s.durationMs)}</span>
                    <span className="text-tabular w-14 text-right text-xs text-muted-foreground">{s.tokens ? compactTokens(s.tokens) : ""}</span>
                    <StatusPill status={s.status} />
                  </Link>
                </li>
              ))}
            </ul>
          )}
        </CardContent>
      </Card>

      <section className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
        {d?.scopes.map((s) => (
          <div key={String(s.id)} className="flex items-center justify-between rounded-lg border bg-card/60 px-3 py-2 text-xs">
            <span className="font-mono">{s.database}</span>
            <span className="text-muted-foreground">
              {s.enabled ? `scanned ${ago(s.lastScanAt)} · ${duration(s.lastScanMs)}` : "paused"}
            </span>
          </div>
        ))}
      </section>
    </main>
  )
}
