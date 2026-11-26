"""Assemble one still image with the creative engine shipped by the desktop app."""
import json
from pathlib import Path
import sys

import creative as ia
from mascot_location import explicit_mascot_location, override_mascot_location


def prepare(base, order):
    model = ia.normalize_pedido_for_pipeline(order)
    legacy = model["legacy"]
    custom_location = explicit_mascot_location(model)
    registry = selection = None
    if not custom_location and not (ia.is_rain_mascot_order(model) or ia.is_nonfootball_order(model)):
        registry, selection = ia.resolve_product_scenario_for_order(model)

    if ia.is_clean_product_enabled(model):
        lines = ia.build_clean_product_text_lines(model)
        collect = ia.build_clean_product_reference_images
    elif ia.is_clean_result_product(model):
        lines = ia.build_clean_result_text_lines(model)
        collect = ia.build_clean_result_reference_images
    elif ia.is_clean_structured_product(model):
        lines = ia.build_clean_structured_text_lines(model)
        collect = ia.build_clean_structured_reference_images
    else:
        lines = ia.build_text_lines(legacy)
        collect = None

    title, title_key = ia.get_titulo_secao_arte(model)
    lines = ia.aplicar_titulo_secao_arte(ia.corrigir_linhas_texto(lines), title)
    prompt, _, _ = ia.load_prompt_base_for_order(legacy, lines, model, selection)
    if selection is not None:
        prompt, _ = ia.render_scenario_prompt_base(prompt, selection)
    prompt = override_mascot_location(prompt, model)

    adjustment = ia.ler_motivo_ajuste(base, legacy)
    ia.enforce_scenario_observation_policy(registry, selection, ia.get_customer_notes(model), adjustment)
    prompt = ia.build_final_image_prompt(
        prompt, ia.build_bloco_titulo_secao_arte(title, title_key), ia.build_adjustment_block(adjustment),
        ia.build_visual_style_block(model), "\n".join(lines), ia.build_customer_notes_block(model),
        ia.build_resultado_absence_guard(model), model,
    )
    prompt += ia.build_contratacao_order_block(model)
    if not custom_location:
        prompt += ia.build_multisport_order_block(model)

    layout = base / "_resultado_api_temp" / "texto_referencia_chatgpt.png"
    refs = collect(base, model, layout) if collect else ia.build_reference_images(base, legacy, layout, order_model=model)
    refs, slot, _ = ia._apply_product_scenario_slot_with_audit(refs, selection)
    if custom_location:
        roles = ia.build_reference_roles(base, model, refs, slot)
        identity_refs = [(reference, role) for reference, role in zip(refs, roles, strict=True) if role != "scene_reference"]
        refs = [reference for reference, _ in identity_refs]
        roles = [role for _, role in identity_refs]
        ia.validate_reference_sources(base, refs)
    else:
        ia.validate_reference_sources(base, refs)
        roles = ia.build_reference_roles(base, model, refs, slot)
    ia.validate_reference_role_consistency(refs, roles)
    prompt = ia.append_reference_usage_instructions(prompt, model, roles, allowed_text_lines=lines)
    prompt = override_mascot_location(prompt, model)
    return dict(prompt=prompt, lines=lines, refs=[p.name for p in refs], roles=roles,
                quality=ia.image_quality_for_order(legacy), model=ia.MODEL, size=ia.SIZE)


if __name__ == "__main__":
    payload = json.load(sys.stdin.buffer)
    if sys.argv[1] == "caption":
        result = ia.gerar_descricao_instagram(ia.normalize_pedido_for_pipeline(payload["order"]), payload["lines"])
    else:
        result = prepare(Path(sys.argv[2]).resolve(), payload["order"])
    sys.stdout.buffer.write(json.dumps(result, ensure_ascii=False).encode("utf-8"))
