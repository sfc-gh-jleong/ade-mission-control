/**
 * Static safety screen for Fixer statements. This is defence in depth: the
 * sandbox rehearsal runs as ADE_APP_ROLE (no production write privileges), and
 * the GUARD apply procedure repeats the same checks server-side before anything
 * touches production. The screen gives the Fixer fast, precise feedback.
 *
 * Rules
 * - One statement per entry, no trailing semicolons, no comments.
 * - Statement kind must be in the allowlist (CREATE/ALTER of tables, views,
 *   dynamic tables, tasks; narrowly scoped INSERT/UPDATE/DELETE; MERGE).
 * - Never DROP TABLE/SCHEMA/DATABASE, TRUNCATE, GRANT/REVOKE, CALL, EXECUTE,
 *   USE, account-level objects, or anything touching ADE_* databases.
 * - Every database-qualified reference must use {{DB}} (the incident's
 *   database). A literal database name is a scope escape.
 */

export type StatementKind =
  | "CREATE_TABLE"
  | "CREATE_VIEW"
  | "CREATE_DYNAMIC_TABLE"
  | "CREATE_TASK"
  | "ALTER_TABLE"
  | "ALTER_VIEW"
  | "ALTER_DYNAMIC_TABLE"
  | "ALTER_TASK"
  | "INSERT"
  | "UPDATE"
  | "DELETE"
  | "MERGE"

export interface ScreenedStatement {
  index: number
  kind: StatementKind | null
  text: string
  errors: string[]
}

export interface ScreenResult {
  ok: boolean
  statements: ScreenedStatement[]
  errors: string[]
}

const PLACEHOLDER = "{{DB}}"

const KIND_PATTERNS: [StatementKind, RegExp][] = [
  ["CREATE_DYNAMIC_TABLE", /^CREATE\s+(OR\s+REPLACE\s+)?(TRANSIENT\s+)?DYNAMIC\s+TABLE\b/i],
  ["CREATE_TASK", /^CREATE\s+(OR\s+REPLACE\s+)?TASK\b/i],
  ["CREATE_VIEW", /^CREATE\s+(OR\s+REPLACE\s+)?(SECURE\s+)?(RECURSIVE\s+)?VIEW\b/i],
  ["CREATE_TABLE", /^CREATE\s+(OR\s+REPLACE\s+)?(TRANSIENT\s+)?TABLE\b/i],
  ["ALTER_DYNAMIC_TABLE", /^ALTER\s+DYNAMIC\s+TABLE\b/i],
  ["ALTER_TASK", /^ALTER\s+TASK\b/i],
  ["ALTER_VIEW", /^ALTER\s+VIEW\b/i],
  ["ALTER_TABLE", /^ALTER\s+TABLE\b/i],
  ["INSERT", /^INSERT\s+INTO\b/i],
  ["UPDATE", /^UPDATE\b/i],
  ["DELETE", /^DELETE\s+FROM\b/i],
  ["MERGE", /^MERGE\s+INTO\b/i],
]

