import { whoAmI } from "@/lib/server/actions"
import { errorResponse } from "@/lib/server/http"
import { isDeployed } from "@/lib/server/db"

export const dynamic = "force-dynamic"

/** The signed-in user (caller's rights) and whether they may approve fixes. */
export async function GET() {
  try {
    return Response.json({ ...(await whoAmI()), deployed: isDeployed() })
  } catch (e) {
    return errorResponse("me", e)
  }
}
