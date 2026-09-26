import { requireAdmin } from "@/lib/server/auth";
import { setUserDisabled } from "@/lib/server/accounts";
import { ApiError, errorResponse, json, readJson } from "@/lib/server/http";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function PATCH(request: Request, context: { params: Promise<{ id: string }> }) {
  try {
    requireAdmin(request);
    const data = await readJson(request);
    if (Object.keys(data).some(key => key !== "disabled")) throw new ApiError(400, "The account change is invalid.");
    return json({ user: setUserDisabled((await context.params).id, data.disabled) });
  } catch (error) { return errorResponse(error); }
}
