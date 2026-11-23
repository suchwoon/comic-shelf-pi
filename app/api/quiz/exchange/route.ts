import { errorResponse, json } from "@/lib/server/http";
import { exchangeQuizCode, quizPayload } from "@/lib/server/quiz-access";

export const runtime = "nodejs";

export async function POST(request: Request) {
  try {
    const { code, verifier } = await quizPayload(request);
    return json(exchangeQuizCode(code, verifier));
  } catch (error) { return errorResponse(error); }
}
