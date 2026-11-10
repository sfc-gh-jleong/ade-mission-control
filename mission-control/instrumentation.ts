/**
 * Next.js server-start hook. Starts ADE's background work (self-tests, agent
 * registry sync, orchestrator) once per server process. Never runs during
 * `next build`.
 */
export async function register() {
  if (process.env.NEXT_RUNTIME !== "nodejs") return
  if (process.env.NEXT_PHASE === "phase-production-build") return
  const { startBackground } = await import("@/lib/server/boot")
  startBackground()
}
