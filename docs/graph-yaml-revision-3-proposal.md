## 0. What this revision is actually for

Revision 1 added `data-model`/`contract`/`class`/`enum`/`constant`.
Revision 2 (last session) found and closed real bugs in how those get
turned into files. This revision is different in kind: it removes the
last language-specific notation from the schema itself, and replaces
the one genuinely fragile part of the whole toolchain — `typedsl.py`
parsing free-text signature strings — with plain structured YAML. The
goal stated for it: a human or an LLM should be able to read
`graph.yaml` and know exactly what gets generated, in any target
language, without needing to know Python conventions to write it.

---

## 1. Generic protocol names, and where `language` actually lives now

`python-module` → **`module`**. `python-function` → **`function`**.
`rest` → **`entrypoint`** (resolved below). `data-model`/`contract`/
`class` are already generic and keep their names.

This is not a rename alone. Today `language` is a **constant on the
protocol registry entry** — `PROTOCOL_REGISTRY["python-module"].language
=== "python"`. A generic `module` protocol can't carry a fixed language
that way; language becomes **node-level data**, declared on a `module`
node and inherited by everything under it unless overridden:

```yaml
- id: auth_service
  interface:
    protocol: module
    language: python        # optional; if absent, inherits from the nearest ancestor module that sets one
```

