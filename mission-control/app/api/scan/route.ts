import { sql } from "@/lib/server/db"
import { errorResponse } from "@/lib/server/http"
import { wakeOrchestrator } from "@/lib/server/orchestrator"

export const dynamic = "force-dynamic"

/** "Scan now": run the detector task once (the app can do nothing else to it). */
export async function POST() {
  try {
    await sql(`CALL ADE_DB.CORE.REQUEST_SCAN()`)
    setTimeout(wakeOrchestrator, 20_000)
    return Response.json({ status: "scan requested" })
  } catch (e) {
    return errorResponse("scan", e)
  }
}
