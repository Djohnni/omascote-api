# Radar de Amistosos — configuração da fundação

Esta fundação fica inativa até a ativação explícita da feature flag. Ela não altera
as rotas legadas nem migra os arquivos JSON existentes.

## Variáveis de ambiente

| Variável | Padrão | Uso |
|---|---|---|
| `RADAR_AMISTOSOS_ENABLED` | `false` | Habilita as rotas e torna PostgreSQL obrigatório no readiness. |
| `DATABASE_URL` | vazio | Conexão PostgreSQL exclusiva da API. |
| `DATABASE_SSL` | `false` | Ativa TLS para bancos gerenciados. |
| `DATABASE_SSL_REJECT_UNAUTHORIZED` | `true` | Mantém validação do certificado TLS; alterar só quando o provedor exigir. |
| `DATABASE_CONNECTION_TIMEOUT_MS` | `5000` | Limite de conexão do health e das operações. |
| `RADAR_AMISTOSOS_PILOT_FREE` | `true` | Mantém o piloto gratuito. |
| `RADAR_PUBLIC_RATING_MIN_MATCHES` | `3` | Mínimo para publicar reputação agregada. |
| `RADAR_PILOT_CITY_IBGE_CODE` | vazio | Cidade canônica do piloto, definida por ambiente. |
| `RADAR_MODERATION_SLA_HOURS` | vazio | SLA operacional, definido antes do piloto. |
| `RADAR_MATCH_RESULTS_ENABLED` | `false` | Habilita as duas mutações de placar somente após a dupla confirmação da partida. |
| `RADAR_MATCH_RESULTS_SECURITY_SECRET` | vazio | Segredo independente de pelo menos 32 bytes para HMAC dos placares e da aplicação única das estatísticas. Com a flag ligada e sem ele, o readiness falha fechado. |
| `RADAR_MATCH_HISTORY_ENABLED` | `false` | Habilita o histórico privado e os confrontos diretos. |
| `RADAR_MATCH_HISTORY_CURSOR_SECRET` | vazio | Segredo de pelo menos 32 bytes usado somente para assinar e vincular cursores. |
| `RADAR_MATCH_HISTORY_RATE_LIMIT_SECRET` | vazio | Segredo independente de pelo menos 32 bytes usado para limitar conta, time e IP sem armazenar os identificadores. |
| `RADAR_INSTAGRAM_VERIFICATION_SECRET` | vazio | Segredo independente, com pelo menos 32 bytes, usado apenas nos HMACs da verificação. Sem ele, o readiness falha fechado. |
| `RADAR_INSTAGRAM_CHALLENGE_TTL_MINUTES` | `20` | Validade do desafio de bio. |
| `RADAR_INSTAGRAM_CHALLENGE_MAX_ATTEMPTS` | `5` | Máximo de tentativas por desafio. |
| `RADAR_INSTAGRAM_RATE_WINDOW_SECONDS` | `3600` | Janela dos limites por conta, time e IP. |
| `RADAR_INSTAGRAM_INITIATE_ACCOUNT_LIMIT` / `RADAR_INSTAGRAM_INITIATE_TEAM_LIMIT` / `RADAR_INSTAGRAM_INITIATE_IP_LIMIT` | `5` / `5` / `20` | Limites para iniciar desafios. |
| `RADAR_INSTAGRAM_CONFIRM_ACCOUNT_LIMIT` / `RADAR_INSTAGRAM_CONFIRM_TEAM_LIMIT` / `RADAR_INSTAGRAM_CONFIRM_IP_LIMIT` | `20` / `20` / `60` | Limites para confirmar desafios. |
| `RADAR_PROFILE_PRINT_IMPORT_ENABLED` | `false` | Habilita apenas a importação de rascunho por print. Desligada, chave e modelo da OpenAI não afetam o restante do Radar. |
| `OPENAI_API_KEY` | vazio | Chave da API, lida somente do ambiente e nunca persistida ou registrada. Obrigatória quando a importação por print estiver habilitada. |
| `RADAR_PROFILE_PRINT_OPENAI_MODEL` | `gpt-5-mini` | Modelo multimodal econômico da Responses API. Fixar snapshot em produção quando a operação exigir reprodutibilidade. |
| `RADAR_PROFILE_PRINT_REASONING_EFFORT` | `low` | Esforço baixo para leitura rápida e barata; a saída continua presa ao schema estrito. |
| `RADAR_PROFILE_PRINT_SECURITY_SECRET` | vazio | Segredo independente de pelo menos 32 bytes para proteger os identificadores dos limites e hashes de idempotência. |
| `RADAR_PROFILE_PRINT_SAFETY_IDENTIFIER_SECRET` | vazio | Segredo independente de pelo menos 32 bytes usado somente para derivar por HMAC o `safety_identifier` opaco e estável de cada conta. Não reutilizar o segredo de segurança da importação. |
| `RADAR_PROFILE_PRINT_MAX_FILE_BYTES` | `8388608` | Tamanho máximo do upload; limitado internamente a 20 MiB. |
| `RADAR_PROFILE_PRINT_MAX_WIDTH` / `RADAR_PROFILE_PRINT_MAX_HEIGHT` | `6000` / `6000` | Dimensões máximas antes da análise. |
| `RADAR_PROFILE_PRINT_MAX_PIXELS` | `20000000` | Limite contra imagens abusivas e bombas de descompressão. |
| `RADAR_PROFILE_PRINT_OPENAI_TIMEOUT_MS` | `45000` | Prazo máximo da chamada à Responses API. |
| `RADAR_PROFILE_PRINT_OPENAI_MAX_OUTPUT_TOKENS` | `1800` | Limite da saída estruturada. |
| `RADAR_PROFILE_PRINT_DRAFT_TTL_MINUTES` | `120` | Retenção curta do rascunho; limitada internamente a 24 horas. |
| `RADAR_PROFILE_PRINT_CLEANUP_INTERVAL_MS` | `900000` | Intervalo da limpeza automática; mínimo de um minuto e máximo de 24 horas. |
| `RADAR_PROFILE_PRINT_DAILY_TEAM_LIMIT` | `3` | Máximo diário por conta e time; limitado internamente a três. |
| `RADAR_PROFILE_PRINT_MONTHLY_GLOBAL_LIMIT` | `50` | Teto mensal global. Configuração ausente ou inválida mantém a importação desligada. |
| `RADAR_PROFILE_PRINT_IP_LIMIT` | `20` | Limite diário por IP calculado pela cadeia de proxies confiável. |
| `RADAR_WHATSAPP_ENCRYPTION_KEYS` | vazio | Chaves AES-256 versionadas no formato `v1:<base64>,v2:<base64>`. Nunca reutilizar segredos da IA, JWT ou Radar. |
| `RADAR_WHATSAPP_ACTIVE_KEY_VERSION` | vazio | Versão usada para novas gravações; versões anteriores permanecem apenas durante rotação controlada. |
| `RADAR_WHATSAPP_RATE_LIMIT_SECRET` | vazio | Segredo HMAC independente para limites persistentes do clique protegido. |
| `RADAR_AVAILABILITY_DEFAULT_TRAVEL_RADIUS_KM` | `25` | Raio usado quando o anúncio e o perfil não informarem um valor específico. |
| `RADAR_AVAILABILITY_MAX_FUTURE_PER_TEAM` | `20` | Limite configurável de disponibilidades futuras abertas por time. |
| `RADAR_AVAILABILITY_MAX_DURATION_HOURS` | `12` | Duração máxima de um horário; limitada internamente a 24 horas. |
| `RADAR_AVAILABILITY_MAX_HORIZON_DAYS` | `180` | Distância máxima entre a criação e o início do horário. |
| `RADAR_AVAILABILITY_RECURRENCE_MAX_DAYS` | `90` | Período máximo de uma recorrência semanal. |
| `RADAR_AVAILABILITY_PAGE_DEFAULT` / `RADAR_AVAILABILITY_PAGE_MAXIMUM` | `20` / `50` | Tamanho padrão e teto da paginação privada por cursor. |
| `RADAR_TRUST_PROXY_HOPS` | `0` | Quantidade explícita de proxies confiáveis para obter o IP do limite; manter zero até comprovar a topologia. |
| `RENDER_GIT_COMMIT` / `GIT_COMMIT` | vazio | Commit exibido nos health checks. |
| `BUILD_ID` | vazio | Identificador de build exibido nos health checks. |

