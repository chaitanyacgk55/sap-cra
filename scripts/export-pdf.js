// Reads reports/<project>-findings.json and writes reports/<project>-review.pdf
// Mimics the SAP Expertise on Demand report format.
// Run: node scripts/export-pdf.js <project-name>

'use strict';

const PDFDocument = require('pdfkit');
const fs = require('fs');
const path = require('path');
const { initFor, maskData } = require('./mask');

const ROOT = path.resolve(__dirname, '..');
const rawProject = process.argv[2];

if (!rawProject) { console.error('Usage: node export-pdf.js <project-name> [--client "Alias,..."]'); process.exit(1); }

const findingsPath = path.join(ROOT, 'reports', `${rawProject}-findings.json`);
if (!fs.existsSync(findingsPath)) {
  console.error(`Findings file not found: ${findingsPath}`);
  process.exit(1);
}

// ── Load + apply masking (client name, emails, IPs, tokens) ──────────────────
const raw = JSON.parse(fs.readFileSync(findingsPath, 'utf8'));
const { mask, maskedProject } = initFor(rawProject);
const data = maskData(raw, mask);

// Downstream display uses the masked project name; the raw name is still the
// file-system key so we can locate the JSON.
const project  = maskedProject;
const findings = Array.isArray(data.findings) ? data.findings : [];
const summary  = data.summary || {};
const techs    = Array.isArray(data.technologies) && data.technologies.length
  ? data.technologies.join(', ') : 'SAP';
const reviewDate = new Date(data.reviewedAt || Date.now())
  .toLocaleDateString('en-GB', { year: 'numeric', month: 'long', day: 'numeric' });

// ── Accenture Suggested vs Followed Approach (shown on page 1) ──────────────
const _techsLower = (data.technologies || []).map(t => String(t).toLowerCase());
const _hasUI5  = _techsLower.some(t => t.includes('ui5') || t.includes('fiori'));
const _hasCAP  = _techsLower.some(t => t === 'cap' || t.includes('capm'));
const _hasRAP  = _techsLower.includes('rap');
const _hasABAP = _techsLower.some(t => t.includes('abap'));
function _deriveFollowed() {
  const dev = _hasRAP || _hasABAP;
  const sxs = _hasCAP || (_hasUI5 && !dev);
  if (dev && sxs) return 'DEV_SXS';
  if (dev)       return 'DEVELOPER';
  if (sxs)       return 'SIDE_BY_SIDE';
  return 'UNKNOWN';
}
const followedApproach  = (data.followedApproach  && String(data.followedApproach).toUpperCase())  || _deriveFollowed();
const suggestedApproach = (data.suggestedApproach && String(data.suggestedApproach).toUpperCase()) || '';
const approachMismatch  = Boolean(suggestedApproach) && followedApproach !== 'UNKNOWN'
                          && suggestedApproach !== followedApproach;

const outPath = path.join(ROOT, 'reports', `${rawProject}-review.pdf`);

// ── Layout constants ──────────────────────────────────────────────────────────
const PW = 595.28, PH = 841.89, M = 50, TW = PW - M * 2;

// ── Colour palette ────────────────────────────────────────────────────────────
const C = {
  purple:     '#6D28D9',
  purplePale: '#EDE9FE',
  high:       '#DC2626', highBg:  '#FEF2F2',
  med:        '#D97706', medBg:   '#FFFBEB',
  low:        '#2563EB', lowBg:   '#EFF6FF',
  dark:       '#111827',
  gray:       '#6B7280',
  border:     '#E5E7EB',
  alt:        '#F9FAFB',
  white:      '#FFFFFF',
  codeBg:     '#1E1535',
  codeText:   '#86EFAC',
};

function sevColor(s) { return s === 'High' ? C.high : s === 'Medium' ? C.med : C.low; }
function sevBg(s)    { return s === 'High' ? C.highBg : s === 'Medium' ? C.medBg : C.lowBg; }
function cap(s)      { return s ? s.charAt(0).toUpperCase() + s.slice(1) : '—'; }

// ── Document setup ────────────────────────────────────────────────────────────
const doc = new PDFDocument({ size: 'A4', margin: M, autoFirstPage: false });
const ws  = fs.createWriteStream(outPath);
doc.pipe(ws);

let pageNum = 0;

// Safe y positions for footer — must stay inside PDFKit's content boundary (PH - M = 791).
// Drawing text at y > PH - M triggers an automatic page break, producing blank pages.
const FOOTER_LINE_Y = PH - M - 22;  // 769  — dividing rule
const FOOTER_TEXT_Y = PH - M - 11;  // 780  — text (8 pt ≈ 10 px line-height → ends at 790 < 791)

