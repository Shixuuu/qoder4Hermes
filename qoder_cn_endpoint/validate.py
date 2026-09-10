"""Structural checks for the Qoder CN custom-endpoint writeup and configs.

This is the shipped entry point used by tests and `python3 -m qoder_cn_endpoint`.
It reads the real README and example files; it does not re-implement a bridge.
"""

from __future__ import annotations

import json
import re
import sys
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any

FENCE_RE = re.compile(r"```([a-zA-Z0-9_+-]*)\n(.*?)```", re.DOTALL)

# Official CN public APIs documented on docs.qoder.cn — not chat-completions.
DOCUMENTED_CN_CLOUD_AGENTS = "https://api.qoder.com.cn/api/v1/cloud"
INVENTED_OFFICIAL_CHAT = "https://api.qoder.com.cn/v1/chat/completions"

REQUIRED_CLAIMS = (
    (
        "no_official_openai_inference",
        "does not publish a public OpenAI-compatible inference API",
    ),
    (
        "chat_completions_path_named",
        "/v1/chat/completions",
    ),
    (
        "custom_models_byok_into_qoder",
        "BYOK",
    ),
    (
        "opposite_direction",
        "opposite direction",
    ),
    (
        "local_bridge_method",
        "local OpenAI-compatible HTTP bridge",
    ),
    (
        "get_v1_models",
        "GET /v1/models",
    ),
    (
        "post_v1_chat_completions",
        "POST /v1/chat/completions",
    ),
    ("cn_host_qoder_com_cn", "qoder.com.cn"),
    ("cn_cli_qoderclicn", "qoderclicn"),
    (
        "cn_cli_pat_env",
        "QODERCN_PERSONAL_ACCESS_TOKEN",
    ),
    ("cn_cloud_pat_env", "QODER_PAT"),
    ("cn_api_host", "api.qoder.com.cn"),
    ("global_host_qoder_com", "qoder.com"),
    ("global_cli_qodercli", "qodercli"),
    ("global_api_host", "api.qoder.com"),
    ("unofficial_unsupported", "unofficial"),
    ("cloud_agents_not_inference", "Cloud Agents"),
)

REQUIRED_BRIDGES = (
    "lininn/qorder-proxy",
    "caigee-cmd/cli2api",
)


@dataclass
class Report:
    errors: list[str] = field(default_factory=list)
    notes: list[str] = field(default_factory=list)

    @property
    def ok(self) -> bool:
        return not self.errors

    def fail(self, message: str) -> None:
        self.errors.append(message)

    def note(self, message: str) -> None:
        self.notes.append(message)


def extract_code_fences(markdown: str) -> list[tuple[str, str]]:
    """Return (language, body) pairs from GitHub-flavored markdown fences."""
    return [(lang.lower(), body.strip("\n")) for lang, body in FENCE_RE.findall(markdown)]


def parse_simple_yaml(text: str) -> Any:
    """Parse the restricted YAML subset used by the Hermes example.

    Supports nested mappings, same-line empty maps (`{}`), quoted/unquoted
    scalars, and `#` comments. Not a general YAML implementation.
    """
    lines: list[tuple[int, str]] = []
    for raw in text.splitlines():
        stripped = raw.split("#", 1)[0].rstrip()
        if not stripped.strip():
            continue
        indent = len(stripped) - len(stripped.lstrip(" "))
        lines.append((indent, stripped.strip()))
    if not lines:
        return {}
    value, next_i = _parse_yaml_block(lines, 0, lines[0][0])
    if next_i != len(lines):
        raise ValueError(f"YAML parse stopped at line {next_i + 1}")
    return value


def _parse_yaml_block(lines: list[tuple[int, str]], i: int, indent: int) -> tuple[Any, int]:
    mapping: dict[str, Any] = {}
    while i < len(lines):
        line_indent, content = lines[i]
        if line_indent < indent:
            break
        if line_indent > indent:
            raise ValueError(f"Unexpected indent at {content!r}")
        if content.startswith("- "):
            raise ValueError("YAML lists are not used in the shipped Hermes example")
        if ":" not in content:
            raise ValueError(f"Expected mapping entry, got {content!r}")
        key, rest = content.split(":", 1)
        key = key.strip()
        rest = rest.strip()
        if rest == "{}":
            mapping[key] = {}
            i += 1
            continue
        if rest:
            mapping[key] = _parse_yaml_scalar(rest)
            i += 1
            continue
        if i + 1 < len(lines) and lines[i + 1][0] > indent:
            child, i = _parse_yaml_block(lines, i + 1, lines[i + 1][0])
            mapping[key] = child
        else:
            mapping[key] = {}
            i += 1
    return mapping, i


