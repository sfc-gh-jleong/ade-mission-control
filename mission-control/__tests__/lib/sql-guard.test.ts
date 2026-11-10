import { describe, expect, it } from "vitest"
import { bindDatabase, canonicalFix, classify, createdObjects, screenRollback, screenStatements, writeTarget } from "@/lib/server/agents/sql-guard"

const ok = (s: string) => screenStatements([s])
const errorsOf = (s: string) => ok(s).errors.join(" | ")

describe("sql-guard: allowed statements", () => {
  it.each([
    "ALTER TASK {{DB}}.ORCHESTRATION.CLEAN_ORDERS SUSPEND",
    "ALTER TASK {{DB}}.ORCHESTRATION.CLEAN_ORDERS MODIFY AS MERGE INTO {{DB}}.STAGING.ORDERS_CLEAN t USING (SELECT o.SALES_CHANNEL FROM {{DB}}.RAW.ORDERS o) s ON t.ORDER_ID = s.ORDER_ID WHEN MATCHED THEN UPDATE SET t.CHANNEL = s.SALES_CHANNEL",
    "CREATE TABLE IF NOT EXISTS {{DB}}.MART.DAILY_REVENUE (ORDER_DATE DATE NOT NULL, CHANNEL VARCHAR(20))",
    "CREATE OR REPLACE VIEW {{DB}}.MART.V_REVENUE AS SELECT * FROM {{DB}}.MART.DAILY_REVENUE",
    "CREATE OR REPLACE DYNAMIC TABLE {{DB}}.MART.CUSTOMER_LTV TARGET_LAG = '1 day' WAREHOUSE = COMPUTE_WH AS SELECT c.SALES_REGION FROM {{DB}}.RAW.CUSTOMERS c",
    "ALTER TABLE {{DB}}.RAW.ORDERS ADD COLUMN NOTE VARCHAR",
    "UPDATE {{DB}}.RAW.ORDERS SET AMOUNT = NULL WHERE AMOUNT = 'N/A'",
    "DELETE FROM {{DB}}.RAW.ORDERS WHERE ORDER_ID IN (SELECT ORDER_ID FROM {{DB}}.RAW.ORDERS QUALIFY ROW_NUMBER() OVER (PARTITION BY ORDER_ID ORDER BY _LOADED_AT DESC) > 1)",
  ])("accepts %s", (s) => {
    expect(ok(s).errors).toEqual([])
  })

  it("classifies statement kinds", () => {
    expect(classify("alter task {{DB}}.A.B resume")).toBe("ALTER_TASK")
    expect(classify("CREATE OR REPLACE DYNAMIC TABLE {{DB}}.A.B AS SELECT 1")).toBe("CREATE_DYNAMIC_TABLE")
    expect(classify("MERGE INTO {{DB}}.A.B t USING x ON 1=1 WHEN MATCHED THEN DELETE")).toBe("MERGE")
  })

  it("finds the write target", () => {
    expect(writeTarget("ALTER TASK {{DB}}.ORCHESTRATION.CLEAN_ORDERS SUSPEND")).toBe("{{DB}}.ORCHESTRATION.CLEAN_ORDERS")
    expect(writeTarget("CREATE TABLE IF NOT EXISTS {{DB}}.MART.T (X INT)")).toBe("{{DB}}.MART.T")
    expect(writeTarget("UPDATE OPS.INCIDENTS SET X = 1 WHERE Y IN (SELECT 1 FROM {{DB}}.A.B)")).toBe("OPS.INCIDENTS")
  })
})

