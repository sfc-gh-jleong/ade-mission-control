"use client"

import { Bot, Brain, Cog, Search, ShieldCheck, User, Wrench } from "lucide-react"
import { cn } from "@/lib/utils"

/** Visual identity of every actor: colour token, icon and label. */
export const ACTORS: Record<string, { label: string; short: string; text: string; bg: string; ring: string; dot: string; Icon: typeof Bot }> = {
  INVESTIGATOR: { label: "Investigator", short: "INV", text: "text-investigator", bg: "bg-investigator/12", ring: "ring-investigator/30", dot: "bg-investigator", Icon: Search },
  FIXER: { label: "Fixer", short: "FIX", text: "text-fixer", bg: "bg-fixer/12", ring: "ring-fixer/30", dot: "bg-fixer", Icon: Wrench },
  REVIEWER: { label: "Reviewer", short: "REV", text: "text-reviewer", bg: "bg-reviewer/12", ring: "ring-reviewer/30", dot: "bg-reviewer", Icon: ShieldCheck },
  SYSTEM: { label: "System", short: "SYS", text: "text-system", bg: "bg-system/12", ring: "ring-system/30", dot: "bg-system", Icon: Cog },
  HUMAN: { label: "Human", short: "YOU", text: "text-human", bg: "bg-human/12", ring: "ring-human/30", dot: "bg-human", Icon: User },
  DETECTOR: { label: "Detector", short: "DET", text: "text-system", bg: "bg-system/12", ring: "ring-system/30", dot: "bg-system", Icon: Brain },
}

export function actorOf(name: string | null | undefined) {
  return ACTORS[String(name ?? "SYSTEM").toUpperCase()] ?? ACTORS.SYSTEM
}

export function AgentAvatar({ actor, size = "md", pulse = false }: { actor: string; size?: "sm" | "md" | "lg"; pulse?: boolean }) {
  const a = actorOf(actor)
  const dims = size === "sm" ? "size-6" : size === "lg" ? "size-10" : "size-8"
  const icon = size === "sm" ? "size-3.5" : size === "lg" ? "size-5" : "size-4"
  return (
    <span className={cn("relative inline-flex shrink-0 items-center justify-center rounded-lg ring-1", dims, a.bg, a.ring, a.text)}>
      <a.Icon className={icon} aria-hidden />
      {pulse && (
        <span className="absolute -right-0.5 -top-0.5 flex size-2.5">
          <span className={cn("absolute inline-flex size-full animate-ping rounded-full opacity-60 motion-reduce:animate-none", a.dot)} />
          <span className={cn("relative inline-flex size-2.5 rounded-full", a.dot)} />
        </span>
      )}
    </span>
  )
}

export function AgentChip({ actor, className }: { actor: string; className?: string }) {
  const a = actorOf(actor)
  return (
    <span className={cn("inline-flex items-center gap-1.5 rounded-md px-1.5 py-0.5 text-[11px] font-medium ring-1", a.bg, a.ring, a.text, className)}>
      <a.Icon className="size-3" aria-hidden />
      {a.label}
    </span>
  )
}
