import { describe, expect, it, vi } from "vitest"
import { installationProblems, tokenPermissions, validRepo } from "@/lib/server/github/client"

// client.ts reads settings through the database client; these tests only use its
// pure rules. (vi.mock is hoisted above the import.)
vi.mock("@/lib/server/db", () => ({ sql: vi.fn() }))
vi.mock("@/lib/sar-sdk", () => ({ getSecret: vi.fn(), SecretType: { GENERIC_STRING: "GENERIC_STRING" } }))

const REPO = "sfc-gh-jleong/ade-demo-retail"
const AS_REGISTERED = { contents: "write", pull_requests: "write", statuses: "write", actions: "read", metadata: "read" }

describe("GitHub App permissions", () => {
  it("accepts the App as the setup steps register it", () => {
    expect(installationProblems({ permissions: AS_REGISTERED, repository_selection: "selected" }, REPO)).toEqual([])
  })

  it("flags permissions that would let the App change workflows, settings, environments or secrets", () => {
    const problems = installationProblems({ permissions: { ...AS_REGISTERED, workflows: "write", administration: "read" }, repository_selection: "selected" }, REPO)
    expect(problems).toEqual(["remove the Workflows, Administration permissions"])
  })

  it("flags missing permissions, an all-repositories install and a suspended installation", () => {
    const problems = installationProblems({ permissions: { contents: "read", metadata: "read" }, repository_selection: "all", suspended_at: "2026-11-12T00:00:00Z" }, REPO)
    expect(problems).toEqual([
      "the installation is suspended",
      "grant Contents (write), Pull requests (write), Commit statuses (write)",
      `install it on ${REPO} only (it is installed on all repositories)`,
    ])
  })

  it("does not require Actions read (it only links deploy runs)", () => {
    const { actions: _actions, ...withoutActions } = AS_REGISTERED
    expect(installationProblems({ permissions: withoutActions, repository_selection: "selected" }, REPO)).toEqual([])
  })

  it("asks tokens for what ADE uses only, capped at what the installation has", () => {
    expect(tokenPermissions({ ...AS_REGISTERED, workflows: "write", administration: "write", issues: "write" })).toEqual(AS_REGISTERED)
    expect(tokenPermissions({ contents: "read", metadata: "read", secrets: "write" })).toEqual({ contents: "read", metadata: "read" })
    expect(tokenPermissions({ contents: "admin" })).toEqual({ contents: "write" })
  })

  it("accepts owner/name repository names only", () => {
    expect(validRepo(REPO)).toBe(true)
    for (const bad of ["ade-demo-retail", "a/b/c", "../x/y", "owner/name?x=1", "", null]) expect(validRepo(bad)).toBe(false)
  })
})
