import { errorResponse, json } from "@/lib/server/http";
import { quizPayload, revokeQuizGrant } from "@/lib/server/quiz-access";

export const runtime = "nodejs";

export async function POST(request: Request) {
  try {
    const { grant } = await quizPayload(request);
    revokeQuizGrant(grant);
    return json({ ok: true });
  } catch (error) { return errorResponse(error); }
}
