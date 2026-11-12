/**
 * GitHub access for Git delivery, as a GitHub App installed on one repository.
 *
 * The App's private key is the Snowflake secret ADE_DB.SECRETS.GITHUB_APP_KEY,
 * mounted only into this container (app.yml `secrets:`); outbound calls go
 * through ADE_GITHUB_EAI, which allows api.github.com only. The agents' sandbox
 * has neither. Locally, ADE_GITHUB_APP_KEY_FILE (path to the .pem) or
 * ADE_GITHUB_APP_KEY stands in for the mount.
 *
 * The App has Contents, Pull requests and Commit statuses write and Actions
 * read on that repository; branch protection on main makes it propose changes
 * rather than make them, and without the Workflows permission it cannot touch
 * .github/workflows. Installation tokens are scoped to the one repository and
 * to the permissions ADE uses (even if the App was granted more), and cached
 * until shortly before they expire. checkConnection() reports an App that has
 * permissions it must not have.
 */
import { createSign } from "node:crypto"
import { readFileSync } from "node:fs"
import { getSecret, SecretType } from "@/lib/sar-sdk"
import { sql } from "@/lib/server/db"
import { gitBlobSha } from "@/lib/server/github/files"

const API = "https://api.github.com"
const TIMEOUT_MS = 20_000

export interface DeliverySettings {
  enabled: boolean
  appId: string | null
  installationId: string | null
  baseBranch: string
  pollSeconds: number
  deployTimeoutMinutes: number
}

export class GitHubError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message)
    this.name = "GitHubError"
  }
}

export async function deliverySettings(): Promise<DeliverySettings> {
  const rows = await sql<{ K: string; V: string | null }>(
    `SELECT SETTING_KEY AS K, SETTING_VALUE::STRING AS V FROM ADE_DB.OPS.SETTINGS WHERE STARTSWITH(SETTING_KEY, 'delivery.github.')`,
  )
  const m = new Map(rows.map((r) => [r.K.replace("delivery.github.", ""), r.V]))
  const id = (v: string | null | undefined) => (v && /^\d{1,20}$/.test(v) ? v : null)
  const n = (v: string | null | undefined, d: number, lo: number, hi: number) => (Number.isFinite(Number(v)) && v !== null ? Math.max(lo, Math.min(hi, Number(v))) : d)
  const branch = m.get("base_branch")
  return {
    enabled: m.get("enabled") === "true",
    appId: id(m.get("app_id")),
    installationId: id(m.get("installation_id")),
    baseBranch: branch && /^[A-Za-z0-9._/-]{1,100}$/.test(branch) ? branch : "main",
    pollSeconds: n(m.get("poll_seconds"), 60, 15, 3600),
    deployTimeoutMinutes: n(m.get("deploy_timeout_minutes"), 30, 5, 1440),
  }
}

function privateKey(): string | null {
  let key: string | null = null
  try {
    key = getSecret("GITHUB_APP_KEY", SecretType.GENERIC_STRING)
  } catch {
    const file = process.env.ADE_GITHUB_APP_KEY_FILE
    key = file ? readFileSync(file, "utf8") : (process.env.ADE_GITHUB_APP_KEY ?? null)
  }
  return key && key.includes("-----BEGIN") && key.includes("PRIVATE KEY-----") ? key : null
}

/** Whether the App is set up well enough to call GitHub (the kill switch is separate). */
export async function githubConfigured(): Promise<{ ok: boolean; problem: string | null; settings: DeliverySettings }> {
  const settings = await deliverySettings()
  const problem = !settings.appId
    ? "delivery.github.app_id is not set"
    : !settings.installationId
      ? "delivery.github.installation_id is not set"
      : !privateKey()
        ? "The GitHub App private key (ADE_DB.SECRETS.GITHUB_APP_KEY) is not stored yet"
        : null
  return { ok: problem === null, problem, settings }
}

