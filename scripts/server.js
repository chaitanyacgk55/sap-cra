// Local HTTP server for the SAP Code Reviewer UI.
// Serves editer.html and exposes:
//   POST /api/review   { project }  -> runs `claude -p "/sap-code-reviewer <project>"` then generates Excel
//   GET  /api/status?project=...    -> checks whether a findings JSON / xlsx exists
//   GET  /reports/<file>            -> downloads generated report files
//
// Run:  node scripts/server.js   (or npm run serve)

const http = require('http');
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { spawn, spawnSync } = require('child_process');
const { URL } = require('url');

// Ensure this workspace is marked "trusted" in the user-level ~/.claude.json
// so the claude CLI honors our .claude/settings.json allow-list AND the
// --dangerously-skip-permissions flag when run headlessly from this server.
// Without this, claude prints:
//   "Ignoring N permissions.allow entries from .claude/settings.json: this
//    workspace has not been trusted."
// and the agent then asks for interactive approval to write the findings
// JSON, which never comes in -p mode → the review fails with exit 0 and no
// output file. Patching trust up-front is idempotent and safe.
function ensureWorkspaceTrust(workspaceDir) {
  try {
    const cfgPath = path.join(os.homedir(), '.claude.json');
    let cfg = {};
    if (fs.existsSync(cfgPath)) {
      try { cfg = JSON.parse(fs.readFileSync(cfgPath, 'utf8')) || {}; }
      catch (e) {
        console.warn(`[trust] WARNING: could not parse ${cfgPath} (${e.message}); leaving it untouched.`);
        return false;
      }
    }
    if (!cfg.projects || typeof cfg.projects !== 'object') cfg.projects = {};
    // The CLI keys projects by forward-slash path on Windows.
    const key = workspaceDir.replace(/\\/g, '/');
    const existing = cfg.projects[key] || {};
    if (existing.hasTrustDialogAccepted === true) return true;
    cfg.projects[key] = { ...existing, hasTrustDialogAccepted: true };
    fs.writeFileSync(cfgPath, JSON.stringify(cfg, null, 2), 'utf8');
    console.log(`[trust] marked workspace trusted in ${cfgPath}  (projects["${key}"].hasTrustDialogAccepted = true)`);
    return true;
  } catch (e) {
    console.warn(`[trust] WARNING: could not update ~/.claude.json: ${e.message}`);
    return false;
  }
}
let ExcelJS = null;
try { ExcelJS = require('exceljs'); } catch { /* only needed when a client uploads .xlsx suggestions */ }

// Folder (inside uploads/<project>/) that stores client-supplied review
// suggestions. Prefixed with a dot so it is naturally skipped by the
// SAP source scanner yet still part of the hashed upload (so cache
// invalidates when the suggestions change).
const CLIENT_SUGGESTIONS_DIR = '.client-suggestions';
const FUNCTIONAL_DESIGN_DIR = '.functional-design';