## Operação segura

1. Criar um banco PostgreSQL de staging e definir `DATABASE_URL`.
2. Executar `npm run db:migrate` antes de habilitar a flag.
3. Verificar `/health/live` e `/health/ready`.
4. Habilitar `RADAR_AMISTOSOS_ENABLED=true` somente em staging.
5. Manter rollback por flag; migrações não devem ser revertidas destrutivamente.

Com o Radar ligado, o readiness exige conexão com PostgreSQL e o registro da
migration obrigatória mais recente em `schema_migrations`. Banco acessível com
schema ausente ou desatualizado permanece fora de serviço; liveness continua
independente para distinguir processo vivo de dependência pronta.

O cliente envia somente cidade e UF. A API resolve código canônico e centro
aproximado no catálogo versionado local, sem chamada externa durante o cadastro.
O campo legado de nível é ignorado e não participa de elegibilidade, busca,
compatibilidade, disponibilidade ou convites. A migração 014 mantém a leitura
dos registros antigos, remove seus índices operacionais e adiciona o cadastro
inteligente e o contato opcional criptografado.

O WhatsApp começa oculto e exige consentimento separado. A listagem expõe apenas
`whatsapp_disponivel`; o número é descriptografado somente após um clique
autenticado, elegível, permitido pela allowlist e sem bloqueio bilateral. A
resposta usa `private, no-store`, recebe limites persistentes e a auditoria não
contém o número.

