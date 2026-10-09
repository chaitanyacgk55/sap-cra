// Local HTTP server for the SAP Code Reviewer UI.
// Serves editer.html and exposes:
//   POST /api/review   { project }  -> runs `claude -p "/sap-code-reviewer <project>"` then generates Excel
//   GET  /api/status?project=...    -> checks whether a findings JSON / xlsx exists
//   GET  /reports/<file>            -> downloads generated report files
//
// Run:  node scripts/server.js   (or npm run serve)

const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { spawn, spawnSync } = require('child_process');
const { URL } = require('url');

// Content-hash of an upload folder + all agent .md files. Guarantees
// "same bytes in → same review out" by keying the findings JSON on the
// exact source tree the agent saw AND the exact instructions it followed.
// Skips generated / non-source noise so a stray .DS_Store doesn't bust
// the cache.
const HASH_SKIP_DIRS = new Set(['node_modules', '.git', 'dist', 'gen', 'build', 'out', 'coverage', 'reports', '.vscode', '.idea', '.settings']);
const HASH_SKIP_FILES = new Set(['.DS_Store', 'Thumbs.db', '.gitignore', '.gitattributes']);
function hashPath(h, root, rel = '') {
  let entries;
  try { entries = fs.readdirSync(root, { withFileTypes: true }); } catch { return; }
  entries.sort((a, b) => a.name.localeCompare(b.name));
  for (const e of entries) {
    if (e.isDirectory()) {
      if (HASH_SKIP_DIRS.has(e.name)) continue;
      hashPath(h, path.join(root, e.name), rel ? rel + '/' + e.name : e.name);
    } else if (e.isFile()) {
      if (HASH_SKIP_FILES.has(e.name)) continue;
      const full = path.join(root, e.name);
      const relPath = rel ? rel + '/' + e.name : e.name;
      h.update(relPath + '\0');
      try { h.update(fs.readFileSync(full)); } catch {}
      h.update('\0');
    }
  }
}
function hashUploadFolder(dir) {
  const h = crypto.createHash('sha256');
  h.update('SOURCE\0');
  hashPath(h, dir);
  // Include every agent .md so tuning the reviewer auto-invalidates caches.
  h.update('\0AGENTS\0');
  const agentsDir = path.join(ROOT, '.claude', 'agents');
  if (fs.existsSync(agentsDir)) hashPath(h, agentsDir);
  return h.digest('hex');
}

const ROOT = path.resolve(__dirname, '..');
const PORT = process.env.PORT ? Number(process.env.PORT) : 5757;

// Locate the claude executable once. On Windows, npm installs `claude.cmd` in
// the global bin — we resolve it with `where` so we can spawn it directly
// without invoking cmd.exe (which corrupts long/multi-line prompts).
function resolveClaude() {
  const isWin = process.platform === 'win32';
  const finder = isWin ? 'where' : 'which';
  try {
    const r = spawnSync(finder, ['claude'], { encoding: 'utf8' });
    if (r.status === 0 && r.stdout) {
      const lines = r.stdout.split(/\r?\n/).map(s => s.trim()).filter(Boolean);
      // Prefer .cmd on Windows; otherwise take the first entry.
      const cmd = isWin ? (lines.find(l => /\.cmd$/i.test(l)) || lines.find(l => /\.exe$/i.test(l)) || lines[0]) : lines[0];
      if (cmd && fs.existsSync(cmd)) return cmd;
    }
  } catch {}
  return null;
}
const CLAUDE_BIN = resolveClaude();

// Load the sap-code-reviewer agent body (stripping YAML frontmatter) so we
// can inline its instructions into the review prompt. This bypasses the
// need for Claude Code to dispatch to a subagent in -p mode — which is
// unreliable in headless mode.
function loadAgentInstructions() {
  const p = path.join(ROOT, '.claude/agents/sap-code-reviewer.md');
  if (!fs.existsSync(p)) return null;
  const raw = fs.readFileSync(p, 'utf8');
  return raw.replace(/^---[\s\S]*?---\s*/, '').trim();
}

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js':   'application/javascript; charset=utf-8',
  '.css':  'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.xlsx': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  '.pdf':  'application/pdf',
  '.png':  'image/png',
  '.svg':  'image/svg+xml',
};

