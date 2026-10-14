"""Private container endpoint used to wait for readiness in either scheduler."""
import http.server
import socketserver


class Handler(http.server.BaseHTTPRequestHandler):
    def do_GET(self):
        self.send_response(200 if self.path == '/health' else 404)
        self.end_headers()
        self.wfile.write(b'ready' if self.path == '/health' else b'not found')

    def log_message(self, *_):
        pass


# HTTPServer resolves the machine hostname while binding. Cloudflare can use a
# 64-character container ID, which exceeds a DNS label's 63-character limit.
with socketserver.TCPServer(('0.0.0.0', 9080), Handler) as server:
    server.serve_forever()
