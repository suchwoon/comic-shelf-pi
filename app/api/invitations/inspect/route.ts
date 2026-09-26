import { checkOrigin } from "@/lib/server/auth";
import { inspectInvitation } from "@/lib/server/accounts";
import { ApiError, errorResponse, json, readJson } from "@/lib/server/http";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(request: Request) {
  try {
    checkOrigin(request);
    const data = await readJson(request);
    if (Object.keys(data).some(key => key !== "token")) throw new ApiError(400, "The invitation is invalid.");
    return json(inspectInvitation(data.token));
  } catch (error) { return errorResponse(error); }
}
