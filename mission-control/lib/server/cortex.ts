/**
 * Cortex Agent SDK client (server-only).
 *
 * The three ADE agents are Cortex Code coding agents running in Snowflake's
 * managed sandbox (`code_toolset_all`), driven from this container through the
 * Cortex Agent REST API with @snowflake/cortex-agent-sdk.
 *
 * Credentials, in order:
 *   1. App Runtime service token (/snowflake/session/token): agents run as the
 *      app's owner role ADE_APP_ROLE, which is read-only on monitored databases.
 *   2. SNOWFLAKE_PAT (local dev).
 *   3. Key-pair JWT minted from the snow CLI connection's private_key_file.
 *
 * Local dev runs agents with the developer's default role, which is usually far
 * more privileged than ADE_APP_ROLE, so agent runs are refused locally unless
 * ADE_ALLOW_LOCAL_AGENTS=1 is set.
 */
import { createHash, createPrivateKey, createPublicKey, sign } from "node:crypto"
import fs from "node:fs"
import os from "node:os"
import { CortexAgentClient, type Authenticator } from "@snowflake/cortex-agent-sdk"
import { getServiceToken, getSnowflakeBaseUrl, readTomlDefaultConnection } from "@/lib/sar-sdk"

/** Thread origin label (the API caps origin_application at 16 bytes). */
export const THREAD_ORIGIN = "ade_mission_ctl"
export const PARTNER_APPLICATION = "ade_mission_control"

const JWT_LIFETIME_S = 55 * 60
let cachedJwt: { token: string; expiresAt: number } | null = null

function expandHome(p: string): string {
  return p.startsWith("~") ? p.replace(/^~/, os.homedir()) : p
}

function mintKeyPairJwt(account: string, user: string, keyFile: string, passphrase?: string): string {
  const now = Math.floor(Date.now() / 1000)
  if (cachedJwt && cachedJwt.expiresAt - 60 > now) return cachedJwt.token

  const privateKey = createPrivateKey({ key: fs.readFileSync(expandHome(keyFile), "utf8"), passphrase })
  const publicDer = createPublicKey(privateKey).export({ type: "spki", format: "der" })
  const fingerprint = `SHA256:${createHash("sha256").update(publicDer).digest("base64")}`
  // Account identifier without region/cloud suffixes, upper-cased (Snowflake JWT rules).
  const qualifiedUser = `${account.split(".")[0].toUpperCase()}.${user.toUpperCase()}`

  const b64 = (v: string | Buffer) => Buffer.from(v).toString("base64url")
  const header = b64(JSON.stringify({ alg: "RS256", typ: "JWT" }))
  const payload = b64(JSON.stringify({ iss: `${qualifiedUser}.${fingerprint}`, sub: qualifiedUser, iat: now, exp: now + JWT_LIFETIME_S }))
  const unsigned = `${header}.${payload}`
  const token = `${unsigned}.${sign("RSA-SHA256", Buffer.from(unsigned), privateKey).toString("base64url")}`
  cachedJwt = { token, expiresAt: now + JWT_LIFETIME_S }
  return token
}

class AppAuthenticator implements Authenticator {
  async getAuthHeaders(): Promise<Record<string, string>> {
    const serviceToken = getServiceToken()
    if (serviceToken) {
      return { Authorization: `Bearer ${serviceToken}`, "X-Snowflake-Authorization-Token-Type": "OAUTH" }
    }
    if (process.env.SNOWFLAKE_PAT) {
      return { Authorization: `Bearer ${process.env.SNOWFLAKE_PAT}`, "X-Snowflake-Authorization-Token-Type": "PROGRAMMATIC_ACCESS_TOKEN" }
    }
    const conn = readTomlDefaultConnection()
    const keyFile = (conn?.private_key_file ?? conn?.private_key_path) as string | undefined
    if (conn?.account && conn.user && keyFile) {
      const passphrase = (conn.private_key_file_pwd ?? conn.private_key_passphrase) as string | undefined
      return {
        Authorization: `Bearer ${mintKeyPairJwt(String(conn.account), String(conn.user), keyFile, passphrase)}`,
        "X-Snowflake-Authorization-Token-Type": "KEYPAIR_JWT",
      }
    }
    throw new Error(
      "No credentials for the Cortex Agent API. Locally, set SNOWFLAKE_PAT or SNOWFLAKE_CONNECTION_NAME to a key-pair snow connection.",
    )
  }
}

const g = globalThis as unknown as { __adeAgentClient?: CortexAgentClient; __adeAuth?: AppAuthenticator }

/** Shared authenticator for the high-level client and the REST (`/api`) client. */
export function appAuthenticator(): Authenticator {
  if (!g.__adeAuth) g.__adeAuth = new AppAuthenticator()
  return g.__adeAuth
}

export function getAgentClient(): CortexAgentClient {
  if (!g.__adeAgentClient) {
    const baseUrl = getSnowflakeBaseUrl()
    if (!baseUrl) throw new Error("Cannot determine the Snowflake account URL for the Cortex Agent API")
    g.__adeAgentClient = new CortexAgentClient({
      baseUrl,
      auth: appAuthenticator(),
      partnerApplication: PARTNER_APPLICATION,
      // Tokens are re-read on every request; a 401 just retries with fresh headers.
      refreshAuth: async () => {
        cachedJwt = null
      },
    })
  }
  return g.__adeAgentClient
}

/** Agents may run when deployed (service identity) or when explicitly allowed locally. */
export function agentsAllowedHere(): { allowed: boolean; reason?: string } {
  if (getServiceToken()) return { allowed: true }
  if (process.env.ADE_ALLOW_LOCAL_AGENTS === "1") return { allowed: true }
  return {
    allowed: false,
    reason:
      "Agents run only in the deployed app (as ADE_APP_ROLE). Locally they would run with your default role; set ADE_ALLOW_LOCAL_AGENTS=1 to override.",
  }
}
