import { requireAuth } from "@/lib/server/auth";
import { createChatMessage, getChatReadState, listChatMessages } from "@/lib/server/chat";
import { errorResponse, json, readJson } from "@/lib/server/http";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  try {
    const user = requireAuth(request);
    const readState = getChatReadState(user);
    if (new URL(request.url).searchParams.get("status") === "1") return json({ readState });
    return json({ messages: listChatMessages(), readState });
  } catch (error) { return errorResponse(error); }
}

export async function POST(request: Request) {
  try {
    requireAuth(request);
    const data = await readJson(request);
    // Recheck after reading the request in case its session was revoked meanwhile.
    const user = requireAuth(request);
    return json({ message: createChatMessage(user, data) }, 201);
  } catch (error) { return errorResponse(error); }
}
