import { describe, expect, it } from "vitest"
import { bindDatabase } from "@/lib/server/agents/sql-guard"
import {
  buildChange,
  classifyGitFix,
  fileObject,
  formatBody,
  gitBlobSha,
  hasMultilineLiteral,
  normalizeSql,
  parseObjectFile,
  patchHash,
  renderObjectFile,
  unifiedDiff,
  type GitJob,
} from "@/lib/server/github/files"

// Copies of sfc-gh-jleong/ade-demo-retail objects/ files.
const TASK_FILE = `CREATE OR ALTER TASK {{DB}}.ORCHESTRATION.BUILD_DAILY_REVENUE
  WAREHOUSE = COMPUTE_WH
  COMMENT = 'Rebuilds MART.DAILY_REVENUE from STAGING.ORDERS_CLEAN'
  AFTER {{DB}}.ORCHESTRATION.CLEAN_ORDERS
AS
  INSERT OVERWRITE INTO {{DB}}.MART.DAILY_REVENUE
    (ORDER_DATE, CHANNEL, ORDERS, REVENUE_USD, AVG_ORDER_USD, DISCOUNT_PCT, BUILT_AT)
  SELECT ORDER_DATE,
         CHANNEL,
         COUNT(*),
         SUM(AMOUNT_USD),
         ROUND(SUM(AMOUNT_USD) / COUNT(*), 2),
         ROUND(100 * SUM(DISCOUNT_USD) / SUM(AMOUNT_USD), 2),
         SYSDATE()
  FROM {{DB}}.STAGING.ORDERS_CLEAN
  GROUP BY ORDER_DATE, CHANNEL;
`

const DT_FILE = `CREATE OR ALTER DYNAMIC TABLE {{DB}}.MART.CUSTOMER_LTV
  TARGET_LAG = '1 day'
  WAREHOUSE = COMPUTE_WH
  REFRESH_MODE = FULL
  COMMENT = 'Customer lifetime value by region'
AS
  SELECT c.CUSTOMER_ID,
         c.FULL_NAME,
         c.REGION,
         COUNT(o.ORDER_ID)  AS ORDERS,
         SUM(o.AMOUNT_USD)  AS LIFETIME_USD,
         MAX(o.ORDER_DATE)  AS LAST_ORDER_DATE
  FROM {{DB}}.RAW.CUSTOMERS c
  LEFT JOIN {{DB}}.STAGING.ORDERS_CLEAN o ON o.CUSTOMER_ID = c.CUSTOMER_ID
  GROUP BY c.CUSTOMER_ID, c.FULL_NAME, c.REGION;
`

const REPO_DEFINED = new Set([
  "ORCHESTRATION.CLEAN_ORDERS",
  "ORCHESTRATION.BUILD_DAILY_REVENUE",
  "ORCHESTRATION.PUBLISH_SNAPSHOT",
  "MART.CUSTOMER_LTV",
  "STAGING.ORDERS_CLEAN",
  "MART.DAILY_REVENUE",
  "MART.REVENUE_SNAPSHOTS",
  "DEPLOY.CHANGE_HISTORY",
])
const TASK: GitJob = { type: "TASK", schema: "ORCHESTRATION", name: "BUILD_DAILY_REVENUE" }
const DT: GitJob = { type: "DYNAMIC_TABLE", schema: "MART", name: "CUSTOMER_LTV" }

describe("object files", () => {
  it("round-trips the repo's task and dynamic table files exactly", () => {
    for (const content of [TASK_FILE, DT_FILE]) {
      const f = parseObjectFile(content)!
      expect(f.indent).toBe("  ")
      expect(renderObjectFile(f, formatBody(f.body, f.indent))).toBe(content)
    }
  })

  it("reads the object a file defines from its header", () => {
    expect(fileObject(parseObjectFile(TASK_FILE)!.header)).toEqual(TASK)
    expect(fileObject(parseObjectFile(DT_FILE)!.header)).toEqual(DT)
    expect(fileObject("CREATE TABLE IF NOT EXISTS {{DB}}.MART.X (A NUMBER)")).toBeNull()
  })

  it("rejects files without an AS line", () => {
    expect(parseObjectFile("CREATE OR ALTER TASK {{DB}}.S.T AS SELECT 1;")).toBeNull()
  })

  it("indents a body like the file, and keeps multi-line literals verbatim", () => {
    expect(formatBody("SELECT 1\nFROM x;\n", "  ")).toBe("  SELECT 1\n  FROM x")
    expect(formatBody("      SELECT 1\n        FROM x", "  ")).toBe("  SELECT 1\n    FROM x")
    const literal = "SELECT 'a\n   b' AS v"
    expect(hasMultilineLiteral(literal)).toBe(true)
    expect(formatBody(literal, "  ")).toBe(literal)
    expect(hasMultilineLiteral("SELECT 'it''s' AS v\nFROM x")).toBe(false)
  })
})

