#!/usr/bin/env node
/**
 * Convert reports/<project>-findings.json → reports/<project>-review.xlsx
 *
 * Usage:  node scripts/export-excel.js <project-name>
 *
 * Sheets produced:
 *   - Summary       : counts + assessment + project metadata
 *   - All Findings  : every finding
 *   - High / Medium / Low : filtered by severity
 *   - <Technology>  : one sheet per detected technology (SAPUI5, CAP, RAP, ABAP Cloud)
 *
 * Adjust column headers / widths in COLUMNS below to match the user's sample Excel.
 */

const fs = require('fs');
const path = require('path');
const ExcelJS = require('exceljs');
const { initFor, maskData } = require('./mask');

const rawProject = process.argv[2];
if (!rawProject) {
  console.error('Usage: node scripts/export-excel.js <project-name> [--client "Alias,..."]');
  process.exit(1);
}

const jsonPath = path.join('reports', `${rawProject}-findings.json`);
if (!fs.existsSync(jsonPath)) {
  console.error(`No findings file found at ${jsonPath}`);
  console.error(`Run the review agent first:  /sap-code-reviewer ${rawProject}`);
  process.exit(1);
}

// Load + apply masking (client name, emails, IPs, tokens).
const raw = JSON.parse(fs.readFileSync(jsonPath, 'utf8'));
const { mask, maskedProject } = initFor(rawProject);
const data = maskData(raw, mask);
const project = maskedProject;         // masked label used in cells
const findings = data.findings || [];

// Adjust these to match the sample Excel your team uses.
const COLUMNS = [
  { key: 'id',             header: '#',                width: 5 },
  { key: 'severity',       header: 'Severity',         width: 10 },
  { key: 'severityRationale', header: 'Severity Rationale', width: 46 },
  { key: 'blocksTransport',header: 'Blocks Transport', width: 8 },
  { key: 'source',         header: 'Source',           width: 10 },
  { key: 'clientNote',     header: 'Client Instruction', width: 50 },
  { key: 'technology',     header: 'Technology',       width: 14 },
  { key: 'layer',          header: 'Layer',            width: 10 },
  { key: 'category',       header: 'Category',         width: 14 },
  { key: 'file',           header: 'File',             width: 36 },
  { key: 'line',           header: 'Line',             width: 6 },
  { key: 'title',          header: 'Title',            width: 34 },
  { key: 'issue',          header: 'Issue',            width: 60 },
  { key: 'recommendation', header: 'Recommendation',   width: 60 },
  { key: 'codeSnippet',    header: 'Code Snippet',     width: 40 },
  { key: 'referenceLink',  header: 'Reference',        width: 40 },
];

// Rows whose finding originated from a client suggestion get this fill so
// reviewers can tell at a glance which rules came from the client vs. the
// baseline SAP ruleset.
const CLIENT_ROW_FILL   = 'FFBBF7D0'; // light green
const CLIENT_SOURCE_PILL = 'FF16A34A'; // darker green badge

// Approach ids match the Accenture Claude artifact exactly. Reports show
// the full name — the raw id ("inapp_btp" etc.) is unreadable for a human.
const APPROACH_FULL_NAME = {
  customisation:  'Customisation (Standard Configuration)',
  keyuser:        'Key User Extensibility',
  developer:      'Developer Extensibility (ABAP Cloud / RAP)',
  sidebyside:     'Side-by-Side Extensibility (SAP BTP)',
  inapp_btp:      'Developer + BTP Mixed',
  keyuser_inapp:  'Key User + Developer Mixed',
  unknown:        'Unknown',
};
function approachLabel(code) {
  if (!code) return '';
  const key = String(code).toLowerCase().replace(/[^a-z_]/g, '');
  return APPROACH_FULL_NAME[key] || code;
}

const SEVERITY_COLORS = {
  High:   'FFFB7185',
  Medium: 'FFFBBF24',
  Low:    'FF60A5FA',
};

