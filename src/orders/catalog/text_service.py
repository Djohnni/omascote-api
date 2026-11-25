"""Text correction and captions within the desktop still-image workflow."""
import json
import os
from urllib.request import Request, urlopen


def request_text(model, prompt):
    key = os.environ.get("PLAYER_CREST_OPENAI_API_KEY", "").strip()
    if not key:
        raise ValueError("credencial_indisponivel")
    data = json.dumps({"model": model, "input": prompt}).encode()
    req = Request("https://api.openai.com/v1/responses", data=data,
                  headers={"Authorization": "Bearer " + key, "Content-Type": "application/json"})
    with urlopen(req, timeout=25) as response:
        body = json.load(response)
    return "".join(part["text"] for item in body.get("output", []) for part in item.get("content", [])
                   if part.get("type") == "output_text")
