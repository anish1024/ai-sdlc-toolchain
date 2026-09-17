# Graph Editor

A single-page, no-build-step tool for authoring, browsing, and editing
`graph.yaml` files — the DAG-of-contracts format used to drive
graph-guided code generation. Open it in a browser, load a
`graph.yaml`, click around a D3 tree diagram of your architecture, and
optionally flip on Edit mode to add nodes, wire dependencies, and
export a new `graph.yaml`.

This README documents the **current** code structure (post-refactor,
August 2026). If you're looking for the wider toolchain this editor
is part of (`graph_runner.py`, `validate_graph.py`, `generate_project.py`,
etc.), see that project's own top-level README — this one only covers
the browser-based editor.

> **Read this first if you're on the September 2026 pivot.** The
> schema moved to "Revision 3" (protocol names renamed, `signature`
> retired for structured `params`/`returns`) shortly after the pass
> this README otherwise documents, and was extended further in
> September 2026 (new node fields, a prompt-generation workflow, a
> native Save dialog). **§11 at the end of this file is the accurate,
> current reference for all of that.** Sections 1–10 below were
> written for the August 2026 MVC refactor and, in places (§6–§9's
> protocol names and field lists), still describe the schema as it
> stood *before* Revision 3 — that staleness predates this pass and
> wasn't introduced by it, but hasn't been fully corrected here yet
> either. Where the two disagree, trust §11, the code comments in
> `graph-model.js`, and `validate_graph.py`'s own docstring (which is
> current) over the older sections.

---

## 1. What changed in this pass

Two things were asked for and done here:

1. **`graph_viewer.html` is removed.** `graph_editor.html` already had
   an "Edit mode" checkbox that, unchecked, gave a fully read-only
   view: same tree diagram, same click-to-inspect detail panel, same
   tooltip, plus collapse/expand and edge-highlighting that the old
   viewer never had. The two files had drifted into ~90% duplicated
   HTML/CSS/JS with the editor being a strict superset. There was
   nothing in the viewer worth keeping separately, so it's gone.
   **Un-checking "Edit mode" in the editor *is* the viewer now.**

2. **The code is reorganized into an explicit MVC split** (previously
   everything but the two logic files lived in one 1,100-line
   `<script>` block). See §3.

If you have bookmarks, embeds, or scripts pointing at the old
`graph_viewer.html`, repoint them at `graph_editor.html` — it opens in
view-only mode by default (Edit mode starts unchecked), so nothing
about the default experience changes for a read-only consumer.

---

## 2. Setup / run

No build step, no package manager, no compilation. This is intentionally
plain `<script src="...">` tags — open it and it works.

### Quickest path

```bash
cd graph-editor/
python3 -m http.server 8000
# then open http://localhost:8000/graph_editor.html
```

A local server is recommended (not strictly required — see below) so
relative `<script src="...">` loads behave identically to how they'll
behave if you ever host this somewhere. Any static server works:
`npx serve`, `php -S localhost:8000`, VS Code's Live Server extension,
etc.

### Double-click / `file://` also works

Every script here is a plain (non-module) `<script src>`, and the
default sample graph is embedded as base64 in `default-graph.js`
rather than fetched at runtime — so there's no CORS restriction
blocking `file://` access. You can just double-click `graph_editor.html`
and it will boot with the bundled sample graph. You'll only need the
local server if you're also serving other files that themselves fetch
things (not the case for this tool as shipped).

### Loading your own graph

Click **"Load a different graph.yaml…"** in the header and pick any
`.yaml`/`.yml` file from disk. Nothing is uploaded anywhere — it's
read client-side via `FileReader` and never leaves the browser.

### Requirements

- Any modern browser (uses `d3@7`, `js-yaml@4`, both loaded from
  `cdnjs.cloudflare.com` — an internet connection is needed the first
  time to fetch those two `<script>` tags, or vendor them locally if
  you need a fully offline copy).
- No Node/npm needed to *run* the app. Node is only used for the
  optional test workflow in §5.

### Configuring colors (optional)

`status-colors.json` and `protocol-registry.json` sit next to
`graph_editor.html` and are loaded via `fetch()` at boot — edit either
one and reload to change status border colors or protocol fill
colors/definitions, with **no code change**. This only works when
served over http(s) (`fetch()` of a sibling file is blocked under
`file://`); if it fails for any reason, the app falls back to the same
values baked into `graph-model.js` and logs why to the console — it
never breaks the app. See §3.4 and §9 for details.

---

## 3. Code structure (MVC)

```
graph-editor/
├── graph_editor.html          Shell: CSS + DOM skeleton + <script> tags. No logic.
├── graph-model.js             MODEL  — pure data & business rules
├── graph-view.js              VIEW   — all DOM/D3 rendering
├── graph-controller.js        CONTROLLER — state + event wiring (glues Model to View)
├── graph-config.js            DATA   — fetches the two JSON config files below and applies them
├── validate-graph.js          VALIDATION — JS port of validate_graph.py, run in-browser on Save (§11)
├── prompt-generator.js        PROMPTGEN  — composes per-node prompts + prompts.json (§11)
├── default-graph.js           DATA   — the sample graph the editor boots with
├── status-colors.json         CONFIG — status -> hex color (and status ENUM order)
├── protocol-registry.json     CONFIG — full protocol definitions, incl. hex fill colors
├── scripts/
│   └── embed-default-graph.py Regenerates default-graph.js from a plain .yaml file
├── examples/
│   └── kharcha_graph_storage.yaml   The real graph currently embedded as the default
└── README.md                  You are here
```

`graph_editor.html` loads them in this order, and the order matters:

