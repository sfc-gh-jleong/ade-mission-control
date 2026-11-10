"use client"

import { useEffect, useMemo, useRef, useState } from "react"
import { useQuery } from "@tanstack/react-query"
import { AnimatePresence, motion } from "motion/react"
import ReactMarkdown from "react-markdown"
import remarkGfm from "remark-gfm"
import { ChevronRight, Coins, Cpu, Database, Globe, Terminal, Timer, Wrench } from "lucide-react"
import { api, clock, compactTokens, credits, duration } from "@/lib/client"
import { useLiveEvents } from "@/lib/live"
import { cn } from "@/lib/utils"
import { AgentAvatar, actorOf } from "@/components/ade/agent"
import { StatusPill } from "@/components/ade/status"
import { CodeBlock } from "@/components/ade/code"
import { Skeleton } from "@/components/ui/skeleton"

export interface Step {
  id: string
  seq: number
  parentId: string | null
  agentRunId: string | null
  kind: string
  actor: string
  phase: string | null
  task: string
  status: string
  model: string | null
  effort: string | null
  startedAt: string | null
  endedAt: string | null
  durationMs: number
  inputTokens: number
  uncachedInputTokens: number
  cacheReadTokens: number
  cacheWriteTokens: number
  outputTokens: number
  credits: number | null
  toolName: string | null
  toolType: string | null
  summary: string | null
  error: string | null
  detail: Record<string, unknown> | null
  requestId: string | null
  threadId: string | null
  cortexRunId: string | null
}

function toolIcon(name: string | null) {
  if (!name) return Wrench
  if (name.includes("sql")) return Database
  if (name === "bash" || name === "bash_output") return Terminal
  if (name.startsWith("web")) return Globe
  return Wrench
}

/** Live reasoning stream for steps that are still running. */
function useLiveText(stepIds: Set<string>) {
  const [text, setText] = useState<Record<string, { thinking: string; text: string; status?: string }>>({})
  useLiveEvents((e) => {
    if (!e.stepId || !stepIds.has(String(e.stepId))) return
    const id = String(e.stepId)
    if (e.type === "agent.delta") {
      setText((prev) => {
        const cur = prev[id] ?? { thinking: "", text: "" }
        const channel = e.channel === "thinking" ? "thinking" : "text"
        return { ...prev, [id]: { ...cur, [channel]: (cur[channel] + String(e.text ?? "")).slice(-6000) } }
      })
    } else if (e.type === "agent.status") {
      setText((prev) => ({ ...prev, [id]: { ...(prev[id] ?? { thinking: "", text: "" }), status: `${String(e.status ?? "").replace(/_/g, " ")}${e.message ? ` · ${e.message}` : ""}` } }))
    }
  })
  return text
}

