import { requireAuth } from "@/lib/server/auth";
import { errorResponse, json } from "@/lib/server/http";
import { listBooks, maxUploadBytes } from "@/lib/server/storage";
import { saveUpload } from "@/lib/server/upload";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  try {
    requireAuth(request);
    const books = listBooks();
    return json({ books, totalBytes: books.reduce((sum, book) => sum + book.size, 0), maxUploadBytes: maxUploadBytes() });
  } catch (error) { return errorResponse(error); }
}

export async function POST(request: Request) {
  try { requireAuth(request); return json({ book: await saveUpload(request) }, 201); }
  catch (error) { return errorResponse(error); }
}
