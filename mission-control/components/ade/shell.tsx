"use client"

import Image from "next/image"
import Link from "next/link"
import { usePathname } from "next/navigation"
import { useQuery } from "@tanstack/react-query"
import { Activity, BarChart3, Boxes, FlaskConical, Gauge, ListTree, Settings2, ShieldCheck } from "lucide-react"
import { cn } from "@/lib/utils"
import { api } from "@/lib/client"
import { useLiveStatus } from "@/lib/live"
import { ThemeToggle } from "@/components/theme-toggle"
import { CommandPalette } from "@/components/command-palette"
import { ACTORS } from "@/components/ade/agent"

export const NAV = [
  { href: "/", label: "Command Center", icon: Gauge },
  { href: "/incidents", label: "Incidents", icon: ListTree },
  { href: "/fleet", label: "Fleet", icon: Boxes },
  { href: "/analytics", label: "Analytics", icon: BarChart3 },
  { href: "/chaos", label: "Chaos Lab", icon: FlaskConical },
  { href: "/settings", label: "Settings", icon: Settings2 },
]

interface Overview {
  counts: { active: number; awaiting: number; needsHuman: number; open: number }
  orchestrator: { enabled: boolean; running: number; maxInFlight: number; lastTickAt: string | null } | null
}

function LiveDot() {
  const s = useLiveStatus()
  return (
    <span className="inline-flex items-center gap-1.5 text-[11px] text-muted-foreground" title={`Live updates: ${s}`}>
      <span className="relative flex size-2">
        {s === "live" && <span className="absolute inline-flex size-full animate-ping rounded-full bg-success/70 motion-reduce:animate-none" />}
        <span className={cn("relative inline-flex size-2 rounded-full", s === "live" ? "bg-success" : s === "connecting" ? "bg-warning" : "bg-danger")} />
      </span>
      {s === "live" ? "Live" : s === "connecting" ? "Connecting" : "Offline"}
    </span>
  )
}

export function AppShell({ children }: { children: React.ReactNode }) {
  const path = usePathname()
  const { data } = useQuery({ queryKey: ["overview"], queryFn: () => api<Overview>("/api/overview"), refetchInterval: 30_000 })
  const { data: me } = useQuery({ queryKey: ["me"], queryFn: () => api<{ user: string; approver: boolean }>("/api/me"), staleTime: 5 * 60_000 })
  const attention = (data?.counts.awaiting ?? 0) + (data?.counts.needsHuman ?? 0)
  const orch = data?.orchestrator

  return (
    <div className="flex min-h-screen">
      <aside className="sticky top-0 hidden h-screen w-60 shrink-0 flex-col border-r border-sidebar-border bg-sidebar lg:flex">
        <Link href="/" className="flex items-center gap-2.5 px-5 pb-4 pt-5">
          <Image src="/icon.svg" alt="" width={30} height={30} className="rounded-lg" priority />
          <div className="min-w-0">
            <div className="truncate text-sm font-semibold tracking-tight">ADE Mission Control</div>
            <div className="truncate text-[11px] text-muted-foreground">Autonomous data engineering</div>
          </div>
        </Link>
        <nav className="flex-1 space-y-0.5 px-3" aria-label="Main">
          {NAV.map((item) => {
            const active = item.href === "/" ? path === "/" : path.startsWith(item.href)
            return (
              <Link
                key={item.href}
                href={item.href}
                className={cn(
                  "group flex items-center gap-2.5 rounded-lg px-2.5 py-2 text-[13px] transition-colors",
                  active ? "bg-accent font-medium text-foreground" : "text-muted-foreground hover:bg-accent/60 hover:text-foreground",
                )}
              >
                <item.icon className={cn("size-4", active ? "text-primary" : "opacity-80")} aria-hidden />
                <span className="flex-1">{item.label}</span>
                {item.href === "/incidents" && attention > 0 && (
                  <span className="rounded-full bg-warning/15 px-1.5 text-[10px] font-semibold text-warning ring-1 ring-warning/30">{attention}</span>
                )}
              </Link>
            )
          })}
        </nav>
        <div className="space-y-3 border-t border-sidebar-border p-4">
          <div className="space-y-2">
            <div className="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">Agents</div>
            {(["INVESTIGATOR", "FIXER", "REVIEWER"] as const).map((r) => {
              const a = ACTORS[r]
              return (
                <div key={r} className="flex items-center gap-2 text-[12px]">
                  <span className={cn("size-1.5 rounded-full", a.dot)} />
                  <span className="text-muted-foreground">{a.label}</span>
                </div>
              )
            })}
          </div>
          <div className="rounded-lg border bg-card/60 p-2.5">
            <div className="flex items-center justify-between">
              <span className="flex items-center gap-1.5 text-[11px] font-medium">
                <Activity className={cn("size-3.5", orch?.enabled === false ? "text-danger" : "text-success")} />
                Orchestrator
              </span>
              <span className="text-tabular text-[11px] text-muted-foreground">
                {orch ? (orch.enabled ? `${orch.running}/${orch.maxInFlight} busy` : "paused") : "not running here"}
              </span>
            </div>
            <div className="mt-1.5 flex items-center justify-between">
              <LiveDot />
              {me?.approver && (
                <span className="inline-flex items-center gap-1 text-[10px] text-human" title="You can approve and apply fixes">
                  <ShieldCheck className="size-3" /> Approver
                </span>
              )}
            </div>
          </div>
        </div>
      </aside>

      <div className="flex min-w-0 flex-1 flex-col">
        <header className="sticky top-0 z-30 flex h-14 items-center gap-3 border-b bg-background/80 px-4 backdrop-blur-lg sm:px-6">
          <Link href="/" className="flex items-center gap-2 lg:hidden">
            <Image src="/icon.svg" alt="" width={26} height={26} className="rounded-md" />
            <span className="text-sm font-semibold">ADE</span>
          </Link>
          <nav className="flex gap-1 overflow-x-auto lg:hidden" aria-label="Main (compact)">
            {NAV.map((item) => (
              <Link key={item.href} href={item.href} className={cn("rounded-md px-2 py-1 text-xs", (item.href === "/" ? path === "/" : path.startsWith(item.href)) ? "bg-accent font-medium" : "text-muted-foreground")}>
                {item.label}
              </Link>
            ))}
          </nav>
          <div className="ml-auto flex items-center gap-2">
            <span className="hidden text-xs text-muted-foreground sm:inline">{me?.user ? `Signed in as ${me.user}` : ""}</span>
            <CommandPalette />
            <ThemeToggle />
          </div>
        </header>
        <div className="bg-grid min-h-[calc(100vh-3.5rem)]">{children}</div>
      </div>
    </div>
  )
}
