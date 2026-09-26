import { requireAdmin } from "@/lib/server/auth";
import { createInvitation, listInvitations } from "@/lib/server/accounts";
import { ApiError, errorResponse, json, readJson } from "@/lib/server/http";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  try { requireAdmin(request); return json({ invitations: listInvitations() }); }
  catch (error) { return errorResponse(error); }
}

export async function POST(request: Request) {
  try {
    requireAdmin(request);
    const data = await readJson(request);
    if (Object.keys(data).some(key => key !== "userId")) throw new ApiError(400, "The invitation details are invalid.");
    return json(createInvitation(data.userId), 201);
  } catch (error) { return errorResponse(error); }
}
