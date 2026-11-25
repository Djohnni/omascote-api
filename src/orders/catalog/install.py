"""Expand the authenticated desktop release into a private process directory and verify its catalog."""
import io
import json
from pathlib import Path
import sys
from zipfile import ZipFile

directory = Path(sys.argv[1]).resolve()
with ZipFile(io.BytesIO(sys.stdin.buffer.read())) as z:
    for info in z.infolist():
        if Path(info.filename).name != info.filename or info.file_size > 2_000_000:
            raise ValueError("invalid entry")
        (directory / info.filename).write_bytes(z.read(info))
sys.path.insert(0, str(directory))
import creative as ia

for product in ("resultado", "escalacao", "proximo_jogo", "mascote_uniforme"):
    model = ia.normalize_pedido_for_pipeline({"schema_version": 2, "product_id": product, "categoria": product})
    registry, _ = ia.resolve_product_scenario_for_order(model)
    for scenario in json.loads((directory / ia.registry_filename_for_product(product)).read_bytes())["scenarios"]:
        selected = ia.resolve_scenario(registry, scenario["id"], "explicit", 1)
        prompt, _, _ = ia.load_prompt_base_for_order(model["legacy"], [], model, selected)
        ia.render_scenario_prompt_base(prompt, selected)
for product in ("escudo3d", "contratacao", "patrocinador", "proximo_jogo_jogador", "resultado_jogo_jogador"):
    assert ia.PROMPT_FILES[product].stat().st_size > 0
