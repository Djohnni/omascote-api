const crypto = require("crypto");

function uuid(){
  return crypto.randomUUID();
}

function shareToken(){
  return crypto.randomBytes(24).toString("base64url");
}

function hashVoterToken(value){
  return crypto.createHash("sha256").update(String(value || "")).digest("hex");
}

function cleanText(value, max = 120){
  return String(value || "").trim().slice(0, max);
}

function normalizePlayer(player = {}){
  return {
    id: String(player.id || player.jogador_id || ""),
    nome: cleanText(player.nome || "Jogador", 80),
    apelido: cleanText(player.apelido || "", 60),
    numero: cleanText(player.numero || "", 12),
    posicao: cleanText(player.posicao || "", 40)
  };
}

function validateRanking(ranking, presentPlayers){
  const presentes = presentPlayers.map(player => String(player.id));
  const presentesSet = new Set(presentes);
  const lista = Array.isArray(ranking) ? ranking : [];

  if(lista.length !== presentes.length){
    throw new Error("O ranking precisa conter todos os jogadores presentes.");
  }

  const vistos = new Set();
  const normalizado = lista.map((item, index) => {
    const jogadorId = String(item?.jogador_id || item?.id || "");
    if(!presentesSet.has(jogadorId)){
      throw new Error("Ranking contem jogador que nao faz parte desta votacao.");
    }
    if(vistos.has(jogadorId)){
      throw new Error("Ranking contem jogador repetido.");
    }
    vistos.add(jogadorId);
    return {
      jogador_id: jogadorId,
      posicao: index + 1
    };
  });

  return normalizado;
}

function calculateScores(presentPlayers, votes){
  const n = presentPlayers.length;
  const totals = new Map(presentPlayers.map(player => [String(player.id), { soma:0, votos:0 }]));

  votes.forEach(vote => {
    const ranking = Array.isArray(vote.ranking) ? vote.ranking : vote.ranking_json || [];
    ranking.forEach((item, index) => {
      const jogadorId = String(item?.jogador_id || item?.id || "");
      const score = n - index;
      const atual = totals.get(jogadorId);
      if(atual){
        atual.soma += score;
        atual.votos += 1;
      }
    });
  });

  const fallback = n ? (n + 1) / 2 : 0;
  return Object.fromEntries(
    presentPlayers.map(player => {
      const id = String(player.id);
      const data = totals.get(id);
      const media = data?.votos ? data.soma / data.votos : fallback;
      return [id, Math.round(media * 100) / 100];
    })
  );
}

function normalizeComparisonText(value){
  return String(value || "")
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .trim();
}

function positionGroup(posicao){
  const text = normalizeComparisonText(posicao);
  if(!text) return "";

  if(/\b(goleiro|gol|keeper|guarda[\s-]?redes)\b/.test(text)) return "goleiro";
  if(/\b(zagueiro|zaga|defensor|defesa|lateral|beque|back)\b/.test(text)) return "defesa";
  if(/\b(meia|meio|volante|armador|central)\b/.test(text)) return "meio";
  if(/\b(atacante|ataque|ponta|centroavante|avante|ala)\b/.test(text)) return "ataque";

  return "";
}

function topPenalty(setA, rankedIndexes){
  const rules = [
    { size:2, weight:1000 },
    { size:4, weight:100 },
    { size:6, weight:50 }
  ];

  return rules.reduce((total, rule) => {
    if(rankedIndexes.length < rule.size) return total;

    const group = rankedIndexes.slice(0, rule.size);
    const countA = group.filter(index => setA.has(index)).length;
    const countB = rule.size - countA;
    const idealDiff = rule.size % 2;
    const excess = Math.max(0, Math.abs(countA - countB) - idealDiff);

    return total + excess * rule.weight;
  }, 0);
}

function positionPenalty(players, setA){
  const groups = new Map();

  players.forEach((player, index) => {
    const group = positionGroup(player?.posicao);
    if(!group) return;
    if(!groups.has(group)) groups.set(group, []);
    groups.get(group).push(index);
  });

  let penalty = 0;

  groups.forEach((indexes, group) => {
    if(indexes.length < 2) return;

    const countA = indexes.filter(index => setA.has(index)).length;
    const countB = indexes.length - countA;
    const idealDiff = indexes.length % 2;
    const excess = Math.max(0, Math.abs(countA - countB) - idealDiff);
    const weight = group === "goleiro" ? 20 : 4;

    penalty += excess * weight;
  });

  return penalty;
}