```html
<script src="https://cdnjs.cloudflare.com/.../d3.min.js"></script>
<script src="https://cdnjs.cloudflare.com/.../js-yaml.min.js"></script>

<script src="default-graph.js"></script>     <!-- defines window.GraphDefault -->
<script src="graph-model.js"></script>       <!-- defines window.GraphModel, reads nothing above -->
<script src="graph-view.js"></script>        <!-- defines window.GraphView, reads GraphModel -->
<script src="graph-config.js"></script>      <!-- defines window.GraphConfig, reads GraphModel -->
<script src="validate-graph.js"></script>    <!-- defines window.GraphValidate, reads GraphModel -->
<script src="prompt-generator.js"></script>  <!-- defines window.GraphPromptGen, reads GraphModel + GraphView -->
<script src="graph-controller.js"></script>  <!-- reads GraphDefault + GraphModel + GraphView + GraphConfig + GraphValidate + GraphPromptGen, boots the app -->
```

Each file is attached to `window` under its own namespace
(`GraphModel`, `GraphView`, `GraphDefault`) rather than dumping
individual functions into the global scope — so `graph-view.js` calls
`GraphModel.buildTree(...)`, never a bare `buildTree(...)`. This makes
every cross-file dependency visible at the call site instead of
implicit.

### 3.1 Model (`graph-model.js`) — "what is a valid graph"

Pure functions and plain-data constants only. **No `document`, no
`window` reads, no D3.** This is exactly the former `graph-logic.js` +
`graph-edit-logic.js`, merged into one file and namespaced — their
internals are unchanged, because they were already pure and already
the right shape for a Model layer.

Read side (parsed YAML → renderable shape):
| Function | Purpose |
|---|---|
| `normalizeGraph(raw)` | Parsed YAML object → `{project, backbone, defaultBoundary, nodesById}` |
| `buildTree(normalized)` | `nodesById` + `parent` pointers → a `d3.hierarchy`-ready tree, rooted at `backbone` |
| `computeCrossEdges(normalized)` | Every `dependencies` edge that isn't a parent→child tree edge (the dashed lines) |
| `computeMapsToEdges(normalized)` | Every `maps_to` edge (the dotted lines) — see §6 |
| `childrenOf(id, nodesById)` | Direct children of a node by `parent` field |

Write side (mutations used by the edit-mode UI):
| Function | Purpose |
|---|---|
| `addNode` / `deleteNode` | Insert/remove a node, with referential-integrity checks (can't delete a node with children, dependents, or `maps_to` mappers) |
| `addDependency` / `removeDependency` | Manage a node's `dependencies` list |
| `addMapsTo` / `removeMapsTo` | Manage a node's `maps_to` list — see §6 |
| `validateAddChild` | Enforce the protocol registry's `allowedChildren` rule before a node is created |
| `checkCrossLanguageBoundary` | Mirrors `validate_graph.py` check 8 — blocks a same-process dependency edge across a language boundary |
| `registerCustomProtocol` / `restoreCustomProtocols` | Add a protocol type at runtime / restore ones saved in a loaded YAML's `protocol_registry` block |
| `graphToYamlObject` | Reverse of `normalizeGraph`, for Export |
| `emptyNodeFor` | Scaffold a blank node for a given protocol |
| `applyStatusConfig` / `applyProtocolRegistryConfig` | Boot-time config hooks — see §3.5 and §9 |

Constants: `PROTOCOL_REGISTRY` (the 7 built-in protocols), `STATUS_ENUM`
/ `STATUS_ORDER`, `STATUS_COLORS`, `BOUNDARY_ENUM`, `MODEL_KIND_VALUES`,
`BUILTIN_PROTOCOL_IDS`. Full definitions in §9.

Because this file has zero DOM dependency, it's directly testable in
plain Node — see §5.

### 3.2 View (`graph-view.js`) — "how does it look"

All rendering: the D3 tree diagram, the read-only detail panel, the
edit form, the tooltip, the add-child popup, and the custom-protocol
modal — all markup generation and D3 draw calls live here.

**Hard rule this file follows: it never calls `GraphModel` mutation
functions and never mutates app state.** It reads `GraphModel`'s pure
*query* functions (`buildTree`, `computeCrossEdges`, `childrenOf`,
`STATUS_COLORS`, `depIds`) to know what to draw, but every click a user
makes is reported upward through a `handlers` callback object rather
than acted on directly:

```js
GraphView.renderGraph(
  { normalized, registry, editMode, collapsedNodes, selectedNodeId },
  { onNodeClick, onAddChildClick, onToggleCollapse }
);
```

This is what makes the View swappable/inspectable independent of the
app's business rules — it doesn't know what a "settlement round" or a
"protocol" *means*, only how to draw the state it's handed and which
callback to fire for which gesture.

The only self-contained (non-callback) interactions are pure
presentation with no state implications: hover tooltip
show/move/hide, and the visual "highlight edges touching this node"
effect.

### 3.3 Controller (`graph-controller.js`) — "what happens when"

The only file that:
- holds mutable state: `registry`, `normalized`, `editMode`,
  `selectedNodeId`, `collapsedNodes`
- attaches real `addEventListener` calls to real DOM elements
- decides what a user action *means* (call a `GraphModel` mutation,
  then ask `GraphView` to redraw)

Wrapped in an IIFE so none of its internals leak onto `window`. Boots
itself at the bottom of the file (decodes the default graph, calls
`GraphModel.normalizeGraph`, calls `renderAll()`) — this is the only
side-effecting code that runs at load time.

**The dependency direction is strict and one-way:**

```
Controller ──uses──▶ Model
Controller ──uses──▶ View
View       ──reads──▶ Model (query functions only, never mutations)
View       ──never calls──▶ Controller
Model      ──never calls──▶ View or Controller
```

When you need to change something, this tells you where to look:

| You want to... | Edit this file |
|---|---|
| Change what makes a graph valid (a new referential-integrity rule, a new protocol constraint) | `graph-model.js` |
| Change how something looks (detail panel layout, node box styling, a new badge) | `graph-view.js` + the `<style>` block in `graph_editor.html` |
| Add a new button, keyboard shortcut, or way to trigger an existing action | `graph-controller.js` |
| Add an entirely new capability (new mutation + new UI for it) | Model function first, then a View render function that reports the interaction via a handler, then wire the handler in the Controller |

### 3.4 Data (`default-graph.js`)

Not Model, not View — just data. Holds the sample graph
(`kharcha-tracker-backend`, 48 nodes) as a base64 string, decoded at
boot by `GraphDefault.decodeDefaultGraphYaml()`.

**Why base64 instead of `fetch()`-ing a sibling `.yaml`:** this tool
is meant to be double-clickable straight from the filesystem, and a
`fetch()` of a sibling file is blocked by the browser under `file://`.
Embedding the bytes sidesteps that entirely, at the cost of the file
being large and not human-editable in place.

**To change the sample graph**, don't hand-edit the base64. Edit (or
point at) a real `.yaml` file and regenerate:

