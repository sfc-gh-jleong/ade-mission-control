import { subscribe, nowIso, type LiveEvent } from "@/lib/server/events"

export const dynamic = "force-dynamic"
export const runtime = "nodejs"

const HEARTBEAT_MS = 15_000

/**
 * Server-Sent Events: live orchestrator and agent activity. The browser keeps
 * one EventSource open; state itself always comes from SQL, so a dropped
 * connection loses nothing.
 */
export async function GET(req: Request) {
  const encoder = new TextEncoder()
  let unsubscribe: (() => void) | null = null
  let heartbeat: ReturnType<typeof setInterval> | null = null

  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      const send = (event: LiveEvent | { type: "hello"; at: string }) => {
        try {
          controller.enqueue(encoder.encode(`event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`))
        } catch {
          // stream already closed
        }
      }
      // Ask proxies not to buffer, then greet.
      controller.enqueue(encoder.encode(`retry: 3000\n: ${" ".repeat(2048)}\n\n`))
      send({ type: "hello", at: nowIso() })
      unsubscribe = subscribe(send)
      heartbeat = setInterval(() => {
        try {
          controller.enqueue(encoder.encode(`: ping ${nowIso()}\n\n`))
        } catch {
          // closed
        }
      }, HEARTBEAT_MS)
      req.signal.addEventListener("abort", () => {
        unsubscribe?.()
        if (heartbeat) clearInterval(heartbeat)
        try {
          controller.close()
        } catch {
          // already closed
        }
      })
    },
    cancel() {
      unsubscribe?.()
      if (heartbeat) clearInterval(heartbeat)
    },
  })

  return new Response(stream, {
    headers: {
      "Content-Type": "text/event-stream; charset=utf-8",
      "Cache-Control": "no-cache, no-transform",
      Connection: "keep-alive",
      "X-Accel-Buffering": "no",
    },
  })
}
