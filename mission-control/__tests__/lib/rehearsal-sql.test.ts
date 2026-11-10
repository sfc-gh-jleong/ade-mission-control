import { describe, expect, it } from "vitest"
import { parseAwaitFailure, qualifiedRefs, rewriteDatabase, sandboxDatabaseName } from "@/lib/server/rehearsal/sql-text"
import { capConfidence, stageIndexForStatus } from "@/lib/domain"

describe("rehearsal sql-text", () => {
  const body = `MERGE INTO ADE_DEMO_RETAIL.STAGING.ORDERS_CLEAN t
    USING (SELECT o.ORDER_ID, o.CHANNEL FROM ADE_DEMO_RETAIL.RAW.ORDERS o
           JOIN ade_demo_retail.REF.FX_RATES fx ON fx.CURRENCY = o.CURRENCY
           WHERE o.NOTE <> 'ADE_DEMO_RETAIL.RAW.ORDERS') s
    ON t.ORDER_ID = s.ORDER_ID`

  it("finds database-qualified references, case-insensitively", () => {
    const refs = qualifiedRefs(body).map((r) => `${r.database}.${r.schema}.${r.name}`)
    expect(refs).toEqual(["ADE_DEMO_RETAIL.STAGING.ORDERS_CLEAN", "ADE_DEMO_RETAIL.RAW.ORDERS", "ADE_DEMO_RETAIL.REF.FX_RATES"])
  })

  it("rewrites the database outside string literals only", () => {
    const out = rewriteDatabase(body, "ADE_DEMO_RETAIL", "ADE_SBX_1001_1")
    expect(out).toContain("ADE_SBX_1001_1.STAGING.ORDERS_CLEAN")
    expect(out).toContain("ADE_SBX_1001_1.REF.FX_RATES")
    expect(out).toContain("'ADE_DEMO_RETAIL.RAW.ORDERS'")
    expect(out).not.toMatch(/\bADE_DEMO_RETAIL\.STAGING/)
  })

  it("leaves other databases alone", () => {
    expect(rewriteDatabase("SELECT * FROM OTHER.S.T", "ADE_DEMO_RETAIL", "SBX")).toBe("SELECT * FROM OTHER.S.T")
  })

  it("builds sandbox database names", () => {
    expect(sandboxDatabaseName(1010, 2)).toBe("ADE_SBX_1010_2")
  })

  it("parses EXECUTE TASK ... AWAIT failures", () => {
    const msg = `091770 (22000): Task graph 'ADE_SBX_S4_TEST.ORCHESTRATION.BUILD_DAILY_REVENUE' with
      graph_run_group_id='1c771d81-8758-4c7f-9e82-3f63c47ca238' failed. The first
      error task, named 'BUILD_DAILY_REVENUE' failed with error='002003: SQL compilation error:
      Table 'ADE_SBX_S4_TEST.MART.DAILY_REVENUE' does not exist or not authorized.'.`
    const p = parseAwaitFailure(msg)
    expect(p.graphRunGroupId).toBe("1c771d81-8758-4c7f-9e82-3f63c47ca238")
    expect(p.task).toBe("BUILD_DAILY_REVENUE")
    expect(p.code).toBe("002003")
    expect(p.error).toMatch(/SQL compilation error/)
  })
})

describe("domain", () => {
  it("caps confidence by rehearsal outcome", () => {
    expect(capConfidence(95, "PASSED")).toEqual({ confidence: 95, capReason: null })
    expect(capConfidence(95, "FAILED").confidence).toBe(40)
    expect(capConfidence(95, "INCONCLUSIVE").confidence).toBe(70)
    expect(capConfidence(95, "UNSUPPORTED").confidence).toBe(70)
    expect(capConfidence(30, "FAILED")).toEqual({ confidence: 30, capReason: null })
    expect(capConfidence(150, "PASSED").confidence).toBe(100)
    expect(capConfidence(Number.NaN, "PASSED").confidence).toBe(0)
  })

  it("maps statuses to pipeline stages", () => {
    expect(stageIndexForStatus("DETECTED")).toBe(0)
    expect(stageIndexForStatus("REVIEWING")).toBe(4)
    expect(stageIndexForStatus("RESOLVED")).toBe(7)
    expect(stageIndexForStatus("NEEDS_HUMAN")).toBe(-1)
  })
})