function sanitizeProject(name) {
  return String(name || '').trim().replace(/\s+/g, '-').replace(/[^a-zA-Z0-9._-]/g, '');
}

function sendJson(res, status, body) {
  const data = JSON.stringify(body);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(data),
    'Cache-Control': 'no-store',
  });
  res.end(data);
}

function serveStatic(req, res, relPath) {
  const abs = path.join(ROOT, relPath);
  if (!abs.startsWith(ROOT)) { res.writeHead(403).end('forbidden'); return; }
  fs.stat(abs, (err, stat) => {
    if (err || !stat.isFile()) { res.writeHead(404).end('not found'); return; }
    const ext = path.extname(abs).toLowerCase();
    res.writeHead(200, {
      'Content-Type': MIME[ext] || 'application/octet-stream',
      'Content-Length': stat.size,
      'Cache-Control': 'no-store',
    });
    fs.createReadStream(abs).pipe(res);
  });
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on('data', c => chunks.push(c));
    req.on('end', () => {
      try { resolve(chunks.length ? JSON.parse(Buffer.concat(chunks).toString('utf8')) : {}); }
      catch (e) { reject(e); }
    });
    req.on('error', reject);
  });
}

function runProcess(cmd, args, opts = {}) {
  const timeoutMs = opts.timeoutMs || 0;
  // shell defaults to false so argv is passed to CreateProcess directly and
  // Node handles Windows quoting. Callers can override with { shell: true }.
  const useShell = opts.shell === true;
  // Node 24 warns (DEP0190) when args is non-empty and shell:true. If the
  // caller passed [] with shell:true, drop the args entirely — the command
  // string is expected to be self-contained.
  const spawnArgs = (useShell && Array.isArray(args) && args.length === 0) ? undefined : args;
  return new Promise((resolve) => {
    const child = spawn(cmd, spawnArgs, { cwd: ROOT, shell: useShell, windowsHide: true, ...opts });
    let stdout = '', stderr = '', timedOut = false;
    if (child.stdout) child.stdout.on('data', d => { stdout += d.toString(); process.stdout.write(d); });
    if (child.stderr) child.stderr.on('data', d => { stderr += d.toString(); process.stderr.write(d); });
    child.on('error', err => resolve({ code: -1, stdout, stderr: stderr + '\n' + err.message, timedOut }));
    child.on('close', code => resolve({ code, stdout, stderr, timedOut }));

    if (opts.input && child.stdin) {
      try { child.stdin.write(opts.input); child.stdin.end(); } catch {}
    } else if (child.stdin) {
      // Close stdin so the child doesn't sit waiting for input.
      try { child.stdin.end(); } catch {}
    }

    if (timeoutMs > 0) {
      setTimeout(() => {
        timedOut = true;
        try { child.kill('SIGKILL'); } catch {}
      }, timeoutMs);
    }
  });
}

