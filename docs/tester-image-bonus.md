# Bônus de cinco imagens para testadores

A concessão é administrativa, única por conta, e cobre cinco pedidos de somente imagem. Não representa saldo em reais. A galeria pública continua exibindo a imagem de R$18 e os três vídeos com seus preços normais; o benefício aparece no resumo do cliente e no checkout elegível.

## Operação

- Autenticar como a conta já configurada em `BOT_ADMIN_WHATSAPP`.
- No painel da conta, abrir **Liberar imagens para um cliente**.
- Informar o login existente ou e-mail do cliente e clicar em **Liberar 5 imagens**.
- Para uma conta nova, informar e-mail e marcar **Criar conta se este Gmail ainda não tiver cadastro**.
- Copiar as credenciais retornadas uma única vez e entregá-las ao titular por um canal autorizado. A senha temporária começa com o nome do e-mail e termina com oito números aleatórios.
- Repetir a liberação consulta/reutiliza a concessão; não recarrega a quantidade já usada.
- Clientes novos entram por Gmail e senha temporária; podem trocar a senha no painel da conta. Contas Google existentes mantêm o acesso Google e a senha anterior não é substituída.

O sistema não envia e-mails nem confirma participação na Play Store. A concessão é feita pelo administrador após sua conferência. Nenhuma conta é criada ou beneficiada automaticamente ao abrir o site.

## API

Requer JWT de administrador nas rotas `/admin`.

```http
POST /admin/tester-bonus/grant
Content-Type: application/json
Authorization: Bearer <token administrativo>

{"login":"cliente@example.com","create_account":true}
```

Conta existente pode ser liberada somente com `{"login":"identificador" }`. A resposta traz `account`, `bonus` e `grant.replayed`. `credentials` só é devolvido quando a conta acaba de ser criada. Não há token de sessão do cliente na resposta administrativa.

Se a conta for criada mas a concessão não concluir, a resposta preserva as credenciais e informa `bonus_pending:true`; a interface exibe a pendência. Repetir a liberação não redefine a senha.

`GET /admin/tester-bonus/:login` consulta a cota de uma conta. `GET /me` devolve o resumo da cota do próprio cliente.

`POST /auth/change-password`, autenticado como cliente, exige `current_password` e `new_password`. A nova senha precisa ter ao menos dez caracteres e caber no limite suportado pelo hash; credenciais Google sem senha não são redefinidas.

## Cobertura

- Cada pedido elegível reserva uma unidade antes da produção.
- Reservas e usos concluídos contam para o limite.
- O escudo inicial fica incluído na cota; não surge um sexto brinde ao esgotar o bônus.
- Vídeos, modos internos de vídeo e adicionais pagos não usam a concessão.
- Bônus, cupom, saldo e plano semanal não são consumidos juntos.
- Reenvio do mesmo pedido não gasta outra unidade. Mesma chave com conteúdo diferente é conflito.
- Falha técnica confirmada sem resultado válido pode devolver uma unidade uma única vez.
- Download repetido e ajuste do mesmo pedido não gastam outra unidade.
- Uma imagem legítima já entregue permanece acessível depois do consumo da cota.

## Persistência

A implementação utiliza o mesmo diretório persistente `DATA_DIR` já utilizado pelos pedidos da API no Render. Arquivo: `tester-bonus.json`. Não depende de ativar um banco PostgreSQL novo.

O registro utiliza trava exclusiva real no sistema de arquivos, gravação temporária, sincronização e renomeação atômica. Todos os processos da API precisam compartilhar o mesmo volume persistente. Ele não pode ser replicado para discos independentes: essa topologia exigiria migrar a concessão para banco transacional.

Uma trava só é recuperada automaticamente quando pertence a processo do mesmo host comprovadamente encerrado. Travas de origem incerta não são roubadas por tempo. Corrupção, falta do registro de uma concessão concluída ou indisponibilidade bloqueiam novos usos promocionais, sem convertê-los silenciosamente em desconto ou consumo de saldo pago.

Manter cópia de segurança de `clientes.json`, `tester-bonus.json` e pedidos juntos. Nunca apagar o registro para “reiniciar” a campanha. O marcador de concessão concluída na conta impede que apagar o registro conceda outras cinco imagens.

Clientes e pedidos legados continuam em JSON. O provisionamento da campanha serializa seus escritores; a arquitetura legada de todos os cadastros não foi migrada para um banco global nesta mudança.

## Verificação

```text
npm run test:tester-bonus
```

Inclui controle de concorrência entre processos, reinício, repetição, conflitos, cadastro por Gmail, preservação de credenciais, falha parcial, pedidos reais Express/multer em memória, cota, vídeo pago, lote e regressão do escudo existente.

A suíte geral `npm test` também inclui esses testes. O adaptador em `test-support/inject-request.js` executa middleware real sem abrir conexões. O teste integrado promocional desativa a base opcional e falha se tentar abri-la; isso comprova que a cota nova não depende de uma migração de plano pago.

Frontend: `test-mascot-gallery-component.cjs`, `test-guided-tester-image-bonus.cjs` e `test-tester-image-bonus.cjs`. Fixtures locais bloqueiam chamadas externas e não criam pedidos pagos.

## Publicação

Publicar API antes do frontend do bônus. Validar testes e confirmar a versão do serviço e a existência do volume persistente antes da primeira concessão real. A publicação não concede nada a clientes existentes; a primeira concessão depende de ação administrativa explícita.


## Operação pelo Shell do serviço

Na aba Shell do serviço existente no Render, execute `node scripts/grant-tester-images.js cliente@example.com`. O comando usa somente a API local da própria instância, reaproveita a autorização administrativa configurada, não mostra chaves do serviço e não cria novos serviços. Para conta nova, exibe o login e a senha temporária uma única vez e confere o acesso e a cota. Para conta existente, preserva credenciais e quantidade já utilizada. Uma verificação pendente é informada explicitamente.