```bash
python3 scripts/embed-default-graph.py examples/kharcha_graph_storage.yaml
```

This overwrites `default-graph.js` with the new file's contents
re-encoded.

### 3.5 Config (`graph-config.js` + the two `.json` files)

Also data, not Model/View, but *external* data rather than embedded:
`graph-config.js` fetches `status-colors.json` and
`protocol-registry.json` at boot and, if each loads successfully,
applies it to `GraphModel` via `applyStatusConfig`/
`applyProtocolRegistryConfig` (§9 has the full field reference for
both files).

This is the one place in the app that `fetch()`s a sibling file, and
deliberately doesn't get the base64-embedding treatment
`default-graph.js` got: config is an optional customization, not core
functionality, so it's fine for it to require being served over
http(s) rather than opened via `file://`. If a fetch fails for any
reason — no server, missing file, malformed JSON — `graph-controller.js`'s
`boot()` proceeds anyway with whichever config (if any) loaded, and
`graph-model.js`'s own built-in defaults (identical in value to what
the two JSON files ship with) cover whatever didn't. `graph-config.js`
logs a `console.warn` per failed file, never throws.

**The mutate-in-place pattern this depends on:** `applyStatusConfig`/
`applyProtocolRegistryConfig` overwrite `STATUS_COLORS`/`PROTOCOL_REGISTRY`'s
*contents* rather than reassigning the module-level `const`s. Every
file that reads `GraphModel.STATUS_COLORS` or `GraphModel.PROTOCOL_REGISTRY`
already holds a reference to that exact object (captured once, at
`require`/`<script>`-load time) — mutating its contents in place means
the config takes effect everywhere without any file needing to
re-fetch anything from `GraphModel`. This is why `graph-controller.js`'s
`boot()` calls `GraphConfig.loadAndApplyConfig()` *before* cloning
`GraphModel.PROTOCOL_REGISTRY` into the working `registry` — the clone
needs to happen after the config has already landed.

### 3.6 Validation (`validate-graph.js`)

Added in the September 2026 pass — see §11 for the full picture. A
JS port of `validate_graph.py`'s `validate()`, run in-browser when
Save (or "Generate prompt"/"Generate prompts.json") is clicked. Like
`graph-model.js`, it's pure and Node-testable. It deliberately reuses
`graph-model.js`'s existing per-edge mirrors (`checkTypeDescriptorShape`,
`resolveLanguage`, `checkCrossLanguageBoundary`) rather than
duplicating them, and only adds the whole-graph checks that had no JS
equivalent yet (backbone existence, dangling references across every
relationship type, status/test consistency, node-id collision risk,
the full protocol/child-type sweep).

### 3.7 Prompt generation (`prompt-generator.js`)

Also added in the September 2026 pass — see §11. Composes a per-node
prompt from the node's own structured fields (not from a separate
Python tool), and generates the `prompts.json` manifest the "Generate
prompts.json" button writes out. Reads `GraphView.formatSignature`/
`formatTypeDescriptor` for display formatting and `GraphModel` for
relationship data — it's the one file in this app that depends on
both Model and View, since composing a prompt is neither pure data
logic nor DOM rendering.

---

## 4. Data flow — what happens on a click

Concretely tracing a "click a node" interaction end to end, since it
touches every layer:

1. User clicks a node box in the SVG.
2. D3's `.on("click", ...)` handler (attached in `GraphView.renderGraph`)
   fires `handlers.onNodeClick(d)` — the View does not decide what a
   click *means*, it only reports that one happened, on which datum.
3. `graph-controller.js`'s `handleNodeClick(d)` runs: it updates
   `selectedNodeId`, calls `GraphView.markSelected` /
   `GraphView.highlightEdgesFor` for the visual state, and calls
   `openDetailPanelFor(nodeId)`.
4. `openDetailPanelFor` reads `editMode` (Controller state) to decide
   whether to call `GraphView.renderViewPanel(node, nodeId)` (read-only
   markup) or `GraphView.renderEditForm(node, nodeId, registry, ...)`
   (a form), and injects the returned HTML string into `#detail-content`.
5. If in edit mode, the Controller then wires the form's Save/Delete/
   add-dependency controls (`wireEditFormHandlers`) — each of those,
   on interaction, calls a `GraphModel` mutation function
   (`GraphModel.addDependency`, `GraphModel.deleteNode`, ...) and then
   calls `renderAll()` to redraw from the new state.

Every mutation funnels through `GraphModel`, and every redraw funnels
through `GraphView.renderGraph` — there's no code path that mutates
`normalized.nodesById` directly from inside a DOM event handler
without going through a Model function first.

---

## 5. Testing the Model layer

`graph-model.js` has zero DOM dependency, so it runs directly in Node
via `require(...)` — no jsdom, no headless browser needed for this
layer:

```bash
node -e "
const yaml = require('js-yaml');   // npm install js-yaml, dev-only
const fs = require('fs');
const GraphModel = require('./graph-model.js');

const raw = yaml.load(fs.readFileSync('examples/kharcha_graph_storage.yaml', 'utf8'));
const normalized = GraphModel.normalizeGraph(raw);
console.log('nodes:', Object.keys(normalized.nodesById).length);
console.log('cross edges:', GraphModel.computeCrossEdges(normalized).length);
"
```

This was run against the real 48-node example graph while building
this refactor: tree-building, cross-edge computation, and every
mutation function (`addNode`, `addDependency`, `removeDependency`,
`deleteNode`, `graphToYamlObject`) were exercised and produced correct
results, with zero dangling references in the shipped example graph.

