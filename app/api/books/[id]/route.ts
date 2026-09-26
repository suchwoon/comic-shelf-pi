import { requireAdmin, requireAuth } from "@/lib/server/auth";
import { ApiError, errorResponse, json, readJson } from "@/lib/server/http";
import { getBook, store, validateTitle } from "@/lib/server/storage";
import { deleteBook } from "@/lib/server/upload";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
type Context = { params: Promise<{ id: string }> };

export async function GET(request: Request, context: Context) {
  try {
    const user = requireAuth(request);
    return json({ book: getBook((await context.params).id, user.id) });
  }
  catch (error) { return errorResponse(error); }
}

export async function PATCH(request: Request, context: Context) {
  try {
    const user = requireAdmin(request);
    const id = (await context.params).id;
    getBook(id, user.id);
    const input = await readJson(request);
    if (Object.keys(input).some(key => key !== "title")) throw new ApiError(400, "The title update is invalid.");
    store().db.prepare("UPDATE books SET title = ? WHERE id = ?").run(validateTitle(input.title), id);
    return json({ book: getBook(id, user.id) });
  } catch (error) { return errorResponse(error); }
}

export async function DELETE(request: Request, context: Context) {
  try {
    requireAdmin(request);
    await deleteBook((await context.params).id);
    return new Response(null, { status: 204, headers: { "Cache-Control": "no-store" } });
  } catch (error) { return errorResponse(error); }
}