// Minimal .docx text extractor using Node's built-in zlib. A .docx is a
// ZIP whose main payload is word/document.xml. We locate the ZIP's
// End-of-Central-Directory (EOCD) record, walk the central-directory
// entries, inflate the deflate stream for document.xml, strip XML tags
// and newline/paragraph markers, and return plain text.
const zlib = require('zlib');
function extractDocxText(buf) {
  // Locate EOCD by scanning backwards from the end (max comment = 65 535).
  const EOCD_SIG = 0x06054b50;
  const CDFH_SIG = 0x02014b50;
  const LFH_SIG  = 0x04034b50;
  let eocd = -1;
  const maxBack = Math.min(buf.length, 66000);
  for (let i = buf.length - 22; i >= buf.length - maxBack; i--) {
    if (i < 0) break;
    if (buf.readUInt32LE(i) === EOCD_SIG) { eocd = i; break; }
  }
  if (eocd < 0) throw new Error('not a ZIP / .docx — EOCD not found');
  const cdOffset = buf.readUInt32LE(eocd + 16);
  const cdSize   = buf.readUInt32LE(eocd + 12);
  const cdEnd    = cdOffset + cdSize;
  let p = cdOffset;
  let docEntry = null;
  while (p + 46 <= cdEnd) {
    if (buf.readUInt32LE(p) !== CDFH_SIG) break;
    const compMethod = buf.readUInt16LE(p + 10);
    const compSize   = buf.readUInt32LE(p + 20);
    const nameLen    = buf.readUInt16LE(p + 28);
    const extraLen   = buf.readUInt16LE(p + 30);
    const commentLen = buf.readUInt16LE(p + 32);
    const localHdr   = buf.readUInt32LE(p + 42);
    const name       = buf.slice(p + 46, p + 46 + nameLen).toString('utf8');
    if (name === 'word/document.xml') {
      docEntry = { compMethod, compSize, localHdr };
      break;
    }
    p += 46 + nameLen + extraLen + commentLen;
  }
  if (!docEntry) throw new Error('word/document.xml not found inside .docx');
  if (buf.readUInt32LE(docEntry.localHdr) !== LFH_SIG) throw new Error('malformed .docx (bad local header)');
  const lhNameLen  = buf.readUInt16LE(docEntry.localHdr + 26);
  const lhExtraLen = buf.readUInt16LE(docEntry.localHdr + 28);
  const dataStart  = docEntry.localHdr + 30 + lhNameLen + lhExtraLen;
  const payload    = buf.slice(dataStart, dataStart + docEntry.compSize);
  const xmlBuf = docEntry.compMethod === 0
    ? payload
    : zlib.inflateRawSync(payload);
  const xml = xmlBuf.toString('utf8');
  // Preserve paragraph / line breaks before stripping tags.
  const normalized = xml
    .replace(/<w:p[\s>][^>]*>/g, '\n')
    .replace(/<w:br\s*\/?>/g, '\n')
    .replace(/<w:tab\s*\/?>/g, '\t')
    .replace(/<[^>]+>/g, '');
  // Decode a few XML entities.
  return normalized
    .replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"').replace(/&apos;/g, "'")
    .replace(/\r\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

// Best-effort .doc (legacy OLE2 binary) text extraction. The OLE2 format
// is non-trivial; this just salvages the printable ASCII/UTF-16LE runs,
// which is usually enough to identify functional-design keywords.
function extractDocText(buf) {
  // Try UTF-16LE first (Word stores body text as UCS2 in most .doc files).
  const u16 = [];
  for (let i = 0; i + 1 < buf.length; i += 2) {
    const code = buf.readUInt16LE(i);
    if (code === 0x09 || code === 0x0A || code === 0x0D || (code >= 0x20 && code <= 0x7E)) {
      u16.push(String.fromCharCode(code));
    } else if (u16.length && u16[u16.length - 1] !== '\n') {
      u16.push('\n');
    }
  }
  const text = u16.join('').replace(/\n{3,}/g, '\n\n').trim();
  if (text.length > 200) return text;
  // Fallback: ASCII-only scrape.
  return buf.toString('latin1').replace(/[^\x09\x0A\x0D\x20-\x7E]+/g, ' ').trim();
}

// ─── FD approach-analysis — VERBATIM port of the Accenture artifact ───────────
// These six constants are copied byte-for-byte from
// S4PublicCloud_RCEFW_Builder.jsx so a dedicated claude -p call issued with
// FD_ANALYSIS_PROMPT_TEMPLATE lands on the same `recommended` value the
// artifact produces for the same FD. The FD analysis runs as its OWN
// claude invocation (parallel to the code review) so the code's detected
// technology cannot bias the extensibility decision.
const FD_ART_TAXONOMY = `S/4HANA PUBLIC CLOUD EXTENSIBILITY MODEL — there are exactly THREE extensibility types. Classify every requirement precisely into one (or a justified combination):
1. KEY USER EXTENSIBILITY (in-app, low-code / no-code via web-based Key User tools — no ABAP): custom fields, custom CDS views (Key User), custom business objects, custom logic through PRE-DELIVERED BAdIs / enhancement spots, UI adaptation (Adapt UI), flexible workflow, custom forms & email templates, situation handling, custom analytical queries.
2. DEVELOPER EXTENSIBILITY (in-app, pro-code — ABAP Cloud / RAP in the embedded S/4HANA Cloud ABAP Environment "Embedded Steampunk", via ADT/Eclipse): RAP behavior definitions & business objects on released CDS, released APIs and released extension points only. No classic ABAP, no BAPIs, no custom BAdI creation.
3. SIDE-BY-SIDE EXTENSIBILITY (decoupled apps/services on SAP BTP, integrated ONLY via released remote APIs from SAP Business Accelerator Hub and business events): built with the BTP services listed below.`;

const FD_ART_BTP_SERVICES = `SAP BTP SERVICES FOR PUBLIC-CLOUD SIDE-BY-SIDE (use ONLY services available for S/4HANA Public Cloud per the SAP Discovery Center; name each exactly, do not invent services):
- Pro-code app dev: SAP Build Code, SAP Cloud Application Programming Model (CAP / CAPM), SAP Business Application Studio (BAS), SAPUI5 / SAP Fiori elements, SAP BTP ABAP Environment (Steampunk)
- Low-code / no-code: SAP Build Apps, SAP Build Process Automation (SBPA), SAP Build Work Zone (standard / advanced)
- Integration & events: SAP Integration Suite (Cloud Integration / iFlows, API Management), SAP Event Mesh / SAP Integration Suite advanced event mesh
- Data & analytics: SAP HANA Cloud, SAP Datasphere, SAP Analytics Cloud
- Content & documents: SAP Document Management Service (DMS), SAP Forms Service by Adobe
- AI: SAP AI Core, SAP AI Launchpad, Generative AI Hub, Joule / Joule Studio
- Mobile: SAP Mobile Services (MDK)
- Foundation (required by BTP apps): SAP Authorization & Trust Management (XSUAA) / SAP Cloud Identity Services (IAS / IPS), Destination service, Connectivity service, and a runtime (Cloud Foundry or Kyma)
S/4HANA data is reachable from BTP ONLY through released remote OData/SOAP APIs (SAP Business Accelerator Hub) and business events — never direct DB access or unreleased interfaces.`;

const FD_ART_REFS = `AUTHORITATIVE SOURCES (verify every object/API/service against these — do not invent identifiers):
- S/4HANA Public Cloud released APIs, CDS views, events, extension points: SAP Business Accelerator Hub → https://hub.sap.com/products/SAPS4HANACloud/overview
- SAP BTP services (availability, plans, APIs): SAP Business Accelerator Hub → https://hub.sap.com/products/SAPCloudPlatform/overview
- BTP service catalogue, missions & SAP AI services: SAP Discovery Center → https://discovery-center.cloud.sap/
When you name an API, CDS view, event, BAdI, or BTP service, state that it must be confirmed on the relevant hub above and give its expected hub path. If you are not certain an identifier exists, say so explicitly rather than guessing.`;

const FD_ART_AI_FIRST = `STANDARD-FIRST & AI-FIRST EVALUATION (MANDATORY — do this BEFORE proposing any custom development):
Step 1 — Standard capability: check whether standard SAP configuration / a delivered app or best-practice scope item already meets the requirement. If yes, prefer it.
Step 2 — Standard SAP AI: check whether a delivered SAP AI capability already covers the need before building anything custom. Consider, and name explicitly when relevant:
  - Joule (copilot: informational, navigational, transactional/actionable scenarios; Joule Base is included at no extra cost) and Joule Agents (e.g. Project Setup Agent, Tender Analysis Agent) built/extended via Joule Studio in SAP Build
  - Embedded AI in SAP S/4HANA Public Cloud (Base vs Premium AI): e.g. SAP Document AI (document information extraction — quality certificates, invoices, sales-order creation from unstructured docs), AI-assisted account/GL & costing-variant explanations, cash application / payment-exception assistance, situation handling, predictive analytics, AI-driven international trade classification, smart summarization on Fiori elements
  - SAP AI Foundation on BTP for building custom AI only where standard does not fit: SAP AI Core, SAP AI Launchpad, Generative AI Hub, Document Information Extraction service — note these consume SAP AI Units
Step 3 — Only if standard config and standard SAP AI do NOT meet the requirement, proceed to Key User / Developer / Side-by-Side custom development, and state clearly why the standard/AI options were insufficient.
Verify AI feature availability and cost tier (Base vs Premium / AI Units) on the SAP Discovery Center (https://discovery-center.cloud.sap/) and SAP Business Accelerator Hub. Never assume an AI feature exists — confirm it.`;

const FD_ART_UI_HOSTING = `UI PLACEMENT & APPROACH-CONSISTENCY RULES (critical — never contradict yourself):
- SAP Fiori Elements apps (annotation-driven: List Report, Object Page, Analytical List Page, Overview Page) generated on a released or custom RAP OData service run IN-APP and are part of DEVELOPER EXTENSIBILITY — they do NOT require SAP BTP. A standard list→detail (two-screen) flow, table actions, and a confirmation/action dialog (e.g. Calculate / Save) that ARE achievable through Fiori Elements annotations + RAP actions stay PURE Developer Extensibility. Do not label these as a limitation and do not push them to BTP.
- The BTP (side-by-side) layer is required — making the answer a MIXED "Developer + BTP" (id "inapp_btp") or "Side-by-Side" recommendation — only when the UI/app genuinely cannot be delivered by Fiori Elements on RAP, e.g.: freestyle SAPUI5 with bespoke controls or non-standard multi-step UX beyond FE annotations, custom UI hosting on SAP Build Work Zone, CAP services, Integration Suite / Event Mesh, cross-system or non-SAP orchestration, or any artifact deployed on BTP.
- SELF-CONSISTENCY (mandatory): the recommended approach MUST match the artifacts you list. If ANY tool or limitation you list for the recommended approach implies a BTP-hosted artifact (freestyle SAPUI5 on BTP, CAP, SAP Build, Integration Suite, Event Mesh, BAS-deployed UI, etc.), you MUST recommend the corresponding MIXED approach ("inapp_btp") or "sidebyside" — NEVER a pure in-app approach (customisation / keyuser / developer). It is a contradiction to describe a BTP artifact as a "limitation" of a pure approach and still recommend that pure approach.
- Conversely, if Fiori Elements on RAP fully covers the UI, do NOT invent a BTP need — keep it pure Developer Extensibility and state explicitly that no BTP layer is required and why.`;

const FD_ART_UI_TRADEOFF = `UI EFFORT vs COST TRADE-OFF (weigh this in EVERY UI-bearing recommendation — do not decide on "can it be built in-app?" alone):
- First classify the UI nature: (a) display/reporting, (b) standard transactional (create/edit forms, list→detail, simple actions), or (c) dynamic/interactive (conditional rendering, bespoke controls, wizards, live recalculation, drag/drop, heavy client-side logic).
- Fiori Elements on RAP (in-app / Developer Extensibility): NO incremental runtime or licensing cost — it runs inside the S/4HANA Cloud you already own — BUT development effort and complexity rise sharply for non-standard or dynamic UI: annotation limits, verbose RAP/behavior code, and disproportionate effort for small bespoke interactions (even a single custom button/action can require substantial code). Strong fit for (a) and (b).
- Freestyle SAPUI5 / apps on SAP BTP (Side-by-Side): far more flexible and usually faster to build for dynamic/interactive UX and custom controls, BUT carries a real COMMERCIAL COST — BTP runtime (Cloud Foundry / Kyma), service plans, HTML5 app hosting / SAP Build Work Zone, plus any SAP AI Units — and its own lifecycle / DevOps overhead. Often the pragmatic fit for (c).
- DECISION RULE: balance (1) UI complexity & feasibility and the RAP build effort it implies against (2) the BTP commercial cost. If FE-on-RAP fits with reasonable effort, prefer it and note the zero incremental runtime cost. If the UI is dynamic/complex enough that RAP effort becomes disproportionate or infeasible, recommend Developer + BTP and STATE the trade-off explicitly: BTP cost is accepted to gain feasibility / better UX / lower build effort. Always make the cost-vs-effort reasoning visible in the recommendation.`;

// Verbatim port of getAnalysisPrompt(fd) from the artifact's .jsx. The
// JSON skeleton at the bottom is kept identical so Claude follows the same
// structured deliberation and `recommended` matches the artifact's output.
function buildFdAnalysisPrompt(fdText) {
  return `You are an SAP S/4HANA Public Cloud Solution Architect. Analyze the provided Functional Design and evaluate exactly 6 approaches.

CRITICAL S/4HANA PUBLIC CLOUD RULES (apply to ALL approaches):
- NO BAPIs — they do not exist in S/4HANA Public Cloud
- NO custom BAdI creation — ONLY pre-delivered BAdIs from Business Accelerator Hub can be used
- CDS Views: ONLY released CDS views (C1 contract) from Business Accelerator Hub
- APIs: ONLY released APIs via Communication Scenarios from Business Accelerator Hub
- ABAP Cloud (Tier 1 released objects) only — no classic ABAP
- Business Accelerator Hub is the single source of truth

${FD_ART_TAXONOMY}

${FD_ART_BTP_SERVICES}

${FD_ART_AI_FIRST}

${FD_ART_REFS}

${FD_ART_UI_HOSTING}

${FD_ART_UI_TRADEOFF}

Map the 6 approaches to this model: "keyuser" = Key User Extensibility; "developer" = Developer Extensibility (RAP); "sidebyside" = Side-by-Side on BTP (populate "tools" ONLY from the BTP services list above); "customisation" = standard config only; the two mixed approaches combine the pillars. For any approach that uses BTP, its "tools" must be exact service names from the list above.
Additionally, in "recommendation_reason" you MUST state the result of the Standard-First & AI-First evaluation: whether a standard SAP capability or a standard SAP AI service (name it) could meet the requirement, and if so why it is preferred over custom development — or why custom development is nonetheless required.

For the two mixed approaches, include a "layer_split" object that clearly states what each layer handles and why both are needed.
For a mixed recommendation, explain what drives each layer.
For a pure recommendation, explain why mixed would be over-engineering.

FUNCTIONAL DESIGN:
${fdText}

RESPOND WITH ONLY VALID JSON — a single complete object, no markdown, no backticks, no preamble. Keep it COMPACT to avoid truncation: each of benefits/limitations/tools = max 3 short items; each summary = max 2 sentences; do not pad. Ensure the JSON is fully closed.
{
  "approaches": [
    { "id": "customisation",  "name": "Customisation (Standard Configuration)",       "feasibility_score": 6, "effort": "Low",    "risk": "Low",    "can_fully_meet": false, "benefits": ["..."], "limitations": ["..."], "tools": ["..."], "summary": "2-3 sentences" },
    { "id": "keyuser",        "name": "Key User Extensibility",                       "feasibility_score": 6, "effort": "Medium", "risk": "Low",    "can_fully_meet": false, "benefits": ["..."], "limitations": ["..."], "tools": ["..."], "summary": "..." },
    { "id": "developer",      "name": "Developer Extensibility (ABAP Cloud / RAP)",   "feasibility_score": 8, "effort": "High",   "risk": "Medium", "can_fully_meet": true,  "benefits": ["..."], "limitations": ["..."], "tools": ["..."], "summary": "..." },
    { "id": "sidebyside",     "name": "Side-by-Side Extensibility (SAP BTP)",         "feasibility_score": 7, "effort": "High",   "risk": "High",   "can_fully_meet": true,  "benefits": ["..."], "limitations": ["..."], "tools": ["..."], "summary": "..." },
    { "id": "inapp_btp",      "name": "In-App + BTP Mixed",                           "feasibility_score": 9, "effort": "High",   "risk": "Medium", "can_fully_meet": true,  "benefits": ["..."], "limitations": ["..."], "tools": ["..."], "summary": "...", "layer_split": { "layer1_label": "S/4HANA In-App (RAP / ABAP Cloud)", "layer1_handles": ["business logic","CDS data model","OData service exposure"], "layer2_label": "SAP BTP (CAP / Integration Suite)", "layer2_handles": ["complex UI","cross-system orchestration","non-SAP integration"], "why_both_needed": "RAP handles core S/4 logic efficiently; BTP is required because..." } },
    { "id": "keyuser_inapp",  "name": "Key User + In-App Mixed",                      "feasibility_score": 8, "effort": "Medium", "risk": "Low",    "can_fully_meet": true,  "benefits": ["..."], "limitations": ["..."], "tools": ["..."], "summary": "...", "layer_split": { "layer1_label": "Key User Layer (Fiori-based, no ABAP)", "layer1_handles": ["custom fields","simple validations via BAdI","screen adaptations"], "layer2_label": "In-App RAP Layer (ABAP Cloud)", "layer2_handles": ["complex business logic","custom entities","advanced validations"], "why_both_needed": "Key User covers configuration-level needs without dev effort; RAP is needed only where..." } }
  ],
  "recommended": "developer",
  "recommendation_reason": "3-4 sentence justification. If mixed recommended, explain what drives each layer. If pure, explain why mixed would be over-engineering.",
  "ai_evaluation": { "standard_capability": "Does standard SAP config / a delivered app already cover this? yes/no + which.", "standard_ai": "Name any delivered SAP AI capability that could meet the need (Joule / Joule Agent, SAP Document AI, embedded AI feature, etc.), or 'none applicable'.", "recommendation": "Use standard SAP AI | Extend a standard SAP AI feature | Custom build required", "reason": "1-2 sentences on why standard/AI is or is not sufficient." },
  "ui_tradeoff":   { "ui_nature": "display | standard transactional | dynamic/interactive", "rap_effort": "effort & complexity of delivering this UI as Fiori Elements on RAP (note: NO incremental runtime cost).", "btp_cost": "flexibility BTP adds for this UI AND its commercial cost (runtime, service plans, hosting, AI units).", "verdict": "Fiori Elements on RAP (in-app, no runtime cost) | Developer + BTP (accept BTP cost for feasibility/UX)" }
}`;
}

// Extract the first balanced top-level JSON object from arbitrary text —
// brace-aware, string-aware, same algorithm the artifact uses.
function extractJsonObject(text) {
  const start = text.indexOf('{');
  if (start < 0) return null;
  let depth = 0, inStr = false, esc = false;
  for (let i = start; i < text.length; i++) {
    const c = text[i];
    if (inStr) {
      if (esc) esc = false;
      else if (c === '\\') esc = true;
      else if (c === '"') inStr = false;
    } else {
      if (c === '"') inStr = true;
      else if (c === '{') depth++;
      else if (c === '}') { depth--; if (depth === 0) return text.slice(start, i + 1); }
    }
  }
  return null;
}

// Run a SEPARATE claude -p invocation whose entire context is the FD plus
// the artifact's prompt — no code review context, no file I/O, no agent
// personas. Returns the parsed JSON ({ approaches, recommended, ... }) or
// null on failure. Isolation from the code-review call is the whole point:
// it stops detected technologies in the code from biasing the extensibility
// recommendation.
async function runFdAnalysis(fdText, project) {
  if (!CLAUDE_BIN || !fdText || !fdText.trim()) return null;
  const prompt = buildFdAnalysisPrompt(fdText) +
    `\n\nOUTPUT ONLY the JSON object described above. No prose, no backticks, no explanation. ` +
    `Your entire reply must be a single valid JSON object starting with "{" and ending with "}".\n`;

  const promptFile = path.join(ROOT, 'reports', `.fd-prompt-${project}.txt`);
  try { fs.writeFileSync(promptFile, prompt, 'utf8'); }
  catch (e) { console.warn(`[fd-analysis] could not write prompt file: ${e.message}`); return null; }

  const isWin = process.platform === 'win32';
  const winCmd = `type "${promptFile}" | "${CLAUDE_BIN}" -p --permission-mode bypassPermissions --dangerously-skip-permissions --output-format text`;
  const nixCmd = `cat "${promptFile}" | "${CLAUDE_BIN}" -p --permission-mode bypassPermissions --dangerously-skip-permissions --output-format text`;
  console.log(`[fd-analysis] launching dedicated claude for project="${project}" (isolated from code review)`);
  const out = await runProcess(isWin ? winCmd : nixCmd, [], { timeoutMs: 5 * 60 * 1000, shell: true });
  try { fs.unlinkSync(promptFile); } catch {}

  if (!out || !out.stdout) {
    console.warn(`[fd-analysis] empty stdout (exit=${out && out.code}, timedOut=${out && out.timedOut})`);
    return null;
  }
  const stripped = out.stdout.replace(/```json\s*/g, '').replace(/```\s*/g, '').trim();
  const jsonText = extractJsonObject(stripped);
  if (!jsonText) {
    console.warn(`[fd-analysis] could not locate a JSON object in claude output`);
    return null;
  }
  let parsed;
  try { parsed = JSON.parse(jsonText); }
  catch (_e1) {
    try { parsed = JSON.parse(jsonText.replace(/,\s*([}\]])/g, '$1')); } catch (e2) {
      console.warn(`[fd-analysis] JSON.parse failed: ${e2.message}`);
      return null;
    }
  }
  if (!parsed || typeof parsed.recommended !== 'string' || !parsed.recommended.trim()) {
    console.warn(`[fd-analysis] parsed JSON missing "recommended" field`);
    return null;
  }
  console.log(`[fd-analysis] success — recommended="${parsed.recommended}"`);
  return parsed;
}

