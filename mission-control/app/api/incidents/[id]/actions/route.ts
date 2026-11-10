import { z } from "zod"
import { applyFix, approveFix, queueIncident, rejectFix, rollbackFix, runJob, suppressIncident, whoAmI } from "@/lib/server/actions"
import { errorResponse, readJson } from "@/lib/server/http"

export const dynamic = "force-dynamic"

const Body = z.discriminatedUnion("action", [
  z.object({ action: z.literal("approve"), fixId: z.string().min(1), fixHash: z.string().length(64), note: z.string().max(2000).default("") }),
  z.object({ action: z.literal("reject"), fixId: z.string().min(1), note: z.string().max(2000).default("") }),
  z.object({ action: z.literal("apply"), fixId: z.string().min(1), fixHash: z.string().length(64), runAfter: z.boolean().default(true) }),
  z.object({ action: z.literal("rollback"), fixId: z.string().min(1), note: z.string().max(2000).default("") }),
  z.object({ action: z.literal("run_job"), note: z.string().max(2000).default("") }),
  z.object({ action: z.literal("queue") }),
  z.object({ action: z.literal("dismiss"), note: z.string().max(500).default("") }),
])

/** Human actions on an incident. Production-changing ones go through GUARD as the signed-in user. */
export async function POST(req: Request, ctx: { params: Promise<{ id: string }> }) {
  try {
    const { id } = await ctx.params
    const incidentId = decodeURIComponent(id)
    const parsed = Body.safeParse(await readJson(req))
    if (!parsed.success) return Response.json({ error: "Invalid request" }, { status: 400 })
    const b = parsed.data
    switch (b.action) {
      case "approve":
        return Response.json({ result: await approveFix(b.fixId, b.fixHash, b.note) })
      case "reject":
        return Response.json({ result: await rejectFix(b.fixId, b.note) })
      case "apply":
        return Response.json({ result: await applyFix(b.fixId, b.fixHash, b.runAfter) })
      case "rollback":
        return Response.json({ result: await rollbackFix(b.fixId, b.note) })
      case "run_job":
        return Response.json({ result: await runJob(incidentId, b.note || "Manual run from Mission Control") })
      case "queue": {
        const me = await whoAmI()
        await queueIncident(incidentId, me.user)
        return Response.json({ result: { status: "QUEUED" } })
      }
      case "dismiss": {
        const me = await whoAmI()
        await suppressIncident(incidentId, me.user, b.note)
        return Response.json({ result: { status: "SUPPRESSED" } })
      }
    }
  } catch (e) {
    return errorResponse("incident-action", e)
  }
}