`graph-view.js` and `graph-controller.js` are not Node-testable as-is
(they read/write the real DOM and call D3), but the static
cross-references between all three layers were verified by hand for
this refactor — every `GraphModel.*` / `GraphView.*` call used by the
Controller resolves to an actually-exported member, and every DOM
element `id` referenced in JS either exists in `graph_editor.html`
statically or is one of the form-field ids the View creates
dynamically inside the detail panel / modal.

**Known gap:** no automated browser test exists yet for the View/Controller
layers (D3 draw calls, click wiring, form save/delete). If you add one,
Playwright or Puppeteer against a local `http.server` is the natural
choice — the app has no build step, so no bundling would be needed
first.

---

## 6. Representing data models (DTOs and DB schemas)

Two related but distinct kinds of "shape" show up in this schema, and
they're modeled as two separate node instances of the same new
`data-model` protocol rather than one type wearing two hats:

- **Service DTOs** (`model_kind: dto`) — the shape a function contract
  passes around. Before this feature these lived only informally,
  re-declared as free text in each function's `interface.types`.
- **DB schemas** (`model_kind: db_schema`) — the shape a storage
  backend actually persists. There was no representation for this at
  all previously, even though `storage_service`'s own notes already
  referenced `storage_service/models/*.*` as a concept.

The shipped example graph now has one of each —
`user_record` (dto, nested under `auth_service`) and `user_db_row`
(db_schema, nested under `storage_service`) — connected by a
**`maps_to`** relationship:

```yaml
- id: user_db_row
  title: "users table row"
  parent: storage_service
  interface:
    protocol: data-model
    model_kind: db_schema
    model_fields:
      id: "str  # PK"
      email: "str  # unique index"
      password_hash: str
      # ...
  maps_to:
  - user_record        # documents the row -> DTO mapping (password_hash is dropped)
```

**Two different relationships get two different fields:**

- A function *using* a DTO is an ordinary **`dependencies`** entry
  (e.g. `get_current_user` depends on `user_record`) — this is
  unchanged mechanism, and gets you the usual dashed cross-edge in the
  diagram for free.
- A DB schema *mapping to* a DTO is the new **`maps_to`** field,
  rendered as a distinct dotted blue line. It's deliberately **not**
  folded into `dependencies`: `dependencies` means "calls / needs this
  to function" and feeds `checkCrossLanguageBoundary`'s same-process-call
  reasoning — a type mapping isn't a call, so overloading `dependencies`
  for it would blur that meaning and risk a nonsensical cross-language
  warning. `data-model` nodes also have no `language` in the registry
  for the same reason (see the comment in `PROTOCOL_REGISTRY`).

**When to promote a type to a `data-model` node** vs. leaving it as a
plain `interface.types` entry on a function: promote it once the shape
is either (a) reused across more than one function's contract, so
there's a single source of truth instead of N hand-kept-in-sync copies,
or (b) a DB schema, since those have nowhere else to live.

Editing support: in Edit mode, a `data-model` node's form shows a
**Model kind** dropdown (`dto` / `db_schema`) and a **Model fields**
JSON editor, plus the usual Dependencies section and a new **Maps to**
section (add/remove mappings the same way you add/remove dependencies).
Model layer functions: `GraphModel.mapsToIds`, `addMapsTo`,
`removeMapsTo`, `computeMapsToEdges` — `deleteNode` also now blocks
deleting a node that something still maps to, the same way it already
blocked deleting a node with live dependents.

**`model_kind` now also covers enums and constants**, replacing the old
workaround of writing `ENUM = [...]` or a comment block of constant
assignments into free text. Both are still `data-model` nodes — the
Model kind dropdown just has two more options:

```yaml
- id: expense_status
  interface:
    protocol: data-model
    model_kind: enum
    enum_type: string
    enum_values:
      - {name: OPEN, value: Open}
      - {name: LOCKED, value: Locked}
      - {name: SETTLED, value: Settled}
```

```yaml
- id: system_config
  interface:
    protocol: data-model
    model_kind: constant
    constants:
      - {name: MAX_GROUP_SIZE, type: int, value: 100, scope: module}
```

The edit form shows a different sub-editor depending on which kind is
selected (`model_fields` for dto/db_schema, `enum_type` + `enum_values`
for enum, `constants` for constant) — see §9.3 for the mechanics.

