"use client"

import { useState } from "react"
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query"
import { Bot, Check, Database, Loader2, Power, Settings2, ShieldCheck, Users } from "lucide-react"
import { api, ago, clock } from "@/lib/client"
import { cn } from "@/lib/utils"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { Button } from "@/components/ui/button"
import { Skeleton } from "@/components/ui/skeleton"
import { EmptyState } from "@/components/empty-state"
import { AgentAvatar } from "@/components/ade/agent"
import { CodeBlock } from "@/components/ade/code"

interface SettingsData {
  settings: { key: string; value: unknown; description: string; updatedBy: string; updatedAt: string; editable: boolean }[]
  approvers: { user: string; active: boolean; addedBy: string; addedAt: string }[]
  managedDatabases: { database: string; active: boolean }[]
  agents: { name: string; owner: string; createdOn: string; comment: string }[]
}

interface Health {
  checks: { name: string; status: string; durationMs: number; summary: string; checkedAt: string }[]
}

const GROUPS = [
  { title: "Pipeline", prefix: "pipeline." },
  { title: "Budgets", prefix: "budget." },
  { title: "Approval", prefix: "apply." },
  { title: "Models", prefix: "models." },
]

function SettingRow({ s, onSave, saving }: { s: SettingsData["settings"][number]; onSave: (v: unknown) => void; saving: boolean }) {
  const [draft, setDraft] = useState(String(typeof s.value === "string" ? s.value : JSON.stringify(s.value)))
  const isBool = typeof s.value === "boolean"
  const isNum = typeof s.value === "number"
  const dirty = draft !== String(typeof s.value === "string" ? s.value : JSON.stringify(s.value))
  return (
    <div className="flex flex-wrap items-center gap-3 py-2.5">
      <div className="min-w-0 flex-1">
        <div className="font-mono text-[12.5px]">{s.key}</div>
        <div className="text-xs text-muted-foreground">{s.description}</div>
        {s.updatedBy && <div className="text-[10px] text-muted-foreground">changed by {s.updatedBy} {ago(s.updatedAt)}</div>}
      </div>
      {isBool ? (
        <button
          type="button"
          disabled={!s.editable || saving}
          onClick={() => onSave(!s.value)}
          className={cn("relative h-6 w-11 rounded-full transition-colors", s.value ? "bg-success" : "bg-muted")}
          aria-pressed={Boolean(s.value)}
          aria-label={s.key}
        >
          <span className={cn("absolute top-0.5 size-5 rounded-full bg-white shadow transition-all", s.value ? "left-[22px]" : "left-0.5")} />
        </button>
      ) : s.editable ? (
        <div className="flex items-center gap-2">
          <input value={draft} onChange={(e) => setDraft(e.target.value)} className="h-8 w-44 rounded-md border bg-card px-2 font-mono text-xs outline-none ring-primary/40 focus:ring-2" />
          <Button size="sm" variant="outline" disabled={!dirty || saving} onClick={() => onSave(isNum ? Number(draft) : draft)}>
            {saving ? <Loader2 className="size-3.5 animate-spin" /> : <Check className="size-3.5" />}
          </Button>
        </div>
      ) : (
        <span className="font-mono text-xs text-muted-foreground">{JSON.stringify(s.value)}</span>
      )}
    </div>
  )
}