// Read every .doc / .docx file under uploads/<project>/.functional-design/
// and return a single plain-text block for the agent prompt.
async function loadFunctionalDesign(uploadDir) {
  const dir = path.join(uploadDir, FUNCTIONAL_DESIGN_DIR);
  if (!fs.existsSync(dir)) return '';
  let entries;
  try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return ''; }
  const chunks = [];
  for (const e of entries) {
    if (!e.isFile()) continue;
    const ext = path.extname(e.name).toLowerCase();
    if (ext !== '.doc' && ext !== '.docx') continue;    // hard filter
    const full = path.join(dir, e.name);
    try {
      const buf = fs.readFileSync(full);
      const text = ext === '.docx' ? extractDocxText(buf) : extractDocText(buf);
      const clipped = text.slice(0, 100000);
      chunks.push(`----- FILE: ${e.name} -----\n${clipped}`);
    } catch (err) {
      chunks.push(`----- FILE: ${e.name} (parse error: ${err.message}) -----`);
    }
  }
  return chunks.join('\n\n');
}

// Read all files under uploads/<project>/.client-suggestions/ and return
// one plain-text block the agent can read inline. Only .txt and .xlsx are
// accepted; everything else is ignored (and should have been blocked at
// upload time anyway).
async function loadClientSuggestions(uploadDir) {
  const dir = path.join(uploadDir, CLIENT_SUGGESTIONS_DIR);
  if (!fs.existsSync(dir)) return '';
  let entries;
  try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return ''; }
  const chunks = [];
  for (const e of entries) {
    if (!e.isFile()) continue;
    const ext = path.extname(e.name).toLowerCase();
    if (ext !== '.txt' && ext !== '.xlsx') continue;
    const full = path.join(dir, e.name);
    try {
      if (ext === '.txt') {
        chunks.push(`----- FILE: ${e.name} -----\n` + fs.readFileSync(full, 'utf8').trim());
      } else if (ext === '.xlsx') {
        if (!ExcelJS) {
          chunks.push(`----- FILE: ${e.name} (xlsx reader unavailable — run \`npm install\`) -----`);
          continue;
        }
        const wb = new ExcelJS.Workbook();
        await wb.xlsx.readFile(full);
        const sheetTexts = [];
        wb.eachSheet(sheet => {
          const lines = [`## Sheet: ${sheet.name}`];
          sheet.eachRow({ includeEmpty: false }, row => {
            const cells = [];
            row.eachCell({ includeEmpty: false }, c => {
              const v = c.value;
              if (v == null) cells.push('');
              else if (typeof v === 'object' && v.richText) cells.push(v.richText.map(r => r.text).join(''));
              else if (typeof v === 'object' && v.text) cells.push(String(v.text));
              else cells.push(String(v));
            });
            lines.push(cells.join(' | '));
          });
          sheetTexts.push(lines.join('\n'));
        });
        chunks.push(`----- FILE: ${e.name} -----\n` + sheetTexts.join('\n\n'));
      }
    } catch (err) {
      chunks.push(`----- FILE: ${e.name} (parse error: ${err.message}) -----`);
    }
  }
  return chunks.join('\n\n');
}

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