function Payloads({ stepId, kind }: { stepId: string; kind: string }) {
  const { data, isPending } = useQuery({
    queryKey: ["payloads", stepId],
    queryFn: () => api<{ payloads: { kind: string; payload: unknown; bytes: number }[] }>(`/api/steps/${stepId}`),
    staleTime: 60_000,
  })
  if (isPending) return <Skeleton className="h-24" />
  const payloads = data?.payloads ?? []
  if (!payloads.length) return <div className="text-xs text-muted-foreground">No payloads recorded for this step.</div>
  return (
    <div className="space-y-3">
      {payloads.map((p, i) => {
        const v = p.payload as Record<string, unknown> | string | unknown[] | null
        if (p.kind === "TOOL_INPUT" && v && typeof v === "object" && !Array.isArray(v) && typeof (v as Record<string, unknown>).sql === "string") {
          return <CodeBlock key={i} title="SQL" code={String((v as Record<string, unknown>).sql)} />
        }
        if (p.kind === "TOOL_OUTPUT" && Array.isArray(v)) {
          const text = v.map((x) => (typeof x === "string" ? x : JSON.stringify(x, null, 2))).join("\n")
          return <CodeBlock key={i} title="Result" lang="text" code={text.slice(0, 20000)} maxHeight={280} />
        }
        if ((p.kind === "THINKING" || p.kind === "TEXT") && v && typeof v === "object" && "text" in (v as object)) {
          return (
            <div key={i}>
              <div className="mb-1 text-[11px] font-medium uppercase tracking-wider text-muted-foreground">{p.kind === "THINKING" ? "Reasoning" : "Response"}</div>
              <div className="prose-agent max-h-80 overflow-auto rounded-lg border bg-surface-2 p-3 text-[13px] leading-relaxed scrollbar-thin">
                <ReactMarkdown remarkPlugins={[remarkGfm]}>{String((v as { text: string }).text)}</ReactMarkdown>
              </div>
            </div>
          )
        }
        if (p.kind === "PROMPT" && v && typeof v === "object" && "prompt" in (v as object)) {
          return <CodeBlock key={i} title="Prompt sent to the agent" lang="markdown" code={String((v as { prompt: string }).prompt)} maxHeight={320} />
        }
        if (p.kind === "STATUS_TIMELINE" && Array.isArray(v)) {
          return (
            <div key={i}>
              <div className="mb-1 text-[11px] font-medium uppercase tracking-wider text-muted-foreground">Status timeline</div>
              <ol className="space-y-1 font-mono text-[11px] text-muted-foreground">
                {(v as { at: string; status: string; message?: string }[]).map((s, j) => (
                  <li key={j}>
                    <span className="text-foreground/70">{new Date(s.at).toLocaleTimeString()}</span> {s.status}
                    {s.message ? ` — ${s.message}` : ""}
                  </li>
                ))}
              </ol>
            </div>
          )
        }
        return <CodeBlock key={i} title={p.kind.replace(/_/g, " ").toLowerCase()} lang="json" code={JSON.stringify(v, null, 2).slice(0, 30000)} maxHeight={320} />
      })}
      <div className="text-[10px] text-muted-foreground">Step kind {kind}</div>
    </div>
  )
}

function TokenBar({ s }: { s: Step }) {
  const total = s.inputTokens + s.outputTokens
  if (!total) return null
  const seg = [
    { v: s.cacheReadTokens, c: "bg-chart-4/70", l: "cache read" },
    { v: s.cacheWriteTokens, c: "bg-chart-3/70", l: "cache write" },
    { v: s.uncachedInputTokens, c: "bg-chart-1/70", l: "uncached input" },
    { v: s.outputTokens, c: "bg-chart-2/80", l: "output" },
  ]
  return (
    <div className="space-y-1">
      <div className="flex h-1.5 overflow-hidden rounded-full bg-muted">
        {seg.map((x) => (x.v ? <div key={x.l} className={x.c} style={{ width: `${(x.v / total) * 100}%` }} title={`${x.l}: ${x.v.toLocaleString()}`} /> : null))}
      </div>
      <div className="flex flex-wrap gap-x-3 gap-y-0.5 text-[10px] text-muted-foreground">
        {seg.map((x) => (
          <span key={x.l} className="inline-flex items-center gap-1">
            <span className={cn("size-1.5 rounded-full", x.c)} />
            {x.l} {compactTokens(x.v)}
          </span>
        ))}
      </div>
    </div>
  )
}