function drawPageChrome() {
  // Header strip
  doc.rect(0, 0, PW, 36).fillColor(C.purple).fill();
  doc.fontSize(9).fillColor(C.white).font('Helvetica-Bold')
     .text('SAP Code Review Report', M, 13, { lineBreak: false });
  doc.fontSize(9).fillColor('#C4B5FD').font('Helvetica')
     .text(project, 0, 13, { width: PW - M, align: 'right', lineBreak: false });
  // Footer strip — kept within content area to avoid PDFKit auto-page-break
  doc.moveTo(M, FOOTER_LINE_Y).lineTo(PW - M, FOOTER_LINE_Y)
     .strokeColor(C.border).lineWidth(0.5).stroke();
  doc.fontSize(8).fillColor(C.gray).font('Helvetica')
     .text(`${project} · ${reviewDate} · SAP Code Reviewer`, M, FOOTER_TEXT_Y,
           { width: TW - 50, lineBreak: false });
  doc.text(`Page ${pageNum}`, M, FOOTER_TEXT_Y, { width: TW, align: 'right', lineBreak: false });
}

function newPage(skipChrome = false) {
  pageNum++;
  doc.addPage();
  if (!skipChrome) drawPageChrome();
  return skipChrome ? M : 54;   // y-start after chrome
}

function hRule(y, color = C.border, lw = 0.5) {
  doc.moveTo(M, y).lineTo(M + TW, y).strokeColor(color).lineWidth(lw).stroke();
}

function checkY(y, needed = 80) {
  // Use FOOTER_LINE_Y as the safe content boundary so content never flows into the footer area.
  if (y + needed > FOOTER_LINE_Y - 10) return newPage();
  return y;
}

function sectionTitle(label, y) {
  doc.fontSize(14).fillColor(C.purple).font('Helvetica-Bold').text(label, M, y);
  const next = doc.y + 10;
  hRule(next);
  return next + 14;
}

function subTitle(label, y) {
  doc.fontSize(11).fillColor(C.dark).font('Helvetica-Bold').text(label, M, y);
  return doc.y + 6;
}

// ════════════════════════════════════════════════════════════════════════════════
// 1. COVER PAGE
// ════════════════════════════════════════════════════════════════════════════════
pageNum++;
doc.addPage();   // no chrome on cover

// Purple hero band
doc.rect(0, 0, PW, 210).fillColor(C.purple).fill();
doc.fontSize(26).fillColor(C.white).font('Helvetica-Bold')
   .text('SAP Code Review Report', M, 74, { width: TW });
doc.moveTo(M, 113).lineTo(M + 60, 113).strokeColor('#A78BFA').lineWidth(3).stroke();

// Details table
let y = 236;
const detailRows = [
  ['Service Name',                     'SAP Code Review — Automated Analysis'],
  ['Customer / Project',               project],
  ['Technologies',                     techs],
  ['Accenture Suggested Approach',     suggestedApproach || '— (no Functional Design uploaded)'],
  ['Followed Approach',                followedApproach],
  ['Reviewed At',                      reviewDate],
  ['Total Issues',                     String(findings.length)],
  ['Assessment',                       summary.assessment || '—'],
];
const APPROACH_LABEL_BG = '#EDE9FE';  // light purple
const APPROACH_WARN_BG  = '#FEF3C7';  // soft amber (mismatch value cell)
const APPROACH_WARN_FG  = '#92400E';  // amber text
detailRows.forEach(([k, v], i) => {
  // Measure how tall the value text will be so we can size the row correctly
  const vHeight = doc.heightOfString(v, { width: TW - 190, fontSize: 10 });
  const rowH = Math.max(24, vHeight + 14);
  const isApproachRow = (k === 'Accenture Suggested Approach' || k === 'Followed Approach');
  const bg = isApproachRow ? APPROACH_LABEL_BG : (i % 2 ? C.alt : C.white);
  doc.rect(M, y, TW, rowH).fillColor(bg).fill();

  // On mismatch, repaint only the value cell amber so the two differing
  // values are instantly visible on page 1.
  if (isApproachRow && approachMismatch) {
    doc.rect(M + 175, y, TW - 175, rowH).fillColor(APPROACH_WARN_BG).fill();
  }

  doc.fontSize(10).fillColor(isApproachRow ? C.purple : C.gray).font('Helvetica-Bold')
     .text(k, M + 10, y + 7, { width: 165, lineBreak: false });
  const valueColor = (isApproachRow && approachMismatch) ? APPROACH_WARN_FG : C.dark;
  doc.fontSize(10).fillColor(valueColor).font(isApproachRow ? 'Helvetica-Bold' : 'Helvetica')
     .text(v, M + 180, y + 7, { width: TW - 190 });
  y += rowH;
});

