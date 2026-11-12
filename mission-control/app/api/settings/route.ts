import { z } from "zod"
import { sql, parseVariant, iso } from "@/lib/server/db"
import { updateSetting } from "@/lib/server/actions"
import { errorResponse, readJson } from "@/lib/server/http"
import { syncAgents } from "@/lib/server/agents/registry"
import { agentsAllowedHere } from "@/lib/server/cortex"

export const dynamic = "force-dynamic"

const githubId = z.union([z.string().regex(/^\d{1,20}$/), z.number().int().positive()]).transform((v) => String(v))

const EDITABLE: Record<string, z.ZodType> = {
  "pipeline.enabled": z.boolean(),
  "pipeline.max_in_flight": z.number().int().min(1).max(5),
  "pipeline.max_fix_iterations": z.number().int().min(1).max(4),
  "pipeline.auto_rerun_transient": z.boolean(),
  "budget.max_tokens_per_incident": z.number().int().min(100_000).max(20_000_000),
  "budget.max_minutes_per_agent": z.number().int().min(5).max(60),
  "apply.min_confidence": z.number().min(50).max(100),
  "models.investigator": z.string().regex(/^[a-z0-9][a-z0-9.\-]{1,63}$/i),
  "models.fixer": z.string().regex(/^[a-z0-9][a-z0-9.\-]{1,63}$/i),
  "models.reviewer": z.string().regex(/^[a-z0-9][a-z0-9.\-]{1,63}$/i),
  "delivery.github.enabled": z.boolean(),
  "delivery.github.app_id": githubId,
  "delivery.github.installation_id": githubId,
  "delivery.github.base_branch": z.string().regex(/^[A-Za-z0-9._/-]{1,100}$/),
  "delivery.github.poll_seconds": z.number().int().min(15).max(3600),
  "delivery.github.deploy_timeout_minutes": z.number().int().min(5).max(1440),
}

export async function GET() {
  try {
    const [settings, approvers, managed, agents, repoObjects] = await Promise.all([
      sql(`SELECT SETTING_KEY, SETTING_VALUE, DESCRIPTION, UPDATED_BY, UPDATED_AT FROM ADE_DB.OPS.SETTINGS ORDER BY SETTING_KEY`),
      sql(`SELECT USER_NAME, ACTIVE, ADDED_BY, ADDED_AT FROM ADE_DB.GUARD.APPROVERS ORDER BY USER_NAME`),
      sql(`SELECT DATABASE_NAME, ACTIVE, DELIVERY, REPO FROM ADE_DB.GUARD.MANAGED_DATABASES ORDER BY DATABASE_NAME`),
      sql(`SHOW AGENTS IN SCHEMA ADE_DB.AGENTS ->> SELECT "name", "owner", "created_on", "comment" FROM $1`),
      sql(`SELECT DATABASE_NAME, SCHEMA_NAME, OBJECT_NAME, OBJECT_TYPE, REPO_PATH, ADE_MAY_EDIT FROM ADE_DB.GUARD.REPO_OBJECTS ORDER BY 1, 5`).catch(() => []),
    ])
    return Response.json({
      settings: settings.map((s) => ({
        key: s.SETTING_KEY, value: parseVariant(s.SETTING_VALUE), description: s.DESCRIPTION, updatedBy: s.UPDATED_BY,
        updatedAt: iso(s.UPDATED_AT), editable: Boolean(EDITABLE[String(s.SETTING_KEY)]),
      })),
      approvers: approvers.map((a) => ({ user: a.USER_NAME, active: a.ACTIVE, addedBy: a.ADDED_BY, addedAt: iso(a.ADDED_AT) })),
      managedDatabases: managed.map((m) => ({ database: m.DATABASE_NAME, active: m.ACTIVE, delivery: m.DELIVERY ?? "APPLY", repo: m.REPO ?? null })),
      repoObjects: repoObjects.map((o) => ({
        database: o.DATABASE_NAME, object: `${o.SCHEMA_NAME}.${o.OBJECT_NAME}`, type: o.OBJECT_TYPE, path: o.REPO_PATH, mayEdit: Boolean(o.ADE_MAY_EDIT),
      })),
      agents: agents.map((a) => ({ name: a.name, owner: a.owner, createdOn: iso(a.created_on), comment: a.comment })),
    })
  } catch (e) {
    return errorResponse("settings", e)
  }
}

const Body = z.object({ key: z.string(), value: z.unknown() })

/** Change one setting as the signed-in user (caller's rights). Model changes re-sync the agents. */
export async function POST(req: Request) {
  try {
    const parsed = Body.safeParse(await readJson(req))
    if (!parsed.success || !EDITABLE[parsed.data.key]) return Response.json({ error: "Unknown setting" }, { status: 400 })
    const value = EDITABLE[parsed.data.key].safeParse(parsed.data.value)
    if (!value.success) return Response.json({ error: `Invalid value for ${parsed.data.key}` }, { status: 400 })
    await updateSetting(parsed.data.key, value.data)
    let agents = null
    if (parsed.data.key.startsWith("models.") && agentsAllowedHere().allowed) agents = await syncAgents()
    return Response.json({ ok: true, agents })
  } catch (e) {
    return errorResponse("settings-update", e)
  }
}