## Revisão manual do Instagram

O endpoint de confirmação registra apenas a declaração do responsável e coloca
o item na fila. Ele nunca verifica ou aprova automaticamente o Instagram. O
código completo não é persistido nem devolvido como uma única string: o cliente
monta localmente os segmentos recebidos e o servidor mantém somente HMAC.

Revisores são provisionados diretamente no PostgreSQL por um procedimento
operacional autenticado. Não existe rota pública para conceder função. Exemplo
com referências opacas previamente comprovadas:

```sql
INSERT INTO radar_account_roles(
  account_reference,
  role,
  granted_by_account_reference
) VALUES (
  '<referencia-opaca-do-revisor>',
  'verification_reviewer',
  '<referencia-opaca-de-quem-autorizou>'
);
```

Antes do piloto, registrar quem pode executar esse procedimento, como a
revogação será aprovada e como a rotação do segredo invalidará desafios ainda
abertos.

## Importação de perfil por print

`POST /me/time/perfil/importar-print` aceita `multipart/form-data`, um único
arquivo no campo `imagem` e, opcionalmente, `instagram_handle`. O arquivo deve
ser PNG, JPEG ou WebP estático. Assinatura, MIME, extensão, integridade,
dimensões e volume de pixels são validados; depois a imagem é reprocessada para
remover metadados antes de seguir para `POST /v1/responses`.

A chamada usa `store: false`, não oferece ferramentas e exige Structured
Outputs com JSON Schema estrito. Também envia `safety_identifier` estável de no
máximo 64 caracteres, derivado por HMAC da referência opaca da conta com um
segredo exclusivo. Conta, telefone, Instagram e IDs internos nunca compõem esse
campo em texto puro. O texto da imagem é tratado como conteúdo não
confiável. O resultado fica em `team_verifications.ai_draft` por retenção curta
e é somente uma sugestão com valor, confiança e evidência. A rota não chama a
atualização do perfil, não verifica o Instagram e não ativa disponibilidade. O
responsável precisa revisar e salvar manualmente pelos endpoints normais.

Bytes, base64, caminho temporário, resposta bruta e identificadores internos do
provedor não são persistidos. A limpeza automática marca rascunhos vencidos
como expirados e remove o conteúdo do rascunho, mantendo apenas o histórico
operacional não sensível e a auditoria append-only. O mesmo saneamento ocorre
antes de uma nova importação do time.

O processamento seguro usa Sharp 0.35 ou superior e, portanto, esta versão da
API exige Node.js 20.9 ou superior. Confirmar a versão do runtime de staging
antes de habilitar a flag específica.

## Disponibilidades privadas para amistosos

As rotas da Fase 3A ficam sob `/me/time/amistosos/disponibilidades`: listagem,
criação, atualização e cancelamento lógico. Todas resolvem conta, perfil e time
exclusivamente pela sessão, retornam somente `availability_id` opaco e usam
`Cache-Control: private, no-store`. Não há rota pública de busca, convite,
partida ou contato nesta fase.

Criação aceita somente `active` ou `paused`. Ativar exige perfil completo,
Instagram verificado, termos aceitos, time não suspenso e cidade do piloto
quando configurada; o controle mestre `availability_active` não é requisito para
cadastrar o primeiro horário. Modalidade e categoria vêm do perfil e o nível,
cidade e UF são sempre derivados do cadastro canônico.

Recorrência opcional usa `frequency: weekly`, `days_of_week` com nomes em inglês
de `monday` a `sunday`, horários `HH:MM`, data `until` em `YYYY-MM-DD` e fuso
fixo `America/Sao_Paulo`. Mutações exigem `Idempotency-Key`; atualização e
cancelamento também exigem `If-Match`. O banco impede duplicidade equivalente,
mudança de proprietário, remoção física, regressão de versão e retorno de
estados terminais. Horários vencidos são marcados como `expired` na próxima
operação privada e a mudança é auditada.

Comandos locais:

```text
npm install
npm run test:radar
npm test
npm run db:migrate
```
