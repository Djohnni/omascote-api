# Radar real no Meu Clube FC

O modo real é iniciado somente pelo botão **Encontrar amistoso** dentro do perfil autenticado. O botão começa oculto e aparece apenas quando `GET /me/time/radar/elegibilidade` responde com sucesso. Parâmetros de URL não ativam o Radar.

O demonstrador continua separado em `radar-amistosos/demo.html?demo=1`. Ele usa dados fictícios, bloqueia rede pela CSP e exibe “Demonstração local”.

## Configuração da API

O `app.html` usa a meta `omascote-api-base`, cujo valor publicado permanece `https://api.omascote.com.br`. Não existe `localhost` fixo no código de produção.

Para a prévia real local, execute o servidor local com:

- `OMASCOTE_LOCAL_API_BASE`: origem HTTP local da API.
- `RADAR_LOCAL_PREVIEW_PORT`: porta opcional da prévia.

O servidor de prévia substitui a meta apenas na resposta em memória e marca o ambiente como `local-real`; ele não altera o arquivo publicado.

## Contratos

`radar-api.js` centraliza autenticação Bearer, `Idempotency-Key`, `ETag`/`If-Match`, cursores, `Cache-Control: no-store`, tempo limite e erros públicos. O modo real não persiste dados do Radar no `localStorage`; somente reutiliza `omascote_token`, que já pertence à autenticação existente do site.

Os eventos `radar:api-trace` contêm somente método, caminho, status, ETag e duração. Token, corpo, contato e descrição privada nunca entram na prova.

## Acessibilidade e TWA

O Radar real abre como diálogo modal nomeado, mantém o foco dentro dele, aceita `Esc`, devolve o foco ao botão de entrada e sinaliza carregamento. Formulários movem o foco para o primeiro campo e todos os controles permanecem utilizáveis por teclado.

O aplicativo Android continua apontando para `https://omascote.com.br/app.html?omascote_app=1`, e seus filtros aceitam `/app.html`. Como o Radar está integrado nesse mesmo arquivo, não existe rota nova ou mudança Android necessária. Staging deve usar navegador/PWA ou uma TWA de staging separada; não altere a TWA oficial para validar o candidato.

## Verificação local

Execute `node --test radar-amistosos/test-radar-api.js radar-amistosos/test-release-candidate.js`. Depois abra `app.html` pelo servidor de prévia, entre com uma conta local e abra o perfil. O selo `LOCAL REAL · dados da API` diferencia esta integração do demonstrador.
