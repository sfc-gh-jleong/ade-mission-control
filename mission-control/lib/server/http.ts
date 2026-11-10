/** Shared helpers for API route handlers. */
export function errorResponse(where: string, e: unknown, status = 500): Response {
  const message = e instanceof Error ? e.message : String(e)
  console.error(new Date().toISOString(), `[api/${where}]`, message)
  // Snowflake access errors read as "does not exist or not authorized": surface them plainly.
  const code = /not an ADE approver|not authorized|insufficient privileges/i.test(message) ? 403 : status
  return Response.json({ error: cleanSnowflakeError(message) }, { status: code })
}

/** Strip query ids and SQLSTATE noise from Snowflake errors for display. */
export function cleanSnowflakeError(message: string): string {
  return message
    .replace(/^\d{6} \(\w+\): [0-9a-f-]{36}: /, "")
    .replace(/Uncaught exception of type 'STATEMENT_ERROR' on line \d+ at position \d+ : /, "")
    .replace(/^User-defined exception: /, "")
    .trim()
}

export async function readJson<T>(req: Request): Promise<T> {
  try {
    return (await req.json()) as T
  } catch {
    return {} as T
  }
}
