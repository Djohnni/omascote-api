"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const jwt = require("jsonwebtoken");
const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "omascote-futebol-integration-"));
Object.assign(process.env, { OMASCOTE_DATA_DIR:dataDir, NODE_ENV:"test", JWT_SECRET:"offline-futebol-integration-fixture-secret-only",
  BOT_ADMIN_WHATSAPP:"admin-futebol-fixture", FUTEBOL_OMNI360_MODE:"pilot", WEEKLY_PLANS_ENABLED:"false",
  RADAR_ENABLED:"false", RADAR_AMISTOSOS_ENABLED:"false", VEO_VIDEO_ENABLED:"true" });
delete process.env.DATABASE_URL;
delete process.env.POSTGRES_URL;
delete process.env.PLAYER_CREST_OPENAI_API_KEY;
const { app } = require("./server");
const { injectRequest } = require("./test-support/inject-request");
const storage = require("./src/orders/order.storage");
const { catalog } = require("./src/orders/futebol-omni/quote");
const png = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Y9Z8HkAAAAASUVORK5CYII=", "base64");
const clientsFile = path.join(dataDir, "clientes.json");
const owner = process.env.BOT_ADMIN_WHATSAPP;
function headers(user=owner) { return { authorization:"Bearer " + jwt.sign({whatsapp:user},process.env.JWT_SECRET) }; }
function clients() { return JSON.parse(fs.readFileSync(clientsFile,"utf8")); }
function balance() { return clients()[owner].saldo_extra; }
function request(route, json, user=owner) { return injectRequest(app,{method:json===undefined?"GET":"POST",path:route,headers:headers(user),...(json===undefined?{}:{json})}); }
function fixture(row, option) {
  const fields = { sport:"Futebol",delivery_mode:"image_video",video_model:"omni",futebol_scene:option.id,
    futebol_version:row.code,futebol_price_cents:option.cents,announcement_type:row.kind==="renew"?"renovado":"contratado" };
  const files = ["escudo1","escudo2"];
  const roles={mask:"mascot_photo",person:"player_photo",team:"team_photo"};
  if(roles[row.kind]) { files.push("mascote"); fields.match_photo_type=roles[row.kind]; }
  if(row.kind==="desc") Object.assign(fields,{photo_mode:"mascot_description",mascot_description:"Urubu vermelho"});
  if(row.product==="patrocinador") files.push(...Array(row.kind==="many"?18:1).fill("patrocinadores"));
  return {fields,files};
}
function quote(row, fields, files, user=owner) {
  return request("/cupons/preco",{product_id:row.product,fields_json:fields,futebol_upload_counts:{
    mascote:files.filter(f=>f==="mascote").length,patrocinadores:files.filter(f=>f==="patrocinadores").length}},user);
}
function create(row, fields, files, id, user=owner) {
  const flyer={proximo_jogo:"zz1ft",patrocinador:"zz1fj"}[row.product] || row.product;
  return injectRequest(app,{method:"POST",path:"/pedidos",headers:headers(user),multipart:{fields:{
    flyer_tipo:flyer,product_id:row.product,schema_version:"2",rodada:"Campeonato fictício",data:"2026-11-28",
    hora:"15:00",arena:"Campo fictício",client_request_id:id,fields_json:JSON.stringify(fields)},
    files:files.map((field,i)=>({field,filename:`${field}-${i}.png`,contentType:"image/png",data:png}))}});
}

