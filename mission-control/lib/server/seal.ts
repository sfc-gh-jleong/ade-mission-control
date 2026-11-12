/**
 * Integrity seals for agent-produced records.
 *
 * Agents run as the same role as the app, so a prompt-injected agent could
 * UPDATE a review ("APPROVE, 99") or a fix's statements with its SQL tool. The
 * app seals each fix and review with an HMAC whose key is a Snowflake SECRET
 * mounted only into this container (the agents' sandbox cannot read it). The
 * UI shows an unverifiable record as tampered, and the GUARD procedures
 * independently pin the exact statements by recomputing FIX_HASH.
 */
import { createHmac, timingSafeEqual } from "node:crypto"
import { getSecret, SecretType } from "@/lib/sar-sdk"

let cachedKey: string | null | undefined

function key(): string | null {
  if (cachedKey !== undefined) return cachedKey
  try {
    cachedKey = getSecret("SEAL_KEY", SecretType.GENERIC_STRING) || null
  } catch {
    // Local dev without the secret: records are left unsealed (shown as such).
    cachedKey = process.env.ADE_SEAL_KEY ?? null
  }
  return cachedKey
}

export function sealingAvailable(): boolean {
  return key() !== null
}

function canonical(parts: (string | number | null | undefined)[]): string {
  return parts.map((p) => (p === null || p === undefined ? "" : String(p))).join("\u001f")
}

export function seal(parts: (string | number | null | undefined)[]): string | null {
  const k = key()
  if (!k) return null
  return createHmac("sha256", k).update(canonical(parts)).digest("hex").slice(0, 64)
}

export type SealState = "VALID" | "INVALID" | "UNSEALED"

export function verify(parts: (string | number | null | undefined)[], stored: string | null | undefined): SealState {
  if (!stored) return "UNSEALED"
  const expected = seal(parts)
  if (!expected) return "UNSEALED"
  const a = Buffer.from(expected)
  const b = Buffer.from(String(stored))
  return a.length === b.length && timingSafeEqual(a, b) ? "VALID" : "INVALID"
}

/** Fields covered by each seal. Keep in sync with the writers in orchestrator.ts. */
export const fixSealParts = (f: { fixId: string; incidentId: string; version: number; fixHash: string }) => ["FIX", f.fixId, f.incidentId, f.version, f.fixHash]

export const reviewSealParts = (r: {
  reviewId: string
  fixId: string
  verdict: string
  rawConfidence: number
  confidence: number
  rehearsalOutcome: string | null
  fixHash: string
}) => ["REVIEW", r.reviewId, r.fixId, r.verdict, r.rawConfidence.toFixed(2), r.confidence.toFixed(2), r.rehearsalOutcome, r.fixHash]

/** The repo file change for a fix (OPS.SOURCE_CHANGES): what a pull request may push. */
export const sourceSealParts = (s: { fixId: string; path: string; baseCommitSha: string; baseBlobSha: string; newBlobSha: string; patchHash: string }) => [
  "SOURCE",
  s.fixId,
  s.path,
  s.baseCommitSha,
  s.baseBlobSha,
  s.newBlobSha,
  s.patchHash,
]
