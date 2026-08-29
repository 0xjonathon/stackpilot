from http.server import ThreadingHTTPServer, SimpleHTTPRequestHandler
from pathlib import Path
import json
import os

# 本地启动时允许连接局域网、自建网关或本机模型服务；Vercel 函数不设置此项。
os.environ.setdefault("ALLOW_PRIVATE_LLM", "true")

from agent_api import analyze, api_status


ROOT = Path(__file__).resolve().parent
os.chdir(ROOT)


class Handler(SimpleHTTPRequestHandler):
    def _send_json(self, status, payload):
        body = json.dumps(payload, ensure_ascii=False).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Cache-Control", "no-store")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def do_GET(self):
        if self.path.split("?", 1)[0] == "/api/agent":
            self._send_json(200, api_status())
            return
        super().do_GET()

    def do_POST(self):
        if self.path.split("?", 1)[0] != "/api/agent":
            self._send_json(404, {"error": "接口不存在"})
            return
        try:
            length = int(self.headers.get("Content-Length", "0"))
            if length <= 0 or length > 1_000_000:
                raise ValueError("请求体为空或超过限制")
            payload = json.loads(self.rfile.read(length).decode("utf-8"))
            self._send_json(200, analyze(payload))
        except ValueError as error:
            self._send_json(400, {"error": str(error)})
        except RuntimeError as error:
            self._send_json(503, {"error": str(error)})
        except Exception:
            self._send_json(500, {"error": "AI 服务处理失败"})

    def end_headers(self):
        self.send_header("Cache-Control", "no-store")
        self.send_header("Cross-Origin-Opener-Policy", "same-origin")
        super().end_headers()


if __name__ == "__main__":
    address = ("127.0.0.1", 4173)
    print(f"StackPilot running at http://{address[0]}:{address[1]}")
    ThreadingHTTPServer(address, Handler).serve_forever()
