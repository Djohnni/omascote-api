// Atendimento runtime restored from the existing O Mascote application.
"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.startConversation = startConversation;
exports.saveConversationPart = saveConversationPart;
function startConversation(state, payload) {
    const id = payload.id;
    if (typeof id !== 'string' || !/^[a-f0-9-]{36}$/.test(id))
        throw new Error('Conversa inválida.');
    state.conversations ??= [];
    state.conversationStarts ??= [];
    if (id === state.conversationId)
        return;
    if (state.conversationStarts.includes(id))
        throw new Error('Essa conversa já foi encerrada. Atualize a página.');
    const previous = payload.resumeId ? state.conversations.find(c => c.id === payload.resumeId) : null;
    if (payload.resumeId && !previous)
        throw new Error('Conversa anterior não encontrada.');
    const now = new Date().toISOString();
    if (state.draft || state.chat.some(m => m.id !== 'welcome')) {
        const archived = { id: state.conversationId || crypto.randomUUID(), startedAt: state.conversationStartedAt || now, archivedAt: now, chat: structuredClone(state.chat), draft: structuredClone(state.draft), chatRevision: state.chatRevision || 0, draftRevision: state.draftRevision || 0 };
        state.conversations.push(archived);
    }
    if (previous)
        state.conversations = state.conversations.filter(c => c.id !== previous.id);
    state.conversationId = id;
    state.conversationStartedAt = now;
    state.conversationStarts.push(id);
    state.chat = previous ? structuredClone(previous.chat) : [];
    state.draft = previous ? structuredClone(previous.draft) : null;
    state.chatRevision = 0;
    state.draftRevision = 0;
}
function saveConversationPart(state, action, payload) {
    const current = payload.conversationId === state.conversationId;
    if (state.conversationId && !payload.conversationId)
        throw new Error('Atualize a página para iniciar uma nova conversa.');
    let target = current || !state.conversationId ? state : state.conversations.find(c => c.id === payload.conversationId);
    if (!target && typeof payload.conversationId === 'string' && state.conversationStarts.includes(payload.conversationId)) {
        const meaningful = action === 'save_draft' ? Boolean(payload.draft) : payload.chat.some(m => m.id !== 'welcome');
        if (!meaningful)
            return;
        const now = new Date().toISOString();
        target = { id: payload.conversationId, startedAt: now, archivedAt: now, chat: [], draft: null, chatRevision: 0, draftRevision: 0 };
        state.conversations.push(target);
    }
    if (!target)
        throw new Error('Essa conversa foi encerrada. Atualize a página.');
    const revision = typeof payload.revision === 'number' && Number.isFinite(payload.revision) ? payload.revision : 0;
    if (action === 'save_chat') {
        if (revision < (target.chatRevision || 0))
            return;
        target.chat = payload.chat.slice(-80);
        target.chatRevision = revision;
    }
    else {
        if (revision < (target.draftRevision || 0))
            return;
        const draft = payload.draft;
        target.draft = draft && state.processed.includes(draft.id) ? null : draft;
        target.draftRevision = revision;
    }
}