describe("classifyGitFix", () => {
  const header = parseObjectFile(TASK_FILE)!.header
  const dtHeader = parseObjectFile(DT_FILE)!.header

  it("extracts the body of a task fix with SUSPEND / MODIFY AS / RESUME", () => {
    const r = classifyGitFix(
      [
        "ALTER TASK {{DB}}.ORCHESTRATION.BUILD_DAILY_REVENUE SUSPEND",
        "ALTER TASK {{DB}}.ORCHESTRATION.BUILD_DAILY_REVENUE MODIFY AS INSERT OVERWRITE INTO {{DB}}.MART.DAILY_REVENUE SELECT 1",
        "ALTER TASK {{DB}}.ORCHESTRATION.BUILD_DAILY_REVENUE RESUME",
      ],
      TASK,
      REPO_DEFINED,
      header,
    )
    expect(r).toEqual({ kind: "BODY", body: "INSERT OVERWRITE INTO {{DB}}.MART.DAILY_REVENUE SELECT 1" })
  })

  it("rejects changes to other tasks, to the header, and a second MODIFY AS", () => {
    const other = classifyGitFix(["ALTER TASK {{DB}}.ORCHESTRATION.CLEAN_ORDERS MODIFY AS SELECT 1"], TASK, REPO_DEFINED, header)
    expect(other.kind).toBe("INVALID")
    const root = classifyGitFix(
      ["ALTER TASK {{DB}}.ORCHESTRATION.BUILD_DAILY_REVENUE MODIFY AS SELECT 1", "ALTER TASK {{DB}}.ORCHESTRATION.LOAD_ORDERS RESUME"],
      TASK,
      REPO_DEFINED,
      header,
    )
    expect(root.kind).toBe("INVALID")
    expect(classifyGitFix(["ALTER TASK {{DB}}.ORCHESTRATION.BUILD_DAILY_REVENUE SET WAREHOUSE = BIG_WH"], TASK, REPO_DEFINED, header).kind).toBe("INVALID")
    const twice = classifyGitFix(
      ["ALTER TASK {{DB}}.ORCHESTRATION.BUILD_DAILY_REVENUE MODIFY AS SELECT 1", "ALTER TASK {{DB}}.ORCHESTRATION.BUILD_DAILY_REVENUE MODIFY AS SELECT 2"],
      TASK,
      REPO_DEFINED,
      header,
    )
    expect(twice.kind).toBe("INVALID")
    expect(classifyGitFix(["UPDATE {{DB}}.RAW.ORDERS SET AMOUNT = '0' WHERE AMOUNT = 'N/A'"], TASK, REPO_DEFINED, header).kind).toBe("INVALID")
  })

  it("treats recreating a table the repo defines as a deploy", () => {
    const r = classifyGitFix(["CREATE TABLE IF NOT EXISTS {{DB}}.MART.DAILY_REVENUE (ORDER_DATE DATE)"], TASK, REPO_DEFINED, header)
    expect(r).toEqual({ kind: "DEPLOY_ONLY", objects: ["MART.DAILY_REVENUE"] })
    const unknown = classifyGitFix(["CREATE TABLE IF NOT EXISTS {{DB}}.MART.NEW_THING (A NUMBER)"], TASK, REPO_DEFINED, header)
    expect(unknown.kind).toBe("INVALID")
    const mixed = classifyGitFix(
      ["CREATE TABLE IF NOT EXISTS {{DB}}.MART.DAILY_REVENUE (ORDER_DATE DATE)", "ALTER TASK {{DB}}.ORCHESTRATION.BUILD_DAILY_REVENUE MODIFY AS SELECT 1"],
      TASK,
      REPO_DEFINED,
      header,
    )
    expect(mixed.kind).toBe("INVALID")
  })

  it("extracts the query of a dynamic table fix and keeps the file's options", () => {
    const ok = classifyGitFix(
      ["CREATE OR REPLACE DYNAMIC TABLE {{DB}}.MART.CUSTOMER_LTV TARGET_LAG = '1 day' WAREHOUSE = COMPUTE_WH REFRESH_MODE = FULL COMMENT = 'region AS SELECT trap' AS SELECT c.SALES_REGION AS REGION FROM {{DB}}.RAW.CUSTOMERS c"],
      DT,
      REPO_DEFINED,
      dtHeader,
    )
    expect(ok).toEqual({ kind: "BODY", body: "SELECT c.SALES_REGION AS REGION FROM {{DB}}.RAW.CUSTOMERS c" })
    const lag = classifyGitFix(
      ["CREATE OR REPLACE DYNAMIC TABLE {{DB}}.MART.CUSTOMER_LTV TARGET_LAG = '5 minutes' WAREHOUSE = COMPUTE_WH AS SELECT 1"],
      DT,
      REPO_DEFINED,
      dtHeader,
    )
    expect(lag.kind).toBe("INVALID")
    const otherDt = classifyGitFix(["CREATE OR REPLACE DYNAMIC TABLE {{DB}}.MART.OTHER TARGET_LAG = '1 day' WAREHOUSE = COMPUTE_WH AS SELECT 1"], DT, REPO_DEFINED, dtHeader)
    expect(otherDt.kind).toBe("INVALID")
  })
})

