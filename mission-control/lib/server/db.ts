/**
 * Owner's-rights SQL for background work (orchestrator, detector glue, agent
 * telemetry). Runs as the app's service identity (ADE_APP_ROLE) when deployed and
 * as the local snow CLI connection in dev.
 *
 * Route handlers that must act as the signed-in user (approvals) use
 * querySnowflake(..., { callersRights: true }) from "@/lib/snowflake" instead.
 * Everything under lib/server/ is server-only; never import it from a client component.
 */
import * as sdk from "@/lib/sar-sdk"

export type Row = Record<string, unknown>
export type Bind = string | number | boolean | null

/** Run one statement with `?` binds. Never interpolate user or agent input. */
export async function sql<T = Row>(text: string, binds: Bind[] = []): Promise<T[]> {
  return (await sdk.querySnowflake(text, { binds: binds as never })) as T[]
}

/** Long-running variant (sandbox rehearsals, EXECUTE TASK ... AWAIT, detector backfill). */
export async function sqlLong<T = Row>(text: string, binds: Bind[] = [], maxWaitMs = 30 * 60_000): Promise<T[]> {
  return (await sdk.querySnowflakeLongRunning(text, { binds: binds as never, maxWaitMs, pollIntervalMs: 2000 })) as T[]
}

export async function sqlOne<T = Row>(text: string, binds: Bind[] = []): Promise<T | null> {
  const rows = await sql<T>(text, binds)
  return rows[0] ?? null
}

/** VARIANT/ARRAY/OBJECT bind: pass JSON text and wrap the placeholder in PARSE_JSON(?). */
export function json(value: unknown): string | null {
  return value === undefined || value === null ? null : JSON.stringify(value)
}

/** Snowflake returns TIMESTAMP columns as Date objects; normalise at the boundary. */
export function iso(value: unknown): string | null {
  if (value === null || value === undefined || value === "") return null
  if (value instanceof Date) return value.toISOString()
  const d = new Date(String(value))
  return Number.isNaN(d.getTime()) ? String(value) : d.toISOString()
}

/** VARIANT columns arrive as parsed objects or JSON strings depending on driver path. */
export function parseVariant<T = unknown>(value: unknown): T | null {
  if (value === null || value === undefined) return null
  if (typeof value === "string") {
    try {
      return JSON.parse(value) as T
    } catch {
      return value as T
    }
  }
  return value as T
}

export function num(value: unknown): number {
  if (value === null || value === undefined || value === "") return 0
  const n = typeof value === "number" ? value : Number(value)
  return Number.isFinite(n) ? n : 0
}

export function isDeployed(): boolean {
  return Boolean(sdk.getServiceToken())
}
