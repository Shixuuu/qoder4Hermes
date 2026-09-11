# Qoder CN model inference inside Hermes / OpenCode (not the Qoder CLI harness)

Qoder CN does **not** publish a public OpenAI-compatible inference API (`/v1/chat/completions`) for bundled models. There is no supported `https://api.qoder.com.cn/v1/chat/completions`. Official **自定义模型 / custom models** is BYOK **into** Qoder (the **opposite direction**). **Cloud Agents** at `https://api.qoder.com.cn/api/v1/cloud` is a hosted agent sandbox, not raw completions.

This repo exposes a **local OpenAI-compatible HTTP** facade that calls the **same CN model transport `qoderclicn` uses internally**, **without spawning** `qoderclicn` / `qodercn` / `qodercli`. Hermes or OpenCode is the only agent harness: they send `messages` (including `system`); this process does one model turn and returns assistant text. It does not run Qoder Read/Bash/agent tools.

This is **unofficial** and unsupported.

## What the CLI actually calls (CN)

From the installed `qoderclicn` 1.1.48 binary and a live login:

| Step | URL |
| --- | --- |
| PAT → jobToken | `POST https://openapi.qoder.com.cn/api/v1/jobToken/exchange` |
| Userinfo | `GET https://openapi.qoder.com.cn/api/v1/userinfo` |
| Model catalog | `GET https://gateway.qoder.com.cn/algo/api/v2/model/list?Encode=1` |
| Completion SSE | `POST https://gateway.qoder.com.cn/algo/api/v2/service/pro/sse/agent_chat_generation` |

Global `https://api2-v2.qoder.sh/model/v1/chat/completions` **401s** CN jobTokens. Use the **CN** stack (`qoder.com.cn` / `qoderclicn` / `QODERCN_PERSONAL_ACCESS_TOKEN` or `QODER_PAT` on `api.qoder.com.cn` / `openapi.qoder.com.cn`), not `qoder.com` / `qodercli` / `api.qoder.com`.

CLI login file `~/.qoder-cn/.auth/user` (AES-128-CBC, `machine_id[:16]`) already contains `pt-` and `jt-` after `qoderclicn login`.

## Run the facade

The facade serves `GET /v1/models` and `POST /v1/chat/completions`.

```bash
node qoder_cn_endpoint/server.mjs
# GET  http://127.0.0.1:8787/v1/models
# POST http://127.0.0.1:8787/v1/chat/completions
```

Auth: existing `qoderclicn` login, or `export QODERCN_PERSONAL_ACCESS_TOKEN=pt-...` / `QODER_PAT`.

Do **not** put the Qoder PAT in Hermes/OpenCode. Client API key is a placeholder (`not-used`).

## Hermes Agent

```yaml
model:
  default: qwen3.8-max
  provider: custom:qoder-cn-local

providers:
  qoder-cn-local:
    name: Qoder CN (inference facade)
    base_url: http://127.0.0.1:8787/v1
    api_key: not-used
    transport: chat_completions
    models:
      qwen3.8-max: {}
      Qwen3.8-Max: {}
```

## OpenCode

```json
{
  "$schema": "https://opencode.ai/config.json",
  "model": "qoder-cn-local/qwen3.8-max",
  "provider": {
    "qoder-cn-local": {
      "npm": "@ai-sdk/openai-compatible",
      "name": "Qoder CN (inference facade)",
      "options": {
        "baseURL": "http://127.0.0.1:8787/v1",
        "apiKey": "not-used"
      },
      "models": {
        "qwen3.8-max": {
          "name": "Qwen3.8-Max"
        },
        "Qwen3.8-Max": {
          "name": "Qwen3.8-Max (display id)"
        }
      }
    }
  }
}
```

## Checks

```bash
python3 -m qoder_cn_endpoint
python3 -m unittest discover -s tests -v
node --test tests/test_cn_complete.mjs
```
