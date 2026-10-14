"""Private container endpoint used to wait for readiness in either scheduler."""
import http.server


class Handler(http.server.BaseHTTPRequestHandler):
    def do_GET(self):
        self.send_response(200 if self.path == '/health' else 404)
        self.end_headers()
        self.wfile.write(b'ready' if self.path == '/health' else b'not found')

    def log_message(self, *_):
        pass


http.server.HTTPServer(('0.0.0.0', 9080), Handler).serve_forever()