describe("sql-guard: rejected statements", () => {
  it.each([
    ["DROP TABLE {{DB}}.RAW.ORDERS", /not allowed/i],
    ["TRUNCATE TABLE {{DB}}.RAW.ORDERS", /TRUNCATE/],
    ["GRANT SELECT ON TABLE {{DB}}.RAW.ORDERS TO ROLE PUBLIC", /Privilege|not allowed/],
    ["CALL {{DB}}.UTIL.DO_SOMETHING()", /CALL|not allowed/],
    ["EXECUTE TASK {{DB}}.ORCHESTRATION.LOAD_ORDERS", /EXECUTE/],
    ["CREATE OR REPLACE TABLE {{DB}}.MART.DAILY_REVENUE (X INT)", /destroy the table's data/],
    ["INSERT OVERWRITE INTO {{DB}}.MART.DAILY_REVENUE SELECT 1", /OVERWRITE/],
    ["ALTER TABLE {{DB}}.RAW.ORDERS DROP COLUMN CHANNEL", /Dropping columns/],
    ["ALTER TABLE {{DB}}.RAW.ORDERS SWAP WITH {{DB}}.RAW.ORDERS_OLD", /SWAP/],
    ["UPDATE {{DB}}.RAW.ORDERS SET AMOUNT = NULL", /WHERE clause/],
    ["DELETE FROM {{DB}}.RAW.ORDERS", /WHERE clause/],
    ["ALTER TASK ADE_DEMO_RETAIL.ORCHESTRATION.CLEAN_ORDERS SUSPEND", /Use \{\{DB\}\}/],
    ["ALTER TASK {{DB}}.ORCHESTRATION.T MODIFY AS INSERT INTO OTHER_DB.S.T SELECT 1", /OTHER_DB/],
    ["UPDATE ADE_DB.OPS.SETTINGS SET SETTING_VALUE = 1 WHERE 1=1", /ADE's own databases|Use \{\{DB\}\}/],
    ["UPDATE OPS.INCIDENTS SET STATUS = 'RESOLVED' WHERE INCIDENT_ID IN (SELECT 1 FROM {{DB}}.RAW.ORDERS)", /fully qualified/],
    ["ALTER TASK {{DB}}.A.B SUSPEND;", /trailing semicolon/],
    ["ALTER TASK {{DB}}.A.B SUSPEND; DROP TABLE {{DB}}.A.C", /Multiple statements|not allowed/],
    ["ALTER TASK {{DB}}.A.B SUSPEND -- tidy up", /Comments/],
    ["ALTER SESSION SET QUERY_TAG = 'x'", /Session|not allowed/],
    ["USE ROLE ACCOUNTADMIN", /not allowed|Session/],
    ["ALTER TASK {{DB}}.A.B SET EXECUTE AS USER JLEONG", /identity/],
    ["SELECT SYSTEM$CANCEL_ALL_QUERIES(1)", /not allowed|System/],
    ["COPY INTO {{DB}}.RAW.ORDERS FROM @{{DB}}.RAW.STAGE", /not allowed|File/],
  ])("rejects %s", (s, pattern) => {
    const result = ok(s)
    expect(result.ok).toBe(false)
    expect(errorsOf(s)).toMatch(pattern)
  })

  it("ignores database-looking text inside string literals", () => {
    const s = "UPDATE {{DB}}.RAW.ORDERS SET CHANNEL = 'OTHER_DB.S.T' WHERE CHANNEL IS NULL"
    expect(ok(s).errors).toEqual([])
  })

  it("rejects too many statements", () => {
    const many = Array.from({ length: 30 }, () => "ALTER TASK {{DB}}.A.B RESUME")
    expect(screenStatements(many).errors[0]).toMatch(/At most 25/)
  })
})

describe("sql-guard: rollback", () => {
  const forward = ["CREATE TABLE IF NOT EXISTS {{DB}}.MART.DAILY_REVENUE (ORDER_DATE DATE NOT NULL)"]
  it("allows dropping an object the fix creates", () => {
    expect(screenRollback(["DROP TABLE IF EXISTS {{DB}}.MART.DAILY_REVENUE"], forward).errors).toEqual([])
  })
  it("refuses to drop anything else", () => {
    const r = screenRollback(["DROP TABLE {{DB}}.RAW.ORDERS"], forward)
    expect(r.ok).toBe(false)
    expect(r.errors[0]).toMatch(/only drop objects that the fix creates/)
  })
  it("still screens other rollback statements and keeps positions", () => {
    const r = screenRollback(["DROP TABLE {{DB}}.MART.DAILY_REVENUE", "TRUNCATE TABLE {{DB}}.RAW.ORDERS"], forward)
    expect(r.errors.join(" ")).toMatch(/statement 2: .*TRUNCATE/)
  })
  it("finds created objects", () => {
    expect([...createdObjects(forward)]).toEqual(["{{DB}}.MART.DAILY_REVENUE"])
  })
})

describe("sql-guard: binding", () => {
  it("binds the database placeholder", () => {
    expect(bindDatabase("ALTER TASK {{DB}}.A.B RESUME", "ade_sbx_1001_1")).toBe("ALTER TASK ADE_SBX_1001_1.A.B RESUME")
  })
  it("refuses unsafe database names", () => {
    expect(() => bindDatabase("x {{DB}}", 'X"; DROP')).toThrow(/unsafe/)
    expect(() => bindDatabase("x {{DB}}", "A.B")).toThrow(/unsafe/)
  })
  it("canonical form ignores surrounding whitespace only", () => {
    expect(canonicalFix([" a "], ["b"])).toBe(canonicalFix(["a"], [" b"]))
    expect(canonicalFix(["a"], ["b"])).not.toBe(canonicalFix(["a "], ["c"]))
  })
})
