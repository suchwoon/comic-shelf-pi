export function quizConnectParams(query: Pick<URLSearchParams, "get">) {
  const state = query.get("state");
  const challenge = query.get("challenge");
  if (!state || !challenge || !/^[A-Za-z0-9_-]{43}$/.test(state) || !/^[A-Za-z0-9_-]{43}$/.test(challenge)) return null;
  return new URLSearchParams({ state, challenge });
}