// Mismatch banner — stays on the cover (page 1) when there is room.
if (approachMismatch) {
  y += 8;
  const bannerH = 32;
  doc.rect(M, y, TW, bannerH).fillColor(APPROACH_WARN_BG).fill();
  doc.rect(M, y, 5, bannerH).fillColor('#D97706').fill();
  doc.fontSize(9).fillColor(APPROACH_WARN_FG).font('Helvetica-Bold')
     .text('APPROACH MISMATCH', M + 14, y + 6, { width: TW - 20, lineBreak: false });
  doc.fontSize(9).fillColor(APPROACH_WARN_FG).font('Helvetica')
     .text(
       `Accenture suggested "${suggestedApproach}" but the uploaded code follows "${followedApproach}".`,
       M + 14, y + 18, { width: TW - 20, lineBreak: false });
  y += bannerH;
}

// Severity summary boxes
y += 22;
const bw = (TW - 24) / 3;
[
  { label: 'HIGH',   n: summary.high   || 0, c: C.high, bg: C.highBg },
  { label: 'MEDIUM', n: summary.medium || 0, c: C.med,  bg: C.medBg  },
  { label: 'LOW',    n: summary.low    || 0, c: C.low,  bg: C.lowBg  },
].forEach((b, i) => {
  const bx = M + i * (bw + 12);
  doc.roundedRect(bx, y, bw, 66, 6).fillColor(b.bg).fill();
  doc.roundedRect(bx, y, bw, 66, 6).strokeColor(b.c).lineWidth(1.2).stroke();
  doc.fontSize(32).fillColor(b.c).font('Helvetica-Bold')
     .text(String(b.n), bx, y + 10, { width: bw, align: 'center', lineBreak: false });
  doc.fontSize(9).fillColor(b.c).font('Helvetica-Bold')
     .text(b.label, bx, y + 48, { width: bw, align: 'center', lineBreak: false });
});

// Cover footer — rect and text must stay within PDFKit's content boundary (PH - M = 791)
const COVER_FOOTER_H = 28;
doc.rect(0, FOOTER_LINE_Y - 6, PW, COVER_FOOTER_H).fillColor('#F3F4F6').fill();
doc.fontSize(9).fillColor(C.gray).font('Helvetica')
   .text('Confidential  ·  Generated by SAP Code Reviewer', M, FOOTER_TEXT_Y - 2,
         { width: TW, align: 'center', lineBreak: false });

// ════════════════════════════════════════════════════════════════════════════════
// 2. DISCLAIMER
// ════════════════════════════════════════════════════════════════════════════════
y = newPage();
y = sectionTitle('1  Disclaimer', y);
doc.fontSize(10).fillColor(C.dark).font('Helvetica')
   .text(
     'Note: All recommendations in this report are based on automated static analysis of the ' +
     'uploaded source code. We advise you to test recommendations before applying them to a ' +
     'production system.',
     M, y, { width: TW });
y = doc.y + 12;
doc.text(
  'We use "issue" in the following sections to refer to both existing and potential issues/risks ' +
  'identified during analysis.',
  M, y, { width: TW });
y = doc.y + 8;   // advance y past the second paragraph before the next section

// ════════════════════════════════════════════════════════════════════════════════
// 3. SUMMARY
// ════════════════════════════════════════════════════════════════════════════════
y = checkY(y + 10, 180);
y = sectionTitle('2  Summary', y);

y = subTitle('Scope of the Review', y);
doc.fontSize(10).fillColor(C.dark).font('Helvetica')
   .text(
     `The automated code review was performed on the project "${project}" . ` +
     `Technologies covered: ${techs}.\n` +
     `Focus areas: Data Model & Schema Design, Service Layer, Business Logic, Security & Authorization.`,
     M, y, { width: TW });
y = doc.y + 16;

y = subTitle('Results', y);
doc.fontSize(10).fillColor(C.dark).font('Helvetica')
   .text(
     `In total ${findings.length} issue${findings.length !== 1 ? 's' : ''} ` +
     `(${summary.high || 0} High, ${summary.medium || 0} Medium and ${summary.low || 0} Low) ` +
     `were found.${summary.assessment ? '  Assessment: ' + summary.assessment : ''}`,
     M, y, { width: TW });
