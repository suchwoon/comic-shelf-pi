import type { DatabaseSync } from "node:sqlite";
import { CHAT_HISTORY_LIMIT, CHAT_MESSAGE_LIMIT, type AccountUser, type ChatMessage } from "../types";
import { ApiError } from "./http";
import { store } from "./storage";

const CLIENT_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const MESSAGE_RATE_LIMIT = 20;
const MESSAGE_RATE_WINDOW = 60_000;
const columns = "m.id, m.userId, u.username, m.body, m.createdAt";
const shared = globalThis as typeof globalThis & { __comicChatSchemas?: WeakSet<DatabaseSync> };

function chatStore() {
  const { db } = store();
  shared.__comicChatSchemas ??= new WeakSet();
  if (!shared.__comicChatSchemas.has(db)) {
    // Authentication initializes users before any chat operation.
    db.exec(`
      CREATE TABLE IF NOT EXISTS chat_messages (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        userId TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        clientId TEXT NOT NULL,
        body TEXT NOT NULL CHECK (length(body) BETWEEN 1 AND ${CHAT_MESSAGE_LIMIT}),
        createdAt TEXT NOT NULL,
        UNIQUE (userId, clientId)
      );
      CREATE INDEX IF NOT EXISTS chat_messages_user_created ON chat_messages(userId, createdAt);
    `);
    shared.__comicChatSchemas.add(db);
  }
  return db;
}

export function listChatMessages(): ChatMessage[] {
  return (chatStore().prepare(`SELECT ${columns} FROM chat_messages m JOIN users u ON u.id = m.userId
    ORDER BY m.id DESC LIMIT ?`).all(CHAT_HISTORY_LIMIT) as unknown as ChatMessage[]).reverse();
}

export function createChatMessage(user: AccountUser, input: Record<string, unknown>): ChatMessage {
  if (Object.keys(input).some(key => !["body", "clientId"].includes(key))
    || typeof input.body !== "string" || typeof input.clientId !== "string" || !CLIENT_ID.test(input.clientId)) {
    throw new ApiError(400, "The message format is invalid. Please try again.");
  }
  const body = input.body.trim();
  if (!body || body.length > CHAT_MESSAGE_LIMIT || /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(body)) {
    throw new ApiError(400, `Enter a message between 1 and ${CHAT_MESSAGE_LIMIT} characters.`);
  }
  const clientId = input.clientId.toLowerCase();
  const db = chatStore();
  db.exec("BEGIN IMMEDIATE");
  try {
    if (!db.prepare("SELECT 1 FROM users WHERE id = ? AND disabled = 0").get(user.id)) {
      throw new ApiError(401, "Please sign in to continue.");
    }
    const existing = db.prepare(`SELECT ${columns} FROM chat_messages m JOIN users u ON u.id = m.userId
      WHERE m.userId = ? AND m.clientId = ?`).get(user.id, clientId) as unknown as ChatMessage | undefined;
    if (existing) {
      db.exec("COMMIT");
      return existing;
    }
    const now = Date.now();
    const recent = db.prepare("SELECT COUNT(*) AS count FROM chat_messages WHERE userId = ? AND createdAt > ?")
      .get(user.id, new Date(now - MESSAGE_RATE_WINDOW).toISOString()) as { count: number };
    if (recent.count >= MESSAGE_RATE_LIMIT) throw new ApiError(429, "Please wait a moment before sending more messages.");
    const createdAt = new Date(now).toISOString();
    const result = db.prepare("INSERT INTO chat_messages (userId, clientId, body, createdAt) VALUES (?, ?, ?, ?)")
      .run(user.id, clientId, body, createdAt);
    const message = db.prepare(`SELECT ${columns} FROM chat_messages m JOIN users u ON u.id = m.userId WHERE m.id = ?`)
      .get(result.lastInsertRowid) as unknown as ChatMessage;
    db.exec("COMMIT");
    return message;
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }
}
