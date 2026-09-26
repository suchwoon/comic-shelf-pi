import { register } from "@/lib/server/auth";
import { ApiError, errorResponse, json, readJson } from "@/lib/server/http";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(request: Request) {
  try {
    const data = await readJson(request);
    if (Object.keys(data).some(key => !["token", "username", "password"].includes(key))) throw new ApiError(400, "The account details are invalid.");
    const { user, cookie } = await register(request, data.token, data.username, data.password);
    const response = json({ authenticated: true, passwordRequired: true, user }, 201);
    response.headers.set("Set-Cookie", cookie);
    return response;
  } catch (error) { return errorResponse(error); }
}
