"""Parse OpenAI-compatible chat.completion bodies from a local CN bridge."""

from __future__ import annotations


def assistant_text(chat: dict) -> str:
    choices = chat.get("choices") or []
    if not choices:
        raise ValueError("chat completion missing choices")
    message = choices[0].get("message") or {}
    content = message.get("content")
    if not isinstance(content, str) or not content.strip():
        raise ValueError("assistant content empty")
    return content.strip()
