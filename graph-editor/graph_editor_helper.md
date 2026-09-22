# graph_editor_helper.md — which fields you need to fill, and what each one actually produces

This is a field-by-field reference for authoring nodes in `graph_editor.html`,
organized by `protocol` (node type). Every claim in this document was checked
against the actual Python tool source and, where noted, verified by running
the real tool against a real graph — not inferred from field names. Where a
field exists but nothing currently reads it, that's stated plainly rather
than left implied.

**How to read the tables:** "Required for" means the tool either crashes,
silently produces an empty/degraded placeholder, or skips the node entirely
without that field. "Optional" means the tool runs fine without it, just
with less detail in the output.

> **September 2026 note:** sections 1–9 below describe protocols by their
> pre-Revision-3 names (`rest`/`python-module`/`python-function`) and
> predate the `calls`/`data_flows`/`errors`/`preconditions`/`postconditions`/
> `prompt`/`prompt_template` fields — this staleness predates this note and
> hasn't been corrected here yet (see the `graph_editor` project's own
> README §11 and this repo's `python-toolchain-README.md` Pass 5 for what's
> current on those). **§10 and §11, appended below, are current** — §10
> documents the browser-side prompt composition placeholders and §11
> documents `prompt.json`'s own shape, both reviewed and confirmed as of
> this pass.

---

## 0. Fields every node type shares (top-level, outside `interface`)

