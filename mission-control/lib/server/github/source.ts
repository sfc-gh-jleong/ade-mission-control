/**
 * The job's file in Git, and the change a fix makes to it.
 *
 *   gitTarget()      is this job's database managed in Git, and which repo file
 *                    defines the job (GUARD.MANAGED_DATABASES, GUARD.REPO_OBJECTS;
 *                    both SYSADMIN-owned, so the agents cannot remap a job)
 *   pinSource()      before the Fixer runs: main's head commit, the file at that
 *                    commit, and whether production still runs that code
 *   buildChange()    after the fix is stored: the rehearsed body copied into the
 *                    file by code, with the diff, git blob SHAs and patch hash
 *                    (pure, in files.ts; re-exported here)
 *   saveChange() / loadChange()   OPS.SOURCE_CHANGES, sealed with the app's key
 */
import { sql, sqlOne } from "@/lib/server/db"
import { seal, sourceSealParts, verify } from "@/lib/server/seal"
import { bindDatabase } from "@/lib/server/agents/sql-guard"
import { q } from "@/lib/server/rehearsal/sql-text"
import { repoClient, validRepo, type DeliverySettings } from "@/lib/server/github/client"
import {
  fileObject,
  gitBlobSha,
  normalizeSql,
  parseObjectFile,
  patchHash,
  type GitJob,
  type ObjectFile,
  type SourceChange,
} from "@/lib/server/github/files"

export { buildChange, type SourceChange } from "@/lib/server/github/files"

export interface GitTarget {
  database: string
  repo: string
  path: string
  job: GitJob
  mayEdit: boolean
  /** SCHEMA.NAME of every object the repo defines for this database. */
  repoDefined: Set<string>
}

export interface PinnedSource extends GitTarget {
  baseBranch: string
  baseCommitSha: string
  baseBlobSha: string
  baseContent: string
  file: ObjectFile
  /** null when production's definition could not be read. */
  productionMatches: boolean | null
}

/** Delivery mode of a database; `null` repo for databases fixed in place through GUARD. */
export async function deliveryFor(database: string): Promise<{ delivery: "APPLY" | "PULL_REQUEST"; repo: string | null }> {
  const r = await sqlOne<{ D: string | null; R: string | null }>(
    `SELECT DELIVERY AS D, REPO AS R FROM ADE_DB.GUARD.MANAGED_DATABASES WHERE DATABASE_NAME = UPPER(?)`,
    [database],
  )
  return r?.D === "PULL_REQUEST" ? { delivery: "PULL_REQUEST", repo: r.R ?? null } : { delivery: "APPLY", repo: null }
}

/**
 * Git delivery details for a job, or null when its database is fixed in place.
 * Throws when the database is managed in Git but the job has no repo file
 * (a person must handle it: GUARD refuses direct changes there).
 */
export async function gitTarget(database: string, jobType: string, jobFqn: string): Promise<GitTarget | null> {
  const d = await deliveryFor(database)
  if (d.delivery !== "PULL_REQUEST") return null
  if (!validRepo(d.repo)) throw new Error(`${database} is managed in Git but GUARD.MANAGED_DATABASES has no valid REPO`)
  const [, schema, name] = jobFqn.split(".")
  const rows = await sql<{ S: string; N: string; T: string; P: string; E: boolean }>(
    `SELECT SCHEMA_NAME AS S, OBJECT_NAME AS N, OBJECT_TYPE AS T, REPO_PATH AS P, ADE_MAY_EDIT AS E
     FROM ADE_DB.GUARD.REPO_OBJECTS WHERE DATABASE_NAME = UPPER(?)`,
    [database],
  )
  const repoDefined = new Set(rows.map((r) => `${r.S}.${r.N}`))
  const own = rows.find((r) => r.S === schema && r.N === name)
  if (!own || (jobType !== "TASK" && jobType !== "DYNAMIC_TABLE") || own.T !== jobType) {
    throw new Error(`${jobFqn} is not defined in ${d.repo}, so ADE cannot change it (the database is managed in Git)`)
  }
  if (!/^objects\/[a-z0-9_]+\/[a-z0-9_]+\.sql$/.test(own.P)) throw new Error(`Unexpected repo path for ${jobFqn}: ${own.P}`)
  return { database: database.toUpperCase(), repo: d.repo, path: own.P, job: { type: jobType, schema, name }, mayEdit: Boolean(own.E), repoDefined }
}

const likeLiteral = (name: string) => `'${name.replace(/\\/g, "\\\\").replace(/([_%])/g, "\\$1").replace(/'/g, "''")}'`