describe("drift normalization", () => {
  it("ignores whitespace and a trailing semicolon but not literal contents", () => {
    const file = parseObjectFile(TASK_FILE)!.body.split("{{DB}}").join("ADE_DEMO_RETAIL")
    const production = file.replace(/\n\s*/g, " ") + ";"
    expect(normalizeSql(production)).toBe(normalizeSql(file))
    expect(normalizeSql("SELECT 'a  b'")).not.toBe(normalizeSql("SELECT 'a b'"))
    expect(normalizeSql("SELECT  'it''s'   ,  1")).toBe("SELECT 'it''s' , 1")
  })
})

describe("hashes and diff", () => {
  it("computes git's blob SHA", () => {
    // printf 'CREATE X\nAS\n  SELECT 1;\n' | git hash-object --stdin
    expect(gitBlobSha("CREATE X\nAS\n  SELECT 1;\n")).toBe("ee2a63f06c6c5a78d23b9491aaca148a35f216a5")
    expect(gitBlobSha("é\n")).toHaveLength(40)
  })

  it("binds the patch hash to the path and both blobs", () => {
    const h = patchHash("objects/a.sql", "a".repeat(40), "b".repeat(40))
    expect(h).toMatch(/^[0-9a-f]{64}$/)
    expect(patchHash("objects/b.sql", "a".repeat(40), "b".repeat(40))).not.toBe(h)
  })

  it("produces a unified diff of the file", () => {
    const f = parseObjectFile(TASK_FILE)!
    const after = renderObjectFile(f, formatBody(f.body.replace("SUM(AMOUNT_USD), 2)", "NULLIF(SUM(AMOUNT_USD), 0), 2)"), f.indent))
    const d = unifiedDiff("objects/orchestration/build_daily_revenue.sql", TASK_FILE, after)
    expect(d.startsWith("--- a/objects/orchestration/build_daily_revenue.sql\n+++ b/objects/orchestration/build_daily_revenue.sql\n")).toBe(true)
    expect(d).toContain("+         ROUND(100 * SUM(DISCOUNT_USD) / NULLIF(SUM(AMOUNT_USD), 0), 2),")
  })
})

/** The +/- lines of a diff, without its ---/+++ header. */
const changedLines = (diff: string) => diff.split("\n").filter((l) => /^[-+](?![-+]{2} )/.test(l))

