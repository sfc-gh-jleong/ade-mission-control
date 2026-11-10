/** Client-side fetch helper: JSON in, JSON out, errors as Error with the API's message. */
export async function api<T>(url: string, init?: RequestInit & { json?: unknown }): Promise<T> {
  const res = await fetch(url, {
    ...init,
    headers: { "Content-Type": "application/json", ...(init?.headers ?? {}) },
    body: init?.json !== undefined ? JSON.stringify(init.json) : init?.body,
  })
  const text = await res.text()
  const data = text ? JSON.parse(text) : {}
  if (!res.ok) throw new Error((data as { error?: string }).error ?? `Request failed (${res.status})`)
  return data as T
}

export function compactTokens(n: number | null | undefined): string {
  if (n === null || n === undefined || !Number.isFinite(n)) return "—"
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(n >= 10_000_000 ? 0 : 1)}M`
  if (n >= 1_000) return `${(n / 1_000).toFixed(n >= 10_000 ? 0 : 1)}k`
  return String(Math.round(n))
}

export function duration(ms: number | null | undefined): string {
  if (ms === null || ms === undefined || !Number.isFinite(ms) || ms <= 0) return "—"
  if (ms < 1000) return `${Math.round(ms)} ms`
  const s = ms / 1000
  if (s < 60) return `${s.toFixed(s < 10 ? 1 : 0)} s`
  const m = Math.floor(s / 60)
  const rs = Math.round(s % 60)
  if (m < 60) return `${m}m ${rs.toString().padStart(2, "0")}s`
  const h = Math.floor(m / 60)
  return `${h}h ${(m % 60).toString().padStart(2, "0")}m`
}

export function ago(iso: string | null | undefined, now = Date.now()): string {
  if (!iso) return "—"
  const t = new Date(iso).getTime()
  if (!Number.isFinite(t)) return "—"
  const s = Math.max(0, Math.round((now - t) / 1000))
  if (s < 45) return "just now"
  if (s < 90) return "1 min ago"
  const m = Math.round(s / 60)
  if (m < 60) return `${m} min ago`
  const h = Math.round(m / 60)
  if (h < 24) return `${h} h ago`
  const d = Math.round(h / 24)
  return `${d} d ago`
}

export function clock(iso: string | null | undefined): string {
  if (!iso) return "—"
  const d = new Date(iso)
  return d.toLocaleString(undefined, { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit", second: "2-digit" })
}

export function credits(n: number | null | undefined): string {
  if (n === null || n === undefined || !Number.isFinite(n)) return "—"
  return n < 0.01 ? n.toFixed(4) : n.toFixed(3)
}