y = doc.y + 18;

// ── Snapshot table ─────────────────────────────────────────────────────────────
y = subTitle('Snapshot of Issues', y);

const TC = { no: M, pri: M + 28, cat: M + 110, iss: M + 200 };
const TCW = { no: 28, pri: 78, cat: 88, iss: M + TW - 200 };

function drawSnapshotHeader(y) {
  doc.rect(M, y, TW, 20).fillColor(C.purple).fill();
  doc.fontSize(9).fillColor(C.white).font('Helvetica-Bold');
  doc.text('No.',      TC.no  + 3, y + 6, { width: TCW.no,  lineBreak: false });
  doc.text('Priority', TC.pri + 3, y + 6, { width: TCW.pri, lineBreak: false });
  doc.text('Category', TC.cat + 3, y + 6, { width: TCW.cat, lineBreak: false });
  doc.text('Issue',    TC.iss + 3, y + 6, { width: TCW.iss, lineBreak: false });
  return y + 20;
}

y = drawSnapshotHeader(y);

const CLIENT_BG = '#DCFCE7';   // light green row background for client-sourced findings
const CLIENT_BAR = '#16A34A';  // badge / banner color for client-sourced findings
const isClientSrc = (f) => (f && typeof f.source === 'string' && f.source.toLowerCase() === 'client');

findings.forEach((f, idx) => {
  if (y + 18 > PH - 50) { y = newPage(); y = drawSnapshotHeader(y); }
  const rowBg = isClientSrc(f) ? CLIENT_BG : (idx % 2 ? C.alt : C.white);
  doc.rect(M, y, TW, 18).fillColor(rowBg).fill();
  doc.moveTo(M, y + 18).lineTo(M + TW, y + 18).strokeColor(C.border).lineWidth(0.3).stroke();
  doc.fontSize(9).fillColor(C.dark).font('Helvetica')
     .text(String(f.id || idx + 1), TC.no + 3, y + 5, { width: TCW.no, lineBreak: false });
  doc.fillColor(sevColor(f.severity)).font('Helvetica-Bold')
     .text(f.severity || '—', TC.pri + 3, y + 5, { width: TCW.pri, lineBreak: false });
  doc.fillColor(C.gray).font('Helvetica')
     .text(cap(f.category), TC.cat + 3, y + 5, { width: TCW.cat, lineBreak: false });
  doc.fillColor(C.dark)
     .text((f.title || '—').substring(0, 58), TC.iss + 3, y + 5, { width: TCW.iss, lineBreak: false });
  y += 18;
});

// ════════════════════════════════════════════════════════════════════════════════
// 4. DETAILED ISSUES grouped by technology
// ════════════════════════════════════════════════════════════════════════════════
y = checkY(y + 10, 180);
y = sectionTitle('3  Issues & Actions', y);

const groups = {};
findings.forEach(f => {
  const t = f.technology || 'General';
  if (!groups[t]) groups[t] = [];
  groups[t].push(f);
});