const FORBIDDEN: [RegExp, string][] = [
  [/^\s*CREATE\s+OR\s+REPLACE\s+(TRANSIENT\s+)?TABLE\b/i, "CREATE OR REPLACE TABLE would destroy the table's data; use ALTER TABLE, or CREATE TABLE IF NOT EXISTS for a missing table"],
  [/^\s*INSERT\s+OVERWRITE\b/i, "INSERT OVERWRITE replaces all rows; write a targeted INSERT/UPDATE/DELETE instead"],
  [/\bDROP\s+(TABLE|SCHEMA|DATABASE|DYNAMIC\s+TABLE|VIEW|TASK|STAGE|PIPE|STREAM)\b/i, "DROP of an object is not allowed (use CREATE OR REPLACE / ALTER)"],
  [/\bTRUNCATE\b/i, "TRUNCATE is not allowed"],
  [/\b(GRANT|REVOKE)\b/i, "Privilege changes are not allowed"],
  [/\bEXECUTE\s+(IMMEDIATE|TASK|NOTEBOOK|ALERT)\b/i, "EXECUTE statements are not allowed in a fix"],
  [/^\s*CALL\b/i, "CALL is not allowed in a fix"],
  [/\b(USE|ALTER)\s+(ROLE|SECONDARY\s+ROLES|WAREHOUSE|SESSION|ACCOUNT|USER)\b/i, "Session/account changes are not allowed"],
  [/\bALTER\s+TABLE\b[\s\S]*\bSWAP\s+WITH\b/i, "SWAP WITH is not allowed"],
  [/\bALTER\s+TABLE\b[\s\S]*\bDROP\s+COLUMN\b/i, "Dropping columns is not allowed"],
  [/\bALTER\s+TASK\b[\s\S]*\bSET\s+(USER_TASK_MANAGED_INITIAL_WAREHOUSE_SIZE|EXECUTE\s+AS)\b/i, "Changing task execution identity or compute is not allowed"],
  [/\bEXECUTE\s+AS\s+(USER|CALLER|OWNER)\b/i, "Changing execution identity is not allowed"],
  [/\b(COPY\s+INTO|PUT|GET|REMOVE)\b\s+(@|'|"?\w)/i, "File/stage operations are not allowed"],
  [/\bADE_(DB|SANDBOX)\b|\bADE_SBX_\w+/i, "Statements may not reference ADE's own databases"],
  [/\bSNOWFLAKE\s*\.\s*(ACCOUNT_USAGE|CORTEX|ML)\b[\s\S]*\b(CREATE|ALTER)\b/i, "Statements may not modify SNOWFLAKE objects"],
  [/\bSYSTEM\$[A-Z_]+\s*\(/i, "System functions are not allowed in a fix"],
  [/--|\/\*/, "Comments are not allowed (put explanations in the fix summary)"],
]

/** Replace quoted string literals and $$-bodies' literals so checks see only SQL structure. */
function stripLiterals(sql: string): string {
  return sql.replace(/'(?:[^']|'')*'/g, "''")
}

/** Find database-qualified references: <db>.<schema>.<object>. */
function databaseRefs(sql: string): string[] {
  const refs: string[] = []
  const re = /(\{\{DB\}\}|"[^"]+"|[A-Za-z_][A-Za-z0-9_$]*)\s*\.\s*("[^"]+"|[A-Za-z_][A-Za-z0-9_$]*)\s*\.\s*("[^"]+"|[A-Za-z_][A-Za-z0-9_$]*)/g
  let m: RegExpExecArray | null
  while ((m = re.exec(sql))) refs.push(m[1])
  return refs
}

export function classify(statement: string): StatementKind | null {
  const s = statement.trim()
  for (const [kind, re] of KIND_PATTERNS) if (re.test(s)) return kind
  return null
}

const OBJ = String.raw`((?:\{\{DB\}\}|"[^"]+"|[A-Za-z_][A-Za-z0-9_$]*)(?:\s*\.\s*(?:"[^"]+"|[A-Za-z_][A-Za-z0-9_$]*)){0,2})`
const TARGET_PATTERNS: RegExp[] = [
  new RegExp(String.raw`^CREATE\s+(?:OR\s+REPLACE\s+)?(?:TRANSIENT\s+|SECURE\s+|RECURSIVE\s+)*(?:DYNAMIC\s+TABLE|TABLE|VIEW|TASK)\s+(?:IF\s+NOT\s+EXISTS\s+)?${OBJ}`, "i"),
  new RegExp(String.raw`^ALTER\s+(?:DYNAMIC\s+TABLE|TABLE|VIEW|TASK)\s+(?:IF\s+EXISTS\s+)?${OBJ}`, "i"),
  new RegExp(String.raw`^INSERT\s+INTO\s+${OBJ}`, "i"),
  new RegExp(String.raw`^UPDATE\s+${OBJ}`, "i"),
  new RegExp(String.raw`^DELETE\s+FROM\s+${OBJ}`, "i"),
  new RegExp(String.raw`^MERGE\s+INTO\s+${OBJ}`, "i"),
]

/** The object a statement writes to (CREATE/ALTER/INSERT/UPDATE/DELETE/MERGE target). */
export function writeTarget(statement: string): string | null {
  const s = statement.trim()
  for (const re of TARGET_PATTERNS) {
    const m = re.exec(s)
    if (m) return m[1].replace(/\s+/g, "")
  }
  return null
}

export function screenStatements(statements: string[], opts: { maxStatements?: number } = {}): ScreenResult {
  const errors: string[] = []
  const max = opts.maxStatements ?? 25
  if (statements.length > max) errors.push(`At most ${max} statements are allowed (got ${statements.length})`)
  const screened = statements.map((raw, index): ScreenedStatement => {
    const text = raw.trim()
    const e: string[] = []
    if (!text) e.push("Empty statement")
    if (/;\s*$/.test(text)) e.push("Remove the trailing semicolon (one statement per entry)")
    const structural = stripLiterals(text)
    if (/;\s*\S/.test(structural.replace(/\$\$[\s\S]*?\$\$/g, ""))) e.push("Multiple statements in one entry")
    const kind = classify(text)
    if (!kind) e.push("Statement type is not allowed (allowed: CREATE/ALTER TABLE, VIEW, DYNAMIC TABLE, TASK; INSERT; UPDATE; DELETE; MERGE)")
    for (const [re, msg] of FORBIDDEN) if (re.test(structural)) e.push(msg)
    const refs = databaseRefs(structural)
    const literal = refs.filter((r) => r !== PLACEHOLDER)
    if (literal.length) e.push(`Use {{DB}} instead of the literal database name(s): ${[...new Set(literal)].join(", ")}`)
    if (kind && !text.includes(PLACEHOLDER)) e.push("Statement must reference the job's database through {{DB}}.<schema>.<object>")
    if (kind) {
      const target = writeTarget(text)
      if (!target || !/^\{\{DB\}\}\.[^.]+\.[^.]+$/.test(target)) {
        e.push(`The object being created or changed must be fully qualified as {{DB}}.<schema>.<object> (found ${target ?? "none"})`)
      }
    }
    if ((kind === "UPDATE" || kind === "DELETE") && !/\bWHERE\b/i.test(structural)) e.push(`${kind} must have a WHERE clause`)
    return { index, kind, text, errors: e }
  })
  for (const s of screened) for (const e of s.errors) errors.push(`statement ${s.index + 1}: ${e}`)
  return { ok: errors.length === 0, statements: screened, errors }
}

/** Objects created (not altered) by forward statements, as normalized {{DB}}.S.O names. */
export function createdObjects(statements: string[]): Set<string> {
  const out = new Set<string>()
  const re = /^CREATE\s+(?:OR\s+REPLACE\s+)?(?:TRANSIENT\s+|SECURE\s+|RECURSIVE\s+)*(?:DYNAMIC\s+TABLE|TABLE|VIEW)\s+(?:IF\s+NOT\s+EXISTS\s+)?(\{\{DB\}\}\s*\.\s*["A-Za-z_][^.\s(]*\s*\.\s*["A-Za-z_][^\s(]*)/i
  for (const s of statements) {
    const m = re.exec(s.trim())
    if (m) out.add(m[1].replace(/\s+/g, "").toUpperCase())
  }
  return out
}

const ROLLBACK_DROP = /^DROP\s+(TABLE|VIEW|DYNAMIC\s+TABLE)\s+(?:IF\s+EXISTS\s+)?(\{\{DB\}\}\s*\.\s*["A-Za-z_][^.\s]*\s*\.\s*["A-Za-z_]\S*)$/i

/**
 * Screen rollback statements. Same rules as forward statements, plus one
 * exception: a rollback may DROP an object that the fix itself CREATES (the
 * only honest inverse of "create the missing table").
 */
export function screenRollback(rollback: string[], forward: string[]): ScreenResult {
  const created = createdObjects(forward)
  const allowedDrops: number[] = []
  const errors: string[] = []
  rollback.forEach((s, i) => {
    const m = ROLLBACK_DROP.exec(s.trim())
    if (!m) return
    const target = m[2].replace(/\s+/g, "").toUpperCase()
    if (created.has(target)) allowedDrops.push(i)
    else errors.push(`statement ${i + 1}: a rollback may only drop objects that the fix creates (${m[2]} is not created by the fix)`)
  })
  const rest = rollback.map((s, i) => (allowedDrops.includes(i) || errors.some((e) => e.startsWith(`statement ${i + 1}:`)) ? null : s))
  const screened = screenStatements(rest.filter((s): s is string => s !== null))
  // Re-number errors back to the original rollback positions.
  const indexMap = rest.map((s, i) => (s === null ? -1 : i)).filter((i) => i >= 0)
  for (const e of screened.errors) {
    const m = /^statement (\d+): (.*)$/.exec(e)
    errors.push(m ? `statement ${indexMap[Number(m[1]) - 1] + 1}: ${m[2]}` : e)
  }
  return { ok: errors.length === 0, statements: screened.statements, errors }
}

/** Bind the {{DB}} placeholder to a concrete database (identifier-quoted). */
export function bindDatabase(statement: string, database: string): string {
  if (!/^[A-Z_][A-Z0-9_$]{0,254}$/i.test(database)) throw new Error(`Refusing to bind unsafe database name: ${database}`)
  return statement.split(PLACEHOLDER).join(database.toUpperCase())
}

/** Canonical hash input for a fix: what was reviewed is exactly what is applied. */
export function canonicalFix(statements: string[], rollback: string[]): string {
  return JSON.stringify({ statements: statements.map((s) => s.trim()), rollback: rollback.map((s) => s.trim()) })
}
