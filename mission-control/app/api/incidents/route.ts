import { listIncidents } from "@/lib/server/queries"
import { errorResponse } from "@/lib/server/http"

export const dynamic = "force-dynamic"

const VIEWS = new Set(["all", "open", "active", "attention", "resolved", "backlog"])

export async function GET(req: Request) {
  try {
    const url = new URL(req.url)
    const view = url.searchParams.get("view") ?? "open"
    const q = (url.searchParams.get("q") ?? "").trim().slice(0, 200)
    const incidents = await listIncidents({ view: VIEWS.has(view) ? view : "open", q: q || undefined })
    return Response.json({ incidents })
  } catch (e) {
    return errorResponse("incidents", e)
  }
}
