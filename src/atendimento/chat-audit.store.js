"use strict";

const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");

const DEFAULT_INACTIVITY_MS = 10 * 60 * 1000;
const SESSION_RE = /^[a-f0-9-]{36}$/i;
const MAX_MESSAGES_PER_CONVERSATION = 500;
const MAX_MESSAGE_TEXT = 6_000;

function cleanText(value, maxLength) {
  return String(value || "")
    .replace(/\u0000/g, "")
    .trim()
    .slice(0, maxLength);
}

function normalizeMessage(message, index, capturedAt) {
  const role = String(message?.role || "").toLowerCase();
  if (!['user', 'assistant'].includes(role)) return null;

  const text = cleanText(message?.text, MAX_MESSAGE_TEXT);
  if (!text) return null;

  const fallbackId = crypto
    .createHash("sha256")
    .update(`${role}:${index}:${text}`)
    .digest("hex")
    .slice(0, 32);

  return {
    id: cleanText(message?.id, 120) || fallbackId,
    role,
    text,
    captured_at: capturedAt,
    ...(cleanText(message?.flow, 80) ? { flow: cleanText(message.flow, 80) } : {}),
    ...(cleanText(message?.action, 80) ? { action: cleanText(message.action, 80) } : {})
  };
}

function emptyState() {
  return { version: 1, conversations: [] };
}

class AtendimentoChatAuditStore {
  constructor({ filePath, inactivityMs = DEFAULT_INACTIVITY_MS, now = () => new Date() }) {
    if (!filePath) throw new Error("CHAT_AUDIT_FILE_REQUIRED");
    this.filePath = filePath;
    this.inactivityMs = inactivityMs;
    this.now = now;
  }

  _nowIso() {
    const value = this.now();
    const date = value instanceof Date ? value : new Date(value);
    return date.toISOString();
  }

  _read() {
    try {
      const parsed = JSON.parse(fs.readFileSync(this.filePath, "utf8"));
      return {
        version: 1,
        conversations: Array.isArray(parsed?.conversations) ? parsed.conversations : []
      };
    } catch (error) {
      if (error?.code === "ENOENT") return emptyState();
      throw error;
    }
  }

  _write(state) {
    fs.mkdirSync(path.dirname(this.filePath), { recursive: true });
    const temporary = `${this.filePath}.${process.pid}.tmp`;
    fs.writeFileSync(temporary, JSON.stringify(state, null, 2), "utf8");
    fs.renameSync(temporary, this.filePath);
  }

  captureLabAction({ session, body }) {
    if (!SESSION_RE.test(String(session || ""))) return null;
    if (String(body?.action || "") !== "save_chat") return null;

    const payload = body?.payload || {};
    const conversationId = String(payload.conversationId || "").toLowerCase();
    if (!SESSION_RE.test(conversationId) || !Array.isArray(payload.chat)) return null;

    const capturedAt = this._nowIso();
    const incoming = payload.chat
      .slice(-MAX_MESSAGES_PER_CONVERSATION)
      .map((message, index) => normalizeMessage(message, index, capturedAt))
      .filter(Boolean);

    const state = this._read();
    const foundIndex = state.conversations.findIndex(item => item.id === conversationId);
    const previous = foundIndex >= 0 ? state.conversations[foundIndex] : null;
    if (!previous && !incoming.some(message => message.role === "user")) return null;
    const previousMessages = Array.isArray(previous?.messages) ? previous.messages : [];
    const previousById = new Map(previousMessages.map(message => [message.id, message]));
    const merged = [...previousMessages];
    let changed = false;

    for (const message of incoming) {
      const existing = previousById.get(message.id);
      if (!existing) {
        merged.push(message);
        previousById.set(message.id, message);
        changed = true;
        continue;
      }

      const updated = {
        ...existing,
        role: message.role,
        text: message.text,
        ...(message.flow ? { flow: message.flow } : {}),
        ...(message.action ? { action: message.action } : {})
      };
      if (JSON.stringify(updated) !== JSON.stringify(existing)) {
        const existingIndex = merged.findIndex(item => item.id === message.id);
        merged[existingIndex] = updated;
        previousById.set(message.id, updated);
        changed = true;
      }
    }

    if (previous && !changed) return previous;

    const messages = merged.slice(-MAX_MESSAGES_PER_CONVERSATION);
    const revision = Number(previous?.revision || 0) + 1;
    const record = {
      id: conversationId,
      session: String(session).toLowerCase(),
      started_at: previous?.started_at || capturedAt,
      last_activity_at: capturedAt,
      revision,
      delivered_revision: Number(previous?.delivered_revision || 0),
      delivered_at: previous?.delivered_at || null,
      messages
    };

    if (foundIndex >= 0) state.conversations[foundIndex] = record;
    else state.conversations.push(record);
    this._write(state);
    return record;
  }

  listPending({ limit = 100 } = {}) {
    const state = this._read();
    const nowMs = new Date(this._nowIso()).getTime();
    const safeLimit = Math.min(Math.max(Number(limit) || 100, 1), 200);

    return state.conversations
      .filter(conversation => {
        const lastActivityMs = new Date(conversation.last_activity_at || 0).getTime();
        const hasUserMessage = Array.isArray(conversation.messages)
          && conversation.messages.some(message => message.role === "user");
        return hasUserMessage
          && Number.isFinite(lastActivityMs)
          && nowMs - lastActivityMs >= this.inactivityMs
          && Number(conversation.delivered_revision || 0) < Number(conversation.revision || 0);
      })
      .sort((left, right) => new Date(left.last_activity_at) - new Date(right.last_activity_at))
      .slice(0, safeLimit)
      .map(conversation => ({
        ...conversation,
        inactive_for_seconds: Math.max(
          0,
          Math.floor((nowMs - new Date(conversation.last_activity_at).getTime()) / 1000)
        )
      }));
  }

  acknowledge({ id, revision }) {
    const conversationId = String(id || "").toLowerCase();
    const receivedRevision = Number(revision);
    if (!SESSION_RE.test(conversationId) || !Number.isInteger(receivedRevision) || receivedRevision < 1) {
      return null;
    }

    const state = this._read();
    const foundIndex = state.conversations.findIndex(item => item.id === conversationId);
    if (foundIndex < 0) return null;

    const current = state.conversations[foundIndex];
    current.delivered_revision = Math.max(
      Number(current.delivered_revision || 0),
      Math.min(receivedRevision, Number(current.revision || 0))
    );
    current.delivered_at = this._nowIso();
    state.conversations[foundIndex] = current;
    this._write(state);
    return current;
  }
}

module.exports = {
  AtendimentoChatAuditStore,
  DEFAULT_INACTIVITY_MS,
  MAX_MESSAGE_TEXT,
  normalizeMessage
};