let secIdx = 1;
for (const [tech, items] of Object.entries(groups)) {
  y = checkY(y, 60);
  doc.fontSize(12).fillColor(C.purple).font('Helvetica-Bold')
     .text(`3.${secIdx}  ${tech}`, M, y);
  y = doc.y + 6;
  hRule(y, C.purplePale, 0.8);
  y += 12;

  items.forEach((f, fi) => {
    y = checkY(y, 90);

    // ── Finding title bar ───────────────────────────────────────────────────
    const titleBg = isClientSrc(f) ? CLIENT_BG : C.purplePale;
    const titleFg = isClientSrc(f) ? CLIENT_BAR : C.purple;
    doc.rect(M, y, TW, 22).fillColor(titleBg).fill();
    const issLabel = `3.${secIdx}.${fi + 1}  Issue: ${f.title || 'Untitled'}`;
    doc.fontSize(10).fillColor(titleFg).font('Helvetica-Bold')
       .text(issLabel, M + 8, y + 7, { width: TW - 16, lineBreak: false });
    y += 22 + 7;

    // ── Client rule badge ───────────────────────────────────────────────────
    if (isClientSrc(f)) {
      y = checkY(y, 20);
      doc.rect(M, y, TW, 16).fillColor(CLIENT_BAR).fill();
      doc.fontSize(9).fillColor(C.white).font('Helvetica-Bold')
         .text('CLIENT RULE — overrides baseline check for this item', M + 8, y + 4, { width: TW - 16, lineBreak: false });
      y += 16 + 4;
    }

    // ── Priority + file ─────────────────────────────────────────────────────
    doc.fontSize(9).fillColor(C.gray).font('Helvetica-Bold')
       .text('Priority: ', M, y, { continued: true });
    doc.fillColor(sevColor(f.severity)).font('Helvetica-Bold')
       .text(f.severity || '—');
    y = doc.y + 3;

    if (f.file) {
      doc.fontSize(9).fillColor(C.gray).font('Helvetica')
         .text(`File: ${f.file}${f.line ? ' : ' + f.line : ''}`, M, y, { width: TW });
      y = doc.y + 6;
    }

    // ── Severity rationale (why this severity was chosen) ───────────────────
    if (f.severityRationale) {
      y = checkY(y, 32);
      doc.fontSize(9).fillColor(C.dark).font('Helvetica-Bold').text('Severity Rationale:', M, y);
      y = doc.y + 3;
      doc.fontSize(9).fillColor(C.gray).font('Helvetica-Oblique')
         .text(f.severityRationale, M + 12, y, { width: TW - 12 });
      y = doc.y + 8;
    }

    // ── Issue description ───────────────────────────────────────────────────
    if (f.issue) {
      y = checkY(y, 40);
      doc.fontSize(9).fillColor(C.dark).font('Helvetica-Bold').text('Issue:', M, y);
      y = doc.y + 3;
      doc.fontSize(10).fillColor(C.dark).font('Helvetica')
         .text(f.issue, M + 12, y, { width: TW - 12 });
      y = doc.y + 8;
    }

    // ── Business impact ─────────────────────────────────────────────────────
    // (The issue text covers this; only emit a separate block if verdict is PLAUSIBLE)
    if (f.verdict === 'PLAUSIBLE') {
      y = checkY(y, 20);
      doc.fontSize(9).fillColor(C.med).font('Helvetica-Bold')
         .text('Note: This finding is PLAUSIBLE — verify against runtime configuration.', M, y, { width: TW });
      y = doc.y + 6;
    }

    // ── Transport blocker banner ───────────────────────────────────────────
    if (f.blocksTransport === true) {
      y = checkY(y, 20);
      doc.rect(M, y, TW, 16).fillColor(C.high).fill();
      doc.fontSize(9).fillColor(C.white).font('Helvetica-Bold')
         .text('TRANSPORT BLOCKER — must be fixed before transport to QA', M + 8, y + 4, { width: TW - 16, lineBreak: false });
      y += 16 + 4;
    }

    // ── Action / recommendation ─────────────────────────────────────────────
    if (f.recommendation) {
      y = checkY(y, 44);
      doc.rect(M, y, TW, 16).fillColor(C.purple).fill();
      doc.fontSize(9).fillColor(C.white).font('Helvetica-Bold')
         .text('Action', M + 8, y + 4, { width: TW - 16, lineBreak: false });
      y += 16 + 4;
      doc.fontSize(10).fillColor(C.dark).font('Helvetica')
         .text(f.recommendation, M + 12, y, { width: TW - 12 });
      y = doc.y + 8;
    }

    // ── Code snippet ────────────────────────────────────────────────────────
    if (f.codeSnippet) {
      const lines = f.codeSnippet.split('\n').slice(0, 12);
      const snH   = lines.length * 11 + 16;
      y = checkY(y, snH + 10);
      doc.rect(M, y, TW, snH).fillColor(C.codeBg).fill();
      doc.fontSize(8).fillColor(C.codeText).font('Courier')
         .text(lines.join('\n'), M + 8, y + 8, { width: TW - 16, lineBreak: true });
      y = Math.max(doc.y + 6, y + snH + 4);
    }

    // ── Reference link ──────────────────────────────────────────────────────
    if (f.referenceLink) {
      y = checkY(y, 18);
      doc.fontSize(8).fillColor(C.gray).font('Helvetica')
         .text(`Reference: ${f.referenceLink}`, M, y, { width: TW });
      y = doc.y + 4;
    }

    y += 16;  // gap between findings
  });

  secIdx++;
  y += 4;
}

// ════════════════════════════════════════════════════════════════════════════════
// Finalise
// ════════════════════════════════════════════════════════════════════════════════
doc.end();
ws.on('finish', () => {
  console.log(`PDF report written: reports/${rawProject}-review.pdf  (${findings.length} findings, project label="${project}")`);
});
ws.on('error', err => {
  console.error('PDF write error:', err.message);
  process.exit(1);
});