// PUT /api/upload-suggestions/<project>/<filename>
// Writes client suggestion files to uploads/<project>/.client-suggestions/.
// Restricted to .txt / .xlsx only.
async function handleUploadSuggestions(req, res, url) {
  const parts = url.pathname.replace(/^\/api\/upload-suggestions\//, '').split('/').filter(Boolean);
  if (parts.length < 2) return sendJson(res, 400, { ok: false, error: 'project and filename required' });
  const project = sanitizeProject(decodeURIComponent(parts[0]));
  if (!project) return sendJson(res, 400, { ok: false, error: 'invalid project name' });
  const filename = decodeURIComponent(parts.slice(1).join('/'));
  if (filename.includes('/') || filename.includes('\\') || filename === '.' || filename === '..') {
    return sendJson(res, 400, { ok: false, error: 'invalid filename' });
  }
  if (!/\.(txt|xlsx)$/i.test(filename)) {
    return sendJson(res, 400, { ok: false, error: 'Only .txt or .xlsx files are accepted for client suggestions' });
  }
  const dir = path.join(ROOT, 'uploads', project, CLIENT_SUGGESTIONS_DIR);
  try { fs.mkdirSync(dir, { recursive: true }); }
  catch (e) { return sendJson(res, 500, { ok: false, error: 'mkdir failed: ' + e.message }); }
  const target = path.join(dir, filename);
  if (!target.startsWith(dir + path.sep)) return sendJson(res, 400, { ok: false, error: 'path escapes directory' });
  const ws = fs.createWriteStream(target);
  req.pipe(ws);
  ws.on('finish', () => sendJson(res, 200, { ok: true, path: `uploads/${project}/${CLIENT_SUGGESTIONS_DIR}/${filename}` }));
  ws.on('error', () => { try { res.destroy(); } catch {} });
  req.on('error', () => { try { ws.destroy(); } catch {} });
}

// PUT /api/upload-fd/<project>/<filename> — functional-design document.
// Restricted to .doc / .docx only.
async function handleUploadFd(req, res, url) {
  const parts = url.pathname.replace(/^\/api\/upload-fd\//, '').split('/').filter(Boolean);
  if (parts.length < 2) return sendJson(res, 400, { ok: false, error: 'project and filename required' });
  const project = sanitizeProject(decodeURIComponent(parts[0]));
  if (!project) return sendJson(res, 400, { ok: false, error: 'invalid project name' });
  const filename = decodeURIComponent(parts.slice(1).join('/'));
  if (filename.includes('/') || filename.includes('\\') || filename === '.' || filename === '..') {
    return sendJson(res, 400, { ok: false, error: 'invalid filename' });
  }
  if (!/\.(docx?|DOCX?)$/.test(filename)) {
    return sendJson(res, 400, { ok: false, error: 'Only .doc or .docx files are accepted for the Functional Design' });
  }
  const dir = path.join(ROOT, 'uploads', project, FUNCTIONAL_DESIGN_DIR);
  try { fs.mkdirSync(dir, { recursive: true }); }
  catch (e) { return sendJson(res, 500, { ok: false, error: 'mkdir failed: ' + e.message }); }
  const target = path.join(dir, filename);
  if (!target.startsWith(dir + path.sep)) return sendJson(res, 400, { ok: false, error: 'path escapes directory' });
  const ws = fs.createWriteStream(target);
  req.pipe(ws);
  ws.on('finish', () => sendJson(res, 200, { ok: true, path: `uploads/${project}/${FUNCTIONAL_DESIGN_DIR}/${filename}` }));
  ws.on('error', () => { try { res.destroy(); } catch {} });
  req.on('error', () => { try { ws.destroy(); } catch {} });
}

async function handleClearFd(req, res, url) {
  const parts = url.pathname.replace(/^\/api\/upload-fd\//, '').split('/').filter(Boolean);
  const project = sanitizeProject(decodeURIComponent(parts[0] || ''));
  if (!project) return sendJson(res, 400, { ok: false, error: 'project required' });
  const dir = path.join(ROOT, 'uploads', project, FUNCTIONAL_DESIGN_DIR);
  try { if (fs.existsSync(dir)) fs.rmSync(dir, { recursive: true, force: true }); }
  catch (e) { return sendJson(res, 500, { ok: false, error: e.message }); }
  sendJson(res, 200, { ok: true });
}

// DELETE /api/upload-suggestions/<project> — clear all client suggestions.
async function handleClearSuggestions(req, res, url) {
  const parts = url.pathname.replace(/^\/api\/upload-suggestions\//, '').split('/').filter(Boolean);
  const project = sanitizeProject(decodeURIComponent(parts[0] || ''));
  if (!project) return sendJson(res, 400, { ok: false, error: 'project required' });
  const dir = path.join(ROOT, 'uploads', project, CLIENT_SUGGESTIONS_DIR);
  try { if (fs.existsSync(dir)) fs.rmSync(dir, { recursive: true, force: true }); }
  catch (e) { return sendJson(res, 500, { ok: false, error: e.message }); }
  sendJson(res, 200, { ok: true });
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
  // Sidecar folders uploaded independently of the code (Functional Design,
  // Client Suggestions). They must NOT be wiped when the code folder is
  // reset for a fresh code upload — otherwise an FD uploaded in Card 1a is
  // silently deleted the moment the user drops the project ZIP in Card 2.
  const PRESERVE = [FUNCTIONAL_DESIGN_DIR, CLIENT_SUGGESTIONS_DIR];
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
    if (fs.existsSync(dir)) {
      // Delete every entry except the preserved sidecars.
      for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        if (PRESERVE.includes(entry.name)) continue;
        const full = path.join(dir, entry.name);
        try { fs.rmSync(full, { recursive: true, force: true }); }
        catch (e) { console.warn(`[reset] failed to remove ${full}: ${e.message}`); }
      }
    } else {
      fs.mkdirSync(dir, { recursive: true });
    }
    sendJson(res, 200, { ok: true, purged, preserved: PRESERVE });
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

  // Safety-net: re-assert workspace trust on every review in case the user
  // reset ~/.claude.json between runs. Cheap; idempotent.
  ensureWorkspaceTrust(ROOT);

  const agentBody = loadAgentInstructions();
  if (!agentBody) {
    return sendJson(res, 500, {
      ok: false,
      error: 'Missing .claude/agents/sap-code-reviewer.md — cannot build review prompt.',
    });
  }

  // Load Functional Design (optional). The approach decision is NOT done
  // inside the code-review prompt any more — it runs as a dedicated,
  // isolated `claude -p` invocation (runFdAnalysis) in parallel with the
  // code review, so detected code technologies cannot bias the
  // recommendation. The result is merged into the findings JSON after
  // both calls complete.
  // The reasoning blocks below (TAXONOMY, BTP_SERVICES, AI_FIRST, REFS,
  // UI_HOSTING, UI_TRADEOFF) are copied VERBATIM from the Accenture
  // "S4publiccloud rcefw builder" Claude artifact so this agent lands on the
  // same `recommended` approach id as the artifact when given the same FD.
  // Scoring, ratings, UI, color coding are intentionally NOT asked for —
  // we only need the single `recommended` id.
  const functionalDesign = await loadFunctionalDesign(uploadDir);
  // The FD block that previously lived here has been removed. FD analysis
  // now runs as a dedicated, isolated claude -p invocation (runFdAnalysis)
  // in parallel with the code review — see the Promise.all below.
  const _unusedPlaceholder_dropped = `inline FD block dropped — see runFdAnalysis`;

  // (Historical inline FD block removed — replaced by dedicated
  //  runFdAnalysis call that fires in parallel with the code review.)

  // Load any client-provided suggestions and inline them into the prompt.
  const clientSuggestions = await loadClientSuggestions(uploadDir);
  const suggestionsBlock = clientSuggestions
    ? `\n\n===== CLIENT SUGGESTIONS =====\n` +
      `The following rules were supplied by the client. Apply them with the\n` +
      `"baseline AS-IS, client-priority annotation" rule:\n` +
      `  1. Run the FULL baseline review first — do NOT drop or alter a baseline\n` +
      `     finding because a client rule mentions the same topic.\n` +
      `  2. For every baseline finding, check if any client rule relates to it\n` +
      `     (same file / API / category / defect class). If YES, DO NOT replace\n` +
      `     the baseline text — keep ALL baseline fields unchanged, just flip\n` +
      `     "source" to "client" and add a new "clientNote" field containing a\n` +
      `     1–2 sentence summary of the exact client instruction that applies.\n` +
      `  3. Also add any additional client-only findings (defects the baseline\n` +
      `     missed) with "source": "client" and a "clientNote".\n` +
      `  4. Pure baseline findings keep "source": "baseline" (or omit it) and\n` +
      `     do NOT get a clientNote.\n` +
      `  5. Invariant: total_with_client >= total_without_client. If your count\n` +
      `     drops below the client-less run, you have misapplied the rule.\n\n` +
      clientSuggestions +
      `\n===== END CLIENT SUGGESTIONS =====\n`
    : '';

  // Build a self-contained prompt: agent instructions + the specific task.
  // Running the checks inline (rather than dispatching to a subagent) is far
  // more reliable in `-p` headless mode.
  const prompt =
    `You are running as the sap-code-reviewer for project "${project}".\n` +
    `Follow these instructions exactly:\n\n` +
    `----- BEGIN AGENT INSTRUCTIONS -----\n${agentBody}\n----- END AGENT INSTRUCTIONS -----\n` +
    suggestionsBlock +
    `\nConcrete task:\n` +
    `  * Project name: ${project}\n` +
    `  * Source folder: uploads/${project}/ (relative to the current working directory)\n` +
    `  * Output JSON file: reports/${project}-findings.json\n` +
    `  * Follow the schema in samples/example-findings.json exactly.\n` +
    `  * Do NOT modify any file under uploads/. Read-only review.\n` +
    `  * Do NOT ask clarifying questions — proceed with sensible defaults.\n` +
    `  * When done, print ONLY the concise summary described in the final step of the agent instructions.\n` +
    `  * WRITE the JSON file before printing the summary.\n` +
    (clientSuggestions ?
       `  * Honor the CLIENT SUGGESTIONS block above using the baseline-AS-IS annotation rule:\n` +
       `    run the full baseline FIRST and never alter a baseline finding. For every baseline\n` +
       `    finding, if a client rule relates to it, keep all baseline fields unchanged, flip\n` +
       `    "source" to "client" and populate "clientNote" with a 1–2 sentence summary of the\n` +
       `    specific client instruction that applies. Also add any client-only findings. The\n` +
       `    final count MUST be >= the baseline-only count.\n`
       : '') +
    '';

  const findingsPath = path.join(ROOT, 'reports', `${project}-findings.json`);
  const preMtime = fs.existsSync(findingsPath) ? fs.statSync(findingsPath).mtimeMs : 0;

  // Delete any stale PDF / Excel from a previous run for this same project
  // name BEFORE kicking off the review. The UI's status poller watches these
  // files on disk; if we leave them in place the Download buttons would
  // appear while the current review is still running, pointing at the OLD
  // output. Non-fatal if deletion fails.
  const stalePdf  = path.join(ROOT, 'reports', `${project}-review.pdf`);
  const staleXlsx = path.join(ROOT, 'reports', `${project}-review.xlsx`);
  for (const p of [stalePdf, staleXlsx]) {
    if (fs.existsSync(p)) {
      try { fs.unlinkSync(p); console.log(`[review] cleared stale output: ${path.basename(p)}`); }
      catch (e) { console.warn(`[review] could not delete ${p}: ${e.message}`); }
    }
  }

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

  // Deterministic, content-addressed cache. The UI auto-generates a new
  // timestamped project name on every page load, so two uploads of the
  // same content under different project names used to miss cache and
  // trigger a fresh (stochastic) LLM run, which produces slightly different
  // findings each time — 71 one run, 78 the next. Keying by content hash
  // means identical bytes ALWAYS return identical findings.
  const contentCacheDir  = path.join(ROOT, 'reports', '.cache');
  const contentCachePath = path.join(contentCacheDir, `${sourceHash}.json`);

  // When FD is present we require the cached entry to ALSO have a parsed
  // approachAnalysis — otherwise the cache was built under old server code
  // that never ran the dedicated FD analysis. Accepting such a cache entry
  // would silently return a stale (wrong) suggestedApproach forever.
  const cacheIsFresh = (payload) => {
    if (!payload || payload._sourceHash !== sourceHash) return false;
    if (functionalDesign && !payload.approachAnalysis) {
      console.log(`[review] cache REJECTED — FD uploaded but cached entry lacks approachAnalysis (pre-FD-isolation build)`);
      return false;
    }
    return true;
  };

  let cacheHit = false;
  // 1) Project-scoped cache (findings file already exists with matching hash)
  if (fs.existsSync(findingsPath)) {
    try {
      const prev = JSON.parse(fs.readFileSync(findingsPath, 'utf8'));
      if (cacheIsFresh(prev)) {
        cacheHit = true;
        console.log(`[review] cache HIT (project) project="${project}" hash=${sourceHash.slice(0, 12)}… — skipping claude`);
      }
    } catch {}
  }
  // 2) Cross-project content-addressed cache
  if (!cacheHit && fs.existsSync(contentCachePath)) {
    try {
      const cached = JSON.parse(fs.readFileSync(contentCachePath, 'utf8'));
      if (cacheIsFresh(cached)) {
        // Rewrite the project name on the cached payload so downstream
        // exports still carry the user's current project label.
        cached.project = project;
        fs.mkdirSync(path.dirname(findingsPath), { recursive: true });
        fs.writeFileSync(findingsPath, JSON.stringify(cached, null, 2), 'utf8');
        cacheHit = true;
        console.log(`[review] cache HIT (content) project="${project}" hash=${sourceHash.slice(0, 12)}… — reused from .cache/`);
      } else if (functionalDesign) {
        // Delete the poisoned entry so it can't trip us again on the next
        // review of the same content.
        try { fs.unlinkSync(contentCachePath); console.log(`[review] removed poisoned cache entry ${sourceHash.slice(0, 12)}…`); } catch {}
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

    // Launch FD analysis in parallel. This is a SEPARATE claude -p call whose
    // only input is the Functional Design text + the artifact's exact prompt
    // (TAXONOMY, BTP_SERVICES, AI_FIRST, REFS, UI_HOSTING, UI_TRADEOFF). It
    // has ZERO access to the uploaded code or the code-review ruleset, so the
    // detected tech cannot bias its recommendation.
    const fdAnalysisPromise = functionalDesign
      ? runFdAnalysis(functionalDesign, project).catch(e => {
          console.warn(`[fd-analysis] threw: ${e.message}`);
          return null;
        })
      : Promise.resolve(null);

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

    // Wait for the dedicated FD-analysis call to finish (whether or not the
    // code review succeeded). Its result gets merged into the findings JSON
    // below so the exporters see suggestedApproach + approachAnalysis.
    const fdAnalysisResult = await fdAnalysisPromise;
    if (functionalDesign) {
      console.log(`[fd-analysis] final result:`,
        fdAnalysisResult ? `recommended=${fdAnalysisResult.recommended}` : 'null');
    }

    // Stamp the source hash into the findings JSON so future re-runs of the
    // same upload can short-circuit the LLM. Non-fatal if it fails.
    if (fs.existsSync(findingsPath)) {
      try {
        const j = JSON.parse(fs.readFileSync(findingsPath, 'utf8'));
        j._sourceHash = sourceHash;
        j._reviewedAt = j.reviewedAt || new Date().toISOString();
        // Merge the dedicated FD analysis into the findings JSON. The
        // exporters only display `suggestedApproach`; `approachAnalysis` is
        // preserved for traceability and so a future re-run can diff.
        if (fdAnalysisResult && typeof fdAnalysisResult.recommended === 'string' && fdAnalysisResult.recommended.trim()) {
          j.suggestedApproach = fdAnalysisResult.recommended.trim();
          j.approachAnalysis  = fdAnalysisResult;
        }
        fs.writeFileSync(findingsPath, JSON.stringify(j, null, 2), 'utf8');
        // Also write a copy into the content-addressed cache so a different
        // project name uploading the same bytes gets the identical result.
        try {
          fs.mkdirSync(contentCacheDir, { recursive: true });
          fs.writeFileSync(contentCachePath, JSON.stringify(j, null, 2), 'utf8');
          console.log(`[review] content cache populated at .cache/${sourceHash.slice(0,12)}….json`);
        } catch (e) {
          console.warn('[review] could not write content cache:', e.message);
        }
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

  // Report how many sidecar files were actually read by the agent so the UI
  // can tell the user whether the FD / client suggestions made it in.
  const fdDir = path.join(uploadDir, FUNCTIONAL_DESIGN_DIR);
  const csDir = path.join(uploadDir, CLIENT_SUGGESTIONS_DIR);
  const fdCount = fs.existsSync(fdDir) ? fs.readdirSync(fdDir).filter(n => /\.(docx?|DOCX?)$/.test(n)).length : 0;
  const csCount = fs.existsSync(csDir) ? fs.readdirSync(csDir).filter(n => /\.(txt|xlsx)$/i.test(n)).length : 0;

  return sendJson(res, 200, {
    ok: true,
    project,
    xlsxUrl: xlsxExists ? `/reports/${project}-review.xlsx` : null,
    pdfUrl:  pdfExists  ? `/reports/${project}-review.pdf`  : null,
    summary: findings && findings.summary,
    technologies: findings && findings.technologies,
    suggestedApproach: findings && findings.suggestedApproach,
    counts: findings && {
      total: list.length,
    },
    functionalDesignFiles: fdCount,
    clientSuggestionsFiles: csCount,
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
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS');
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
  if (req.method === 'PUT' && url.pathname.startsWith('/api/upload-suggestions/')) {
    return handleUploadSuggestions(req, res, url);
  }
  if (req.method === 'DELETE' && url.pathname.startsWith('/api/upload-suggestions/')) {
    return handleClearSuggestions(req, res, url);
  }
  if (req.method === 'PUT' && url.pathname.startsWith('/api/upload-fd/')) {
    return handleUploadFd(req, res, url);
  }
  if (req.method === 'DELETE' && url.pathname.startsWith('/api/upload-fd/')) {
    return handleClearFd(req, res, url);
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
  // One-time: mark this workspace trusted so the claude CLI stops ignoring
  // the allow-list and --dangerously-skip-permissions.
  ensureWorkspaceTrust(ROOT);
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