function quantityPenalty(totalPlayers, teamASize){
  const teamBSize = totalPlayers - teamASize;
  return Math.max(0, Math.abs(teamASize - teamBSize) - 1);
}

function chooseBalancedTeams(players, scores){
  const n = players.length;
  if(n < 2){
    throw new Error("Selecione pelo menos 2 jogadores.");
  }

  const targetSizes = [...new Set([Math.floor(n / 2), Math.ceil(n / 2)])].filter(Boolean);
  const values = players.map(player => Number(scores[player.id] || 0));
  const total = values.reduce((sum, value) => sum + value, 0);
  const rankedIndexes = players
    .map((player, index) => ({
      index,
      nome: normalizeComparisonText(player?.apelido || player?.nome || ""),
      score: values[index]
    }))
    .sort((a, b) => {
      if(b.score !== a.score) return b.score - a.score;
      return a.nome.localeCompare(b.nome);
    })
    .map(item => item.index);
  let best = null;

  function evaluate(indexes){
    const setA = new Set(indexes);
    const forcaA = indexes.reduce((sum, index) => sum + values[index], 0);
    const forcaB = total - forcaA;
    const diff = Math.abs(forcaA - forcaB);
    const penalidadeTop = topPenalty(setA, rankedIndexes);
    const penalidadePosicao = positionPenalty(players, setA);
    const penalidadeQuantidade = quantityPenalty(n, indexes.length);
    const scoreFinal = diff * 10 + penalidadeTop * 20 + penalidadePosicao * 5 + penalidadeQuantidade * 100;

    if(
      !best ||
      scoreFinal < best.scoreFinal ||
      scoreFinal === best.scoreFinal && diff < best.diff ||
      scoreFinal === best.scoreFinal && diff === best.diff && penalidadeTop < best.penalidadeTop ||
      scoreFinal === best.scoreFinal && diff === best.diff && penalidadeTop === best.penalidadeTop && penalidadePosicao < best.penalidadePosicao
    ){
      best = {
        indexes:setA,
        diff,
        forcaA,
        forcaB,
        scoreFinal,
        penalidadeTop,
        penalidadePosicao,
        penalidadeQuantidade
      };
    }
  }

  function combine(start, needed, picked){
    if(needed === 0){
      evaluate(picked);
      return;
    }
    for(let i = start; i <= n - needed; i += 1){
      picked.push(i);
      combine(i + 1, needed - 1, picked);
      picked.pop();
    }
  }

  if(n <= 24){
    targetSizes.forEach(size => combine(0, size, []));
  }else{
    // Fallback raro para listas muito grandes: distribui alternando por forca.
    const sorted = players
      .map((player, index) => ({ player, index, score:values[index] }))
      .sort((a, b) => b.score - a.score);
    const picked = [];
    let sumA = 0;
    let sumB = 0;
    sorted.forEach(item => {
      if((picked.length < Math.ceil(n / 2)) && (sumA <= sumB || (n - picked.length) <= Math.ceil(n / 2))){
        picked.push(item.index);
        sumA += item.score;
      }else{
        sumB += item.score;
      }
    });
    evaluate(picked);
  }

  const timeA = [];
  const timeB = [];
  players.forEach((player, index) => {
    if(best.indexes.has(index)) timeA.push(player);
    else timeB.push(player);
  });

  return {
    time_a: timeA,
    time_b: timeB,
    forca_a: Math.round(best.forcaA * 100) / 100,
    forca_b: Math.round(best.forcaB * 100) / 100,
    diferenca: Math.round(best.diff * 100) / 100
  };
}

function buildResult(session, votes){
  const players = (session.jogadores_presentes || []).map(normalizePlayer);
  if(!votes.length){
    throw new Error("Receba pelo menos 1 voto antes de gerar os times.");
  }
  const scores = calculateScores(players, votes);
  const teams = chooseBalancedTeams(players, scores);
  return {
    ...teams,
    scores,
    votos_count: votes.length,
    gerado_em: new Date().toISOString()
  };
}