function addFindingsSheet(workbook, name, list) {
  const safeName = String(name).replace(/[\\/*?:[\]]/g, '').slice(0, 31);
  const sheet = workbook.addWorksheet(safeName, { views: [{ state: 'frozen', ySplit: 1 }] });

  sheet.columns = COLUMNS.map(c => ({ header: c.header, key: c.key, width: c.width }));

  // Header style
  sheet.getRow(1).eachCell(cell => {
    cell.font = { bold: true, color: { argb: 'FFFFFFFF' } };
    cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF6D28D9' } };
    cell.alignment = { vertical: 'middle', horizontal: 'left', wrapText: true };
  });

  list.forEach(f => {
    const isClient = (f.source || '').toLowerCase() === 'client';
    const row = sheet.addRow({
      id:              f.id ?? '',
      severity:        f.severity ?? '',
      severityRationale: f.severityRationale ?? '',
      blocksTransport: f.blocksTransport === true ? 'YES' : '',
      source:          isClient ? 'Client' : 'Baseline',
      clientNote:      isClient ? (f.clientNote ?? '') : '',
      technology:      f.technology ?? '',
      layer:           f.layer ?? '',
      category:        f.category ?? '',
      file:            f.file ?? '',
      line:            f.line ?? '',
      title:           f.title ?? '',
      issue:           f.issue ?? '',
      recommendation:  f.recommendation ?? '',
      codeSnippet:     f.codeSnippet ?? '',
      referenceLink:   f.referenceLink ?? '',
    });
    row.alignment = { vertical: 'top', wrapText: true };
    const sevColor = SEVERITY_COLORS[f.severity];
    if (sevColor) {
      row.getCell('severity').fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: sevColor } };
      row.getCell('severity').font = { bold: true, color: { argb: 'FF1F2937' } };
    }
    if (f.blocksTransport === true) {
      row.getCell('blocksTransport').fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFFB7185' } };
      row.getCell('blocksTransport').font = { bold: true, color: { argb: 'FFFFFFFF' } };
      row.getCell('blocksTransport').alignment = { vertical: 'middle', horizontal: 'center' };
    }
    if (isClient) {
      // Highlight the entire row so client-sourced rules are instantly
      // visually distinct from baseline findings.
      row.eachCell({ includeEmpty: false }, cell => {
        if (cell.fill && cell.fill.fgColor) return; // keep severity/blocker pills
        cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: CLIENT_ROW_FILL } };
      });
      row.getCell('source').fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: CLIENT_SOURCE_PILL } };
      row.getCell('source').font = { bold: true, color: { argb: 'FFFFFFFF' } };
      row.getCell('source').alignment = { vertical: 'middle', horizontal: 'center' };
    }
  });

  sheet.autoFilter = { from: 'A1', to: { row: 1, column: COLUMNS.length } };
  return sheet;
}

async function main() {
  const workbook = new ExcelJS.Workbook();
  workbook.creator = 'SAP-Code-Reviewer';
  workbook.created = new Date();

  // Summary sheet
  const summary = workbook.addWorksheet('Summary');
  summary.columns = [{ width: 24 }, { width: 62 }];
  const high   = findings.filter(f => f.severity === 'High').length;
  const medium = findings.filter(f => f.severity === 'Medium').length;
  const low    = findings.filter(f => f.severity === 'Low').length;
  const assessment = high ? 'Blockers present' : findings.length ? 'Review minor fixes before merge' : 'Ready for merge';

  const clientCount = findings.filter(f => (f.source || '').toLowerCase() === 'client').length;
  const baselineCount = findings.length - clientCount;

  // Derive the "Followed approach" from the detected technologies, using
  // the artifact's six-id vocabulary.
  const techsLower = (data.technologies ?? []).map(t => String(t).toLowerCase());
  const hasUI5  = techsLower.some(t => t.includes('ui5') || t.includes('fiori'));
  const hasCAP  = techsLower.some(t => t === 'cap' || t.includes('capm'));
  const hasRAP  = techsLower.includes('rap');
  const hasABAP = techsLower.some(t => t.includes('abap'));
  function deriveFollowed() {
    const dev = hasRAP || hasABAP;
    const sxs = hasCAP || (hasUI5 && !dev); // UI5 alone → BTP side-by-side
    if (dev && sxs) return 'inapp_btp';
    if (dev)       return 'developer';
    if (sxs)       return 'sidebyside';
    return 'unknown';
  }
  const followedApproach  = (data.followedApproach  && String(data.followedApproach).toLowerCase())  || deriveFollowed();
  const suggestedApproach = (data.suggestedApproach && String(data.suggestedApproach).toLowerCase()) || '';
  const approachMismatch  = suggestedApproach && followedApproach !== 'unknown'
                            && suggestedApproach !== followedApproach;

  const rows = [
    ['SAP Code Review', ''],
    ['Project',       data.project     ?? project],
    ['Reviewed at',   data.reviewedAt  ?? new Date().toISOString()],
    ['Technologies',  (data.technologies ?? []).join(', ')],
    [],
    ['Accenture Suggested Approach', suggestedApproach ? approachLabel(suggestedApproach) : '— (no Functional Design uploaded)'],
    ['Followed Approach',            approachLabel(followedApproach)],
    [],
    ['Severity',      'Count'],
    ['High',          high],
    ['Medium',        medium],
    ['Low',           low],
    ['Total',         findings.length],
    [],
    ['Source',        'Count'],
    ['Baseline',      baselineCount],
    ['Client',        clientCount],
    [],
    ['Assessment',    assessment],
  ];
  rows.forEach(r => summary.addRow(r));

  summary.getRow(1).font = { bold: true, size: 14, color: { argb: 'FF6D28D9' } };

  // Approach rows (6 = Suggested, 7 = Followed). Highlight amber if they
  // differ so the mismatch is unmissable on page 1.
  const APPROACH_LABEL_FILL = 'FFEDE9FE';   // light purple
  const APPROACH_MISMATCH   = 'FFFBBF24';   // amber
  summary.getRow(6).getCell(1).font = { bold: true, color: { argb: 'FF6D28D9' } };
  summary.getRow(7).getCell(1).font = { bold: true, color: { argb: 'FF6D28D9' } };
  summary.getRow(6).getCell(1).fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: APPROACH_LABEL_FILL } };
  summary.getRow(7).getCell(1).fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: APPROACH_LABEL_FILL } };
  if (approachMismatch) {
    [6, 7].forEach(rn => {
      summary.getRow(rn).getCell(2).fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: APPROACH_MISMATCH } };
      summary.getRow(rn).getCell(2).font = { bold: true, color: { argb: 'FF1F2937' } };
    });
    summary.addRow([]);
    const warnRow = summary.addRow([
      'APPROACH MISMATCH',
      `Accenture suggested "${approachLabel(suggestedApproach)}" but the uploaded code follows "${approachLabel(followedApproach)}".`,
    ]);
    warnRow.getCell(1).fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: APPROACH_MISMATCH } };
    warnRow.getCell(1).font = { bold: true, color: { argb: 'FF1F2937' } };
    warnRow.getCell(2).font = { italic: true, color: { argb: 'FF92400E' } };
  }

  summary.getRow(9).font = { bold: true };     // "Severity" header
  ['High', 'Medium', 'Low'].forEach((sev, i) => {
    const rowNum = 10 + i;
    summary.getRow(rowNum).getCell(1).fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: SEVERITY_COLORS[sev] } };
    summary.getRow(rowNum).getCell(1).font = { bold: true, color: { argb: 'FF1F2937' } };
  });
  summary.getRow(15).font = { bold: true };    // "Source" header
  summary.getRow(19).font = { bold: true };    // "Assessment" label

  // Findings sheets
  addFindingsSheet(workbook, 'All Findings', findings);
  for (const sev of ['High', 'Medium', 'Low']) {
    addFindingsSheet(workbook, sev, findings.filter(f => f.severity === sev));
  }
  const techs = [...new Set(findings.map(f => f.technology).filter(Boolean))];
  for (const tech of techs) {
    addFindingsSheet(workbook, tech, findings.filter(f => f.technology === tech));
  }

  const outPath = path.join('reports', `${rawProject}-review.xlsx`);
  fs.mkdirSync('reports', { recursive: true });
  await workbook.xlsx.writeFile(outPath);

  console.log(`\n✓ Excel report written: ${outPath}`);
  console.log(`  ${findings.length} findings across ${techs.length} technolog${techs.length === 1 ? 'y' : 'ies'}`);
  console.log(`  High: ${high}  Medium: ${medium}  Low: ${low}`);
  console.log(`  Assessment: ${assessment}\n`);
}

main().catch(err => {
  console.error('Excel export failed:', err.message);
  process.exit(1);
});