const b64url = (s: string | Buffer) => Buffer.from(s).toString("base64").replace(/=+$/, "").replace(/\+/g, "-").replace(/\//g, "_")

function appJwt(appId: string, pem: string): string {
  const now = Math.floor(Date.now() / 1000)
  const head = b64url(JSON.stringify({ alg: "RS256", typ: "JWT" }))
  const body = b64url(JSON.stringify({ iat: now - 60, exp: now + 9 * 60, iss: appId }))
  const signature = createSign("RSA-SHA256").update(`${head}.${body}`).sign(pem)
  return `${head}.${body}.${b64url(signature)}`
}

const g = globalThis as unknown as { __adeGhToken?: Map<string, { token: string; expiresAt: number }> }

/** What ADE uses. Tokens ask for these only, whatever else the App was granted. */
const USED: Record<string, "read" | "write"> = { contents: "write", pull_requests: "write", statuses: "write", actions: "read", metadata: "read" }
/** Only links deploy runs; the rest of USED is needed to open pull requests. */
const OPTIONAL = new Set(["actions"])
/** Would let the App change workflows, repository settings (branch protection included), environments or secrets. */
const FORBIDDEN = ["workflows", "administration", "environments", "secrets"]
const LEVEL: Record<string, number> = { read: 1, write: 2, admin: 3 }
const PERMISSION_LABEL: Record<string, string> = {
  contents: "Contents",
  pull_requests: "Pull requests",
  statuses: "Commit statuses",
  actions: "Actions",
  metadata: "Metadata",
  workflows: "Workflows",
  administration: "Administration",
  environments: "Environments",
  secrets: "Secrets",
}

interface Installation {
  permissions?: Record<string, string>
  repository_selection?: "all" | "selected"
  app_slug?: string
  suspended_at?: string | null
}

/** A call authenticated as the App itself (JWT), for installation details and tokens. */
async function appRequest<T>(jwt: string, method: string, path: string, body?: unknown): Promise<T> {
  const res = await fetch(`${API}${path}`, {
    method,
    headers: headers(`Bearer ${jwt}`),
    body: body === undefined ? undefined : JSON.stringify(body),
    signal: AbortSignal.timeout(TIMEOUT_MS),
  })
  const data = (await res.json().catch(() => ({}))) as T & { message?: string }
  if (!res.ok) {
    const hint = res.status === 401 ? " (check delivery.github.app_id and the private key)" : res.status === 404 ? " (check delivery.github.installation_id)" : ""
    throw new GitHubError(res.status, `GitHub App sign-in failed (${res.status}): ${data?.message ?? res.statusText}${hint}`)
  }
  return data
}

/** The permissions to ask for: what ADE uses, capped at what the installation has. */
export function tokenPermissions(granted: Record<string, string>): Record<string, string> {
  const out: Record<string, string> = {}
  for (const [k, want] of Object.entries(USED)) {
    const have = granted[k]
    if (have) out[k] = (LEVEL[have] ?? 0) >= LEVEL[want] ? want : have
  }
  return out
}

async function installationToken(repo: string, force = false): Promise<string> {
  const { settings, ok, problem } = await githubConfigured()
  if (!ok) throw new GitHubError(0, `GitHub delivery is not configured: ${problem}`)
  if (!g.__adeGhToken) g.__adeGhToken = new Map()
  const cacheKey = `${settings.installationId}/${repo}`
  const cached = g.__adeGhToken.get(cacheKey)
  if (!force && cached && cached.expiresAt - Date.now() > 5 * 60_000) return cached.token
  const jwt = appJwt(settings.appId!, privateKey()!)
  const installation = await appRequest<Installation>(jwt, "GET", `/app/installations/${settings.installationId}`)
  const permissions = tokenPermissions(installation.permissions ?? {})
  if (!Object.keys(permissions).length) throw new GitHubError(0, "The GitHub App has none of the permissions ADE uses (Contents, Pull requests, Commit statuses)")
  const data = await appRequest<{ token?: string; expires_at?: string }>(jwt, "POST", `/app/installations/${settings.installationId}/access_tokens`, {
    repositories: [repo.split("/")[1]],
    permissions,
  })
  if (!data.token) throw new GitHubError(0, "GitHub App sign-in failed: no token")
  g.__adeGhToken.set(cacheKey, { token: data.token, expiresAt: data.expires_at ? Date.parse(data.expires_at) : Date.now() + 50 * 60_000 })
  return data.token
}

function headers(authorization: string): Record<string, string> {
  return {
    Accept: "application/vnd.github+json",
    "X-GitHub-Api-Version": "2022-11-28",
    "User-Agent": "ade-mission-control",
    "Content-Type": "application/json",
    Authorization: authorization,
  }
}

export function validRepo(repo: string | null | undefined): repo is string {
  return Boolean(repo && /^[A-Za-z0-9-]{1,39}\/[A-Za-z0-9._-]{1,100}$/.test(repo))
}

const encPath = (p: string) => p.split("/").map(encodeURIComponent).join("/")

/** A client bound to one repository; every call stays under /repos/<repo>/. */
export function repoClient(repo: string) {
  if (!validRepo(repo)) throw new Error(`Invalid repository name: ${repo}`)
  const base = `/repos/${repo}`

  async function call<T>(method: string, path: string, body?: unknown, retried = false): Promise<T> {
    const token = await installationToken(repo, retried)
    const res = await fetch(`${API}${base}${path}`, {
      method,
      headers: headers(`Bearer ${token}`),
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: AbortSignal.timeout(TIMEOUT_MS),
    })
    if (res.status === 401 && !retried) return call<T>(method, path, body, true)
    if (res.status === 204) return undefined as T
    const data = (await res.json().catch(() => ({}))) as T & { message?: string }
    if (!res.ok) throw new GitHubError(res.status, `GitHub ${method} ${path.split("?")[0]} failed (${res.status}): ${data?.message ?? res.statusText}`)
    return data
  }

  return {
    repo,
    get: <T>(path: string) => call<T>("GET", path),

    async headSha(branch: string): Promise<string> {
      const r = await call<{ object: { sha: string } }>("GET", `/git/ref/heads/${encPath(branch)}`)
      return r.object.sha
    },

    /** A file at a ref; its content is checked against the blob SHA GitHub reports. */
    async file(path: string, ref: string): Promise<{ content: string; sha: string }> {
      const r = await call<{ type: string; content?: string; encoding?: string; sha: string }>("GET", `/contents/${encPath(path)}?ref=${encodeURIComponent(ref)}`)
      if (r.type !== "file" || r.encoding !== "base64" || typeof r.content !== "string") throw new GitHubError(0, `${path} is not a regular file at ${ref.slice(0, 12)}`)
      const content = Buffer.from(r.content, "base64").toString("utf8")
      if (gitBlobSha(content) !== r.sha) throw new GitHubError(0, `${path} at ${ref.slice(0, 12)} did not match its blob SHA`)
      return { content, sha: r.sha }
    },

    async commitTree(sha: string): Promise<string> {
      return (await call<{ tree: { sha: string } }>("GET", `/git/commits/${sha}`)).tree.sha
    },

    async createBlob(content: string): Promise<string> {
      return (await call<{ sha: string }>("POST", `/git/blobs`, { content, encoding: "utf-8" })).sha
    },

    async createTree(baseTree: string, path: string, blobSha: string): Promise<string> {
      return (await call<{ sha: string }>("POST", `/git/trees`, { base_tree: baseTree, tree: [{ path, mode: "100644", type: "blob", sha: blobSha }] })).sha
    },

    async createCommit(message: string, tree: string, parent: string): Promise<string> {
      return (await call<{ sha: string }>("POST", `/git/commits`, { message, tree, parents: [parent] })).sha
    },

    /** Point an ADE branch at a commit (created, or moved if it already exists). */
    async setBranch(branch: string, sha: string): Promise<void> {
      if (!branch.startsWith("ade/")) throw new Error(`Refusing to write branch ${branch}`)
      try {
        await call("POST", `/git/refs`, { ref: `refs/heads/${branch}`, sha })
      } catch (e) {
        if (!(e instanceof GitHubError) || e.status !== 422) throw e
        await call("PATCH", `/git/refs/heads/${encPath(branch)}`, { sha, force: true })
      }
    },

    async setStatus(sha: string, context: string, state: "success" | "failure" | "pending", description: string): Promise<void> {
      await call("POST", `/statuses/${sha}`, { context, state, description: description.slice(0, 140) })
    },

    async openPullFor(branch: string): Promise<{ number: number; html_url: string; head: { sha: string } } | null> {
      const owner = repo.split("/")[0]
      const list = await call<{ number: number; html_url: string; head: { sha: string } }[]>("GET", `/pulls?state=open&head=${encodeURIComponent(`${owner}:${branch}`)}&per_page=5`)
      return list[0] ?? null
    },

    async createPull(title: string, head: string, baseBranch: string, body: string): Promise<{ number: number; html_url: string }> {
      return call("POST", `/pulls`, { title, head, base: baseBranch, body, draft: false })
    },

    async addLabels(issue: number, labels: string[]): Promise<void> {
      await call("POST", `/issues/${issue}/labels`, { labels })
    },

    async pull(n: number) {
      return call<{
        number: number
        state: "open" | "closed"
        merged: boolean
        merged_at: string | null
        merged_by: { login: string } | null
        merge_commit_sha: string | null
        html_url: string
        head: { sha: string; ref: string }
      }>("GET", `/pulls/${n}`)
    },

    async reviews(n: number) {
      return call<{ user: { login: string } | null; state: string; submitted_at: string | null }[]>("GET", `/pulls/${n}/reviews?per_page=100`)
    },

    /** "ahead" or "identical" if `head` contains `base`. */
    async compare(base: string, head: string): Promise<string> {
      return (await call<{ status: string }>("GET", `/compare/${base}...${head}`)).status
    },

    async runFor(sha: string): Promise<string | null> {
      try {
        const r = await call<{ workflow_runs: { html_url: string; name: string }[] }>("GET", `/actions/runs?head_sha=${sha}&per_page=10`)
        return r.workflow_runs.find((w) => w.name === "Deploy")?.html_url ?? r.workflow_runs[0]?.html_url ?? null
      } catch {
        return null
      }
    },
  }
}

export type RepoClient = ReturnType<typeof repoClient>

/**
 * What is wrong with an installation for Git delivery: suspended, permissions
 * that would let it change workflows, settings, environments or secrets,
 * missing permissions ADE needs, or installed on every repository.
 */
export function installationProblems(installation: Installation, repo: string): string[] {
  const p = installation.permissions ?? {}
  const label = (k: string) => PERMISSION_LABEL[k] ?? k
  const forbidden = FORBIDDEN.filter((k) => p[k])
  const missing = Object.entries(USED)
    .filter(([k, want]) => !OPTIONAL.has(k) && (LEVEL[p[k]] ?? 0) < LEVEL[want])
    .map(([k, want]) => `${label(k)} (${want})`)
  return [
    ...(installation.suspended_at ? ["the installation is suspended"] : []),
    ...(forbidden.length ? [`remove the ${forbidden.map(label).join(", ")} permission${forbidden.length > 1 ? "s" : ""}`] : []),
    ...(missing.length ? [`grant ${missing.join(", ")}`] : []),
    ...(installation.repository_selection === "all" ? [`install it on ${repo} only (it is installed on all repositories)`] : []),
  ]
}

/**
 * Settings page check: can the App reach the repository, and is it set up as
 * the guarantees assume?
 */
export async function checkConnection(repo: string): Promise<{ ok: boolean; detail: string }> {
  try {
    const { ok, problem, settings } = await githubConfigured()
    if (!ok) return { ok: false, detail: problem ?? "Git delivery is not configured" }
    const installation = await appRequest<Installation>(appJwt(settings.appId!, privateKey()!), "GET", `/app/installations/${settings.installationId}`)
    const r = await repoClient(repo).get<{ full_name: string }>("")
    const problems = installationProblems(installation, repo)
    const as = installation.app_slug ? ` as ${installation.app_slug}` : ""
    if (problems.length) return { ok: false, detail: `Reached ${r.full_name}${as}, but ${problems.join("; ")}` }
    const note = (LEVEL[installation.permissions?.actions ?? ""] ?? 0) < LEVEL.read ? " (without Actions read, deploy runs are not linked)" : ""
    return { ok: true, detail: `Connected to ${r.full_name}${as}${note}` }
  } catch (e) {
    return { ok: false, detail: e instanceof Error ? e.message : String(e) }
  }
}
