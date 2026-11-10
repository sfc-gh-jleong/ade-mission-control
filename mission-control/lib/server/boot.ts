/**
 * Background work started from instrumentation.ts. Idempotent per process.
 *
 * Deployed: self-tests, agent registry sync (creates/updates the three saved
 * agents through the SDK), then the orchestrator loop. Locally nothing starts
 * unless ADE_BACKGROUND=1, so `npm run dev` never launches agents with a
 * developer's role by accident.
 */
import { agentsAllowedHere } from "@/lib/server/cortex"
import { isDeployed } from "@/lib/server/db"
import { nowIso } from "@/lib/server/events"
import { syncAgents } from "@/lib/server/agents/registry"
import { startOrchestrator } from "@/lib/server/orchestrator"
import { checkAgentSandbox, checkSqlIdentity } from "@/lib/server/selftest"

const g = globalThis as unknown as { __adeBooted?: boolean }

export function startBackground(): void {
  if (g.__adeBooted) return
  g.__adeBooted = true
  if (!isDeployed() && process.env.ADE_BACKGROUND !== "1") {
    console.log(nowIso(), "[boot] local dev: background work disabled (set ADE_BACKGROUND=1 to enable)")
    return
  }
  console.log(nowIso(), "[boot] starting background work")
  setTimeout(() => {
    void (async () => {
      const identity = await checkSqlIdentity()
      console.log(nowIso(), "[boot] SQL_IDENTITY", identity.status, identity.summary)
      if (!agentsAllowedHere().allowed) return
      const agents = await syncAgents()
      console.log(nowIso(), "[boot] agents", agents.map((a) => `${a.name}=${a.action}`).join(" "))
      if (process.env.ADE_SKIP_AGENT_SELFTEST !== "1") {
        const sandbox = await checkAgentSandbox()
        console.log(nowIso(), "[boot] AGENT_SANDBOX", sandbox.status, sandbox.summary)
      }
      startOrchestrator()
    })().catch((e) => {
      console.error(nowIso(), "[boot] startup failed; starting orchestrator anyway", e)
      if (agentsAllowedHere().allowed) startOrchestrator()
    })
  }, 2000)
}
