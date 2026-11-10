import { listSteps } from "@/lib/server/queries"
import { errorResponse } from "@/lib/server/http"

export const dynamic = "force-dynamic"

export async function GET(_req: Request, ctx: { params: Promise<{ id: string }> }) {
  try {
    const { id } = await ctx.params
    return Response.json({ steps: await listSteps(decodeURIComponent(id)) })
  } catch (e) {
    return errorResponse("steps", e)
  }
}
