"""Drive the shipped validator against the real writeup and example configs."""

from __future__ import annotations

import json
import shutil
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

from qoder_cn_endpoint.validate import (  # noqa: E402
    INVENTED_OFFICIAL_CHAT,
    plain_markdown,
    check_hermes_provider,
    check_opencode_config,
    extract_code_fences,
    hermes_named_providers,
    load_json,
    parse_simple_yaml,
    validate_repo,
)


class ValidateRepoTests(unittest.TestCase):
    def test_shipped_entry_point_accepts_this_repo(self) -> None:
        report = validate_repo(ROOT)
        self.assertTrue(report.ok, "\n".join(report.errors))

    def test_module_cli_exits_zero(self) -> None:
        proc = subprocess.run(
            [sys.executable, "-m", "qoder_cn_endpoint", str(ROOT)],
            cwd=str(ROOT),
            capture_output=True,
            text=True,
            check=False,
        )
        self.assertEqual(proc.returncode, 0, proc.stdout + proc.stderr)
        self.assertIn("OK", proc.stdout)

    def test_validator_fails_when_bridge_method_removed(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            dest = Path(tmp)
            shutil.copytree(ROOT / "examples", dest / "examples")
            shutil.copy(ROOT / "README.md", dest / "README.md")
            readme = dest / "README.md"
            readme.write_text(
                readme.read_text(encoding="utf-8").replace(
                    "without spawning",
                    "by wrapping",
                ),
                encoding="utf-8",
            )
            report = validate_repo(dest)
            self.assertFalse(report.ok)
            self.assertTrue(
                any("no_cli_spawn" in err or "local_bridge_method" in err for err in report.errors),
                report.errors,
            )

    def test_writeup_denies_invented_official_chat_url(self) -> None:
        text = (ROOT / "README.md").read_text(encoding="utf-8")
        self.assertIn(INVENTED_OFFICIAL_CHAT, text)
        plain = plain_markdown(text)
        self.assertIn(
            "does not publish a public OpenAI-compatible inference API",
            plain,
        )
        self.assertIn("into Qoder", plain)


class HermesExampleTests(unittest.TestCase):
    def test_example_file_shape(self) -> None:
        raw = (ROOT / "examples" / "hermes-config.yaml").read_text(encoding="utf-8")
        cfg = parse_simple_yaml(raw)
        providers = hermes_named_providers(cfg)
        self.assertIn("qoder-cn-local", providers)
        errors: list[str] = []

        class _R:
            def fail(self, message: str) -> None:
                errors.append(message)

        check_hermes_provider("qoder-cn-local", providers["qoder-cn-local"], _R())  # type: ignore[arg-type]
        self.assertEqual(errors, [])
        entry = providers["qoder-cn-local"]
        self.assertTrue(str(entry["base_url"]).endswith("/v1"))
        self.assertIn("api_key", entry)
        self.assertIn("models", entry)

    def test_writeup_fence_parses_as_hermes_provider(self) -> None:
        text = (ROOT / "README.md").read_text(encoding="utf-8")
        yaml_fences = [body for lang, body in extract_code_fences(text) if lang in {"yaml", "yml"}]
        matching = [b for b in yaml_fences if "providers:" in b and "base_url:" in b]
        self.assertTrue(matching, "README must contain a Hermes providers YAML fence")
        cfg = parse_simple_yaml(matching[0])
        providers = hermes_named_providers(cfg)
        name, entry = next(iter(providers.items()))
        self.assertTrue(str(entry.get("base_url")).endswith("/v1"))
        self.assertIn("api_key", entry)
        self.assertTrue(any("qwen3.8-max" in str(m).lower() for m in entry["models"]))
        self.assertNotEqual(name, "qoder-cn")  # not a fake first-party plugin id used as npm package


class OpenCodeExampleTests(unittest.TestCase):
    def test_example_file_shape(self) -> None:
        cfg = load_json((ROOT / "examples" / "opencode.json").read_text(encoding="utf-8"))
        errors: list[str] = []

        class _R:
            def fail(self, message: str) -> None:
                errors.append(message)

        check_opencode_config(cfg, _R())  # type: ignore[arg-type]
        self.assertEqual(errors, [])
        self.assertEqual(cfg["model"], "qoder-cn-local/qwen3.8-max")
        provider = cfg["provider"]["qoder-cn-local"]
        self.assertEqual(provider["npm"], "@ai-sdk/openai-compatible")
        self.assertTrue(provider["options"]["baseURL"].endswith("/v1"))
        self.assertIn("apiKey", provider["options"])

    def test_writeup_json_fence_is_openai_compatible_provider(self) -> None:
        text = (ROOT / "README.md").read_text(encoding="utf-8")
        json_fences = [body for lang, body in extract_code_fences(text) if lang == "json"]
        matching = [b for b in json_fences if "@ai-sdk/openai-compatible" in b]
        self.assertTrue(matching, "README must contain an OpenCode JSON fence")
        cfg = json.loads(matching[0])
        self.assertIn("/", cfg["model"])
        provider_name, model_key = cfg["model"].split("/", 1)
        entry = cfg["provider"][provider_name]
        self.assertEqual(entry["npm"], "@ai-sdk/openai-compatible")
        self.assertTrue(entry["options"]["baseURL"].endswith("/v1"))
        self.assertIn("apiKey", entry["options"])
        self.assertIn(model_key, entry["models"])


class YamlParserTests(unittest.TestCase):
    def test_empty_model_maps(self) -> None:
        parsed = parse_simple_yaml(
            "providers:\n  x:\n    base_url: http://127.0.0.1:8787/v1\n    models:\n      qwen3.8-max: {}\n"
        )
        self.assertEqual(parsed["providers"]["x"]["models"]["qwen3.8-max"], {})


if __name__ == "__main__":
    unittest.main()
