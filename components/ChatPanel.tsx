"use client";

import { useEffect, useLayoutEffect, useRef, useState } from "react";
import type { FormEvent } from "react";
import { ArrowDown, ArrowUp, LoaderCircle, MessageCircle, X } from "lucide-react";
import { CHAT_HISTORY_LIMIT, CHAT_MESSAGE_LIMIT } from "@/lib/types";
import type { AccountUser, ChatMessage } from "@/lib/types";

async function responseError(response: Response, fallback: string) {
  try {
    const data = await response.json();
    if (typeof data.error === "string") return data.error;
  } catch { /* A proxy may return an error without JSON. */ }
  return fallback;
}

function messageId() {
  if (crypto.randomUUID) return crypto.randomUUID();
  // getRandomValues also works on HTTP LAN origins, where randomUUID is absent.
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  bytes[6] = (bytes[6] & 15) | 64;
  bytes[8] = (bytes[8] & 63) | 128;
  const hex = Array.from(bytes, byte => byte.toString(16).padStart(2, "0")).join("");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

export default function ChatPanel({ user, onUnauthorized }: { user: AccountUser; onUnauthorized: () => void }) {
  const [open, setOpen] = useState(false);
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [loaded, setLoaded] = useState(false);
  const [loadError, setLoadError] = useState("");
  const [draft, setDraft] = useState("");
  const [sending, setSending] = useState(false);
  const [sendError, setSendError] = useState("");
  const [newMessages, setNewMessages] = useState(false);
  const dialogRef = useRef<HTMLDialogElement>(null);
  const launcherRef = useRef<HTMLButtonElement>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const listRef = useRef<HTMLDivElement>(null);
  const nearBottom = useRef(true);
  const sendController = useRef<AbortController | null>(null);
  const pendingMessage = useRef<{ body: string; clientId: string } | null>(null);
  const composing = useRef(false);

  function mergeMessages(incoming: ChatMessage[]) {
    setMessages(previous => {
      const known = new Map(previous.map(message => [message.id, message]));
      const additions = incoming.filter(message => !known.has(message.id));
      if (!additions.length) return previous;
      for (const message of additions) known.set(message.id, message);
      return [...known.values()].sort((a, b) => a.id - b.id).slice(-CHAT_HISTORY_LIMIT);
    });
  }

  useEffect(() => {
    if (!open) return;
    const dialog = dialogRef.current!;
    const mobile = window.matchMedia("(max-width: 600px)");
    const previousOverflow = document.body.style.overflow;
    const show = () => {
      dialog.close();
      document.body.style.overflow = mobile.matches ? "hidden" : previousOverflow;
      if (mobile.matches) dialog.showModal();
      else { dialog.show(); inputRef.current?.focus({ preventScroll: true }); }
      if (nearBottom.current && listRef.current) listRef.current.scrollTop = listRef.current.scrollHeight;
    };
    show();
    mobile.addEventListener("change", show);
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape" && !document.querySelector("dialog:modal")) {
        event.preventDefault();
        setOpen(false);
      }
    };
    document.addEventListener("keydown", onKeyDown);
    return () => {
      mobile.removeEventListener("change", show);
      document.removeEventListener("keydown", onKeyDown);
      document.body.style.overflow = previousOverflow;
      dialog.close();
      launcherRef.current?.focus({ preventScroll: true });
    };
  }, [open]);

  // The visual viewport follows the mobile keyboard, including browsers that
  // leave the layout viewport at its original height while typing.
  useEffect(() => {
    if (!open || !window.visualViewport) return;
    const viewport = window.visualViewport;
    const syncViewport = () => {
      dialogRef.current?.style.setProperty("--chat-height", `${viewport.height}px`);
      dialogRef.current?.style.setProperty("--chat-top", `${viewport.offsetTop}px`);
    };
    syncViewport();
    viewport.addEventListener("resize", syncViewport);
    viewport.addEventListener("scroll", syncViewport);
    return () => {
      viewport.removeEventListener("resize", syncViewport);
      viewport.removeEventListener("scroll", syncViewport);
    };
  }, [open]);

  useEffect(() => {
    if (!open) return;
    let disposed = false;
    let active: AbortController | null = null;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const poll = async () => {
      if (disposed || document.hidden || active) return;
      clearTimeout(timer);
      const controller = new AbortController();
      active = controller;
      const timeout = setTimeout(() => controller.abort(), 10_000);
      try {
        const response = await fetch("/api/chat", { cache: "no-store", signal: controller.signal });
        if (disposed) return;
        if (response.status === 401) { onUnauthorized(); return; }
        if (!response.ok) throw new Error(await responseError(response, "Could not load the conversation. Retrying…"));
        const data: { messages: ChatMessage[] } = await response.json();
        if (disposed) return;
        mergeMessages(data.messages);
        setLoaded(true);
        setLoadError("");
      } catch (cause) {
        if (!disposed && !document.hidden) setLoadError(cause instanceof Error && cause.name !== "AbortError"
          ? cause.message : "Could not connect. Retrying…");
      } finally {
        clearTimeout(timeout);
        active = null;
        if (!disposed && !document.hidden) timer = setTimeout(() => void poll(), 3000);
      }
    };
    const onVisibility = () => {
      clearTimeout(timer);
      if (document.hidden) active?.abort();
      else void poll();
    };
    void poll();
    document.addEventListener("visibilitychange", onVisibility);
    window.addEventListener("online", onVisibility);
    return () => {
      disposed = true;
      clearTimeout(timer);
      active?.abort();
      document.removeEventListener("visibilitychange", onVisibility);
      window.removeEventListener("online", onVisibility);
    };
  }, [open, onUnauthorized]);

  useEffect(() => () => sendController.current?.abort(), []);

  useLayoutEffect(() => {
    if (!open) return;
    if (nearBottom.current && listRef.current) {
      listRef.current.scrollTop = listRef.current.scrollHeight;
      setNewMessages(false);
    } else setNewMessages(true);
  }, [messages, open, loaded]);

  async function send(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const body = draft.trim();
    if (!body || sendController.current || composing.current) return;
    const controller = new AbortController();
    sendController.current = controller;
    setSending(true);
    setSendError("");
    const timeout = setTimeout(() => controller.abort(), 10_000);
    try {
      // Reuse this ID after an uncertain network failure so retrying cannot
      // create two copies of a message the server already accepted.
      if (pendingMessage.current?.body !== body) pendingMessage.current = { body, clientId: messageId() };
      const response = await fetch("/api/chat", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify(pendingMessage.current), signal: controller.signal,
      });
      if (response.status === 401) { onUnauthorized(); return; }
      if (!response.ok) throw new Error(await responseError(response, "Could not send. Please try again."));
      const data: { message: ChatMessage } = await response.json();
      nearBottom.current = true;
      mergeMessages([data.message]);
      setDraft("");
      pendingMessage.current = null;
    } catch (cause) {
      setSendError(cause instanceof Error && cause.name !== "AbortError" ? cause.message : "Could not send. Check your connection and try again.");
    } finally {
      clearTimeout(timeout);
      sendController.current = null;
      setSending(false);
    }
  }

  return <>
    <button ref={launcherRef} className="shelf-button shelf-button-light shelf-chat-launcher" type="button"
      aria-label="Open chat" aria-expanded={open} aria-controls="shelf-chat" onClick={() => { nearBottom.current = true; setOpen(true); }} hidden={open}>
      <MessageCircle size={18} strokeWidth={1.5} /><span>Chat</span>
    </button>
    <dialog ref={dialogRef} id="shelf-chat" className="shelf-chat" aria-labelledby="shelf-chat-title" aria-describedby="shelf-chat-description"
      onCancel={event => { event.preventDefault(); setOpen(false); }}>
      <header className="shelf-chat-header">
        <div><h2 id="shelf-chat-title"><MessageCircle size={17} strokeWidth={1.5} />Chat</h2><p id="shelf-chat-description">A shared room for everyone.</p></div>
        <button type="button" className="shelf-icon-button" aria-label="Close chat" onClick={() => setOpen(false)}><X size={19} /></button>
      </header>
      <div className="shelf-chat-conversation">
        <div ref={listRef} className="shelf-chat-messages" role="log" aria-label="Conversation" aria-live="polite" aria-relevant="additions" tabIndex={0}
          onScroll={event => {
            const list = event.currentTarget;
            nearBottom.current = list.scrollHeight - list.scrollTop - list.clientHeight < 48;
            if (nearBottom.current) setNewMessages(false);
          }}>
          {!messages.length && <div className="shelf-chat-empty">
            {!loaded && !loadError ? <><LoaderCircle size={21} className="shelf-spin" /><p>Loading conversation…</p></> : loadError ? <p>Waiting for a connection…</p> : <><MessageCircle size={26} strokeWidth={1.2} /><p>No messages yet.<br />Say hello to your fellow readers.</p></>}
          </div>}
          {messages.map(message => <article className="shelf-chat-message" key={message.id}>
            <div className="shelf-chat-message-meta"><strong>{message.username}</strong>{message.userId === user.id && <span className="shelf-chat-you">you</span>}
              <time dateTime={message.createdAt} title={new Date(message.createdAt).toLocaleString()}>{new Date(message.createdAt).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}</time>
            </div><p>{message.body}</p>
          </article>)}
        </div>
        {newMessages && <button type="button" className="shelf-chat-new" onClick={() => {
          nearBottom.current = true;
          if (listRef.current) listRef.current.scrollTop = listRef.current.scrollHeight;
          setNewMessages(false);
        }}>New messages<ArrowDown size={13} /></button>}
      </div>
      {loadError && <p className="shelf-chat-status" role="status">{loadError}</p>}
      <form className="shelf-chat-compose" onSubmit={send}>
        {sendError && <p className="shelf-chat-error" role="alert">{sendError}</p>}
        <div className="shelf-chat-input-row">
          <textarea ref={inputRef} aria-label="Message" placeholder="Write a message…" rows={2} maxLength={CHAT_MESSAGE_LIMIT}
            value={draft} readOnly={sending} onChange={event => { setDraft(event.target.value); setSendError(""); pendingMessage.current = null; }}
            onCompositionStart={() => { composing.current = true; }} onCompositionEnd={() => { composing.current = false; }}
            onKeyDown={event => {
              if (event.key === "Enter" && !event.shiftKey && !event.nativeEvent.isComposing && event.nativeEvent.keyCode !== 229 && !composing.current) {
                event.preventDefault();
                event.currentTarget.form?.requestSubmit();
              }
            }} />
          <button className="shelf-button shelf-button-primary shelf-chat-send" type="submit" aria-label="Send message" disabled={sending || !draft.trim()}>
            {sending ? <LoaderCircle size={17} className="shelf-spin" /> : <ArrowUp size={18} />}
          </button>
        </div>
        <div className="shelf-chat-compose-note"><span>Enter to send · Shift+Enter for a new line</span>{draft.length > CHAT_MESSAGE_LIMIT * .8 && <span>{draft.length}/{CHAT_MESSAGE_LIMIT}</span>}</div>
      </form>
    </dialog>
  </>;
}
