import { requireAuth } from "@/lib/server/auth";
import { errorResponse } from "@/lib/server/http";
import { pageImage, parsePageNumber } from "@/lib/server/page-images";
import { getBook } from "@/lib/server/storage";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(request: Request, context: { params: Promise<{ id: string; page: string }> }) {
  try {
    // Authenticate every request, including HEAD and cached pages.
    const user = requireAuth(request);
    const { id, page } = await context.params;
    const book = getBook(id, user.id);
    const bytes = await pageImage(book, parsePageNumber(page, book.pageCount));
    // Recheck sessions after a potentially slow render so a revoked account
    // cannot receive an image from an in-flight request.
    requireAuth(request);
    return new Response(request.method === "HEAD" ? null : new Uint8Array(bytes), {
      headers: {
        "Content-Type": "image/jpeg",
        "Content-Length": String(bytes.byteLength),
        "Cache-Control": "private, no-store",
        "X-Content-Type-Options": "nosniff",
      },
    });
  } catch (error) { return errorResponse(error); }
}

export const HEAD = GET;
