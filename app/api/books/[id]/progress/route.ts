import { requireAuth } from "@/lib/server/auth";
import { errorResponse, json, readJson } from "@/lib/server/http";
import { updateProgress } from "@/lib/server/storage";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function PATCH(request: Request, context: { params: Promise<{ id: string }> }) {
  try {
    requireAuth(request);
    return json({ book: updateProgress((await context.params).id, await readJson(request)) });
  } catch (error) { return errorResponse(error); }
}
