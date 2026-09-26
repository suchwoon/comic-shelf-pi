import { authenticated, login, logoutCookie, passwordRequired } from "@/lib/server/auth";
import { errorResponse, json, readJson } from "@/lib/server/http";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  try { return json({ authenticated: authenticated(request), passwordRequired: passwordRequired() }); }
  catch (error) { return errorResponse(error); }
}

export async function POST(request: Request) {
  try {
    const { password } = await readJson(request);
    const cookie = login(request, password);
    const response = json({ authenticated: true, passwordRequired: passwordRequired() });
    if (cookie) response.headers.set("Set-Cookie", cookie);
    return response;
  } catch (error) { return errorResponse(error); }
}

export async function DELETE(request: Request) {
  try {
    const response = json({ authenticated: false, passwordRequired: passwordRequired() });
    response.headers.set("Set-Cookie", logoutCookie(request));
    return response;
  } catch (error) { return errorResponse(error); }
}
