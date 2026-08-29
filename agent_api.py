"""OpenAI-compatible LLM adapter for StackPilot.

Only compact analysis evidence is accepted. User supplied credentials are used
for the current request and are never persisted by the server.
"""

from __future__ import annotations

import ipaddress
import json
import os
import re
import socket
import urllib.error
import urllib.request
from urllib.parse import urlparse


DEFAULT_BASE_URL = "https://api.openai.com/v1"
DEFAULT_MODEL = "gpt-5-mini"
MAX_CONTEXT_BYTES = 900_000

AGENT_SCHEMA = {
    "type": "object",
    "additionalProperties": False,
    "properties": {
        "summary": {"type": "string"},
        "findings": {
            "type": "array",
            "maxItems": 5,
            "items": {
                "type": "object",
                "additionalProperties": False,
                "properties": {
                    "severity": {"type": "string", "enum": ["info", "attention", "risk"]},
                    "title": {"type": "string"},
                    "evidence": {"type": "string"},
                    "recommendation": {"type": "string"},
                },
                "required": ["severity", "title", "evidence", "recommendation"],
            },
        },
        "answer": {"type": "string"},
        "limitations": {"type": "array", "items": {"type": "string"}, "maxItems": 5},
    },
    "required": ["summary", "findings", "answer", "limitations"],
}

INSTRUCTIONS = """你是 StackPilot 燃料电池电堆测试分析助手。请解释确定性引擎已经计算出的证据、发现值得复核的模式，并给出可执行的下一步建议。

要求：
1. 只使用输入 JSON 中的证据，不补造原始数据、目标工况、阈值、标准条款或故障结论。
2. 数值计算与平台判定以确定性引擎为准，只负责解释、关联和建议。
3. “均值最低”或“离均差最大”不等于故障；没有阈值时必须说明仅建议复核。
4. 缺少目标工况表、内阻或必要信号时，相关符合性保持“未判定”。
5. 使用简洁、专业的中文；每条发现引用可核验的数值或平台编号。
6. 返回严格 JSON，不要 Markdown，字段必须为 summary、findings、answer、limitations。
"""


def _server_config() -> dict:
    return {
        "baseUrl": os.environ.get("LLM_BASE_URL") or os.environ.get("OPENAI_BASE_URL") or DEFAULT_BASE_URL,
        "apiKey": os.environ.get("LLM_API_KEY") or os.environ.get("OPENAI_API_KEY") or "",
        "model": os.environ.get("LLM_MODEL") or os.environ.get("OPENAI_MODEL") or DEFAULT_MODEL,
    }


def api_status() -> dict:
    config = _server_config()
    return {
        "available": bool(config["apiKey"]),
        "model": config["model"] if config["apiKey"] else None,
        "provider": "OpenAI Compatible API",
        "customConfigSupported": True,
    }


def _validate_endpoint(base_url: str) -> str:
    value = str(base_url or "").strip().rstrip("/")
    if not value or len(value) > 512:
        raise ValueError("AI 接口地址无效")
    parsed = urlparse(value)
    if parsed.scheme not in {"http", "https"} or not parsed.hostname or parsed.username or parsed.password or parsed.query or parsed.fragment:
        raise ValueError("AI 接口地址必须是有效的 HTTP(S) 地址")
    local_hosts = {"localhost", "127.0.0.1", "::1"}
    is_local = parsed.hostname in local_hosts
    allow_private = os.environ.get("ALLOW_PRIVATE_LLM", "").lower() in {"1", "true", "yes"}
    private_target = is_local

    if not is_local:
        try:
            for info in socket.getaddrinfo(parsed.hostname, parsed.port or 443, type=socket.SOCK_STREAM):
                if not ipaddress.ip_address(info[4][0]).is_global:
                    private_target = True
        except socket.gaierror as error:
            raise ValueError("无法解析 AI 接口地址") from error

    if private_target and not allow_private:
        raise ValueError("AI 接口地址不能指向内网或保留地址")
    if parsed.scheme == "http" and not private_target:
        raise ValueError("公网 AI 接口必须使用 HTTPS")

    if value.endswith("/chat/completions"):
        return value
    if value.endswith("/v1"):
        return f"{value}/chat/completions"
    return f"{value}/v1/chat/completions"


def _request_config(payload: dict) -> dict:
    server = _server_config()
    supplied = payload.get("llmConfig") if isinstance(payload.get("llmConfig"), dict) else {}
    if supplied:
        api_key = str(supplied.get("apiKey") or "").strip()
        model = str(supplied.get("model") or "").strip()
        base_url = str(supplied.get("baseUrl") or "").strip()
    else:
        api_key = str(server["apiKey"]).strip()
        model = str(server["model"]).strip()
        base_url = str(server["baseUrl"]).strip()
    if not api_key:
        raise RuntimeError("请先配置 AI API Key")
    if not model or len(model) > 160:
        raise ValueError("AI 模型名称无效")
    return {"endpoint": _validate_endpoint(base_url), "apiKey": api_key, "model": model}


