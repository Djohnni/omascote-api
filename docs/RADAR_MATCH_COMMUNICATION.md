# Comunicação da partida

A migração `016_match_communication.sql` cria uma conversa única para cada partida já originada por convite aceito. Ela adiciona mensagens, marcadores de leitura, idempotência, limites persistentes e o vínculo opcional de uma mensagem denunciada com a fila de moderação existente.

## Ativação

O recurso nasce desligado. Ele requer simultaneamente:

- `RADAR_AMISTOSOS_ENABLED=true`;
- `RADAR_MATCH_COMMUNICATION_ENABLED=true`;
- `RADAR_MATCH_COMMUNICATION_SECURITY_SECRET` exclusivo, aleatório e com pelo menos 32 bytes.

O segredo protege cursores, escopos de limite, payloads idempotentes e a pseudonimização da conta na auditoria. Ele não deve ser reutilizado por JWT, busca, convites, WhatsApp ou moderação.

## Canais

`GET /me/time/amistosos/:matchId/comunicacao` é restrito aos dois participantes. A resposta ordena WhatsApp, Instagram e chat interno. O WhatsApp só é liberado quando o número criptografado é válido, o adversário autorizou sua exibição e não há bloqueio. O Instagram usa apenas o identificador público e informa o estado do selo; não há API, scraping ou login do Instagram. O chat interno permanece disponível quando os canais externos não existem.

## Privacidade

Mensagens têm no máximo 1000 caracteres, são armazenadas como texto simples e renderizadas como texto escapado. HTML, esquemas executáveis e links HTTP são recusados. Texto de mensagem nunca entra em logs, métricas, notificações ou auditoria. Auditoria guarda somente referências públicas e metadados. Uma mensagem só aparece para os participantes; o conteúdo chega à moderação somente depois de denúncia e somente pela rota administrativa já protegida por função ativa.

## Retenção

`RADAR_MATCH_COMMUNICATION_RETENTION_DAYS` define a retenção do conteúdo, com padrão de 365 dias. O processo agendável `npm run radar:retention` apaga somente o corpo expirado e mantém metadados e auditoria. Mensagens ligadas a casos abertos ou atribuídos não são apagadas até a decisão. O processo usa o mesmo bloqueio global de retenção, é idempotente e nunca exclui a auditoria obrigatória.

## Desativação e rollback

Desative somente `RADAR_MATCH_COMMUNICATION_ENABLED`. As rotas passam a responder 404 e as demais funções do Radar continuam ativas. Não remova a migração, não apague tabelas e não reescreva mensagens ou auditoria durante rollback.
