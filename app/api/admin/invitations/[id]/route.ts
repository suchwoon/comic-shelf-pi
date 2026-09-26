import { requireAdmin } from "@/lib/server/auth";
import { revokeInvitation } from "@/lib/server/accounts";
import { errorResponse } from "@/lib/server/http";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function DELETE(request: Request, context: { params: Promise<{ id: string }> }) {
  try {
    requireAdmin(request);
    revokeInvitation((await context.params).id);
    return new Response(null, { status: 204, headers: { "Cache-Control": "no-store" } });
  } catch (error) { return errorResponse(error); }
}
