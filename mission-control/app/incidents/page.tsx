"use client"

import Link from "next/link"
import { useRouter, useSearchParams } from "next/navigation"
import { Suspense, useState } from "react"
import { useQuery } from "@tanstack/react-query"
import { ListTree, Search } from "lucide-react"
import { api, ago, compactTokens, duration } from "@/lib/client"
import { useLiveInvalidation } from "@/lib/live"
import { cn } from "@/lib/utils"
import { formatIncidentNumber } from "@/lib/domain"
import { Card, CardContent } from "@/components/ui/card"
import { Skeleton } from "@/components/ui/skeleton"
import { EmptyState } from "@/components/empty-state"
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table"
import { SeverityBadge, StatusPill, jobTypeLabel } from "@/components/ade/status"
import { PipelineStepper, reachedStage } from "@/components/ade/pipeline"

const VIEWS = [
  { key: "open", label: "Open" },
  { key: "attention", label: "Needs attention" },
  { key: "active", label: "In flight" },
  { key: "resolved", label: "Resolved" },
  { key: "backlog", label: "History backlog" },
  { key: "all", label: "All" },
]

interface IncidentItem {
  id: string
  number: number
  title: string
  summary: string | null
  status: string
  statusDetail: string | null
  severity: string
  category: string | null
  jobType: string
  jobFqn: string
  database: string
  errorCode: string | null
  occurrences: number
  symptoms: number
  confidence: number | null
  isBackfill: boolean
  lastSeenAt: string | null
  updatedAt: string | null
  totalTokens: number
  totalAgentMs: number
  fixIterations: number
}

function IncidentsInner() {
  const params = useSearchParams()
  const router = useRouter()
  const view = params.get("view") ?? "open"
  const [q, setQ] = useState(params.get("q") ?? "")
  const { data, isPending, error } = useQuery({
    queryKey: ["incidents", view, params.get("q") ?? ""],
    queryFn: () => api<{ incidents: IncidentItem[] }>(`/api/incidents?view=${view}&q=${encodeURIComponent(params.get("q") ?? "")}`),
  })
  useLiveInvalidation([["incidents"]])

  return (
    <main className="mx-auto w-full max-w-[1400px] space-y-5 px-4 py-6 sm:px-6 lg:px-8">
      <div className="flex flex-wrap items-end justify-between gap-4">
        <div>
          <div className="flex items-center gap-2 text-xs font-medium uppercase tracking-wider text-primary">
            <ListTree className="size-3.5" /> Incidents
          </div>
          <h1 className="mt-1 text-2xl font-semibold tracking-tight">Every failure, deduplicated</h1>
          <p className="mt-1 text-sm text-muted-foreground">One incident per distinct problem. Repeats add occurrences; cascading failures attach to their root.</p>
        </div>
        <form
          className="relative w-full max-w-xs"
          onSubmit={(e) => {
            e.preventDefault()
            router.push(`/incidents?view=${view}&q=${encodeURIComponent(q)}`)
          }}
        >
          <Search className="absolute left-2.5 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" />
          <input
            value={q}
            onChange={(e) => setQ(e.target.value)}
            placeholder="Search job, title or ADE-number"
            className="h-9 w-full rounded-lg border bg-card pl-8 pr-3 text-sm outline-none ring-primary/40 focus:ring-2"
          />
        </form>
      </div>

      <div className="flex flex-wrap gap-1 rounded-lg border bg-card/60 p-1">
        {VIEWS.map((v) => (
          <Link
            key={v.key}
            href={`/incidents?view=${v.key}`}
            className={cn("rounded-md px-3 py-1.5 text-xs font-medium transition-colors", view === v.key ? "bg-accent text-foreground" : "text-muted-foreground hover:text-foreground")}
          >
            {v.label}
          </Link>
        ))}
      </div>

      <Card>
        <CardContent className="p-0">
          {isPending ? (
            <div className="space-y-2 p-4">{Array.from({ length: 6 }, (_, i) => <Skeleton key={i} className="h-12" />)}</div>
          ) : error ? (
            <EmptyState variant="error" title="Could not load incidents" description={(error as Error).message} />
          ) : !data?.incidents.length ? (
            <EmptyState title="No incidents in this view" description="Jobs in the monitored databases are healthy." />
          ) : (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead className="w-24">Incident</TableHead>
                  <TableHead>Problem</TableHead>
                  <TableHead className="hidden w-56 xl:table-cell">Progress</TableHead>
                  <TableHead className="w-36">Status</TableHead>
                  <TableHead numeric className="hidden w-20 md:table-cell">Conf.</TableHead>
                  <TableHead numeric className="hidden w-24 lg:table-cell">Agent time</TableHead>
                  <TableHead numeric className="hidden w-20 lg:table-cell">Tokens</TableHead>
                  <TableHead numeric className="w-24">Last seen</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {data.incidents.map((i) => (
                  <TableRow key={i.id} className="cursor-pointer" onClick={() => router.push(`/incidents/${i.number}`)}>
                    <TableCell>
                      <div className="font-mono text-xs">{formatIncidentNumber(i.number)}</div>
                      <SeverityBadge severity={i.severity} className="mt-1" />
                    </TableCell>
                    <TableCell className="max-w-0">
                      <Link href={`/incidents/${i.number}`} className="block truncate text-sm font-medium hover:text-primary" onClick={(e) => e.stopPropagation()}>
                        {i.summary ?? i.title}
                      </Link>
                      <div className="mt-0.5 flex items-center gap-2 truncate text-xs text-muted-foreground">
                        <span className="truncate font-mono">{i.jobFqn}</span>
                        <span>·</span>
                        <span>{jobTypeLabel(i.jobType)}</span>
                        {i.errorCode && <span className="font-mono">· {i.errorCode}</span>}
                        {i.occurrences > 1 && <span>· ×{i.occurrences}</span>}
                        {i.symptoms > 0 && <span>· {i.symptoms} downstream</span>}
                      </div>
                    </TableCell>
                    <TableCell className="hidden xl:table-cell">
                      <PipelineStepper status={i.status} compact reached={reachedStage(i)} />
                    </TableCell>
                    <TableCell>
                      <StatusPill status={i.status} />
                    </TableCell>
                    <TableCell numeric className={cn("hidden font-semibold md:table-cell", i.confidence === null ? "text-muted-foreground" : i.confidence >= 80 ? "text-success" : i.confidence >= 60 ? "text-warning" : "text-danger")}>
                      {i.confidence === null ? "—" : Math.round(i.confidence)}
                    </TableCell>
                    <TableCell numeric className="hidden text-muted-foreground lg:table-cell">{duration(i.totalAgentMs)}</TableCell>
                    <TableCell numeric className="hidden text-muted-foreground lg:table-cell">{i.totalTokens ? compactTokens(i.totalTokens) : "—"}</TableCell>
                    <TableCell numeric className="text-xs text-muted-foreground">{ago(i.lastSeenAt)}</TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          )}
        </CardContent>
      </Card>
    </main>
  )
}

export default function IncidentsPage() {
  return (
    <Suspense fallback={<div className="p-8"><Skeleton className="h-64" /></div>}>
      <IncidentsInner />
    </Suspense>
  )
}
