# Python toolchain — data-model / contract / class / REST-routing / Revision 3

Five stages over this toolchain, in order:

1. **Data-model (DTO / DB schema) support** — brings the Python side
   in line with the `data-model` protocol in `graph_editor.html`
   (schema-level design: that project's own README §6).
2. **Contract/class/enum/constant support** — brings the Python side
   in line with the `contract`/`class` protocols and the `enum`/
   `constant` `model_kind` values added on top of that (schema-level
   design: that project's own README §6-7).
3. **Verified against the real files** — Passes 1-2 were built and
   verified without `typedsl.py`, `generate_project.py`, or the real
   example graph, since they weren't uploaded yet. This pass started
   once they were, plus a real reported crash and a real report of
   missing generator output — every item in it was reproduced against
   the real files before being fixed, and re-verified against the
   same real files afterward.
4. **Revision 3** — a genuine schema redesign, not another bug-fix
   pass: generic protocol names (no more
   `python-module`/`python-function`/`rest`), a fully-structured type
   system (no more free-text signature strings for `typedsl.py` to
   parse), and "one node, one file" as the organizing generation
   principle. See its own section below for the full accepted-proposal
   rationale and everything it actually took to make real.
5. **September 2026 pivot** (this update) — a change in *direction*,
   not another schema layer: `graph.yaml` is being enriched enough
   that a small LLM can act on it directly (prompt generation, and
   eventually scaffolding) without this Python toolchain running
   first. The actual composition/validation/UI work for that now
   lives in the `graph_editor` project (see that project's own README
   §11) — this stage's Python-side footprint is much smaller than
   Revision 3's: new `Node` fields so nothing silently vanishes on
   load/save, and two new validator checks. See its own section below.

No stage here was a mechanical find-and-replace. Making these node
kinds actually work end-to-end in this toolchain surfaced real,
concrete bugs each time — some pre-existing, some that would have
appeared the moment anyone actually used the new node kind for real.
Every fix is reproduced and verified against a real graph (the shipped
50-node example, an isolated minimal graph, or — from Pass 3 onward —
the actual `kharcha-tracker-v2.yaml` and actual `typedsl.py`) before
being called done — see each stage's own notes on what was actually
executed vs. reasoned through.

---

## Pass 1: data-model (DTO / DB schema) support

### What was actually broken, and the fix

#### 1. Silent data loss: `graph_runner.py` dropped `maps_to` on every save

`Node` had no `maps_to` field at all. Any Python-side load→save cycle
(which `opencode_bridge.py` does after nearly every action) would
silently **delete every `maps_to` mapping** from the yaml on write —
not an error, not a warning, just gone.

**Fix:** added `maps_to` to `Node` (plus a `maps_to_ids` property,
mirroring `dep_ids`), and to both `Graph.load()` and `Graph.save()`.
Verified with a real load→save→reload round-trip.

#### 2. A real deadlock: data-model nodes could never reach `integrated`

`rederive_status()` caps any node with no `tests` at `IMPLEMENTED`
forever — correct for a real function (can't claim `TESTED` with
nothing to test against), but a data-model node **never has tests of
its own** by design. That meant `user_record` could never progress
past `IMPLEMENTED`, which meant `deps_ready()` could never return
`True` for anything depending on it — confirmed directly:
`get_current_user` (which depends on `user_record`) would have been
**permanently blocked from ever integrating**, for a reason that has
nothing to do with its own real work.

**Fix:** `graph_runner.py` gained `NON_EXECUTABLE_PROTOCOLS = {"data-model"}`
and a small `_is_non_executable()` check. `rederive_status()` now
promotes a non-executable node straight from `contract_defined` to
`integrated` — there's no meaningful implementing/testing phase for a
pure data shape. `graph_runner.py` is otherwise deliberately
protocol-agnostic (it reads `interface.protocol` nowhere else); this
is one small, explicit, named exception, not a general opening.

Verified: isolated test proving `rederive_status` promotes correctly,
plus a full `run_auto()` orchestration test (see #3) proving the fix
holds through the real public API, not just the internal function.

#### 3. `next_action()` would have told OpenCode to "implement" a DTO

Even before a `resync` ever runs, `next_action()`'s per-node scan
would hit a `contract_defined` data-model node and return
`Action(..., "implement", ...)` — exactly what `opencode_bridge.py`'s
`run_auto()` interprets as "call OpenCode." A local LLM call spent on
"implementing" a fixed field list is at best wasted, and the resulting
prompt has no file-output convention wired up for it at all.

**Fix:** a new `Action` kind, `"resync"` — returned instead of
`"implement"` for a `contract_defined` non-executable node, with an
honest reason ("needs no implementation, run resync"). `opencode_bridge.py`'s
existing `if action.kind != "implement": continue` already handles any
unrecognized-as-implement kind correctly with zero changes needed
there beyond a clarifying comment.

**Verified live**, not just unit-tested: built a minimal graph whose
only remaining work is one `contract_defined` data-model node, ran it
through the real `run_auto()` with a spy `opencode_runner` that raises
if ever called — confirmed **0 OpenCode calls**, and the node correctly
`integrated` on disk afterward.

#### 4. `validate_graph.py` had an incomplete edit already sitting in it

Found on inspection, not introduced by this pass: `PROTOCOL_REGISTRY`'s
`rest` and `python-module` entries already listed `"data-model"` in
their `allowed_children` sets, but **there was no `"data-model"` entry
in the registry at all**. Every data-model node was silently falling
into check 5's "unknown protocol, skipping checks" branch — confirmed
by running the validator before this fix: it emitted a warning for
both `user_record` and `user_db_row` in the real graph.

**Fix:** added the missing entry
(`{"allowed_children": set(), "required_fields": ["model_kind", "model_fields"], "language": None}`).
Verified: the validator now reports **0 errors, 0 warnings** on the
real graph (previously 2 warnings).

#### 5. Same cross-language false-positive bug as the JS side, mirrored here

Check 8 (cross-language boundary) compared `n_rule["language"] != dep_rule["language"]`
directly. Since `data-model`'s language is `None`, a `python-function`
depending on a `data-model` node (`"python" != None`) would trip a
false "cross-language edge without boundary=service" error — the
identical bug already fixed in `graph-model.js`'s
`checkCrossLanguageBoundary`.

**Fix:** skip the check when either side's language is `None`.
Verified with an isolated graph exercising exactly this dependency
shape — confirmed zero errors.

#### 6. New checks: dangling `maps_to`, and `model_kind` enum validation

Two checks that didn't exist because the concepts didn't exist yet:

- **Dangling `maps_to` references** — mirrors check 3's existing
  dangling-`dependencies` check, for the same category of error
  (a typo'd or deleted target). Deliberately broke a test graph
  (`maps_to` pointing at a nonexistent node) and confirmed it's caught.
- **`model_kind` must be `dto` or `db_schema`** — mirrors
  `graph-model.js`'s `MODEL_KIND_ENUM`. Deliberately broke a test graph
  (`model_kind: not_a_real_kind`) and confirmed it's caught.

#### 7. The actual missing feature: data-model shapes never became real dataclasses

Even once the above was fixed, a data-model node's `model_fields`
still didn't produce anything a real function could import and use —
`generate_models_file()` only ever sourced dataclasses from a
function's own inline `interface.types`. A function whose signature
referenced `UserRecord` by name (exactly what promoting `user_record`
to its own node was *for* — see the graph project's own README, §6,
on "single source of truth instead of N hand-kept-in-sync copies")
would have hit `TypeDslError: Unrecognized type expression: 'UserRecord'`
the moment anyone tried to scaffold or test-generate against it.

**Fix:** `scaffold.py` gained three new functions:

- `data_model_type_name(node)` — derives a PascalCase class name from
  a node's id (`user_record` → `UserRecord`).
- `is_data_model(node)` — a small readability helper.
- `collect_data_model_types(graph)` — converts every data-model node's
  `model_fields` into the exact same `"{ field: type, ... }"`
  shape-string format `interface.types` already uses, so it slots into
  the *existing* `generate_models_file()`/`typedsl.py` pipeline with
  no separate code path. Handles two real cases the actual example
  graph already exercises:
    - **Inline `# comment`s** (e.g. `"str  # unique index"`, a real
      convention already used in the shipped example graph) — stripped
      before parsing, since they're documentation, not DSL syntax.
    - **A field type `typedsl.py` genuinely can't parse** — degrades
      that *one field* to `str` with a warning, rather than failing
      the whole graph's generation. Same tiered-honesty approach
      `generate_pytest.py` already uses for `expect` keys it can't
      mechanically translate — an honest fallback beats a silent wrong
      guess, and a warning beats a crash.
    - **Two data-model nodes deriving the same type name** — first one
      wins, the rest are skipped with a warning (never silently
      overwritten), matching `load_full_registry`'s own established
      collision rule for custom protocols.

**Verified live, twice** (both real generator paths):
- `scaffold.py` against the real graph → confirmed `UserRecord`/`UserDbRow`
  dataclasses generated correctly in `app/models.py`, *and* confirmed
  `get_current_user`'s generated stub correctly imports and
  type-annotates against `UserRecord`.
- `module_scaffold.py` against the real graph → confirmed the same two
  dataclasses land in `services/_scaffold_types.py`, and
  `services/auth_service.py`'s generated `signup`/`get_current_user`
  stubs correctly import `UserRecord` from it.

#### 8. The same "known types" gap, repeated across 8 call sites in 5 more files

Once `collect_data_model_types()` existed, every place in the codebase
that builds a "known custom type names" set for `typedsl.py` had the
identical gap — each was found by grepping for the pattern, not
guessed at:

| File | Call site |
|---|---|
| `module_scaffold.py` | `known_types_for()`, `scaffold_modules()`'s `_scaffold_types.py` generation |
| `generate_pytest.py` | `_known_return_fields()` (Tier A field-name detection), CLI `__main__` |
| `generate_prompts.py` | `generate_all_prompts()` |
| `opencode_bridge.py` | `run_explicit_list()`, `run_auto()` |

Each now merges in `collect_data_model_types(graph)`'s output the same
way. `module_scaffold.py` needed one extra bit of care: `known_types_for()`
and `scaffold_modules()`'s later `_scaffold_types.py` step both needed
the same data — `known_types_for()` now accepts an optional
precomputed `dm_shapes` param so `scaffold_modules()` can compute it
**once** and pass it through, rather than calling
`collect_data_model_types()` twice and printing the same warnings
twice.

**Verified**: an isolated test directly proving `generate_pytest.py`'s
`_known_return_fields()` correctly resolves `UserRecord`'s fields
(`{id, email, name, avatar_url}`) for `get_current_user`'s return
type — the exact mechanism Tier A test-assertion generation depends on.

---

### Files changed (Pass 1)

| File | Changed | Why |
|---|---|---|
| `graph_runner.py` | Yes | `maps_to` field/round-trip (data-loss fix), `NON_EXECUTABLE_PROTOCOLS`, `rederive_status()`, `next_action()` |
| `validate_graph.py` | Yes | Missing `data-model` registry entry (pre-existing bug), cross-language `None` fix, dangling-`maps_to` check, `model_kind` enum check |
| `scaffold.py` | Yes | New `data_model_type_name()`, `is_data_model()`, `collect_data_model_types()`; merged into `scaffold()` |
| `module_scaffold.py` | Yes | Merged `collect_data_model_types()` into `known_types_for()` and `scaffold_modules()` |
| `generate_pytest.py` | Yes | Merged into `_known_return_fields()` and CLI |
| `generate_prompts.py` | Yes | Merged into `generate_all_prompts()` |
| `opencode_bridge.py` | Yes | Merged into `run_explicit_list()` and `run_auto()`; clarified the `run_auto()` loop comment for the new `"resync"` action kind |
| `exceptions_gen.py` | No | Only reads `tests[].expect_raises` — unaffected by node protocol |
| `frd_to_draft.py`, `frd_template_to_draft.py`, `frd_template.md` | No | Only ever *emit* `rest`/`python-module`/`python-function` nodes from FRD text — never consume or need to understand `data-model` |
| `typedsl.py` | No | Pure DSL parser, no protocol awareness — used correctly by the new code, not modified |
| `mock_test_runner.py`, `opencode_json.example` | No | Unrelated (demo test runner; OpenCode provider config) |
| `generate_project.py` | No | Thin CLI wrapper around `scaffold.py`/`module_scaffold.py` — inherits their fixes with no changes of its own needed |

### What wasn't done, and why (Pass 1)

**`frd_to_draft.py` / `frd_template_to_draft.py` were not taught to
*generate* `data-model` nodes.** These tools transcribe FRD/template
text into `unsplit` candidate nodes — they don't (and shouldn't)
decide when a shape deserves its own promoted data-model node versus
staying inline in a function's `interface.types`. That's the same
architectural-judgment line these tools already draw for everything
else they deliberately don't do (real signatures, real tests, MVP
scoping) — extending it to data-model promotion would be scope
creep on tools whose entire design point is staying mechanical.

**No new required top-level CLI flag or command was added anywhere.**
Every fix here is either a bug fix (data-model nodes now behave
correctly with the *existing* commands) or an internal helper — no
tool's command-line interface changed shape.

---

## Pass 2: contract/class/enum/constant support

`enum`/`constant` (new `model_kind` values, still `data-model` nodes)
and `contract`/`class` (two new protocols) round out the schema-level
work from Pass 1 — see the graph editor's own README §6-7. `contract`
is a fixed set of method signatures with no body (like `data-model`,
nothing to implement independently); `class` is a concrete
implementation, its real substance living in its `python-function`
children exactly the way a `python-module`'s does. `implements` is the
new relationship connecting the two — structurally identical to
`maps_to` (a fact, not a call), just for a different pair of node
kinds.

**A real constraint on this pass, stated up front:** `typedsl.py` and
`exceptions_gen.py` weren't uploaded this session, so `scaffold.py`,
`generate_pytest.py`, `generate_prompts.py`, and `opencode_bridge.py`
couldn't actually be *executed* (`from typedsl import ...` fails
immediately). `graph_runner.py` and `validate_graph.py` have no such
dependency and were fully executed and tested live. Where a fix
touched a typedsl-dependent file (`module_scaffold.py`), a documented,
throwaway stub of typedsl.py's interface was written *only* to enable
running the real code path once, then discarded — noted per-item
below. Anything that would have required guessing at typedsl.py's real
type-resolution semantics to verify honestly was left undone rather
than shipped unverified — see "What wasn't done" below.

### What was actually broken, and the fix

#### 1. Silent data loss, again: `graph_runner.py` dropped `implements` on every save

Identical bug to Pass 1's `maps_to` one, in the identical place:
`Node` had no `implements` field, so a load→save round-trip would
silently delete every `implements` relationship. **Fix:** added
`implements` (plus an `implements_ids` property, mirroring
`maps_to_ids`) to `Node`, `Graph.load()`, and `Graph.save()`. Verified
with a real load→save→reload round-trip — confirmed lost before the
fix, preserved after.

#### 2. The same deadlock, for `contract` nodes

`contract` nodes have no tests of their own either (they're a fixed
signature list, not a body), so without accounting for them
`rederive_status()` would cap a `contract` node at `IMPLEMENTED`
forever, permanently blocking `deps_ready()` for anything depending on
it — the exact same failure mode Pass 1 fixed for `data-model`.
**Fix:** added `"contract"` to `NON_EXECUTABLE_PROTOCOLS` (`class` is
deliberately *not* added — like `python-module`, its substance is in
its children, so it gets no special-casing). Verified live: a minimal
graph with a `contract_defined` `contract` node depended on by a
`python-function` leaf — `resync_graph()` promotes the contract
straight to `integrated`, unblocking its dependent, confirmed via
`resync_graph`'s real return value, not just inspection.

#### 3. `next_action()` would have told OpenCode to "implement" a contract

Same mechanism as Pass 1's DTO bug — a `contract_defined` `contract`
node would have produced an `Action(..., "implement", ...)`. Since
`contract` is now in `NON_EXECUTABLE_PROTOCOLS`, `next_action()`'s
existing (Pass-1-added) `_is_non_executable()` branch already returns
`"resync"` correctly with no further code change needed — verified
directly: a single-node graph whose only node is a `contract_defined`
contract produces `action.kind == "resync"`.

#### 4. `validate_graph.py`: no registry entries for the two new protocols

Same shape as Pass 1's bug #4 — `contract`/`class` were referenced
nowhere in `PROTOCOL_REGISTRY`, so every such node would have silently
fallen into check 5's "unknown protocol" branch. **Fix:** added both,
with `required_fields: ["methods"]` for `contract` and
`allowed_children: {"python-function"}` for `class`. `language: None`
on both, mirroring `data-model` and the graph editor's own registry —
neither makes a language claim; a class's real language lives on its
function children, per the "language is a property of a subtree, not
a node" principle.

#### 5. A subtler version of the required-fields bug: `MODEL_KIND_REQUIRED_FIELDS`

Extending `MODEL_KIND_ENUM` to include `enum`/`constant` surfaced a
sharper problem than a missing set member: the *existing*
`data-model` registry entry's flat `required_fields: ["model_kind",
"model_fields"]` would have produced a false "missing model_fields"
warning on **every single enum/constant node**, since neither kind
has a `model_fields` field at all (they have `enum_values`/`constants`
instead) — confirmed by running the old check against a valid enum
node before fixing it. **Fix:** `required_fields` on the `data-model`
registry entry is now just `["model_kind"]`; a new
`MODEL_KIND_REQUIRED_FIELDS` dict (`dto`/`db_schema` →
`model_fields`, `enum` → `enum_type`+`enum_values`, `constant` →
`constants`) is checked separately, keyed off the node's actual
`model_kind`. Verified: a `status: contract_defined` enum node with no
`enum_values` now correctly warns about the *right* missing field;
a complete one produces zero warnings.

#### 6. Missing checks: dangling `implements`, wrong-protocol `implements`, unresolved method types, duplicate enum/constant names

Four new checks, each deliberately broken against a test graph and
confirmed caught before being called done:
- `implements` pointing at a nonexistent node id.
- `implements` pointing at a real node whose protocol isn't
  `"contract"` (mirrors `graph-model.js`'s `addImplements`, which
  enforces this at authoring time — this is what catches a
  hand-edited graph that bypassed the editor).
- A `contract` method's param/return type that resolves to neither a
  known primitive nor an existing node id (warning-level — this file
  has no real type-expression parser, unlike `typedsl.py`, so it only
  checks the bare name and heuristically unwraps `list[x]`-style
  wrappers rather than fully parsing them).
- Duplicate `name`s within one node's `enum_values` or `constants`.

#### 7. Found *by* the new checks, not introduced by them: `python-module` could never actually contain a `contract` or `class`

Running the new registry entries against a real nested graph
surfaced that `python-module`'s `allowed_children` — in
`validate_graph.py` **and** in `graph-model.js` **and** in
`protocol-registry.json` — never included `"contract"`/`"class"` at
all. The schema literally couldn't nest either new protocol inside a
module, which is the one place they're actually meant to live. **Fix:**
added both to all three registries. Verified: the same nested test
graph that first surfaced the error now validates with 0 errors.

#### 8. Found the same way, one level deeper: the real example graph had `class` nodes parented under a `contract`

Re-running the fixed validator against the actual
`kharcha-tracker-3_2-data-models.yaml` (not a synthetic test graph)
caught a structural bug in an *earlier* edit to that file: `flat_file`/
`sql_lite`/`postgres` were parented under `storage_interface`, a
`contract` node — invalid, since `contract`'s `allowed_children` is
correctly empty (a contract is a spec, not a container). **Fix:**
reparented all three to `storage_service` (their actual containing
module, and `storage_interface`'s own parent — making them siblings of
the contract they implement, not its children), and corrected the
`dependencies` lists on both `storage_service` (now must list all
three as children, per check 4) and `storage_interface` (no longer
lists them at all — the relationship is `class implements contract`,
not the reverse, so a contract depending on its implementers never
made sense). Verified: the real file now validates with exactly one
error, and that one is pre-existing — see the next item.

#### 9. Found on inspection, not introduced by this pass: `auth_service` has 5 children missing from its own `dependencies`

The real file's `auth_service` node has five children
(`signup`/`login`/`request_password_reset`/`confirm_password_reset`/
`get_current_user`) but an empty `dependencies` list — violating check
4's established rule, confirmed present in the *original* uploaded
file before any edit this session touched it. Left unfixed — silently
"fixing" a graph's actual content wasn't asked for and isn't this
pass's job; flagged here so it isn't mistaken for something this pass
introduced.

#### 10. `module_scaffold.py`: `class` nodes were invisible to the coarse scaffolder

`module_nodes` was filtered to `protocol == "python-module"` only, so
a `class` node — whose function children work through the *exact
same* `parent`-based rendering path `python-module` already uses —
would silently generate no file at all. **Fix:** the filter now
matches `("python-module", "class")`. `contract` is deliberately not
included — a contract's `methods` are structural signatures, not
function bodies to stub; see "What wasn't done" for why generating a
real ABC/Protocol from them wasn't attempted.

**Verified live**, using a documented, throwaway stub of `typedsl.py`'s
interface (written only to make this one execution possible in a
session where the real file wasn't uploaded — not part of the
deliverable): built a minimal graph with a `contract` + implementing
`class` + one `python-function` child, ran the real
`scaffold_modules()`, and confirmed a correct `services/flat_file.py`
was generated with the right function stub inside it — not just that
the filter change looked right statically.

### Files changed (Pass 2)

| File | Changed | Why |
|---|---|---|
| `graph_runner.py` | Yes | `implements` field/round-trip (data-loss fix), `NON_EXECUTABLE_PROTOCOLS += "contract"` |
| `validate_graph.py` | Yes | `contract`/`class` registry entries, `MODEL_KIND_REQUIRED_FIELDS`, dangling/wrong-protocol `implements` checks, method type-reference check, enum/constant name-uniqueness checks |
| `module_scaffold.py` | Yes | `class` added to the `module_nodes` filter |
| `graph-model.js`, `protocol-registry.json` (graph editor project) | Yes | `python-module.allowedChildren` was missing `contract`/`class` — bug #7 above |
| `kharcha-tracker-3_2-data-models.yaml` (graph editor project) | Yes | Reparented `flat_file`/`sql_lite`/`postgres` off `storage_interface` — bug #8 above |
| `scaffold.py`, `generate_pytest.py`, `generate_prompts.py`, `opencode_bridge.py` | No | Confirmed protocol-agnostic already (signature/parent-based) — no `contract`/`class`-specific logic needed for structural support; enum/constant *codegen* is the one real gap, see below |
| `exceptions_gen.py`, `frd_to_draft.py`, `frd_template_to_draft.py`, `frd_template.md`, `typedsl.py`, `mock_test_runner.py`, `opencode_json.example`, `generate_project.py` | No | Same reasoning as Pass 1's table — unaffected by node protocol either way |

### What wasn't done, and why (Pass 2)

**`scaffold.py` was not extended to generate real Python `Enum`
classes or module-level constants from `enum`/`constant` nodes.**
~~This is the one genuinely missing feature-level gap left by this
pass~~ **— done in Pass 3, once the real `typedsl.py` was uploaded and
this could actually be verified by execution instead of guessed at.**
An `enum`/`constant` node's contract is fully validated and
round-trips correctly, but nothing yet turns it into code a generated
stub could import. Doing this properly means going through
`typedsl.py`'s exact type-resolution machinery (what `annotation` and
`dummy_expr` a *non-dataclass* custom type like an `Enum` member
should get, whether `known_types` handles a type name backed by
something other than a dataclass at all) — and `typedsl.py` wasn't
uploaded this session. Guessing at that API closely enough to emit
code that would actually run, with no way to execute and confirm it,
risks exactly the "looks done, silently broken" failure mode this
project's whole design exists to prevent. If `typedsl.py` gets
uploaded, this is the next concrete piece of work, along with wiring
the resulting type/constant names into the ~8 `known_types`-merging
call sites Pass 1's item 8 already catalogued (the same gap would
repeat there for enums the same way it did for data-model DTOs).

**`contract` nodes were not turned into real Python ABCs/Protocols.**
A contract's `interface.methods` list is validated (§6 above) but
never rendered into code — no built-in Python tool in this project
currently generates an interface/abstract-base-class file from a
method-signature list at all, so this isn't a small extension of an
existing path the way the `class`-in-`module_scaffold.py` fix was;
it's new generation logic, and for the same `typedsl.py`-unavailable
reason above, wasn't attempted without a way to verify the output
actually imports and type-checks.

**`generate_pytest.py`, `generate_prompts.py`, `opencode_bridge.py`
needed no changes.** All three build their "known custom types" set
and pick leaf nodes via `is_leaf_with_signature()`/`interface.get("types")`
merges that are already protocol-agnostic — a `class` node's
`python-function` children are indistinguishable from a
`python-module`'s to this logic, so they're picked up correctly with
no code change. Confirmed by grep, not just inference: `scaffold.py`'s
`is_data_model()` is the *only* place in these four files (plus
`scaffold.py` itself) that branches on a literal protocol string at
all.

**No new required top-level CLI flag or command was added anywhere,**
same as Pass 1 — every change here is a bug fix or an internal filter/
registry addition.

---

## Pass 3: verified against the real files, real graph, and a real crash report

Passes 1 and 2 built and verified everything they could without
`typedsl.py`, `generate_project.py`, `exceptions_gen.py`, or the real
`examples/kharcha-tracker-v2.yaml` — those weren't uploaded yet. This
pass started when all four were, plus a real reported crash
(`TypeDslError: Unrecognized type expression`) and, later, a real
report that `generate_project.py`'s `main.py`/`services/` output
wasn't showing up as expected. Nothing here was reasoned about in the
abstract — every item below was reproduced against the real files
first, then fixed, then re-verified against the same real files.

### What was actually broken, and the fix

#### 1. The reported crash's real mechanism: enum/constant type names never entered `known`

Traced mechanically, not guessed: `scaffold()`'s driver builds
`known = set(all_types.keys())`, and `all_types` only ever gets
populated from `collect_data_model_types()` — which filters to nodes
with `model_fields`. `enum`/`constant` nodes have `enum_values`/
`constants` instead, so their derived type names (e.g.
`ExpenseStatus`) never entered `known` anywhere in this file, in
`module_scaffold.py`, or in `generate_pytest.py`/`generate_prompts.py`/
`opencode_bridge.py`'s own known-types merges. `collect_data_model_types`
degrades a bad DTO *field* gracefully to `str` with a warning, but
`generate_stub_file()` calls `parse_signature()` on a *function
signature* with no try/except at all — a signature referencing an
enum type crashes there, uncaught. This is almost certainly what
produced the reported crash.

**Fix:** two new functions in `scaffold.py`:
- `collect_enum_types(graph)` — every `model_kind: enum` node, derived
  into `{type_name: {enum_type, members}}`, same collision rule
  (first wins, warn) as `collect_data_model_types`.
- `collect_constant_declarations(graph)` — every `model_kind: constant`
  node's `constants`, flattened into one list. Constants are VALUES,
  never referenced as a TYPE in a signature — so, unlike enum names,
  they do NOT get unioned into `known` anywhere.

`generate_models_file()` now accepts optional `enum_defs`/`constants`
params (default empty, so every existing call site keeps working
unchanged) and emits real `class X(Enum):` blocks — each with its own
`dummy_X()` factory returning its first member, matching the exact
convention the dataclass loop already uses — plus plain module-level
constant assignments. Enum names are unioned into `known` at every
call site: `scaffold()`'s own driver, `module_scaffold.py`'s
`known_types_for()`/`scaffold_modules()`, `generate_pytest.py`,
`generate_prompts.py`, and both `opencode_bridge.py` sites — the exact
same ~8-call-site pattern Pass 1's item 8 already catalogued for
data-model DTOs, now repeated for enums as predicted there.

**A bug in this very fix, found by actually running it:** the
topological sort in `generate_models_file()` visits a dataclass
field's `referenced_types` to order definitions — but an enum-typed
field's referenced name isn't a key in `shapes` (enums aren't
dataclasses), so `shapes[name]` crashed on the very first real test.
Fixed by making `visit()` skip any referenced name that isn't
actually in `shapes` — it doesn't need ordering; its class block is
emitted separately.

**Verified live, with the REAL `typedsl.py`** (not the throwaway stub
used before it was uploaded): generated `models.py` from the real
`kharcha-tracker-v2.yaml`, imported it, called `dummy_Expense()` —
confirmed `.status`/`.expn_ctgry` are real `ExpenseStatus`/
`ExpenseCategory` enum instances, not placeholders.

#### 2. A separate, pre-existing mistake found while fixing #1: raw node ids used as field types

Three fields in the real graph (`expense.status`, `expense.expn_ctgry`,
`group.status`) used the raw snake_case node id (`'expense_status'`)
as their field type instead of the derived PascalCase name
(`'ExpenseStatus'`) `typedsl.py` actually needs. This predates the
enum work — it silently degraded to `str` for a DTO field, but hits
the exact same uncaught crash as #1 if the same mistake appears in a
function signature. **Fix:** corrected all three in the real
`kharcha-tracker-v2.yaml`, and added a new `validate_graph.py` check
(3e) that flags this mistake class generically — confirmed it catches
the exact three fields when pointed at the real graph, before they
were fixed.

#### 3. A much bigger, separate gap: `typedsl.py`'s primitive vocabulary didn't match the graph's

Found while tracing #1 further: `typedsl.py`'s real `PRIMITIVES` dict
only recognizes `str`/`int`/`float`/`bool`/`Decimal`/`None`/`dict`/
`list` — but the real graph uses `string`/`UUID`/`timestamp`/`number`
as type names throughout (confirmed by count: 14× `string`, 8× `UUID`,
7× `timestamp`, 1× `number` — 30 field occurrences, not a one-off).
Every one silently degraded to `str`, quietly losing real type
information across most of the schema's id/timestamp/string fields —
never a crash, but a much larger practical problem than #2. Per
`typedsl.py`'s own docstring ("Extend it if a future graph uses
something outside that vocabulary"), this is exactly the case for
extending it, not fixing the graph.

**Fix (after explicit sign-off on the exact mappings):** `string`→`str`
(alias), `number`→`float`, `UUID`→`str` (alias, no new import), and
`timestamp`→real `datetime.datetime`. The `datetime` case needed real
plumbing, not just a dict entry: `generate_models_file()` now
unconditionally imports `datetime` (mirroring `Decimal`'s existing
unconditional import), and `generate_stub_file()`/
`generate_wiring_test_file()` each gained a `needs_datetime` check
mirroring their existing `needs_decimal` check exactly, so a leaf
stub only imports `datetime` when it actually uses it.

**Verified live, with the REAL `typedsl.py`:** `dummy_UserRecord().created_at`
is a real `datetime.datetime(1970, 1, 1, 0, 0)`, confirmed by
executing the generated module, not just reading its source.

#### 4. `--granularity leaf` correctly refused to run — for a real, separate reason

Not a bug: `generate_project.py`'s `ValueError: 0 leaf nodes found`
is its own deliberate loud-fail, working as designed. Confirmed
directly: all 13 `python-function` nodes in the real graph had
`signature: null` — none had been given a real contract yet. Nothing
to fix in code here; the graph itself needed real signatures.

**What was done:** drafted all 13, explicitly marked `PROPOSED` in
each node's `notes` (all had empty `title`/`notes`/`stub_behavior` —
there was no real spec to derive from). The 8 storage functions
mirror `storage_interface`'s already-defined contract methods
one-to-one; the 5 auth functions are inferred from the node id alone
plus `get_current_user`'s one existing dependency on `user`. Flagged
in `login`'s own note: it currently returns a bare `str` token, which
can never satisfy `generate_pytest.py`'s `token_present` Tier B
convention (`getattr(result, 'token', None)` on a plain string is
always `None`) — a `LoginResult` DTO would fix that but wasn't added
without being asked.

**Verified live:** `validate_graph.py` → 0/0. `generate_project.py
--granularity leaf --mode wired` → succeeds, 13 leaf files, 3 service
packages. Executed the generated stubs directly (`get_current_user("x")`
returns a real `User`, `flat_file_save(dummy_BaseRecord())` returns a
real `BaseRecord`). Ran the generated `tests/test_wiring.py` — 0 tests
collected, correctly: none of the 13 currently call each other.

#### 5. `generate_main_file()` was reading from a hardcoded table, not the graph

Reported as "the REST entry point isn't created" — it *was* being
created, but `generate_main_file()` looped over a literal `ROUTE_MAP`
constant: 9 hand-written `(method, path, node_id)` tuples from one
specific historical graph, silently `continue`-ing past any `node_id`
not in that list, no warning. Confirmed directly: only 2 of the real
graph's 13 leaf functions (`signup`, `login`) happened to match a
`ROUTE_MAP` entry by name; the other 11 (all 8 storage functions plus
3 more auth functions) got no endpoint at all, for a graph that had
no relationship to whatever produced `ROUTE_MAP`'s original 9 entries.
A Python-code route table that doesn't move when the graph does is
exactly the drift this whole project exists to eliminate.

**Fix (after explicit sign-off on the schema design):** `python-function`
nodes gained two new optional interface fields, `http_method`/`route`
(added to `graph-model.js`, `graph-view.js`, `graph-controller.js`,
`protocol-registry.json` — editable in the graph editor exactly like
`signature`). `generate_main_file()` rewritten to read these two
fields directly from the graph instead of `ROUTE_MAP` (deleted
entirely), and gained an `import_path_for` parameter so a caller with
a different file-layout convention can plug in its own resolver.
`validate_graph.py` gained a check: `http_method`/`route` must be set
together or not at all.

**A second, separate gap found while fixing this:** `module_scaffold.py`
never called anything like `generate_main_file` at all — no REST
entry point in that path, hardcoded or otherwise. Fixed by having it
call the SAME `generate_main_file()`, but it needed its OWN
`import_path_for` resolver: module-granularity output groups multiple
functions into one file per parent module/class node, so a leaf's
real import path is its *parent's* file, not a file of its own the
way `scaffold.py`'s default `module_path_for`-based resolver assumes.
Built via a `module_import_path` dict populated during the existing
per-node loop in `scaffold_modules()`, at no extra graph traversal cost.

**Verified live, both granularities:** added real `http_method`/`route`
values to `signup`/`login` in the real graph, ran both
`--granularity leaf` and `--granularity module`, then actually
imported both generated `main.py` files and inspected the live
FastAPI route table on each — both show the identical, correct
`POST /api/v1/auth/login` and `POST /api/v1/auth/signup`, each
importing from the right place for its own file layout
(`app.auth_service.login` vs `services.auth_service`).

### Files changed (Pass 3)

| File | Changed | Why |
|---|---|---|
| `typedsl.py` | Yes | `PRIMITIVES` extended: `string`/`UUID` (str aliases), `number` (float), `timestamp` (real `datetime.datetime`) |
| `scaffold.py` | Yes | `collect_enum_types()`, `collect_constant_declarations()`; `generate_models_file()` emits real Enums/constants + unconditional `datetime` import; `generate_main_file()` rewritten to read `http_method`/`route` from the graph, `ROUTE_MAP` deleted; `needs_datetime` added alongside `needs_decimal` in two places; `collect_data_model_types()` gained `extra_known` |
| `module_scaffold.py` | Yes | Enum/constant collection wired into `known_types_for()`/`scaffold_modules()`; `main.py` generation added via the same `generate_main_file()` with a module-aware `import_path_for` resolver |
| `validate_graph.py` | Yes | New check: raw-node-id-as-field-type (3e); new check: `http_method`/`route` must pair (3f) |
| `generate_pytest.py`, `generate_prompts.py`, `opencode_bridge.py` | Yes | One-line fix repeated at each known-types call site — enum names merged in so `parse_signature` doesn't crash on an enum-typed signature |
| `kharcha-tracker-v2.yaml` | Yes | 3 raw-id field types corrected; 13 leaf function signatures drafted (marked PROPOSED); `http_method`/`route` added to `signup`/`login` |
| `graph-model.js`, `graph-view.js`, `graph-controller.js`, `protocol-registry.json` (graph editor project) | Yes | `http_method`/`route` added as optional `python-function` interface fields, editable in the editor |
| `graph_runner.py`, `generate_project.py`, `exceptions_gen.py` | No | Confirmed unaffected — `exceptions_gen.py` scans `tests[].expect_raises` across all nodes regardless of protocol, already fully agnostic; `generate_project.py` is a thin router, inherits `scaffold.py`/`module_scaffold.py`'s fixes with no changes of its own |

### What wasn't done, and why (Pass 3)

**The remaining 11 leaf functions have no `http_method`/`route`.**
Deliberately not guessed — whether `request_password_reset`,
`confirm_password_reset`, `get_current_user`, and the 8 storage CRUD
functions should be public API surface is a product decision, not a
mechanical one. `signup`/`login` got real values because they were
the only 2 the old `ROUTE_MAP` already claimed for this graph.

**`login`'s bare-`str` return type wasn't changed to a `LoginResult`
DTO.** Flagged in its own `notes` (see item 4 above) but not added
unprompted — a new data-model node is graph content, not a signature
inference.

**The remaining `typedsl.py` warnings** (`'string url'`,
`'string (e.g., USD, EUR)'`, and a few composite list-of-dict field
shapes) are genuinely malformed/free-text type strings in the graph
itself, not a vocabulary gap — separate from everything fixed this
pass, and not touched.

---

## Revision 3: language-agnostic schema, structured types, one-node-one-file

Everything before this section added protocols and fixed real bugs
within a schema that still had Python-specific notation baked in:
`python-module`/`python-function`/`rest` as protocol names, free-text
`"func(a: T) -> R"` signature strings for `typedsl.py` to parse, and a
flat `{field: type}` map for `model_fields` while every other
structured construct (`enum_values`, `constants`, `contract.methods`)
had already moved to lists of objects. Revision 3 is the accepted
proposal that removes all of that, on the premise that a human or an
LLM should be able to read `graph.yaml` and know exactly what gets
generated, in any target language, without knowing Python conventions
to write it.

This section covers three real implementation passes against that
proposal — 3.1 (schema + validator), 3.2a (retiring `typedsl.py`,
making `generate_project.py` work again), and the one-node-one-file
data-model work that followed a real bug report. Each surfaced real,
unpredicted bugs the same way every prior pass did.

### 3.1 — schema + validator

**Protocol renames**: `rest`→`entrypoint`, `python-module`→`module`,
`python-function`→`function`. Not a find-and-replace — `language` used
to be a fixed constant on each protocol's registry entry
(`PROTOCOL_REGISTRY["python-module"].language === "python"`); a
generic `module` can't carry that, so language became **node-level
data**: an optional `interface.language` on `module` nodes, resolved
by walking up to the nearest ancestor that declares one, falling back
to a new `graph.default_language` (mirrors `default_boundary`'s
existing pattern). `browser-js` deliberately keeps the old
fixed-constant mechanism — frontend is a separate future design
effort, untouched by this revision.

**Structured types everywhere**: `model_fields` converted from a flat
map to a list of `{name, type, ...}` objects, matching the other three
constructs. Function `signature` (free text) retired in favor of
`params`/`returns`, reusing `contract.methods`' own shape rather than
maintaining two representations of the same concept. A "type
descriptor" is now always one of: a canonical primitive keyword
(`string`/`integer`/`float`/`boolean`/`decimal`/`datetime`/`uuid`/`none`
— deliberately not Python's own type names), a real node id (a
reference — **the node id IS the type name now**, eliminating the
entire class of raw-snake-case-vs-derived-PascalCase mistakes this
project spent real effort catching in earlier passes), or a
fully-nested `list`/`map`/`optional` wrapper with **zero embedded
syntax** (`{"type": "list", "items": {"type": "uuid"}}`, not
`list<uuid>` — a deliberate, discussed trade-off: more verbose, but no
residual parser at all, at any nesting depth).

**A real design gap found mid-implementation, not anticipated in the
proposal**: `function` nodes had no way to have a real function name
different from their node id. The old signature strings carried both
(node `expense_split_calculator` → function `calculate_equal_split`;
three separate storage-backend nodes all needing a method literally
named `save` to satisfy `implements`) — losing that would have made
implementing a shared contract across sibling classes impossible.
Added an optional `interface.name` field (defaults to the node id),
and patched the already-migrated real files to restore it from their
original `signature` strings wherever it differed.

**`class.fields`** (new, minimal by design per the accepted proposal):
`{name, type}` only, no `required`/`default`/`notes` yet — addable
later without a breaking change.

**`layout` inference** (§7 of the proposal): a module may be
`layout: file` only if every direct child is a `function` — enforced
as a real `validate_graph.py` error, not just documented. `layout`
itself became optional, meant to be inferred (folder unless
all-function) rather than set explicitly every time.

**Migration**: all three real graphs converted by hand
(`kharcha-tracker-v2.yaml`, `kharcha-tracker-3_2-data-models.yaml`,
`kharcha_graph_storage.yaml`), including real structural additions the
migration required, not just renames — 6 new data-model nodes in
`kharcha_graph_storage.yaml` promoted from inline `interface.types`
declarations (Revision 3 retires that field too; a found-along-the-way
bonus: `signup`'s inline `UserRecord` was byte-identical to the
already-real `user_record` node — dropped as a duplicate rather than
creating a second one), and 2 new nodes (`expense_share`,
`expense_payment`) in both kharcha-tracker files, promoted from
`expn_splt`/`paid_by` composite list-of-dict fields `typedsl.py` could
never parse at all under the old schema.

**`migrate_to_v3.py`** (new, standalone) — a reusable CLI tool
automating everything mechanically safe about this conversion (renames,
`model_fields` list conversion, signature→params/returns with name
preservation, `contract.methods`, `constants[].type` canonicalization)
while refusing to guess at anything needing human judgment (composite
fields, inline `types`, bare untyped `dict`/`list`, quoted-literal
unions) — printed as warnings, never silently invented. Verified
against two synthetic test graphs (one clean path, one covering every
"needs a human" case) before being handed over.

### 3.2a — retiring `typedsl.py`, making `generate_project.py` work again

The reported crash: `AttributeError: 'list' object has no attribute
'items'` — `collect_data_model_types()` still assumed the old flat-map
`model_fields`. Fixing it properly meant retiring `typedsl.py`'s
parsing role entirely, not patching around it: every type is already
structured, so there's nothing left to parse, only a type descriptor
to resolve. New module **`type_resolve.py`** replaces it — a
recursive walk (`resolve_annotation`/`resolve_dummy_expr`/
`referenced_node_ids`), no string grammar at all, roughly a tenth the
size of `typedsl.py`'s regex-and-splitting approach. `scaffold.py`,
`module_scaffold.py`, `generate_pytest.py`, `generate_prompts.py`,
`opencode_bridge.py` all rewritten around it; nothing imports
`typedsl.py` anymore (confirmed by grep, not assumed).

**Two more real bugs found by actually running the regenerated
output, not by inspection:**

1. **Multi-level module nesting was silently broken** — `scaffold()`'s
   directory-creation logic only ever used `module_path_for`'s single
   last path segment, even though that function had been generalized
   to compute full nested paths in an earlier session. A genuinely
   2-level-nested real node (`storage_service/flat_file_backend/
   flat_file_list.py`) landed in the wrong flat location. This had
   been latent since the earlier generalization — no graph had
   actually exercised real multi-level nesting until this pass did.
2. **The new `interface.name` field broke wired dependency calls
   whenever multiple dependencies share a function name** — exactly
   the case it was built for. `save_record` depends on three functions
   all legitimately named `save`; three separate `from X import save`
   statements all bind the same local name, so only the last import
   survives and every "distinct" wired call silently invoked the same
   function three times. Fixed by always aliasing dependency imports
   by node id (guaranteed unique), with the wiring-test generator's
   `patch()` target updated to match.

**Verified**: all three real graphs, both `--granularity leaf`/
`module`, both `--mode flat`/`wired` — validated, generated, and the
generated code actually **imported and executed**, including all 23
wiring tests passing against `kharcha_graph_storage.yaml`'s real,
genuinely-nested 38-function graph.

### One-node-one-file for data-model children of a module

A real bug report started this: a `constants` module with 5 real
`data-model` children generated an empty placeholder file, because
`generate_module_file()` had no rendering path for data-model children
at all — only `function` dependencies or `exports`.

**First finding**: the reported file's `layout: file` was itself
invalid (non-function children), and two OTHER pre-existing content
gaps (`storage_service`/`auth_service` missing children from their own
`dependencies`) were also real, unrelated to the report. Fixed all
three directly in the file.

**Second finding, more consequential**: fixing the invalid `layout:
file` should have let `constants` auto-infer to `folder` per the 3.1
rule — it didn't. The *rule* had been built into the JS editor and
documented in `validate_graph.py`'s check 3g, but never actually wired
into `module_scaffold.py`'s real folder-vs-file decision, which only
ever checked for the literal string `"folder"`. New `inferred_layout()`
helper, wired into every decision point.

**Third finding**: even correctly folder-ized, `constants/` was still
empty inside — `write_folder_module` (as it existed then) had no
branch for `data-model` children at all. New per-node generators in
`scaffold.py` (`generate_single_dataclass_file`, `generate_single_enum_file`,
`generate_single_constant_file`, plus `resolve_model_fields` extracted
for reuse), dispatched from a new `render_single_data_model_file` in
`module_scaffold.py`.

**A real regression caused by the fix itself**: cross-references
between a data-model's own file and code elsewhere need to know every
node's target path before rendering ANY content — a naive "process
folders before file-style modules" ordering fixed one direction
(file-style code referencing a folder-organized type) but broke the
other (`save_record`, once correctly promoted to folder-style,
depends on `in_memory_save`/`flat_file_save`/`sqlite_save`, which live
in file-style modules processed too late under that ordering).
Required a real two-phase restructuring — `write_folder_module`
replaced by `discover_folder_module()` (populates every path, writes
nothing) + `render_pending()` (renders everything, called once,
after ALL discovery across the whole graph is complete), plus a
separate `type_import_path` map alongside the existing
`leaf_module_path`.

**A boundary case found during regression testing, not anticipated**:
a `function` can be a direct child of the `entrypoint` node itself
(`entrypoint`'s own `allowedChildren` includes `function`, not just
`module`) — bypassing both discovery loops entirely
(`balance_aggregator` in the real graph). Fixed with an explicit
discovery step for the backbone's own function children.

**Two more real bugs found only by the final verification step** —
actually importing every single generated module in a real project,
not just checking that generation didn't crash or that one reported
case looked right:

1. `generate_stub_file` never accepted a `type_import_path` at all —
   every function referencing a data-model type that had moved into
   its own per-node file (6 real promoted types: `UserRecord`,
   `GroupRecord`, `ExpenseRecord`, `AuthResult`, `SettlementRound`,
   `SettlementRecord`) generated a broken import pointing at the old
   shared aggregate. 15 of 42 real generated modules failed to import
   before this fix.
2. `generate_single_dataclass_file` had the identical bug in the
   opposite direction — its own docstring even admitted the flaw ("a
   referenced type with no entry here is assumed to live in the SAME
   file"), silently omitting the import entirely for anything still
   in the shared aggregate rather than falling back to it.

Both fixed by grouping referenced types by their actual resolved path
with the shared aggregate as an explicit fallback, never a silent
omission or a hardcoded single destination.

**Verified**: 0 import failures across all 42 real generated modules
in `kharcha_graph_storage.yaml`'s module-mode output (up from 15
failures on the first "it doesn't crash" pass) — plus a targeted
synthetic cross-boundary test (a file-style module's function
importing a type organized in a folder elsewhere in the tree),
executed end to end, not just inspected.

### Files changed (Revision 3, cumulative across 3.1/3.2a/one-node-one-file)

| File | Changed | Why |
|---|---|---|
| `graph-model.js`, `graph-view.js`, `graph-controller.js`, `protocol-registry.json` (graph editor project) | Yes | Generic protocol names, node-level `language`, structured `params`/`returns`/`class.fields`/`model_fields`, `interface.name`, `layout` auto-inference display |
| `graph_runner.py` | Yes | `default_language` (mirrors `default_boundary`) |
| `validate_graph.py` | Yes | Full rewrite: renamed registry, `resolve_type_descriptor` (replaces the now-impossible raw-id mistake check), `resolve_language` (ancestor-walk, replaces registry-constant lookup), `layout: file` enforcement |
| `type_resolve.py` | New | Replaces `typedsl.py`'s parsing role entirely |
| `scaffold.py` | Yes | Full rewrite around `type_resolve.py`; `resolve_model_fields`/`generate_single_*` for one-node-one-file; `type_import_path` threading; multi-level nesting fix; dependency-import aliasing fix |
| `module_scaffold.py` | Yes | Full rewrite: `inferred_layout()`, `discover_folder_module`/`render_pending` two-phase split, entrypoint-direct-child handling, per-data-model-node file dispatch |
| `generate_pytest.py`, `generate_prompts.py`, `opencode_bridge.py` | Yes | Rewritten around `type_resolve.py`, no more `known_types`/`extra_known` threading (structural simplification, not just a rename — a type reference no longer needs a pre-built "known" set to validate against, since it's trusted by existence rather than name-matching) |
| `generate_project.py` | Yes | Stale error messages referencing the retired `signature` field corrected |
| `migrate_to_v3.py` | New | Reusable migration tool for any remaining old-shape graphs |
| `typedsl.py` | Retired | Confirmed unused by grep; safe to delete from the repo |
| `graph_runner.py`'s `NON_EXECUTABLE_PROTOCOLS`, `exceptions_gen.py` | No | Unaffected — protocol-name-based logic already used the generic `data-model`/`contract` strings, never the renamed ones |

### What's still open

**Phase 3.2b — real `class`/`contract` OOP codegen** — unchanged from
before Revision 3: a `class` node still generates byte-identical
output to a `module` (no `self`, no `__init__`, no real class
wrapper), and `contract.methods` still generates nothing at all (pure
validated spec). The accepted proposal's `class.fields` (§5) and
`ABC`-based contract codegen (§6, resolved in favor of `ABC` over
`Protocol` for the enforcement reasons discussed when the proposal was
finalized) are the concrete next pieces — not started.

**Two pre-existing content gaps**, confirmed present before any work
this session touched them, deliberately left alone: `auth_service`/
`storage_service` missing children from their own `dependencies` in
two of the four real graphs.

**Sibling-folder-to-sibling-folder references** are handled correctly
by the two-phase discovery/render split (confirmed — that was the
whole point of the restructuring), but two data-model nodes in
different folders that reference EACH OTHER (a genuine cycle, not
just an ordering issue) would still hit Python's own circular-import
limits, same as any hand-written Python project would — not something
file-splitting can fix, and not attempted.

---

## Pass 5: September 2026 pivot — new relationship/prompt fields, validation kept in sync

Unlike Passes 1-4, this stage's *design and implementation* work
mostly happened outside this toolchain — in the `graph_editor`
project (composing prompts, running validation in-browser, a native
save dialog; see that project's own README §11 for the full account).
This toolchain's footprint is deliberately small: keep `Node` and
`validate_graph.py` able to round-trip and check the new fields, since
those fields are edited in the browser but the graph is still a plain
YAML file any of these scripts can open.

### What was actually broken, and the fix

**`Node` didn't have the new fields at all.** `graph-editor`'s schema
gained four new node-level concepts this pass: `calls`/`data_flows`
(two new relationships, same pattern as the existing `maps_to`/
`implements`) and `prompt_template`/`prompt` (a prompt composition
override and the reviewed prompt text itself). `graph_runner.py`'s
`Node` dataclass is a fixed set of fields, not an open dict — without
adding these explicitly, `Graph.load()` would have silently dropped
them on any Python-side read of a graph edited in the browser, and
`Graph.save()` would have silently dropped them on any Python-side
write. Fixed the same way `maps_to`/`implements` already work: real
dataclass fields with `default_factory=list`/`""`, read in `load()`,
written in `save()`, plus `calls_ids`/`data_flows_ids` convenience
properties mirroring `maps_to_ids`/`implements_ids`.

**`validate_graph.py` had no way to catch a dangling `calls`/
`data_flows` reference.** Two new checks added (3j, 3k), same shape as
the existing 3b (`maps_to`)/3c (`implements`) dangling-reference
checks: a `calls` or `data_flows` entry pointing at a node id that
doesn't exist is an error; a `data_flows` entry whose `data_model`
doesn't match an existing node id is a warning (not an error — a
`data_model` string is documentation of *what* moves, not necessarily
a strict reference to a `data-model` node, so a mismatch is worth
flagging but not blocking).

**A real bug introduced mid-edit, caught by actually compiling the
file.** An earlier pass at these two checks left literal backslash-
escaped quote characters (`\"`) inside f-strings in `validate_graph.py`
— a copy-paste/escaping mistake, not a logic error, but one that would
have raised a `SyntaxError` the moment this file was imported, silently
disabling every check in it, not just the two new ones. Caught by
running `python3 -m py_compile validate_graph.py` rather than assuming
a prior edit was clean, and by then actually constructing a `Graph`,
round-tripping it through `save()`/`load()`, and calling `validate()`
against both a valid and a deliberately-broken graph to confirm the
new checks fire correctly (not just that the file parses).

