"use client"

import Link from "next/link"
import { useMemo, useState } from "react"
import { useQuery } from "@tanstack/react-query"
import { Boxes, Search } from "lucide-react"
import { api, ago } from "@/lib/client"
import { useLiveInvalidation } from "@/lib/live"
import { cn } from "@/lib/utils"
import { Card, CardContent } from "@/components/ui/card"
import { Skeleton } from "@/components/ui/skeleton"
import { EmptyState } from "@/components/empty-state"
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table"
import { StatusPill, jobTypeLabel } from "@/components/ade/status"

interface Job {
  id: string
  type: string
  database: string
  schema: string
  name: string
  fqn: string
  owner: string | null
  warehouse: string | null
  schedule: string | null
  state: string | null
  lastRunAt: string | null
  lastStatus: string | null
  lastSuccessAt: string | null
  lastFailureAt: string | null
  runs24h: number
  failures24h: number
  openIncidents: number
  predecessors: string[]
  history: { hour: string | null; ok: number; bad: number }[]
}

/** 72 hourly cells: green = runs succeeded, red = a failure that hour. */
function RunStrip({ history }: { history: Job["history"] }) {
  const cells = useMemo(() => {
    const now = new Date()
    now.setMinutes(0, 0, 0)
    const byHour = new Map(history.map((h) => [h.hour ? new Date(h.hour).getTime() : 0, h]))
    return Array.from({ length: 72 }, (_, i) => {
      const t = now.getTime() - (71 - i) * 3600_000
      return { t, h: byHour.get(t) }
    })
  }, [history])
  return (
    <div className="flex h-4 items-end gap-px" aria-label="Last 72 hours of runs">
      {cells.map((c) => (
        <span
          key={c.t}
          title={`${new Date(c.t).toLocaleString()}${c.h ? ` · ${c.h.ok} ok · ${c.h.bad} failed` : ""}`}
          className={cn("w-[3px] rounded-sm", !c.h ? "h-1 bg-muted" : c.h.bad ? "h-4 bg-danger" : "h-2.5 bg-success/70")}
        />
      ))}
    </div>
  )
}

function health(j: Job): { label: string; tone: string } {
  if (j.openIncidents > 0) return { label: "Incident", tone: "text-danger" }
  if (j.failures24h > 0) return { label: "Failing", tone: "text-warning" }
  if (String(j.state ?? "").toLowerCase().includes("suspend")) return { label: "Suspended", tone: "text-muted-foreground" }
  if (j.lastSuccessAt) return { label: "Healthy", tone: "text-success" }
  return { label: "Idle", tone: "text-muted-foreground" }
}

