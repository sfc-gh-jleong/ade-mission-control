import { fleet } from "@/lib/server/queries"
import { errorResponse } from "@/lib/server/http"

export const dynamic = "force-dynamic"

export async function GET() {
  try {
    return Response.json({ jobs: await fleet() })
  } catch (e) {
    return errorResponse("fleet", e)
  }
}
