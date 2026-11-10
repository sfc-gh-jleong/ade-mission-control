import { getIncident } from "@/lib/server/queries"
import { errorResponse } from "@/lib/server/http"

export const dynamic = "force-dynamic"

export async function GET(_req: Request, ctx: { params: Promise<{ id: string }> }) {
  try {
    const { id } = await ctx.params
    const data = await getIncident(decodeURIComponent(id))
    if (!data) return Response.json({ error: "Incident not found" }, { status: 404 })
    return Response.json(data)
  } catch (e) {
    return errorResponse("incident", e)
  }
}