**Not yet done:** `validate_graph.py` (outside this editor's codebase)
should get a matching rule that `model_kind` is one of
`dto`/`db_schema`/`enum`/`constant` and, optionally, that `db_schema`
nodes live under a `storage_service`-rooted subtree — this repo
doesn't have that file to edit.

---

## 7. Representing contracts and classes

Two more protocols beyond the original five, for the case a plain
`python-module` tree couldn't express: **an abstract contract with
more than one interchangeable concrete implementation** (e.g. a
storage backend that might be a flat file, SQLite, or Postgres, all
fulfilling the same method set).

- **`contract`** — a data-transfer interface: a named set of method
  signatures, each with params/return typed against `data-model` node
  ids (or a primitive like `str`/`int`/`dict`). No children, no
  language — a contract is a boundary spec, not code.
  ```yaml
  - id: storage_interface
    interface:
      protocol: contract
      methods:
        - name: save_record
          params: [{name: record, type: base_record}]
          returns: base_record
  ```
- **`class`** — a concrete implementation. Its `python-function`
  children (via the existing `parent` field, same as any other
  decomposition) are where the actual leaf implementation work
  happens; the class node itself carries no language either, per the
  "language is a property of a subtree, not an individual node"
  principle — its function children's own `language` is what's real.

**`implements`** is the relationship connecting the two — a new
top-level, sibling-to-`dependencies`/`maps_to` field, not an
`interface` field, for the same reason `maps_to` isn't folded into
`dependencies`: "this class fulfills this contract" is a structural
fact, not a call, so it shouldn't feed `checkCrossLanguageBoundary` or
blur what `dependencies` means.

```yaml
- id: flat_file
  interface:
    protocol: class
  implements:
    - node: storage_interface
```

Editing support: in Edit mode, a node's form shows an **Implements**
section (same add/remove-chip pattern as Maps to), offered whenever
at least one `contract` node exists in the graph, with its "add"
dropdown restricted to contract-protocol nodes only.
`GraphModel.addImplements` also rejects targeting anything that isn't
a `contract` node, and `deleteNode` now blocks deleting a contract
something still implements, the same way it blocks deleting a node
with live dependents or mappers.

**Not yet done:** `validate_graph.py` should get a matching rule
(`implements` targets resolve to `protocol: contract`, method
param/return types resolve to a known `data-model` node or primitive)
— this repo doesn't have that file to edit. Also open: whether a
class's method set should be checked against its contract's `methods`
for full coverage (currently unchecked either here or presumably in
`validate_graph.py`).

---

## 8. Extending the protocol registry

The 7 built-in protocols (`rest`, `python-module`, `python-function`,
`browser-js`, `data-model`, `contract`, `class`) live in
`GraphModel.PROTOCOL_REGISTRY`. You
can add more at runtime without editing code, via the **"+ Custom
protocol type"** button in Edit mode — it calls
`GraphModel.registerCustomProtocol`, which requires a `language` field
(this is what lets `checkCrossLanguageBoundary` catch an impossible
same-process call across e.g. Python↔Swift). `data-model` is the one
built-in exception to "every protocol has a language" — see §6.

Custom protocols you register are saved into the exported YAML's
top-level `protocol_registry` block (see `graphToYamlObject`), and
restored automatically the next time that file is loaded
(`restoreCustomProtocols`) — so they round-trip without needing to be
re-registered by hand every session.

---

## 9. Constants reference

Every closed set of values the editor uses, where it's defined, and
whether it's actually enforced (a `<select>`, rejecting bad input) or
just a convention the code reads consistently but never validates.

### 9.1 `STATUS_ENUM` / `STATUS_ORDER` / `STATUS_COLORS`

Defined in `graph-model.js`, **overridable via `status-colors.json`**
(§3.5). The one enum enforced by a `<select>` — the edit form's Status
field can't be set to anything outside this list. `STATUS_ENUM` and
`STATUS_ORDER` are the *same array* under two names (`STATUS_ENUM` at
call sites building the dropdown, `STATUS_ORDER` where sequence
matters); the color and the enum's very existence both now come from
one JSON file — a status's position in the file *is* its position in
`STATUS_ORDER`, so adding a new status is one line in
`status-colors.json`, nothing in code. Colors render as each node's
**border** (see §9.5).

| Value | Default color | Meaning |
|---|---|---|
| `unsplit` | `#9ca3af` gray | Node exists in the tree but has no contract yet |
| `contract_defined` | `#3b82f6` blue | Signature/interface specified; no implementation |
| `stub` | `#f59e0b` amber | Placeholder implementation, matches contract shape, does nothing real |
| `implementing` | `#f97316` orange | Real implementation in progress |
| `implemented` | `#eab308` yellow | Implementation complete, not yet verified against tests |
| `tested` | `#a855f7` purple | Passes its own tests, in isolation |
| `integrated` | `#22c55e` green | Verified working within the whole system |

### 9.2 `BOUNDARY_ENUM`

Defined in `graph-model.js` as `[BOUNDARY_MODULE, BOUNDARY_SERVICE]`
(`"module"`, `"service"`). **Now enforced by a `<select>`** in the edit
form (previously free text — a typo like `"servic"` used to silently
pass through as "not service" with no warning; that gap is closed).
The select's blank option represents "unset," which is meaningfully
different from either enum value: it means "fall back to the graph's
top-level `default_boundary`," not "explicitly module."

| Value | Meaning |
|---|---|
| `module` | Same-process, direct call — the default assumption |
| `service` | Crosses a process boundary — the only value that permits a dependency edge between nodes whose protocols declare different languages (checked by `checkCrossLanguageBoundary`) |
| *(blank/unset)* | Falls back to the node's nearest `default_boundary` |

Not JSON-configurable — unlike status/protocol colors, these two
literal strings are load-bearing inside `checkCrossLanguageBoundary`'s
logic itself (`BOUNDARY_SERVICE` is compared against directly), so
externalizing them would mean the boundary-check code and the config
file could silently disagree about what "service" means. Kept as code
constants deliberately for that reason.

### 9.3 `MODEL_KIND_VALUES`

Defined in `graph-model.js` as `[MODEL_KIND_DTO, MODEL_KIND_DB_SCHEMA,
MODEL_KIND_ENUM_TYPE, MODEL_KIND_CONSTANT]` (`"dto"`, `"db_schema"`,
`"enum"`, `"constant"`). Renamed from `MODEL_KIND_ENUM` — now that
`"enum"` is itself one of the values, keeping the array named
`MODEL_KIND_ENUM` would have meant `MODEL_KIND_ENUM` contains
`"enum"` as a member, confusing at every call site. **Enforced by a
`<select>`**, same as `boundary` — only rendered when a node's protocol
declares `model_kind` in its `fields` list (currently just
`data-model`; see §9.4). Same not-JSON-configurable reasoning as
`BOUNDARY_ENUM`: nothing in the current code branches on the specific
value the way `checkCrossLanguageBoundary` does on `boundary`, but
keeping it next to `BOUNDARY_ENUM` in code keeps the two easy to find
together.

| Value | Meaning | Interface sub-fields it uses |
|---|---|---|
| `dto` | Service-boundary data transfer shape | `model_fields` |
| `db_schema` | Storage-layer persisted shape | `model_fields` |
| `enum` | A closed, named set of values | `enum_type`, `enum_values` |
| `constant` | A group of related named constants | `constants` |

The edit form renders all three sub-field blocks into the DOM at once
and toggles which is visible via a plain `display` switch on
`f-model-kind`'s `change` event (`graph-controller.js`) — no full
form re-render, so in-progress edits to other fields survive switching
`model_kind` before Save. Save itself reads only the block matching
the *final* selected kind and deletes the other kinds' fields, so a
dto-turned-enum node doesn't carry stale `model_fields`.

### 9.4 `PROTOCOL_REGISTRY`

Defined in `graph-model.js`, **overridable via `protocol-registry.json`**
(§3.5) — see §8 for how to add a protocol at runtime instead of
editing either file.

| Protocol id | `label` | Default `color` | `allowedChildren` | `fields` | `leafCapable` | `language` |
|---|---|---|---|---|---|---|
| `rest` | REST API (backbone) | `#a78bfa` | `python-module`, `python-function` | *(none)* | `false` | `python` |
| `python-module` | Python module (service/package) | `#2dd4bf` | `python-function`, `python-module`, `data-model` | `exports` | `false` | `python` |
| `python-function` | Python function (leaf) | `#fb7185` | *(none)* | `signature`, `types`, `tests`, `stub_behavior` | `true` | `python` |
| `browser-js` | Frontend/JS surface | `#fbbf24` | *(none)* | `exports` | `true` | `javascript` |
| `data-model` | Data model (DTO / DB schema / enum / constant) | `#60a5fa` | *(none)* | `model_kind`, `model_fields` | `true` | `null` *(deliberate — see §6)* |
| `contract` | Contract (data-transfer interface) | `#c084fc` | *(none)* | `methods` | `false` | `null` *(deliberate — see §7)* |
| `class` | Class (implements a contract) | `#34d399` | `python-function` | *(none)* | `false` | `null` *(deliberate — see §7)* |

`note` was a `fields` entry on `rest`/`python-module`/`data-model`
until this pass — removed everywhere in favor of a single top-level
`notes` field on every node, so there's exactly one place prose lives
regardless of protocol. Existing `interface.note` content in both
shipped example graphs (`kharcha_graph_storage.yaml` and the sample
this editor boots with) has been migrated into `notes`.

Column meanings: `allowedChildren` is enforced by `validateAddChild`
(the only place decomposition legality is checked). `fields` drives
which `interface.*` sub-fields the edit form renders. `leafCapable` is
currently informational only — nothing branches on it yet.
`language` feeds `checkCrossLanguageBoundary`; `null` means "makes no
language claim," which is what lets a function depend on a DTO
without a false cross-language warning — `contract` and `class` are
`null` for the same reason (§7): language belongs to the
language-tagged leaf/module subtree, not to the boundary-spec or
container node itself.

`color` is now genuinely load-bearing (§9.5), not dead metadata — a
custom protocol's color, chosen from `KNOWN_COLORS` in the "+ Custom
protocol type" modal, is what its nodes will actually render as.

`BUILTIN_PROTOCOL_IDS` isn't an independent constant — it's
`new Set(Object.keys(PROTOCOL_REGISTRY))`, kept in sync by
`applyProtocolRegistryConfig` whenever the registry is reloaded from
config. Its only job: at export time, distinguish "ships with the
tool" protocols (never written to the YAML) from custom ones a user
registered (written to `protocol_registry:` so they round-trip).

### 9.5 Node color convention: fill = protocol, border = status

The two color systems above are deliberately independent facts,
rendered as two independent visual channels on the same node box:

- **Fill** = the node's protocol color (`registry[protocol].color`) —
  *what kind of thing this is*.
- **Border** (a thick 3.5px stroke, 4.5–5px on hover/selected) = the
  node's status color (`STATUS_COLORS[status]`) — *how far along it
  is*.

Both are read fresh on every render, so editing either JSON config
file and reloading — or registering a custom protocol at runtime —
changes node colors immediately, with no other code needing to know.
The legend (bottom-left of the canvas) is generated the same way, from
the same live values, specifically so it can't drift out of sync with
what's actually configured.

### 9.6 `KNOWN_FIELD_OPTIONS` / `KNOWN_COLORS` (`graph-view.js`)

Not validation constants — they only populate the checkboxes/dropdown
shown when registering a **new custom protocol** via "+ Custom
protocol type." Neither restricts what `registerCustomProtocol` will
actually accept (any string works for both `fields` and `color`); they
exist purely as UI convenience lists.

- `KNOWN_FIELD_OPTIONS`: `signature`, `types`, `exports`,
  `model_kind`, `model_fields`, `methods`, `tests`, `stub_behavior` —
  every interface sub-field any built-in protocol currently uses.
  `note` was removed from this list along with the field itself (§9.4);
  `methods` was added for `contract`.
- `KNOWN_COLORS`: 9 named hex swatches (`purple` `#a78bfa`, `teal`
  `#2dd4bf`, `coral` `#fb7185`, `pink` `#f472b6`, `gray` `#9ca3af`,
  `blue` `#60a5fa`, `green` `#4ade80`, `amber` `#fbbf24`, `red`
  `#f87171`) — the dropdown shows the name, submits the hex.

---

## 10. Known limitations (carried over, not introduced by this refactor)

- No undo/redo. Deleting a node is a real, immediate mutation of
  in-memory state; only Save (§11) persists anything to disk.
- The edit form's Types/Model fields/Exports/Tests fields are raw JSON
  textareas — invalid JSON on Save shows an inline error but there's
  no structured editor for these yet.
- The "Allowed children" / "Template fields" pickers in the custom-protocol
  modal are a small hand-rolled checkbox-dropdown (`.ms-dropdown` /
  `initCheckboxDropdowns` in `graph-view.js`), not a library component —
  fine for the handful of options these lists ever have, but not meant
  to scale to a long list without adding search/filter.
- No collaborative/multi-user editing — this is a single-file,
  single-session, client-only tool.
- `status-colors.json`/`protocol-registry.json` only take effect when
  served over http(s) — under `file://`, `fetch()` of a sibling file
  is blocked, so config silently falls back to the JS built-in
  defaults (§3.5). This is the one feature added in this pass that
  breaks the tool's "double-click and go" story; everything else
  still works from a raw filesystem open.

---

## 11. September 2026 pivot — self-sufficient `graph.yaml`, prompt generation, native Save

The direction changed after the pass documented above: instead of a
separate Python toolchain (`scaffold.py`, `module_scaffold.py`,
`generate_prompts.py`, ...) reading `graph.yaml` and doing the actual
scaffolding/prompt-writing, the goal is now for **`graph.yaml` itself
to carry enough structure that a small LLM can be handed it directly**
(plus a generated `prompts.json`) and do that work itself. The Python
scripts still exist and still run, but new work happens in
`graph_editor.html` and its JS files, not there. This section is the
accurate reference for everything that changed under that pivot.

### 11.1 New node fields

| Field | Where | Purpose |
|---|---|---|
| `interface.errors` | `function` nodes | `[{code, description}]` — error cases not expressible as a type |
| `interface.preconditions` | `function` nodes | `[string]` — must hold before the call |
| `interface.postconditions` | `function` nodes | `[string]` — guaranteed true after a successful call |
| `calls` | any node | `[{node, operation_name}]` — sharpens a `dependencies` edge down to a named operation (own top-level field, same pattern as `maps_to`/`implements` — see `addCall`'s doc comment in `graph-model.js`) |
| `data_flows` | any node | `[{node, data_model, direction}]`, `direction` ∈ `read`/`write` — what data moves where, independent of `dependencies`/`calls` |
| `prompt_template` | any node | Optional override of the built-in prompt composition template for this node. A plain string with `{placeholder}` tokens — see 11.3. Blank = use the built-in default for the node's `kind` (11.2). |
| `prompt` | any node | The reviewed/edited prompt **text itself**, distinct from `prompt_template` (the recipe vs. the result). Populated by the "Generate prompt" button, editable, persisted on node Save. |

`errors`/`preconditions`/`postconditions` were deliberately added as
fields on `function` itself, not as a separate `operations` list —
Revision 3 already decomposes every operation into its own `function`
leaf node with structured `params`/`returns`; a list-of-operations
block would have duplicated that decomposition. `calls`/`data_flows`
are a third and fourth instance of the `maps_to`/`implements`
pattern: their own top-level field, their own `add*`/`remove*`
functions, their own dangling-reference check in both
`validate_graph.py` and `validate-graph.js`, their own edge color on
the graph (cyan dashed for calls, lime dotted for data flows) and
their own chip UI in the detail panel.

### 11.2 Prompt "kind": implementation vs. skeleton

Not every promptable node gets the same kind of prompt.
`GraphPromptGen.nodeKind(node, normalized, registry)` returns one of:

- **`"implementation"`** — a real function body, or a complete
  data-model/browser-js definition. Any node whose protocol is
  `leafCapable` in the registry (`function`, `browser-js`,
  `data-model` today).
- **`"skeleton"`** — imports, class/module wiring, and empty function
  stubs (`raise NotImplementedError` / `pass`) only — no function
  bodies. Applies to:
  - `contract` nodes (always) — generates the ABC/Protocol shell from
    `methods`.
  - `class` nodes (always) — the class shell + stub methods for every
    `function` child.
  - `module` nodes **only if their effective layout is `file`**
    (`GraphModel.inferredLayout(...) === "file"`) — a `layout: folder`
    module has no single shared file to skeleton, since every
    function child already gets its own complete file (imports
    included) via its own implementation prompt.
- **`null`** — not a generation target at all (e.g. `entrypoint`).

This is a deliberately separate classification from the registry's
`leafCapable` flag, not a repurposing of it — `leafCapable: false` on
`module`/`class`/`contract` still means what it always meant
elsewhere (those protocols have children), and other code that reads
`leafCapable` (e.g. `registerCustomProtocol`'s default heuristic) is
unaffected.

A node is only actually included in a generated manifest — bulk or
single — when `status` is `stub` or `implementing` (mirrors the old
Python tool's `READY_STATUSES`; `unsplit`/`contract_defined` aren't
ready yet, `implemented`/`tested`/`integrated` are already done). The
single-node "Generate prompt" button (11.4) is the one exception —
it ignores this status gate so you can draft/preview a prompt before
flipping status.

### 11.3 Prompt composition (`prompt-generator.js`)

A node's prompt = `interface` fields (protocol-dependent: `params`/
`returns`/`errors`/`preconditions`/`postconditions` for a function,
`methods` for a contract, `fields` for a class, `model_fields`/
`enum_values`/`constants` for a data-model) + `calls`/`data_flows`/
`dependencies` + `notes` + a **guardrail** block derived from `status`
and `contract_version`:

- `status: stub` → `ACTION: CREATE` — "this file/function doesn't
  exist yet."
- `status: implementing` → `ACTION: UPDATE` — "an implementation
  already exists; touch only this node's own file/function."

If `node.prompt_template` is set, it overrides the built-in default
template for that node's `kind` — a plain string with `{placeholder}`
tokens substituted in a single pass, no nested/conditional template
logic. The full, current placeholder reference (every token, what
each is self-contained for vs. not, and known double-print risks) is
`graph_editor_helper.md`'s §10, not duplicated here — it's been
revised twice since first written (a combined `{relationships}` token
was removed in favor of cherry-picking `{dependencies}`/`{calls}`/
`{data_flows}` individually, and `{language}`/`{action}`/
`{scope_note}`/`{path}`/`{relationships_header}` were added after).

### 11.4 The two "Generate" workflows

**Header button — "Generate prompts.json"** (edit mode only): runs
`GraphValidate.validateGraph` over the *whole* graph first (blocks on
errors, confirms on warnings-only, same as Save), then writes an
object — **not a bare array** — shaped `{ project, structure, tree, prompts }`:

- `structure` — every node with a determinable file (`nodeKind()` is
  non-null), **regardless of current status**: `{node_id, path, kind}`
  per entry. This is the intended FINAL layout, not just what's ready
  to build right now — the point of it is that `prompts.json` alone
  can bootstrap a project from scratch.
- `tree` — the same data rendered as an ASCII directory tree,
  deduplicated by path (see 11.8 — a `function`'s path now equals its
  parent's, so the same file can legitimately appear twice in
  `structure` under two different node ids; the tree collapses that
  to one visual leaf).
- `prompts` — one entry per promptable node (11.2), sorted shallowest-
  parent-first: `{node_id, kind, status, version, action, prompt}`. If
  a node's `prompt` field is already non-empty (previously generated
  and reviewed), that saved text is used **verbatim** instead of being
  recomputed — the node still appears, it's just not silently
  regenerated out from under an edit.
- `project` — the graph's project name.

The button only refuses to write the file when **both** `structure`
and `prompts` are empty — a graph with real structure but nothing yet
at `stub`/`implementing` still produces a useful file.

**Per-node "Generate prompt" button** (in the edit form, only shown
when `nodeKind` is non-null for that node): the same composition and
the same full-graph validation as the bulk button, applied to just
the selected node — works regardless of that node's own status
(useful for drafting/previewing before flipping it to `stub`). Writes
the result into an editable textarea below the button, not directly
into the node — the text only becomes part of the node's real data
when you click the form's own **Save** button afterward. If the
textarea already has content, generating again asks for confirmation
before overwriting it.

### 11.5 Save (renamed from Export) + native file picker

The header button was **Export YAML**; it's now **Save**, and before
writing anything it runs `GraphValidate.validateGraph` — blocks with
an alert listing errors, or confirms before proceeding on
warnings-only. Both Save and "Generate prompts.json" write through a
shared `saveTextFile(text, suggestedName, pickerId)` helper:

- If the browser supports the File System Access API
  (`showSaveFilePicker` — **Chrome/Edge only**; Firefox and Safari
  have declined to implement it), a native save dialog opens. The
  same `pickerId` is passed on every call (`"graph-yaml-save"` for
  the graph, `"graph-prompts-save"` for prompts.json), which is what
  makes the browser itself reopen the last directory used for that
  id next time — no manual path-tracking needed, and it defaults to
  the browser's own default location (typically the user's
  downloads/home folder) the first time.
