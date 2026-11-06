// Atendimento runtime restored from the existing O Mascote application.
"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.applyRatings = applyRatings;
exports.pendingResult = pendingResult;
exports.applyAction = applyAction;
const products_1 = require("./products");
const contract_players_1 = require("./contract-players");
const conversations_1 = require("./conversations");
const sports_1 = require("./sports");
const match_fields_1 = require("./match-fields");
const workflows_1 = require("./workflows");
const id = (prefix) => `${prefix}-${crypto.randomUUID().slice(0, 8)}`;
const lines = (s) => (s || '').split('\n').map(l => l.trim()).filter(Boolean);
const clean = (s) => s.trim().normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase();
function applyRatings(original, ratings, voteId) {
    const state = structuredClone(original);
    state.shareVotes ??= [];
    if (voteId && state.shareVotes.includes(voteId))
        throw new Error('Este navegador já enviou uma avaliação neste link.');
    const rows = lines(ratings).map(l => l.split('|').map(s => s.trim()));
    if (!rows.length)
        throw new Error('Informe as notas.');
    if (new Set(rows.map(([name]) => clean(name))).size !== rows.length)
        throw new Error('Avalie cada atleta uma única vez.');
    for (const [name, note] of rows) {
        if (!state.athletes.some(a => clean(a.name) === clean(name)))
            throw new Error(`Atleta fora do elenco: ${name}`);
        if (!note || !Number.isFinite(Number(note)) || Number(note) < 0 || Number(note) > 10)
            throw new Error(`Use nota de 0 a 10 para ${name}.`);
    }
    for (const [name, note] of rows)
        state.athletes.find(a => clean(a.name) === clean(name)).ratings.push(Number(note));
    if (voteId)
        state.shareVotes.push(voteId);
    return state;
}
function pendingResult(state, now = new Date()) {
    return state.games.find(g => g.status === 'scheduled' && Number.isFinite((0, workflows_1.eventInstant)(g.date).getTime()) && (0, workflows_1.eventInstant)(g.date).getTime() + 3 * 3600000 < now.getTime() && (!g.reminderAfter || new Date(g.reminderAfter).getTime() < now.getTime()));
}
function createOrder(state, draft) {
    const p = (0, products_1.getProduct)(draft.flow);
    if (!p)
        throw new Error('Arte inválida.');
    const values = (0, sports_1.normalizeArtValues)(draft.flow, draft.values);
    if (draft.flow === 'contratacao')
        values.announcement ||= 'Contratado';
    const units = ['jogador_escudo', 'contratacao'].includes(draft.flow) ? lines(values.players).length : 1;
    const custom = draft.flow === 'personalizada';
    const price = custom ? null : Number((p.price * units + (draft.flow === 'contratacao' && values.jersey_requested === 'Sim' ? units * 2 : 0)).toFixed(2));
    const funding = custom ? 'review' : p.planEligible && (0, workflows_1.planRemaining)(state) >= units ? 'test_plan' : 'test_pix';
    const order = { id: id('arte'), flow: draft.flow, values, files: [...draft.files], createdAt: new Date().toISOString(), status: custom ? 'review' : 'prepared', prompt: (0, sports_1.buildArtPrompt)(draft.flow, values, draft.files), price, units, funding, eventId: draft.eventId };
    if (draft.eventId) {
        const game = state.games.find(g => g.id === draft.eventId);
        if (!game)
            throw new Error('Evento não encontrado.');
        if (['resultado', 'resultado_jogo_jogador'].includes(draft.flow)) {
            if (!Number.isFinite((0, workflows_1.eventInstant)(game.date).getTime()) || (0, workflows_1.eventInstant)(game.date).getTime() > Date.now())
                throw new Error('O evento está no futuro ou sem data válida. Confira a data antes de registrar resultado.');
            if (game.status === 'played' && clean(game.result) !== clean(values.score || ''))
                throw new Error('Este evento já tem outro resultado confirmado. Confira o histórico antes de preparar a arte.');
            game.status = 'played';
            game.result = values.score;
        }
    }
    if (funding === 'test_plan')
        state.plan.usage.push({ at: order.createdAt, orderId: order.id, count: units });
    if (['proximo_jogo', 'proximo_jogo_jogador'].includes(draft.flow) && !draft.eventId) {
        const date = (0, match_fields_1.matchDateForDraft)(draft);
        if (!date)
            throw new Error('Confira a data e horário do jogo antes de confirmar.');
        const game = { id: id('evento'), sport: values.sport, name: values.matchup || values.athlete_name, date: date.toISOString(), venue: values.venue || '', competition: values.competition || '', status: 'scheduled', result: '', source: order.id };
        state.games.push(game);
        order.eventId = game.id;
    }
    if (['resultado', 'resultado_jogo_jogador'].includes(draft.flow) && !draft.eventId) {
        const game = { id: id('evento'), sport: values.sport, name: values.score || values.matchup || values.athlete_name, date: values.match_datetime || order.createdAt, venue: values.venue || '', competition: values.competition || '', status: 'played', result: values.score || '', source: order.id };
        state.games.push(game);
        order.eventId = game.id;
    }
    state.orders.push(order);
    return order;
}
function applyAction(original, action, payload) {
    const state = structuredClone(original ?? (0, workflows_1.newState)());
    if (action === 'start_conversation') {
        (0, conversations_1.startConversation)(state, payload);
        return { state, reply: '' };
    }
    if (action === 'save_draft' || action === 'save_chat') {
        (0, conversations_1.saveConversationPart)(state, action, payload);
        return { state, reply: '' };
    }
    if (state.conversationId && payload.conversationId !== state.conversationId)
        throw new Error('Uma nova conversa foi aberta. Atualize a página antes de confirmar.');
    if (action === 'simulate_match_day') {
        const invite = state.invites.find(i => i.id === payload.id && i.status === 'accepted');
        const game = state.games.find(g => g.id === invite?.gameId);
        if (!invite || !game || game.status === 'played')
            throw new Error('Escolha uma partida de teste aceita e ainda sem resultado.');
        game.date = new Date(Date.now() - 4 * 3600000).toISOString();
        return { state, reply: 'Dia da partida simulado apenas no teste. Agora informe o resultado e avalie o amistoso.' };
    }
    if (action === 'remind_later') {
        const g = state.games.find(g => g.id === payload.id);
        if (g)
            g.reminderAfter = new Date(Date.now() + 86400000).toISOString();
        return { state, reply: 'Tudo bem. Pergunto novamente a partir de amanhã.' };
    }
    if (action === 'radar_message') {
        const invite = state.invites.find(i => i.id === payload.id);
        if (!invite)
            throw new Error('Convite não encontrado.');
        if (invite.status !== 'accepted')
            throw new Error('O convite precisa ser aceito primeiro.');
        const message = (typeof payload.message === 'string' ? payload.message : '').trim().slice(0, 500);
        if (!message)
            throw new Error('Escreva a mensagem.');
        invite.messages.push(`Você: ${message}`);
        return { state, reply: 'Mensagem registrada na conversa da partida de teste.' };
    }
    if (action === 'rate_match') {
        const i = state.invites.find(i => i.id === payload.id);
        const n = Number(payload.rating);
        if (!i || !i.gameId || !state.games.find(g => g.id === i.gameId && g.status === 'played') || !Number.isFinite(n) || n < 1 || n > 5)
            throw new Error('Conclua a partida e escolha uma nota de 1 a 5.');
        i.rating = n;
        return { state, reply: 'Avaliação da partida de teste salva.' };
    }
    if (action !== 'complete')
        throw new Error('Ação desconhecida.');
    const draft = payload.draft;
    if (!draft?.id || !draft.flow)
        throw new Error('Pedido incompleto.');
    if (state.processed.includes(draft.id))
        return { state, reply: 'Essa confirmação já foi salva. Nenhum registro foi duplicado.' };
    const errors = (0, workflows_1.validateDraft)(draft);
    if (errors.length)
        throw new Error(`Falta conferir: ${errors.join('; ')}`);
    const v = draft.values;
    let reply = '';
    let recordId;
    if ((0, products_1.getProduct)(draft.flow)) {
        if (draft.flow === 'personalizada' && v.scope_verified !== 'yes')
            throw new Error('O pedido personalizado precisa ser identificado como imagem esportiva pelo assistente antes de confirmar.');
        const playerLines = lines(v.players);
        const many = ['jogador_escudo', 'contratacao'].includes(draft.flow) && playerLines.length > 1;
        const photos = draft.files.filter(f => f.field === 'player_photos');
        const created = draft.flow === 'contratacao' ? (0, contract_players_1.contractPlayers)(v).map((player, i) => createOrder(state, { ...draft, values: { ...v, players: `${player.name} | ${player.position}`, announcement: player.announcement, jersey_requested: player.jersey }, files: [...draft.files.filter(f => f.field !== 'player_photos' && (f.field !== 'jersey_reference' || player.jersey === 'Sim')), photos[i]] })) : many ? playerLines.map((line, i) => createOrder(state, { ...draft, values: { ...v, players: line }, files: [...draft.files.filter(f => f.field !== 'player_photos'), photos[i]] })) : [createOrder(state, draft)];
        const order = created[0];
        recordId = order.id;
        reply = order.status === 'review' ? `Pedido personalizado ${order.id} salvo para análise, com prompt adaptado. Sem cobrança. Você pode gerar uma prévia de teste abaixo.` : `Pedido de teste ${order.id} salvo com ${order.files.length} anexo(s) e prompt de ${order.values.sport}. ${order.funding === 'test_plan' ? `${order.units} crédito(s) de teste reservado(s).` : 'Pix avulso apenas simulado, sem cobrança.'} Você pode gerar a prévia abaixo.`;
        if (many)
            reply = `${created.length} pedidos salvos, um para cada atleta com sua própria foto e prompt. Gere as prévias individualmente ou em lote abaixo. Pagamento somente simulado.`;
    }
    else
        switch (draft.flow) {
            case 'perfil':
                state.profile = { ...v, sport: v.sport === 'Outro esporte' ? v.other_sport : v.sport };
                state.profileFiles = [...draft.files];
                reply = 'Perfil salvo neste teste. Vou reutilizar seus dados e imagens nos próximos pedidos.';
                break;
            case 'elenco': {
                const entries = lines(v.athletes).map(l => l.split('|').map(s => s.trim()));
                if (new Set(entries.map(e => clean(e[0]))).size !== entries.length)
                    throw new Error('Há nomes duplicados. Diferencie os atletas antes de salvar.');
                if (entries.length > 30)
                    throw new Error('Use até 30 atletas neste teste.');
                const photos = draft.files.filter(f => f.field === 'athlete_photos');
                if (photos.length && photos.length !== entries.length)
                    throw new Error('Envie uma foto por atleta ou deixe todas para depois.');
                state.athletes = entries.map(([name, position = '', number = ''], i) => { const old = state.athletes.find(a => clean(a.name) === clean(name)); return { id: old?.id || id('atleta'), name, position, number, photo: photos[i] || old?.photo, ratings: old?.ratings || [] }; });
                reply = `Elenco salvo: ${state.athletes.length} atleta(s). As avaliações anteriores foram preservadas.`;
                break;
            }
            case 'escalacao_oficial': {
                if (!state.athletes.length)
                    throw new Error('Cadastre o elenco primeiro.');
                const names = lines(v.lineup).map(l => l.split('|')[0].trim());
                if (names.some(n => !state.athletes.some(a => clean(a.name) === clean(n))))
                    throw new Error('Use somente nomes que estão no elenco salvo.');
                if (new Set(names.map(clean)).size !== names.length)
                    throw new Error('Um atleta aparece mais de uma vez.');
                state.lineup = v.lineup;
                reply = 'Escalação oficial salva. Já pode ser usada na arte de escalação.';
                break;
            }
            case 'marcas': {
                const old = state.sponsors.find(s => clean(s.values.name) === clean(v.name));
                const sponsor = { id: old?.id || id('marca'), values: { ...v }, files: [...draft.files] };
                state.sponsors = state.sponsors.filter(s => s.id !== sponsor.id);
                state.sponsors.push(sponsor);
                reply = 'Patrocinador e logo salvos no perfil.';
                break;
            }
            case 'historico': {
                const g = { id: id('evento'), sport: v.sport === 'Outro esporte' ? v.other_sport : v.sport, name: v.name, date: (0, workflows_1.eventInstant)(v.date).toISOString(), venue: v.venue || '', competition: v.competition || '', status: 'scheduled', result: '', source: 'perfil' };
                state.games.push(g);
                recordId = g.id;
                reply = 'Evento salvo no histórico. Depois da data, vou perguntar o resultado.';
                break;
            }
            case 'registrar_resultado': {
                const game = state.games.find(g => g.id === draft.eventId);
                if (!game)
                    throw new Error('Evento não encontrado.');
                if (game.status === 'played')
                    throw new Error('Este evento já tem resultado confirmado.');
                if ((0, workflows_1.eventInstant)(game.date).getTime() > Date.now())
                    throw new Error('O evento está no futuro. Confira a data antes de registrar resultado.');
                game.status = 'played';
                game.result = v.result;
                recordId = game.id;
                reply = `Resultado confirmado e salvo no mesmo evento: ${game.name} — ${game.result}. Já pode criar a arte de Resultado.`;
                break;
            }
            case 'dirigente': {
                const entries = lines(v.games);
                if (entries.length > 40)
                    throw new Error('Use até 40 eventos por tabela.');
                for (const line of entries) {
                    const [name, date] = line.split('|').map(s => s.trim());
                    if (!name || !date || !Number.isFinite((0, workflows_1.eventInstant)(date).getTime()))
                        throw new Error(`Confira participantes e data: ${line}`);
                }
                for (const line of entries) {
                    const [name, date, competition = '', venue = ''] = line.split('|').map(s => s.trim());
                    state.games.push({ id: id('evento'), name, date: (0, workflows_1.eventInstant)(date).toISOString(), artType: { 'Próximo Jogo': 'proximo_jogo', 'Resultado do Jogo': 'resultado', 'Escalação': 'escalacao', 'Jogador + Escudo': 'jogador_escudo' }[v.art_type], competition, venue, sport: v.sport === 'Outro esporte' ? v.other_sport : v.sport, status: 'scheduled', result: '', source: 'dirigente' });
                }
                reply = `${entries.length} evento(s) extraído(s), conferido(s) e salvo(s). Use “Preparar arte” em cada evento para anexar seus escudos e fotos sem misturar partidas.`;
                break;
            }
            case 'amistoso': {
                if (!state.profile.name)
                    throw new Error('Salve o perfil da sua equipe primeiro.');
                if (!Number.isFinite(Number(v.radius)) || Number(v.radius) <= 0)
                    throw new Error('Informe uma distância maior que zero.');
                if ((0, workflows_1.eventInstant)(v.date).getTime() < Date.now())
                    throw new Error('Escolha uma data futura para o amistoso.');
                const sport = v.sport === 'Outro esporte' ? v.other_sport : v.sport;
                const invite = { id: id('convite'), opponent: `Equipe demonstrativa de ${sport}`, sport, city: v.city, date: (0, workflows_1.eventInstant)(v.date).toISOString(), venue: v.venue, status: 'invited', messages: [`Convite de teste: ${state.profile.name}, ${v.category}, ${v.home}, até ${v.radius} km.`] };
                state.invites.push(invite);
                recordId = invite.id;
                reply = `Convite local criado para ${invite.opponent}. Esse adversário é fictício; você pode simular a resposta para testar todo o fluxo.`;
                break;
            }
            case 'responder_convite': {
                const invite = state.invites.find(i => i.id === draft.eventId);
                if (!invite)
                    throw new Error('Convite não encontrado.');
                if (invite.status === 'accepted' || invite.status === 'declined')
                    throw new Error('Este convite já foi encerrado.');
                if (v.response === 'Contrapropor') {
                    if (!v.date || (0, workflows_1.eventInstant)(v.date).getTime() < Date.now())
                        throw new Error('Informe uma nova data futura.');
                    invite.date = (0, workflows_1.eventInstant)(v.date).toISOString();
                    invite.status = 'counterproposal';
                    reply = 'Contraproposta de teste salva. Você pode aceitar a nova data.';
                }
                else if (v.response === 'Recusar') {
                    invite.status = 'declined';
                    reply = 'Convite recusado na simulação.';
                }
                else {
                    invite.status = 'accepted';
                    const game = { id: id('evento'), name: `${state.profile.name} x ${invite.opponent}`, sport: invite.sport, date: invite.date, venue: invite.venue, competition: 'Amistoso de teste', status: 'scheduled', result: '', source: invite.id };
                    state.games.push(game);
                    invite.gameId = game.id;
                    reply = 'Aceite simulado e partida salva no histórico. A conversa desta partida está liberada.';
                }
                if (v.message)
                    invite.messages.push(`Adversário de teste: ${v.message}`);
                break;
            }
            case 'avaliar': {
                state.athletes = applyRatings(state, v.ratings).athletes;
                reply = 'Avaliações salvas. A divisão de equipes já usará as novas médias.';
                break;
            }
            case 'dividir': {
                const names = lines(v.present);
                const athletes = names.map(n => state.athletes.find(a => clean(a.name) === clean(n)));
                const n = Number(v.team_count);
                if (athletes.some(a => !a) || new Set(names.map(clean)).size !== names.length)
                    throw new Error('Use nomes do elenco, sem repetir atletas.');
                if (names.length < n)
                    throw new Error('Precisa haver pelo menos um atleta por equipe.');
                const teams = Array.from({ length: n }, () => ({ names: [], total: 0 }));
                const rated = athletes.map(a => ({ name: a.name, rating: a.ratings.length ? a.ratings.reduce((x, y) => x + y, 0) / a.ratings.length : 5 })).sort((a, b) => b.rating - a.rating);
                for (const athlete of rated) {
                    const team = [...teams].sort((a, b) => a.names.length - b.names.length || a.total - b.total)[0];
                    team.names.push(athlete.name);
                    team.total += athlete.rating;
                }
                reply = teams.map((t, i) => `Equipe ${i + 1}: ${t.names.join(', ')} (força ${t.total.toFixed(1)})`).join('\n') + '\nAtletas sem avaliação usam nota neutra 5.';
                break;
            }
            case 'planos':
                state.plan = { allowance: v.plan.includes('28,90') ? 2 : 1, price: v.plan.includes('28,90') ? 28.9 : 18.9, startedAt: new Date().toISOString(), usage: [] };
                reply = `Pix aprovado somente na simulação. Plano de teste ativado: ${state.plan.allowance} imagem(ns) por semana durante 30 dias, renovação manual e cotas não acumuláveis.`;
                break;
            case 'suporte': {
                const ticket = { id: id('suporte'), subject: `${v.subject}${v.details ? ' — ' + v.details : ''}${v.order_id ? ' | ' + v.order_id : ''}`, createdAt: new Date().toISOString(), files: [...draft.files] };
                state.tickets.push(ticket);
                recordId = ticket.id;
                reply = `Solicitação ${ticket.id} salva neste teste com ${ticket.files.length} anexo(s). Nenhuma mensagem foi enviada a uma pessoa.`;
                break;
            }
            default: throw new Error('Fluxo não disponível.');
        }
    state.processed.push(draft.id);
    state.processed = state.processed.slice(-500);
    state.draft = null;
    return { state, reply, recordId };
}
