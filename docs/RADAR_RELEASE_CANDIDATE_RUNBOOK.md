# Radar de Amistosos — release candidate

Este runbook prepara **staging somente**. Ele não autoriza push, deploy, alteração no banco oficial ou ativação de contas reais.

## Gate antes do staging

1. Use o commit candidato e confirme que ele descende do commit aprovado e de `origin/main`.
2. Crie um PostgreSQL gerenciado vazio, exclusivo do staging, com TLS e validação de certificado.
3. Cadastre as variáveis da seção seguinte no cofre do provedor, com valores diferentes por finalidade.
4. Mantenha todas as flags `false` e execute `npm run radar:staging:preflight`.
5. Faça backup do banco vazio, execute `npm run db:migrate` duas vezes e confirme 14 migrações na prontidão.
6. Inicie API e frontend de staging; valide CORS, proxy, health, métricas e retenção antes de autorizar o piloto.
7. Só depois de autorização separada, ligue a flag mestre e as flags funcionais; contas ativas participam automaticamente.

O preflight deve terminar com `ok: true`, zero flags ligadas, segredos separados, CORS HTTPS exclusivo de staging, proxy definido e metadados de commit/build.

## Variáveis sem valores

Infraestrutura: `NODE_ENV`, `PORT`, `PUBLIC_API_BASE_URL`, `DATABASE_URL`, `DATABASE_SSL`, `DATABASE_SSL_REJECT_UNAUTHORIZED`, `DATABASE_CONNECTION_TIMEOUT_MS`, `COMMIT_SHA`, `RELEASE_VERSION`.

Autenticação e rede: `JWT_SECRET`, `OMASCOTE_CORS_INCLUDE_PRODUCTION_ORIGINS`, `OMASCOTE_CORS_ORIGINS`, `RADAR_TRUST_PROXY_HOPS`.

Participação e flags: `RADAR_AMISTOSOS_ENABLED`, `RADAR_SEARCH_ENABLED`, `RADAR_INVITATIONS_ENABLED`, `RADAR_MATCH_CENTER_ENABLED`, `RADAR_MATCH_RESULTS_ENABLED`, `RADAR_MATCH_HISTORY_ENABLED`, `RADAR_REPUTATION_ENABLED`, `RADAR_MODERATION_ENABLED`, `RADAR_PROFILE_PRINT_IMPORT_ENABLED`, `RADAR_MODERATION_SLA_HOURS`. Contas ativas participam automaticamente; município não limita acesso.

Segredos exclusivos: `RADAR_INSTAGRAM_VERIFICATION_SECRET`, `RADAR_SEARCH_CURSOR_SECRET`, `RADAR_SEARCH_RATE_LIMIT_SECRET`, `RADAR_INVITATIONS_SECURITY_SECRET`, `RADAR_MATCH_RESULTS_SECURITY_SECRET`, `RADAR_MATCH_HISTORY_CURSOR_SECRET`, `RADAR_MATCH_HISTORY_RATE_LIMIT_SECRET`, `RADAR_REPUTATION_SECURITY_SECRET`, `RADAR_MODERATION_SECURITY_SECRET`, `RADAR_METRICS_TOKEN`.

Observabilidade e retenção: `RADAR_METRICS_ENABLED`, `RADAR_TECHNICAL_RETENTION_DAYS`, `RADAR_RETENTION_BATCH_MAXIMUM`.

IA optativa e desligada por padrão: `OPENAI_API_KEY`, `RADAR_PROFILE_PRINT_OPENAI_MODEL`, `RADAR_PROFILE_PRINT_REASONING_EFFORT`, `RADAR_PROFILE_PRINT_SECURITY_SECRET`, `RADAR_PROFILE_PRINT_SAFETY_IDENTIFIER_SECRET`, `RADAR_PROFILE_PRINT_DAILY_TEAM_LIMIT`, `RADAR_PROFILE_PRINT_MONTHLY_GLOBAL_LIMIT`.

WhatsApp optativo: `RADAR_WHATSAPP_ENCRYPTION_KEYS`, `RADAR_WHATSAPP_ACTIVE_KEY_VERSION`, `RADAR_WHATSAPP_RATE_LIMIT_SECRET`. Configure valores exclusivos no cofre e deixe a visibilidade desligada por padrão.

