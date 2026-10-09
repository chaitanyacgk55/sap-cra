# File type & SAP technology detection

The main `/sap-code-reviewer` agent classifies each uploaded file by these signals. A single project may contain multiple technologies (e.g. a CAP `srv/` + a UI5 `app/`) — every match is added to `technologies[]`.

## Detection signals

### SAPUI5 / Fiori
| Signal | Where |
|--------|-------|
| `"sap.ui5"` object | `manifest.json` |
| `sap.ui.define([...])` | `*.controller.js`, `Component.js` |
| `xmlns="sap.m"` / `xmlns:mvc="sap.ui.core.mvc"` | `*.view.xml` |
| `webapp/` folder | project root |
| `sap-ui-core.js` script reference | `index.html` |
| `sap-icon://...` URIs | any file |
| `i18n.properties` | `webapp/i18n/` |

### CAP (Cloud Application Programming Model)
| Signal | Where |
|--------|-------|
| `.cds` files | any location |
| `@sap/cds` dependency | `package.json` |
| `srv/` + `db/` folders | project root |
| `cds.ApplicationService` | `*.ts` / `*.js` |
| `cds.env` / `cds.log(...)` | any TS/JS file |
| `.cdsrc.json` | project root |
| `xs-security.json` with `scopes` | project root |

### RAP (RESTful ABAP Programming Model)
| Signal | Where |
|--------|-------|
| `define behavior for` | `*.bdef.abap` / `*.abap` |
| `strict(2)` | behavior definition |
| `class ... behavior handler` | `*.clas.abap` |
| `MODIFY ENTITIES OF` | behavior implementation |
| `define service` | `*.srvd.abap` |
| `define service binding` | `*.srvb.abap` |
| `draft table` | behavior definition |
| `%tky` / `%pky` variables | behavior implementation |

### ABAP Cloud
| Signal | Where |
|--------|-------|
| `@AbapCatalog.viewSemantics` | CDS view |
| `@AccessControl.authorizationCheck` | CDS view |
| `define view entity` | `*.ddls.abap` |
| Access Control DCL: `@MappingRole: true` | `*.acds.abap` |
| Package hierarchy `Z*` / `Y*` / `/NS/` | source header |
| `INHERITING FROM cx_static_check` | class definition |
| `RISK LEVEL HARMLESS DURATION SHORT` | test class |
| ABAP Doc `"!` comments | class definition |

## Overlap rules

- **RAP ⊂ ABAP Cloud**: RAP artifacts are also ABAP Cloud. When both patterns match, list **both** in `technologies[]` but run the RAP-specific checks first (they're more specific).
- **CAP + UI5**: A monorepo with `srv/` + `app/` is common. Run each ruleset against its own subtree only.
- **Node CAP vs Java CAP**: Detect via `package.json` (`@sap/cds`) vs `pom.xml` (`com.sap.cds`). Currently the reviewer's CAP rules cover Node/TypeScript CAP; Java CAP checks are a future addition.

## What is NOT detected

- Classic ABAP (on-premise, not Cloud): flagged as `ABAP (legacy)` and only Clean-Core migration hints are provided.
- SAPUI5 built with UI5 Tooling for CAP frontend module: still detected as `SAPUI5`.
- Fiori Elements apps (annotation-driven): detected as `SAPUI5` + `Fiori Elements` subtype note.
- Node.js apps that aren't CAP: not classified as any SAP tech; agent will say so.
