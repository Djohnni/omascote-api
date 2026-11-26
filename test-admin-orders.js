"use strict";
const assert = require("node:assert/strict");
const test = require("node:test");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const jwt = require("jsonwebtoken");
const sharp = require("sharp");
const dir = fs.mkdtempSync(path.join(os.tmpdir(), "omascote-admin-orders-"));
Object.assign(process.env, { OMASCOTE_DATA_DIR: dir, JWT_SECRET: "admin-orders-test-secret", NODE_ENV: "test", BOT_ADMIN_WHATSAPP: "owner-admin", RADAR_AMISTOSOS_ENABLED: "false" });
const json = (file, value) => { fs.mkdirSync(path.dirname(file), { recursive:true }); fs.writeFileSync(file, JSON.stringify(value)); };
const customers = { "owner-admin":{ ativo:true,nome_time:"Administrador" }, alice:{ ativo:true,nome_time:"Águia Azul",email:"alice@example.test",senha_hash:"NEVER_RETURN_PASSWORD",google_id:"NEVER_RETURN_GOOGLE" }, bob:{ ativo:true,nome_time:"Time B" } };
json(path.join(dir,"clientes.json"),customers);
function order(id, customer, values = {}, status = "pronto") {
  const base = path.join(dir,"pedidos",customer,"2026-11",id);
  json(path.join(base,"pedido.json"), { id,categoria:"jogador_escudo",criado_em:"2026-11-26T12:00:00Z",...values });
  fs.writeFileSync(path.join(base,"status.txt"),status); return base;
}
const free = order("free-order","alice",{ pagamento_metodo:"bonus_testador",pagamento_pendente:false,valor_final:0,pagamento_info:{status:"approved",valor_pago:0},bonus_testador:{uso_id:"secret-usage",customer_key:"alice"} });
const paid = order("paid-order","bob",{ pagamento_metodo:"pix",pagamento_confirmado_em:"2026-11-26T12:01:00Z",pagamento_info:{status:"approved",valor_pago:6} });
order("pending-order","alice",{ pagamento_pendente:true,valor_pendente:8 },"aguardando_pagamento");
order("plan-order","bob",{ pagamento_metodo:"plano_semanal" },"em_producao");
order("unknown-order","alice",{ valor_final:0 },"erro");
order("before-sp-day","alice",{criado_em:"2026-11-26T02:59:59Z"});
order("start-sp-day","bob",{criado_em:"2026-11-26T03:00:00Z"});
json(path.join(dir,"pedidos","bob","2026-12","next-utc-month","pedido.json"),{ id:"next-utc-month",categoria:"jogador_escudo",criado_em:"2026-12-01T02:00:00Z",status:"novo" });
const unreadable=path.join(dir,"pedidos","alice","2026-11","unreadable");fs.mkdirSync(unreadable);fs.writeFileSync(path.join(unreadable,"pedido.json"),"{");
const { app } = require("./server");
const { payment } = require("./src/admin/orders.routes");
test("admin order list and images are private, read-only and reflect real payment evidence",async t=>{
  const image=await sharp({create:{width:32,height:48,channels:3,background:"#148644"}}).png().toBuffer();
  fs.writeFileSync(path.join(free,"resultado_final.png"),image);fs.writeFileSync(path.join(paid,"resultado_final.png"),image);
  const before=fs.readFileSync(path.join(free,"pedido.json"));
  const server=app.listen(0,"127.0.0.1");await new Promise(resolve=>server.once("listening",resolve));
  t.after(()=>{server.closeAllConnections();server.close();fs.rmSync(dir,{recursive:true,force:true});});
  const root=`http://127.0.0.1:${server.address().port}`;
  const call=(route,user="owner-admin",options={})=>fetch(root+route,{headers:user?{Authorization:"Bearer "+jwt.sign({whatsapp:user},process.env.JWT_SECRET,{expiresIn:"2m"})}:{},...options});
  const query="/admin/pedidos?desde=2026-11-26&ate=2026-11-26";
  for(const route of [query,"/admin/pedidos/free-order/imagem?mini=1"]){
    assert.equal((await call(route,null)).status,401);
    assert.equal((await call(route,"alice")).status,403);
    assert.equal((await call(route,"bob")).status,403);
    assert.equal((await call(route,"unknown-admin")).status,403);
    assert.equal((await fetch(root+route,{headers:{Authorization:"Bearer invalid"}})).status,401);
  }
  const response=await call(query);assert.equal(response.status,200);assert.match(response.headers.get("cache-control"),/private.*no-store/);
  const data=await response.json();assert.equal(data.total,6);assert.equal(data.resumo.clientes,2);assert.equal(data.resumo.gratis,1);assert.equal(data.resumo.pagos,1);assert.equal(data.resumo.pendentes,1);assert.equal(data.resumo.planos,1);assert.equal(data.resumo.erros,1);
  assert.ok(!data.pedidos.some(row=>row.id==="before-sp-day"));assert.ok(data.pedidos.some(row=>row.id==="start-sp-day"));assert.equal(data.registros_ilegíveis,1);
  const encoded=JSON.stringify(data);for(const secret of ["NEVER_RETURN_PASSWORD","NEVER_RETURN_GOOGLE","secret-usage","customer_key","pedido.json",dir])assert.ok(!encoded.includes(secret),secret);
  assert.equal(data.pedidos.find(row=>row.id==="free-order").pagamento.tipo,"gratis");assert.equal(data.pedidos.find(row=>row.id==="paid-order").pagamento.valor,6);
  assert.equal(data.pedidos.find(row=>row.id==="unknown-order").pagamento.tipo,"nao_informado");
  const search=await (await call(query+"&busca=aguia")).json();assert.equal(search.total,3);
  const filtered=await (await call(query+"&pagamento=gratis")).json();assert.deepEqual(filtered.pedidos.map(row=>row.id),["free-order"]);
  const failed=await (await call(query+"&status=erro")).json();assert.deepEqual(failed.pedidos.map(row=>row.id),["unknown-order"]);
  const monthBoundary=await (await call("/admin/pedidos?desde=2026-11-30&ate=2026-11-30")).json();assert.deepEqual(monthBoundary.pedidos.map(row=>row.id),["next-utc-month"]);
  const first=await (await call(query+"&limite=2")).json(), second=await (await call(query+"&limite=2&pagina=2")).json();assert.equal(first.paginas,3);assert.equal(new Set([...first.pedidos,...second.pedidos].map(row=>row.id)).size,4);
  for(const suffix of ["&desde=invalid","&ate=2026-02-31","&desde=2027-01-01","&pagina=-1","&limite=5000","&status=super_admin","&pagamento=pix"]){assert.equal((await call(query+suffix)).status,400,suffix);}
  const full=await call("/admin/pedidos/free-order/imagem");assert.equal(full.status,200);assert.deepEqual(Buffer.from(await full.arrayBuffer()),image);assert.match(full.headers.get("cache-control"),/no-store/);
  const mini=await call("/admin/pedidos/free-order/imagem?mini=1");assert.equal(mini.status,200);assert.match(mini.headers.get("content-type"),/image\/jpeg/);assert.equal((await sharp(Buffer.from(await mini.arrayBuffer())).metadata()).format,"jpeg");
  assert.equal((await call("/admin/pedidos/missing/imagem")).status,404);assert.equal((await call("/admin/pedidos/%2E%2E%5Cescape/imagem")).status,400);
  customers["owner-admin"].ativo=false;json(path.join(dir,"clientes.json"),customers);assert.equal((await call(query)).status,403);assert.equal((await call("/admin/pedidos/free-order/imagem")).status,403);
  assert.deepEqual(fs.readFileSync(path.join(free,"pedido.json")),before);
});
test("free and paid labels require explicit evidence",()=>{
  assert.equal(payment({valor_final:0}).tipo,"nao_informado");
  assert.equal(payment({pagamento_metodo:"pix",pagamento_pendente:true,pagamento_info:{status:"approved"}}).tipo,"pendente");
  assert.equal(payment({pagamento_metodo:"bonus_testador",bonus_testador_cota_devolvida:true}).tipo,"devolvido");
  assert.equal(payment({pagamento_metodo:"cupom",valor_final:0}).tipo,"gratis");
  assert.equal(payment({pagamento_metodo:"plano_semanal"}).tipo,"plano");
  assert.equal(payment({pagamento_metodo:"saldo_ia4tube",pagamento_confirmado_em:"2026-11-26",pagamento_info:{valor_pago:8}}).valor,8);
});
