// Tiny local server for the peak/off-peak widget.
// Run: node serve.js   →   opens http://127.0.0.1:3737 in your default browser.
//
// No dependencies. Uses only Node's built-in http + fs.

const http = require("node:http");
const fs   = require("node:fs");
const path = require("node:path");
const { exec } = require("node:child_process");

const HOST = "127.0.0.1";
const PORT = Number(process.env.DSH_PEAK_PORT) || 3737;
const ROOT = __dirname;

const MIME = {
  ".html": "text/html; charset=utf-8",
  ".js":   "text/javascript; charset=utf-8",
  ".css":  "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg":  "image/svg+xml",
};

function safeJoin(root, urlPath) {
  // Strip query, decode, normalize, then guard against escaping the root.
  const clean = decodeURIComponent(urlPath.split("?")[0]);
  const target = path.normalize(path.join(root, clean));
  if (!target.startsWith(root)) return null;
  return target;
}

const server = http.createServer((req, res) => {
  let urlPath = req.url || "/";
  if (urlPath === "/") urlPath = "/widget.html";

  const target = safeJoin(ROOT, urlPath);
  if (!target) {
    res.writeHead(403, { "Content-Type": "text/plain" });
    res.end("forbidden");
    return;
  }
  fs.readFile(target, (err, buf) => {
    if (err) {
      res.writeHead(404, { "Content-Type": "text/plain" });
      res.end(`not found: ${urlPath}`);
      return;
    }
    const type = MIME[path.extname(target).toLowerCase()] || "application/octet-stream";
    res.writeHead(200, {
      "Content-Type": type,
      "Cache-Control": "no-store",
    });
    res.end(buf);
  });
});

server.listen(PORT, HOST, () => {
  const url = `http://${HOST}:${PORT}/`;
  console.log(`[dsh-peak] serving widget at ${url}`);
  console.log(`[dsh-peak] open it in a browser tab and pin it; press Ctrl+C to stop.`);

  // Best-effort open in default browser. Skip when --no-open or in CI.
  if (!process.argv.includes("--no-open") && !process.env.CI) {
    const cmd =
      process.platform === "win32" ? `start "" "${url}"` :
      process.platform === "darwin" ? `open "${url}"` :
      `xdg-open "${url}"`;
    exec(cmd, () => { /* ignore failures — user can open manually */ });
  }
});
