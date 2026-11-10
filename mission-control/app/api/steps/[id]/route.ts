import { stepPayloads } from "@/lib/server/queries"
import { errorResponse } from "@/lib/server/http"

export const dynamic = "force-dynamic"

/** Bulky payloads of one step (prompt, tool input/output, reasoning, structured output). */
export async function GET(_req: Request, ctx: { params: Promise<{ id: string }> }) {
  try {
    const { id } = await ctx.params
    return Response.json({ payloads: await stepPayloads(decodeURIComponent(id)) })
  } catch (e) {
    return errorResponse("step-payloads", e)
  }
}