def _parse_yaml_scalar(value: str) -> Any:
    if (value.startswith('"') and value.endswith('"')) or (
        value.startswith("'") and value.endswith("'")
    ):
        return value[1:-1]
    if value in ("true", "false"):
        return value == "true"
    if value in ("null", "~"):
        return None
    return value


def load_json(text: str) -> Any:
    return json.loads(text)


def hermes_named_providers(config: dict[str, Any]) -> dict[str, dict[str, Any]]:
    providers = config.get("providers")
    if not isinstance(providers, dict) or not providers:
        raise ValueError("Hermes config missing providers.<name> mapping")
    out: dict[str, dict[str, Any]] = {}
    for name, entry in providers.items():
        if not isinstance(entry, dict):
            raise ValueError(f"providers.{name} must be a mapping")
        out[str(name)] = entry
    return out


def check_hermes_provider(name: str, entry: dict[str, Any], report: Report) -> None:
    base = entry.get("base_url") or entry.get("api") or entry.get("url")
    if "base_url" not in entry:
        report.fail(f"Hermes providers.{name} must set base_url (api/url aliases exist, but the shipped snippet uses base_url)")
    if not isinstance(base, str) or not base.rstrip("/").endswith("/v1"):
        report.fail(f"Hermes providers.{name}.base_url must end with /v1, got {base!r}")
    if "api_key" not in entry:
        report.fail(f"Hermes providers.{name} missing api_key")
    else:
        key = str(entry["api_key"])
        if key.startswith("pt-") or "QODER" in key.upper() and "TOKEN" in key.upper():
            report.fail("Hermes api_key must be a local placeholder, not the Qoder PAT")
        if not key.strip():
            report.fail("Hermes api_key placeholder must be non-empty")
    models = entry.get("models")
    if not isinstance(models, dict) or not models:
        report.fail(f"Hermes providers.{name} missing models mapping")
        return
    model_ids = {str(mid) for mid in models}
    if not any(mid.lower() in {"qwen3.8-max", "qwen3.8-max"} or "qwen3.8-max" in mid.lower() for mid in model_ids):
        report.fail(f"Hermes models must include a real Qoder CN id such as qwen3.8-max / Qwen3.8-Max, got {sorted(model_ids)}")


def check_opencode_config(config: dict[str, Any], report: Report) -> None:
    provider = config.get("provider")
    if not isinstance(provider, dict) or not provider:
        report.fail("OpenCode config missing provider mapping")
        return
    model_field = config.get("model")
    if not isinstance(model_field, str) or "/" not in model_field:
        report.fail("OpenCode model must be providerName/modelKey")
        return
    provider_name, model_key = model_field.split("/", 1)
    entry = provider.get(provider_name)
    if not isinstance(entry, dict):
        report.fail(f"OpenCode provider.{provider_name} missing (model is {model_field!r})")
        return
    if entry.get("npm") != "@ai-sdk/openai-compatible":
        report.fail("OpenCode provider.npm must be @ai-sdk/openai-compatible")
    options = entry.get("options")
    if not isinstance(options, dict):
        report.fail("OpenCode provider.options missing")
        return
    base = options.get("baseURL")
    if not isinstance(base, str) or not base.rstrip("/").endswith("/v1"):
        report.fail(f"OpenCode options.baseURL must end with /v1, got {base!r}")
    api_key = options.get("apiKey")
    if not isinstance(api_key, str) or not api_key.strip():
        report.fail("OpenCode options.apiKey must be a placeholder string")
    elif str(api_key).startswith("pt-"):
        report.fail("OpenCode apiKey must not be the Qoder PAT")
    models = entry.get("models")
    if not isinstance(models, dict) or model_key not in models:
        report.fail(f"OpenCode models must include key {model_key!r} from model field {model_field!r}")
    else:
        ids = {str(mid).lower() for mid in models}
        if "qwen3.8-max" not in ids:
            report.fail(f"OpenCode models must include qwen3.8-max / Qwen3.8-Max, got {sorted(models)}")


def plain_markdown(text: str) -> str:
    """Strip markdown emphasis so claim search matches the readable wording.

    Do not strip `_` globally — env names like QODER_PAT use underscores.
    """
    stripped = re.sub(r"\*\*([^*]+)\*\*", r"\1", text)
    stripped = re.sub(r"(?<![A-Za-z0-9])\*([^*]+)\*(?![A-Za-z0-9])", r"\1", stripped)
    stripped = stripped.replace("`", "")
    stripped = re.sub(r"\[([^\]]+)\]\([^)]+\)", r"\1", stripped)
    return stripped


