"""Package the installed iA4Tube creative functions and verified templates; no orders or credentials."""
import argparse
import base64
import io
import os
import ast
import hashlib
from pathlib import Path
import re
import zipfile


def names(node):
    return {n.id for n in ast.walk(node) if isinstance(n, ast.Name)}


def assemble(worker, adapter):
    source = (worker / "resultado_pipeline.py").read_text("utf-8-sig")
    defs = {}
    for node in ast.parse(source).body:
        if isinstance(node, (ast.FunctionDef, ast.ClassDef)):
            defs[node.name] = node
        elif isinstance(node, ast.Assign) and isinstance(node.targets[0], ast.Name):
            defs[node.targets[0].id] = node
    exported = {n.attr for n in ast.walk(ast.parse(adapter.read_text("utf-8")))
                if isinstance(n, ast.Attribute) and isinstance(n.value, ast.Name) and n.value.id == "ia"}
    needed, pending = set(), list(exported)
    while pending:
        name = pending.pop()
        if name in needed or name in {"log", "load_api_key"} or name not in defs:
            continue
        needed.add(name)
        pending.extend(names(defs[name]) - needed)
    header = """from __future__ import annotations
import hashlib
import json
import re
import unicodedata
from pathlib import Path
from scenario_registry import (
    SCENARIO_CONTROL_ASSET, SCENARIO_CONTROL_ORIGINAL, SCENARIO_CONTROL_PROMPT,
    ScenarioRegistry, ScenarioRegistryError, ScenarioSelection, find_explicit_scene_conflict,
    load_scenario_registry, registry_filename_for_product, render_scenario_prompt_base,
    resolve_scenario, verify_selection_asset,
)
from mascot_rain_prompts import is_rain_mascot_order, load_rain_image_prompt
from text_service import request_text

def log(*args):
    pass

def sha256_file(path):
    with path.open("rb") as stream:
        digest = hashlib.sha256()
        for chunk in iter(lambda: stream.read(1024 * 1024), b""):
            digest.update(chunk)
        return digest.hexdigest()
"""
    out = [header]
    for name in sorted(needed, key=lambda k: defs[k].lineno):
        body = ast.get_source_segment(source, defs[name])
        if name in {"corrigir_linhas_texto", "gerar_descricao_instagram"}:
            body = body.replace("client = OpenAI(api_key=load_api_key())", "")
            body, count = re.subn(r'response = client\.responses\.create\(\s*model="gpt-5-mini",\s*input=prompt\s*\)',
                                  'text = request_text("gpt-5-mini", prompt)', body)
            if count != 1:
                raise ValueError("Unexpected desktop text API")
            body = body.replace("response.output_text.strip()", "text.strip()")
        if name == "find_existing":
            body = body.replace("if not name:", "if not name or '/' in name or chr(92) in name or ':' in name or Path(name).name != name:")
            body = body.replace("if p.exists() and p.is_file():", "if is_image_file(p):")
        if name == "is_image_file":
            body = body.replace("return path.is_file()", 'return bool(re.fullmatch(r"(?:escudo[12]|mascote|camiseta|referencia|foto[2-4]|pat[0-9]{2})[.]png", path.name)) and not path.is_symlink() and path.is_file()')
        out.append(body)
    return "\n\n".join(out).encode()


def pack(worker, dest):
    here = Path(__file__).resolve().parents[1] / "src/orders/catalog"
    recipe = assemble(worker, here / "build_request.py")
    entries = {"creative.py": recipe}
    registry = (worker / "scenario_registry.py").read_text("utf-8-sig")
    # The shipping registries have only original/prompt scenarios. Pillow is only needed for asset registries.
    registry = registry.replace("from PIL import Image\n", "").replace("        with Image.open(asset_path) as probe:",
        "        from PIL import Image\n        with Image.open(asset_path) as probe:")
    entries["scenario_registry.py"] = registry.encode()
    entries["mascot_rain_prompts.py"] = (worker / "mascot_rain_prompts.py").read_bytes()
    templates = set(re.findall(r'["\'](prompt_[a-z_0-9]+\.txt)["\']', recipe.decode()))
    templates.add("prompt_mascote_chuva.txt")
    for name in sorted(templates):
        if (worker / name).is_file():
            entries[name] = (worker / name).read_bytes()
    for suffix in ("", "_proximo_jogo", "_mascote_uniforme", "_escalacao", "_jogador_escudo"):
        name = "scenario_registry" + suffix + ".json"
        entries[name] = (worker / name).read_bytes()
    buffer = io.BytesIO()
    with zipfile.ZipFile(buffer, "w") as archive:
        for name, data in sorted(entries.items()):
            archive.writestr(zipfile.ZipInfo(name, (2026, 1, 1, 0, 0, 0)), data,
                             compress_type=zipfile.ZIP_DEFLATED, compresslevel=9)
    from cryptography.hazmat.primitives.ciphers.aead import AESGCM
    key = base64.b64decode(os.environ["IA4TUBE_CATALOG_PACK_KEY"], validate=True)
    nonce = os.urandom(12)
    dest.write_bytes(nonce + AESGCM(key).encrypt(nonce, buffer.getvalue(), None))
    print(len(entries), "files,", dest.stat().st_size, "bytes, sha256", hashlib.sha256(dest.read_bytes()).hexdigest())


if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    parser.add_argument("worker", type=Path)
    parser.add_argument("archive", type=Path)
    args = parser.parse_args()
    pack(args.worker, args.archive)
