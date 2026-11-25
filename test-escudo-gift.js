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
process.env.GOOGLE_CLIENT_ID = 'local-gmail-audience';
// Isolate unrelated weekly-plan database availability; exercise the real gift/order/payment code.
const planModule = require('./src/plans/weekly-plans.service');
const createPlans = planModule.createWeeklyPlansService;
planModule.createWeeklyPlansService = options => ({...createPlans(options),
  customerOperationalState:async()=>({hasEntitlement:false,paymentPending:false})});
const {app} = require('./server');
const {injectRequest} = require('./test-support/inject-request');
const clientsFile = path.join(dataDir, 'clientes.json');
const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Y9Z8HkAAAAASUVORK5CYII=', 'base64');
function token(id) { return jwt.sign({whatsapp:id}, process.env.JWT_SECRET, {expiresIn:'1h'}); }
const {createTesterBonusStore} = require('./src/tester-bonus/tester-bonus.store');
const store = createTesterBonusStore({dataDir});
const auth = owner => ({authorization:'Bearer '+token(owner)});
const getMe = owner => injectRequest(app,{method:'GET',path:'/me',headers:auth(owner)});
const login = () => injectRequest(app,{method:'POST',path:'/auth/google',json:{id_token:'local-token-fixture'}});
function order(owner,id,{video=false,required=false,oldTab=false}={}) {
  return injectRequest(app,{method:'POST',path:'/pedidos',headers:{...auth(owner),...(oldTab?{origin:'https://omascote.com.br'}:{})},multipart:{
    fields:{flyer_tipo:'escudo3d',rodada:'Escudo',data:'Escudo',client_request_id:id,
      ...(required?{image_bonus_required:'1'}:{}),
      fields_json:JSON.stringify({delivery_mode:video?'image_video':'image',...(video?{video_model:'fast'}:{})})},
    files:[{field:'escudo1',filename:'escudo.png',contentType:'image/png',data:png}]}});
}

test('Gmail promotion through verified Google login, checkout and migration', async t => {
  const sample={ativo:true,nome_time:'Time',saldo_extra:50,saldo_mensal:0,usados_no_ciclo:8,
    ciclo_mes:new Date().toISOString().slice(0,7).replace('-',''),brinde_mascote_ja_liberado:true};
  fs.writeFileSync(clientsFile,JSON.stringify({
    google_old:{...sample,login_tipo:'google',google_id:'old',brinde_escudo3d_app_usado:true},
    google_inactive:{...sample,ativo:false},
    password:{...sample,email:'password@gmail.com',senha_hash:require('bcryptjs').hashSync('local-password',4)}
  }));
  let claims;
  const originalFetch=global.fetch;
  t.after(()=>{global.fetch=originalFetch;});
  global.fetch=async url=>{
    assert.ok(String(url).startsWith('https://oauth2.googleapis.com/tokeninfo?id_token='));
    return new Response(JSON.stringify(claims),{status:200});
  };
  const identity=(sub,email,verified=true)=>{claims={aud:process.env.GOOGLE_CLIENT_ID,sub,email,email_verified:verified};};
  for(const [sub,email,verified] of [['unverified','wait@gmail.com',false],['workspace','club@example.com',true]]) {
    identity(sub,email,verified);
    const response=await login();
    assert.equal(response.status,200,response.text);
    assert.equal((await getMe('google_'+sub)).json.tester_image_bonus.granted,false);
  }
  const password=await injectRequest(app,{method:'POST',path:'/auth/login',json:{whatsapp:'password@gmail.com',senha:'local-password'}});
  assert.equal(password.status,200,password.text);
  assert.equal((await getMe('password')).json.tester_image_bonus.granted,false);
  const staleCrest=await order('password','old-tab',{oldTab:true});
  assert.equal(staleCrest.status,409);
  assert.equal(staleCrest.json.code,'CREST_PRICE_CHANGED');
  identity('inactive','inactive@gmail.com');
  assert.equal((await login()).status,403);
  identity('old','old@gmail.com','true');
  assert.equal((await login()).status,200);
  const old=(await getMe('google_old')).json;
  assert.equal(old.tester_image_bonus.remaining,1);
  assert.equal(old.brinde_escudo_login_disponivel,false);
  assert.equal(old.brinde_escudo_login_usado,true);

  identity('fresh','fresh@GMAIL.COM','true');
  const owner='google_fresh';
  for(const response of await Promise.all([login(),login()])) assert.equal(response.status,200,response.text);
  assert.equal((await getMe(owner)).json.tester_image_bonus.remaining,2);
  const videoQuote=await injectRequest(app,{method:'POST',path:'/cupons/preco',headers:auth(owner),
    json:{product_id:'escudo3d',delivery_mode:'image_video',video_model:'fast'}});
  assert.equal(videoQuote.json.valor_final,14.9);
  const attempts=await Promise.all(['gmail-a','gmail-b','gmail-c'].map(id=>order(owner,id,{required:true})));
  assert.deepEqual(attempts.map(x=>x.status).sort(),[200,200,409]);
  assert.equal(attempts.find(x=>x.status===409).json.code,'IMAGE_BONUS_UNAVAILABLE');
  for(const result of attempts.filter(x=>x.status===200)){
    assert.equal(result.json.valor_final,0);
    assert.equal(result.json.brinde_escudo_login,false);
    const again=await order(owner,result.json.client_request_id,{required:true});
    assert.equal(again.json.pedido_id,result.json.pedido_id);
  }
  assert.equal((await login()).status,200);
  assert.equal((await getMe(owner)).json.tester_image_bonus.remaining,0);
  const paid=await order(owner,'gmail-paid');
  assert.equal(paid.status,200,paid.text);
  assert.equal(paid.json.valor_final,4);
  assert.equal(paid.json.requer_pix_antes_criacao,true);
  const tester=await store.grant({customerKey:owner,actor:'local-admin'});
  assert.equal(tester.summary.limit,5);
  assert.equal(tester.summary.remaining,3);
  assert.equal((await login()).status,200);
  assert.equal((await getMe(owner)).json.tester_image_bonus.remaining,3);
});
