const assert = require('node:assert/strict');
const test = require('node:test');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const jwt = require('jsonwebtoken');
const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'omascote-gift-test-'));
process.env.OMASCOTE_DATA_DIR = dataDir;
process.env.NODE_ENV = 'test';
process.env.JWT_SECRET = 'local-escudo-gift-test-secret-only';
process.env.BOT_ADMIN_WHATSAPP = 'gift-test-bot';
process.env.WEEKLY_PLANS_ENABLED = 'false';
// Isolate unrelated weekly-plan database availability; exercise the real gift/order/payment code.
const planModule = require('./src/plans/weekly-plans.service');
const createPlans = planModule.createWeeklyPlansService;
planModule.createWeeklyPlansService = options => ({...createPlans(options),
  customerOperationalState:async()=>({hasEntitlement:false,paymentPending:false})});
const {app} = require('./server');
const storage = require('./src/orders/order.storage');
const clientsFile = path.join(dataDir, 'clientes.json');
const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Y9Z8HkAAAAASUVORK5CYII=', 'base64');
function clients() { return JSON.parse(fs.readFileSync(clientsFile,'utf8')); }
function token(id) { return jwt.sign({whatsapp:id}, process.env.JWT_SECRET, {expiresIn:'1h'}); }
function form(id, extra = {}) {
  const f = new FormData();
  for (const [k,v] of Object.entries({flyer_tipo:'escudo3d',rodada:'Escudo 3D',data:'Escudo 3D',
    client_request_id:id,brinde_escudo_login:'1',fields_json:JSON.stringify({delivery_mode:'image',sport:'Futebol'}),...extra})) f.append(k,v);
  f.append('escudo1',new Blob([png],{type:'image/png'}),'escudo.png');
  return f;
}
test('um escudo grátis por conta: concorrência, replay, saldo, login e próximos pedidos', async t => {
  const sample = {ativo:true,nome_time:'Time de teste',saldo_extra:50,saldo_mensal:0,
    usados_no_ciclo:8,ciclo_mes:new Date().toISOString().slice(0,7).replace('-',''),brinde_mascote_ja_liberado:true};
  fs.writeFileSync(clientsFile,JSON.stringify({alice:{...sample},bob:{...sample,saldo_extra:0},
    provisional:{...sample,cadastro_automatico:true,conta_finalizada:false},
    oldgift:{...sample,brinde_escudo3d_app_usado:true},'gift-test-bot':{...sample}}));
  const server = await new Promise(resolve => { const s=app.listen(0,'127.0.0.1',()=>resolve(s)); });
  t.after(()=>new Promise(resolve=>server.close(resolve)));
  const origin=`http://127.0.0.1:${server.address().port}`;
  async function request(owner,endpoint,body) {
    const r=await fetch(origin+endpoint,{method:body?'POST':'GET',headers:owner?{Authorization:'Bearer '+token(owner)}:{},body});
    return {status:r.status,data:await r.json()};
  }
  async function quote(owner, fields={}) {
    const r=await fetch(origin+'/cupons/preco',{method:'POST',headers:{'Content-Type':'application/json',...(owner?{Authorization:'Bearer '+token(owner)}:{})},
      body:JSON.stringify({product_id:'escudo3d',delivery_mode:'image',...fields})}); return r.json();
  }
  assert.equal((await quote('alice')).valor_final,0);
  assert.equal((await quote('alice',{delivery_mode:'image_video',video_model:'fast'})).valor_final,14.90);
  assert.equal((await quote('alice',{delivery_mode:'image_video',video_model:'omni'})).valor_final,19.90);
  assert.equal((await quote(null)).valor_final,4);
  assert.equal((await request('alice','/me')).data.brinde_escudo_login_disponivel,true);
  const invalid=await request('alice','/pedidos',form('invalid',{fields_json:'{invalid'}));
  assert.equal(invalid.status,400);
  assert.equal((await request('alice','/me')).data.brinde_escudo_login_disponivel,true);
  const attempts=await Promise.all(['gift-a','gift-b'].map(id=>request('alice','/pedidos',form(id))));
  assert.deepEqual(attempts.map(x=>x.status).sort(),[200,409]);
  const success=attempts.find(x=>x.status===200).data;
  assert.equal(success.valor_final,0);
  assert.equal(success.brinde_escudo_login,true);
  assert.equal(success.pagamento_pendente,false);
  assert.equal(success.requer_pix_antes_criacao,false);
  assert.equal(clients().alice.saldo_extra,50,'gift must not debit existing balance');
  const stored=storage.findPedidoByClientRequestId(path.join(dataDir,'pedidos'),'alice',success.client_request_id);
  assert.equal(stored.pedido.pagamento_metodo,'brinde_escudo_login');
  assert.equal(stored.pedido.video_generation?.requested===true,false);
  assert.equal(stored.pedido.qualidade_geracao,undefined,'gift retains normal image quality');
  assert.equal(fs.readFileSync(path.join(stored.base,'status.txt'),'utf8').trim(),'novo');
  const replay=await request('alice','/pedidos',form(success.client_request_id));
  assert.equal(replay.status,200);
  assert.equal(replay.data.pedido_id,success.pedido_id);
  assert.equal(storage.listPedidoBasesByWhatsapp(path.join(dataDir,'pedidos'),'alice').length,1);
  assert.equal((await request('alice','/me')).data.brinde_escudo_login_disponivel,false);
  const freshLogin=token('alice');
  assert.ok(freshLogin);
  assert.equal((await request('alice','/pedidos',form('new-session'))).status,409);
  assert.equal((await quote('alice')).valor_final,4);
  const paid=await request('alice','/pedidos',form('normal-paid',{brinde_escudo_login:''}));
  assert.equal(paid.status,200,JSON.stringify(paid.data));
  assert.equal(paid.data.valor_final,4);
  assert.equal(clients().alice.saldo_extra,46);
  const denied=await request('provisional','/pedidos',form('provisional'));
  assert.equal(denied.status,403);
  assert.equal(denied.data.code,'ESCUDO_GIFT_LOGIN_REQUIRED');
  assert.equal((await request(null,'/pedidos',form('anonymous'))).status,401);
  assert.equal((await request('oldgift','/pedidos',form('old-gift'))).status,409);
  assert.equal((await request('bob','/pedidos',form('video-gift',{fields_json:JSON.stringify({delivery_mode:'image_video',video_model:'fast'})}))).status,400);
  assert.equal((await request('bob','/pedidos',form('wrong-product',{flyer_tipo:'mascote_uniforme'}))).status,400);
  const bob=await request('bob','/pedidos',form('bob-gift'));
  assert.equal(bob.status,200);
  assert.equal(bob.data.valor_final,0);
  assert.equal(bob.data.pagamento_pendente,false);
  const next=await request('bob','/pedidos',form('bob-paid',{brinde_escudo_login:''}));
  assert.equal(next.status,200);
  assert.equal(next.data.valor_final,4);
  assert.equal(next.data.requer_pix_antes_criacao,true);
  const bot=await request('gift-test-bot','/bot/pedidos/novos');
  assert.equal(bot.status,200);
  assert.ok(bot.data.pedidos.some(p=>p.id===bob.data.pedido_id));
  assert.ok(!bot.data.pedidos.some(p=>p.id===next.data.pedido_id));
  const reset=clients(); delete reset.bob.brinde_escudo_login_usado; delete reset.bob.brinde_escudo3d_app_usado;
  fs.writeFileSync(clientsFile,JSON.stringify(reset));
  assert.equal((await request('bob','/me')).data.brinde_escudo_login_disponivel,false,'persisted gift order protects interrupted account writes');
});

