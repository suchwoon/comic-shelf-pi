export class ApiError extends Error {
  constructor(public status: number, message: string) {
    super(message);
  }
}

export function json(data: unknown, status = 200) {
  return Response.json(data, { status, headers: { "Cache-Control": "no-store" } });
}

export function errorResponse(error: unknown) {
  if (error instanceof ApiError) return json({ error: error.message }, error.status);
  const code = (error as NodeJS.ErrnoException)?.code;
  if (code === "ENOSPC") return json({ error: "There is not enough storage. Free up space and try again." }, 507);
  console.error("Comic Shelf request failed:", error instanceof Error ? error.name : "UnknownError");
  return json({ error: "Something went wrong. Please try again shortly." }, 500);
}

export async function readJson(request: Request): Promise<Record<string, unknown>> {
  if (!request.headers.get("content-type")?.includes("application/json")) {
    throw new ApiError(415, "The request must use JSON.");
  }
  if (!request.body) throw new ApiError(400, "The request is empty.");
  const reader = request.body.getReader();
  const parts: Uint8Array[] = [];
  let size = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > 16_384) {
        await reader.cancel();
        throw new ApiError(413, "The request is too large.");
      }
      parts.push(value);
    }
    const data: unknown = JSON.parse(Buffer.concat(parts).toString("utf8"));
    if (!data || typeof data !== "object" || Array.isArray(data)) throw new Error("object required");
    return data as Record<string, unknown>;
  } catch (error) {
    if (error instanceof ApiError) throw error;
    throw new ApiError(400, "The request format is invalid.");
  } finally {
    reader.releaseLock();
  }
}
