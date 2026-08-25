-- Dividir Times MVP - estrutura de persistencia sugerida
-- Ajuste os nomes de FK/tabelas conforme o backend real do Meu Clube FC.

create table if not exists time_divisoes (
  id uuid primary key,
  time_id uuid not null,
  titulo varchar(90) not null,
  status varchar(20) not null default 'aberta',
  share_token varchar(80) not null unique,
  resultado_json jsonb,
  criado_por uuid,
  criado_em timestamptz not null default now(),
  atualizado_em timestamptz not null default now()
);

create table if not exists time_divisao_presentes (
  sessao_id uuid not null references time_divisoes(id) on delete cascade,
  jogador_id uuid not null,
  nome_snapshot varchar(80) not null,
  apelido_snapshot varchar(60),
  numero_snapshot varchar(12),
  posicao_snapshot varchar(40),
  ordem integer not null default 0,
  primary key (sessao_id, jogador_id)
);

create table if not exists time_divisao_votos (
  id uuid primary key,
  sessao_id uuid not null references time_divisoes(id) on delete cascade,
  voter_token_hash char(64) not null,
  nome_votante varchar(80),
  ranking_json jsonb not null,
  criado_em timestamptz not null default now(),
  unique (sessao_id, voter_token_hash)
);

create index if not exists idx_time_divisoes_time_id on time_divisoes(time_id);
create index if not exists idx_time_divisoes_share_token on time_divisoes(share_token);
create index if not exists idx_time_divisao_votos_sessao on time_divisao_votos(sessao_id);
