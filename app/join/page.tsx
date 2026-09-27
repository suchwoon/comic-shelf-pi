"use client";

import Link from "next/link";
import { useEffect, useState, type FormEvent } from "react";
import { ArrowRight, CircleAlert, LoaderCircle, RotateCcw } from "lucide-react";
import ThemeSelector from "@/components/ThemeSelector";

type Invitation = { kind: "invite" | "reset"; username: string | null; expiresAt: string };

async function responseError(response: Response, fallback: string) {
  try {
    const data: { error?: string } = await response.json();
    if (typeof data.error === "string") return data.error;
  } catch { /* A proxy may return a non-JSON error. */ }
  return fallback;
}

export default function JoinPage() {
  const [token, setToken] = useState("");
  const [invitation, setInvitation] = useState<Invitation | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState("");
  const [attempt, setAttempt] = useState(0);
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [confirmation, setConfirmation] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    const controller = new AbortController();
    async function inspect() {
      const value = new URLSearchParams(window.location.hash.slice(1)).get("token") ?? "";
      setToken(value);
      setLoading(true);
      setLoadError("");
      setInvitation(null);
      if (!value) {
        setLoadError("Open the complete invitation link from your library administrator.");
        setLoading(false);
        return;
      }
      try {
        const response = await fetch("/api/invitations/inspect", {
          method: "POST", headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ token: value }), signal: controller.signal,
        });
        if (!response.ok) throw new Error(await responseError(response, "This invitation is invalid or has expired. Ask your administrator for a new link."));
        const data: Invitation = await response.json();
        if (controller.signal.aborted) return;
        setInvitation(data);
        setUsername(data.username ?? "");
      } catch (cause) {
        if (!controller.signal.aborted) setLoadError(cause instanceof Error ? cause.message : "Check your connection and try again.");
      } finally {
        if (!controller.signal.aborted) setLoading(false);
      }
    }
    void inspect();
    return () => controller.abort();
  }, [attempt]);

  useEffect(() => {
    const update = () => setAttempt(value => value + 1);
    window.addEventListener("hashchange", update);
    return () => window.removeEventListener("hashchange", update);
  }, []);

  async function register(event: FormEvent) {
    event.preventDefault();
    if (busy || !invitation) return;
    setError("");
    if (password.length < 8 || password.length > 128) {
      setError("Choose a password between 8 and 128 characters.");
      return;
    }
    if (password !== confirmation) {
      setError("The passwords do not match.");
      return;
    }
    setBusy(true);
    try {
      const response = await fetch("/api/register", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ token, username: username.trim(), password }),
      });
      if (!response.ok) throw new Error(await responseError(response, "Could not complete your request. Please try again."));
      window.location.replace("/");
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Check your connection and try again.");
      setBusy(false);
    }
  }

  const resetting = invitation?.kind === "reset";
  return <div className="shelf-app">
    <header className="shelf-header"><div className="shelf-header-inner"><Link className="shelf-brand" href="/" aria-label="Shelf home">Shelf.</Link><div className="shelf-header-actions"><ThemeSelector /><Link className="shelf-button shelf-button-light" href="/">Sign in</Link></div></div></header>
    <main className="shelf-main">
      {loading ? <div className="shelf-loading" role="status"><LoaderCircle size={20} className="shelf-spin" />Checking invitation</div> : loadError ? <section className="shelf-state-card">
        <CircleAlert size={28} strokeWidth={1.5} /><h1>Invitation unavailable</h1><p role="alert">{loadError}</p>
        <button className="shelf-button shelf-button-light" type="button" onClick={() => setAttempt(value => value + 1)}><RotateCcw size={16} />Try again</button>
      </section> : invitation && <section className="shelf-login shelf-join">
        <form className="shelf-login-form" onSubmit={register}>
          <h1>{resetting ? "Reset your password" : "Join the library"}</h1>
          <p>{resetting ? "Choose a new password to access your account again." : "Create your account to read books and save your own reading progress."}</p>
          <label className="shelf-field-label">Username<input autoComplete="username" autoCapitalize="none" spellCheck={false} value={username} onChange={event => setUsername(event.target.value)} readOnly={resetting} disabled={busy} autoFocus={!resetting} minLength={3} maxLength={32} pattern="[A-Za-z0-9][A-Za-z0-9_.\-]{2,31}" aria-describedby={resetting ? undefined : "shelf-username-hint"} required /></label>
          {!resetting && <p id="shelf-username-hint" className="shelf-field-hint">3–32 characters. Start with a letter or number; dots, underscores and hyphens are allowed.</p>}
          <label className="shelf-field-label">Password<input type="password" autoComplete="new-password" minLength={8} maxLength={128} value={password} onChange={event => setPassword(event.target.value)} disabled={busy} autoFocus={resetting} aria-describedby="shelf-join-password-hint" required /></label>
          <p id="shelf-join-password-hint" className="shelf-field-hint">Use 8–128 characters. Spaces are allowed.</p>
          <label className="shelf-field-label">Confirm password<input type="password" autoComplete="new-password" minLength={8} maxLength={128} value={confirmation} onChange={event => setConfirmation(event.target.value)} disabled={busy} required /></label>
          {error && <p className="shelf-form-error" role="alert"><CircleAlert size={16} />{error}</p>}
          <button type="submit" className="shelf-button shelf-button-primary" disabled={busy || !username.trim() || !password || !confirmation}>{busy && <LoaderCircle size={16} className="shelf-spin" />}{resetting ? "Save new password" : "Create account"}<ArrowRight size={16} /></button>
        </form>
      </section>}
    </main>
  </div>;
}
