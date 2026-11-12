import { sql } from "@/lib/server/db"
import { errorResponse } from "@/lib/server/http"
import { checkConnection, githubConfigured } from "@/lib/server/github/client"

export const dynamic = "force-dynamic"

/** Settings page: can Mission Control reach each Git-managed repository as the GitHub App? */
export async function POST() {
  try {
    const { ok, problem } = await githubConfigured()
    const repos = await sql<{ R: string }>(`SELECT DISTINCT REPO AS R FROM ADE_DB.GUARD.MANAGED_DATABASES WHERE DELIVERY = 'PULL_REQUEST' AND REPO IS NOT NULL`)
    if (!ok) return Response.json({ ok: false, results: repos.map((r) => ({ repo: r.R, ok: false, detail: problem })) })
    const results = await Promise.all(repos.map(async (r) => ({ repo: r.R, ...(await checkConnection(r.R)) })))
    return Response.json({ ok: results.every((r) => r.ok), results })
  } catch (e) {
    return errorResponse("github-check", e)
  }
}
