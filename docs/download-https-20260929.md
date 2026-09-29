# Download HTTPS temporário — 29/09/2026

## Escopo

Somente entrega dos arquivos PNG e MP4 já produzidos e autorizados. Não altera
preços, pagamentos, geração, prompts, worker, visualização ou arquivos existentes.
O frontend mantém os botões separados de imagem e vídeo.

O POST autenticado `/pedidos/:id/download-ticket`, com `transporte: "https"`,
retorna um endereço para o arquivo exato, válido por cinco minutos. O link é uma
credencial temporária: quem o possuir pode acessar esse arquivo nesse período.
Não contém a sessão/JWT da conta e não deve ser compartilhado ou registrado.
Logs técnicos da aplicação e eventos do frontend não incluem a chave.
Logs da infraestrutura devem também evitar conservar query strings sensíveis.

O GET revalida propriedade, pagamento, aprovação e direito ao vídeo/plano.
Aceita HEAD, Range e novas tentativas durante a validade. Responde como attachment,
com tipo PNG/MP4, no-store, no-referrer e nosniff. Somente o hash da chave fica na
memória, com limite de 5.000 registros e limpeza de expirados na emissão.
Reiniciar o servidor invalida links antigos; outro clique em Baixar emite um novo,
sem gerar nem cobrar outra arte. Esta implementação pressupõe uma instância da
API; múltiplas réplicas exigiriam armazenamento compartilhado dos hashes.

O frontend entrega o endereço ao navegador, sem carregar o arquivo inteiro em
um Blob. Nunca usa navegação `_self`: solicita attachment em `_blank` e oferece
um link de toque real se a tentativa automática for bloqueada. Alguns navegadores
internos podem abrir uma aba/visualização; a conversa original não é substituída.
O aviso diz "Download solicitado", não "salvo no celular".

## Verificação

- Suíte completa da API: 270 testes aprovados.
- Suíte do frontend: 13 testes aprovados.
- Cobertura: login, propriedade, pagamento, aprovação, entitlement, validade,
  alteração do pedido após emissão, HEAD sem marcar download, Range, repetição,
  bytes exatos, proteção da origem e fallback legado.
- Chrome real: imagem PNG (2.162.460 bytes) e vídeo MP4 (10.207.179 bytes)
  baixados pelo helper real do frontend em página local isolada, mantendo a URL.
  Ambos comparados por SHA-256 com os originais, sem diferenças.
- O ensaio visual local usa HTTP loopback e arquivos existentes, não login ou
  credenciais reais. A autorização HTTPS é validada separadamente pelos testes
  de integração. Não foi reproduzido o navegador interno real do Instagram ou
  WhatsApp; não há garantia baseada somente nesses testes.

## Publicação e retorno

1. Publicar API `Djohnni/omascote-api`, main, no Render `srv-d64b828gjchc739kim30`.
2. Confirmar commit de `/health/live`.
3. Publicar frontend `Djohnni/omascote`, main, via GitHub Pages.
4. Confirmar conteúdo de `https://omascote.com.br/app.html`.
5. Fazer teste manual de pedido já pago, sem nova geração ou cobrança.

Se necessário, `DOWNLOAD_HTTPS_ENABLED=false` na API devolve imediatamente o
contrato antigo de ticket/POST, que o frontend continua aceitando. Reativar exige
remover o valor false e reiniciar/deployar. Links nativos emitidos antes da
desativação passam a retornar 403. Não mudar chaves existentes.

Baseline anterior: frontend `45ff0b73d2dcb0f2e66a41ab915858e07237ad59`,
API `e44316e36e3f117e3d24646b10bada4f784b2fd0`.
Também é possível reverter apenas os commits desta mudança por PR, sem reset
destrutivo e sem tocar em pedidos/saldos. Há backup local verificado anterior.
