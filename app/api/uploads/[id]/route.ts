import { requireAdmin } from "@/lib/server/auth";
import { appendUpload, cancelUpload } from "@/lib/server/chunk-upload";
import { errorResponse, json } from "@/lib/server/http";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
type Context = { params: Promise<{ id: string }> };

export async function PATCH(request: Request, context: Context) {
  try {
    requireAdmin(request);
    return json(await appendUpload((await context.params).id, request));
  } catch (error) { return errorResponse(error); }
}

export async function DELETE(request: Request, context: Context) {
  try {
    requireAdmin(request);
    await cancelUpload((await context.params).id);
    return new Response(null, { status: 204, headers: { "Cache-Control": "no-store" } });
  } catch (error) { return errorResponse(error); }
}
