# Dividir Times MVP

Modulo de referencia para integrar o MVP "Dividir Times" na API do Meu Clube FC.

## Persistencia

Aplicar `schema.sql` no banco Postgres da API. Ele cria:

- `time_divisoes`: sessao de treino/jogo, token publico, status e resultado gerado.
- `time_divisao_presentes`: jogadores escolhidos pelo organizador com snapshot dos dados exibidos.
- `time_divisao_votos`: votos por ranking bruto, nome opcional do votante e hash do `voter_token`.

A restricao `unique(sessao_id, voter_token_hash)` bloqueia voto duplicado no MVP.

## Integracao na API

O arquivo `dividir-times.router.js` exporta uma factory. Exemplo:

```js
const { createDividirTimesRouter } = require("./backend-dividir-times/dividir-times.router");

app.use(createDividirTimesRouter({
  auth,
  db,
  getTimeId: (req) => req.user?.time_id,
  getUserId: (req) => req.user?.id
}));
```

O objeto `db` precisa expor `query(sql, params)` no padrao do `pg`.

## Endpoints

- `POST /me/time/divisoes`
  - Autenticado.
  - Body: `{ titulo, jogadores_presentes: ["..."] }`
  - Cria a sessao e retorna `share_token`.

- `GET /me/time/divisoes/:id`
  - Autenticado.
  - Retorna sessao, jogadores presentes, votos_count e resultado se existir.

- `POST /me/time/divisoes/:id/gerar-times`
  - Autenticado.
  - Calcula media por ranking e gera Time A/Time B.

- `GET /dividir-times/:token?voter_token=...`
  - Publico.
  - Retorna jogadores presentes e se o token local ja votou.

- `POST /dividir-times/:token/votos`
  - Publico.
  - Body: `{ voter_token, nome_votante, ranking: [{ jogador_id }] }`
  - Salva ranking bruto validando todos os presentes, sem repetidos.

## Regras do algoritmo

- Ranking por ordem, sem nota de 0 a 10.
- Com N jogadores, 1o recebe N pontos, 2o recebe N-1, ate o ultimo receber 1.
- A forca do jogador e a media dos pontos recebidos.
- A divisao testa combinacoes possiveis e escolhe a menor diferenca de soma.
- Com numero impar, permite diferenca de 1 jogador entre os times.

## Observacao

Este workspace nao contem o servidor real que hoje atende `/me/time/jogadores`. Por isso o modulo fica pronto para integrar no backend de producao, mas ainda precisa ser importado no repositorio/API que publica `https://api.omascote.com.br`.
