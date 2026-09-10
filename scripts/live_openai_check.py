#!/usr/bin/env python3
"""Hit a local OpenAI-compatible bridge: GET /v1/models and two chat completions."""

from __future__ import annotations

import argparse
import json
import sys
import urllib.error
import urllib.request
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

from qoder_cn_endpoint.live import assistant_text  # noqa: E402


def request_json(url: str, payload: dict | None = None, timeout: float = 180.0) -> dict:
    data = None
    headers = {"Accept": "application/json"}
    if payload is not None:
        raw = json.dumps(payload).encode("utf-8")
        data = raw
        headers["Content-Type"] = "application/json"
        headers["Authorization"] = "Bearer not-used"
    req = urllib.request.Request(url, data=data, headers=headers, method="GET" if payload is None else "POST")
    with urllib.request.urlopen(req, timeout=timeout) as resp:
        body = resp.read().decode("utf-8")
        return json.loads(body)


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--base-url", default="http://127.0.0.1:3000/v1")
    parser.add_argument("--model", default="qwen3.8-max")
    parser.add_argument("--out-dir", default="")
    args = parser.parse_args()
    base = args.base_url.rstrip("/")
    models = request_json(f"{base}/models", timeout=20)
    ids = [item.get("id") for item in models.get("data") or []]
    if args.model not in ids:
        print(f"model {args.model!r} not in {ids}", file=sys.stderr)
        return 1
    chat1 = request_json(
        f"{base}/chat/completions",
        {
            "model": args.model,
            "stream": False,
            "messages": [{"role": "user", "content": "Reply with the single word ALPHA and nothing else."}],
        },
    )
    chat2 = request_json(
        f"{base}/chat/completions",
        {
            "model": args.model,
            "stream": False,
            "messages": [{"role": "user", "content": "Reply with the single word BRAVO and nothing else."}],
        },
    )
    t1 = assistant_text(chat1)
    t2 = assistant_text(chat2)
    if args.out_dir:
        out = Path(args.out_dir)
        out.mkdir(parents=True, exist_ok=True)
        (out / "live-models.json").write_text(json.dumps(models, indent=2) + "\n", encoding="utf-8")
        (out / "live-chat-1.json").write_text(json.dumps(chat1, indent=2) + "\n", encoding="utf-8")
        (out / "live-chat-2.json").write_text(json.dumps(chat2, indent=2) + "\n", encoding="utf-8")
    print(json.dumps({"models": ids, "chat1": t1, "chat2": t2, "ok": True}))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
