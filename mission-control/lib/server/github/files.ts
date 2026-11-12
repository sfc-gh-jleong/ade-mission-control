/**
 * Text rules for Git delivery. No I/O, so it is unit-tested directly
 * (__tests__/lib/github-files.test.ts).
 *
 * The demo repo keeps one statement per file, objects/<schema>/<name>.sql:
 *
 *   CREATE OR ALTER TASK {{DB}}.ORCHESTRATION.CLEAN_ORDERS
 *     WAREHOUSE = COMPUTE_WH
 *     AFTER {{DB}}.ORCHESTRATION.LOAD_ORDERS
 *   AS
 *     MERGE INTO ...;
 *
 * a header, a line that is exactly AS, and the body. For a database managed
 * in Git a fix may only replace the body of the failing task or dynamic table.
 * Code here (not an agent) copies the rehearsed body into the file, so the pull
 * request changes exactly what the sandbox ran and the Reviewer approved.
 */
import { createHash } from "node:crypto"
import { createTwoFilesPatch } from "diff"

export type GitJobType = "TASK" | "DYNAMIC_TABLE"

export interface ObjectFile {
  /** Everything before the AS line, trailing whitespace removed. */
  header: string
  /** Everything after the AS line, without the final semicolon. */
  body: string
  /** Indentation of the body's first non-empty line. */
  indent: string
}

export interface GitJob {
  type: GitJobType
  schema: string
  name: string
}

export type GitFixShape =
  | { kind: "BODY"; body: string }
  | { kind: "DEPLOY_ONLY"; objects: string[] }
  | { kind: "INVALID"; error: string }

export function parseObjectFile(content: string): ObjectFile | null {
  const text = content.replace(/\r\n?/g, "\n")
  const m = /^AS[ \t]*$/m.exec(text)
  if (!m) return null
  const header = text.slice(0, m.index).replace(/\s+$/, "")
  let body = text.slice(m.index + m[0].length).replace(/^\n/, "").replace(/\s+$/, "")
  if (body.endsWith(";")) body = body.slice(0, -1).replace(/\s+$/, "")
  if (!header || !body.trim()) return null
  const first = body.split("\n").find((l) => l.trim()) ?? ""
  return { header, body, indent: /^[ \t]*/.exec(first)?.[0] ?? "" }
}

const IDENT = String.raw`("[^"]+"|[A-Za-z_][A-Za-z0-9_$]*)`
const FQN = String.raw`\{\{DB\}\}\s*\.\s*${IDENT}\s*\.\s*${IDENT}`
const unquote = (part: string) => (part.startsWith('"') ? part.slice(1, -1) : part.toUpperCase())
const key = (schema: string, name: string) => `${unquote(schema)}.${unquote(name)}`

/** The object a repo file defines (from its header), e.g. TASK ORCHESTRATION.CLEAN_ORDERS. */
export function fileObject(header: string): GitJob | null {
  const m = new RegExp(String.raw`^\s*CREATE\s+OR\s+ALTER\s+(TASK|DYNAMIC\s+TABLE)\s+${FQN}`, "i").exec(header)
  if (!m) return null
  return { type: /^TASK$/i.test(m[1]) ? "TASK" : "DYNAMIC_TABLE", schema: unquote(m[2]), name: unquote(m[3]) }
}

/** True if a quoted literal or $$ block in the text spans a line break. */
export function hasMultilineLiteral(sql: string): boolean {
  let inString = false
  for (let i = 0; i < sql.length; i++) {
    const c = sql[i]
    if (inString) {
      if (c === "\\") i++
      else if (c === "'" && sql[i + 1] === "'") i++
      else if (c === "'") inString = false
      else if (c === "\n") return true
    } else if (c === "'") {
      inString = true
    } else if (c === "$" && sql[i + 1] === "$") {
      const end = sql.indexOf("$$", i + 2)
      if (end < 0 || sql.slice(i + 2, end).includes("\n")) return true
      i = end + 1
    }
  }
  return inString
}

/**
 * Lay out a body the way the repo files are laid out: common indentation
 * removed, then every line indented like the file's body. A body with a
 * multi-line literal is kept exactly as written (re-indenting would change it).
 */
export function formatBody(raw: string, indent: string): string {
  const text = raw.replace(/\r\n?/g, "\n").replace(/^\s*\n/, "").replace(/\s+$/, "").replace(/;$/, "").replace(/\s+$/, "")
  if (hasMultilineLiteral(text)) return text
  const lines = text.split("\n").map((l) => l.replace(/[ \t]+$/, ""))
  const widths = lines.filter((l) => l.trim()).map((l) => /^[ \t]*/.exec(l)![0].length)
  const common = widths.length ? Math.min(...widths) : 0
  return lines.map((l) => (l.trim() ? indent + l.slice(common) : "")).join("\n")
}

export function renderObjectFile(file: Pick<ObjectFile, "header">, formattedBody: string): string {
  return `${file.header}\nAS\n${formattedBody};\n`
}

/**
 * Comparable form of SQL text: whitespace runs outside quoted literals become
 * one space, and a trailing semicolon is dropped. Snowflake stores task and
 * dynamic table definitions as written, so this is enough to tell whether
 * production runs the code in a file.
 */
