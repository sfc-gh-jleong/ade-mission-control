// Spike S2/S3: managed Cortex Code (coding agent) + client-side submit tool.
// Verifies: code_toolset_all sandbox SQL, a client-side structured-output tool,
// sendToolResults() round trip, per-event telemetry, and the request id used to
// join CORTEX_AGENT_USAGE_HISTORY (S3).
//
//   node scripts/spikes/s2-coding-agent.mjs
//
// Local auth: key-pair JWT minted from the osm_deploy connection.
import { createHash, createPrivateKey, createPublicKey, sign } from "node:crypto"
import fs from "node:fs"
import { CortexAgentClient } from "@snowflake/cortex-agent-sdk"

const ACCOUNT = "SFSENORTHAMERICA-JLEONG_AWS1"
const USER = "JLEONG"
const KEY_FILE = "/Users/jleong/Documents/rsa_key.p8"
const BASE_URL = "https://sfsenorthamerica-jleong-aws1.snowflakecomputing.com"
const MODEL = process.env.SPIKE_MODEL ?? "claude-sonnet-5"

function mintJwt() {
  const now = Math.floor(Date.now() / 1000)
  const privateKey = createPrivateKey({ key: fs.readFileSync(KEY_FILE, "utf8") })
  const der = createPublicKey(privateKey).export({ type: "spki", format: "der" })
  const fp = `SHA256:${createHash("sha256").update(der).digest("base64")}`
  const qualified = `${ACCOUNT.toUpperCase()}.${USER}`
  const b64 = (v) => Buffer.from(v).toString("base64url")
  const unsigned = `${b64(JSON.stringify({ alg: "RS256", typ: "JWT" }))}.${b64(
    JSON.stringify({ iss: `${qualified}.${fp}`, sub: qualified, iat: now, exp: now + 3300 }),
  )}`
  return `${unsigned}.${sign("RSA-SHA256", Buffer.from(unsigned), privateKey).toString("base64url")}`
}

const client = new CortexAgentClient({
  baseUrl: BASE_URL,
  auth: {
    async getAuthHeaders() {
      return { Authorization: `Bearer ${mintJwt()}`, "X-Snowflake-Authorization-Token-Type": "KEYPAIR_JWT" }
    },
  },
  partnerApplication: "ade_mission_control",
})

const submitDiagnosis = {
  tool_spec: {
    type: "generic",
    name: "submit_diagnosis",
    description:
      "Submit your final diagnosis. Call exactly once, when the investigation is complete. The application records it; do not repeat it in prose.",
    input_schema: {
      type: "object",
      properties: {
        root_cause: { type: "string", description: "One-paragraph root cause" },
        category: { type: "string", enum: ["SCHEMA_DRIFT", "MISSING_OBJECT", "DATA_QUALITY", "LOGIC_BUG", "PERMISSIONS", "RESOURCE", "TRANSIENT", "UNKNOWN"] },
        confidence: { type: "number", description: "0-100" },
        evidence: { type: "array", items: { type: "string" } },
      },
      required: ["root_cause", "category", "confidence", "evidence"],
    },
  },
}

const t0 = Date.now()
const ms = () => `${String(Date.now() - t0).padStart(6)}ms`

const conversation = await client.conversations.create({
  thread: { origin_application: "ade_spike" },
  agent: {
    type: "coding",
    spec: {
      models: { orchestration: MODEL },
      thinkingEffort: "low",
      permissionPolicy: "always_allow",
      instructions: {
        system:
          "You are the Investigator agent of ADE Mission Control. You diagnose failed Snowflake jobs using read-only SQL only. Finish by calling submit_diagnosis exactly once.",
      },
      orchestration: { budget: { seconds: 300, tokens: 400000 } },
      tools: [submitDiagnosis],
      client_metadata: { incident_id: "spike-s2", phase: "INVESTIGATE" },
    },
  },
})
console.log(ms(), "conversation", conversation.id)

const turn = await conversation.send(
  [
    "Task ADE_DEMO_RETAIL.ORCHESTRATION.CLEAN_ORDERS is part of a task graph.",
    "1) Run SELECT CURRENT_USER(), CURRENT_ROLE() with your SQL tool.",
    "2) Run SHOW TASKS IN SCHEMA ADE_DEMO_RETAIL.ORCHESTRATION and read the CLEAN_ORDERS definition.",
    "3) Query TABLE(ADE_DEMO_RETAIL.INFORMATION_SCHEMA.TASK_HISTORY(SCHEDULED_TIME_RANGE_START => DATEADD(hour, -6, CURRENT_TIMESTAMP()), ERROR_ONLY => TRUE)) filtered to DATABASE_NAME = 'ADE_DEMO_RETAIL'.",
    "Then call submit_diagnosis summarising the most recent failure of CLEAN_ORDERS (or that there is none).",
  ].join("\n"),
)
console.log(ms(), "turn", turn.id)

const toolStarts = new Map()
const clientUses = []
let finalEvent = null
for await (const ev of turn.events()) {
  const seq = ev.sequence_number
  switch (ev.event) {
    case "response.status":
      console.log(ms(), seq, "status", ev.status, "|", ev.message, "| model", ev.orchestration_model, "| effort", ev.thinking_effort)
      break
    case "response.tool_use":
      toolStarts.set(ev.tool_use_id, Date.now())
      console.log(ms(), seq, "tool_use", ev.type, ev.name, "client_side:", ev.client_side_execute, "input:", JSON.stringify(ev.input).slice(0, 160))
      if (ev.client_side_execute) clientUses.push(ev)
      break
    case "response.tool_result": {
      const dur = Date.now() - (toolStarts.get(ev.tool_use_id) ?? Date.now())
      const text = (ev.content ?? []).map((c) => c.text ?? JSON.stringify(c.json ?? "")).join(" ")
      console.log(ms(), seq, "tool_result", ev.name, ev.status, `${dur}ms`, "|", text.replace(/\s+/g, " ").slice(0, 200))
      break
    }
    case "response.tool_use.status":
    case "response.tool_result.status":
      console.log(ms(), seq, ev.event, ev.tool_type, ev.status, ev.message ?? "")
      break
    case "response":
      finalEvent = ev
      console.log(ms(), seq, "response status", ev.status)
      console.log("   metadata", JSON.stringify(ev.metadata))
      break
    case "error":
      console.log(ms(), seq, "ERROR", ev.code, ev.message, ev.request_id)
      break
    case "metadata":
      console.log(ms(), seq, "metadata", JSON.stringify(ev.metadata))
      break
    default:
      if (!ev.event.endsWith(".delta")) console.log(ms(), seq, ev.event)
  }
}

const result = await turn.result()
console.log(ms(), "turn result: status", result.status, "requestId", result.requestId, "runId", result.runId, "usage", JSON.stringify(result.usage))

if (clientUses.length) {
  const use = clientUses[0]
  console.log(ms(), "submit_diagnosis payload:", JSON.stringify(use.input, null, 2))
  const follow = await conversation.sendToolResults([
    {
      toolUse: { toolUseId: use.tool_use_id, name: use.name, input: use.input },
      result: { accepted: true, message: "Diagnosis recorded. End your turn with one short sentence." },
    },
  ])
  const followResult = await follow.result()
  console.log(ms(), "follow-up:", followResult.status, "|", followResult.text.slice(0, 300))
  console.log("   follow-up usage", JSON.stringify(followResult.usage), "requestId", followResult.requestId)
  console.log("   follow-up metadata", JSON.stringify(followResult.metadata))
} else {
  console.log(ms(), "NO client-side tool use observed. Final text:", result.text.slice(0, 500))
}
