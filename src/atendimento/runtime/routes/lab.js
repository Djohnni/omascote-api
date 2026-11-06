// Atendimento runtime restored from the existing O Mascote application.
"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.GET = GET;
exports.POST = POST;
const lab_engine_1 = require("../lib/lab-engine");
const lab_storage_1 = require("../lib/lab-storage");
const workflows_1 = require("../lib/workflows");
const luna_1 = require("../lib/luna");
async function GET(request) {
    try {
        (0, lab_storage_1.localRequest)(request);
        const session = (0, lab_storage_1.labSession)(request);
        return Response.json({ ok: true, state: await (0, lab_storage_1.readState)(session) }, { headers: (0, lab_storage_1.headers)(session) });
    }
    catch {
        return Response.json({ ok: false, error: 'Não foi possível abrir os dados do teste.' }, { status: 503 });
    }
}
async function POST(request) {
    const session = (0, lab_storage_1.labSession)(request);
    try {
        (0, lab_storage_1.localRequest)(request);
        const raw = await request.text();
        if (raw.length > 240000)
            throw new Error('Dados muito grandes.');
        const body = JSON.parse(raw);
        if (typeof body.action !== 'string' || !body.payload || typeof body.payload !== 'object')
            throw new Error('Ação inválida.');
        if (body.payload.draft) {
            const d = body.payload.draft;
            if (!d.id || !workflows_1.FLOW_IDS.includes(d.flow) || !d.values || typeof d.values !== 'object' || Array.isArray(d.values) || !Array.isArray(d.files) || d.files.length > 50)
                throw new Error('Dados inválidos.');
            if (Object.values(d.values).some(v => typeof v !== 'string' || v.length > 12000))
                throw new Error('Resposta muito grande.');
            for (const f of d.files) {
                if (!/^[a-f0-9-]{36}$/.test(f.id) || !await (0, lab_storage_1.bucket)().head(`${session}/files/${f.id}`))
                    throw new Error('Um anexo não foi salvo. Envie novamente.');
            }
        }
        if (body.action === 'save_chat' && (!Array.isArray(body.payload.chat) || body.payload.chat.some((m) => !m || typeof m !== 'object' || !['user', 'assistant'].includes(String(Reflect.get(m, 'role'))) || typeof Reflect.get(m, 'text') !== 'string')))
            throw new Error('Conversa inválida.');
        if (body.action === 'complete' && body.payload.draft?.flow === 'personalizada') {
            const state = await (0, lab_storage_1.readState)(session);
            if (state.conversationId && body.payload.conversationId !== state.conversationId)
                throw new Error('Uma nova conversa foi aberta. Atualize a página antes de confirmar.');
            if (!await (0, luna_1.verifySportsBrief)(body.payload.draft.values))
                throw new Error('Esse pedido não é uma imagem esportiva. Conte o objetivo ligado ao esporte.');
            body.payload.draft.values.scope_verified = 'yes';
        }
        const result = await (0, lab_storage_1.mutate)(session, state => { const result = (0, lab_engine_1.applyAction)(state, body.action, body.payload); return { state: result.state, value: result }; });
        return Response.json({ ok: true, ...result }, { headers: (0, lab_storage_1.headers)(session) });
    }
    catch (error) {
        return Response.json({ ok: false, error: error instanceof Error ? error.message : 'Não foi possível salvar.' }, { status: 400, headers: (0, lab_storage_1.headers)(session) });
    }
}
