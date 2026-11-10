"use client"

import { useState } from "react"
import { useQuery } from "@tanstack/react-query"
import { Bar, BarChart, CartesianGrid, Cell, Legend, Line, LineChart, Pie, PieChart, ResponsiveContainer, Tooltip, XAxis, YAxis } from "recharts"
import { BarChart3, Coins, Gauge, Timer, Zap } from "lucide-react"
import { api, compactTokens, credits, duration } from "@/lib/client"
import { cn } from "@/lib/utils"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { Skeleton } from "@/components/ui/skeleton"
import { EmptyState } from "@/components/empty-state"
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table"
import { AgentAvatar, ACTORS } from "@/components/ade/agent"
import { formatIncidentNumber } from "@/lib/domain"

type Row = Record<string, any>
interface Analytics {
  daily: Row[]
  performance: Row[]
  funnel: Row | null
  calibration: Row[]
  cost: Row[]
  categories: Row[]
}

const tooltipStyle = { background: "var(--popover)", border: "1px solid var(--border)", borderRadius: 8, fontSize: 12 }
const axis = { tick: { fontSize: 11, fill: "var(--chart-axis)" }, axisLine: false, tickLine: false }
const ACTOR_COLOR: Record<string, string> = { INVESTIGATOR: "var(--agent-investigator)", FIXER: "var(--agent-fixer)", REVIEWER: "var(--agent-reviewer)" }
const PIE = ["var(--chart-1)", "var(--chart-2)", "var(--chart-3)", "var(--chart-4)", "var(--chart-5)", "var(--agent-system)"]

