import { changePassword, currentUser, login, logoutCookie } from "@/lib/server/auth";
import { ApiError, errorResponse, json, readJson } from "@/lib/server/http";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  try {
    const user = currentUser(request);
    return json({ authenticated: Boolean(user), passwordRequired: true, user });
  }
  catch (error) { return errorResponse(error); }
}

export async function POST(request: Request) {
  try {
    const data = await readJson(request);
    if (Object.keys(data).some(key => !["username", "password"].includes(key))) throw new ApiError(400, "The sign-in details are invalid.");
    const { user, cookie } = await login(request, data.username, data.password);
    const response = json({ authenticated: true, passwordRequired: true, user });
    response.headers.set("Set-Cookie", cookie);
    return response;
  } catch (error) { return errorResponse(error); }
}

export async function DELETE(request: Request) {
  try {
    const response = json({ authenticated: false, passwordRequired: true, user: null });
    response.headers.set("Set-Cookie", logoutCookie(request));
    return response;
  } catch (error) { return errorResponse(error); }
}

export async function PATCH(request: Request) {
  try {
    const data = await readJson(request);
    if (Object.keys(data).some(key => !["currentPassword", "newPassword"].includes(key))) throw new ApiError(400, "The password details are invalid.");
    const { user, cookie } = await changePassword(request, data.currentPassword, data.newPassword);
    const response = json({ authenticated: true, passwordRequired: true, user });
    response.headers.set("Set-Cookie", cookie);
    return response;
  } catch (error) { return errorResponse(error); }
}
