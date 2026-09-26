import { requireAuth } from "@/lib/server/auth";
import { completeUpload } from "@/lib/server/chunk-upload";
import { errorResponse, json } from "@/lib/server/http";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(request: Request, context: { params: Promise<{ id: string }> }) {
  try {
    requireAuth(request);
    return json({ book: await completeUpload((await context.params).id) }, 201);
  } catch (error) { return errorResponse(error); }
}
