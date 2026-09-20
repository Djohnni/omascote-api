"use strict";

const express = require("express");

function createChatAuditAdminRouter({ store, auth, isAdmin }) {
  if (!store) throw new Error("CHAT_AUDIT_STORE_REQUIRED");
  if (typeof auth !== "function") throw new Error("CHAT_AUDIT_AUTH_REQUIRED");
  if (typeof isAdmin !== "function") throw new Error("CHAT_AUDIT_ADMIN_CHECK_REQUIRED");

  const router = express.Router();
  router.use(auth);
  router.use((req, res, next) => {
    if (!isAdmin(req)) return res.status(403).json({ ok: false, error: "Acesso negado" });
    return next();
  });

  router.get("/pendentes", (req, res) => {
    try {
      const conversations = store.listPending({ limit: req.query?.limite });
      return res.json({ ok: true, total: conversations.length, conversations });
    } catch (error) {
      console.error("[chat_audit] erro_listar", error?.message || error);
      return res.status(500).json({ ok: false, error: "Erro ao listar auditorias do chat" });
    }
  });

  router.post("/:id/recebida", (req, res) => {
    try {
      const conversation = store.acknowledge({
        id: req.params.id,
        revision: req.body?.revision
      });
      if (!conversation) {
        return res.status(404).json({ ok: false, error: "Conversa não encontrada" });
      }
      return res.json({
        ok: true,
        id: conversation.id,
        delivered_revision: conversation.delivered_revision
      });
    } catch (error) {
      console.error("[chat_audit] erro_confirmar", error?.message || error);
      return res.status(500).json({ ok: false, error: "Erro ao confirmar auditoria do chat" });
    }
  });

  return router;
}

module.exports = { createChatAuditAdminRouter };
