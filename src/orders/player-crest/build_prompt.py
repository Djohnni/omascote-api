"""Build the production desktop image prompt for one player and one crest."""
import json
from pathlib import Path
import sys

from prompt import (
    build_adjustment_block, build_customer_notes_block, build_final_image_prompt,
    build_multisport_order_block, build_visual_style_block, is_nonfootball_order,
    normalize_text,
)

ROOT = Path(__file__).parent


COMPOSITION_RULES = "\n\nREGRAS OBRIGATÓRIAS DE COMPOSIÇÃO — JOGADOR + ESCUDO:\n- MOSTRE O JOGADOR UMA ÚNICA VEZ. Use apenas o recorte principal da foto original, mantendo rosto, pose e uniforme. Não repita o jogador nem o rosto no fundo: sem retrato ampliado, sombra com a silhueta do jogador, montagem ou dupla exposição. O fundo deve mostrar apenas o ambiente escolhido, sem cópia do atleta.\n- MANTENHA O ESCUDO ORIGINAL INTEIRO E VISÍVEL. Posicione o escudo separado do jogador, ao lado dele, com espaço livre entre os dois. Nenhuma parte do corpo, mão, uniforme, texto, borda da imagem ou efeito pode cobrir qualquer parte do escudo. O contorno e todas as letras, números e detalhes devem estar visíveis e legíveis desde o primeiro quadro. Se faltar espaço, reposicione ou redimensione o escudo proporcionalmente. Nunca recorte, distorça, redesenhe ou complete o escudo.\n- FIDELIDADE DO ESCUDO É PRIORIDADE MÁXIMA. Use o arquivo original do escudo inteiro como elemento gráfico importado, nunca uma versão desenhada pela IA. Compare a arte com o arquivo antes de finalizar: mantenha exatamente a quantidade de estrelas, inclusive zero, e preserve a posição, o tamanho relativo, o formato e a cor de cada uma, mesmo quando estiver acima ou fora do contorno. Preserve também letras pequenas, datas, monogramas, linhas finas, bordas, símbolos, espaços vazados e cores. Não acrescente, remova, mova, substitua, simplifique ou reconstrua nenhum detalhe. Não aplique iluminação, textura ou efeito por cima do escudo. Para integrá-lo, só reposicione ou redimensione o arquivo inteiro proporcionalmente e aplique sombra ou brilho por fora, sem sobrepor ou apagar nenhum detalhe. Se a referência for pouco nítida, use o arquivo como está; não invente o que não dá para ler."

def render(order):
    fields = order.get("fields") or {}
    model = dict(product_id="jogador_escudo", fields=fields, assets=order.get("assets") or {},
                 raw=order, legacy={**order, **(order.get("legacy") or {})})
    players = fields.get("players") or order.get("jogadores") or [{}]
    name = normalize_text(fields.get("player_name") or players[0].get("nome") or order.get("data"))
    if not name:
        raise ValueError("Nome do jogador ausente")
    other_sport = is_nonfootball_order(model)
    filename = "prompt_multiesportes.txt" if other_sport else "prompt_jogador_escudo.txt"
    base = (ROOT / filename).read_bytes().decode("utf-8").strip()
    if not other_sport:
        scenarios = json.loads((ROOT / "backgrounds.json").read_text(encoding="utf-8"))
        scenario = fields.get("scenario_id") or order.get("scenario_id") or "jogador_escudo_atual_v1"
        background = scenarios[scenario]
        if background:
            original, = (line for line in base.splitlines() if line.startswith("Visual desejado:"))
            base = base.replace(original, background)
    prompt = build_final_image_prompt(
        base, "", build_adjustment_block(order.get("motivo_ajuste") or ""),
        build_visual_style_block(model), name, build_customer_notes_block(model), "", model,
    )
    prompt += build_multisport_order_block(model)
    references = "reference-other.txt" if other_sport else "reference-football.txt"
    suffix = (ROOT / references).read_text(encoding="utf-8")
    return prompt + suffix.replace('["__PLAYER_LITERAL__"]', json.dumps([name], ensure_ascii=False)) + COMPOSITION_RULES


if __name__ == "__main__":
    sys.stdout.buffer.write(render(json.load(sys.stdin.buffer)).encode("utf-8"))