### Files changed (Pass 5)

| File | Changed | Why |
|---|---|---|
| `graph_runner.py` | Yes | `Node` gains `calls`, `data_flows`, `prompt_template`, `prompt` fields + `calls_ids`/`data_flows_ids` properties; `Graph.load()`/`Graph.save()` read/write all four |
| `validate_graph.py` | Yes | Two new checks: 3j (dangling `calls` reference → error), 3k (dangling `data_flows` reference → error; unresolved `data_model` → warning) |
| `graph-model.js`, `graph-view.js`, `graph-controller.js`, `protocol-registry.json` (graph-editor project) | Yes | Same four fields on the JS side, `function`'s new `errors`/`preconditions`/`postconditions`, full edit-form/view-panel/edge UI for `calls`/`data_flows` — see that project's own README §11.1 |
| `validate-graph.js`, `prompt-generator.js` (graph-editor project) | New | JS port of `validate_graph.py`; prompt composition + `prompts.json` generation. Neither has a Python-side equivalent — this work is client-side only, by design (§11.2-11.4 of that README) |
| `scaffold.py`, `module_scaffold.py`, `generate_project.py`, `generate_prompts.py`, `generate_pytest.py`, `opencode_bridge.py`, `exceptions_gen.py` | No | None of these read `calls`/`data_flows`/`prompt_template`/`prompt` — see "What wasn't done" below |
| `type_resolve.py`, `migrate_to_v3.py` | No | Unaffected — the new fields aren't types and don't need migration (they default to empty/blank on any graph that predates them) |

