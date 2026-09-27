import { requireAdmin } from "@/lib/server/auth";
import { serveFile } from "@/lib/server/files";
import { errorResponse } from "@/lib/server/http";
import { bookFile, getBook } from "@/lib/server/storage";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(request: Request, context: { params: Promise<{ id: string }> }) {
  try {
    const user = requireAdmin(request);
    const book = getBook((await context.params).id, user.id);
    return await serveFile(request, bookFile(book.id), "application/pdf", book.originalName);
  } catch (error) { return errorResponse(error); }
}

export const HEAD = GET;
