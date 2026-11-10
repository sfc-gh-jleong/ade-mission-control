"use client"

import { useEffect, useState } from "react"
import { codeToHtml } from "shiki"
import { Check, Copy } from "lucide-react"
import { copyText } from "@/lib/clipboard"
import { cn } from "@/lib/utils"

/** Syntax-highlighted code (shiki, bundled locally; no network). */
export function CodeBlock({ code, lang = "sql", className, title, maxHeight = 420 }: { code: string; lang?: string; className?: string; title?: string; maxHeight?: number }) {
  const [html, setHtml] = useState<string | null>(null)
  const [copied, setCopied] = useState(false)
  useEffect(() => {
    let alive = true
    codeToHtml(code, { lang, themes: { light: "github-light", dark: "github-dark-dimmed" }, defaultColor: false })
      .then((h) => alive && setHtml(h))
      .catch(() => alive && setHtml(null))
    return () => {
      alive = false
    }
  }, [code, lang])
  return (
    <div className={cn("code-block group relative overflow-hidden rounded-lg border bg-surface-2", className)}>
      {title && <div className="border-b px-3 py-1.5 font-mono text-[11px] text-muted-foreground">{title}</div>}
      <button
        type="button"
        onClick={async () => {
          if (await copyText(code)) {
            setCopied(true)
            setTimeout(() => setCopied(false), 1500)
          }
        }}
        className="absolute right-2 top-2 z-10 rounded-md border bg-card/80 p-1.5 text-muted-foreground opacity-0 backdrop-blur transition group-hover:opacity-100 focus:opacity-100"
        aria-label="Copy code"
      >
        {copied ? <Check className="size-3.5 text-success" /> : <Copy className="size-3.5" />}
      </button>
      <div className="scrollbar-thin overflow-auto" style={{ maxHeight }}>
        {html ? (
          <div className="[&_.shiki]:!bg-transparent [&_span]:[color:var(--shiki-light)] dark:[&_span]:[color:var(--shiki-dark)]" dangerouslySetInnerHTML={{ __html: html }} />
        ) : (
          <pre className="px-4 py-3.5 font-mono text-[12.5px] leading-relaxed whitespace-pre-wrap">{code}</pre>
        )}
      </div>
    </div>
  )
}
