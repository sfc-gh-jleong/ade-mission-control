/**
 * Agent registry: keeps the three saved Cortex Agent objects in ADE_DB.AGENTS in
 * sync with lib/server/agents/definitions.ts, through the Cortex Agent SDK.
 *
 * Runs at boot (as the app's service identity, so the agents are owned by
 * ADE_APP_ROLE) and whenever models are changed in Settings. It creates missing
 * agents and updates an agent only when its spec hash differs.
 */
import { createHash } from "node:crypto"
import { CortexAgentClient as ApiAgentClient } from "@snowflake/cortex-agent-sdk/api"
import { AGENT_ROLES, type AgentRole } from "@/lib/domain"
import { getSnowflakeBaseUrl } from "@/lib/sar-sdk"
import { appAuthenticator, PARTNER_APPLICATION } from "@/lib/server/cortex"
import { sql, json } from "@/lib/server/db"
import { nowIso } from "@/lib/server/events"
import {
  AGENT_DATABASE,
  AGENT_NAMES,
  AGENT_SCHEMA,
  BUDGETS,
  DEFAULT_MODELS,
  INSTRUCTIONS,
  PROFILES,
  SUBMIT_TOOL_SPECS,
} from "@/lib/server/agents/definitions"

export interface AgentSpecSummary {
  role: AgentRole
  name: string
  fqn: string
  model: string
  specHash: string
  action: "created" | "updated" | "unchanged" | "error"
  error?: string
}

const g = globalThis as unknown as { __adeApiClient?: ApiAgentClient; __adeAgentSpecs?: Map<AgentRole, AgentSpecSummary> }

function apiClient(): ApiAgentClient {
  if (!g.__adeApiClient) {
    const baseUrl = getSnowflakeBaseUrl()
    if (!baseUrl) throw new Error("Cannot determine the Snowflake account URL")
    g.__adeApiClient = new ApiAgentClient({ baseUrl, auth: appAuthenticator(), partnerApplication: PARTNER_APPLICATION })
  }
  return g.__adeApiClient
}

export function agentFqn(role: AgentRole): string {
  return `${AGENT_DATABASE}.${AGENT_SCHEMA}.${AGENT_NAMES[role]}`
}

/** Models from Settings (models.investigator / models.fixer / models.reviewer). */
export async function configuredModels(): Promise<Record<AgentRole, string>> {
  const models = { ...DEFAULT_MODELS }
  try {
    const rows = await sql<{ SETTING_KEY: string; V: string }>(
      `SELECT SETTING_KEY, SETTING_VALUE::STRING AS V FROM ADE_DB.OPS.SETTINGS WHERE SETTING_KEY LIKE 'models.%'`,
    )
    for (const r of rows) {
      const role = r.SETTING_KEY.split(".")[1]?.toUpperCase() as AgentRole
      if (AGENT_ROLES.includes(role) && r.V && /^[a-z0-9][a-z0-9.\-]{1,63}$/i.test(r.V)) models[role] = r.V
    }
  } catch (e) {
    console.error(nowIso(), "[agents] could not read model settings, using defaults", e)
  }
  return models
}

export function desiredSpec(role: AgentRole, model: string) {
  return {
    comment: `ADE Mission Control ${role.toLowerCase()} agent (managed by the app; edits here are overwritten)`,
    profile: PROFILES[role],
    models: { orchestration: model },
    orchestration: { budget: BUDGETS[role] },
    instructions: { system: INSTRUCTIONS[role] },
    tools: [{ tool_spec: { type: "code_toolset_all", name: "code_toolset_all" } }, SUBMIT_TOOL_SPECS[role]],
    tool_resources: { code_toolset_all: { permission_policy: { type: "always_allow" } } },
  }
}

export function specHash(spec: unknown): string {
  return createHash("sha256").update(JSON.stringify(spec)).digest("hex").slice(0, 16)
}

/** Create or update the three agents. Safe to call repeatedly. */
export async function syncAgents(): Promise<AgentSpecSummary[]> {
  const models = await configuredModels()
  const target = { database: AGENT_DATABASE, schema: AGENT_SCHEMA }
  const results: AgentSpecSummary[] = []
  for (const role of AGENT_ROLES) {
    const name = AGENT_NAMES[role]
    const spec = desiredSpec(role, models[role])
    const hash = specHash(spec)
    const summary: AgentSpecSummary = { role, name, fqn: agentFqn(role), model: models[role], specHash: hash, action: "unchanged" }
    try {
      let existingHash: string | null = null
      let exists = false
      try {
        const desc = await apiClient().agent.describe({ ...target, name })
        exists = true
        const body = desc.responseBody as unknown as { agent_spec?: string | Record<string, unknown> }
        const live = typeof body.agent_spec === "string" ? JSON.parse(body.agent_spec) : body.agent_spec
        existingHash = live ? specHash(normalizeLiveSpec(live, spec)) : null
      } catch (e) {
        if (!isNotFound(e)) throw e
      }
      if (!exists) {
        await apiClient().agent.create(target, { name, ...(spec as Record<string, unknown>) } as never)
        summary.action = "created"
      } else if (existingHash !== hash) {
        await apiClient().agent.update({ ...target, name }, spec as never)
        summary.action = "updated"
      }
    } catch (e) {
      summary.action = "error"
      summary.error = e instanceof Error ? e.message : String(e)
    }
    results.push(summary)
  }
  g.__adeAgentSpecs = new Map(results.map((r) => [r.role, r]))
  await sql(
    `INSERT INTO ADE_DB.TELEMETRY.HEALTH_CHECKS (CHECK_NAME, STATUS, DURATION_MS, SUMMARY, DETAIL, INSTANCE)
     SELECT 'AGENT_REGISTRY', ?, 0, ?, PARSE_JSON(?), 'registry'`,
    [
      results.some((r) => r.action === "error") ? "FAIL" : "PASS",
      results.map((r) => `${r.name} (${r.model}): ${r.action}`).join("; "),
      json(results),
    ],
  ).catch((e) => console.error(nowIso(), "[agents] could not record registry check", e))
  return results
}

/** Current spec hash per agent (from the last sync), for AGENT_RUNS.AGENT_SPEC_HASH. */
export function currentSpec(role: AgentRole): AgentSpecSummary | undefined {
  return g.__adeAgentSpecs?.get(role)
}

/** Keep only the keys we manage, in the same order, so hashes compare like for like. */
function normalizeLiveSpec(live: Record<string, unknown>, desired: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {}
  for (const key of Object.keys(desired)) out[key] = live[key]
  return out
}

function isNotFound(e: unknown): boolean {
  const msg = e instanceof Error ? e.message : String(e)
  const status = (e as { status?: number })?.status
  return status === 404 || /does not exist|not found|404/i.test(msg)
}