/** The body production runs now: a task's definition, or a dynamic table's query. */
export async function productionBody(database: string, job: GitJob): Promise<string | null> {
  const where = `${q(database)}.${q(job.schema)}`
  if (job.type === "TASK") {
    const rows = await sql<{ name: string; definition: string }>(`SHOW TASKS LIKE ${likeLiteral(job.name)} IN SCHEMA ${where} ->> SELECT "name", "definition" FROM $1`)
    return rows.find((r) => r.name === job.name)?.definition ?? null
  }
  const rows = await sql<{ name: string; text: string }>(`SHOW DYNAMIC TABLES LIKE ${likeLiteral(job.name)} IN SCHEMA ${where} ->> SELECT "name", "text" FROM $1`)
  const text = rows.find((r) => r.name === job.name)?.text
  const m = text ? /\bAS\s+((?:SELECT|WITH|\()[\s\S]*)$/i.exec(text) : null
  return m ? m[1] : null
}

export async function pinSource(target: GitTarget, settings: DeliverySettings): Promise<PinnedSource> {
  const gh = repoClient(target.repo)
  const baseCommitSha = await gh.headSha(settings.baseBranch)
  const { content, sha } = await gh.file(target.path, baseCommitSha)
  const file = parseObjectFile(content)
  if (!file) throw new Error(`${target.path} is not in the expected format (header, a line with AS, body)`)
  const defined = fileObject(file.header)
  if (!defined || defined.type !== target.job.type || defined.schema !== target.job.schema || defined.name !== target.job.name) {
    throw new Error(`${target.path} does not define ${target.job.schema}.${target.job.name}`)
  }
  const prod = await productionBody(target.database, target.job).catch(() => null)
  const productionMatches = prod === null ? null : normalizeSql(prod) === normalizeSql(bindDatabase(file.body, target.database))
  return { ...target, baseBranch: settings.baseBranch, baseCommitSha, baseBlobSha: sha, baseContent: content, file, productionMatches }
}

export async function saveChange(fixId: string, incidentId: string, pinned: PinnedSource, change: SourceChange): Promise<void> {
  const sealValue = seal(sourceSealParts({ fixId, path: pinned.path, baseCommitSha: pinned.baseCommitSha, baseBlobSha: pinned.baseBlobSha, newBlobSha: change.newBlobSha, patchHash: change.patchHash }))
  await sql(
    `INSERT INTO ADE_DB.OPS.SOURCE_CHANGES (FIX_ID, INCIDENT_ID, REPO, BASE_BRANCH, BASE_COMMIT_SHA, PATH, OBJECT_TYPE, BASE_BLOB_SHA, NEW_BLOB_SHA,
       BASE_CONTENT, NEW_CONTENT, DIFF, PATCH_HASH, SEAL)
     SELECT ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?`,
    [fixId, incidentId, pinned.repo, pinned.baseBranch, pinned.baseCommitSha, pinned.path, pinned.job.type, pinned.baseBlobSha, change.newBlobSha,
     pinned.baseContent, change.newContent, change.diff, change.patchHash, sealValue],
  )
}

export interface StoredChange {
  fixId: string
  incidentId: string
  repo: string
  baseBranch: string
  baseCommitSha: string
  path: string
  objectType: "TASK" | "DYNAMIC_TABLE"
  baseBlobSha: string
  newBlobSha: string
  baseContent: string
  newContent: string
  diff: string
  patchHash: string
  seal: "VALID" | "INVALID" | "UNSEALED"
}

/**
 * A stored change, with its seal checked and its content re-derived: the blob
 * SHAs and patch hash must match the stored contents, so a row edited after
 * the app wrote it never reaches GitHub.
 */
export async function loadChange(fixId: string): Promise<StoredChange | null> {
  const r = await sqlOne<Record<string, string>>(`SELECT * FROM ADE_DB.OPS.SOURCE_CHANGES WHERE FIX_ID = ?`, [fixId])
  if (!r) return null
  const parts = { fixId, path: r.PATH, baseCommitSha: r.BASE_COMMIT_SHA, baseBlobSha: r.BASE_BLOB_SHA, newBlobSha: r.NEW_BLOB_SHA, patchHash: r.PATCH_HASH }
  let state = verify(sourceSealParts(parts), r.SEAL)
  const consistent =
    gitBlobSha(r.BASE_CONTENT) === r.BASE_BLOB_SHA && gitBlobSha(r.NEW_CONTENT) === r.NEW_BLOB_SHA && patchHash(r.PATH, r.BASE_BLOB_SHA, r.NEW_BLOB_SHA) === r.PATCH_HASH
  if (!consistent) state = "INVALID"
  return {
    fixId, incidentId: r.INCIDENT_ID, repo: r.REPO, baseBranch: r.BASE_BRANCH, baseCommitSha: r.BASE_COMMIT_SHA, path: r.PATH,
    objectType: r.OBJECT_TYPE as "TASK" | "DYNAMIC_TABLE", baseBlobSha: r.BASE_BLOB_SHA, newBlobSha: r.NEW_BLOB_SHA,
    baseContent: r.BASE_CONTENT, newContent: r.NEW_CONTENT, diff: r.DIFF, patchHash: r.PATCH_HASH, seal: state,
  }
}