export function AgentTrace({ steps, focusStepId }: { steps: Step[]; focusStepId?: string | null }) {
  const [open, setOpen] = useState<Set<string>>(() => new Set(focusStepId ? [focusStepId] : []))
  const runningIds = useMemo(() => new Set(steps.filter((s) => s.status === "RUNNING").map((s) => s.id)), [steps])
  const live = useLiveText(runningIds)
  const focusRef = useRef<HTMLLIElement | null>(null)
  useEffect(() => {
    focusRef.current?.scrollIntoView({ behavior: "smooth", block: "center" })
  }, [focusStepId])

  const roots = steps.filter((s) => !s.parentId)
  const children = useMemo(() => {
    const m = new Map<string, Step[]>()
    for (const s of steps) if (s.parentId) m.set(s.parentId, [...(m.get(s.parentId) ?? []), s])
    return m
  }, [steps])
  const t0 = steps.length ? Math.min(...steps.map((s) => (s.startedAt ? new Date(s.startedAt).getTime() : Infinity))) : 0
  const t1 = steps.length ? Math.max(...steps.map((s) => (s.endedAt ? new Date(s.endedAt).getTime() : Date.now()))) : 1
  const span = Math.max(1, t1 - t0)

  if (!steps.length) return <div className="rounded-lg border border-dashed p-8 text-center text-sm text-muted-foreground">No agent steps yet.</div>

  const toggle = (id: string) => setOpen((prev) => {
    const next = new Set(prev)
    if (next.has(id)) next.delete(id)
    else next.add(id)
    return next
  })

  const Row = ({ s, depth }: { s: Step; depth: number }) => {
    const a = actorOf(s.actor)
    const start = s.startedAt ? new Date(s.startedAt).getTime() : t0
    const end = s.endedAt ? new Date(s.endedAt).getTime() : Date.now()
    const left = ((start - t0) / span) * 100
    const width = Math.max(0.6, ((end - start) / span) * 100)
    const isOpen = open.has(s.id)
    const kids = children.get(s.id) ?? []
    const ToolIcon = toolIcon(s.toolName)
    const liveText = live[s.id]
    const web = Boolean((s.detail as Record<string, unknown> | null)?.webAccess)
    return (
      <li ref={s.id === focusStepId ? focusRef : undefined} className={cn(depth > 0 && "border-l border-dashed border-border/80 pl-3")}>
        <button
          type="button"
          onClick={() => toggle(s.id)}
          className={cn("group grid w-full grid-cols-[1fr_auto] items-center gap-3 rounded-lg px-2 py-2 text-left transition-colors hover:bg-accent/50", s.id === focusStepId && "ring-1 ring-primary/40")}
          aria-expanded={isOpen}
        >
          <div className="flex min-w-0 items-center gap-2.5">
            <ChevronRight className={cn("size-3.5 shrink-0 text-muted-foreground transition-transform", isOpen && "rotate-90")} />
            {s.kind === "TOOL_CALL" ? (
              <span className={cn("inline-flex size-6 shrink-0 items-center justify-center rounded-md bg-muted", a.text)}>
                <ToolIcon className="size-3.5" />
              </span>
            ) : (
              <AgentAvatar actor={s.actor} size="sm" pulse={s.status === "RUNNING"} />
            )}
            <div className="min-w-0">
              <div className="flex items-center gap-2">
                <span className={cn("truncate text-[13px]", s.kind === "TOOL_CALL" ? "text-foreground/90" : "font-medium")}>{s.task}</span>
                {web && <span className="rounded bg-warning/15 px-1 text-[10px] text-warning">web access</span>}
              </div>
              <div className="flex items-center gap-2 truncate text-[11px] text-muted-foreground">
                <span className={a.text}>{a.label}</span>
                {s.phase && <span>· {s.phase.toLowerCase()}</span>}
                {s.model && <span className="font-mono">· {s.model}</span>}
                {s.effort && <span>· effort {s.effort}</span>}
                {s.status === "RUNNING" && liveText?.status && <span className="truncate text-primary">· {liveText.status}</span>}
              </div>
            </div>
          </div>
          <div className="flex items-center gap-3">
            <div className="hidden w-40 md:block" aria-hidden>
              <div className="relative h-2 rounded-full bg-muted/70">
                <div className={cn("absolute inset-y-0 rounded-full", s.status === "FAILED" ? "bg-danger/80" : s.status === "RUNNING" ? cn(a.dot, "animate-pulse-soft") : a.dot)} style={{ left: `${left}%`, width: `${Math.min(100 - left, width)}%` }} />
              </div>
            </div>
            <span className="text-tabular w-14 text-right text-[11px] text-muted-foreground">{s.status === "RUNNING" ? "…" : duration(s.durationMs)}</span>
            <span className="text-tabular hidden w-14 text-right text-[11px] text-muted-foreground sm:inline">{s.inputTokens + s.outputTokens ? compactTokens(s.inputTokens + s.outputTokens) : ""}</span>
            <StatusPill status={s.status} />
          </div>
        </button>

        <AnimatePresence initial={false}>
          {isOpen && (
            <motion.div initial={{ height: 0, opacity: 0 }} animate={{ height: "auto", opacity: 1 }} exit={{ height: 0, opacity: 0 }} transition={{ duration: 0.18 }} className="overflow-hidden">
              <div className="mb-2 ml-8 space-y-3 rounded-lg border bg-card/70 p-3">
                <div className="grid grid-cols-2 gap-x-6 gap-y-1.5 text-[12px] sm:grid-cols-4">
                  <Meta icon={Timer} label="Time taken" value={duration(s.durationMs)} sub={`${clock(s.startedAt)} → ${s.endedAt ? new Date(s.endedAt).toLocaleTimeString() : "running"}`} />
                  <Meta icon={Cpu} label="Model" value={s.model ?? (s.kind === "SYSTEM" ? "—" : "inherited")} sub={s.effort ? `thinking ${s.effort}` : undefined} />
                  <Meta icon={Coins} label="Tokens" value={s.inputTokens + s.outputTokens ? `${compactTokens(s.inputTokens)} in · ${compactTokens(s.outputTokens)} out` : "—"} sub={s.credits !== null ? `${credits(s.credits)} credits` : undefined} />
                  <Meta icon={Wrench} label="Task" value={s.kind === "TOOL_CALL" ? (s.toolName ?? "tool") : s.kind.toLowerCase()} sub={s.phase ?? undefined} />
                </div>
                {s.kind === "TURN" && <TokenBar s={s} />}
                {(s.summary || s.error) && (
                  <div className={cn("rounded-md px-3 py-2 text-[12.5px]", s.error ? "bg-danger/10 text-danger" : "bg-muted/60")}>{s.error ?? s.summary}</div>
                )}
                {s.status === "RUNNING" && liveText && (liveText.thinking || liveText.text) && (
                  <div className="prose-agent max-h-64 overflow-auto rounded-lg border border-primary/30 bg-primary/5 p-3 text-[13px] scrollbar-thin">
                    <div className="mb-1 text-[10px] uppercase tracking-wider text-primary">Live</div>
                    <ReactMarkdown remarkPlugins={[remarkGfm]}>{(liveText.text || liveText.thinking).slice(-3000)}</ReactMarkdown>
                  </div>
                )}
                {s.status !== "RUNNING" && <Payloads stepId={s.id} kind={s.kind} />}
                {(s.requestId || s.threadId || s.cortexRunId) && (
                  <div className="flex flex-wrap gap-x-4 gap-y-1 border-t pt-2 font-mono text-[10px] text-muted-foreground">
                    {s.cortexRunId && <span>run {s.cortexRunId}</span>}
                    {s.threadId && <span>thread {s.threadId}</span>}
                    {s.requestId && <span>request {s.requestId}</span>}
                  </div>
                )}
              </div>
            </motion.div>
          )}
        </AnimatePresence>
        {kids.length > 0 && (
          <ul className="ml-5 mt-0.5 space-y-0.5">
            {kids.map((k) => (
              <Row key={k.id} s={k} depth={depth + 1} />
            ))}
          </ul>
        )}
      </li>
    )
  }

  return (
    <ul className="space-y-0.5">
      {roots.map((s) => (
        <Row key={s.id} s={s} depth={0} />
      ))}
    </ul>
  )
}

function Meta({ icon: Icon, label, value, sub }: { icon: typeof Timer; label: string; value: string; sub?: string }) {
  return (
    <div className="min-w-0">
      <div className="flex items-center gap-1 text-[10px] uppercase tracking-wider text-muted-foreground">
        <Icon className="size-3" /> {label}
      </div>
      <div className="text-tabular truncate font-medium">{value}</div>
      {sub && <div className="truncate text-[10px] text-muted-foreground">{sub}</div>}
    </div>
  )
}