// PUT /api/upload/<project>/<relative/path/to/file>
// Body is the raw file bytes. No multipart parsing needed.
async function handleUpload(req, res, url) {
  const parts = url.pathname.replace(/^\/api\/upload\//, '').split('/').filter(Boolean);
  if (parts.length < 2) return sendJson(res, 400, { ok: false, error: 'path required' });
  const project = sanitizeProject(decodeURIComponent(parts[0]));
  if (!project) return sendJson(res, 400, { ok: false, error: 'invalid project name' });

  // Reject path traversal and absolute-drive components on Windows.
  const relParts = parts.slice(1).map(p => decodeURIComponent(p));
  for (const p of relParts) {
    if (!p || p === '.' || p === '..' || p.includes('\\') || /^[A-Za-z]:$/.test(p)) {
      return sendJson(res, 400, { ok: false, error: 'invalid file path segment: ' + p });
    }
  }

  const projectDir = path.join(ROOT, 'uploads', project);
  const target = path.join(projectDir, ...relParts);
  if (!target.startsWith(projectDir + path.sep) && target !== projectDir) {
    return sendJson(res, 400, { ok: false, error: 'path escapes project directory' });
  }

  try { fs.mkdirSync(path.dirname(target), { recursive: true }); }
  catch (e) { return sendJson(res, 500, { ok: false, error: 'mkdir failed: ' + e.message }); }

  const ws = fs.createWriteStream(target);
  req.pipe(ws);
  ws.on('finish', () => sendJson(res, 200, { ok: true, path: `uploads/${project}/${relParts.join('/')}` }));
  ws.on('error', (e) => { try { res.destroy(); } catch {} });
  req.on('error', () => { try { ws.destroy(); } catch {} });
}

// POST /api/reset { project, purgeSiblings? } — empty uploads/<project>/,
// and when purgeSiblings is true also remove every OTHER folder under uploads/
// so stale prior runs don't accumulate on disk.
async function handleReset(req, res) {
  let body;
  try { body = await readBody(req); } catch { return sendJson(res, 400, { ok: false, error: 'invalid JSON' }); }
  const project = sanitizeProject(body.project);
  if (!project) return sendJson(res, 400, { ok: false, error: 'project required' });
  const uploadsRoot = path.join(ROOT, 'uploads');
  const dir = path.join(uploadsRoot, project);
  const purged = [];
  try {
    if (!fs.existsSync(uploadsRoot)) fs.mkdirSync(uploadsRoot, { recursive: true });
    if (body.purgeSiblings) {
      for (const entry of fs.readdirSync(uploadsRoot, { withFileTypes: true })) {
        if (!entry.isDirectory()) continue;
        if (entry.name === project) continue;
        const sib = path.join(uploadsRoot, entry.name);
        try { fs.rmSync(sib, { recursive: true, force: true }); purged.push(entry.name); }
        catch (e) { console.warn(`[reset] failed to remove ${sib}: ${e.message}`); }
      }
    }
    if (fs.existsSync(dir)) fs.rmSync(dir, { recursive: true, force: true });
    fs.mkdirSync(dir, { recursive: true });
    sendJson(res, 200, { ok: true, purged });
  } catch (e) {
    sendJson(res, 500, { ok: false, error: e.message });
  }
}

async function handleReview(req, res) {
  let body;
  try { body = await readBody(req); }
  catch (e) { return sendJson(res, 400, { ok: false, error: 'invalid JSON body' }); }

  const project = sanitizeProject(body.project);
  if (!project) return sendJson(res, 400, { ok: false, error: 'project name required' });

  // Optional: comma-separated client-name aliases to mask in the generated
  // reports. Passed to the export scripts via MASK_CLIENT env var.
  const clientAliases = typeof body.client === 'string' ? body.client.trim() : '';

  const uploadDir = path.join(ROOT, 'uploads', project);
  if (!fs.existsSync(uploadDir)) {
    return sendJson(res, 404, { ok: false, error: `uploads/${project}/ not found — save the files first` });
  }

  if (!CLAUDE_BIN) {
    return sendJson(res, 500, {
      ok: false,
      error: 'The `claude` CLI was not found on PATH. Install with: npm install -g @anthropic-ai/claude-code. Then restart this server.',
    });
  }

  const agentBody = loadAgentInstructions();
  if (!agentBody) {
    return sendJson(res, 500, {
      ok: false,
      error: 'Missing .claude/agents/sap-code-reviewer.md — cannot build review prompt.',
    });
  }

  // Build a self-contained prompt: agent instructions + the specific task.
  // Running the checks inline (rather than dispatching to a subagent) is far
  // more reliable in `-p` headless mode.
  const prompt =
    `You are running as the sap-code-reviewer for project "${project}".\n` +
    `Follow these instructions exactly:\n\n` +
    `----- BEGIN AGENT INSTRUCTIONS -----\n${agentBody}\n----- END AGENT INSTRUCTIONS -----\n\n` +
    `Concrete task:\n` +
    `  * Project name: ${project}\n` +
    `  * Source folder: uploads/${project}/ (relative to the current working directory)\n` +
    `  * Output JSON file: reports/${project}-findings.json\n` +
    `  * Follow the schema in samples/example-findings.json exactly.\n` +
    `  * Do NOT modify any file under uploads/. Read-only review.\n` +
    `  * Do NOT ask clarifying questions — proceed with sensible defaults.\n` +
    `  * When done, print ONLY the concise summary described in the final step of the agent instructions.\n` +
    `  * WRITE the JSON file before printing the summary.\n`;

  const findingsPath = path.join(ROOT, 'reports', `${project}-findings.json`);
  const preMtime = fs.existsSync(findingsPath) ? fs.statSync(findingsPath).mtimeMs : 0;

  // ── Deterministic cache: if the upload folder AND the agent instructions
  // haven't changed a byte, reuse the previous findings JSON instead of
  // re-invoking the (stochastic) LLM. The LLM has no temperature-0 knob on
  // the `claude` CLI, so caching is the ONLY way to guarantee that "same
  // project → same findings" holds across runs.
  //
  // The cache invalidates automatically when:
  //   * any file in uploads/<project>/ changes, OR
  //   * any file in .claude/agents/*.md changes.
  // The old `force` bypass has been removed on purpose: forcing a fresh
  // LLM run would immediately reintroduce nondeterminism.
  const sourceHash = hashUploadFolder(uploadDir);
  let cacheHit = false;
  if (fs.existsSync(findingsPath)) {
    try {
      const prev = JSON.parse(fs.readFileSync(findingsPath, 'utf8'));
      if (prev && prev._sourceHash === sourceHash) {
        cacheHit = true;
        console.log(`[review] cache HIT project="${project}" hash=${sourceHash.slice(0, 12)}… — skipping claude`);
      }
    } catch {}
  }
  if (!cacheHit) {
    console.log(`[review] cache MISS project="${project}" hash=${sourceHash.slice(0, 12)}…`);
  }

  let review;
  if (cacheHit) {
    // Skip the LLM entirely — reuse the existing findings JSON.
    review = { code: 0, stdout: '', stderr: '', timedOut: false, cached: true };
  } else {
    // Prompt goes to a file, then we pipe it into claude via stdin. This avoids:
    //  - Windows argv length + newline limits.
    //  - Node's EINVAL when spawning `.cmd` files without a shell (Node 20+).
    const promptFile = path.join(ROOT, 'reports', `.prompt-${project}.txt`);
    fs.writeFileSync(promptFile, prompt, 'utf8');

    const isWin = process.platform === 'win32';
    // One-string commands so the shell (cmd /S /c or sh -c) parses the quotes,
    // not Node's argv quoter. This avoids the `\"` vs `""` mismatch cmd.exe hits.
    const winCmd = `type "${promptFile}" | "${CLAUDE_BIN}" -p --permission-mode bypassPermissions --dangerously-skip-permissions --output-format text`;
    const nixCmd = `cat "${promptFile}" | "${CLAUDE_BIN}" -p --permission-mode bypassPermissions --dangerously-skip-permissions --output-format text`;
    console.log(`[review] launching claude bin=${CLAUDE_BIN} for project="${project}"`);
    console.log(`[review] cmd: ${isWin ? winCmd : nixCmd}`);
    const claudePromise = runProcess(
      isWin ? winCmd : nixCmd,
      [],
      { timeoutMs: 8 * 60 * 1000, shell: true }
    );

    // Poll for the findings JSON. When it appears (fresh write), we stop waiting
    // on claude — it sometimes stays alive after finishing the task, which used
    // to leave the UI spinning. We move straight to the Excel export.
    const jsonAppeared = await new Promise((resolve) => {
      let done = false;
      const iv = setInterval(() => {
        if (done) return;
        try {
          const st = fs.statSync(findingsPath);
          if (st.mtimeMs > preMtime) { done = true; clearInterval(iv); resolve(true); }
        } catch {}
      }, 1500);
      claudePromise.then(() => { if (!done) { done = true; clearInterval(iv); resolve(false); } });
    });

    // If the JSON is here, don't block on claude — kick off Excel now.
    // If claude is still running, we let it finish in the background.
    review = jsonAppeared
      ? { code: 0, stdout: '', stderr: '', timedOut: false, stillRunning: true }
      : await claudePromise;

    console.log(`[review] json present=${jsonAppeared} claude exit=${review.code} timedOut=${review.timedOut}`);
    try { fs.unlinkSync(promptFile); } catch {}

    // Stamp the source hash into the findings JSON so future re-runs of the
    // same upload can short-circuit the LLM. Non-fatal if it fails.
    if (fs.existsSync(findingsPath)) {
      try {
        const j = JSON.parse(fs.readFileSync(findingsPath, 'utf8'));
        j._sourceHash = sourceHash;
        j._reviewedAt = j.reviewedAt || new Date().toISOString();
        fs.writeFileSync(findingsPath, JSON.stringify(j, null, 2), 'utf8');
      } catch (e) {
        console.warn('[review] could not stamp _sourceHash:', e.message);
      }
    }
  }

  if (!fs.existsSync(findingsPath)) {
    // Save the transcript so the user can recover the findings even if claude
    // couldn't write the JSON itself.
    try {
      const logPath = path.join(ROOT, 'reports', `${project}-review.log.txt`);
      fs.writeFileSync(logPath, `EXIT ${review.code}  timedOut=${review.timedOut}\n\n--- STDOUT ---\n${review.stdout}\n\n--- STDERR ---\n${review.stderr}\n`, 'utf8');
    } catch {}
    // Give a much more actionable error message.
    const hint = review.timedOut
      ? 'Timed out after 5 minutes — the `claude` CLI was killed. It may be waiting for interactive input or auth. Try running it once manually in this folder to complete any first-run setup.'
      : review.code === -1
        ? 'The `claude` CLI could not be started. Check that it is on PATH (`where claude`) and that you can run it in the same terminal that launched this server.'
        : review.code !== 0
          ? `The \`claude\` CLI exited with code ${review.code}. See stderr below.`
          : 'The `claude` CLI finished successfully but did not write reports/' + project + '-findings.json. The agent may have asked a clarifying question or been blocked by permissions.';
    return sendJson(res, 500, {
      ok: false,
      stage: 'review',
      error: 'Review finished but no findings JSON was written. ' + hint,
      prompt,
      exitCode: review.code,
      claudeStdout: review.stdout.slice(-4000),
      claudeStderr: review.stderr.slice(-4000),
    });
  }

  // 2) Generate Excel and PDF reports in parallel. Pass client aliases (if
  //    provided by the UI) via MASK_CLIENT so the shared masker redacts them.
  const exportEnv = { ...process.env };
  if (clientAliases) exportEnv.MASK_CLIENT = clientAliases;
  const [excel, pdf] = await Promise.all([
    runProcess(process.execPath, ['scripts/export-excel.js', project], { env: exportEnv }),
    runProcess(process.execPath, ['scripts/export-pdf.js',   project], { env: exportEnv }),
  ]);
  const xlsxPath = path.join(ROOT, 'reports', `${project}-review.xlsx`);
  const pdfPath  = path.join(ROOT, 'reports', `${project}-review.pdf`);
  const xlsxExists = fs.existsSync(xlsxPath);
  const pdfExists  = fs.existsSync(pdfPath);

  let findings = null;
  try { findings = JSON.parse(fs.readFileSync(findingsPath, 'utf8')); } catch {}

  // Slim finding breakdown for the UI dashboard: severity+category only.
  const list = findings && Array.isArray(findings.findings) ? findings.findings : [];
  const categoryBreakdown = list.reduce((acc, f) => {
    const cat = (f.category || 'other').toLowerCase();
    if (!acc[cat]) acc[cat] = { high: 0, medium: 0, low: 0, total: 0 };
    const sev = (f.severity || '').toLowerCase();
    if (acc[cat][sev] !== undefined) acc[cat][sev]++;
    acc[cat].total++;
    return acc;
  }, {});
  const blocksTransport = list.filter(f => f.blocksTransport === true).length;

  return sendJson(res, 200, {
    ok: true,
    project,
    xlsxUrl: xlsxExists ? `/reports/${project}-review.xlsx` : null,
    pdfUrl:  pdfExists  ? `/reports/${project}-review.pdf`  : null,
    summary: findings && findings.summary,
    technologies: findings && findings.technologies,
    counts: findings && {
      total: list.length,
    },
    categoryBreakdown,
    blocksTransport,
    cached: cacheHit,
    sourceHash: sourceHash.slice(0, 12),
    excelStdout: excel.stdout.slice(-2000),
    excelStderr: excel.stderr.slice(-2000),
    pdfStdout:   pdf.stdout.slice(-1000),
    pdfStderr:   pdf.stderr.slice(-1000),
  });
}

function handleStatus(req, res, url) {
  const project = sanitizeProject(url.searchParams.get('project'));
  if (!project) return sendJson(res, 400, { ok: false, error: 'project required' });
  const xlsx = path.join(ROOT, 'reports', `${project}-review.xlsx`);
  const pdf  = path.join(ROOT, 'reports', `${project}-review.pdf`);
  sendJson(res, 200, {
    ok: true,
    xlsx: fs.existsSync(xlsx),
    pdf:  fs.existsSync(pdf),
    xlsxUrl: fs.existsSync(xlsx) ? `/reports/${project}-review.xlsx` : null,
    pdfUrl:  fs.existsSync(pdf)  ? `/reports/${project}-review.pdf`  : null,
  });
}

const server = http.createServer(async (req, res) => {
  // CORS for local development / other origins.
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') { res.writeHead(204).end(); return; }

  const url = new URL(req.url, `http://${req.headers.host}`);

  if (req.method === 'GET' && (url.pathname === '/' || url.pathname === '/editer.html')) {
    return serveStatic(req, res, 'editer.html');
  }
  if (req.method === 'GET' && url.pathname.startsWith('/reports/')) {
    return serveStatic(req, res, url.pathname.replace(/^\//, ''));
  }
  if (req.method === 'GET' && url.pathname === '/api/status') {
    return handleStatus(req, res, url);
  }
  if (req.method === 'PUT' && url.pathname.startsWith('/api/upload/')) {
    return handleUpload(req, res, url);
  }
  if (req.method === 'POST' && url.pathname === '/api/reset') {
    return handleReset(req, res);
  }
  if (req.method === 'GET' && url.pathname === '/api/health') {
    const v = CLAUDE_BIN
      ? await runProcess(CLAUDE_BIN, ['--version'], { timeoutMs: 10000, shell: true })
      : { code: -1, stdout: '', stderr: 'claude not found on PATH' };
    return sendJson(res, 200, {
      ok: v.code === 0,
      claudeBin: CLAUDE_BIN,
      claudeVersion: (v.stdout || '').trim(),
      claudeError: v.code !== 0 ? (v.stderr || '').trim() : null,
      platform: process.platform,
      cwd: ROOT,
      agentFile: fs.existsSync(path.join(ROOT, '.claude/agents/sap-code-reviewer.md')),
    });
  }
  if (req.method === 'POST' && url.pathname === '/api/review') {
    return handleReview(req, res);
  }

  res.writeHead(404, { 'Content-Type': 'text/plain' }).end('not found');
});

server.listen(PORT, async () => {
  console.log(`SAP Code Reviewer UI running on http://localhost:${PORT}/`);
  console.log(`POST /api/review  { "project": "<name>" }  to trigger a review.`);
  // Startup diagnostic: verify claude is reachable.
  if (CLAUDE_BIN) {
    console.log(`[health] claude bin: ${CLAUDE_BIN}`);
    const v = await runProcess(CLAUDE_BIN, ['--version'], { timeoutMs: 10000, shell: true });
    if (v.code === 0) console.log(`[health] claude CLI OK: ${(v.stdout || '').trim()}`);
    else console.warn(`[health] WARNING: claude --version failed (exit ${v.code}) stderr: ${(v.stderr || '').trim()}`);
  } else {
    console.warn(`[health] WARNING: claude CLI not found on PATH. Install with:`);
    console.warn(`[health]   npm install -g @anthropic-ai/claude-code`);
    console.warn(`[health] The Review button will not work until 'claude --version' runs from this folder.`);
  }
  const agentPath = path.join(ROOT, '.claude/agents/sap-code-reviewer.md');
  if (!fs.existsSync(agentPath)) {
    console.warn(`[health] WARNING: agent file missing: ${agentPath}`);
  }
});