describe("fix statements to file change (what the PR opener re-derives)", () => {
  const f = parseObjectFile(TASK_FILE)!
  const base = { path: "objects/orchestration/build_daily_revenue.sql", baseContent: TASK_FILE, baseBlobSha: gitBlobSha(TASK_FILE), file: f }
  const fixedBody = f.body.replace("ROUND(100 * SUM(DISCOUNT_USD) / SUM(AMOUNT_USD), 2)", "ROUND(100 * SUM(DISCOUNT_USD) / NULLIF(SUM(AMOUNT_USD), 0), 2)")
  const task = (afterAs: string) => [
    "ALTER TASK {{DB}}.ORCHESTRATION.BUILD_DAILY_REVENUE SUSPEND",
    `ALTER TASK {{DB}}.ORCHESTRATION.BUILD_DAILY_REVENUE MODIFY AS${afterAs}`,
    "ALTER TASK {{DB}}.ORCHESTRATION.BUILD_DAILY_REVENUE RESUME",
  ]
  const bodyOf = (statements: string[], job: GitJob = TASK, header = f.header) => {
    const shape = classifyGitFix(statements, job, REPO_DEFINED, header)
    if (shape.kind !== "BODY") throw new Error(`expected BODY, got ${JSON.stringify(shape)}`)
    return shape.body
  }

  it("changes only the lines the fix changes, however the Fixer laid out the body", () => {
    const layouts = {
      nextLine: "\n" + fixedBody,
      sameLine: " " + fixedBody.trimStart(),
      unindented: "\n" + fixedBody.split("\n").map((l) => l.slice(2)).join("\n"),
      deeper: "\n" + fixedBody.split("\n").map((l) => "      " + l).join("\n"),
    }
    for (const [name, layout] of Object.entries(layouts)) {
      const change = buildChange(base, bodyOf(task(layout)))
      expect(change.unchanged, name).toBe(false)
      expect(changedLines(change.diff), name).toEqual([
        "-         ROUND(100 * SUM(DISCOUNT_USD) / SUM(AMOUNT_USD), 2),",
        "+         ROUND(100 * SUM(DISCOUNT_USD) / NULLIF(SUM(AMOUNT_USD), 0), 2),",
      ])
    }
  })

  it("writes a file that deploys exactly the SQL that was rehearsed", () => {
    const body = bodyOf(task(" " + fixedBody.trimStart()))
    const change = buildChange(base, body)
    const written = parseObjectFile(change.newContent)!
    expect(written.header).toBe(f.header)
    expect(normalizeSql(bindDatabase(written.body, "ADE_DEMO_RETAIL"))).toBe(normalizeSql(bindDatabase(body, "ADE_DEMO_RETAIL")))
    expect(change.newBlobSha).toBe(gitBlobSha(change.newContent))
    expect(change.patchHash).toBe(patchHash(base.path, base.baseBlobSha, change.newBlobSha))
    // The PR opener derives the same blob again from the same statements.
    expect(buildChange(base, bodyOf(task(" " + fixedBody.trimStart()))).newBlobSha).toBe(change.newBlobSha)
    // Layout is stable: rebuilding from the written file changes nothing.
    const again = buildChange({ ...base, baseContent: change.newContent, baseBlobSha: change.newBlobSha, file: written }, written.body)
    expect(again.newContent).toBe(change.newContent)
  })

  it("treats main's own body, in any layout, as unchanged (deploying main is the fix)", () => {
    for (const layout of ["\n" + f.body, " " + f.body.trimStart(), "\n" + f.body.replace(/\n[ \t]+/g, "\n")]) {
      expect(buildChange(base, bodyOf(task(layout))).unchanged).toBe(true)
    }
  })

  it("keeps a dynamic table's header and options, and changes only the query lines", () => {
    const d = parseObjectFile(DT_FILE)!
    const dtBase = { path: "objects/mart/customer_ltv.sql", baseContent: DT_FILE, baseBlobSha: gitBlobSha(DT_FILE), file: d }
    const query = d.body.replace("c.REGION,", "c.SALES_REGION AS REGION,").replace("c.FULL_NAME, c.REGION", "c.FULL_NAME, c.SALES_REGION")
    const stmt = `CREATE OR REPLACE DYNAMIC TABLE {{DB}}.MART.CUSTOMER_LTV\n  TARGET_LAG = '1 day'\n  WAREHOUSE = COMPUTE_WH\n  REFRESH_MODE = FULL\nAS\n${query}`
    const change = buildChange(dtBase, bodyOf([stmt], DT, d.header))
    expect(parseObjectFile(change.newContent)!.header).toBe(d.header)
    expect(changedLines(change.diff)).toEqual([
      "-         c.REGION,",
      "+         c.SALES_REGION AS REGION,",
      "-  GROUP BY c.CUSTOMER_ID, c.FULL_NAME, c.REGION;",
      "+  GROUP BY c.CUSTOMER_ID, c.FULL_NAME, c.SALES_REGION;",
    ])
  })

  it("keeps a body with a multi-line literal exactly as rehearsed", () => {
    const body = "INSERT OVERWRITE INTO {{DB}}.MART.DAILY_REVENUE SELECT 'line one\n  line two' AS NOTE"
    const change = buildChange(base, bodyOf(task(" " + body)))
    expect(parseObjectFile(change.newContent)!.body).toBe(body)
  })
})
