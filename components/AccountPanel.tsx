"use client";

import { useCallback, useEffect, useRef, useState, type FormEvent } from "react";
import { CheckCircle2, CircleAlert, Copy, KeyRound, LoaderCircle, Plus, RotateCcw, X } from "lucide-react";
import type { AccountInvitation, AccountUser, ManagedUser, SessionResponse } from "@/lib/types";
import { isDialogBackdropClick, showModalDialog } from "@/lib/client/dialog";

type CreatedInvitation = AccountInvitation & { link: string };

function dateLabel(value: string) {
  return new Date(value).toLocaleString("en", { dateStyle: "medium", timeStyle: "short" });
}

export default function AccountPanel({ user, onClose, onUnauthorized, onSession }: {
  user: AccountUser;
  onClose: () => void;
  onUnauthorized: () => void;
  onSession: (session: SessionResponse) => void;
}) {
  const dialogRef = useRef<HTMLDialogElement>(null);
  const linkRef = useRef<HTMLInputElement>(null);
  const [section, setSection] = useState<"password" | "members">("password");
  const [currentPassword, setCurrentPassword] = useState("");
  const [newPassword, setNewPassword] = useState("");
  const [confirmation, setConfirmation] = useState("");
  const [busy, setBusy] = useState("");
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [loading, setLoading] = useState(false);
  const [loadError, setLoadError] = useState("");
  const [users, setUsers] = useState<ManagedUser[]>([]);
  const [invitations, setInvitations] = useState<AccountInvitation[]>([]);
  const [created, setCreated] = useState<CreatedInvitation | null>(null);
  const [copyNotice, setCopyNotice] = useState("");
  const isAdmin = user.role === "admin";

  useEffect(() => {
    const dialog = dialogRef.current;
    if (dialog) return showModalDialog(dialog);
  }, []);

  const request = useCallback(async <T,>(path: string, options?: RequestInit): Promise<T> => {
    const response = await fetch(path, { cache: "no-store", ...options });
    if (response.status === 401) {
      onUnauthorized();
      throw new Error("Please sign in again.");
    }
    if (!response.ok) {
      let message = "Could not save your changes. Please try again.";
      try {
        const data: { error?: string } = await response.json();
        if (typeof data.error === "string") message = data.error;
      } catch { /* A proxy may return a non-JSON error. */ }
      throw new Error(message);
    }
    return response.status === 204 ? undefined as T : await response.json() as T;
  }, [onUnauthorized]);

  const loadMembers = useCallback(async (signal?: AbortSignal) => {
    setLoading(true);
    setLoadError("");
    try {
      const [memberData, invitationData] = await Promise.all([
        request<{ users: ManagedUser[] }>("/api/admin/users", { signal }),
        request<{ invitations: AccountInvitation[] }>("/api/admin/invitations", { signal }),
      ]);
      if (signal?.aborted) return;
      setUsers(memberData.users);
      setInvitations(invitationData.invitations);
      setCreated(current => current && invitationData.invitations.some(invitation => invitation.id === current.id) ? current : null);
    } catch (cause) {
      if (!signal?.aborted) setLoadError(cause instanceof Error ? cause.message : "Could not load members.");
    } finally {
      if (!signal?.aborted) setLoading(false);
    }
  }, [request]);

  useEffect(() => {
    if (!isAdmin || section !== "members") return;
    const controller = new AbortController();
    void loadMembers(controller.signal);
    return () => controller.abort();
  }, [isAdmin, section, loadMembers]);

  async function changePassword(event: FormEvent) {
    event.preventDefault();
    if (busy) return;
    setError("");
    setNotice("");
    if (newPassword.length < 8 || newPassword.length > 128) {
      setError("Choose a password between 8 and 128 characters.");
      return;
    }
    if (newPassword !== confirmation) {
      setError("The new passwords do not match.");
      return;
    }
    setBusy("password");
    try {
      const session = await request<SessionResponse>("/api/session", {
        method: "PATCH", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ currentPassword, newPassword }),
      });
      onSession(session);
      setCurrentPassword("");
      setNewPassword("");
      setConfirmation("");
      setNotice("Password changed. Your other sessions have been signed out.");
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Could not change your password.");
    } finally { setBusy(""); }
  }

  async function createInvitation(member?: ManagedUser) {
    if (busy) return;
    setBusy(member ? `reset-${member.id}` : "invite");
    setError("");
    setNotice("");
    setCopyNotice("");
    try {
      const data = await request<{ invitation: AccountInvitation; token: string }>("/api/admin/invitations", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify(member ? { userId: member.id } : {}),
      });
      setCreated({ ...data.invitation, link: `${window.location.origin}/join#token=${encodeURIComponent(data.token)}` });
      setNotice(member ? "Password reset link created. Copy it below." : "Invitation created. Copy the link below.");
      await loadMembers();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Could not create an invitation.");
    } finally { setBusy(""); }
  }

  async function setBlocked(member: ManagedUser) {
    if (busy) return;
    setBusy(member.id);
    setError("");
    setNotice("");
    try {
      await request(`/api/admin/users/${encodeURIComponent(member.id)}`, {
        method: "PATCH", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ disabled: !member.disabled }),
      });
      setNotice(`${member.username} ${member.disabled ? "can access the library again" : "has been blocked"}.`);
      await loadMembers();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Could not update this member.");
    } finally { setBusy(""); }
  }

  async function revokeInvitation(invitation: AccountInvitation) {
    if (busy) return;
    setBusy(invitation.id);
    setError("");
    setNotice("");
    try {
      await request(`/api/admin/invitations/${encodeURIComponent(invitation.id)}`, { method: "DELETE" });
      if (created?.id === invitation.id) setCreated(null);
      setNotice("Invitation cancelled.");
      await loadMembers();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Could not cancel this invitation.");
    } finally { setBusy(""); }
  }

  async function copyLink() {
    if (!created) return;
    try {
      if (!navigator.clipboard?.writeText) throw new Error("clipboard_unavailable");
      await navigator.clipboard.writeText(created.link);
      setCopyNotice("Link copied. Share it directly with the intended reader.");
    } catch {
      // LAN HTTP pages may not have clipboard access. Keep the link selectable.
      linkRef.current?.focus();
      linkRef.current?.select();
      setCopyNotice("Select and copy the link above, then share it directly.");
    }
  }

  function switchSection(value: "password" | "members") {
    setSection(value);
    setError("");
    setNotice("");
  }

  return (
    <dialog ref={dialogRef} className="shelf-dialog shelf-account-dialog" aria-labelledby="shelf-account-title" aria-describedby="shelf-account-description"
      onCancel={event => { event.preventDefault(); if (!busy) onClose(); }}
      onClick={event => { if (!busy && isDialogBackdropClick(event)) onClose(); }}>
      <div className="shelf-account-content">
        <button className="shelf-icon-button shelf-dialog-close" type="button" aria-label="Close account settings" onClick={onClose} disabled={!!busy}><X size={21} /></button>
        <h2 id="shelf-account-title">Account settings</h2>
        <p id="shelf-account-description" className="shelf-account-description">{user.username} · {isAdmin ? "Administrator" : "Reader"}</p>
        {isAdmin && <nav className="shelf-account-nav" aria-label="Account sections">
          <button type="button" aria-pressed={section === "password"} onClick={() => switchSection("password")} disabled={!!busy}>Password</button>
          <button type="button" aria-pressed={section === "members"} onClick={() => switchSection("members")} disabled={!!busy}>Manage members</button>
        </nav>}
        {error && <p className="shelf-form-error" role="alert"><CircleAlert size={16} />{error}</p>}
        {notice && <p className="shelf-account-notice" role="status"><CheckCircle2 size={16} />{notice}</p>}

        {section === "password" ? <form className="shelf-account-password" onSubmit={changePassword}>
          <input type="text" name="username" autoComplete="username" value={user.username} readOnly hidden />
          <label className="shelf-field-label">Current password<input type="password" autoComplete="current-password" value={currentPassword} onChange={event => setCurrentPassword(event.target.value)} required disabled={!!busy} /></label>
          <label className="shelf-field-label">New password<input type="password" autoComplete="new-password" minLength={8} maxLength={128} value={newPassword} onChange={event => setNewPassword(event.target.value)} aria-describedby="shelf-password-hint" required disabled={!!busy} /></label>
          <p id="shelf-password-hint" className="shelf-field-hint">Use 8–128 characters. Spaces are allowed.</p>
          <label className="shelf-field-label">Confirm new password<input type="password" autoComplete="new-password" minLength={8} maxLength={128} value={confirmation} onChange={event => setConfirmation(event.target.value)} required disabled={!!busy} /></label>
          <div className="shelf-dialog-actions"><button type="submit" className="shelf-button shelf-button-primary" disabled={!!busy || !currentPassword || !newPassword || !confirmation}>{busy === "password" && <LoaderCircle size={16} className="shelf-spin" />}Change password</button></div>
        </form> : <div className="shelf-member-management">
          <section className="shelf-account-section" aria-labelledby="shelf-invite-heading">
            <div className="shelf-account-section-heading"><h3 id="shelf-invite-heading">Invite a reader</h3><button className="shelf-button shelf-button-primary" type="button" onClick={() => void createInvitation()} disabled={!!busy || loading}><Plus size={15} />Create invitation</button></div>
            <p className="shelf-field-hint">Readers can read books on the site. Only the administrator can download original PDFs. Reading progress is private to each account.</p>
            {created && <div className="shelf-invitation-created">
              <strong>{created.kind === "reset" ? `Reset password for ${created.username}` : "Your invitation is ready"}</strong>
              <p>This link can be used once within 7 days, until {dateLabel(created.expiresAt)}. Copy it now; it is only shown here after creation.</p>
              <label className="shelf-field-label">Invitation link<input ref={linkRef} readOnly value={created.link} onFocus={event => event.currentTarget.select()} /></label>
              <button className="shelf-button shelf-button-light" type="button" onClick={() => void copyLink()}><Copy size={15} />Copy link</button>
              {copyNotice && <p role="status">{copyNotice}</p>}
            </div>}
          </section>
          {loading ? <div className="shelf-account-loading" role="status"><LoaderCircle className="shelf-spin" size={18} />Loading members</div> : loadError ? <div className="shelf-account-load-error"><p className="shelf-form-error" role="alert"><CircleAlert size={16} />{loadError}</p><button className="shelf-button shelf-button-light" type="button" onClick={() => void loadMembers()}><RotateCcw size={15} />Try again</button></div> : <>
            <section className="shelf-account-section" aria-labelledby="shelf-members-heading">
              <h3 id="shelf-members-heading">Members</h3>
              <ul className="shelf-account-list">{users.map(member => <li key={member.id}>
                <div className="shelf-account-list-copy"><strong>{member.username}</strong><span>{member.role === "admin" ? "Administrator" : member.disabled ? "Blocked" : "Reader"}{member.id === user.id ? " · You" : ""}</span></div>
                {member.role === "reader" && <div className="shelf-account-list-actions">
                  <button className="shelf-button shelf-button-light" type="button" aria-label={`Create reset link for ${member.username}`} onClick={() => void createInvitation(member)} disabled={!!busy || member.disabled}><KeyRound size={14} /><span>Reset password</span></button>
                  <button className={`shelf-button ${member.disabled ? "shelf-button-light" : "shelf-button-block"}`} type="button" aria-label={`${member.disabled ? "Unblock" : "Block"} ${member.username}`} onClick={() => void setBlocked(member)} disabled={!!busy}>{member.disabled ? "Unblock" : "Block"}</button>
                </div>}
              </li>)}</ul>
              <p className="shelf-field-hint">Blocking a reader signs them out and stops library access. Their account and reading progress are kept.</p>
            </section>
            <section className="shelf-account-section" aria-labelledby="shelf-invitations-heading">
              <h3 id="shelf-invitations-heading">Active invitations</h3>
              {invitations.length ? <ul className="shelf-account-list">{invitations.map(invitation => <li key={invitation.id}>
                <div className="shelf-account-list-copy"><strong>{invitation.kind === "reset" ? `Password reset · ${invitation.username}` : "Reader invitation"}</strong><span>Expires {dateLabel(invitation.expiresAt)}</span></div>
                <button className="shelf-button shelf-button-light" type="button" aria-label={`Cancel ${invitation.kind === "reset" ? `password reset for ${invitation.username}` : "reader invitation"}`} onClick={() => void revokeInvitation(invitation)} disabled={!!busy}>Cancel</button>
              </li>)}</ul> : <p className="shelf-field-hint">No active invitations.</p>}
            </section>
          </>}
        </div>}
      </div>
    </dialog>
  );
}
