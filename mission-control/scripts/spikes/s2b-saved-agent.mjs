// Spike S2b: saved (named) Cortex Agent object carrying code_toolset_all +
// a client-side submit tool, run by name, then updated. Verifies the update is
// what the next run uses (no stale default version).
//
//   node scripts/spikes/s2b-saved-agent.mjs
import { createHash, createPrivateKey, createPublicKey, sign } from "node:crypto"
import fs from "node:fs"
import { CortexAgentClient as ApiClient } from "@snowflake/cortex-agent-sdk/api"
import { CortexAgentClient } from "@snowflake/cortex-agent-sdk"

const ACCOUNT = "SFSENORTHAMERICA-JLEONG_AWS1"
const USER = "JLEONG"
const KEY_FILE = "/Users/jleong/Documents/rsa_key.p8"
const BASE_URL = "https://sfsenorthamerica-jleong-aws1.snowflakecomputing.com"
const TARGET = { database: "ADE_DB", schema: "AGENTS" }
const NAME = "ADE_SPIKE_AGENT"

function mintJwt() {
  const now = Math.floor(Date.now() / 1000)
  const privateKey = createPrivateKey({ key: fs.readFileSync(KEY_FILE, "utf8") })
  const der = createPublicKey(privateKey).export({ type: "spki", format: "der" })
  const fp = `SHA256:${createHash("sha256").update(der).digest("base64")}`
  const q = `${ACCOUNT}.${USER}`
  const b64 = (v) => Buffer.from(v).toString("base64url")
  const unsigned = `${b64(JSON.stringify({ alg: "RS256", typ: "JWT" }))}.${b64(JSON.stringify({ iss: `${q}.${fp}`, sub: q, iat: now, exp: now + 3300 }))}`
  return `${unsigned}.${sign("RSA-SHA256", Buffer.from(unsigned), privateKey).toString("base64url")}`
}
const auth = { async getAuthHeaders() { return { Authorization: `Bearer ${mintJwt()}`, "X-Snowflake-Authorization-Token-Type": "KEYPAIR_JWT" } } }
const api = new ApiClient({ baseUrl: BASE_URL, auth, partnerApplication: "ade_mission_control" })
const client = new CortexAgentClient({ baseUrl: BASE_URL, auth, partnerApplication: "ade_mission_control" })

const submit = {
  tool_spec: {
    type: "generic",
    name: "submit_answer",
    description: "Submit the final answer. Call exactly once.",
    input_schema: { type: "object", properties: { marker: { type: "string" }, sql_user: { type: "string" }, sql_role: { type: "string" } }, required: ["marker", "sql_user", "sql_role"] },
  },
}
const spec = (marker) => ({
  comment: "ADE spike agent (safe to drop)",
  profile: { display_name: "ADE Spike" },
  models: { orchestration: "claude-sonnet-5" },
  orchestration: { budget: { seconds: 240, tokens: 300000 } },
  instructions: { system: `Your secret marker is ${marker}. Run SELECT CURRENT_USER(), CURRENT_ROLE() with your SQL tool, then call submit_answer with the marker and the results.` },
  tools: [{ tool_spec: { type: "code_toolset_all", name: "code_toolset_all" } }, submit],
  tool_resources: { code_toolset_all: { permission_policy: { type: "always_allow" } } },
})

const t0 = Date.now()
const ms = () => `${String(Date.now() - t0).padStart(6)}ms`

try { await api.agent.delete({ ...TARGET, name: NAME }) } catch {}
const created = await api.agent.create(TARGET, { name: NAME, ...spec("ALPHA-1") })
console.log(ms(), "create:", JSON.stringify(created.responseBody ?? created).slice(0, 200))
const desc = await api.agent.describe({ ...TARGET, name: NAME })
console.log(ms(), "describe keys:", Object.keys(desc.responseBody ?? {}).join(","))

async function runOnce(label) {
  const conv = await client.conversations.create({
    thread: { origin_application: "ade_spike" },
    agent: { type: "data", spec: { ...TARGET, name: NAME } },
  })
  const turn = await conv.send("Go.")
  let submitted = null
  for await (const ev of turn.events()) {
    if (ev.event === "response.status") console.log(ms(), label, "status", ev.status)
    if (ev.event === "response.tool_use") {
      console.log(ms(), label, "tool_use", ev.type, ev.name, "client_side:", ev.client_side_execute)
      if (ev.client_side_execute) submitted = ev.input
    }
    if (ev.event === "response.tool_result") console.log(ms(), label, "tool_result", ev.name, ev.status, JSON.stringify(ev.content ?? []).slice(0, 160))
    if (ev.event === "error") console.log(ms(), label, "ERROR", ev.code, ev.message)
    if (ev.event === "response") console.log(ms(), label, "response", ev.status, "model", ev.metadata?.orchestration_model, "effort", ev.metadata?.thinking_effort)
  }
  const res = await turn.result()
  console.log(ms(), label, "submitted:", JSON.stringify(submitted), "requestId", res.requestId)
  return submitted
}

const a = await runOnce("run#1")
await api.agent.update({ ...TARGET, name: NAME }, spec("BRAVO-2"))
console.log(ms(), "updated instructions to BRAVO-2")
const b = await runOnce("run#2")
console.log("RESULT:", { run1: a?.marker, run2: b?.marker, updateHonoured: b?.marker === "BRAVO-2" })