### What wasn't done, and why (Pass 5)

**No generator consumes `calls` or `data_flows` for actual code
generation.** `scaffold.py`/`module_scaffold.py` still generate
wiring purely from `dependencies` — a `calls` entry's `operation_name`
or a `data_flows` entry's `direction`/`data_model` don't influence any
generated file's imports, call sites, or docstrings today. These
fields exist so a browser-side generated prompt can describe that
detail to an LLM directly; teaching the Python generators themselves
to use the same data was explicitly out of scope for this pass and,
given the toolchain's role is shrinking rather than growing (see the
intro's stage 5 summary), may not be worth doing at all rather than
building it into the `graph_editor` prompt composer instead.

**No Python-side prompt generation was added or changed.**
`generate_prompts.py`/`opencode_bridge.py` still do what they did
after Revision 3 — nothing here was touched to parallel
`prompt-generator.js`'s new skeleton/implementation split or its
`prompt`/`prompt_template` field handling. That split now exists in
exactly one place (the browser), which is the intended state per the
pivot, not an oversight — but it does mean the two are on record as
*not* kept in sync going forward unless a future pass explicitly
decides otherwise.

**`class`/`contract` OOP codegen is still exactly as open as Revision
3 left it** (Phase 3.2b, still unstarted) — the new `calls`/
`data_flows` fields don't change that; a `class` node still generates
byte-identical output to a `module`, and `contract.methods` still
generates nothing. If Phase 3.2b is ever picked back up, the
browser's new `prompt-generator.js` skeleton prompts (README §11.2)
are the more current reference for what a `class`/`contract` shell
should actually contain than anything in this Python toolchain today.