| Field | Required for | What it produces / who reads it |
|---|---|---|
| `id` | Everything | Becomes the filename, dotted import path, and dataclass/Enum class name (PascalCase-derived) everywhere. The single most load-bearing field in the whole schema. |
| `parent` | File placement | Determines folder/file nesting in both `scaffold.py` (`module_path_for`) and `module_scaffold.py` (`file_path_for`, `write_folder_module`). |
| `status` | `generate_prompts.py`, `opencode_bridge.py` | Must be `contract_defined` or `implementing` (`READY_STATUSES`) for a leaf to be picked up for prompt/test generation or handed to OpenCode. A leaf stuck at `unsplit` is invisible to both, even with a perfect `signature`. |
| `dependencies` | Almost everything | **Redefined:** means "this node's code imports/references that node's unit" — a real import edge, not containment (containment is `parent`'s job alone; there is no longer a rule that a parent must list its children here). Only `module`/`class` nodes may hold a `dependencies` list; only `module` and `data-model` (dto/db_schema/enum/constant) nodes are valid targets — you call or implement a function/contract, you don't import it. A leaf (`function`, `contract`, `data-model`, ...) has no list of its own; it inherits whatever its containing module/class imports, resolved on the fly (`GraphModel.effectiveDependencies` in the editor) rather than stored on the leaf. This feeds "wired" dummy-call generation in the (now-superseded) Python generators and cross-language boundary checks. |
| `maps_to` | Validation only | DB-schema↔DTO type-mapping edges. Dangling references are caught by `validate_graph.py`; **not currently read by any code generator** — documentation/traceability only today. |
| `implements` | Validation only | Class→contract edges. `validate_graph.py`/`graph-model.js` enforce the target is `protocol: contract`; **not currently read by any code generator** — a `class` node's generated code is identical whether or not `implements` is set. |
| `notes` | `opencode_bridge.py`, `module_scaffold.py` | Embedded verbatim into the OpenCode prompt (`build_prompt`, "Notes from the contract — treat as binding requirements") and into `module_scaffold.py`'s generated docstring OPENCODE PROMPT block. **Not embedded into `scaffold.py`'s leaf-mode stub file** — leaf-mode stubs only say "see notes in graph.yaml," they don't quote it. |
| `stub_behavior` | `opencode_bridge.py`, `module_scaffold.py` | Same asymmetry as `notes`: embedded in the OpenCode prompt and in `module_scaffold.py`'s docstring, but **not** quoted into `scaffold.py`'s leaf-mode stub file. |
| `tests` | `generate_pytest.py` | No `tests` = no test file generated for that node at all (`generate_test_for_node` returns `None` immediately). `generate_prompts.py`'s TODO.md shows `(no tests defined)`. |
| `context_include` (`context: {include: [...]}`) | Nothing yet | Round-trips through load/save faithfully. Referenced only in a human-readable `Action` reason string in `graph_runner.py` ("scoped to context.include only") — **not actually read or enforced by `build_prompt` or anything else**. Fill it in for your own documentation; no tool currently honors it as a scoping mechanism. |
| `contract_version` | Nothing | Round-trips; no tool reads it. |
| `boundary` | `validate_graph.py` only | `module` vs `service`. Only matters when a dependency edge crosses a language boundary (see each protocol's `language`) — required to be `service` in that case, or `validate_graph.py` errors. Doesn't affect generated file structure. |

---

## 1. `rest`

The graph's backbone/root. No protocol-specific `interface` fields.

| Field | Required for | Output |
|---|---|---|
| *(none)* | — | Exists as the tree root (`graph.backbone`). `module_path_for`'s default nesting treats a node parented directly to the backbone as top-level (no extra folder). |

**Minimum to be useful:** just needs to exist and be `graph.backbone`. All real content lives in its descendants.

---

## 2. `python-module`

A folder/package-level grouping.

| Field | Required for | Output |
|---|---|---|
| `exports` | `module_scaffold.py`, a2d-style graphs only | Rendered as free-text illustrative stubs (`kind`/`name`/`signature` — signature is NOT re-parsed, printed as-is) **only if the module has zero kharcha-style function dependencies**. Ignored entirely by `scaffold.py` (leaf mode has no concept of module-level exports). |
| `layout` | `module_scaffold.py` only | `"file"` (default, or absent) = today's behavior: one combined file for the whole module. `"folder"` = a real Python package, one file per leaf function descendant, recursively (reuses `scaffold.py`'s own per-function generator). **Ignored by `scaffold.py`** — leaf granularity always makes one file per function regardless of this field. **Rejected by `validate_graph.py` on anything other than `python-module`** (e.g. setting it on a `class` node is a hard error). |

**Its children matter more than its own fields:**
- Children with `protocol: python-function` **and** a real `signature`, reachable via this module's own `dependencies` list → become the module's rendered functions (module mode) or individual files (leaf mode / folder layout).
- Children with `protocol: data-model` → **currently produce nothing inside this module's own generated file.** `generate_module_file()` has no code path for data-model children at all; it falls through to an empty placeholder ("No dependencies and no exports found for this module node") even though the module clearly has content. The DTOs themselves *do* get generated correctly, but into the single shared `services/_scaffold_types.py` (module mode) or `app/models.py` (leaf mode) — not nested under this module's own file, regardless of the graph's intended organization. **This is a known, currently-unfixed gap** — if you name a module `models` and give it DTO children expecting `from services.models import User` to work, it won't; you'd need `from services._scaffold_types import User` instead until this is fixed.
- Children with `protocol: contract` → similarly produce nothing in this module's own file (no ABC/Protocol generation exists yet — see §5).

**Minimum to be useful:** `dependencies` listing every child (required by validation regardless), and at least one `python-function` child with a real `signature` if you want this module to render as anything other than an empty stub.

---

## 3. `python-function` — the highest-leverage node type

| Field | Required for | Output |
|---|---|---|
| `signature` | **Everything downstream** | See below — this is the field that gates almost every generator. |
| `types` | Optional | Inline custom type shapes this function declares (not promoted to their own `data-model` node). Merged into the graph-wide `known`/`all_types` set the exact same way `data-model` shapes are — read by every generator that builds a `known` set (`scaffold.py`, `module_scaffold.py`, `generate_pytest.py`, `generate_prompts.py`, `opencode_bridge.py`). |
| `tests` | `generate_pytest.py` | See §0 — no tests, no test file. |
| `stub_behavior` | `opencode_bridge.py` prompt, `module_scaffold.py` docstring | See §0's asymmetry note. |
| `http_method` + `route` | `generate_main_file()` (both generators) | **Both must be set together.** Produces a real FastAPI route (`@app.post("/path") def x_endpoint(): return x(dummy_args)`) in the generated `main.py`. Either one alone → `validate_graph.py` warns, and no endpoint is generated (silently, from the generator's own perspective). |

### What `signature` alone unlocks or blocks

| Without a real `signature` | With one |
|---|---|
| `--granularity leaf`: this function contributes 0 files. If **every** function in the graph lacks a signature, `generate_project.py` refuses outright: `ValueError: 0 leaf nodes found`. | `--granularity leaf`: gets its own file (`app/<parent>/<id>.py` or nested under `layout: folder`), fully type-annotated, with wired dummy-calls to its real dependencies. |
| `--granularity module`: falls back to a raw `def id(*args, **kwargs): raise NotImplementedError(...)` stub — no type annotations, no wired calls, just a marked placeholder. | `--granularity module`: real typed signature, wired dummy-calls to dependencies (if `dependencies` set). |
| `generate_pytest.py`: no test file generated (`generate_test_for_node` returns `None`). | Gets a real pytest file translated from its `tests:` block (three-tier translation — see that file's own docstring). |
| `generate_prompts.py`/`opencode_bridge.py`: effectively invisible — `is_leaf_with_signature()` gates node selection everywhere. | Gets a scoped prompt (`build_prompt`) and, if `tests` is also set, a fixed test file bundled with it. |

**Signature syntax must be real `typedsl.py` vocabulary**: `name(param: Type, ...) -> ReturnType`. Types can be a primitive (`str`/`int`/`float`/`bool`/`Decimal`/`dict`/`list`/`None`/`string`/`number`/`UUID`/`timestamp`), a `list[X]`/`dict[K,V]` wrapper, a `X | None` union, or **the derived PascalCase name of another node** — never that node's raw id. `expense_status` (a node id) will fail; `ExpenseStatus` (its derived type name) will work. `validate_graph.py` has a dedicated check for this exact mistake on `model_fields` values; the same mistake in a `signature` isn't caught by the validator but **will crash** `generate_stub_file()` uncaught.

**Minimum for a "complete" leaf:** `signature` (real, parseable) + `status: contract_defined` or later + `tests` if you want a generated test + `dependencies` listing anything it really calls.

---

## 4. `browser-js`

| Field | Required for | Output |
|---|---|---|
| `exports` | Nothing in the Python tools | **No Python tool processes `browser-js` nodes at all.** `scaffold.py` and `module_scaffold.py` both filter strictly on `python-module`/`python-function`/`class`/`data-model`. A `browser-js` node is fully visible to the graph editor and `validate_graph.py` (cross-language boundary checks apply, since it has `language: javascript`), but `generate_project.py` will never emit a file for it under either granularity. |

**Minimum:** whatever the graph editor needs for modeling/documentation purposes; nothing here feeds Python codegen.

---

## 5. `data-model`

`model_kind` decides which of the three sub-shapes below actually matters — the other two are ignored regardless of what's in them.

| `model_kind` | Required fields | Output |
|---|---|---|
| `dto` / `db_schema` | `model_fields` (dict of `fieldName: typeString`) | A real `@dataclass` + `dummy_X()` factory in the shared models file. **Empty `model_fields: {}` is silently skipped entirely** — not even an empty class gets generated (confirmed: a real node in the shipped example with empty `model_fields` produces nothing at all). |
| `enum` | `enum_type` (`string`/`int`) + `enum_values` (list of `{name, value[, notes]}`) | A real `class X(Enum): MEMBER = value` + a `dummy_X()` factory returning the first member. Empty `enum_values` → warning, no class emitted (Python doesn't allow an empty Enum). |
| `constant` | `constants` (list of `{name, type, value[, scope, notes]}`) | Plain module-level assignments (`NAME: type = value`) in the shared models file. **Never added to the `known` type-name set** — a constant is a value, not a type; it can't be used as a signature/field type annotation. |

Field **type strings** inside `model_fields` follow the exact same rule as function signatures (§3): use the referenced node's derived PascalCase name, never its raw id. `validate_graph.py` has a dedicated check for this.

**Where the generated code actually lands:** always the single shared file — `app/models.py` (leaf mode) or `services/_scaffold_types.py` (module mode) — regardless of which `python-module` this data-model node is nested under in the graph. See §2's note on the current re-export gap.

**Minimum for a "complete" data-model node:** `model_kind` + the one matching required field above, non-empty.

---

## 6. `contract`

| Field | Required for | Output |
|---|---|---|
| `methods` | Validation only, today | A list of `{name, params: [{name, type}], returns}`. `validate_graph.py` checks every referenced type resolves to a primitive or an existing node (warning-level). **No Python code is generated from a contract's `methods` at all** — no ABC, no `Protocol`, nothing. A contract today is a validated specification, not a code-generation input. |

`implements` on the *implementing* `class` node (not on the contract itself) is what connects the two — also validation-only, not consumed by codegen (§0).

**Minimum:** `methods` with real entries, if you want the validator to actually check anything. Otherwise this node currently exists for documentation/architecture-diagram purposes only.

---

## 7. `class`

| Field | Required for | Output |
|---|---|---|
| *(none — `fields: []`)* | — | A `class` node's generated code is **byte-for-byte identical in shape to a `python-module`'s** — same flat, un-indented `def name(...):` functions, no `self` parameter, no `class Foo:` wrapper at all. `implements` (a top-level field, not an interface field) is validated (must point at a real `contract` node) but has **zero effect on the generated code's shape**. |

Its `python-function` children work exactly as described in §3 — same signature requirements, same wired-dependency behavior, same everything. The only things that make a `class` node different from a `python-module` today are: (a) its `allowedChildren` is restricted to `python-function` only, (b) it can hold `implements`, and (c) it is **not** eligible for `layout: folder` (rejected by `validate_graph.py`) — a class's methods are meant to stay together in one file, once real class-wrapper generation exists.

**Minimum:** same as a `python-module` with function children (§2/§3). `implements` is worth setting for documentation/validation value even though it doesn't change output yet.

---

## 8. Master table — "if you want X, you must fill in Y"

| You want... | Fill in... | On node type |
|---|---|---|
| Any leaf file at all under `--granularity leaf` | `signature` (real, parseable) | `python-function` |
| A wired dummy-call proving a function's dependency actually imports | `dependencies` listing the real dependency's id | `python-function` |
| A generated pytest file | `signature` + `tests` | `python-function` |
| A prompt OpenCode can act on | `signature` + `status: contract_defined`/`implementing` | `python-function` |
| A REST endpoint in `main.py` (either granularity) | `http_method` **and** `route`, both set | `python-function` |
| A real dataclass in the shared models file | `model_kind: dto`/`db_schema` + non-empty `model_fields` | `data-model` |
| A real `Enum` class | `model_kind: enum` + `enum_type` + non-empty `enum_values` | `data-model` |
| A real module-level constant | `model_kind: constant` + non-empty `constants` | `data-model` |
| A field/param typed as another node's shape | that node's **derived PascalCase name** (never its raw id) | any type-string field |
| A real Python package (folder) instead of one file | `layout: folder` | `python-module` only |
| The OpenCode prompt to include your written guidance | `notes` and/or `stub_behavior` | any node (but not echoed into `scaffold.py`'s leaf-mode stub file itself) |
| The validator to check a contract's method types | non-empty `methods` with real param/return types | `contract` |

---

## 9. Known gaps — filling the field won't produce the output you might expect, yet

- **`data-model` children of a `python-module`** don't get re-exported from that module's own generated file — they land in the shared types file only. (§2)
- **`contract.methods`** never becomes real Python code (no ABC/Protocol generation). (§6)
- **`class` nodes** don't generate a real `class Foo:` wrapper or `self`-bound methods — identical output to `python-module`. `implements` is validated but cosmetic today. (§7)
- **`context_include`** is round-tripped but not read by any prompt-building or generation logic despite being referenced in one internal comment. (§0)
- **`maps_to`** is validated (dangling-reference check) but not consumed by any code generator. (§0)
- **`notes`/`stub_behavior`** reach the OpenCode prompt and `module_scaffold.py`'s output, but are silently absent from `scaffold.py`'s own leaf-mode stub file content — only referenced generically there, not quoted.

---

## 10. Prompt composition placeholders (`prompt-generator.js`, September 2026)

Every token a `prompt_template` string (or the built-in `DEFAULT_TEMPLATE`/
`DEFAULT_SKELETON_TEMPLATE`) can use, substituted by `applyTemplate()` in a
single pass — `{unknown_token}` is left as-is rather than erroring, so a
typo silently prints literally rather than crashing.

**Self-contained labels.** Most of these values already include their own
`## Heading` or `Label:` text baked in when they have real content, and are
the empty string `""` — no heading at all — when the node has nothing
there. This was a deliberate cleanup pass ("check all empty labels used
for prompt composition") after the built-in templates were found printing
orphaned headings (`## Notes` with nothing under it, a bare `## Relationships`
when a node had no dependencies at all, etc.) for any node that simply
hadn't filled a field in yet — which, for a freshly-created node, is most
of them. `{relationships_header}` exists specifically to solve the one case
none of the other three could solve alone: it wraps `{dependencies}`/
`{calls}`/`{data_flows}`, which stay independently cherry-pickable (see
below), so none of the three individually knows whether either of the
*other* two has content — `{relationships_header}` is `"## Relationships"`
only when at least one of the three is non-empty, `""` otherwise.

`{relationships}` itself (a single merged placeholder) was **removed** —
cherry-pick `{dependencies}`/`{calls}`/`{data_flows}` individually instead,
for finer control over what a template actually prints.

**Standing rule: derived values are computed fresh on every call, never
stored on a node.** A `path` field briefly existed as a cached, persisted
value and was deliberately reverted: a stored derived value goes stale the
moment anything it depends on changes elsewhere (reparenting, a project
rename, a hand-edit to `graph.yaml` outside this app) with nothing in the
file to distinguish "correct" from "stale." Every placeholder below —
including `{path}` — is recomputed from the live graph state every time a
prompt is generated, with nothing written back onto the node.

| Placeholder | Source | Notes |
|---|---|---|
| `{id}` | node id | |
| `{title}` | `node.title` | blank if unset |
| `{status}` | `node.status` | |
| `{version}` | `node.contract_version` | defaults `"0.0.0"` |
| `{protocol}` | `node.interface.protocol` | |
| `{language}` | `GraphModel.resolveLanguage(...)` | ancestor-walk to the nearest declared `interface.language`, falling back to `graph.default_language` — same resolution `checkCrossLanguageBoundary`/`validate_graph.py`'s `resolve_language` already use, not reinvented for this |
| `{action}` | `actionForStatus(status)` | `"CREATE"` (status=`stub`), `"UPDATE"` (status=`implementing`), or blank |
| `{guardrail}` | `buildGuardrail()` | full sentence: action + version + scope restriction combined |
| `{scope_note}` | `buildScopeNote()` | terser sibling to `{guardrail}` — just the "touch only this file" line, no version/status preamble. Use one or the other, not both |
| `{signature}` | `function` nodes only | blank for every other protocol; not wrapped by any built-in template heading, so no orphan-header risk either way |
| `{interface}` | `renderInterfaceBlock()` | self-contained (`## Interface\n...` or `""`) — protocol-dependent block, see breakdown below |
| `{children}` | `renderChildFunctionSignatures()` | self-contained (`## Function stubs to declare (bodies deferred)\n...` or `""`) — function-child signatures; only non-blank for `class`/skeleton-eligible `module` nodes |
| `{preconditions}` | `node.interface.preconditions`, one per line | **Function-only field.** Raw joined lines — unlike most of this table, **not** self-contained: no heading is folded into the value, so a custom `prompt_template` that puts its own `## Preconditions`-style heading in front of `{preconditions}` will still print that heading even when the node has zero preconditions set. This is deliberate scope, not an oversight — the built-in `DEFAULT_TEMPLATE`/`DEFAULT_SKELETON_TEMPLATE` never wrap it with a static heading in the first place (it only ever appears pre-formatted as `Precondition: ...` lines inside `{interface}`, which *is* self-contained), so the orphan-heading risk only exists if you build a custom template that adds one yourself. |
| `{postconditions}` | `node.interface.postconditions`, one per line | Same shape and same caveat as `{preconditions}` — function-only, raw lines, not self-contained, already covered (as `Postcondition: ...`) inside `{interface}`. |
| `{errors}` | `node.interface.errors` as `code: description`, one per line | Function-only field, same caveat as the two above (raw, not self-contained; already covered inside `{interface}` as `Error code: description`). **Double-print risk:** if a custom template uses both `{interface}` and `{errors}` (or `{preconditions}`/`{postconditions}`) individually, the same information prints twice — the same cherry-pick-vs-combined tradeoff `{dependencies}`/`{calls}`/`{data_flows}` have against `{interface}`... except those three are cherry-picked *instead of* a combined placeholder (`{relationships}` was removed), whereas `{preconditions}`/`{postconditions}`/`{errors}` are cherry-picked *in addition to* `{interface}` (there was never a removed combined version of these three) — pick one presentation or the other in a custom template, not both. |
| `{dependencies}` | `GraphModel.depIds(node)`, resolved to each target's **full relative path** via `GraphModel.buildPath` | Self-contained: `"Depends on: <path>, <path>, ..."` when non-empty, `""` otherwise. Deliberately shows **paths, not bare node ids** — lets a reader (or a downstream tool) go straight from "depends on" to the actual file. This path substitution is scoped to `dependencies` only; `{calls}`/`{data_flows}` below still reference node ids. |
| `{calls}` | `node.calls` as `target.operation_name()`, one per line, **node ids** (not paths) | Self-contained: `"Calls:\n<lines>"` when non-empty, `""` otherwise. |
| `{data_flows}` | `node.data_flows` as `(direction) data_model <-> target`, one per line, **node ids** (not paths) | Self-contained: `"Data flows:\n<lines>"` when non-empty, `""` otherwise. |
| `{relationships_header}` | derived from whether any of `{dependencies}`/`{calls}`/`{data_flows}` is non-empty | `"## Relationships"` if at least one of the three has content, `""` if all three are empty — see "Self-contained labels" above for why this exists as its own placeholder rather than being folded into one of the three. |
| `{notes}` | `node.notes` | Self-contained (`## Notes\n...` or `""`). |
| `{stub_behavior}` | `node.stub_behavior` | Self-contained (`## Stub behavior\n...` or `""`). Available on `function`/`data-model`/`browser-js` nodes, and on a `module` **only when its effective layout is `file`** (see §0/§2's layout discussion) — a `layout: folder` module has no single file for "its" behavior to describe. |
| `{path}` | `GraphModel.buildPath(nodeId, normalized, registry)` | `{project}/<parent-chain by id, root to leaf, excluding the backbone>/{node_id}{extension}` — **computed fresh every call, never stored** (see the standing rule above). Deliberately does NOT mirror `module_scaffold.py`'s real on-disk convention of collapsing a whole non-folder-layout subtree into one shared file (see `python-toolchain-README.md` Pass 5) — every node still gets its own path unconditionally, **except**: a `function` node's path is always its parent's path, never a nested segment of its own, because a function is never its own file — it's code inside whatever module/class contains it. This is more than just the common case: `validate_graph.py`/`validate-graph.js`'s layout check (3g) already requires every direct child of a `layout: file` module to be a function, so `function` is the *only* protocol that can ever sit directly inside one — no other node type needs the same treatment. Extension comes from `{language}` via a small `LANGUAGE_EXTENSIONS` table (`python`→`.py`, `javascript`→`.js`, `typescript`→`.ts`; unrecognized/unset language → no extension, deliberately, rather than a guessed wrong one). Lives in `graph-model.js` (not `prompt-generator.js`, where it was first written) since it's a structural graph fact, same category as `resolveLanguage`/`inferredLayout`. |

**`{interface}`'s breakdown by protocol** (all via `renderInterfaceBlock`):

| Protocol | Lines produced |
|---|---|
| `function` | `Signature: ...`, `HTTP: ...` (if both `http_method`+`route` set), one `Precondition:`/`Postcondition:`/`Error code: ` line each |
| `data-model` | `model_kind: <label>` (see label table below) + one `Field name: type` / `Enum member name = value` / `Constant name: type = value` line each |
| `browser-js` | one `Export kind name: signature` line each |
| `contract` | one `Method name(params) -> returns` line each |
| `class` | one `Instance field self.name: type` line each, + `Implements contract(s): ...` if any |

**`model_kind` display labels** (cosmetic only — `GraphModel.MODEL_KIND_VALUES`
remains the actual validated enum; this table doesn't add or check values,
just how the raw string prints in `{interface}`):

| Raw `model_kind` | Printed as |
|---|---|
| `dto` | `Data Transfer Object(DTO)` |
| `db_schema` | `Database Schema` |
| `enum` | `Enum` |
| `constant` | `Constant group` |

**`model_fields` accepts JSON Schema as an alternate input, converted
once on Save.** The `f-model-fields` textarea in the edit form
normally expects our own array shape (`[{name, type, required?, notes?}]`),
but will also accept a full JSON Schema object
(`{properties: {...}, required: [...]}`, draft-07 style) — detected
by `GraphModel.looksLikeJsonSchema()` (unambiguous: our shape is
always an array, a JSON Schema is always a non-array object with a
`properties` key) and converted by `GraphModel.convertJsonSchemaToModelFields()`.
This is a **one-time, one-way conversion at Save time**, not a second
persisted format — once saved, the node holds our normal array shape
and nothing remembers it was ever pasted as JSON Schema; pasting JSON
Schema again later just converts again the same way. Nothing
downstream (the validator, `renderInterfaceBlock`, the edit form's own
re-render) ever needs to know the JSON Schema shape existed.

Per-property mapping:

| JSON Schema | Our `model_fields` shape |
|---|---|
| `"type": "string"` / `"boolean"` / `"integer"` | same name directly |
| `"type": "number"` | `float` |
| `"type": "string", "format": "uuid"` | `uuid` |
| `"type": "string", "format": "date-time"` | `datetime` |
| `"type": "array", "items": {...}` | `{type: "list", items: <mapped item type>}` (recurses) |
| `"type": ["X", "null"]` (nullable union) | `{type: "optional", of: <mapped X>}` — independent of `required`, since presence and nullability are different axes JSON Schema conflates and we don't |
| top-level `required: [...]` | that field's `required: true`; everything else `false` |
| property `description` | that field's `notes` |
| no `"type"` at all (e.g. an `enum`-only property) | falls back to `string` |

Genuinely lossy — no field in our shape for these, so each is folded
into that field's `notes` as a short parenthetical instead of being
silently dropped: `enum` → `(allowed: A, B, C)`; `pattern` →
`(pattern: ...)`; `minLength`/`maxLength` → `(length: N-M)`; `default`
→ `(default: ...)`; `readOnly` → `(read-only)`. Schema-level (not
per-property) `title`/`description` have no home in an array of field
objects either: `title` backfills the node's own `title` **only if
left empty** in the same Save (an intentional edit always wins), and
`description` **prepends** to the node's own `notes` rather than
overwriting anything already there. `$schema`/`$id`/`additionalProperties`
are dropped entirely — no reasonable home for them anywhere in this
schema, so this is a deliberate omission, not an oversight.

---

## 11. `prompt.json`'s shape — `{ project, structure, tree, prompts }`

`GraphPromptGen.generatePromptManifest()` (wired to the "Generate prompts.json"
header button) does not return a bare array — it returns an object with four
keys, built specifically so the file can bootstrap a project from scratch,
not just describe today's next steps:

- **`structure`** — every node with a determinable file (`nodeKind()` is
  non-null: `function`/`browser-js`/`data-model`, or a skeleton-eligible
  `contract`/`class`/`layout: file` `module`), **regardless of current
  status**. Each entry is `{node_id, path, kind}`. This is the intended
  FINAL layout — a node at `status: implemented` still appears here even
  though it won't appear in `prompts` below.
- **`tree`** — the same data as `structure`, rendered as an ASCII directory
  tree (like the `tree` command) for a human or an LLM to read the shape of
  the project at a glance. **Deduplicated by path** — since a `function`
  node's path now equals its parent's (§10's `{path}` row), the same file
  can legitimately appear in `structure` under two different `node_id`s
  (the module's skeleton entry and the function's implementation entry);
  the tree collapses those to one visual leaf so it doesn't look like a
  rendering bug.
- **`prompts`** — the original per-node array: one entry per node at
  `status: stub`/`implementing` (see `isPromptable`), each
  `{node_id, kind, status, version, action, prompt}`. A node's saved
  `prompt` field is used verbatim here if non-empty, rather than
  recomputed, so a reviewed/edited prompt isn't silently overwritten by a
  later "Generate prompts.json" click.
- **`project`** — the graph's project name, included so a consumer doesn't
  need to separately track which graph a given `prompts.json` came from.

The "Generate prompts.json" button only refuses to write the file when
**both** `structure` and `prompts` are empty (nothing in the graph has a
determinable file at all) — a graph with real structure but zero nodes at
`stub`/`implementing` yet still produces a useful file (the target layout,
with an empty `prompts` array), rather than being blocked entirely.