export function normalizeSql(text: string): string {
  const s = text.replace(/\r\n?/g, "\n").trim().replace(/;\s*$/, "").trim()
  let out = ""
  let inString = false
  let space = false
  for (let i = 0; i < s.length; i++) {
    const c = s[i]
    if (inString) {
      out += c
      if (c === "\\" && i + 1 < s.length) out += s[++i]
      else if (c === "'" && s[i + 1] === "'") out += s[++i]
      else if (c === "'") inString = false
      continue
    }
    if (/\s/.test(c)) {
      space = true
      continue
    }
    if (space && out) out += " "
    space = false
    if (c === "'") inString = true
    out += c
  }
  return out
}

/** git's object id for a file: SHA-1 of "blob <bytes>\0<content>". */
export function gitBlobSha(content: string): string {
  const bytes = Buffer.from(content, "utf8")
  return createHash("sha1").update(`blob ${bytes.length}\0`).update(bytes).digest("hex")
}

export function patchHash(path: string, baseBlobSha: string, newBlobSha: string): string {
  return createHash("sha256").update(`${path}\n${baseBlobSha}\n${newBlobSha}`).digest("hex")
}

export function unifiedDiff(path: string, before: string, after: string): string {
  return createTwoFilesPatch(`a/${path}`, `b/${path}`, before, after, undefined, undefined, { context: 3 })
    .replace(/^=+\n/, "")
}

export interface SourceChange {
  newContent: string
  newBlobSha: string
  diff: string
  patchHash: string
  /** The file already has this body (ignoring layout): deploying main is the fix. */
  unchanged: boolean
}

/** The job's file with its body replaced by a fix's body (header kept byte for byte). */
export function buildChange(base: { path: string; baseContent: string; baseBlobSha: string; file: ObjectFile }, body: string): SourceChange {
  const formatted = formatBody(body, base.file.indent)
  const newContent = renderObjectFile(base.file, formatted)
  const newBlobSha = gitBlobSha(newContent)
  return {
    newContent,
    newBlobSha,
    diff: unifiedDiff(base.path, base.baseContent, newContent),
    patchHash: patchHash(base.path, base.baseBlobSha, newBlobSha),
    unchanged: newBlobSha === base.baseBlobSha || normalizeSql(formatted) === normalizeSql(base.file.body),
  }
}

/**
 * The body that follows `AS` in a statement, with the layout it had there.
 * Written on the next line, the body keeps that line's indentation. Written on
 * the same line as AS, its first line gets the indentation of the least
 * indented line below it, so formatBody keeps the rest of the layout as is.
 */
function bodyAfterAs(text: string): string {
  const sameLine = text.replace(/^[ \t]+/, "")
  if (!sameLine.startsWith("\n") && !sameLine.startsWith("\r")) {
    const rest = sameLine.split(/\r?\n/).slice(1).filter((l) => l.trim())
    const indent = rest.length ? rest.map((l) => /^[ \t]*/.exec(l)![0]).reduce((a, b) => (b.length < a.length ? b : a)) : ""
    return hasMultilineLiteral(sameLine) ? sameLine : indent + sameLine
  }
  return sameLine.replace(/^(?:[ \t]*\r?\n)+/, "")
}

/** Replace quoted literals with blanks of the same length (keeps indexes stable). */
function blankLiterals(sql: string): string {
  return sql.replace(/'(?:[^'\\]|\\[\s\S]|'')*'/g, (m) => `'${" ".repeat(m.length - 2)}'`)
}

const DT_OPTION = /\b(TARGET_LAG|WAREHOUSE|REFRESH_MODE|INITIALIZE)\s*=\s*('(?:[^']|'')*'|[A-Za-z0-9_$"]+)/gi

function dtOptions(text: string): Map<string, string> {
  const out = new Map<string, string>()
  for (const m of blankLiterals(text).matchAll(DT_OPTION)) {
    out.set(m[1].toUpperCase(), text.slice(m.index! + m[0].length - m[2].length, m.index! + m[0].length).toUpperCase())
  }
  return out
}

const GIT_RULE =
  "This job's code lives in Git: a fix may only replace the body of the failing job " +
  "(ALTER TASK {{DB}}.<SCHEMA>.<TASK> MODIFY AS ..., optionally between ALTER TASK ... SUSPEND and RESUME; " +
  "or one CREATE OR REPLACE DYNAMIC TABLE {{DB}}.<SCHEMA>.<NAME> ... AS <query> with the repo file's TARGET_LAG, WAREHOUSE and REFRESH_MODE)"

/**
 * Check that a fix has a shape Git delivery can carry, and extract the new body.
 *
 *   BODY         the new body of the failing task or dynamic table
 *   DEPLOY_ONLY  the fix only (re)creates objects the repo already defines, so
 *                deploying main is the fix
 *   INVALID      anything else (sent back to the Fixer with this error)
 *
 * `repoDefined` holds SCHEMA.NAME of every object the repo defines; `fileHeader`
 * is the job's file header (for dynamic table options).
 */