export default function FleetPage() {
  const { data, isPending, error } = useQuery({ queryKey: ["fleet"], queryFn: () => api<{ jobs: Job[] }>("/api/fleet"), refetchInterval: 60_000 })
  useLiveInvalidation([["fleet"]])
  const [q, setQ] = useState("")
  const [db, setDb] = useState("ALL")
  const jobs = data?.jobs ?? []
  const dbs = [...new Set(jobs.map((j) => j.database))]
  const filtered = jobs.filter((j) => (db === "ALL" || j.database === db) && (!q || j.fqn.toLowerCase().includes(q.toLowerCase())))
  const counts = {
    total: jobs.length,
    healthy: jobs.filter((j) => health(j).label === "Healthy").length,
    failing: jobs.filter((j) => ["Incident", "Failing"].includes(health(j).label)).length,
  }

  return (
    <main className="mx-auto w-full max-w-[1400px] space-y-5 px-4 py-6 sm:px-6 lg:px-8">
      <div className="flex flex-wrap items-end justify-between gap-4">
        <div>
          <div className="flex items-center gap-2 text-xs font-medium uppercase tracking-wider text-primary">
            <Boxes className="size-3.5" /> Fleet
          </div>
          <h1 className="mt-1 text-2xl font-semibold tracking-tight">Monitored jobs</h1>
          <p className="mt-1 text-sm text-muted-foreground">
            {counts.total} jobs across {dbs.length} databases · <span className="text-success">{counts.healthy} healthy</span> · <span className={counts.failing ? "text-danger" : ""}>{counts.failing} failing</span>
          </p>
        </div>
        <div className="flex items-center gap-2">
          <select value={db} onChange={(e) => setDb(e.target.value)} className="h-9 rounded-lg border bg-card px-2 text-sm">
            <option value="ALL">All databases</option>
            {dbs.map((d) => <option key={d} value={d}>{d}</option>)}
          </select>
          <div className="relative">
            <Search className="absolute left-2.5 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" />
            <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Filter jobs" className="h-9 w-56 rounded-lg border bg-card pl-8 pr-3 text-sm outline-none ring-primary/40 focus:ring-2" />
          </div>
        </div>
      </div>
      <Card>
        <CardContent className="p-0">
          {isPending ? (
            <div className="space-y-2 p-4">{Array.from({ length: 8 }, (_, i) => <Skeleton key={i} className="h-10" />)}</div>
          ) : error ? (
            <EmptyState variant="error" title="Could not load the fleet" description={(error as Error).message} />
          ) : !filtered.length ? (
            <EmptyState title="No jobs" description="Register a database in Settings to monitor its jobs." />
          ) : (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead className="min-w-[16rem]">Job</TableHead>
                  <TableHead className="w-28">Type</TableHead>
                  <TableHead className="hidden w-44 xl:table-cell">Schedule</TableHead>
                  <TableHead className="w-24">Health</TableHead>
                  <TableHead className="hidden w-[13.5rem] lg:table-cell">Last 72 h</TableHead>
                  <TableHead numeric className="w-20">24 h</TableHead>
                  <TableHead numeric className="w-32">Last run</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {filtered.map((j) => {
                  const h = health(j)
                  return (
                    <TableRow key={j.id}>
                      <TableCell className="max-w-[22rem]">
                        <div className="truncate font-mono text-[13px]" title={j.fqn}>{j.schema}.{j.name}</div>
                        <div className="truncate text-[11px] text-muted-foreground">
                          {j.database}{j.owner ? ` · owner ${j.owner}` : ""}{j.warehouse ? ` · ${j.warehouse}` : ""}
                          {j.predecessors.length > 0 ? ` · after ${j.predecessors.map((p) => p.split(".").pop()).join(", ")}` : ""}
                        </div>
                      </TableCell>
                      <TableCell className="text-xs text-muted-foreground">{jobTypeLabel(j.type)}</TableCell>
                      <TableCell className="hidden truncate font-mono text-[11px] text-muted-foreground xl:table-cell">{j.schedule ?? (j.predecessors.length ? "child task" : "—")}</TableCell>
                      <TableCell>
                        {j.openIncidents > 0 ? (
                          <Link href={`/incidents?q=${encodeURIComponent(j.name)}`} className={cn("text-xs font-medium underline-offset-2 hover:underline", h.tone)}>{h.label}</Link>
                        ) : (
                          <span className={cn("text-xs font-medium", h.tone)}>{h.label}</span>
                        )}
                      </TableCell>
                      <TableCell className="hidden lg:table-cell"><RunStrip history={j.history} /></TableCell>
                      <TableCell numeric className="text-xs">
                        <span className="text-muted-foreground">{j.runs24h}</span>
                        {j.failures24h > 0 && <span className="text-danger"> / {j.failures24h} failed</span>}
                      </TableCell>
                      <TableCell numeric className="text-xs">
                        <div className="flex flex-col items-end gap-0.5">
                          {j.lastStatus ? <StatusPill status={j.lastStatus} /> : <span className="text-muted-foreground">—</span>}
                          <span className="text-[10px] text-muted-foreground">{ago(j.lastRunAt)}</span>
                        </div>
                      </TableCell>
                    </TableRow>
                  )
                })}
              </TableBody>
            </Table>
          )}
        </CardContent>
      </Card>
    </main>
  )
}