export default function AnalyticsPage() {
  const [days, setDays] = useState(14)
  const { data, isPending, error } = useQuery({ queryKey: ["analytics", days], queryFn: () => api<Analytics>(`/api/analytics?days=${days}`) })

  const byDay = (() => {
    const m = new Map<string, Row>()
    for (const r of data?.daily ?? []) {
      const k = String(r.usage_date).slice(0, 10)
      const cur = m.get(k) ?? { day: k, INVESTIGATOR: 0, FIXER: 0, REVIEWER: 0, ms: 0, turns: 0 }
      cur[r.actor] = (cur[r.actor] ?? 0) + Number(r.input_tokens ?? 0) + Number(r.output_tokens ?? 0)
      cur.ms += Number(r.agent_ms ?? 0)
      cur.turns += Number(r.turns ?? 0)
      m.set(k, cur)
    }
    return [...m.values()].sort((a, b) => a.day.localeCompare(b.day))
  })()
  const totals = (data?.performance ?? []).reduce(
    (a, r) => ({ runs: a.runs + Number(r.runs ?? 0), tokens: a.tokens + Number(r.avg_tokens ?? 0) * Number(r.runs ?? 0), credits: a.credits + Number(r.total_credits ?? 0) }),
    { runs: 0, tokens: 0, credits: 0 },
  )
  const funnel = data?.funnel
  const funnelSteps = funnel
    ? [
        { k: "Detected", v: Number(funnel.detected ?? 0) },
        { k: "Diagnosed", v: Number(funnel.diagnosed ?? 0) },
        { k: "Fix proposed", v: Number(funnel.fix_proposed ?? 0) },
        { k: "Reviewed", v: Number(funnel.reviewed ?? 0) },
        { k: "Approved", v: Number(funnel.approved ?? 0) },
        { k: "Applied", v: Number(funnel.applied ?? 0) },
        { k: "Resolved", v: Number(funnel.resolved ?? 0) },
      ]
    : []
  const maxFunnel = Math.max(1, ...funnelSteps.map((f) => f.v))

  return (
    <main className="mx-auto w-full max-w-[1400px] space-y-5 px-4 py-6 sm:px-6 lg:px-8">
      <div className="flex flex-wrap items-end justify-between gap-4">
        <div>
          <div className="flex items-center gap-2 text-xs font-medium uppercase tracking-wider text-primary">
            <BarChart3 className="size-3.5" /> Analytics
          </div>
          <h1 className="mt-1 text-2xl font-semibold tracking-tight">Agent performance and cost</h1>
          <p className="mt-1 text-sm text-muted-foreground">From per-step telemetry in ADE_DB.OPS.AGENT_STEPS; credits reconciled from CORTEX_AGENT_USAGE_HISTORY.</p>
        </div>
        <div className="flex gap-1 rounded-lg border bg-card/60 p-1">
          {[7, 14, 30, 90].map((d) => (
            <button key={d} type="button" onClick={() => setDays(d)} className={cn("rounded-md px-3 py-1 text-xs font-medium", days === d ? "bg-accent" : "text-muted-foreground")}>
              {d} d
            </button>
          ))}
        </div>
      </div>

      {isPending ? (
        <div className="grid gap-4 lg:grid-cols-2">{Array.from({ length: 4 }, (_, i) => <Skeleton key={i} className="h-72" />)}</div>
      ) : error ? (
        <EmptyState variant="error" title="Could not load analytics" description={(error as Error).message} />
      ) : (
        <>
          <section className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
            <Kpi icon={Zap} label="Agent runs" value={String(totals.runs)} />
            <Kpi icon={Coins} label="Tokens" value={compactTokens(totals.tokens)} />
            <Kpi icon={Gauge} label="Credits (reconciled)" value={totals.credits ? credits(totals.credits) : "pending"} hint="ACCOUNT_USAGE lags up to ~1 h" />
            <Kpi icon={Timer} label="Incidents resolved" value={String(funnel?.resolved ?? 0)} hint={`${funnel?.detected ?? 0} detected`} />
          </section>

          <section className="grid gap-4 xl:grid-cols-3">
            <Card className="xl:col-span-2">
              <CardHeader className="pb-1"><CardTitle>Tokens per day by agent</CardTitle></CardHeader>
              <CardContent className="h-72">
                {byDay.length ? (
                  <ResponsiveContainer width="100%" height="100%">
                    <BarChart data={byDay} margin={{ left: -10, right: 8 }}>
                      <CartesianGrid stroke="var(--chart-grid)" vertical={false} />
                      <XAxis dataKey="day" {...axis} tickFormatter={(d) => String(d).slice(5)} />
                      <YAxis {...axis} tickFormatter={(v) => compactTokens(v)} />
                      <Tooltip contentStyle={tooltipStyle} formatter={(v, n) => [compactTokens(Number(v ?? 0)), ACTORS[String(n)]?.label ?? String(n)]} />
                      <Legend formatter={(n: string) => ACTORS[n]?.label ?? n} wrapperStyle={{ fontSize: 12 }} />
                      {(["INVESTIGATOR", "FIXER", "REVIEWER"] as const).map((a) => (
                        <Bar key={a} dataKey={a} stackId="t" fill={ACTOR_COLOR[a]} radius={a === "REVIEWER" ? [4, 4, 0, 0] : 0} />
                      ))}
                    </BarChart>
                  </ResponsiveContainer>
                ) : (
                  <div className="flex h-full items-center justify-center text-sm text-muted-foreground">No agent activity in this window.</div>
                )}
              </CardContent>
            </Card>
            <Card>
              <CardHeader className="pb-1"><CardTitle>Pipeline funnel</CardTitle></CardHeader>
              <CardContent className="space-y-2 pt-2">
                {funnelSteps.map((f) => (
                  <div key={f.k} className="space-y-1">
                    <div className="flex justify-between text-xs"><span className="text-muted-foreground">{f.k}</span><span className="text-tabular font-medium">{f.v}</span></div>
                    <div className="h-2 overflow-hidden rounded-full bg-muted"><div className="h-full rounded-full bg-primary/80" style={{ width: `${(f.v / maxFunnel) * 100}%` }} /></div>
                  </div>
                ))}
              </CardContent>
            </Card>
          </section>

          <Card>
            <CardHeader className="pb-1"><CardTitle>Per-agent performance</CardTitle></CardHeader>
            <CardContent className="p-0">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Agent</TableHead>
                    <TableHead>Model</TableHead>
                    <TableHead numeric>Runs</TableHead>
                    <TableHead numeric>Success</TableHead>
                    <TableHead numeric>p50</TableHead>
                    <TableHead numeric>p95</TableHead>
                    <TableHead numeric>Avg tokens</TableHead>
                    <TableHead numeric>Cache hit</TableHead>
                    <TableHead numeric>Avg tools</TableHead>
                    <TableHead numeric>Credits</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {(data?.performance ?? []).map((r, idx) => (
                    <TableRow key={idx}>
                      <TableCell><span className="flex items-center gap-2"><AgentAvatar actor={r.agent_role} size="sm" /> {ACTORS[r.agent_role]?.label ?? r.agent_role}</span></TableCell>
                      <TableCell className="font-mono text-xs">{r.model}</TableCell>
                      <TableCell numeric>{r.runs}</TableCell>
                      <TableCell numeric>{r.success_pct ?? "—"}%</TableCell>
                      <TableCell numeric>{duration(Number(r.p50_ms))}</TableCell>
                      <TableCell numeric>{duration(Number(r.p95_ms))}</TableCell>
                      <TableCell numeric>{compactTokens(Number(r.avg_tokens))}</TableCell>
                      <TableCell numeric>{r.cache_hit_pct ?? "—"}%</TableCell>
                      <TableCell numeric>{r.avg_tool_calls}</TableCell>
                      <TableCell numeric>{r.total_credits ? credits(Number(r.total_credits)) : "—"}</TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </CardContent>
          </Card>

          <section className="grid gap-4 xl:grid-cols-3">
            <Card>
              <CardHeader className="pb-1"><CardTitle>Failure categories</CardTitle></CardHeader>
              <CardContent className="h-64">
                {data?.categories.length ? (
                  <ResponsiveContainer width="100%" height="100%">
                    <PieChart>
                      <Pie data={data.categories} dataKey="n" nameKey="category" innerRadius={55} outerRadius={85} paddingAngle={2}>
                        {data.categories.map((_, i) => <Cell key={i} fill={PIE[i % PIE.length]} />)}
                      </Pie>
                      <Tooltip contentStyle={tooltipStyle} />
                      <Legend wrapperStyle={{ fontSize: 11 }} formatter={(v: string) => v.replace(/_/g, " ").toLowerCase()} />
                    </PieChart>
                  </ResponsiveContainer>
                ) : <div className="flex h-full items-center justify-center text-sm text-muted-foreground">No incidents.</div>}
              </CardContent>
            </Card>
            <Card className="xl:col-span-2">
              <CardHeader className="pb-1"><CardTitle>Confidence calibration</CardTitle></CardHeader>
              <CardContent className="h-64">
                {data?.calibration.length ? (
                  <ResponsiveContainer width="100%" height="100%">
                    <LineChart data={data.calibration.map((c) => ({ bucket: `${c.confidence_bucket}-${Number(c.confidence_bucket) + 9}`, reviews: Number(c.reviews), verified: Number(c.verified_pct ?? 0) }))} margin={{ left: -10, right: 8 }}>
                      <CartesianGrid stroke="var(--chart-grid)" vertical={false} />
                      <XAxis dataKey="bucket" {...axis} />
                      <YAxis yAxisId="l" {...axis} />
                      <YAxis yAxisId="r" orientation="right" {...axis} domain={[0, 100]} tickFormatter={(v) => `${v}%`} />
                      <Tooltip contentStyle={tooltipStyle} />
                      <Legend wrapperStyle={{ fontSize: 12 }} />
                      <Bar yAxisId="l" dataKey="reviews" fill="var(--chart-1)" />
                      <Line yAxisId="r" dataKey="verified" name="verified after apply %" stroke="var(--agent-reviewer)" strokeWidth={2} />
                    </LineChart>
                  </ResponsiveContainer>
                ) : <div className="flex h-full items-center justify-center text-center text-sm text-muted-foreground">Appears once reviewed fixes have been applied and verified.</div>}
              </CardContent>
            </Card>
          </section>

          <Card>
            <CardHeader className="pb-1"><CardTitle>Cost and time per incident</CardTitle></CardHeader>
            <CardContent className="p-0">
              {!data?.cost.length ? (
                <div className="p-6 text-sm text-muted-foreground">No agent work in this window.</div>
              ) : (
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead>Incident</TableHead>
                      <TableHead>Job</TableHead>
                      <TableHead>Status</TableHead>
                      <TableHead numeric>Agent runs</TableHead>
                      <TableHead numeric>Tool calls</TableHead>
                      <TableHead numeric>Agent time</TableHead>
                      <TableHead numeric>Tokens</TableHead>
                      <TableHead numeric>Credits</TableHead>
                      <TableHead numeric>To reviewed fix</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {data.cost.map((c, idx) => (
                      <TableRow key={idx}>
                        <TableCell className="font-mono text-xs"><a className="hover:text-primary" href={`/incidents/${c.incident_number}`}>{formatIncidentNumber(c.incident_number)}</a></TableCell>
                        <TableCell className="max-w-[18rem] truncate font-mono text-xs">{c.job_fqn}</TableCell>
                        <TableCell className="text-xs">{String(c.status).replace(/_/g, " ").toLowerCase()}</TableCell>
                        <TableCell numeric>{c.agent_runs}</TableCell>
                        <TableCell numeric>{c.tool_calls}</TableCell>
                        <TableCell numeric>{duration(Number(c.agent_ms))}</TableCell>
                        <TableCell numeric>{compactTokens(Number(c.tokens))}</TableCell>
                        <TableCell numeric>{c.credits ? credits(Number(c.credits)) : "—"}</TableCell>
                        <TableCell numeric>{c.seconds_to_reviewed_fix ? duration(Number(c.seconds_to_reviewed_fix) * 1000) : "—"}</TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              )}
            </CardContent>
          </Card>
        </>
      )}
    </main>
  )
}

function Kpi({ icon: Icon, label, value, hint }: { icon: typeof Zap; label: string; value: string; hint?: string }) {
  return (
    <Card>
      <CardContent className="flex items-start justify-between p-4">
        <div>
          <div className="text-[11px] font-medium uppercase tracking-wider text-muted-foreground">{label}</div>
          <div className="text-tabular mt-1.5 text-2xl font-semibold">{value}</div>
          {hint && <div className="mt-0.5 text-xs text-muted-foreground">{hint}</div>}
        </div>
        <div className="rounded-lg bg-muted p-2 text-primary"><Icon className="size-4" /></div>
      </CardContent>
    </Card>
  )
}