## Banco e migrações

As migrações 001–014 são incrementais e a 014 é o requisito atual. A segunda execução deve aplicar zero arquivos. O readiness precisa informar `applied: 14`, `latest: 014_radar_smart_onboarding` e `required: 014_radar_smart_onboarding` antes da ativação.

Não faça downgrade destrutivo. Para rollback operacional, desligue `RADAR_AMISTOSOS_ENABLED`, preserve o schema e a auditoria, volte para um commit compatível e corrija schema apenas por migração compensatória 014 ou posterior.

## CORS, proxy e IP

Staging aceita somente a origem HTTPS exata do frontend de staging. Não use curinga e não inclua automaticamente o domínio de produção. Configure `RADAR_TRUST_PROXY_HOPS` com a quantidade observada na cadeia do provedor; valide com requisições por conexão direta bloqueada e pela borda permitida. Rate limits usam o IP calculado pelo Express, nunca o primeiro valor bruto de `X-Forwarded-For`.

## Métricas, logs e alertas

Colete `/internal/radar/metrics` por HTTPS com Bearer exclusivo do coletor. Não compartilhe esse token com JWT ou demais segredos. Preserve `X-Request-Id` entre proxy e API.

Dashboards mínimos: taxa e p95 de busca, convite, aceite, partida, placar, denúncia e moderação; 4xx/5xx por operação; consultas, erros, duração e concorrência do banco; fila de moderação aberta e idade do caso mais antigo.

Alertas iniciais: banco/readiness por 2 minutos; 5xx acima de 2% por 5 minutos; p95 acima de 1,5 s por 10 minutos; qualquer erro de banco; 429, conflito ou denúncia acima do padrão; caso fora do SLA; retenção sem execução ou com duas falhas consecutivas.

## Retenção automática

Agende `npm run radar:retention` a cada hora em processo separado. O advisory lock impede dois trabalhos simultâneos; cada execução é idempotente e limitada por lote. O processo expira disponibilidades, convites e provas vencidas, remove descrições privadas após retenção e limpa somente limites técnicos antigos. A auditoria append-only nunca é apagada.

Registre estado de saída e duração do job no agendador. Repetir a execução sem novos vencimentos deve produzir zero alterações.

## Backup e restauração

Antes de migração ou ativação, gere backup lógico do PostgreSQL gerenciado com `pg_dump` em formato custom, TLS e credencial temporária somente de leitura quando suportada. Registre horário, commit, versão das migrações, tamanho, checksum e duração sem registrar URI ou senha.

Restaure com `pg_restore` em outro banco vazio e isolado. Confirme contagens, relação de um convite aceito para uma partida, resultados oficiais, auditoria, migração 014 e `/health/ready`. Execute login, elegibilidade, busca e leitura de partida no banco restaurado. Destrua o banco de ensaio conforme a política do staging somente depois de guardar o relatório.

O comando `npm run radar:backup:verify` é a prova local com PGlite e recusa `NODE_ENV=production`, `DATABASE_URL` externa e caminhos fora de `dados`.

## Carga e segurança

`npm run radar:load` cria um banco isolado e simula 30 times, disponibilidades, buscas, convites, aceites concorrentes, partidas, placares, paginação, denúncias e moderação. O script recusa produção e qualquer `DATABASE_URL`. Repita a mesma carga no PostgreSQL gerenciado de staging antes de considerar produção.

Validações obrigatórias: sessão expirada; conta inativa; conta suspensa; acesso cruzado; IDs adulterados; cursor adulterado; `Idempotency-Key`; `ETag`/`If-Match`; cliques concorrentes; autoaceite/autoverificação; papel administrativo; CORS; IP atrás do proxy; limite de upload; e busca por credenciais em arquivos versionados.

## Ativação e saída

Ative primeiro a flag mestre e depois as flags funcionais. Acompanhe erros, latência, backfill e fila. Para desligar, desative imediatamente `RADAR_AMISTOSOS_ENABLED`; o frontend oculta a entrada e a API falha fechada sem remover dados.

OpenAI continua fora do caminho crítico. Perfil, elegibilidade, disponibilidade e todo o fluxo do Radar funcionam manualmente sem chave ou chamada externa.
