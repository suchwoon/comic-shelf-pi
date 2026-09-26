import { requireAdmin } from "@/lib/server/auth";
import { completeUpload } from "@/lib/server/chunk-upload";
import { errorResponse, json } from "@/lib/server/http";
import { getBook } from "@/lib/server/storage";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(request: Request, context: { params: Promise<{ id: string }> }) {
  try {
    const user = requireAdmin(request);
    const book = await completeUpload((await context.params).id);
    return json({ book: getBook(book.id, user.id) }, 201);
  } catch (error) { return errorResponse(error); }
}
