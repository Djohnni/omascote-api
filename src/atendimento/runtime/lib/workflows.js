// Atendimento runtime restored from the existing O Mascote application.
"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.NO_PHOTO_MODES = exports.titleFor = exports.newState = exports.FLOW_IDS = exports.SERVICE_IDS = exports.SERVICES = void 0;
exports.fieldsFor = fieldsFor;
exports.initialValues = initialValues;
exports.validateDraft = validateDraft;
exports.eventInstant = eventInstant;
exports.localEventDate = localEventDate;
exports.planRemaining = planRemaining;
const products_1 = require("./products");
const product_questions_1 = require("./product-questions");
const sports_1 = require("./sports");
const match_fields_1 = require("./match-fields");
const contract_players_1 = require("./contract-players");
exports.SERVICES = [
    { id: 'perfil', name: 'Perfil do time ou atleta' }, { id: 'elenco', name: 'Elenco e atletas' },
    { id: 'escalacao_oficial', name: 'Escalação oficial' }, { id: 'marcas', name: 'Cadastrar patrocinadores' },
    { id: 'historico', name: 'Jogos e histórico' }, { id: 'galeria', name: 'Galeria de artes' },
    { id: 'dirigente', name: 'Identificar jogos pela foto' }, { id: 'amistoso', name: 'Encontrar amistoso' },
    { id: 'avaliar', name: 'Avaliar atletas' }, { id: 'dividir', name: 'Dividir times' },
    { id: 'ranking', name: 'Ranking e estatísticas' }, { id: 'pedidos', name: 'Meus pedidos' },
    { id: 'planos', name: 'Planos e Pix' }, { id: 'suporte', name: 'Suporte' },
];
exports.SERVICE_IDS = exports.SERVICES.map(s => s.id);
exports.FLOW_IDS = [...products_1.PRODUCTS.map(p => p.id), ...exports.SERVICE_IDS, 'registrar_resultado', 'responder_convite'];
const newState = () => ({ version: 1, profile: {}, profileFiles: [], athletes: [], lineup: '', sponsors: [], games: [], orders: [], invites: [], tickets: [], shareLinks: [], shareVotes: [], plan: null, draft: null, chat: [], processed: [], conversationId: '', conversationStartedAt: '', conversationStarts: [], conversations: [], chatRevision: 0, draftRevision: 0 });
exports.newState = newState;
const titleFor = (id) => (0, products_1.getProduct)(id)?.name ?? exports.SERVICES.find(s => s.id === id)?.name ?? ({ registrar_resultado: 'Registrar resultado', responder_convite: 'Responder convite de teste' }[id] || id);
exports.titleFor = titleFor;
const text = (key, label, required = false, hint) => ({ key, label, required, type: 'text', hint });
const area = (key, label, required = false, hint) => ({ key, label, required, type: 'textarea', hint });
const images = (key, label, required = false, maxFiles = 1) => ({ key, label, required, type: 'images', maxFiles });
const sportField = { key: 'sport', label: 'Qual é o esporte?', type: 'select', options: sports_1.SPORTS, required: true };
const selectedSport = (values) => values.sport === 'Outro esporte' ? values.other_sport || values.sport : values.sport;
exports.NO_PHOTO_MODES = ['Sem foto', 'Só escudos', 'Só símbolos/logos'];
function fieldsFor(flow, values = {}) {
    const sport = values.sport || '';
    const effectiveSport = selectedSport(values);
    // Until the sport is answered, show the site's original fields, not an invented generic form.
    const context = (0, sports_1.sportContext)(effectiveSport || 'Futebol');
    const sportFields = [sportField];
    if (sport === 'Outro esporte')
        sportFields.push(text('other_sport', 'Qual modalidade?', true));
    if (sport && !sports_1.SPORTS.includes(sport) || sport === 'Outro esporte')
        sportFields.push(text('sport_context', 'Como são o local e os equipamentos dessa modalidade?', true));
    if ((0, products_1.getProduct)(flow)) {
        const questions = product_questions_1.PRODUCT_QUESTIONS[flow];
        const adapted = [];
        for (const q of questions) {
            if (['proximo_jogo_jogador', 'resultado_jogo_jogador'].includes(flow) && ['photo_mode', 'match_photo'].includes(q.key))
                continue;
            if (q.key === 'match_photo' && exports.NO_PHOTO_MODES.includes(values.photo_mode))
                continue;
            if (q.showWhen && ((q.showWhen.equals !== undefined && values[q.showWhen.key] !== q.showWhen.equals) || (q.showWhen.notEquals !== undefined && (!values[q.showWhen.key] || values[q.showWhen.key] === q.showWhen.notEquals))))
                continue;
            if (q.key === 'jersey_reference' && !(0, contract_players_1.contractPlayers)(values).some(p => p.jersey === 'Sim'))
                continue;
            if (q.key === 'scorers' && context.result !== 'gols')
                continue;
            if (q.key === 'coupon_code') {
                adapted.push(text(q.key, 'Tem um cupom?', false, 'Opcional. Neste teste o código fica salvo, mas não é validado e não altera o preço.'));
                continue;
            }
            let label = !sport || sport === 'Futebol' ? q.label : q.label.replace(/do time/gi, 'da equipe').replace(/o time/gi, 'a equipe').replace(/jogadores/gi, 'atletas').replace(/jogador/gi, 'atleta').replace(/artilheiros/gi, 'marcadores').replace(/time/gi, 'equipe');
            if (context.individual && /crest/.test(q.key))
                label = /away|opponent/.test(q.key) ? 'Quer enviar o símbolo ou logo do outro participante?' : 'Quer enviar o símbolo, logo ou escudo do participante?';
            let f = { key: q.key, label, type: 'text', required: q.required, defaultValue: q.defaultValue, hint: q.helper, placeholder: q.placeholder };
            if (q.type === 'matchup')
                f = context.individual ? text(q.key, 'Quem participa e qual é o evento?', true, 'Adversário não é obrigatório nesta modalidade.') : { key: q.key, label: q.label, type: 'matchup', required: true };
            else if (q.type === 'score')
                f = !context.individual && ['gols', 'pontos'].includes(context.result) ? { key: q.key, label: q.label, type: 'score', required: true } : text(q.key, `Qual foi o resultado (${context.result})?`, true, 'Informe os participantes e o resultado exato, sem completar informações que não tem.');
            else if (q.type === 'players') {
                f = area(q.key, q.playerMode === 'scorers' ? 'Quem marcou e quanto?' : 'Quais atletas vão aparecer?', q.required, q.playerMode === 'lineup' ? 'Uma linha por atleta: nome | posição (opcional). Não precisa informar número.' : q.playerMode === 'contract' ? 'Uma linha por atleta: nome | posição | Contratado ou Renovado | Sim ou Não para camiseta. Fotos na mesma ordem dos nomes.' : q.playerMode === 'scorers' ? 'Uma linha por atleta: nome | quantidade.' : 'Uma linha por atleta: nome | posição ou categoria | número (opcional). Fotos na mesma ordem dos nomes.');
                adapted.push(f);
                if (q.playerMode === 'player_card' || q.playerMode === 'contract')
                    adapted.push(images('player_photos', 'Envie uma foto de cada atleta, na ordem dos nomes', true, q.maxPlayers ?? 10));
                continue;
            }
            else if (q.type === 'file' || q.type === 'multi_file') {
                f = images(q.key, label, q.required, q.type === 'file' ? 1 : (q.maxFiles ?? 8));
                if (context.individual && /crest/.test(q.key) && !['escudo3d', 'mascote_uniforme', 'jogador_escudo', 'contratacao'].includes(flow))
                    f.required = false;
            }
            else if (q.type === 'choice') {
                f.type = 'select';
                f.options = [...(q.choices ?? [])];
            }
            else if (q.type === 'long_text')
                f.type = 'textarea';
            if (q.key === 'scenario_id' && sport && sport !== 'Futebol') {
                f.options = f.options?.filter(option => !option.startsWith('Estádio') && (option !== 'Futsal' || sport === 'Futsal'));
            }
            if (q.key === 'photo_mode') {
                f.options = context.individual ? ['Sem foto', 'Atleta', 'Equipe', 'Mascote'] : ['Sem foto', 'Jogador', 'Time', 'Mascote'];
                f.defaultValue = 'Sem foto';
                f.required = false;
            }
            if (q.key === 'match_photo')
                f.required = Boolean(values.photo_mode && !exports.NO_PHOTO_MODES.includes(values.photo_mode));
            if (q.key === 'match_datetime') {
                f.type = 'text';
                f.placeholder = 'Ex.: Domingo • 15h30 ou 13/09/2026 às 15h30';
            }
            if (q.key === 'matchup' && context.individual)
                f.label = 'Quem participa e qual é o evento?';
            adapted.push(f);
        }
        // Photo choice/upload and visual style are grouped into their existing site sections.
        // Definitions remain available to validation and chat extraction.
        return [...sportFields, ...adapted];
    }
    const definitions = {
        perfil: [...sportFields, text('name', 'Qual é o nome da equipe ou atleta?', true), text('city', 'Qual é a cidade?', true), text('state', 'Qual é o estado/UF?', true), text('instagram', 'Qual é o Instagram?'), area('description', 'Como você apresentaria sua equipe?'), images('crest', 'Envie seu escudo ou símbolo'), images('mascot', 'Quer guardar a imagem do mascote?'), { key: 'visibility', label: 'Como prefere o perfil?', type: 'select', options: ['Privado', 'Página de teste compartilhável'], defaultValue: 'Privado' }],
        elenco: [area('athletes', 'Quem faz parte da equipe?', true, 'Uma linha por atleta: nome | posição/categoria | número. O cadastro mantém as avaliações dos nomes já existentes.'), images('athlete_photos', 'Quer guardar as fotos na ordem dos nomes?', false, 30)],
        escalacao_oficial: [area('lineup', 'Quem são os titulares e reservas?', true, 'Uma linha por atleta: nome | titular ou reserva | posição. Use os nomes do elenco salvo.')],
        marcas: [text('name', 'Qual é o nome do patrocinador?', true), text('instagram', 'Instagram'), text('site', 'Site'), images('logo', 'Envie a logo', true), { key: 'active', label: 'Está ativo?', type: 'select', options: ['Sim', 'Não'], defaultValue: 'Sim' }],
        historico: [...sportFields, text('name', 'Qual é a partida, prova ou competição?', true), { key: 'date', label: 'Qual a data e horário?', type: 'datetime-local', required: true }, text('competition', 'Qual a competição?'), text('venue', 'Qual o local?')],
        registrar_resultado: [text('result', `Como terminou? Informe ${context.result}.`, true, 'O resultado será associado ao evento exibido, após sua confirmação.')],
        dirigente: [...sportFields, area('games', 'Quais são os eventos?', true, 'Uma linha por evento: participantes | AAAA-MM-DD HH:mm | competição | local. Você também pode mandar vários prints para preencher.'), { key: 'art_type', label: 'Qual arte preparar para os eventos?', type: 'select', options: ['Próximo Jogo', 'Resultado do Jogo', 'Escalação', 'Jogador + Escudo'], defaultValue: 'Próximo Jogo' }, images('schedule_prints', 'Enviar tabelas ou prints para leitura', false, 6)],
        amistoso: [...sportFields, text('city', 'Em qual cidade?', true), text('category', 'Qual categoria?', true), { key: 'date', label: 'Qual data e horário?', type: 'datetime-local', required: true }, text('venue', 'Onde pode jogar?', true), text('radius', 'Distância máxima em km', true), { key: 'home', label: 'Mando de jogo', type: 'select', options: ['Em casa', 'Fora', 'Tanto faz'], defaultValue: 'Tanto faz' }],
        responder_convite: [{ key: 'response', label: 'Simular resposta do adversário', type: 'select', options: ['Aceitar', 'Contrapropor', 'Recusar'], required: true }, { key: 'date', label: 'Nova data, se contrapropuser', type: 'datetime-local' }, text('message', 'Mensagem de teste')],
        avaliar: [area('ratings', 'Quais notas de 0 a 10 você dá aos atletas?', true, 'Uma linha: nome do elenco | nota. A média considera as avaliações salvas.')],
        dividir: [area('present', 'Quem está presente?', true, 'Um nome do elenco por linha.'), { key: 'team_count', label: 'Quantas equipes?', type: 'select', options: ['2', '3', '4'], defaultValue: '2', required: true }],
        planos: [{ key: 'plan', label: 'Qual plano quer experimentar?', type: 'select', options: ['R$ 18,90 — 1 imagem por semana', 'R$ 28,90 — 2 imagens por semana'], required: true }, { key: 'payment', label: 'Pagamento neste teste', type: 'select', options: ['Simular Pix aprovado'], required: true, hint: 'Simulação local. Não gera cobrança nem confirma pagamento real.' }],
        suporte: [text('subject', 'Com o que você precisa de ajuda?', true), text('order_id', 'Tem o número de um pedido?'), area('details', 'Quer explicar ou enviar algum detalhe?'), images('support_images', 'Anexar prints', false, 3)],
    };
    return definitions[flow] ?? [];
}
function initialValues(flow, state) {
    const base = { sport: (0, products_1.getProduct)(flow) ? '' : state.profile.sport || '' };
    if (flow === 'perfil')
        Object.assign(base, state.profile);
    if (flow === 'elenco')
        base.athletes = state.athletes.map(a => `${a.name} | ${a.position} | ${a.number}`).join('\n');
    if (flow === 'escalacao_oficial')
        base.lineup = state.lineup || state.athletes.map(a => `${a.name} | titular | ${a.position}`).join('\n');
    if (flow === 'escalacao')
        base.players = state.lineup || state.athletes.map(a => `${a.name} | ${a.position}`).join('\n');
    if (flow === 'dividir')
        base.present = state.athletes.map(a => a.name).join('\n');
    if (flow === 'avaliar')
        base.ratings = state.athletes.map(a => `${a.name} | `).join('\n');
    if (flow === 'amistoso')
        base.city = state.profile.city || '';
    for (const f of fieldsFor(flow, base))
        if (f.defaultValue && !base[f.key])
            base[f.key] = f.defaultValue;
    return base;
}
function validateDraft(draft) {
    const errors = [];
    const fields = fieldsFor(draft.flow, draft.values);
    for (const f of fields) {
        const v = draft.values[f.key]?.trim();
        if (f.required && (f.type === 'images' ? !draft.files.some(a => a.field === f.key) : !v))
            errors.push(f.label);
        if (v && f.type === 'select' && f.options && !f.options.includes(v) && f.key !== 'sport' && !(f.key === 'photo_mode' && exports.NO_PHOTO_MODES.includes(v)))
            errors.push(`Escolha uma opção válida: ${f.label}`);
        if (v && f.type === 'datetime-local' && !Number.isFinite(new Date(v).getTime()))
            errors.push(`Confira a data: ${f.label}`);
        if (v && f.key === 'match_datetime' && !(0, match_fields_1.matchDateForDraft)(draft))
            errors.push('Não consegui entender a data e o horário. Escreva como você falaria, por exemplo: próximo domingo às 3 da tarde.');
        if (f.type === 'matchup' && v) {
            const pair = (0, match_fields_1.splitMatchup)(v);
            if (!pair.home.trim() || !pair.away.trim())
                errors.push('Informe os dois participantes do confronto.');
        }
        if (f.type === 'score' && v) {
            const score = (0, match_fields_1.splitScore)(draft.values[f.key]);
            if (!score.unparsed && (!score.home.trim() || !score.away.trim() || !/^\d+$/.test(score.homeScore) || !/^\d+$/.test(score.awayScore)))
                errors.push('Confira os dois times e os dois valores do placar.');
        }
    }
    if (draft.flow === 'contratacao' || draft.flow === 'jogador_escudo') {
        const n = (draft.values.players || '').split('\n').filter(l => l.trim()).length;
        if (n > 10)
            errors.push('O limite é 10 atletas por pedido.');
        if (draft.files.filter(f => f.field === 'player_photos').length !== n)
            errors.push('Envie uma foto para cada atleta, na ordem dos nomes.');
    }
    if (draft.flow === 'contratacao' && (draft.values.players || '').split('\n').filter(l => l.trim()).some(l => !l.split('|')[1]?.trim()))
        errors.push('Informe nome e posição/categoria de cada atleta.');
    if (draft.flow === 'escalacao' && !(0, sports_1.sportContext)(selectedSport(draft.values) || '').individual && (draft.values.players || '').split('\n').filter(l => l.trim()).length < 2)
        errors.push('Informe pelo menos dois atletas na escalação.');
    if (draft.values.sport === 'Outro esporte' && !draft.values.other_sport?.trim())
        errors.push('Informe o nome da modalidade.');
    return [...new Set(errors)];
}
function eventInstant(value) { return new Date(/(Z|[+-]\d\d:\d\d)$/.test(value) ? value : `${value.replace(' ', 'T')}-03:00`); }
function localEventDate(value) { const date = eventInstant(value); if (!Number.isFinite(date.getTime()))
    return value; return new Intl.DateTimeFormat('sv-SE', { timeZone: 'America/Sao_Paulo', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hour12: false }).format(date).replace(' ', 'T'); }
function planRemaining(state, now = new Date()) {
    if (!state.plan)
        return 0;
    const elapsed = now.getTime() - new Date(state.plan.startedAt).getTime();
    if (elapsed < 0 || elapsed >= 30 * 86400000)
        return 0;
    const week = Math.min(3, Math.floor(elapsed / (7 * 86400000)));
    const used = state.plan.usage.filter(u => Math.min(3, Math.floor((new Date(u.at).getTime() - new Date(state.plan.startedAt).getTime()) / (7 * 86400000))) === week).reduce((n, u) => n + u.count, 0);
    return Math.max(0, state.plan.allowance - used);
}