function createDividirTimesRouter({ auth, db, getTimeId, getUserId }){
  if(!auth) throw new Error("auth middleware obrigatorio.");
  if(!db?.query) throw new Error("db.query obrigatorio.");

  const express = require("express");
  const router = express.Router();

  async function resolveTimeId(req){
    const timeId = await getTimeId?.(req);
    if(!timeId) throw new Error("Time nao encontrado para esta conta.");
    return String(timeId);
  }

  function resolveUserId(req){
    return String(getUserId?.(req) || req.user?.id || req.user?.user_id || "");
  }

  async function loadPlayers(timeId, ids){
    const uniqueIds = [...new Set((ids || []).map(id => String(id || "")).filter(Boolean))];
    if(uniqueIds.length < 2) throw new Error("Selecione pelo menos 2 jogadores presentes.");

    const result = await db.query(
      `select id, nome, apelido, numero, posicao
         from time_jogadores
        where time_id = $1
          and ativo is distinct from false
          and id = any($2::uuid[])`,
      [timeId, uniqueIds]
    );

    const players = (result.rows || []).map(normalizePlayer);
    if(players.length !== uniqueIds.length){
      throw new Error("Um ou mais jogadores selecionados nao existem no elenco ativo.");
    }
    return uniqueIds.map(id => players.find(player => player.id === id)).filter(Boolean);
  }

  async function loadSessionById(id, timeId){
    const sessionRes = await db.query(
      `select id, time_id, titulo, status, share_token, resultado_json, criado_em, atualizado_em
         from time_divisoes
        where id = $1 and time_id = $2`,
      [id, timeId]
    );
    const session = sessionRes.rows?.[0];
    if(!session) return null;
    return hydrateSession(session);
  }

  async function loadSessionByToken(token){
    const sessionRes = await db.query(
      `select id, time_id, titulo, status, share_token, resultado_json, criado_em, atualizado_em
         from time_divisoes
        where share_token = $1`,
      [token]
    );
    const session = sessionRes.rows?.[0];
    if(!session) return null;
    return hydrateSession(session);
  }

  async function hydrateSession(session){
    const playersRes = await db.query(
      `select jogador_id as id, nome_snapshot as nome, apelido_snapshot as apelido,
              numero_snapshot as numero, posicao_snapshot as posicao
         from time_divisao_presentes
        where sessao_id = $1
        order by ordem asc, nome_snapshot asc`,
      [session.id]
    );
    const votesRes = await db.query(
      `select count(*)::int as total from time_divisao_votos where sessao_id = $1`,
      [session.id]
    );
    return {
      id: session.id,
      time_id: session.time_id,
      titulo: session.titulo,
      status: session.status,
      share_token: session.share_token,
      jogadores_presentes: (playersRes.rows || []).map(normalizePlayer),
      votos_count: Number(votesRes.rows?.[0]?.total || 0),
      resultado: session.resultado_json || null,
      criado_em: session.criado_em,
      atualizado_em: session.atualizado_em
    };
  }

  async function loadVotes(sessionId){
    const votesRes = await db.query(
      `select ranking_json from time_divisao_votos where sessao_id = $1 order by criado_em asc`,
      [sessionId]
    );
    return (votesRes.rows || []).map(row => ({ ranking: row.ranking_json || [] }));
  }

  router.post("/me/time/divisoes", auth, async (req, res) => {
    try{
      const timeId = await resolveTimeId(req);
      const titulo = cleanText(req.body?.titulo || "Dividir Times", 90) || "Dividir Times";
      const players = await loadPlayers(timeId, req.body?.jogadores_presentes);
      const id = uuid();
      const token = shareToken();

      await db.query("begin");
      await db.query(
        `insert into time_divisoes (id, time_id, titulo, share_token, criado_por)
         values ($1, $2, $3, $4, $5)`,
        [id, timeId, titulo, token, resolveUserId(req) || null]
      );

      for(let index = 0; index < players.length; index += 1){
        const player = players[index];
        await db.query(
          `insert into time_divisao_presentes
             (sessao_id, jogador_id, nome_snapshot, apelido_snapshot, numero_snapshot, posicao_snapshot, ordem)
           values ($1, $2, $3, $4, $5, $6, $7)`,
          [id, player.id, player.nome, player.apelido, player.numero, player.posicao, index + 1]
        );
      }
      await db.query("commit");

      const sessao = await loadSessionById(id, timeId);
      res.json({ ok:true, sessao });
    }catch(err){
      try{ await db.query("rollback"); }catch(e){}
      res.status(400).json({ ok:false, error:err.message || "Nao foi possivel criar a votacao." });
    }
  });

  router.get("/me/time/divisoes/:id", auth, async (req, res) => {
    try{
      const timeId = await resolveTimeId(req);
      const sessao = await loadSessionById(req.params.id, timeId);
      if(!sessao) return res.status(404).json({ ok:false, error:"Votacao nao encontrada." });
      res.json({ ok:true, sessao, resultado:sessao.resultado || null });
    }catch(err){
      res.status(400).json({ ok:false, error:err.message || "Nao foi possivel carregar a votacao." });
    }
  });

  router.post("/me/time/divisoes/:id/gerar-times", auth, async (req, res) => {
    try{
      const timeId = await resolveTimeId(req);
      const sessao = await loadSessionById(req.params.id, timeId);
      if(!sessao) return res.status(404).json({ ok:false, error:"Votacao nao encontrada." });
      const votos = await loadVotes(sessao.id);
      const resultado = buildResult(sessao, votos);

      await db.query(
        `update time_divisoes
            set resultado_json = $2,
                atualizado_em = now()
          where id = $1`,
        [sessao.id, JSON.stringify(resultado)]
      );

      const atualizada = await loadSessionById(sessao.id, timeId);
      res.json({ ok:true, sessao:atualizada, resultado });
    }catch(err){
      res.status(400).json({ ok:false, error:err.message || "Nao foi possivel gerar os times." });
    }
  });

  router.get("/dividir-times/:token", async (req, res) => {
    try{
      const sessao = await loadSessionByToken(req.params.token);
      if(!sessao) return res.status(404).json({ ok:false, error:"Votacao nao encontrada." });
      const voterToken = cleanText(req.query?.voter_token || "", 200);
      let jaVotou = false;

      if(voterToken){
        const voteRes = await db.query(
          `select 1 from time_divisao_votos where sessao_id = $1 and voter_token_hash = $2 limit 1`,
          [sessao.id, hashVoterToken(voterToken)]
        );
        jaVotou = !!voteRes.rows?.length;
      }

      res.json({
        ok:true,
        sessao:{
          id:sessao.id,
          titulo:sessao.titulo,
          status:sessao.status,
          jogadores_presentes:sessao.jogadores_presentes
        },
        ja_votou:jaVotou
      });
    }catch(err){
      res.status(400).json({ ok:false, error:err.message || "Nao foi possivel carregar a votacao." });
    }
  });

  router.post("/dividir-times/:token/votos", async (req, res) => {
    try{
      const sessao = await loadSessionByToken(req.params.token);
      if(!sessao) return res.status(404).json({ ok:false, error:"Votacao nao encontrada." });
      if(sessao.status !== "aberta") throw new Error("Esta votacao nao esta aberta.");

      const voterToken = cleanText(req.body?.voter_token || "", 200);
      if(!voterToken) throw new Error("Token do votante ausente.");

      const ranking = validateRanking(req.body?.ranking, sessao.jogadores_presentes);
      const nomeVotante = cleanText(req.body?.nome_votante || "", 80);

      await db.query(
        `insert into time_divisao_votos (id, sessao_id, voter_token_hash, nome_votante, ranking_json)
         values ($1, $2, $3, $4, $5)`,
        [uuid(), sessao.id, hashVoterToken(voterToken), nomeVotante || null, JSON.stringify(ranking)]
      );

      res.json({ ok:true });
    }catch(err){
      const duplicate = err.code === "23505" || /duplicate|unique/i.test(String(err.message || ""));
      res.status(duplicate ? 409 : 400).json({
        ok:false,
        error: duplicate ? "Este aparelho ja votou nesta sessao." : (err.message || "Nao foi possivel salvar o voto.")
      });
    }
  });

  return router;
}

module.exports = {
  createDividirTimesRouter,
  validateRanking,
  calculateScores,
  chooseBalancedTeams,
  buildResult,
  hashVoterToken
};
