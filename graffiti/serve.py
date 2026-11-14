"""Serve this folder on http://localhost (browsers do not run the page from a double-clicked file)."""
import functools
import http.server
import os
import socketserver
import threading
import webbrowser

os.chdir(os.path.dirname(os.path.abspath(__file__)))
Handler = http.server.SimpleHTTPRequestHandler
Handler.extensions_map.update({".js": "text/javascript", ".json": "application/json", ".ply": "application/octet-stream",
                               ".bin": "application/octet-stream", ".html": "text/html"})
for port in range(8000, 8020):
    try:
        httpd = socketserver.ThreadingTCPServer(("127.0.0.1", port), Handler)
        break
    except OSError:
        continue
url = f"http://localhost:{port}/"
print(f"Grimes Graffiti is running at {url}  (close this window to stop)")
threading.Timer(1.0, functools.partial(webbrowser.open, url)).start()
httpd.serve_forever()
