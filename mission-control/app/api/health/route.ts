import { sql, iso, parseVariant } from "@/lib/server/db"
import { checkAgentSandbox, checkSqlIdentity, errorText } from "@/lib/server/selftest"

export const dynamic = "force-dynamic"

/** Latest result per self-test. */
export async function GET() {
  try {
    const rows = await sql(
      `SELECT CHECK_NAME, STATUS, DURATION_MS, SUMMARY, DETAIL, INSTANCE, CHECKED_AT
       FROM ADE_DB.TELEMETRY.HEALTH_CHECKS
       QUALIFY ROW_NUMBER() OVER (PARTITION BY CHECK_NAME ORDER BY CHECKED_AT DESC) = 1
       ORDER BY CHECK_NAME`,
    )
    return Response.json({
      checks: rows.map((r) => ({
        name: r.CHECK_NAME,
        status: r.STATUS,
        durationMs: r.DURATION_MS,
        summary: r.SUMMARY,
        detail: parseVariant(r.DETAIL),
        instance: r.INSTANCE,
        checkedAt: iso(r.CHECKED_AT),
      })),
    })
  } catch (e) {
    console.error(new Date().toISOString(), "[api/health] GET failed", e)
    return Response.json({ error: errorText(e) }, { status: 500 })
  }
}

/** Re-run self-tests. `?agent=1` also runs the (billable) agent sandbox check. */
export async function POST(req: Request) {
  try {
    const withAgent = new URL(req.url).searchParams.get("agent") === "1"
    const results = [await checkSqlIdentity()]
    if (withAgent) results.push(await checkAgentSandbox())
    return Response.json({ results })
  } catch (e) {
    console.error(new Date().toISOString(), "[api/health] POST failed", e)
    return Response.json({ error: errorText(e) }, { status: 500 })
  }
}
