# Radar — validação do candidato

## Gate visual e funcional

- Entrada oculta sem sessão, com flag desligada, conta fora da allowlist ou API indisponível.
- Nenhum parâmetro de URL ativa o recurso.
- Modo real usa autenticação existente e dados da API; `localStorage` não armazena dados do Radar.
- Demonstrador permanece em `radar-amistosos/demo.html?demo=1`, identificado e sem rede.
- API de produção vem da meta do `app.html`; a origem local é substituída apenas em memória pelo servidor de prévia.
- `Idempotency-Key`, cursor, `ETag`, `If-Match`, 401, 403, 409/412 e indisponibilidade permanecem tratados pelo cliente.
- Uma única ação principal, títulos curtos, chips e detalhes compactos são preservados.

## Tamanhos

Validar 360, 390, 640, 820, 1024 e 1366 px. Em todos: sem rolagem horizontal, ação principal visível, campos legíveis, diálogo dentro da viewport, foco visível e botão voltar funcional.

## Teclado e leitor

Abra pelo botão “Encontrar amistoso”, percorra todos os controles com `Tab`/`Shift+Tab`, abra um formulário, use `Esc` para voltar e feche o Radar. O foco deve retornar ao mesmo botão. O diálogo precisa ter título acessível, `aria-busy` durante carregamento e região viva para mudanças de tela.

## Falhas seguras

- Sessão expirada: mostrar estado seguro sem dados anteriores.
- API indisponível: tentativa novamente, sem liberar a entrada para nova sessão.
- Versão conflitante: não repetir mutação com dados antigos; recarregar o recurso.
- Conta fora do piloto: manter a entrada invisível.
- Contato: aparecer somente dentro de uma partida aceita e nunca nos eventos `radar:api-trace`.

## TWA Android

Confirmar, sem editar o projeto Android, que `launch_url` aponta para `/app.html` no domínio oficial e que o `AndroidManifest.xml` aceita esse caminho HTTPS. O Radar não cria nova rota e herda o escopo existente. Uma eventual TWA de staging precisa de domínio e Digital Asset Links próprios; isso pertence à autorização de staging, não a este candidato local.
