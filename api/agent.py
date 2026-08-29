"""Vercel Python Function entrypoint for /api/agent."""

from http.server import BaseHTTPRequestHandler
import json

from agent_api import analyze, api_status


class handler(BaseHTTPRequestHandler):
    def _json(self, status, payload):
        body = json.dumps(payload, ensure_ascii=False).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Cache-Control", "no-store")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def do_GET(self):
        self._json(200, api_status())

    def do_POST(self):
        try:
            length = int(self.headers.get("Content-Length", "0"))
            if length <= 0 or length > 1_000_000:
                raise ValueError("请求体为空或超过限制")
            payload = json.loads(self.rfile.read(length).decode("utf-8"))
            self._json(200, analyze(payload))
        except ValueError as error:
            self._json(400, {"error": str(error)})
        except RuntimeError as error:
            self._json(503, {"error": str(error)})
        except Exception:
            self._json(500, {"error": "AI 服务处理失败"})
