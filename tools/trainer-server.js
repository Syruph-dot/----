import http from 'http';
import fs from 'fs';
import path from 'path';
import { spawn } from 'child_process';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const STATIC_DIR = path.join(__dirname, '..', 'trainer-ui');
const PORT = process.env.PORT || 5174;

let clients = [];
let currentProcess = null;
let lastStatus = { state: 'idle' };

function broadcast(obj) {
  const s = JSON.stringify(obj).replace(/\n/g, '\\n');
  for (const res of clients) {
    try { res.write(`data: ${s}\n\n`); } catch (e) { /* ignore */ }
  }
}

async function runCmd(cmd) {
  broadcast({ type: 'info', text: `> ${cmd}` });
  return new Promise((resolve, reject) => {
    currentProcess = spawn(cmd, { shell: true, cwd: process.cwd(), env: process.env });
    lastStatus = { state: 'running', cmd };

    currentProcess.stdout.on('data', (d) => broadcast({ type: 'stdout', text: d.toString() }));
    currentProcess.stderr.on('data', (d) => broadcast({ type: 'stderr', text: d.toString() }));

    currentProcess.on('close', (code) => {
      broadcast({ type: 'exit', code, cmd });
      currentProcess = null;
      lastStatus = { state: 'idle' };
      resolve(code);
    });

    currentProcess.on('error', (err) => {
      broadcast({ type: 'error', error: err.message });
      currentProcess = null;
      lastStatus = { state: 'idle' };
      reject(err);
    });
  });
}

async function runPipeline(opts = {}) {
  try {
    const episodes = opts.episodes || 20;
    const outputDir = opts.outputDir || 'training-output';
    const format = opts.format || 'jsonl';
    const split = opts.split || 'rare-full';
    const bcDir = opts.bcDir || 'bc-dataset';
    const modelDir = opts.modelDir || 'bc-model';
    const epochs = opts.epochs || 12;
    const batchSize = opts.batchSize || 64;
    const steps = opts.steps || ['headless', 'prepare', 'train', 'smoke'];

    if (steps.includes('headless')) {
      await runCmd(`pnpm run headless -- --episodes ${episodes} --output-dir ${outputDir} --format ${format} --split ${split}`);
    }
    if (steps.includes('prepare')) {
      await runCmd(`python scripts/prepare_bc_dataset.py --input ${outputDir} --output-dir ${bcDir}`);
    }
    if (steps.includes('train')) {
      await runCmd(`python scripts/train_bc.py --dataset-dir ${bcDir} --output-dir ${modelDir} --epochs ${epochs} --batch-size ${batchSize}`);
    }
    if (steps.includes('smoke')) {
      await runCmd(`pnpm run policy:smoke -- --policy ${modelDir}/policy.json`);
    }
    broadcast({ type: 'done', text: 'Pipeline finished' });
  } catch (err) {
    broadcast({ type: 'error', error: err.message });
  }
}

function serveStatic(req, res, pathname) {
  let filePath = pathname === '/' ? path.join(STATIC_DIR, 'index.html') : path.join(STATIC_DIR, decodeURIComponent(pathname));
  if (!filePath.startsWith(STATIC_DIR)) {
    res.writeHead(403);
    res.end('Forbidden');
    return;
  }
  fs.stat(filePath, (err, st) => {
    if (err) { res.writeHead(404); res.end('Not found'); return; }
    if (st.isDirectory()) filePath = path.join(filePath, 'index.html');
    fs.readFile(filePath, (err, data) => {
      if (err) { res.writeHead(500); res.end('Error'); return; }
      const ext = path.extname(filePath).toLowerCase();
      const mimes = { '.html':'text/html', '.js':'application/javascript', '.css':'text/css', '.json':'application/json', '.png':'image/png', '.svg':'image/svg+xml' };
      res.writeHead(200, { 'Content-Type': mimes[ext] || 'application/octet-stream' });
      res.end(data);
    });
  });
}

const server = http.createServer((req, res) => {
  const url = new URL(req.url, `http://localhost`);
  const pathname = url.pathname;

  if (req.method === 'GET' && pathname === '/events') {
    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      Connection: 'keep-alive'
    });
    res.write('\n');
    clients.push(res);
    req.on('close', () => { clients = clients.filter(c => c !== res); });
    return;
  }

  if (req.method === 'GET' && pathname === '/api/status') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(lastStatus));
    return;
  }

  if (req.method === 'POST' && pathname === '/api/run-pipeline') {
    let body = '';
    req.on('data', (chunk) => body += chunk);
    req.on('end', () => {
      try {
        const opts = body ? JSON.parse(body) : {};
        runPipeline(opts);
        res.writeHead(202, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ started: true }));
      } catch (e) {
        res.writeHead(400); res.end('Bad request');
      }
    });
    return;
  }

  if (req.method === 'POST' && pathname === '/api/cancel') {
    if (currentProcess) {
      try { currentProcess.kill(); broadcast({ type: 'info', text: 'Process killed' }); } catch (e) { }
      res.writeHead(200); res.end('killed');
    } else {
      res.writeHead(200); res.end('no-process');
    }
    return;
  }

  // serve static UI
  serveStatic(req, res, pathname);
});

server.listen(PORT, () => console.log(`Trainer server listening at http://localhost:${PORT}`));
