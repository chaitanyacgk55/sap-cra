// Shared PII / client-name masker for report exports.
// Loads config, builds a masker function, applies it to findings before export.
//
// Config resolution order (later overrides earlier):
//   1. mask.config.json         (repo root)
//   2. .reviewer-config.json    (repo root or uploads/<project>/)
//   3. MASK_CLIENT env var      (comma-separated aliases)
//   4. --client "A,B,C" CLI arg (comma-separated aliases)
//
// Config shape:
//   {
//     "clientAliases":      ["Vistra", "VISTRA HOLDINGS", "Vistra Holdings UK"],
//     "clientMask":         "[CLIENT]",
//     "maskEmails":         true,
//     "maskIPs":            true,
//     "maskTokens":         true,
//     "additionalPatterns": [ { "pattern": "\\bACC-\\d{4}\\b", "flags": "g", "replacement": "[ACC-ID]" } ]
//   }

'use strict';

const fs   = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');

const MASKS = {
  client: '[CLIENT]',
  email:  '[EMAIL]',
  ip:     '[IP]',
  token:  '[TOKEN]',
};

// Industry-standard PII regexes (RFC-loose, good enough for redaction).
const EMAIL_RE = /\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}\b/g;
const IPV4_RE  = /\b(?:(?:25[0-5]|2[0-4]\d|[01]?\d\d?)\.){3}(?:25[0-5]|2[0-4]\d|[01]?\d\d?)\b/g;
const JWT_RE   = /\beyJ[A-Za-z0-9_-]+?\.[A-Za-z0-9_-]+?\.[A-Za-z0-9_-]+\b/g;

function escapeRe(s) { return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'); }

function readJsonSafe(file) {
  try {
    if (!fs.existsSync(file)) return null;
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (e) {
    console.warn(`[mask] failed to parse ${file}: ${e.message}`);
    return null;
  }
}

function loadConfig({ project } = {}) {
  const cfg = {
    clientAliases:      [],
    clientMask:         MASKS.client,
    maskEmails:         true,
    maskIPs:            true,
    maskTokens:         true,
    additionalPatterns: [],
  };

  const candidates = [
    path.join(ROOT, 'mask.config.json'),
    path.join(ROOT, '.reviewer-config.json'),
    project ? path.join(ROOT, 'uploads', project, '.reviewer-config.json') : null,
  ].filter(Boolean);

  for (const file of candidates) {
    const user = readJsonSafe(file);
    if (user && typeof user === 'object') {
      if (Array.isArray(user.clientAliases)) cfg.clientAliases.push(...user.clientAliases);
      if (typeof user.clientMask === 'string') cfg.clientMask = user.clientMask;
      if (typeof user.maskEmails === 'boolean') cfg.maskEmails = user.maskEmails;
      if (typeof user.maskIPs    === 'boolean') cfg.maskIPs    = user.maskIPs;
      if (typeof user.maskTokens === 'boolean') cfg.maskTokens = user.maskTokens;
      if (Array.isArray(user.additionalPatterns)) cfg.additionalPatterns.push(...user.additionalPatterns);
    }
  }

  // Env var
  if (process.env.MASK_CLIENT) {
    cfg.clientAliases.push(
      ...process.env.MASK_CLIENT.split(',').map(s => s.trim()).filter(Boolean)
    );
  }
  // CLI: --client "A,B"
  const idx = process.argv.indexOf('--client');
  if (idx > 0 && process.argv[idx + 1]) {
    cfg.clientAliases.push(
      ...process.argv[idx + 1].split(',').map(s => s.trim()).filter(Boolean)
    );
  }

  // Deduplicate; keep aliases ≥ 3 chars (avoid masking tiny tokens like "AB").
  const uniq = [...new Set(cfg.clientAliases)]
    .filter(a => typeof a === 'string' && a.trim().length >= 3);
  // Longest first, so "Vistra Holdings UK" masks before "Vistra".
  uniq.sort((a, b) => b.length - a.length);

  cfg._aliasRegexes = uniq.map(a => new RegExp(`\\b${escapeRe(a)}\\b`, 'gi'));
  cfg._activeAliases = uniq;
  return cfg;
}

function buildMasker(cfg) {
  const mask = (input) => {
    if (input == null) return input;
    let s = String(input);
    for (const re of cfg._aliasRegexes) s = s.replace(re, cfg.clientMask);
    for (const p of cfg.additionalPatterns || []) {
      try {
        const re = new RegExp(p.pattern, p.flags || 'gi');
        s = s.replace(re, p.replacement || '[REDACTED]');
      } catch { /* invalid user regex — ignore */ }
    }
    if (cfg.maskEmails) s = s.replace(EMAIL_RE, MASKS.email);
    if (cfg.maskIPs)    s = s.replace(IPV4_RE,  MASKS.ip);
    if (cfg.maskTokens) s = s.replace(JWT_RE,   MASKS.token);
    return s;
  };
  mask.cfg = cfg;
  return mask;
}

const MASKED_FIELDS = [
  'file', 'title', 'issue', 'recommendation',
  'codeSnippet', 'referenceLink', 'category', 'layer',
];

function maskFinding(f, mask) {
  const out = { ...f };
  MASKED_FIELDS.forEach(k => { if (out[k] != null) out[k] = mask(out[k]); });
  if (Array.isArray(out.additionalFiles)) out.additionalFiles = out.additionalFiles.map(mask);
  return out;
}

function maskData(data, mask) {
  if (!data || typeof data !== 'object') return data;
  return {
    ...data,
    project: mask(data.project),
    findings: Array.isArray(data.findings) ? data.findings.map(f => maskFinding(f, mask)) : [],
    summary: data.summary
      ? { ...data.summary, assessment: mask(data.summary.assessment) }
      : data.summary,
  };
}

/**
 * Convenience: load config + build masker + mask a project string in one call.
 * Returns { mask, cfg, maskedProject }.
 */
function initFor(project) {
  const cfg  = loadConfig({ project });
  const mask = buildMasker(cfg);
  if (cfg._activeAliases.length) {
    console.log(`[mask] active aliases: ${cfg._activeAliases.map(a => JSON.stringify(a)).join(', ')} → ${cfg.clientMask}`);
  }
  return { mask, cfg, maskedProject: mask(project) };
}

module.exports = { loadConfig, buildMasker, maskFinding, maskData, initFor };
