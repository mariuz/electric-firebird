// Serve a built example: node serve.mjs <dir> <port> [--isolated]
//
// --isolated sends COOP/COEP, so the page is cross-origin isolated and the
// example loads the threaded engine; without it the page is not, as on a
// static host, and the example loads the build without threads.
import * as http from 'node:http';
import * as fs from 'node:fs';
import * as path from 'node:path';

const [dir, port, flag] = process.argv.slice(2);
const root = path.resolve(dir);
const isolated = flag === '--isolated';
const TYPES = { '.html': 'text/html', '.js': 'text/javascript', '.wasm': 'application/wasm', '.json': 'application/json' };

http.createServer((req, res) => {
  const url = new URL(req.url ?? '/', 'http://localhost');
  const file = path.join(root, url.pathname === '/' ? 'index.html' : decodeURIComponent(url.pathname));
  if (!file.startsWith(root + path.sep) || !fs.existsSync(file) || !fs.statSync(file).isFile()) {
    res.writeHead(404);
    res.end('not found');
    return;
  }
  const headers = { 'Content-Type': TYPES[path.extname(file)] ?? 'application/octet-stream' };
  if (isolated) {
    headers['Cross-Origin-Opener-Policy'] = 'same-origin';
    headers['Cross-Origin-Embedder-Policy'] = 'require-corp';
  }
  res.writeHead(200, headers);
  fs.createReadStream(file).pipe(res);
}).listen(Number(port), () => console.log(`${dir} on :${port}${isolated ? ' (isolated)' : ''}`));
