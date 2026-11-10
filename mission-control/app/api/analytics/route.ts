import { analytics } from "@/lib/server/queries"
import { errorResponse } from "@/lib/server/http"

export const dynamic = "force-dynamic"

export async function GET(req: Request) {
  try {
    const days = Number(new URL(req.url).searchParams.get("days") ?? 14)
    return Response.json(await analytics(Number.isFinite(days) ? days : 14))
  } catch (e) {
    return errorResponse("analytics", e)
  }
}
