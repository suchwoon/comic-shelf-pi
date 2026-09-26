import { requireAdmin, requireAuth } from "@/lib/server/auth";
import { errorResponse, json } from "@/lib/server/http";
import { getBook, listBooks, maxUploadBytes } from "@/lib/server/storage";
import { saveUpload } from "@/lib/server/upload";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  try {
    const user = requireAuth(request);
    const books = listBooks(user.id);
    return json({ books, totalBytes: books.reduce((sum, book) => sum + book.size, 0), maxUploadBytes: maxUploadBytes() });
  } catch (error) { return errorResponse(error); }
}

export async function POST(request: Request) {
  try {
    const user = requireAdmin(request);
    const book = await saveUpload(request);
    return json({ book: getBook(book.id, user.id) }, 201);
  }
  catch (error) { return errorResponse(error); }
}
