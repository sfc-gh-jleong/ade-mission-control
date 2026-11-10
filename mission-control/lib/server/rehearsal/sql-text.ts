/**
 * SQL text helpers for sandbox rehearsal: find which objects a job references
 * and rewrite database names from production to the sandbox clone.
 *
 * Rewriting is textual, so it is applied only to *database-qualified*
 * identifiers (`DB.SCHEMA.OBJECT`) whose database is the incident's database.
 * String literals are left untouched. Unqualified references resolve against
 * the task's own schema, which rehearsal recreates under the same name.
 */

export interface ObjectRef {
  database: string
  schema: string
  name: string
}

const IDENT = String.raw`(?:"[^"]+"|[A-Za-z_][A-Za-z0-9_$]*)`
const QUALIFIED = new RegExp(String.raw`(${IDENT})\s*\.\s*(${IDENT})\s*\.\s*(${IDENT})`, "g")

function unquote(id: string): string {
  return id.startsWith('"') && id.endsWith('"') ? id.slice(1, -1) : id.toUpperCase()
}

/** Split SQL into code and string-literal segments ('...' with '' escapes). */
function segments(sql: string): { text: string; literal: boolean }[] {
  const out: { text: string; literal: boolean }[] = []
  let i = 0
  let start = 0
  while (i < sql.length) {
    if (sql[i] === "'") {
      if (i > start) out.push({ text: sql.slice(start, i), literal: false })
      let j = i + 1
      while (j < sql.length) {
        if (sql[j] === "'" && sql[j + 1] === "'") j += 2
        else if (sql[j] === "'") break
        else j++
      }
      out.push({ text: sql.slice(i, Math.min(j + 1, sql.length)), literal: true })
      i = j + 1
      start = i
    } else {
      i++
    }
  }
  if (start < sql.length) out.push({ text: sql.slice(start), literal: false })
  return out
}

/** Database-qualified object references in `sql`, deduplicated. */
export function qualifiedRefs(sql: string): ObjectRef[] {
  const seen = new Map<string, ObjectRef>()
  for (const seg of segments(sql)) {
    if (seg.literal) continue
    for (const m of seg.text.matchAll(QUALIFIED)) {
      const ref = { database: unquote(m[1]), schema: unquote(m[2]), name: unquote(m[3]) }
      const key = `${ref.database}.${ref.schema}.${ref.name}`
      // Skip function-call-like matches such as DB.SCHEMA.FN( handled by caller via objects list.
      if (!seen.has(key)) seen.set(key, ref)
    }
  }
  return [...seen.values()]
}

/** Replace `fromDb.` with `toDb.` in database-qualified identifiers, outside literals. */
export function rewriteDatabase(sql: string, fromDb: string, toDb: string): string {
  const from = fromDb.toUpperCase()
  return segments(sql)
    .map((seg) => {
      if (seg.literal) return seg.text
      return seg.text.replace(QUALIFIED, (whole, db: string, schema: string, obj: string) =>
        unquote(db) === from ? `${toDb}.${schema}.${obj}` : whole,
      )
    })
    .join("")
}

/** Sandbox database name for an incident attempt: ADE_SBX_<number>_<attempt>. */
export function sandboxDatabaseName(incidentNumber: number | string, attempt: number): string {
  const n = String(incidentNumber).replace(/[^0-9]/g, "")
  return `ADE_SBX_${n}_${attempt}`
}

/** Quote an identifier for SQL text (always quoted, embedded quotes doubled). */
export function q(id: string): string {
  return `"${id.replace(/"/g, '""')}"`
}

export function fqn(ref: ObjectRef): string {
  return `${q(ref.database)}.${q(ref.schema)}.${q(ref.name)}`
}

/**
 * Parse EXECUTE TASK ... AWAIT failures, e.g.
 *   Task graph 'X' with graph_run_group_id='...' failed. The first error task,
 *   named 'T' failed with error='002003: SQL compilation error: ...'.
 */
export function parseAwaitFailure(message: string): { graphRunGroupId?: string; task?: string; code?: string; error?: string } {
  const flat = message.replace(/\s+/g, " ")
  const gid = /graph_run_group_id='([^']+)'/.exec(flat)?.[1]
  const task = /first error task, named '([^']+)'/.exec(flat)?.[1]
  const err = /failed with error='([0-9]{6}): ([\s\S]*?)'\.?\s*$/.exec(flat) ?? /failed with error='([0-9]{6}): ([^']*)/.exec(flat)
  return { graphRunGroupId: gid, task, code: err?.[1], error: err?.[2]?.trim() }
}
