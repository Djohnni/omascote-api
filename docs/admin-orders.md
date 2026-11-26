# Painel administrativo de clientes e imagens

No site, entrar com a conta administrativa existente, abrir **Minha conta** e selecionar **Painel administrativo**. Também é possível usar `https://omascote.com.br/app.html?painel=pedidos` depois do login.

O painel consulta os pedidos persistidos na API, incluindo os gerados na nuvem. Mostra cliente/time, e-mail ou login, produto, data, status, miniatura e forma de liberação. Um clique na miniatura abre a imagem completa. Os filtros permitem pesquisar por cliente, time ou pedido e selecionar período, produto, status e pagamento. O período inicial é de sete dias, no horário de São Paulo. Cada consulta aceita até 366 dias e até 50 pedidos por página. O site usa páginas de 25 e atualiza a cada 30 segundos enquanto o painel está aberto e visível.

## Acesso e privacidade

- `GET /admin/pedidos` e `GET /admin/pedidos/:id/imagem` exigem JWT válido e o administrador configurado em `BOT_ADMIN_WHATSAPP`, com conta existente e não inativa.
- A permissão exibida pelo frontend não concede acesso: a API verifica cada consulta e cada imagem.
- As imagens são buscadas com o cabeçalho Authorization e exibidas por URLs Blob temporárias. Tokens não entram nos endereços das imagens. Respostas usam `private, no-store`.
- Fechar o painel ou sair da conta cancela consultas, remove os registros da tela e libera as URLs temporárias. A página não usa armazenamento local para dados do painel.
- As consultas são somente leitura e não concedem bônus, cobram, liberam, reprocessam ou alteram pedidos.

## Pagamentos

O painel usa os registros do pedido: bônus/brinde/cupom gratuito, Pix ou saldo confirmado, plano, pendência e devolução/estorno. Valor zero sem evidência de gratuidade aparece como **Pagamento não informado**. Pedidos antigos sem informação confiável não são classificados como pagos ou grátis. A quantidade de pedidos pagos não é um relatório de receita.

## Validação

`node --test test-admin-orders.js` valida autorização da lista e das imagens, conta inativa, ausência de credenciais no retorno, filtros, paginação, limites de período, datas de São Paulo, miniaturas e preservação dos arquivos originais. Os testes usam dados isolados em diretório temporário.
