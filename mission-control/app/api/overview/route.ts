import { overview } from "@/lib/server/queries"
import { orchestratorState } from "@/lib/server/orchestrator"
import { errorResponse } from "@/lib/server/http"

export const dynamic = "force-dynamic"

export async function GET() {
  try {
    const data = await overview()
    return Response.json({ ...data, orchestrator: orchestratorState() })
  } catch (e) {
    return errorResponse("overview", e)
  }
}
