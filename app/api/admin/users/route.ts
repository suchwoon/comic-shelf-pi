import { requireAdmin } from "@/lib/server/auth";
import { listUsers } from "@/lib/server/accounts";
import { errorResponse, json } from "@/lib/server/http";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  try { requireAdmin(request); return json({ users: listUsers() }); }
  catch (error) { return errorResponse(error); }
}