export function classifyGitFix(statements: string[], job: GitJob, repoDefined: Set<string>, fileHeader: string): GitFixShape {
  const stmts = statements.map((s) => s.trim()).filter(Boolean)
  const jobKey = `${job.schema.toUpperCase()}.${job.name.toUpperCase()}`
  if (!stmts.length) return { kind: "INVALID", error: GIT_RULE }

  const taskControl = new RegExp(String.raw`^ALTER\s+TASK\s+(?:IF\s+EXISTS\s+)?${FQN}\s+(SUSPEND|RESUME)$`, "i")
  const dtControl = new RegExp(String.raw`^ALTER\s+DYNAMIC\s+TABLE\s+(?:IF\s+EXISTS\s+)?${FQN}\s+(REFRESH|RESUME|SUSPEND)$`, "i")
  const create = new RegExp(String.raw`^CREATE\s+(?:OR\s+REPLACE\s+)?(?:TRANSIENT\s+)?(TABLE|VIEW|DYNAMIC\s+TABLE)\s+(?:IF\s+NOT\s+EXISTS\s+)?${FQN}`, "i")

  // DEPLOY_ONLY: only creates of repo-defined objects (plus task/DT control statements).
  const creates = stmts.map((s) => create.exec(s))
  if (creates.some(Boolean) && !/^CREATE\s+OR\s+REPLACE\s+DYNAMIC\s+TABLE\b/i.test(stmts.find((_, i) => creates[i]) ?? "")) {
    const objects: string[] = []
    for (let i = 0; i < stmts.length; i++) {
      const c = creates[i]
      if (c) {
        const k = key(c[2], c[3])
        if (!repoDefined.has(k)) return { kind: "INVALID", error: `${GIT_RULE}. ${k} is not defined in the repo, so it cannot be created through Git` }
        objects.push(k)
      } else if (!taskControl.test(stmts[i]) && !dtControl.test(stmts[i])) {
        return { kind: "INVALID", error: `${GIT_RULE}. A fix that recreates a missing object may not also change other objects (statement ${i + 1})` }
      }
    }
    return { kind: "DEPLOY_ONLY", objects }
  }

  let body: string | null = null
  for (let i = 0; i < stmts.length; i++) {
    const s = stmts[i]
    const n = i + 1
    if (job.type === "TASK") {
      const modify = new RegExp(String.raw`^ALTER\s+TASK\s+(?:IF\s+EXISTS\s+)?${FQN}\s+MODIFY\s+AS\b([\s\S]+)$`, "i").exec(s)
      if (modify) {
        if (key(modify[1], modify[2]) !== jobKey) return { kind: "INVALID", error: `${GIT_RULE}. Statement ${n} changes ${key(modify[1], modify[2])}, not the failing job ${jobKey}` }
        if (body !== null) return { kind: "INVALID", error: `${GIT_RULE}. Use exactly one MODIFY AS (statement ${n} is a second one)` }
        body = bodyAfterAs(modify[3])
        continue
      }
      const control = taskControl.exec(s)
      if (control && key(control[1], control[2]) === jobKey) continue
      return { kind: "INVALID", error: `${GIT_RULE}. Statement ${n} is not allowed: warehouse, schedule, predecessors, condition and comment are part of the repo file's header and stay as they are` }
    }

    const control = dtControl.exec(s)
    if (control && key(control[1], control[2]) === jobKey) continue
    const replace = new RegExp(String.raw`^CREATE\s+OR\s+REPLACE\s+DYNAMIC\s+TABLE\s+${FQN}([\s\S]*)$`, "i").exec(s)
    if (!replace) return { kind: "INVALID", error: `${GIT_RULE}. Statement ${n} is not allowed` }
    if (key(replace[1], replace[2]) !== jobKey) return { kind: "INVALID", error: `${GIT_RULE}. Statement ${n} replaces ${key(replace[1], replace[2])}, not the failing job ${jobKey}` }
    if (body !== null) return { kind: "INVALID", error: `${GIT_RULE}. Use exactly one CREATE OR REPLACE DYNAMIC TABLE (statement ${n} is a second one)` }
    const rest = replace[3]
    const as = /\bAS\s+(?=SELECT\b|WITH\b|\()/i.exec(blankLiterals(rest))
    if (!as) return { kind: "INVALID", error: `${GIT_RULE}. Statement ${n} has no AS <query>` }
    const options = rest.slice(0, as.index)
    if (/^\s*\(/.test(options)) return { kind: "INVALID", error: `${GIT_RULE}. Column lists are not supported; keep the repo file's header` }
    const want = dtOptions(fileHeader)
    for (const [k, v] of dtOptions(options)) {
      if (want.get(k) !== v) return { kind: "INVALID", error: `${GIT_RULE}. ${k} must stay ${want.get(k) ?? "unset"} as in the repo file (statement ${n} sets ${v})` }
    }
    body = bodyAfterAs(rest.slice(as.index).replace(/^AS/i, ""))
  }
  if (body === null || !body.trim()) return { kind: "INVALID", error: GIT_RULE }
  return { kind: "BODY", body }
}
