'use strict';

function create(catalog) {
const rows = new Map(catalog.flatMap(row => row.options.map(option => [option.id, { row, option }])));
const count = items => Array.isArray(items) ? items.length : 0;

function details(product, fields, uploads) {
  if (product === 'patrocinador') {
    const logos = count(uploads.patrocinadores);
    if (!logos) throw new Error('Envie pelo menos uma marca de patrocinador.');
    return { kind: logos > 1 ? 'many' : 'one', extra: Math.min(3, Math.floor(logos / 4)) };
  }
  if (product === 'contratacao') {
    const type = String(fields.announcement_type || '').toLowerCase();
    if (!['contratado', 'renovado'].includes(type)) throw new Error('Confira o anúncio do atleta.');
    return { kind: type === 'renovado' ? 'renew' : 'hired', extra: fields.jersey_enabled === true ? 2 : 0 };
  }
  if (product === 'escalacao') {
    const names = count(fields.players);
    return { kind: count(uploads.mascote) ? 'team' : 'bare', extra: Math.min(3, Math.floor(Math.max(0, names - 10) / 3)) };
  }
  if (['proximo_jogo', 'resultado'].includes(product)) {
    const roles = { mascot_photo: 'mask', team_photo: 'team', player_photo: 'person' };
    const kind = count(uploads.mascote) ? roles[fields.match_photo_type] :
      fields.photo_mode === 'mascot_description' && String(fields.mascot_description || '').trim() ? 'desc' : 'bare';
    return { kind, extra: Math.min(3, Math.floor(count(fields.scorers) / 3)) };
  }
  return { kind: 'ath', extra: 0 };
}

function quote(product, fields, uploads) {
  const entry = rows.get(fields.futebol_scene);
  if (!entry || entry.row.product !== product || fields.delivery_mode !== 'image_video' ||
      fields.video_model !== 'omni' || typeof fields.sport !== 'string' || !fields.sport.trim()) {
    throw new Error('Escolha uma cena válida para este produto e informe a modalidade.');
  }
  const { kind, extra } = details(product, fields, uploads);
  if (kind !== entry.row.kind) throw new Error('A cena escolhida não corresponde aos dados ou fotos do pedido.');
  return entry.option.cents + extra * 100;
}

function contract(sceneId) {
  return { requested: true, commercial: true, internal_test: false, delivery_mode: 'image_video',
    model: 'omni', model_id: 'gemini-omni-1.2-flash', provider: 'google_vertex_ai', location: 'global',
    duration_seconds: 10, resolution: '720p', aspect_ratio: '9:16', generate_audio: true,
    reference_mode: 'initial_only', prompt_version: 'football_field_v2',
    first_last_frame_same: false, scene_id: sceneId, status: 'pending', requested_at: new Date().toISOString() };
}

return { catalog, quote, contract, details };
}

if (typeof module === 'object' && module.exports) module.exports = create(require('./catalog.json'));
else window.createFutebolCatalog = create;

