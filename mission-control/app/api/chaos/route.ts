import { z } from "zod"
import { sql, sqlLong, parseVariant } from "@/lib/server/db"
import { errorResponse, readJson } from "@/lib/server/http"

export const dynamic = "force-dynamic"

export const SCENARIOS = [
  { id: "drop_target_table", label: "Dropped target table", job: "BUILD_DAILY_REVENUE", description: "MART.DAILY_REVENUE is dropped; the revenue build fails to find it." },
  { id: "upstream_column_rename", label: "Upstream column rename", job: "CLEAN_ORDERS", description: "The source team renames RAW.ORDERS.CHANNEL to SALES_CHANNEL and updates their loader." },
  { id: "bad_numeric_values", label: "Malformed amounts", job: "CLEAN_ORDERS", description: "Orders arrive with amounts like 'N/A' and '1,299.00'." },
  { id: "duplicate_source_rows", label: "Duplicate source rows", job: "CLEAN_ORDERS", description: "The platform re-sends corrected copies of recent orders; the MERGE hits duplicates." },
  { id: "zero_revenue_division", label: "Division by zero", job: "BUILD_DAILY_REVENUE", description: "Free promotional orders make a channel's revenue zero." },
  { id: "dt_column_rename", label: "Dynamic table drift", job: "CUSTOMER_LTV", description: "RAW.CUSTOMERS.REGION is renamed; the LTV dynamic table can no longer refresh." },
] as const

const Body = z.discriminatedUnion("action", [
  z.object({ action: z.literal("break"), scenario: z.enum(SCENARIOS.map((s) => s.id) as [string, ...string[]]) }),
  z.object({ action: z.literal("reset") }),
  z.object({ action: z.literal("run") }),
])

export async function GET() {
  return Response.json({ scenarios: SCENARIOS })
}

/** Chaos Lab: break or reset the ADE_DEMO_RETAIL demo pipeline (SECURE procedures in ADE_DB.CHAOS). */
export async function POST(req: Request) {
  try {
    const parsed = Body.safeParse(await readJson(req))
    if (!parsed.success) return Response.json({ error: "Invalid request" }, { status: 400 })
    const b = parsed.data
    const rows =
      b.action === "break"
        ? await sqlLong(`CALL ADE_DB.CHAOS.BREAK_DEMO(?)`, [b.scenario], 10 * 60_000)
        : b.action === "reset"
          ? await sqlLong(`CALL ADE_DB.CHAOS.RESET_DEMO()`, [], 10 * 60_000)
          : await sql(`CALL ADE_DB.CHAOS.RUN_DEMO()`)
    const value = rows[0] ? Object.values(rows[0])[0] : null
    // Ask the detector to look right away instead of waiting for its schedule.
    await sql(`CALL ADE_DB.CORE.REQUEST_SCAN()`).catch(() => {})
    return Response.json({ result: parseVariant(value) })
  } catch (e) {
    return errorResponse("chaos", e)
  }
}
