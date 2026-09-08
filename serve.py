#!/usr/bin/env python3
"""Serve the browser UI for kSTEP-on-wasm.

    ./serve.py [--port 8080]

Routes:
  /                     index.html
  /qemu/<file>          build/qemu/build/   (qemu-system-aarch64.js/.wasm)
  /images/<kernel>/<f>  $KSTEP_DIR/build/<kernel>/  (kernel, rootfs.cpio; KSTEP_DIR defaults to ../kstep)
  /kernels.json         list of kernel dirs that have kernel + rootfs.cpio

Adds Cross-Origin-Opener-Policy / Cross-Origin-Embedder-Policy headers, which
browsers require before they expose SharedArrayBuffer (needed for pthreads).
"""
import argparse, json, mimetypes, os, sys
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer

W = os.path.dirname(os.path.abspath(__file__))
KSTEP_BUILD = os.path.join(os.environ.get("KSTEP_DIR", os.path.join(W, "..", "kstep")), "build")
mimetypes.add_type("application/wasm", ".wasm")
mimetypes.add_type("text/javascript", ".js")


def kernels():
    out = []
    if os.path.isdir(KSTEP_BUILD):
        for d in sorted(os.listdir(KSTEP_BUILD)):
            p = os.path.join(KSTEP_BUILD, d)
            if os.path.isfile(os.path.join(p, "kernel")) and os.path.isfile(os.path.join(p, "rootfs.cpio")):
                out.append(d)
    return out


class Handler(SimpleHTTPRequestHandler):
    def end_headers(self):
        self.send_header("Cross-Origin-Opener-Policy", "same-origin")
        self.send_header("Cross-Origin-Embedder-Policy", "require-corp")
        self.send_header("Cross-Origin-Resource-Policy", "same-origin")
        self.send_header("Cache-Control", "no-cache")
        super().end_headers()

    def translate_path(self, path):
        path = path.split("?", 1)[0].split("#", 1)[0]
        if path in ("", "/"):
            return os.path.join(W, "index.html")
        if path.startswith("/qemu/"):
            return os.path.join(W, "build", "qemu", "build", os.path.basename(path))
        if path.startswith("/images/"):
            _, _, kernel, name = path.split("/", 3)
            if kernel in kernels() and name in ("kernel", "rootfs.cpio"):
                return os.path.join(KSTEP_BUILD, kernel, name)
            return os.path.join(W, "nonexistent")
        return os.path.join(W, "nonexistent")

    def do_GET(self):
        if self.path.split("?")[0] == "/kernels.json":
            body = json.dumps(kernels()).encode()
            self.send_response(200)
            self.send_header("Content-Type", "application/json")
            self.send_header("Content-Length", str(len(body)))
            self.end_headers()
            self.wfile.write(body)
            return
        super().do_GET()

    def log_message(self, fmt, *a):
        sys.stderr.write("%s %s\n" % (self.address_string(), fmt % a))


if __name__ == "__main__":
    ap = argparse.ArgumentParser()
    ap.add_argument("--port", type=int, default=8080)
    a = ap.parse_args()
    qemu_js = os.path.join(W, "build", "qemu", "build", "qemu-system-aarch64.js")
    if not os.path.isfile(qemu_js):
        sys.exit(f"missing {qemu_js}; run ./build_qemu.sh")
    print(f"serving kernels={kernels()} at http://localhost:{a.port}/")
    ThreadingHTTPServer(("", a.port), Handler).serve_forever()
