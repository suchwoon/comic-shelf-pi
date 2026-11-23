import { quizConnectParams } from "@/lib/quiz-connect";
import { ApiError, errorResponse } from "@/lib/server/http";
import { issueQuizCode, quizOrigin } from "@/lib/server/quiz-access";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export function GET(request: Request) {
  try {
    const origin = quizOrigin();
    const params = quizConnectParams(new URL(request.url).searchParams);
    if (!params) throw new ApiError(400, "Start sign-in from Quiz Room.");
    const code = issueQuizCode(request, params.get("challenge")!);
    let location: string;
    if (code) {
      const callback = new URL("/api/auth/callback", origin);
      callback.search = new URLSearchParams({ code, state: params.get("state")! }).toString();
      location = callback.href;
    } else {
      params.set("quiz", "1");
      location = "/?" + params.toString();
    }
    return new Response(null, { status: 303, headers: { Location: location, "Cache-Control": "no-store", "Referrer-Policy": "no-referrer" } });
  } catch (error) { return errorResponse(error); }
}
