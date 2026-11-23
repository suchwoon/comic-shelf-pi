import { errorResponse, json } from "@/lib/server/http";
import { quizIdentity, quizPayload } from "@/lib/server/quiz-access";

export const runtime = "nodejs";

export async function POST(request: Request) {
  try {
    const { grant } = await quizPayload(request);
    return json({ user: quizIdentity(grant).user });
  } catch (error) { return errorResponse(error); }
}
