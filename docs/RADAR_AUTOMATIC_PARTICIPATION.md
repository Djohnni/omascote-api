# Participação automática no Radar

Desde a migração `015_radar_automatic_participation.sql`, toda conta de time ativa no armazenamento legado usado por `POST /auth/login` participa do Radar automaticamente.

## Sincronização

- Cadastro automático, cadastro manual, login, login Google, resgate entre navegadores e finalização da conta reconciliam a identidade do Radar.
- A inicialização da API executa um backfill sequencial e idempotente de todas as contas ativas.
- A leitura do perfil do Radar também reconcilia a conta autenticada, sem exigir um segundo cadastro.
- Nome público e slug passam por proteção própria; telefone e login nunca são usados como nome público.
- Suspensão e saída explícita são preservadas. A preferência `radar_visible=false` também é preservada.

## Descoberta

A busca sem filtros inclui qualquer time ativo e visível. Instagram, cidade, escudo, termos, modalidade, categoria e agenda são melhorias opcionais. Só são excluídos o próprio time, suspensões, saídas, ocultação explícita e bloqueios bilaterais.

Filtros restringem resultados somente quando enviados. Time sem cidade aparece depois dos times com distância calculável. Convites recebem data, horário, modalidade, categoria e mando na própria proposta e não dependem de agenda anterior.

## Operação e rollback

`RADAR_AMISTOSOS_ENABLED=false` oculta a interface e faz a API falhar fechada sem apagar dados. A variável legada `RADAR_PILOT_ACCOUNT_ALLOWLIST` não participa mais da autorização e deve ficar removida. O rollback de código não deve remover a coluna `radar_visible`, tabelas nem auditoria append-only.

O backfill pode ser repetido: ele cria somente perfis ausentes e registra auditoria apenas quando houver criação ou alteração real.