A graph-level `default_language` (mirroring the existing
`default_boundary`) covers the case where nothing in the tree sets one
at all. `class`/`function`/`data-model`/`contract` nodes don't carry
`language` themselves — they resolve it by walking up to the nearest
`module` ancestor, same principle as before ("language is a property
of a subtree, not a node"), just implemented as a real walk instead of
a registry lookup.

**Affected:** `graph-model.js` (`PROTOCOL_REGISTRY`, `checkCrossLanguageBoundary`
needs to resolve language by ancestor walk, not registry lookup),
`validate_graph.py` (its own mirror of the same registry and check 8),
`graph-view.js`/`graph-controller.js` (a `language` field on `module`
nodes' edit form).

---

## 2. `model_fields`: flat map → list of objects

Today `data-model` is the one construct still shaped as a bare
`{fieldName: typeString}` map, while `enum_values`, `constants`, and
`contract.methods[].params` are all lists of richer objects. That's an
inconsistency with no upside — a flat map has nowhere to put a
per-field `notes`, a `required` flag, or a default. Converting it to
match the other three:

```yaml
# before
model_fields:
  status: expense_status
  amount: float

# after
model_fields:
  - name: status
    type: expense_status
  - name: amount
    type: float
  - name: notes
    type: string
    required: false
    notes: "Optional free-text memo."
```

**This is a breaking change to every real `.yaml` file that has DTOs** —
migration is in §7, not deferred.

---

## 3. Type references: the node id *is* the type name now — no more derived-name matching

This is the biggest single simplification, and it falls out naturally
once field/param types are structured rather than parsed from text.
Every mistake this project spent real effort catching this session —
`expense_status` where `ExpenseStatus` was needed, the whole
raw-snake-case-id class of bug, `typedsl.py`'s `Unrecognized type
expression` crashes — existed because a human had to correctly
hand-derive a PascalCase name and type it into a string. If `type:`
in a structured field can just **be the node's own id**, that
derivation becomes the *generator's* job at code-emission time, not
something anyone has to get right while authoring the graph:

```yaml
- name: status
  type: expense_status     # this IS the real node id — validated by existence, not name-matching
```

`validate_graph.py` replaces its raw-id-mistake check (no longer
needed — there's no wrong form to type) with a much simpler one: does
`type` resolve to either a canonical primitive keyword or a real node
id in the graph? That's it.

### Canonical, language-neutral primitive vocabulary

Not Python's own type names (today's `str`/`int`/`X | None` — that's
literally PEP 604 syntax, re-importing Python-specificity through the
back door). A small neutral set of *scalars*:

| Canonical | Python | C# | Java | Rust |
|---|---|---|---|---|
| `string` | `str` | `string` | `String` | `String` |
| `integer` | `int` | `int` | `int` | `i64` |
| `float` | `float` | `double` | `double` | `f64` |
| `boolean` | `bool` | `bool` | `boolean` | `bool` |
| `decimal` | `Decimal` | `decimal` | `BigDecimal` | `rust_decimal::Decimal` |
| `datetime` | `datetime` | `DateTime` | `Instant` | `chrono::DateTime` |
| `uuid` | `str` (alias, per your existing Pass-3 decision) | `Guid` | `UUID` | `uuid::Uuid` |

**Collections/optionality are fully-nested structures, not embedded
syntax** (§13's question, now resolved — see below): `list`, `map`,
and `optional` are themselves values of `type`, each with their own
named sub-field(s) pointing at another type descriptor recursively.
This means resolving a type is a plain recursive walk over a YAML
object — check `type`; if it's a scalar keyword, done; if it's
`list`/`map`/`optional`, recurse into the named sub-field; otherwise
it must match a real node id (a reference — see below). **Zero
parsing**, at any level of nesting:

```yaml
# a plain scalar
type: string

# a reference to another node (an enum, a DTO, another data-model)
type: expense_status

# a list of a scalar
type: list
items:
  type: uuid

# a list of a referenced node
type: list
items:
  type: expense

# a map
type: map
key:
  type: string
value:
  type: float

# optional, nestable like everything else
type: optional
of:
  type: list
  items:
    type: uuid
```

**What this resolves that free-text couldn't:** the real graph has
fields like `expn_splt`/`paid_by` — a list of ad hoc `{user_id, amount}`
shapes — that `typedsl.py` was never able to parse at all (they
degraded to `str`). Under this structure, the right move isn't a new
"anonymous inline object" capability — consistent with this project's
existing preference for promoting reusable shapes to their own named
node (`base_record`, `expense_status`, etc.) rather than keeping them
inline — it's giving that shape its own small `data-model` node (e.g.
`expense_share: {user_id: uuid, amount: float}`) and referencing it:
`type: list`, `items: {type: expense_share}`. No anonymous-shape
concept needed; the existing "promote it to a node" convention just
extends to cover this case too.

This table is the seed of each future per-language generator's own
type-mapping module (`python_lang.py`, `csharp_lang.py`, ...) — see §9
on why that's the multi-language path, not transpiling generated
Python.

---

## 4. Function signatures: reuse `contract.methods`' shape, retire the free-text DSL

`function` nodes stop having a `signature: "foo(a: str) -> Bar"`
string entirely. They get the exact same structured shape
`contract.methods[]` already uses:

```yaml
- id: signup
  parent: auth_service
  interface:
    protocol: function
    params:
      - name: email
        type: string
      - name: password
        type: string
    returns:
      type: user            # references the `user` node directly
```

`typedsl.py` shrinks to almost nothing — there's no longer a
free-text grammar to parse. What's left is a small, per-language
**type-resolution** function (canonical type name → native annotation
+ default/dummy value), which is exactly the seed of the per-language
generator split in §9. `contract.methods` needed no shape change at
all — this is functions adopting *its* shape, closing the
"two parallel representations of the same concept" gap.

**Practical effect on the "every function needs a hand-authored,
correct signature" problem:** this removes the failure mode where a
plausible-looking string silently crashes generation — there's no
string to get subtly wrong anymore, only a structural reference that
either resolves or is flagged immediately by the validator. It does
**not** remove the requirement that someone still specify every
parameter's real type before generation produces anything useful —
that's inherent to any typed system, not a `typedsl.py` problem.

---

## 5. `class` gets real instance state — a genuine new capability, not just better rendering

Today a `class` node is only a bag of function children — there's no
way to express what data an instance actually holds, so real OOP
codegen (`def __init__(self, x, y):`) has nothing to generate *from*.
`class` nodes gain a `fields` list, same shape as the reworked
`model_fields`:

```yaml
- id: flat_file
  parent: storage_service
  implements: [{node: storage_interface}]
  interface:
    protocol: class
    fields:
      - name: base_path
        type: string
```

Generated Python (illustrative — the exact template is implementation
detail, not something to lock down in the schema itself):

```python
class FlatFile(StorageInterface):
    def __init__(self, base_path: str):
        self.base_path = base_path

    def save_record(self, record: BaseRecord) -> BaseRecord:
        raise NotImplementedError("save_record")
```

Function children become real bound methods (`self` parameter added,
body indented under the class), not flat module-level functions
indistinguishable from a `module`'s — closing the gap where `class`
and `module` currently produce byte-identical output.

---

## 6. `contract.methods` → real generated code, not just a validated spec

Once functions and contract methods share one shape (§4), this is a
new template, not new schema: emit a real interface per target
language from `interface.methods`, keyed off the same canonical types.
Python: `abc.ABC` with `@abstractmethod` (resolved in §12 — nominal,
enforced at instantiation, not `typing.Protocol`'s unenforced
structural typing):

```python
class StorageInterface(ABC):
    @abstractmethod
    def save_record(self, record: BaseRecord) -> BaseRecord: ...
    @abstractmethod
    def get_record(self, id: str) -> BaseRecord: ...
```

Implementing classes must then explicitly inherit
(`class FlatFile(StorageInterface):`), matching `implements:` in the
graph directly — the generated code enforces the exact relationship
the graph already declares, rather than leaving it as documentation
`validate_graph.py` checks but Python itself doesn't.

---

## 7. One node, one file — the organizing principle that also answers "when is a module a folder"

Rather than special-casing "aggregate all DTOs into one shared types
file" (today's behavior, and the reason the `models`-module gap
existed at all), revision 3 proposes a single uniform rule:

> **Every node that isn't a pure organizational container (`module`,
> `entrypoint`) gets its own generated file, placed wherever its parent
> module resolves to in the folder tree.**

`function`, `class`, `data-model` (dto/db_schema/enum/constant), and
`contract` each always get their own file. `module` nodes are then
*purely* folders/namespaces — the only open question per module is
whether its **function** children collapse into one shared file
(the one case where "many nodes, one file" is still allowed, because
a handful of small related functions in one file is a real, normal
pattern) or each get their own file too:

- **A module may be `layout: file` only if every direct child is a
  `function`.** If it has any `module`/`class`/`data-model`/`contract`
  child, `validate_graph.py` requires `layout: folder` — enforced,
  not just documented.
- **`layout` becomes optional, not a decision you make every time.**
  If absent, it's inferred automatically from child composition
  exactly per the rule above — folder unless every child is a
  function. You only ever set it explicitly to *override* the
  inferred default (e.g. force a function-only module into a folder
  for max granularity).
- A `data-model`/`contract` node always gets its own file regardless
  of its parent's layout — this directly closes the `models`-module
  gap: `from services.auth_service.user import User` becomes real
  once `user` has its own file, no re-export shim needed.

---

## 8. Closing the wired-call asymmetry, for real this time

The root cause, restated precisely: `module_scaffold.py` has **two
separate implementations** of "render a function's stub body" —
`render_kharcha_style_function` (always `raise NotImplementedError`,
never proves a dependency call) and `generate_stub_file` (real
wired dummy-calls, used only by the folder-layout path added last
session). Under §7's "every function gets its own file by default"
rule, the collapsed-multiple-functions-in-one-file case becomes the
*exception* rather than the default — and even in that exception, it
should call the **same** underlying stub-body generator, just write
its output into a shared file instead of separate ones, rather than
maintaining a second, weaker implementation. One function-body
renderer, two possible file-layout destinations — not two renderers.

---

## 9. Why this is the real path to multi-language, not transpilation (restating the decision from last message)

With signatures, contract methods, DTO fields, and class fields all
resolving through the same canonical type table (§3), adding a second
target language means writing one new, bounded module — a
`csharp_lang.py` mapping canonical types to C# annotations/defaults,
paired with a `csharp_scaffold.py` that knows C#'s own file/namespace
conventions — not touching the graph schema at all. The schema was
already the portable part; this revision finishes making the
*generators* swappable too, which is what actually unlocks Phase 3
properly (as a set of parallel generators, per your accepted decision
last message — not as Python-to-X transpilation).

---

## 10. Migration plan for the real graphs

Three real files need this applied: `kharcha-tracker-v2.yaml`,
`kharcha-tracker-3_2-data-models.yaml`, `kharcha_graph_storage.yaml`.

1. **Protocol rename**: `python-module`→`module`, `python-function`→`function`,
   `rest`→`entrypoint`, mechanical, scriptable.
2. **`language` placement**: add `language: python` once, on each
   graph's top-level backbone-adjacent root module (or `default_language: python`
   at the graph root) — covers every existing node with zero per-node
   changes, since nothing currently declares a non-Python subtree.
3. **`model_fields` conversion**: dict → list-of-objects, scriptable
   (the shape transformation itself is mechanical; per-field `notes`/
   `required` can be backfilled later, not required for the migration
   to be valid).
4. **Signature conversion**: the 13 signatures drafted last session
   (all `PROPOSED`, already marked as such) convert cleanly to
   `params`/`returns` — this is the smallest, cleanest migration
   surface possible, since there's no large body of hand-written
   signatures yet to convert.
5. **Re-run `validate_graph.py`** (itself updated for the new checks)
   against all three as the acceptance gate, same discipline as every
   prior pass this session.

---

## 11. Proposed implementation phasing

**3.1 — Schema + editor + validator.** Generic protocol names,
node-level `language`, `model_fields` list conversion, structured
`function`/`contract.methods` shape, `class.fields`, the `layout`
inference rule. Touches `graph-model.js`/`graph-view.js`/
`graph-controller.js`/`protocol-registry.json`/`validate_graph.py`.
Migrate the three real graphs (§10) as the verification step.

**3.2 — Generator rewrite for Python.** Retire `typedsl.py`'s parsing
role in favor of structured-type resolution; unify the two
stub-body renderers (§8); implement §7's one-node-one-file rule end
to end, including per-file DTOs/enums/constants/contracts.

**3.3 — Real OOP codegen.** `class.fields` → real `__init__`,
`self`-bound methods; `contract.methods` → real `ABC`.

**3.4 — Re-verify against real execution**, same standard as every
prior pass: generate the real graphs, import the generated code,
execute it, not just inspect the source.

Each phase gets its own sign-off before starting the next, same as
this session's pattern — this is a bigger change than anything done
so far, and I'd rather confirm the direction after 3.1 lands (schema
+ real-file migration, no generator changes yet) than build all four
phases before finding out something in 3.1 needs to go differently.

---

## 12. Resolved decisions

- **Contract codegen: `abc.ABC`, not `typing.Protocol`.** ABC enforces
  at instantiation time that every abstract method is overridden —
  Protocol enforces nothing at class-definition time at all. Given a
  stub subclass with every method present (even a body that's just
  `raise NotImplementedError(...)`) still satisfies ABC's check, this
  costs nothing during scaffolding and catches a missing method
  immediately (e.g. via the generated wiring test) rather than letting
  it surface later as a plain `AttributeError` at first real call —
  consistent with this project's "enforced, not just conventional"
  standard everywhere else.
- **`class.fields` starts minimal**: `{name, type}` only. `required`/
  `default`/`notes` deferred — addable later without a breaking change.
- **`rest` → `entrypoint`.** Deliberately not `api` — doesn't
  presuppose REST/HTTP, so a future non-REST entrypoint kind isn't a
  misnomer. **Explicit scope boundary:** `http_method`/`route` stay on
  `function` nodes exactly as-is — those fields are themselves
  REST-specific vocabulary, and generalizing them is deferred until an
  actual second entrypoint kind exists to justify it, not redesigned
  speculatively now.
- **Collections/optionality: fully-nested structure, zero embedded
  syntax** — `type: list`/`map`/`optional` with named sub-fields
  (`items`/`key`+`value`/`of`), not compact `list<T>` generics. Costs
  real verbosity on a graph with many collections; buys a type system
  with no parser at all, at any nesting depth. See §3 for the full
  shape and the `expn_splt`-style anonymous-object case it resolves
  along the way.
