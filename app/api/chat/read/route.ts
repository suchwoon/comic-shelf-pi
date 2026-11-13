import { requireAuth } from "@/lib/server/auth";
import { markChatRead } from "@/lib/server/chat";
import { errorResponse, json, readJson } from "@/lib/server/http";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(request: Request) {
  try {
    requireAuth(request);
    const data = await readJson(request);
    const user = requireAuth(request);
    return json({ readState: markChatRead(user, data) });
  } catch (error) { return errorResponse(error); }
}