def _post_json(endpoint: str, api_key: str, body: dict) -> dict:
    request = urllib.request.Request(
        endpoint,
        data=json.dumps(body, ensure_ascii=False).encode("utf-8"),
        headers={"Authorization": f"Bearer {api_key}", "Content-Type": "application/json"},
        method="POST",
    )
    try:
        with urllib.request.urlopen(request, timeout=55) as response:
            return json.loads(response.read().decode("utf-8"))
    except urllib.error.HTTPError as error:
        try:
            raw = json.loads(error.read().decode("utf-8"))
            detail = raw.get("error", {}).get("message") or raw.get("message")
        except Exception:
            detail = None
        failure = RuntimeError(detail or f"AI 接口返回 HTTP {error.code}")
        failure.status = error.code
        raise failure from error
    except urllib.error.URLError as error:
        raise RuntimeError(f"无法连接 AI 接口：{error.reason}") from error


def _extract_content(response: dict) -> str:
    choices = response.get("choices") or []
    if not choices:
        return ""
    choice = choices[0] if isinstance(choices[0], dict) else {}
    content = (choice.get("message") or {}).get("content")
    if isinstance(content, str):
        return content
    if isinstance(content, list):
        return "".join(str(part.get("text") or "") for part in content if isinstance(part, dict))
    if isinstance(content, dict):
        return str(content.get("text") or content.get("content") or json.dumps(content, ensure_ascii=False))
    return str(choice.get("text") or "")


def _find_json_object(text: str) -> dict | None:
    cleaned = re.sub(r"<think\b[^>]*>.*?</think>", "", text, flags=re.IGNORECASE | re.DOTALL).strip().lstrip("\ufeff")
    if cleaned.startswith("```"):
        cleaned = re.sub(r"^```(?:json)?\s*", "", cleaned, flags=re.IGNORECASE)
        cleaned = re.sub(r"\s*```$", "", cleaned)

    candidates = [cleaned]
    candidates.extend(cleaned[index:] for index, char in enumerate(cleaned) if char == "{")
    decoder = json.JSONDecoder()
    for candidate in candidates:
        try:
            value, _ = decoder.raw_decode(candidate.strip())
            if isinstance(value, str):
                value = json.loads(value)
            if isinstance(value, dict):
                return value
        except (json.JSONDecodeError, TypeError):
            continue
    return None


def _parse_json_result(text: str) -> dict:
    cleaned = re.sub(r"<think\b[^>]*>.*?</think>", "", str(text or ""), flags=re.IGNORECASE | re.DOTALL).strip()
    if not cleaned:
        raise RuntimeError("AI 接口未返回可展示内容")
    result = _find_json_object(cleaned)
    if result is None:
        plain = re.sub(r"^```(?:markdown|text)?\s*|\s*```$", "", cleaned, flags=re.IGNORECASE).strip()
        first_line = next((line.strip().lstrip("#*- ") for line in plain.splitlines() if line.strip()), "AI 分析已完成")
        return {
            "summary": first_line[:240],
            "findings": [],
            "answer": plain[:4000],
            "limitations": ["模型返回了非结构化内容，已按原文展示。"],
            "_parseMode": "text",
        }
    raw_findings = result.get("findings") if isinstance(result.get("findings"), list) else []
    findings = []
    for item in raw_findings[:5]:
        if not isinstance(item, dict):
            continue
        severity = item.get("severity") if item.get("severity") in {"info", "attention", "risk"} else "info"
        findings.append({
            "severity": severity,
            "title": str(item.get("title") or "分析发现")[:240],
            "evidence": str(item.get("evidence") or "")[:1200],
            "recommendation": str(item.get("recommendation") or "")[:1200],
        })
    limitations = result.get("limitations") if isinstance(result.get("limitations"), list) else []
    fallback_summary = result.get("answer") or result.get("content") or result.get("message") or "分析已完成"
    return {
        "summary": str(result.get("summary") or fallback_summary)[:2000],
        "findings": findings,
        "answer": str(result.get("answer") or result.get("content") or "")[:4000],
        "limitations": [str(item)[:800] for item in limitations[:5]],
        "_parseMode": "json",
    }


def analyze(payload: dict) -> dict:
    config = _request_config(payload)
    context = payload.get("context")
    if not isinstance(context, dict):
        raise ValueError("缺少结构化分析上下文")
    context_text = json.dumps(context, ensure_ascii=False, separators=(",", ":"))
    if len(context_text.encode("utf-8")) > MAX_CONTEXT_BYTES:
        raise ValueError("分析上下文超过服务端限制")

    question = str(payload.get("question") or "请生成本批次分析摘要。")[:1200]
    request_body = {
        "model": config["model"],
        "messages": [
            {"role": "system", "content": INSTRUCTIONS},
            {"role": "user", "content": f"分析任务：{question}\n\n分析上下文：\n{context_text}"},
        ],
        "temperature": 0.2,
        "max_tokens": 1600,
        "response_format": {
            "type": "json_schema",
            "json_schema": {"name": "stackpilot_analysis", "strict": True, "schema": AGENT_SCHEMA},
        },
    }
    try:
        raw = _post_json(config["endpoint"], config["apiKey"], request_body)
    except RuntimeError as error:
        if getattr(error, "status", None) != 400:
            raise
        request_body.pop("response_format", None)
        raw = _post_json(config["endpoint"], config["apiKey"], request_body)

    result = _parse_json_result(_extract_content(raw))
    parse_mode = result.pop("_parseMode", "json")
    result["meta"] = {
        "provider": "OpenAI Compatible API",
        "model": raw.get("model", config["model"]),
        "responseId": raw.get("id"),
        "usage": raw.get("usage"),
        "parseMode": parse_mode,
    }
    return result
