# SAP Code Reviewer

Automated, best-practice code review for SAP applications using Claude Code.

**Covers:** SAPUI5 / Fiori · CAP (CAPM) · RAP · ABAP Cloud

---

## Prerequisites

1. **Node.js 20+** and npm — [nodejs.org](https://nodejs.org)
2. **Claude Code CLI** — `npm install -g @anthropic-ai/claude-code`
3. A modern browser (Chrome / Edge / Firefox) for `editer.html`

Verify:
```cmd
node --version
claude --version
```

---

## First-time setup

```cmd
cd "SAP-Code-Reviewer"
npm install
```

That installs `xlsx` (used for Excel export) and `jszip` (for zip extraction).

---

## How to run — 4 simple steps

### Step 1 — Launch the workspace
Double-click **`start.cmd`** (Windows) — it does two things:
- Opens `editer.html` in your default browser (the upload UI)
- Starts Claude Code CLI inside the project

Or run manually:
```cmd
start editer.html
claude
```

### Step 2 — Upload your project via the browser UI
- Enter a **project name** (e.g. `my-sap-app`) — spaces are turned into `-`.
- Drop a folder, ZIP, or individual files into the upload zone.
- Click **"Save to uploads/"** to write the files to `uploads/<project-name>/`.

### Step 3 — Ask the agent to review
Inside the Claude Code session, type:

```
/sap-code-reviewer my-sap-app
```

The agent will:
1. Scan `uploads/my-sap-app/`
2. Detect which SAP technologies are present (UI5 / CAP / RAP / ABAP Cloud)
3. Apply the matching best-practice rulesets
4. Write findings to `reports/my-sap-app-findings.json`
5. Print a short summary

If you already know the tech and want a deeper focused review:
```
/sap-ui5-reviewer my-sap-app
/sap-capm-reviewer my-sap-app
/sap-rap-reviewer my-sap-app
/sap-abap-cloud-reviewer my-sap-app
```

### Step 4 — Generate the Excel report

```cmd
node scripts/export-excel.js my-sap-app
```

Output: `reports/my-sap-app-review.xlsx` with sheets:
- **Summary** — counts by severity, assessment
- **All Findings** — every finding, sortable by severity
- **High / Medium / Low** — severity-scoped
- **SAPUI5 / CAP / RAP / ABAP Cloud** — one sheet per detected technology

*(The exact Excel layout will be adjusted when you provide your sample template.)*

---

## Findings JSON schema

See [samples/example-findings.json](samples/example-findings.json). Every finding carries:

| Field | Description |
|-------|-------------|
| `severity` | `High` / `Medium` / `Low` |
| `layer` | `db` / `srv` / `app` / `security` / `config` |
| `technology` | `SAPUI5` / `CAP` / `RAP` / `ABAP Cloud` |
| `file` | Repo-relative path |
| `line` | 1-indexed line number |
| `category` | `correctness` / `security` / `performance` / `clean-core` / `testability` |
| `title` | Short label |
| `issue` | Concrete defect + impact |
| `recommendation` | The fix (may include code snippet) |
| `codeSnippet` | Offending code excerpt (optional) |

---

## Standards enforced

Reviews follow the official SAP best-practice sources listed in [docs/sap-standards.md](docs/sap-standards.md):
- **SAPUI5 Best Practices** (developer guide)
- **CAP Cookbook + Best Practices** (cap.cloud.sap)
- **RAP Development Guide** (Business Technology Platform)
- **ABAP Cloud Development Model** (Clean Core rules)
- **S/4HANA Cloud Extensibility Constraints**

---

## Troubleshooting

**"claude: command not found"**
`npm install -g @anthropic-ai/claude-code` then reopen the terminal.

**"Cannot find module xlsx"**
Run `npm install` inside the project folder.

**Excel export fails / findings JSON missing**
Run the review agent first — it produces the JSON that the Excel script reads.

**Trust dialog blocks file access**
On first launch, accept the trust dialog when Claude Code prompts for the project folder.

---

## Project layout

```
SAP-Code-Reviewer/
├── CLAUDE.md                 # Claude Code project instructions
├── README.md                 # This file
├── editer.html               # Upload UI
├── start.cmd                 # One-click launcher
├── package.json              # Node deps
├── uploads/                  # Where uploaded projects land
├── reports/                  # Generated findings JSON + Excel
├── samples/                  # Example findings shape
├── docs/                     # Detection rules + standards refs
├── scripts/
│   └── export-excel.js       # JSON → xlsx
└── .claude/agents/           # The review agents
```