export default function SettingsPage() {
  const qc = useQueryClient()
  const { data, isPending, error } = useQuery({ queryKey: ["settings"], queryFn: () => api<SettingsData>("/api/settings") })
  const health = useQuery({ queryKey: ["health"], queryFn: () => api<Health>("/api/health"), refetchInterval: 60_000 })
  const [saving, setSaving] = useState<string | null>(null)
  const [message, setMessage] = useState<string | null>(null)
  const save = useMutation({
    mutationFn: (b: { key: string; value: unknown }) => api("/api/settings", { method: "POST", json: b }),
    onMutate: (b) => {
      setSaving(b.key)
      setMessage(null)
    },
    onSuccess: (_r, b) => setMessage(`Saved ${b.key}${b.key.startsWith("models.") ? " · agent definitions re-synced" : ""}`),
    onError: (e) => setMessage((e as Error).message),
    onSettled: () => {
      setSaving(null)
      void qc.invalidateQueries({ queryKey: ["settings"] })
      void qc.invalidateQueries({ queryKey: ["overview"] })
    },
  })
  const enabled = data?.settings.find((s) => s.key === "pipeline.enabled")?.value !== false

  return (
    <main className="mx-auto w-full max-w-[1200px] space-y-5 px-4 py-6 sm:px-6 lg:px-8">
      <div className="flex flex-wrap items-end justify-between gap-4">
        <div>
          <div className="flex items-center gap-2 text-xs font-medium uppercase tracking-wider text-primary">
            <Settings2 className="size-3.5" /> Settings
          </div>
          <h1 className="mt-1 text-2xl font-semibold tracking-tight">Controls, guardrails and health</h1>
          <p className="mt-1 text-sm text-muted-foreground">Changes are made as you (caller&apos;s rights) and written to the audit log. The agents cannot change these.</p>
        </div>
        <Button
          variant={enabled ? "outline" : "default"}
          className={cn(enabled ? "border-danger/40 text-danger hover:bg-danger/10" : "bg-success text-white hover:bg-success/90")}
          disabled={!data || saving !== null}
          onClick={() => save.mutate({ key: "pipeline.enabled", value: !enabled })}
        >
          <Power className="size-4" /> {enabled ? "Pause all agents" : "Resume agents"}
        </Button>
      </div>
      {message && <div className="rounded-md bg-muted px-3 py-2 text-sm">{message}</div>}

      {isPending ? (
        <Skeleton className="h-96" />
      ) : error ? (
        <EmptyState variant="error" title="Could not load settings" description={(error as Error).message} />
      ) : (
        <div className="grid gap-4 xl:grid-cols-3">
          <div className="space-y-4 xl:col-span-2">
            {GROUPS.map((g) => (
              <Card key={g.title}>
                <CardHeader className="pb-0"><CardTitle>{g.title}</CardTitle></CardHeader>
                <CardContent className="divide-y">
                  {data!.settings.filter((s) => s.key.startsWith(g.prefix)).map((s) => (
                    <SettingRow key={`${s.key}:${JSON.stringify(s.value)}`} s={s} saving={saving === s.key} onSave={(value) => save.mutate({ key: s.key, value })} />
                  ))}
                </CardContent>
              </Card>
            ))}
          </div>
          <div className="space-y-4">
            <Card>
              <CardHeader className="pb-2"><CardTitle className="flex items-center gap-2"><Bot className="size-4 text-primary" /> Agent objects</CardTitle></CardHeader>
              <CardContent className="space-y-2.5">
                {data!.agents.map((a) => {
                  const role = a.name.replace("ADE_", "")
                  return (
                    <div key={a.name} className="flex items-center gap-2.5">
                      <AgentAvatar actor={role} size="sm" />
                      <div className="min-w-0">
                        <div className="font-mono text-xs">ADE_DB.AGENTS.{a.name}</div>
                        <div className="text-[10px] text-muted-foreground">owner {a.owner} · created {clock(a.createdOn)}</div>
                      </div>
                    </div>
                  )
                })}
                <p className="text-[11px] text-muted-foreground">Managed by the app with the Cortex Agent SDK; model changes above update them.</p>
              </CardContent>
            </Card>
            <Card>
              <CardHeader className="pb-2"><CardTitle className="flex items-center gap-2"><ShieldCheck className="size-4 text-human" /> Approvers</CardTitle></CardHeader>
              <CardContent className="space-y-1.5 text-xs">
                {data!.approvers.map((a) => (
                  <div key={a.user} className="flex items-center justify-between">
                    <span className="font-mono">{a.user}</span>
                    <span className={a.active ? "text-success" : "text-muted-foreground"}>{a.active ? "active" : "inactive"}</span>
                  </div>
                ))}
                <p className="pt-1 text-[11px] text-muted-foreground">Maintained by SYSADMIN in ADE_DB.GUARD.APPROVERS.</p>
              </CardContent>
            </Card>
            <Card>
              <CardHeader className="pb-2"><CardTitle className="flex items-center gap-2"><Database className="size-4 text-primary" /> Managed databases</CardTitle></CardHeader>
              <CardContent className="space-y-2 text-xs">
                {data!.managedDatabases.map((m) => (
                  <div key={m.database} className="flex items-center justify-between">
                    <span className="font-mono">{m.database}</span>
                    <span className={m.active ? "text-success" : "text-muted-foreground"}>{m.active ? "fixes allowed" : "monitor only"}</span>
                  </div>
                ))}
                <div className="pt-1 text-[11px] text-muted-foreground">Add a database (run by an admin):</div>
                <CodeBlock lang="bash" code={`snow sql -f sql/03_scope_grants.sql -D "db=MY_DB" -c <connection>`} />
              </CardContent>
            </Card>
            <Card>
              <CardHeader className="pb-2"><CardTitle className="flex items-center gap-2"><Users className="size-4 text-primary" /> System health</CardTitle></CardHeader>
              <CardContent className="space-y-2">
                {(health.data?.checks ?? []).map((c) => (
                  <div key={c.name} className="rounded-md border bg-card/60 p-2">
                    <div className="flex items-center justify-between text-xs">
                      <span className="font-mono">{c.name}</span>
                      <span className={cn("font-semibold", c.status === "PASS" ? "text-success" : c.status === "WARN" ? "text-warning" : "text-danger")}>{c.status}</span>
                    </div>
                    <div className="mt-1 text-[11px] text-muted-foreground">{c.summary}</div>
                    <div className="text-[10px] text-muted-foreground">{ago(c.checkedAt)}</div>
                  </div>
                ))}
                <Button size="sm" variant="outline" onClick={async () => { await api("/api/health?agent=1", { method: "POST" }).catch(() => {}); void health.refetch() }}>
                  Run agent self-test
                </Button>
              </CardContent>
            </Card>
          </div>
        </div>
      )}
    </main>
  )
}
