import { requireAdmin } from "@/lib/server/auth";
import { createUpload } from "@/lib/server/chunk-upload";
import { errorResponse, json, readJson } from "@/lib/server/http";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(request: Request) {
  try {
    requireAdmin(request);
    return json(await createUpload(await readJson(request)), 201);
  } catch (error) { return errorResponse(error); }
}
