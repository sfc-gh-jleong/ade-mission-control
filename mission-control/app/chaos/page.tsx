"use client"

import { useState } from "react"
import { useMutation, useQuery } from "@tanstack/react-query"
import { FlaskConical, Loader2, Play, RotateCcw, Zap } from "lucide-react"
import { api } from "@/lib/client"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { Button } from "@/components/ui/button"
import { CodeBlock } from "@/components/ade/code"

interface Scenario {
  id: string
  label: string
  job: string
  description: string
}

export default function ChaosLab() {
  const { data } = useQuery({ queryKey: ["chaos"], queryFn: () => api<{ scenarios: Scenario[] }>("/api/chaos") })
  const [result, setResult] = useState<unknown>(null)
  const [busy, setBusy] = useState<string | null>(null)
  const run = useMutation({
    mutationFn: (body: Record<string, unknown>) => api<{ result: unknown }>("/api/chaos", { method: "POST", json: body }),
    onMutate: (b) => setBusy(String(b.scenario ?? b.action)),
    onSuccess: (r) => setResult(r.result),
    onError: (e) => setResult({ error: (e as Error).message }),
    onSettled: () => setBusy(null),
  })

  return (
    <main className="mx-auto w-full max-w-[1200px] space-y-5 px-4 py-6 sm:px-6 lg:px-8">
      <div>
        <div className="flex items-center gap-2 text-xs font-medium uppercase tracking-wider text-primary">
          <FlaskConical className="size-3.5" /> Chaos Lab
        </div>
        <h1 className="mt-1 text-2xl font-semibold tracking-tight">Break the demo pipeline, watch the agents fix it</h1>
        <p className="mt-1 max-w-3xl text-sm text-muted-foreground">
          <span className="font-mono">ADE_DEMO_RETAIL</span> is a small retail pipeline (orders → cleaned orders → daily revenue → snapshot, plus a customer-LTV dynamic table) owned by SYSADMIN like any production database. Each scenario resets it, injects one realistic failure and triggers the job, so the detector opens an incident within a minute.
        </p>
      </div>

      <div className="flex flex-wrap gap-2">
        <Button variant="outline" size="sm" disabled={busy !== null} onClick={() => run.mutate({ action: "reset" })}>
          {busy === "reset" ? <Loader2 className="size-3.5 animate-spin" /> : <RotateCcw className="size-3.5" />} Reset to healthy
        </Button>
        <Button variant="outline" size="sm" disabled={busy !== null} onClick={() => run.mutate({ action: "run" })}>
          {busy === "run" ? <Loader2 className="size-3.5 animate-spin" /> : <Play className="size-3.5" />} Run pipeline now
        </Button>
      </div>

      <section className="grid gap-4 md:grid-cols-2 xl:grid-cols-3">
        {(data?.scenarios ?? []).map((s) => (
          <Card key={s.id} className="flex flex-col">
            <CardHeader className="pb-2">
              <CardTitle className="flex items-center justify-between gap-2">
                {s.label}
                <span className="font-mono text-[11px] font-normal text-muted-foreground">{s.job}</span>
              </CardTitle>
            </CardHeader>
            <CardContent className="flex flex-1 flex-col justify-between gap-4">
              <p className="text-sm text-muted-foreground">{s.description}</p>
              <Button size="sm" disabled={busy !== null} onClick={() => run.mutate({ action: "break", scenario: s.id })} className="self-start">
                {busy === s.id ? <Loader2 className="size-3.5 animate-spin" /> : <Zap className="size-3.5" />} Break it
              </Button>
            </CardContent>
          </Card>
        ))}
      </section>

      {result !== null && (
        <Card>
          <CardHeader className="pb-2"><CardTitle>Result</CardTitle></CardHeader>
          <CardContent>
            <CodeBlock lang="json" code={JSON.stringify(result, null, 2)} />
            <p className="mt-2 text-xs text-muted-foreground">The detector scans every minute (a scan was also requested now). Follow the incident on the Command Center.</p>
          </CardContent>
        </Card>
      )}
    </main>
  )
}