- Otherwise, falls back to the original anchor/Blob download — same
  behavior as before this pass, just without a picker or remembered
  path.

Cancelling the native picker (`AbortError`) is treated as "user
changed their mind," not an error — nothing is downloaded as a
fallback in that case.

### 11.6 `protocol-registry.json` bugfix

Unrelated to the pivot itself but fixed alongside it: `protocol-registry.json`
had drifted out of sync with `graph-model.js`'s built-in
`PROTOCOL_REGISTRY` — it still had the pre-Revision-3 protocol names
(`rest`/`python-module`/`python-function` instead of
`entrypoint`/`module`/`function`). Since `graph-config.js` applies
this file's contents **over** the built-in registry whenever it loads
successfully (i.e. whenever served over http(s), not `file://`), this
was a real, silent correctness bug — not just a doc gap — until fixed.
It's now kept in sync, including the new `function` fields (11.1).

### 11.7 Python-side changes

`graph_runner.py`'s `Node` dataclass gained `calls`, `data_flows`, and
`prompt_template`/`prompt` as real fields (read/written by
`Graph.load()`/`Graph.save()`, mirroring how `maps_to`/`implements`
already worked) — without this, those fields would have silently
vanished on any Python-side load/save round-trip. `validate_graph.py`
gained two new checks (dangling-reference checks for `calls` and
`data_flows`, mirroring the existing `maps_to`/`implements` checks).
`scaffold.py`, `module_scaffold.py`, `generate_project.py`,
`generate_prompts.py`, and `exceptions_gen.py` are **unchanged** —
none of them read the new fields, consistent with the pivot's
direction (these are the scripts being phased out in favor of
`graph_editor.html` + `prompt-generator.js`). If you still rely on any
of them for actual code generation, be aware they don't know about
`calls`/`data_flows`/skeleton prompts at all.

