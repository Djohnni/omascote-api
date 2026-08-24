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

Comandos locais:

```text
npm install
npm run test:radar
npm test
npm run db:migrate
```
