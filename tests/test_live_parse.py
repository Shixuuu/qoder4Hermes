"""Parse captured live OpenAI chat.completion bodies from the CN bridge."""

from __future__ import annotations

import json
import sys
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

from qoder_cn_endpoint.live import assistant_text  # noqa: E402

FIXTURES = ROOT / "tests" / "fixtures"


class LiveParseTests(unittest.TestCase):
    def test_captured_chat_bodies_have_assistant_text(self) -> None:
        for name, expected in (("live-chat-1.json", "ALPHA"), ("live-chat-2.json", "BRAVO")):
            data = json.loads((FIXTURES / name).read_text(encoding="utf-8"))
            self.assertEqual(assistant_text(data), expected)
            self.assertEqual(data["object"], "chat.completion")
            self.assertEqual(data["model"], "qwen3.8-max")

    def test_rejects_empty_assistant(self) -> None:
        with self.assertRaises(ValueError):
            assistant_text({"choices": [{"message": {"role": "assistant", "content": "   "}}]})


if __name__ == "__main__":
    unittest.main()
