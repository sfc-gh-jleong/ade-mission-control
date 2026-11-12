import { describe, expect, it } from "vitest"
import { branchName, commitMessage, prBody, prTitle, publicLine, publicText, type PrContent } from "@/lib/server/github/text"
import { decide, summarizeReviews, type ObservedPr, type TrackedPr } from "@/lib/server/github/tracking"

const content: PrContent = {
  incidentNumber: 1004,
  jobType: "TASK",
  objectName: "ORCHESTRATION.CLEAN_ORDERS",
  path: "objects/orchestration/clean_orders.sql",
  version: 1,
  fix: {
    title: "Parse amounts with TRY_TO_NUMBER <script>alert(1)</script>",
    summary: "Skips 'N/A' amounts. See https://evil.example/x and ping @octocat about #12. Query 01c85ae1-0a1a-b2ab-000d-c56b21bcb87e.",
    assumptions: ["Rows with unparseable amounts can wait for the source team", "[click](https://evil.example)"],
    verificationPlan: "CLEAN_ORDERS succeeds on the next run at abc-xy123.snowflakecomputing.com",
    riskLevel: "LOW",
  },
  rootCause: "RAW.ORDERS.AMOUNT holds 'N/A' for MYACCT_AWS1 orders.",
  rehearsal: { outcome: "PASSED", reason: "The failure reproduced and the job succeeded after the fix." },
  review: { verdict: "APPROVE", confidence: 91.6, summary: "Minimal and safe.", concerns: [] },
  fixHash: "f".repeat(64),
  patchHash: "e".repeat(64),
  productionDiffered: false,
}

describe("public PR text", () => {
  const opts = { redact: ["MYACCT_AWS1"] }

  it("escapes HTML, mentions, references, links and URLs", () => {
    const s = publicText(content.fix.summary + " <b>x</b> [a](b) www.example.com", 2000)
    expect(s).not.toMatch(/<b>|https:\/\/|@octocat|#12|\]\(|www\.example/)
    expect(s).toContain("&lt;b&gt;")
    expect(s).toContain("[id]")
  })

  it("redacts Snowflake hosts and named strings, and caps length", () => {
    expect(publicText(content.fix.verificationPlan, 500)).toContain("[snowflake host]")
    expect(publicText(content.rootCause, 500, opts)).toContain("[redacted]")
    expect(publicText("x".repeat(50), 10)).toHaveLength(10)
    expect(publicLine("a\n\nb", 10)).toBe("a b")
  })

  it("renders a body with no links back, IDs or raw agent HTML", () => {
    const body = prBody(content, opts)
    expect(body).toContain("ADE-1004")
    expect(body).toContain("`objects/orchestration/clean_orders.sql`")
    expect(body).not.toMatch(/https?:\/\/|<script|MYACCT|01c85ae1|snowflakecomputing|@octocat/i)
    expect(body).toContain("confidence 92/100")
    expect(prTitle(content)).toMatch(/^ADE-1004: Parse amounts with TRY_TO_NUMBER &lt;script&gt;/)
    expect(commitMessage(content).split("\n")[0]).toBe(prTitle(content))
    expect(branchName(1004, 2)).toBe("ade/ADE-1004-v2")
  })

  it("notes production drift when there was any", () => {
    expect(prBody({ ...content, productionDiffered: true })).toContain("differed from `main`")
    expect(prBody(content)).not.toContain("differed from `main`")
  })
})

describe("tracking", () => {
  const now = Date.parse("2026-11-12T12:00:00Z")
  const open: TrackedPr = { state: "OPEN", headSha: "a".repeat(40), createdAt: "2026-11-12T11:00:00Z", mergedAt: null, timedOut: false }
  const pr = (o: Partial<ObservedPr> = {}): ObservedPr => ({
    state: "open", merged: false, mergedBy: null, mergedAt: null, mergeCommitSha: null, headSha: "a".repeat(40), approvals: [], changesRequested: false, ...o,
  })
  const deploy = { deployId: "d1", commitSha: "c".repeat(40), deployedAt: "2026-11-12T11:50:00Z", actor: "sfc-gh-jleong", runUrl: "https://github.com/x/y/actions/runs/1", pipelineStatus: "SUCCEEDED" }

  it("records review progress on an open PR", () => {
    expect(decide(open, { pr: pr({ approvals: ["sfc-gh-jleong"] }) }, now, 30)).toEqual({
      kind: "REVIEW_UPDATE", approvals: ["sfc-gh-jleong"], changesRequested: false, currentHead: "a".repeat(40), changedAfterPush: false,
    })
  })

  it("flags commits pushed after ADE's commit", () => {
    const r = decide(open, { pr: pr({ headSha: "b".repeat(40) }) }, now, 30)
    expect(r.kind === "REVIEW_UPDATE" && r.changedAfterPush).toBe(true)
  })

  it("moves open -> merged -> deployed", () => {
    const merged = decide(open, { pr: pr({ state: "closed", merged: true, mergedBy: "sfc-gh-jleong", mergedAt: "2026-11-12T11:40:00Z", mergeCommitSha: "c".repeat(40) }) }, now, 30)
    expect(merged).toMatchObject({ kind: "MERGED", mergedBy: "sfc-gh-jleong", mergeCommitSha: "c".repeat(40), changedAfterPush: false })
    const row: TrackedPr = { ...open, state: "MERGED", mergedAt: "2026-11-12T11:40:00Z" }
    expect(decide(row, { deploy }, now, 30)).toEqual({ kind: "DEPLOYED", deploy })
    expect(decide(row, {}, now, 30)).toEqual({ kind: "NONE" })
  })

  it("sends a closed PR to a person", () => {
    expect(decide(open, { pr: pr({ state: "closed" }) }, now, 30)).toEqual({ kind: "CLOSED" })
  })

  it("reports a missing deploy once after the timeout", () => {
    const row: TrackedPr = { ...open, state: "MERGED", mergedAt: "2026-11-12T11:00:00Z" }
    expect(decide(row, {}, now, 30)).toEqual({ kind: "DEPLOY_TIMEOUT" })
    expect(decide({ ...row, timedOut: true }, {}, now, 30)).toEqual({ kind: "NONE" })
    expect(decide(row, {}, now, 90)).toEqual({ kind: "NONE" })
    expect(decide({ ...row, timedOut: true }, { deploy }, now, 30)).toEqual({ kind: "DEPLOYED", deploy })
  })

  it("resolves a deploy-only fix with the first deploy after it was raised", () => {
    const row: TrackedPr = { state: "DEPLOY_NEEDED", headSha: null, createdAt: "2026-11-12T11:45:00Z", mergedAt: null, timedOut: false }
    expect(decide(row, { deploy }, now, 30)).toEqual({ kind: "DEPLOYED", deploy })
    expect(decide(row, { deploy: { ...deploy, deployedAt: "2026-11-12T11:00:00Z" } }, now, 30)).toEqual({ kind: "NONE" })
  })

  it("counts each reviewer's latest review", () => {
    expect(
      summarizeReviews([
        { user: "a", state: "CHANGES_REQUESTED", submittedAt: "2026-11-12T10:00:00Z" },
        { user: "a", state: "APPROVED", submittedAt: "2026-11-12T11:00:00Z" },
        { user: "b", state: "APPROVED", submittedAt: "2026-11-12T10:00:00Z" },
        { user: "b", state: "DISMISSED", submittedAt: "2026-11-12T11:30:00Z" },
        { user: "c", state: "COMMENTED", submittedAt: "2026-11-12T11:31:00Z" },
      ]),
    ).toEqual({ approvals: ["a"], changesRequested: false })
  })
})
