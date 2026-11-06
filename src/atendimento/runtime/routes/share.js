// Atendimento runtime restored from the existing O Mascote application.
"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.GET = GET;
exports.POST = POST;
const lab_storage_1 = require("../lib/lab-storage");
const lab_engine_1 = require("../lib/lab-engine");
const noStore = { 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' };
async function GET(request) {
    try {
        (0, lab_storage_1.localRequest)(request);
        const id = new URL(request.url).searchParams.get('id') || '';
        if (!/^[a-f0-9-]{36}$/.test(id))
            throw new Error('Link inválido.');
        const item = await (0, lab_storage_1.bucket)().get(`shares/${id}`);
        if (!item)
            throw new Error('Link não encontrado.');
        const share = await item.json();
        const state = await (0, lab_storage_1.readState)(share.owner);
        if (share.kind === 'ratings')
            return Response.json({ ok: true, kind: 'ratings', profile: { name: state.profile.name || '' }, athletes: state.athletes.map(a => ({ name: a.name })) }, { headers: noStore });
        if (state.profile.visibility !== 'Página de teste compartilhável')
            throw new Error('Este perfil está privado.');
        const profile = Object.fromEntries(['name', 'sport', 'city', 'state', 'description', 'instagram'].map(key => [key, state.profile[key] || '']));
        return Response.json({ ok: true, kind: 'profile', profile, athletes: state.athletes.map(a => ({ name: a.name, position: a.position, number: a.number })), lineup: state.lineup, games: state.games.map(g => ({ id: g.id, name: g.name, result: g.result })) }, { headers: noStore });
    }
    catch (e) {
        return Response.json({ ok: false, error: e instanceof Error ? e.message : 'Link indisponível.' }, { status: 404, headers: noStore });
    }
}
async function POST(request) {
    const session = (0, lab_storage_1.labSession)(request);
    try {
        (0, lab_storage_1.localRequest)(request);
        const raw = await request.text();
        if (raw.length > 18000)
            throw new Error('Dados muito grandes.');
        const body = JSON.parse(raw);
        if (body.action === 'create') {
            if (!['profile', 'ratings'].includes(body.kind))
                throw new Error('Opção inválida.');
            const link = await (0, lab_storage_1.mutate)(session, async (state) => {
                if (body.kind === 'profile' && state.profile.visibility !== 'Página de teste compartilhável')
                    throw new Error('No Perfil, escolha “Página de teste compartilhável” e salve primeiro.');
                if (body.kind === 'ratings' && !state.athletes.length)
                    throw new Error('Cadastre os atletas primeiro.');
                const link = { id: crypto.randomUUID(), kind: body.kind, createdAt: new Date().toISOString() };
                await (0, lab_storage_1.bucket)().put(`shares/${link.id}`, JSON.stringify({ owner: session, ...link, voters: [] }));
                state.shareLinks.push(link);
                return { state, value: link };
            });
            return Response.json({ ok: true, url: `/compartilhar/${link.id}`, link }, { headers: (0, lab_storage_1.headers)(session) });
        }
        if (body.action === 'vote') {
            if (!/^[a-f0-9-]{36}$/.test(body.id))
                throw new Error('Link inválido.');
            const item = await (0, lab_storage_1.bucket)().get(`shares/${body.id}`);
            if (!item)
                throw new Error('Link não encontrado.');
            const share = await item.json();
            if (share.kind !== 'ratings')
                throw new Error('Este link não aceita avaliações.');
            const ratings = String(body.ratings || '');
            if (!ratings.trim())
                throw new Error('Informe as notas.');
            const voteId = await (0, lab_storage_1.voteKey)(`${body.id}:${session}`);
            await (0, lab_storage_1.mutate)(share.owner, state => {
                if (share.voters.includes(session))
                    throw new Error('Este navegador já enviou uma avaliação neste link.');
                // Save ratings and deduplication together; leave the owner's current draft untouched.
                return { state: (0, lab_engine_1.applyRatings)(state, ratings, voteId), value: null };
            });
            return Response.json({ ok: true, reply: 'Avaliações enviadas e incorporadas à média da equipe de teste.' }, { headers: (0, lab_storage_1.headers)(session) });
        }
        throw new Error('Ação inválida.');
    }
    catch (e) {
        return Response.json({ ok: false, error: e instanceof Error ? e.message : 'Não foi possível concluir.' }, { status: 400, headers: (0, lab_storage_1.headers)(session) });
    }
}
