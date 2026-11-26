const assert = require('node:assert/strict');
const {catalog,quote,contract} = require('./quote');
const roles = {mask:'mascot_photo',person:'player_photo',team:'team_photo'};
for (const row of catalog) {
  const fields = {sport:'Futebol',delivery_mode:'image_video',video_model:'omni',
    announcement_type:row.kind==='renew'?'renovado':'contratado'};
  let files = {};
  if (roles[row.kind]) { files.mascote=[{}]; fields.match_photo_type=roles[row.kind]; }
  if (row.kind==='desc') Object.assign(fields,{photo_mode:'mascot_description',mascot_description:'urubu'});
  if (row.product==='patrocinador') files.patrocinadores=Array(row.kind==='many'?3:1);
  for (const option of row.options) {
    const order={...fields,futebol_scene:option.id};
    assert.equal(quote(row.product,order,files),option.cents);
    assert.equal(contract(option.id).resolution,'720p');
    assert.equal(contract(option.id).reference_mode,'initial_only');
    assert.equal(contract(option.id).prompt_version,'football_field_v2');
    assert.throws(()=>quote('escudo3d',order,files));
    for(const sport of ['Futsal','Futebol Society','Basquete','Vôlei','Tênis','Parkour personalizado'])
      assert.equal(quote(row.product,{...order,sport},files),option.cents);
    for(const sport of ['', '  ', null, undefined, {}, []])
      assert.throws(()=>quote(row.product,{...order,sport},files));
    if(row.kind==='many') assert.equal(quote(row.product,order,{patrocinadores:Array(18)}),option.cents+300);
    assert(option.cents>=1890 && option.cents+300<=2790);
  }
  assert.notEqual(row.options[0].cents,row.options[1].cents);
}
assert.equal(catalog.length,19);
assert.equal(new Set(catalog.flatMap(r=>r.options.map(o=>o.id))).size,38);
console.log('19 versões, 38 contratos. Cobranças e incompatibilidades verificadas.');

