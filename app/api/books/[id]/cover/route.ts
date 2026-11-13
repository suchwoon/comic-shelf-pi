import { requireAuth } from "@/lib/server/auth";
import { serveCover } from "@/lib/server/cover-images";
import { errorResponse } from "@/lib/server/http";
import { getBook } from "@/lib/server/storage";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(request: Request, context: { params: Promise<{ id: string }> }) {
  try {
    const user = requireAuth(request);
    const book = getBook((await context.params).id, user.id);
    return await serveCover(request, book.id);
  } catch (error) { return errorResponse(error); }
}

export const HEAD = GET;