def check_writeup_claims(text: str, report: Report) -> None:
    haystack = plain_markdown(text)
    for claim_id, needle in REQUIRED_CLAIMS:
        if needle.lower() not in haystack.lower():
            report.fail(f"writeup missing claim {claim_id}: {needle!r}")
    lower = haystack.lower()
    if "into qoder" not in lower and "into qoder cn" not in lower:
        report.fail("writeup must state official custom models is BYOK into Qoder")
    for name in REQUIRED_BRIDGES:
        if name not in text:
            report.fail(f"writeup must name existing CN-capable bridge {name}")
    if "127.0.0.1:3000" not in text and "http://127.0.0.1:3000/v1" not in text:
        report.fail("writeup must include lininn/qorder-proxy listen URL http://127.0.0.1:3000/v1")
    if "127.0.0.1:3010" not in text:
        report.fail("writeup must include caigee-cmd/cli2api listen URL on port 3010")
    if INVENTED_OFFICIAL_CHAT in text:
        window = _sentence_window(text, INVENTED_OFFICIAL_CHAT)
        if not re.search(r"\b(not|does not|do not|no |never|isn't|is not)\b", window, re.I):
            report.fail(
                "writeup mentions invented official chat-completions URL without denying it"
            )
    if DOCUMENTED_CN_CLOUD_AGENTS not in text:
        report.fail("writeup must cite Cloud Agents gateway https://api.qoder.com.cn/api/v1/cloud")
    if "qoder-cn plugin" in lower and "first-party" not in lower:
        report.note("writeup mentions a qoder-cn plugin; confirm it is not claimed as first-party")


def _sentence_window(text: str, needle: str) -> str:
    idx = text.find(needle)
    if idx < 0:
        return ""
    start = max(0, text.rfind(".", 0, idx) + 1)
    end = text.find(".", idx + len(needle))
    if end < 0:
        end = min(len(text), idx + 240)
    return text[start:end]


def check_writeup_fences(text: str, report: Report) -> tuple[dict[str, Any] | None, dict[str, Any] | None]:
    fences = extract_code_fences(text)
    hermes_cfg = None
    opencode_cfg = None
    for lang, body in fences:
        if lang in {"yaml", "yml"} and "providers:" in body and "base_url:" in body:
            try:
                parsed = parse_simple_yaml(body)
            except ValueError as exc:
                report.fail(f"writeup Hermes YAML fence failed to parse: {exc}")
                continue
            if isinstance(parsed, dict) and "providers" in parsed:
                hermes_cfg = parsed
                for name, entry in hermes_named_providers(parsed).items():
                    check_hermes_provider(name, entry, report)
        if lang == "json" and '"provider"' in body and "@ai-sdk/openai-compatible" in body:
            try:
                parsed = load_json(body)
            except json.JSONDecodeError as exc:
                report.fail(f"writeup OpenCode JSON fence failed to parse: {exc}")
                continue
            if isinstance(parsed, dict):
                opencode_cfg = parsed
                check_opencode_config(parsed, report)
    if hermes_cfg is None:
        report.fail("writeup missing copy-pasteable Hermes YAML fence with providers + base_url")
    if opencode_cfg is None:
        report.fail("writeup missing copy-pasteable OpenCode JSON fence with @ai-sdk/openai-compatible")
    return hermes_cfg, opencode_cfg


def validate_repo(root: Path) -> Report:
    report = Report()
    readme = root / "README.md"
    hermes_path = root / "examples" / "hermes-config.yaml"
    opencode_path = root / "examples" / "opencode.json"
    if not readme.is_file():
        report.fail(f"missing writeup {readme}")
        return report
    text = readme.read_text(encoding="utf-8")
    check_writeup_claims(text, report)
    check_writeup_fences(text, report)

    if not hermes_path.is_file():
        report.fail(f"missing {hermes_path}")
    else:
        try:
            hermes = parse_simple_yaml(hermes_path.read_text(encoding="utf-8"))
            for name, entry in hermes_named_providers(hermes).items():
                check_hermes_provider(name, entry, report)
        except ValueError as exc:
            report.fail(f"examples/hermes-config.yaml parse error: {exc}")

    if not opencode_path.is_file():
        report.fail(f"missing {opencode_path}")
    else:
        try:
            opencode = load_json(opencode_path.read_text(encoding="utf-8"))
            check_opencode_config(opencode, report)
        except json.JSONDecodeError as exc:
            report.fail(f"examples/opencode.json parse error: {exc}")
    return report


def main(argv: list[str] | None = None) -> int:
    args = list(sys.argv[1:] if argv is None else argv)
    root = Path(args[0]) if args else Path(__file__).resolve().parents[1]
    report = validate_repo(root)
    if report.notes:
        print("notes:")
        for note in report.notes:
            print(f"  - {note}")
    if report.ok:
        print(f"OK {root}")
        return 0
    print(f"FAIL {root}")
    for err in report.errors:
        print(f"  - {err}")
    return 1


if __name__ == "__main__":
    raise SystemExit(main())
