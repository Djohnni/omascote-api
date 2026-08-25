# Radar de Amistosos — operação segura

## Variáveis

Todas as flags permanecem desligadas quando ausentes.

- `RADAR_AMISTOSOS_ENABLED`: flag mestre.
- `RADAR_SEARCH_ENABLED`, `RADAR_INVITATIONS_ENABLED`, `RADAR_MATCH_CENTER_ENABLED`, `RADAR_MATCH_RESULTS_ENABLED`, `RADAR_MATCH_HISTORY_ENABLED`, `RADAR_REPUTATION_ENABLED`, `RADAR_MODERATION_ENABLED`: liberações graduais.
- `RADAR_PILOT_ACCOUNT_ALLOWLIST`: referências opacas de contas, separadas por vírgula. Vazio significa que a flag mestre controla o acesso; preenchido nega qualquer conta fora da lista.
- `RADAR_PILOT_CITY_IBGE_CODE`, `RADAR_MODERATION_SLA_HOURS` e `RADAR_PUBLIC_RATING_MIN_MATCHES`: política configurável do piloto.
- `DATABASE_URL`: PostgreSQL de staging/produção.
- `DATABASE_SSL` e `DATABASE_SSL_REJECT_UNAUTHORIZED`: política TLS do banco.
- `OMASCOTE_CORS_ORIGINS`: origens adicionais explícitas, separadas por vírgula. As origens oficiais continuam preservadas.
- `RADAR_INSTAGRAM_VERIFICATION_SECRET`, `RADAR_SEARCH_CURSOR_SECRET`, `RADAR_SEARCH_RATE_LIMIT_SECRET`, `RADAR_INVITATIONS_SECURITY_SECRET`, `RADAR_MATCH_RESULTS_SECURITY_SECRET`, `RADAR_MATCH_HISTORY_CURSOR_SECRET`, `RADAR_MATCH_HISTORY_RATE_LIMIT_SECRET`, `RADAR_REPUTATION_SECURITY_SECRET`, `RADAR_MODERATION_SECURITY_SECRET`: segredos independentes com pelo menos 32 bytes.
- `JWT_SECRET`, `OMASCOTE_DATA_DIR` e `PUBLIC_API_BASE_URL`: configuração já exigida pela autenticação e pela API principal.
- `OPENAI_API_KEY`, `RADAR_PROFILE_PRINT_OPENAI_MODEL`, `RADAR_PROFILE_PRINT_REASONING_EFFORT`, `RADAR_PROFILE_PRINT_SECURITY_SECRET` e `RADAR_PROFILE_PRINT_SAFETY_IDENTIFIER_SECRET`: somente quando a importação por print for habilitada. A integração local da Fase 6A mantém essa função desligada.
- `RADAR_DATABASE_EMBEDDED_PATH`: somente para integração local; é ignorada quando `NODE_ENV=production`.

Não reutilize valores entre segredos e não registre valores em arquivos, logs ou commits.

## Migrações 001–013

1. Fundação do Radar e auditoria.
2. Integridade da confirmação de resultado.
3. Identidade e autorização do time.
4. Verificação do Instagram e papéis de revisão.
5. Importação segura de print.
6. Disponibilidades.
7. Busca e limites persistentes.
8. Convites e notificações.
9. Central da partida.
10. Placar confirmado e estatísticas.
11. Histórico e paginação assinada.
12. Avaliações e reputação anônima.
13. Bloqueios, denúncias, compensações e saída do Radar.

Execute `npm run db:migrate` antes de ligar qualquer flag. A prontidão exige a migração 013 e falha fechada quando uma função ligada não possui a configuração necessária.

## Ativação

1. Aplicar as migrações com as flags desligadas.
2. Configurar segredos e allowlist do piloto.
3. Validar `/health/ready`.
4. Ligar a flag mestre.
5. Ligar funções gradualmente, acompanhando erros, fila e limites.

## Desativação

Desligue primeiro `RADAR_AMISTOSOS_ENABLED`. O frontend oculta a entrada e todas as rotas protegidas retornam indisponibilidade sem apagar dados. As flags específicas podem ser desligadas adicionalmente.

## Rollback

As migrações são cumulativas e os livros de auditoria são imutáveis. Não reverta apagando ou reescrevendo tabelas. Para rollback operacional:

1. desligue a flag mestre;
2. mantenha o schema 001–013;
3. reverta apenas o código para o commit anterior compatível;
4. restaure código novo depois da correção;
5. use uma migração compensatória 014 ou posterior se o schema precisar mudar.

Faça backup antes de qualquer migração em staging ou produção. A saída de um time e as correções administrativas devem permanecer como registros compensatórios.

## Ensaio local

Use valores locais não reutilizados e mantenha todos fora do Git.

1. Configure `JWT_SECRET`, `RADAR_LOCAL_TEST_PASSWORD`, `OMASCOTE_DATA_DIR`, `RADAR_DATABASE_EMBEDDED_PATH`, as flags, a allowlist e os segredos independentes.
2. Execute `npm run radar:local:setup` para migrar e criar as contas locais.
3. Inicie a API e valide `/health/ready`.
4. Configure `RADAR_LOCAL_API_BASE` e execute `npm run radar:local:e2e`.
5. Opcionalmente, configure `RADAR_LOCAL_PROOF_FILE` para guardar apenas método, rota, estado HTTP, ETag e cache, sem tokens ou corpos.