**A separate top-level README for this wider Python toolchain is
referenced at the top of this file but wasn't available when this
section was written — it hasn't been updated as part of this pass.**
If one exists, it should get a short note pointing at this section (or
at `validate_graph.py`'s own docstring, which documents the Python-side
changes directly) so its own description of `Node`'s fields doesn't
go stale the same way `protocol-registry.json` did.

### 11.8 `path`, the derived-values rule, and the function/parent collision fix

A `path` field briefly existed as a real, persisted node field
(mirroring `prompt`) so a computed file path would round-trip in
`graph.yaml` for downstream tools to read "for easier processing
later." It was **removed** once the actual risk was named plainly:
a stored derived value goes stale the moment anything it depends on
changes elsewhere — reparenting a node, renaming the project, a
hand-edit to `graph.yaml` outside this app — with nothing in the file
itself to distinguish "correct" from "three edits out of date." That
became a standing rule for this project going forward: **derived
values are always computed on the fly, never stored on a node.**
`GraphModel.buildPath(nodeId, normalized, registry)` is the pure
function that survived — called fresh every time `{path}` or a
`{dependencies}` line is composed, nothing written back.

Building a real multi-node test case for the `structure`/`tree`
feature (11.4) surfaced a genuine bug in `buildPath` itself, not just
in the persistence question: a `module` whose effective layout
resolves to `file` (every direct child is a function) gets its own
path — say `auth.py` — but its function child's path, built by
walking the ancestor chain, came out as `auth/login.py`. A real
filesystem can't have both `auth.py` (a file) and `auth/` (a
directory) with the same name. The fix: a `function` node's path is
now always its parent's path, never a nested segment of its own — a
function is never its own file, it's code inside whatever module
contains it. This is a complete fix for every *valid* graph, not a
narrow patch: `validate_graph.py`/`validate-graph.js`'s layout check
already requires every direct child of a `layout: file` module to be
a function, so `function` is the only protocol that can ever collide
this way in the first place. One consequence: `structure` can now
legitimately list the same `path` twice (the module's skeleton entry
and the function's implementation entry both pointing at one file) —
intentional there, but `tree` deduplicates by path so the same
filename doesn't appear to render twice.
