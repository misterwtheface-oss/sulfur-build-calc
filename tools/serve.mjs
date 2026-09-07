/*
  serve.mjs — tiny static file server for local + LAN preview.
  Start it only while testing (so a phone on the same Wi-Fi can hit it for real
  mobile testing), and stop it (Ctrl+C) when done — don't leave a port open idle.

  Usage: node tools/serve.mjs [port]   (default 8080)
*/
import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";

const port = Number(process.argv[2]) || 8080;
const root = process.cwd();

const TYPES = {
  ".html": "text/html", ".js": "text/javascript", ".mjs": "text/javascript",
  ".css": "text/css", ".json": "application/json", ".png": "image/png",
  ".jpg": "image/jpeg", ".svg": "image/svg+xml", ".webp": "image/webp",
};

const server = http.createServer((req, res) => {
  const urlPath = decodeURIComponent(req.url.split("?")[0]);
  let filePath = path.join(root, urlPath === "/" ? "index.html" : urlPath);
  if (!filePath.startsWith(root)) { res.writeHead(403).end("Forbidden"); return; }
  fs.readFile(filePath, (err, buf) => {
    if (err) { res.writeHead(404).end("Not found"); return; }
    res.writeHead(200, { "Content-Type": TYPES[path.extname(filePath)] || "application/octet-stream" });
    res.end(buf);
  });
});

server.listen(port, () => {
  const nets = os.networkInterfaces();
  const lan = Object.values(nets).flat().find((n) => n && n.family === "IPv4" && !n.internal);
  console.log(`Serving ${root}`);
  console.log(`  local:  http://localhost:${port}`);
  if (lan) console.log(`  LAN:    http://${lan.address}:${port}  (for phone testing)`);
  console.log("Ctrl+C to stop.");
});
