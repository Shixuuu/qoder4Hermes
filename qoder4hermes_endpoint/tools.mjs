/**
 * Parse model tool markup into OpenAI tool_calls. Hermes executes tools;
 * this layer only translates.
 */
import crypto from "node:crypto";

const INVOKE_SPLIT = /<\s*[|｜]*\s*DSML\s*[|｜]*\s*invoke\b/i;
const PARAM_RE =
  /parameter\s+name="([^"]+)"[^>]*>([\s\S]*?)<\s*\/\s*[|｜]*\s*DSML\s*[|｜]*\s*parameter/gi;
const QWEN_TOOL_RE = /<tool_call>\s*([\s\S]*?)\s*<\/tool_call>/gi;

export function looksLikeToolMarkup(text) {
  if (!text) return false;
  return /DSML|<\s*tool_call\b|invoke\s+name=/i.test(text);
}

function newCallId() {
  return "call_" + crypto.randomBytes(6).toString("hex");
}

function asToolCall(name, argsObj) {
  return {
    id: newCallId(),
    type: "function",
    function: {
      name,
      arguments: JSON.stringify(argsObj ?? {}),
    },
  };
}

export function parseDsmlToolCalls(text) {
  if (!text || !/DSML/i.test(text)) return [];
  const calls = [];
  const parts = String(text).split(INVOKE_SPLIT);
  for (const part of parts.slice(1)) {
    const nameMatch = part.match(/name="([^"]+)"/);
    if (!nameMatch) continue;
    const args = {};
    PARAM_RE.lastIndex = 0;
    let pm;
    const chunk = part;
    while ((pm = PARAM_RE.exec(chunk))) {
      args[pm[1]] = String(pm[2]).trim();
    }
    calls.push(asToolCall(nameMatch[1], args));
  }
  return calls;
}

export function parseQwenToolCalls(text) {
  if (!text || !/<tool_call>/i.test(text)) return [];
  const calls = [];
  QWEN_TOOL_RE.lastIndex = 0;
  let m;
  while ((m = QWEN_TOOL_RE.exec(text))) {
    const body = m[1].trim();
    try {
      const obj = JSON.parse(body);
      const name = obj.name || obj.tool || "";
      if (!name) continue;
      const args = obj.arguments ?? obj.params ?? obj;
      const cleaned = { ...args };
      delete cleaned.name;
      delete cleaned.tool;
      calls.push(asToolCall(name, typeof args === "string" ? { value: args } : cleaned));
    } catch {
      const lines = body.split("\n").map((l) => l.trim()).filter(Boolean);
      if (lines[0]) calls.push(asToolCall(lines[0], { raw: lines.slice(1).join("\n") }));
    }
  }
  return calls;
}

export function parseToolMarkup(text) {
  const dsml = parseDsmlToolCalls(text);
  if (dsml.length) return dsml;
  return parseQwenToolCalls(text);
}

export function openaiToolCallDeltas(calls) {
  return calls.map((call, index) => ({
    index,
    id: call.id,
    type: "function",
    function: {
      name: call.function.name,
      arguments: call.function.arguments,
    },
  }));
}


