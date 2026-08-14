// Quick smoke test for serve.js — checks path-traversal guard and 404 behavior.
// Run: node smoke.js
const http = require("node:http");
const { spawn } = require("node:child_process");
const path = require("node:path");

const PORT = 3738;
const proc = spawn(process.execPath, ["serve.js", "--no-open"], {
  cwd: __dirname,
  env: { ...process.env, DSH_PEAK_PORT: String(PORT) },
  stdio: "ignore",
});

function get(p) {
  return new Promise((resolve) => {
    const req = http.get({ host: "127.0.0.1", port: PORT, path: p }, (res) => {
      res.resume();
      resolve(res.statusCode);
    });
    req.on("error", () => resolve("ERR"));
    req.setTimeout(2000, () => { req.destroy(); resolve("TIMEOUT"); });
  });
}

(async () => {
  // Wait for server
  for (let i = 0; i < 20; i++) {
    const code = await get("/widget.html");
    if (code === 200) break;
    await new Promise(r => setTimeout(r, 100));
  }
  const cases = [
    ["/widget.html", 200, "legit file"],
    ["/", 200, "root → widget.html"],
    ["/%2e%2e/SECRET.md", 403, "encoded traversal"],
    ["/foo/../../SECRET.md", 403, "multi-level traversal"],
    ["/nope.html", 404, "missing file"],
  ];
  let pass = 0, fail = 0;
  for (const [p, want, note] of cases) {
    const got = await get(p);
    const ok = got === want;
    console.log(`  ${ok ? "PASS" : "FAIL"}  ${String(got).padEnd(4)} (want ${want})  ${p.padEnd(35)}  ${note}`);
    if (ok) pass++; else fail++;
  }
  proc.kill();
  console.log(`---\n${pass} passed, ${fail} failed`);
  process.exit(fail === 0 ? 0 : 1);
})();