test("pilot catalog, quote, paid order, scene integrity and retry use real routes offline",async t=>{
  const all=clients();
  for(const user of [owner,"ordinary-fixture"]) all[user]={ativo:true,nome_time:"Fixture",saldo_extra:1000,saldo_mensal:0,usados_no_ciclo:8,
    ciclo_mes:new Date().toISOString().slice(0,7).replace("-","")};
  fs.writeFileSync(clientsFile,JSON.stringify(all));
  const originalFetch=global.fetch;
  global.fetch=async()=>{throw new Error("Network forbidden in fixture");};
  try {
    await t.test("only admin sees pilot",async()=>{
      assert.equal((await request("/catalogo/futebol-videos",undefined,"ordinary-fixture")).json.available,false);
      const catalogResponse=await request("/catalogo/futebol-videos");
      assert.equal(catalogResponse.json.pilot,true);
      assert.equal(catalogResponse.json.catalog.length,19);
    });
    await t.test("38 scenes quote independently including 18 sponsor logos",async()=>{
      for(const row of catalog) {
        const prices=[];
        for(const option of row.options) {
          const {fields,files}=fixture(row,option);
          const response=await quote(row,fields,files);
          assert.equal(response.status,200,response.text);
          const expected=(option.cents+(row.kind==="many"?300:0))/100;
          assert.equal(response.json.valor_original,expected);
          assert.equal(response.json.valor_final,expected);
          prices.push(expected);
        }
        assert.notEqual(...prices);
      }
    });
    await t.test("P1, P2 and 18 logos persist exact scene, 720p contract and one debit",async()=>{
      for(const code of ["P1","P2","S2"]) {
        const row=catalog.find(r=>r.code===code), option=row.options[0];
        const {fields,files}=fixture(row,option);
        if(code==="S2") fields.futebol_price_cents+=300;
        const before=balance(), id=`futebol-fixture-${code}`;
        const response=await create(row,fields,files,id);
        assert.equal(response.status,200,response.text);
        const saved=storage.findPedidoByClientRequestId(path.join(dataDir,"pedidos"),owner,id);
        assert(saved);
        assert.equal(saved.pedido.image_prompt_version,"football_field_v2");
        assert.equal(saved.pedido.fields.futebol_scene,option.id);
        assert.equal(saved.pedido.video_generation.scene_id,option.id);
        assert.equal(saved.pedido.video_generation.resolution,"720p");
        assert.equal(saved.pedido.video_generation.reference_mode,"initial_only");
        assert.equal(saved.pedido.video_generation.prompt_version,"football_field_v2");
        assert.equal(saved.pedido.video_generation.duration_seconds,10);
        assert.equal(saved.pedido.image_executor,undefined);
        assert.equal(Number((before-balance()).toFixed(2)),fields.futebol_price_cents/100);
        assert.equal((await create(row,fields,files,id)).status,200);
        assert.equal(Number((before-balance()).toFixed(2)),fields.futebol_price_cents/100);
      }
    });
    for (const resolution of ["360p","720p"]) await t.test(`historical ${resolution} stays ready and downloadable without acquiring new metadata`,async()=>{
      const row=catalog.find(r=>r.code==="P1"), {fields,files}=fixture(row,row.options[0]);
      const before=balance();
      const response=await create(row,fields,files,`football-history-${resolution}`);
      assert.equal(response.status,200,response.text);
      const saved=storage.findPedidoByClientRequestId(path.join(dataDir,"pedidos"),owner,`football-history-${resolution}`);
      const filename=path.join(saved.base,"pedido.json");
      const old={...saved.pedido,aprovado_cliente:true,pagamento_pendente:false,status:"pronto",
        video_generation:{...saved.pedido.video_generation,resolution,status:"ready",ready:true}};
      delete old.image_prompt_version;
      delete old.video_generation.reference_mode;
      delete old.video_generation.prompt_version;
      fs.writeFileSync(filename,JSON.stringify(old));
      fs.writeFileSync(path.join(saved.base,"status.txt"),"pronto");
      const mp4=Buffer.from([0,0,0,24,0x66,0x74,0x79,0x70,0x69,0x73,0x6f,0x6d]);
      fs.writeFileSync(path.join(saved.base,"resultado_video.mp4"),mp4);
      const historicalContract=old.video_generation;
      assert.equal((await request(`/pedidos/${saved.id}/info`)).json.video_pronto,true);
      assert.equal((await request(`/pedidos/${saved.id}/info`)).json.video_generation.resolution,resolution);
      const listed=(await request("/meus-pedidos")).json.pedidos.find(order=>order.id===saved.id);
      assert.equal(listed.video_pronto,true);
      assert.equal(listed.video_generation.resolution,resolution);
      const ticket=await request(`/pedidos/${saved.id}/download-ticket`,{formato:"video",transporte:"https"});
      assert.equal(ticket.status,200,ticket.text);
      assert.equal(ticket.json.video_duration_seconds,10);
      const downloaded=await request(ticket.json.download_path);
      assert.equal(downloaded.status,200);
      assert.match(downloaded.headers["content-type"],/video\/mp4/);
      assert.deepEqual(JSON.parse(fs.readFileSync(filename)).video_generation,historicalContract);
      // Same request ID replays the historical contract without adding metadata or charging again.
      assert.equal((await create(row,fields,files,`football-history-${resolution}`)).status,200);
      assert.equal(Math.round((before-balance())*100),fields.futebol_price_cents);
      assert.equal(JSON.parse(fs.readFileSync(filename)).video_generation.resolution,resolution);
      assert.equal(Object.hasOwn(JSON.parse(fs.readFileSync(filename)),"image_prompt_version"),false);
      assert.deepEqual(JSON.parse(fs.readFileSync(filename)).video_generation,historicalContract);
    });
    await t.test("gallery scene accepts the selected sport and location without changing its price or contract",async()=>{
      const row=catalog.find(r=>r.code==="P1"),option=row.options.find(o=>o.id==="P1-A");
      const cases=[
        {sport:"Futsal",sport_context:"Quadra coberta do bairro",scenario_id:"proximo_jogo_futsal_v1"},
        {sport:"Futsal",sport_context:"Quadra coberta",scenario_id:"proximo_jogo_atual_v1"},
        {sport:"Futebol Society",sport_context:"Campo sintético"},
        {sport:"Basquete",sport_context:"Ginásio municipal"},
        {sport:"Vôlei",sport_context:"Quadra de areia"},
        {sport:"Tênis",sport_context:"Quadra de saibro"},
        {sport:"Peteca adaptada personalizada",sport_context:"Quadra comunitária"}
      ];
      for(const [index,selected] of cases.entries()){
        const {fields,files}=fixture(row,option);Object.assign(fields,selected);
        const quoted=await quote(row,fields,files);
        assert.equal(quoted.status,200,quoted.text);
        assert.equal(quoted.json.valor_original,option.cents/100);
        const before=balance(),id=`sport-fixture-${index}`;
        const response=await create(row,fields,files,id);
        assert.equal(response.status,200,response.text);
        const saved=storage.findPedidoByClientRequestId(path.join(dataDir,"pedidos"),owner,id);
        assert.equal(saved.pedido.fields.sport,selected.sport);
        assert.equal(saved.pedido.fields.sport_context,selected.sport_context);
        assert.equal(saved.pedido.image_prompt_version,"football_field_v2");
        assert.equal(saved.pedido.video_generation.scene_id,"P1-A");
        assert.equal(saved.pedido.video_generation.resolution,"720p");
        assert.equal(saved.pedido.video_generation.reference_mode,"initial_only");
        assert.equal(saved.pedido.video_generation.prompt_version,"football_field_v2");
        assert.equal((await create(row,fields,files,id)).status,200);
        assert.equal(Math.round((before-balance())*100),option.cents);
      }
    });
    await t.test("sport flexibility preserves mismatched-product and tampered scenario rejection before debit",async()=>{
      const row=catalog.find(r=>r.code==="P1"),option=row.options[0],{fields,files}=fixture(row,option);
      const before=balance();
      const wrong=await create(row,{...fields,sport:"Futsal",scenario_id:"jogador_escudo_futsal_v1"},files,"sport-wrong-scenario");
      assert.equal(wrong.status,400);assert.equal(wrong.json.code,"SCENARIO_PRODUCT_MISMATCH");
      const tampered=await create(row,{...fields,sport:"Basquete",scenario_id:"proximo_jogo_atual_v1",scenario_version:1},files,"sport-tampered-scenario");
      assert.equal(tampered.status,400);assert.equal(tampered.json.code,"SCENARIO_TAMPERED");
      assert.equal((await create(row,{...fields,sport:""},files,"sport-missing-fixture")).status,400);
      assert.equal(balance(),before);
    });
    await t.test("stale price, mismatched assets and customer cannot create scene",async()=>{
      const row=catalog.find(r=>r.code==="P1"), {fields,files}=fixture(row,row.options[0]);
      const before=balance();
      assert.equal((await create(row,{...fields,futebol_price_cents:1},files,"stale-fixture")).status,409);
      assert.equal((await create(row,{...fields,match_photo_type:"player_photo"},files,"mismatched-fixture")).status,400);
      assert.equal((await create(row,fields,files,"customer-fixture","ordinary-fixture")).status,503);
      assert.equal(balance(),before);
      assert.equal(clients()["ordinary-fixture"].saldo_extra,1000);
    });
  } finally { global.fetch=originalFetch; }
});
