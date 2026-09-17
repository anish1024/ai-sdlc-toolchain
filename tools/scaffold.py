"""
scaffolder/scaffold.py — generates a real Python project structure
from a graph_runner YAML file: one directory per top-level service
(a direct child of the backbone that itself has children), one .py
file per leaf node with a signature-correct stub function, a
dataclass in app/models.py for every custom type, and a FastAPI
app.main wiring PRD-style REST endpoints to the generated functions.

TWO STUB MODES (this is the answer to "carve out service layers to
test communication first"):

  --mode flat   Every function immediately returns a dummy value.
                Good for checking imports/signatures/structure only —
                no function ever calls another.

  --mode wired  Every function ALSO calls its real declared
                dependencies (real imports, real function calls) with
                dummy arguments, before returning its own dummy value.
                This is the "walking skeleton" — proves the actual
                call graph (imports, argument counts, wiring) works
                end-to-end with fake data at the leaves, before any
                real business logic exists. Pair this with the
                generated tests/test_wiring.py, which patches leaf
                functions and asserts they get called — that's the
                actual "test the communication layer" deliverable.

Directory mapping (mechanical, from the graph's own `parent` field):
  - A direct child of the backbone that itself has children (e.g.
    auth_service) -> a package directory (app/auth_service/).
  - A leaf under that service -> one file inside that package
    (app/auth_service/signup.py).
  - A direct child of the backbone with NO children of its own (e.g.
    settlement_engine, which is contract_defined directly) -> a
    single top-level module file (app/settlement_engine.py).
"""

from __future__ import annotations

import argparse
from pathlib import Path

from graph_runner import Graph, Node
from type_resolve import resolve_annotation, resolve_dummy_expr, referenced_node_ids, derive_pascal, TypeResolveError


# ---------------------------------------------------------------- models.py

# ---------------------------------------------------------------- data-model nodes -> dataclasses

def is_data_model(node: Node) -> bool:
    return node.interface.get("protocol") == "data-model"


def data_model_type_name(node: Node) -> str:
    """Derives a PascalCase Python class name from a data-model node's
    id -- now a thin wrapper around type_resolve.derive_pascal, the
    ONE place this derivation happens (Revision 3: a type reference in
    the graph IS the real node id, e.g. 'expense_status' -- the
    PascalCase name ('ExpenseStatus') only ever exists as a
    code-generation detail now, never something a graph author has to
    get right by hand)."""
    return derive_pascal(node.id)


def resolve_model_fields(node: Node, warnings: list[str]) -> list[dict]:
    """Resolves ONE data-model node's `model_fields` list into
    {"name", "annotation", "dummy_expr", "referenced_ids"} dicts --
    extracted out of collect_data_model_types (which calls this once
    per node to build its whole-graph aggregate) so module_scaffold.py's
    one-node-one-file writer can resolve a single node's fields
    directly too, without needing the aggregate at all."""
    resolved_fields = []
    for field in node.interface.get("model_fields", []):
        fname = field["name"]
        try:
            annotation = resolve_annotation(field["type"])
            dummy_expr = resolve_dummy_expr(field["type"])
            refs = referenced_node_ids(field["type"])
        except TypeResolveError as e:
            warnings.append(
                f"data-model node '{node.id}', field '{fname}': type descriptor "
                f"{field.get('type')!r} could not be resolved ({e}) -- using 'str' "
                f"as a placeholder in the generated dataclass. This should have "
                f"been caught by validate_graph.py -- run that first."
            )
            annotation, dummy_expr, refs = "str", '""', set()
        resolved_fields.append({
            "name": fname, "annotation": annotation, "dummy_expr": dummy_expr, "referenced_ids": refs,
        })
    return resolved_fields


def collect_data_model_types(graph: Graph) -> tuple[dict[str, list[dict]], list[str]]:
    """Every data-model node's model_fields -- now a LIST of
    {name, type: <descriptor>, required?, notes?} objects (Revision 3),
    not a flat {fieldName: typeString} map -- resolved directly via
    type_resolve, with NO known/extra_known set to thread through
    anymore: a type descriptor's reference IS a real node id, checked
    for existence by validate_graph.py already, so this function can
    just trust it and derive the class name on the fly. This is a
    genuine simplification over the old typedsl.py-based version, not
    just a reshuffle -- the entire `known`/`extra_known` plumbing that
    used to run through this file, module_scaffold.py,
    generate_pytest.py, generate_prompts.py, and opencode_bridge.py is
    gone; nothing needs it anymore.

    Returns (dict[type_name -> list of resolved field dicts], warnings).
    Each resolved field dict is {"name", "annotation", "dummy_expr",
    "referenced_ids"} -- ready for generate_models_file to emit
    directly, no further parsing.

    Two known, deliberate behaviors, not oversights:
      - If a field's type descriptor is malformed enough that
        type_resolve can't resolve it (should be rare -- validate_graph.py
        is supposed to catch this before generation ever runs), that
        ONE field degrades to a 'str' placeholder with a warning,
        rather than failing the whole graph's generation -- same
        tiered-honesty approach generate_pytest.py uses for `expect`
        keys it can't mechanically translate.
      - If two data-model nodes derive the SAME type name (e.g.
        'user-record' vs 'user_record'), the first one encountered
        wins and the rest are skipped with a warning -- never silently
        overwritten.
    """
    warnings: list[str] = []
    data_model_nodes = [n for n in graph.nodes.values() if is_data_model(n) and n.interface.get("model_fields")]

    shapes: dict[str, list[dict]] = {}
    for n in data_model_nodes:
        type_name = data_model_type_name(n)
        if type_name in shapes:
            warnings.append(
                f"data-model node '{n.id}' derives type name '{type_name}', which "
                f"collides with another data-model node's derived name -- keeping "
                f"the first one encountered, skipping this node's shape. Rename one "
                f"of the colliding node ids to fix."
            )
            continue
        shapes[type_name] = resolve_model_fields(n, warnings)

    return shapes, warnings


def collect_enum_types(graph: Graph) -> tuple[dict[str, dict], list[str]]:
    """Every `model_kind: enum` data-model node, converted into a real
    Python Enum definition -- the enum-kind sibling of
    collect_data_model_types() above. Kept as a SEPARATE function
    rather than folded into that one because an enum isn't a
    dataclass-shaped 'name: type' record (it has members, not fields),
    so it needs its own generation template in generate_models_file()
    below, not the { field: type } shape string format dto/db_schema
    nodes use.

    THE BUG THIS FIXES: collect_data_model_types() filters to nodes
    with `model_fields`, which enum nodes never have (they have
    `enum_values` instead) -- so an enum's derived type name NEVER
    entered `known` anywhere in this file, in module_scaffold.py, or
    in generate_pytest.py/generate_prompts.py/opencode_bridge.py's own
    known-types merges. Any function signature or DTO field that
    referenced an enum type by its correct derived name (e.g.
    'ExpenseStatus') would still hit `TypeDslError: Unrecognized type
    expression` -- confirmed by reproducing it directly against the
    real graph before this fix existed. Unlike collect_data_model_types's
    per-field graceful degrade-to-str, a bad SIGNATURE (not a DTO
    field) crashes generate_stub_file() uncaught, since parse_signature()
    there has no try/except around it -- this is almost certainly what
    produced the reported crash.

    Returns (enum_defs, warnings) where enum_defs[type_name] = {
      "enum_type": "string" | "int", "members": [(member_name, value), ...]
    }. Same collision rule as collect_data_model_types: first wins,
    rest skipped with a warning, never silently overwritten.
    """
    warnings: list[str] = []
    enum_nodes = [
        n for n in graph.nodes.values()
        if is_data_model(n) and n.interface.get("model_kind") == "enum"
    ]
    enum_defs: dict[str, dict] = {}
    for n in enum_nodes:
        type_name = data_model_type_name(n)
        if type_name in enum_defs:
            warnings.append(
                f"enum node '{n.id}' derives type name '{type_name}', which "
                f"collides with another enum node's derived name -- keeping "
                f"the first one encountered, skipping this node."
            )
            continue
        members = [(v["name"], v["value"]) for v in n.interface.get("enum_values", [])]
        if not members:
            warnings.append(f"enum node '{n.id}' has no enum_values -- generating an empty Enum, which Python rejects at class-definition time. Add at least one value.")
            continue
        enum_defs[type_name] = {
            "enum_type": n.interface.get("enum_type", "string"),
            "members": members,
        }
    return enum_defs, warnings


def collect_constant_declarations(graph: Graph) -> tuple[list[dict], list[str]]:
    """Every `model_kind: constant` data-model node's `constants` list,
    flattened across all such nodes into one list of real module-level
    Python constants. Unlike enums, constants are VALUES, never
    referenced as a TYPE in a signature or field -- so, unlike
    collect_enum_types's output, this does NOT feed into `known`
    anywhere; it only feeds generate_models_file's constants section.

    Returns (constants, warnings) -- constants is a flat list of
    {"name", "type", "value", "notes"} dicts. A NAME colliding across
    two different constant nodes is warned and the first wins, same
    collision rule as everywhere else in this file.
    """
    warnings: list[str] = []
    constant_nodes = [
        n for n in graph.nodes.values()
        if is_data_model(n) and n.interface.get("model_kind") == "constant"
    ]
    seen_names: set[str] = set()
    constants: list[dict] = []
    for n in constant_nodes:
        for c in n.interface.get("constants", []):
            if c["name"] in seen_names:
                warnings.append(
                    f"constant '{c['name']}' declared in node '{n.id}' collides "
                    f"with a same-named constant from another node -- keeping "
                    f"the first one encountered, skipping this one."
                )
                continue
            seen_names.add(c["name"])
            constants.append(c)
    return constants, warnings


def generate_models_file(dm_shapes: dict[str, list[dict]],
                          enum_defs: dict[str, dict] | None = None,
                          constants: list[dict] | None = None) -> str:
    """One @dataclass per data-model type, plus a dummy_X() factory for
    each — stub bodies call dummy_X() rather than inlining nested
    constructor calls everywhere. `dm_shapes` is collect_data_model_types()'s
    output directly -- already-resolved {name, annotation, dummy_expr,
    referenced_ids} field dicts, no parsing left to do here at all
    (Revision 3: this function used to call typedsl.py's
    parse_type_shape on a shape STRING; now every field already
    carries its own resolved annotation/dummy_expr).

    `enum_defs`/`constants` optional and additive, same as before:
    real `class X(Enum): ...` blocks (each with its own `dummy_X()`
    factory) and plain module-level constant assignments, appended
    after the dataclasses.
    """
    enum_defs = enum_defs or {}
    constants = constants or []

    # Types can reference each other (SettlementRound references
    # SettlementRecord) -- topologically order definitions so a type
    # is only referenced after it's defined. Each field's
    # referenced_ids are real node ids; map through derive_pascal to
    # compare against dataclass NAMES (the keys of dm_shapes).
    deps = {
        name: {derive_pascal(rid) for f in fields for rid in f["referenced_ids"]}
        for name, fields in dm_shapes.items()
    }

    ordered = []
    seen = set()
    def visit(name, stack):
        if name in seen:
            return
        if name not in dm_shapes:
            # A referenced name that isn't itself a dataclass shape --
            # e.g. an enum type (its own class block is emitted
            # separately below, unordered relative to these, since
            # enums can't reference dataclasses or each other in this
            # schema). Nothing to order or define here; the visitor
            # that reached this name already has what it needs.
            return
        if name in stack:
            raise TypeResolveError(f"Circular type reference involving {name}")
        for dep in sorted(deps.get(name, set())):
            if dep != name:
                visit(dep, stack | {name})
        seen.add(name)
        ordered.append(name)
    for name in sorted(dm_shapes):
        visit(name, set())

    lines = [
        '"""Auto-generated from graph.yaml — one dataclass + dummy',
        'factory per data-model node, plus one Enum class (+ dummy factory)',
        'per enum-kind data-model node and one module-level assignment per',
        'constant-kind data-model node. Regenerate with scaffold.py rather',
        'than hand-editing type shapes here (hand edits to field VALUES/',
        'logic elsewhere are fine and expected)."""',
        "",
        "from __future__ import annotations",
        "from dataclasses import dataclass",
        "from decimal import Decimal",
        "from datetime import datetime",
    ]
    if enum_defs:
        lines.append("from enum import Enum")
    lines.append("")

    for name in ordered:
        fields = dm_shapes[name]
        lines.append("@dataclass")
        lines.append(f"class {name}:")
        if not fields:
            lines.append("    pass")
        for f in fields:
            lines.append(f"    {f['name']}: {f['annotation']}")
        lines.append("")
        lines.append("")

    for name in ordered:
        fields = dm_shapes[name]
        args = ", ".join(f"{f['name']}={f['dummy_expr']}" for f in fields)
        lines.append(f"def dummy_{name}() -> {name}:")
        lines.append(f"    return {name}({args})")
        lines.append("")
        lines.append("")

    for name, enum_def in sorted(enum_defs.items()):
        lines.append(f"class {name}(Enum):")
        for member_name, value in enum_def["members"]:
            value_lit = repr(value) if enum_def["enum_type"] == "string" else str(value)
            lines.append(f"    {member_name} = {value_lit}")
        lines.append("")
        lines.append("")
        first_member = enum_def["members"][0][0]
        lines.append(f"def dummy_{name}() -> {name}:")
        lines.append(f"    return {name}.{first_member}")
        lines.append("")
        lines.append("")

    if constants:
        lines.append("# --- constants (from constant-kind data-model nodes) ---")
        for c in constants:
            comment = f"  # {c['notes']}" if c.get("notes") else ""
            ann = resolve_annotation({"type": c["type"]})  # canonical ("integer") -> Python ("int")
            lines.append(f"{c['name']}: {ann} = {c['value']!r}{comment}")
        lines.append("")

    return "\n".join(lines)


# ---------------------------------------------------------------- structure

def is_service_parent(node: Node, graph: Graph) -> bool:
    """True if this is a direct child of the backbone that itself has
    children (a 'service' package), vs. a direct child with no
    children of its own (a standalone top-level module, e.g.
    settlement_engine)."""
    return node.parent == graph.backbone and bool(graph.children_of(node.id))


def module_path_for(node: Node, graph: Graph, root_package: str = "app", stop_at: str | None = None) -> tuple[str, str]:
    """Returns (dotted_module_path, immediate_package_dir_relative_to_root).

    Walks the FULL ancestor chain from node.parent up to (but not
    including) `stop_at` (defaults to graph.backbone) -- e.g.
    ('app.auth_service.signup', 'auth_service') for a one-level-deep
    leaf, same as before this change. Previously this only ever looked
    at the IMMEDIATE parent, silently flattening any deeper
    python-module-under-python-module nesting to just the nearest
    parent's name -- a real limitation, found while building
    module_scaffold.py's `layout: folder` support (§ generate_project.py
    docs), which needed genuine multi-level nesting to produce a real
    folder tree at all. No graph this project has tested against
    nests more than one level deep, so this is a backward-compatible
    generalization, not a behavior change for any real graph checked
    so far -- verified directly (see module_scaffold.py's test).

    `root_package`/`stop_at` let a caller with a different root than
    "app"/graph.backbone reuse this function -- specifically,
    module_scaffold.py's folder-layout writer, which roots leaf
    functions under "services.<folder_module_id>" instead and stops
    climbing at the folder module itself (already included in
    root_package), not the graph's backbone.
    """
    stop_at = stop_at if stop_at is not None else graph.backbone
    parts: list[str] = []
    cur_id = node.parent
    while cur_id is not None and cur_id != stop_at:
        parts.append(cur_id)
        cur_id = graph.nodes[cur_id].parent if cur_id in graph.nodes else None
    parts.reverse()
    dotted_prefix = ".".join([root_package] + parts) if parts else root_package
    return f"{dotted_prefix}.{node.id}", (parts[-1] if parts else "")


# ---------------------------------------------------------------- one-file-per-data-model-node
# (Revision 3 proposal §7: "every node that isn't a pure organizational
# container gets its own generated file" -- module_scaffold.py's
# folder-layout writer uses these three functions for a data-model
# node's OWN file, separate from the single shared generate_models_file()
# above, which leaf-granularity still uses unchanged.)

def generate_single_dataclass_file(type_name: str, fields: list[dict],
                                    import_path_for_type: dict[str, str] | None = None,
                                    fallback_import_path: str = "services._scaffold_types") -> str:
    """One @dataclass + dummy_X() factory, in its OWN file -- the
    per-node counterpart to generate_models_file()'s all-in-one
    version. `import_path_for_type` maps a REFERENCED node id to its
    own generated file's dotted import path (populated by a caller
    that's already resolved every data-model node's location across
    the whole graph -- see module_scaffold.py's two-phase
    path-then-content approach); a referenced type with NO entry here
    falls back to `fallback_import_path` (the shared aggregate file) --
    NOT silently dropped, which was a real bug found by actually
    importing every generated module: a dataclass referencing a type
    still living in the shared file would previously get no import
    line for it at all."""
    import_path_for_type = import_path_for_type or {}
    referenced: set[str] = set()
    for f in fields:
        referenced |= f["referenced_ids"]

    lines = [
        f'"""Auto-generated from graph.yaml data-model node — one dataclass',
        f'+ dummy factory, in its own file (Revision 3 one-node-one-file).',
        f'Regenerate with module_scaffold.py rather than hand-editing the',
        f'shape here (hand edits to field VALUES/logic elsewhere are fine)."""',
        "",
        "from __future__ import annotations",
        "from dataclasses import dataclass",
        "from decimal import Decimal",
        "from datetime import datetime",
        "",
    ]
    # group referenced types by their import path so each source module
    # is imported once, not once per field
    by_path: dict[str, list[str]] = {}
    for rid in sorted(referenced):
        cls_name = derive_pascal(rid)
        path = import_path_for_type.get(rid, fallback_import_path)
        by_path.setdefault(path, []).append(cls_name)
        by_path.setdefault(path, []).append(f"dummy_{cls_name}")
    for path, names in sorted(by_path.items()):
        lines.append(f"from {path} import {', '.join(sorted(set(names)))}")
    if by_path:
        lines.append("")

    lines.append("@dataclass")
    lines.append(f"class {type_name}:")
    if not fields:
        lines.append("    pass")
    for f in fields:
        lines.append(f"    {f['name']}: {f['annotation']}")
    lines.append("")
    lines.append("")
    args = ", ".join(f"{f['name']}={f['dummy_expr']}" for f in fields)
    lines.append(f"def dummy_{type_name}() -> {type_name}:")
    lines.append(f"    return {type_name}({args})")
    lines.append("")
    return "\n".join(lines)


def generate_single_enum_file(type_name: str, enum_def: dict) -> str:
    """One `class X(Enum):` + dummy_X() factory, in its own file.
    Enums never reference other data-model nodes, so no cross-file
    import composition is needed here (unlike the dataclass case)."""
    lines = [
        f'"""Auto-generated from graph.yaml enum-kind data-model node."""',
        "",
        "from __future__ import annotations",
        "from enum import Enum",
        "",
        f"class {type_name}(Enum):",
    ]
    for member_name, value in enum_def["members"]:
        value_lit = repr(value) if enum_def["enum_type"] == "string" else str(value)
        lines.append(f"    {member_name} = {value_lit}")
    lines.append("")
    lines.append("")
    first_member = enum_def["members"][0][0]
    lines.append(f"def dummy_{type_name}() -> {type_name}:")
    lines.append(f"    return {type_name}.{first_member}")
    lines.append("")
    return "\n".join(lines)


def generate_single_constant_file(constants: list[dict]) -> str:
    """Plain module-level assignments for one constant-kind data-model
    node's `constants` list, in its own file. Never referenced as a
    TYPE by anything (a constant is a value), so -- like enums -- no
    cross-file import composition needed."""
    lines = [
        f'"""Auto-generated from graph.yaml constant-kind data-model node."""',
        "",
        "from __future__ import annotations",
        "",
    ]
    for c in constants:
        comment = f"  # {c['notes']}" if c.get("notes") else ""
        ann = resolve_annotation({"type": c["type"]})
        lines.append(f"{c['name']}: {ann} = {c['value']!r}{comment}")
    lines.append("")
    return "\n".join(lines)


def is_leaf_with_signature(node: Node) -> bool:
    """Revision 3: a leaf's 'signature' is just its params+returns
    being present -- both structured fields, not a string to check
    truthiness of. `returns` alone is the real gate (params legitimately
    can be an empty list for a no-arg function); function name defaults
    to node.id when `interface.name` isn't set (see PROTOCOL_REGISTRY's
    note on why the two are kept separate)."""
    return node.interface.get("protocol") == "function" and "returns" in node.interface


def func_name_for(node: Node) -> str:
    """The real function/method name to emit -- `interface.name` if
    set, else the node id. Kept as its own tiny function since this
    exact fallback is needed in several places (stub generation,
    wired-call composition, main.py route wiring)."""
    return node.interface.get("name") or node.id


# ---------------------------------------------------------------- stub files

def generate_stub_file(node: Node, graph: Graph, mode: str,
                        import_path_for=None, models_import_path: str = "app.models",
                        type_import_path: dict[str, str] | None = None) -> str:
    """`import_path_for(node, graph) -> str` resolves a leaf node's own
    real import path AND each of its wired dependencies' import paths
    -- defaults to this file's own module_path_for (leaf-granularity's
    one-file-per-function convention rooted at "app"). module_scaffold.py's
    `layout: folder` writer passes its own resolver, since a folder
    module's leaves live under "services.<folder_id>...", not "app.".
    `models_import_path` is the equivalent for the shared types file --
    "app.models" by default, "services._scaffold_types" for module mode
    (matching generate_module_file's own existing import string there).
    `type_import_path` (Revision 3) is an optional per-node-id override
    on top of that: a referenced data-model node that got its OWN file
    (module_scaffold.py's folder-layout writer, one-node-one-file) is
    looked up here FIRST; only a referenced type with no entry here
    falls back to the single `models_import_path` string. Without this,
    a folder-organized data-model's own generated file works fine, but
    every FUNCTION that references it would still hardcode the old
    single shared-file import -- a real bug, found by actually
    importing every generated module and watching several fail with
    "cannot import name X from _scaffold_types", not by inspection.

    Revision 3: no more `known_types` parameter at all -- there's
    nothing left to parse. `node.interface["params"]`/`["returns"]`
    are already resolved type descriptors; type_resolve's functions
    turn each one directly into an annotation/dummy_expr/referenced
    node ids, with no string grammar in between.
    """
    if import_path_for is None:
        def import_path_for(n, g):
            mod, _ = module_path_for(n, g)
            return mod

    params = node.interface.get("params", [])
    returns = node.interface["returns"]
    fname = func_name_for(node)

    ret_annotation = resolve_annotation(returns)
    ret_dummy = resolve_dummy_expr(returns)
    referenced = set(referenced_node_ids(returns))
    for p in params:
        referenced |= referenced_node_ids(p["type"])

    # Separately track which dummy_X() FACTORY functions actually get
    # CALLED in the generated body (return statement, and any wired
    # dependency-call arguments that happen to be custom-typed) — these
    # need their own import; `referenced` above only covers the
    # dataclass names used in type ANNOTATIONS, which is a different set.
    dummy_factories_needed: set[str] = set(referenced_node_ids(returns))
    needs_decimal = "Decimal(" in ret_dummy or any("Decimal(" in resolve_dummy_expr(p["type"]) for p in params)
    needs_datetime = "datetime(" in ret_dummy or any("datetime(" in resolve_dummy_expr(p["type"]) for p in params)

    header_lines = [
        f'"""',
        f"STUB for graph node '{node.id}' — {node.title}",
        f"See graph.yaml for the full contract: interface, tests,",
        f"stub_behavior, and notes (including any PROPOSED defaults this",
        f"function's real implementation should honor).",
        f'"""',
        "",
        "from __future__ import annotations",
    ]

    dep_imports = []
    dep_calls = []
    dep_dummy_args_all: list[str] = []
    if mode == "wired":
        for dep_id in node.dep_ids:
            dep_node = graph.nodes.get(dep_id)
            if dep_node is None or not is_leaf_with_signature(dep_node):
                continue
            dep_mod = import_path_for(dep_node, graph)
            dep_fname = func_name_for(dep_node)
            dep_params = dep_node.interface.get("params", [])
            # Always alias by node id, never import the bare function
            # name -- a REAL bug found by actually running the
            # generated wiring test: when multiple dependencies
            # legitimately share a function name (e.g. three storage
            # backends all named `save`, via `interface.name` -- see
            # PROTOCOL_REGISTRY's note on why that's a real, intended
            # pattern), separate `from X import save` statements all
            # bind the SAME local name, so only the last import
            # survives and every "distinct" call silently invokes the
            # same function three times. Aliasing by node id (always
            # unique) fixes this unconditionally rather than only
            # when a collision happens to be detected.
            dep_imports.append(f"from {dep_mod} import {dep_fname} as {dep_id}")
            dummy_args = ", ".join(resolve_dummy_expr(p["type"]) for p in dep_params)
            dep_dummy_args_all.append(dummy_args)
            # a dependency's own params might themselves be custom-typed
            # (dummy_expr = "dummy_X()") -- those need importing too.
            for p in dep_params:
                dummy_factories_needed |= referenced_node_ids(p["type"])
            dep_calls.append(
                f"    _ = {dep_id}({dummy_args})  "
                f"# wired call to '{dep_id}' — dummy args, proves the import + call succeed"
            )

    # needs_decimal/needs_datetime must account for BOTH this node's
    # own signature AND any wired dependency call's dummy arguments —
    # a node whose own signature never mentions Decimal can still need
    # the import if a dependency it calls takes one (this was a real
    # bug: edit_expense has no Decimal in its own signature but calls
    # calculate_equal_split(Decimal("0"), ...) as a wired dependency).
    needs_decimal = needs_decimal or any("Decimal(" in args for args in dep_dummy_args_all)
    needs_datetime = needs_datetime or any("datetime(" in args for args in dep_dummy_args_all)

    lines = list(header_lines)
    if needs_decimal:
        lines.append("from decimal import Decimal")
    if needs_datetime:
        lines.append("from datetime import datetime")

    if referenced or dummy_factories_needed:
        type_import_path = type_import_path or {}
        by_path: dict[str, list[str]] = {}
        for t in referenced:
            by_path.setdefault(type_import_path.get(t, models_import_path), []).append(derive_pascal(t))
        for t in dummy_factories_needed:
            by_path.setdefault(type_import_path.get(t, models_import_path), []).append(f"dummy_{derive_pascal(t)}")
        for path, names in sorted(by_path.items()):
            lines.append(f"from {path} import {', '.join(sorted(set(names)))}")

    lines.extend(sorted(set(dep_imports)))
    lines.append("")
    lines.append("")

    params_str = ", ".join(f"{p['name']}: {resolve_annotation(p['type'])}" for p in params)
    lines.append(f"def {fname}({params_str}) -> {ret_annotation}:")
    lines.append(f'    """STUB — not yet implemented. See graph.yaml node \'{node.id}\'."""')
    if mode == "wired" and dep_calls:
        lines.extend(dep_calls)
    lines.append(f"    return {ret_dummy}")
    lines.append("")

    return "\n".join(lines)


# ---------------------------------------------------------------- FastAPI main.py

def generate_main_file(graph: Graph, import_path_for=None) -> str:
    """Wires a FastAPI endpoint for every python-function leaf node
    that declares BOTH `interface.http_method` and `interface.route`
    -- these are real graph fields now, not a hardcoded table (see
    graph-model.js's PROTOCOL_REGISTRY: python-function's `fields` now
    includes both).

    THE BUG THIS REPLACES: this function used to loop over a literal
    ROUTE_MAP constant -- 9 hardcoded (method, path, node_id) tuples
    hand-written for one specific historical graph, silently skipping
    any node_id not in that list with no warning. Confirmed directly:
    against kharcha-tracker-v2.yaml, only 2 of its 13 real leaf
    functions (signup, login) happened to match a ROUTE_MAP entry by
    name -- the other 11 (four CRUD methods x two storage backends,
    plus 3 more auth functions) silently got no endpoint at all, for
    a graph that never had any relationship to whatever produced
    ROUTE_MAP's original 9 entries. A graph is supposed to be the
    single source of truth this whole toolchain reads from -- a
    Python-code route table that doesn't move when the graph does is
    exactly the kind of drift this project exists to eliminate.

    `import_path_for(node, graph) -> str` resolves a leaf node's real
    importable module path. Defaults to this file's own module_path_for
    (one file per leaf function). module_scaffold.py passes its OWN
    resolver, since it groups multiple functions into one file per
    parent module/class node -- a different import path shape entirely,
    and module_path_for's assumption (own file per leaf) would produce
    an import statement pointing at a file that doesn't exist there.
    """
    if import_path_for is None:
        def import_path_for(node, graph):
            mod, _ = module_path_for(node, graph)
            return mod

    lines = [
        '"""',
        "Auto-generated FastAPI app wiring REST endpoints to the generated",
        "stub functions, driven entirely by each leaf node's own",
        "interface.http_method/interface.route fields in graph.yaml --",
        "not a hardcoded table. Every handler currently returns whatever",
        "its underlying stub returns (a dummy value) — this file exists",
        "so you can actually run the server and curl an endpoint to see",
        "the real call graph execute, even before any real logic exists.",
        '"""',
        "",
        "from __future__ import annotations",
        "from fastapi import FastAPI",
        "",
    ]

    imports = []
    routes = []
    route_nodes = [
        n for n in graph.nodes.values()
        if n.interface.get("protocol") == "function"
        and n.interface.get("http_method") and n.interface.get("route")
    ]
    route_nodes.sort(key=lambda n: n.id)  # deterministic output, not insertion-order-dependent
    for node in route_nodes:
        if not is_leaf_with_signature(node):
            continue
        mod = import_path_for(node, graph)
        fname = func_name_for(node)
        params = node.interface.get("params", [])
        imports.append(f"from {mod} import {fname}")
        py_method = node.interface["http_method"].lower()
        path = node.interface["route"]
        # naive path-param passthrough isn't attempted here -- these
        # are thin illustrative wrappers, not a real request-parsing
        # layer. Flagged in the module docstring above too.
        routes.append(f'@app.{py_method}("{path}")')
        routes.append(f"def {fname}_endpoint():")
        routes.append(f'    """Illustrative only — does not parse real request params yet."""')
        dummy_args = ", ".join(resolve_dummy_expr(p["type"]) for p in params)
        routes.append(f"    return {fname}({dummy_args})")
        routes.append("")

    lines.extend(sorted(set(imports)))
    lines.append("")
    lines.append("app = FastAPI(title=\"" + (graph.project or "Generated API") + "\")")
    lines.append("")
    lines.extend(routes)

    return "\n".join(lines)


# ---------------------------------------------------------------- wiring test

def generate_wiring_test_file(graph: Graph) -> str:
    """The actual 'test the communication layer' deliverable: for every
    node with at least one dependency, patch each dependency's real
    function and assert it gets called when the parent stub runs.
    Only meaningful against --mode wired output."""

    lines = [
        '"""',
        "Auto-generated wiring/communication tests. These do NOT test",
        "business logic (everything is still a dummy-returning stub) --",
        "they test that the call graph itself is correctly wired: that",
        "each node actually calls its declared dependencies. Only",
        "meaningful if the project was scaffolded with --mode wired.",
        '"""',
        "",
        "from unittest.mock import patch",
    ]

    test_count = 0
    body_lines: list[str] = []
    needs_decimal = False
    needs_datetime = False
    for node in graph.nodes.values():
        if not is_leaf_with_signature(node):
            continue
        real_deps = [d for d in node.dep_ids if graph.nodes.get(d) and is_leaf_with_signature(graph.nodes[d])]
        if not real_deps:
            continue

        mod, _ = module_path_for(node, graph)
        fname = func_name_for(node)
        params = node.interface.get("params", [])
        dummy_args = ", ".join(resolve_dummy_expr(p["type"]) for p in params)
        if "Decimal(" in dummy_args:
            needs_decimal = True
        if "datetime(" in dummy_args:
            needs_datetime = True

        test_count += 1
        body_lines.append(f"def test_{node.id}_calls_its_dependencies():")
        indent = "    "
        withs = []
        for dep_id in real_deps:
            # Patch target must match generate_stub_file()'s actual
            # bound name -- it always aliases dependency imports by
            # node id now (see that function's comment on why: a
            # bare function-name import breaks when two dependencies
            # legitimately share a name, e.g. three storage backends
            # all named `save`). Patching "{mod}.{dep_fname}" here
            # would silently patch nothing (that name was never bound
            # in the caller's module at all) -- must be "{mod}.{dep_id}".
            withs.append(f'{indent}with patch("{mod}.{dep_id}") as mock_{dep_id}:')
            indent += "    "
        body_lines.extend(withs)
        body_lines.append(f"{indent}from {mod} import {fname}")
        body_lines.append(f"{indent}{fname}({dummy_args})")
        for dep_id in real_deps:
            body_lines.append(f"{indent}assert mock_{dep_id}.called, "
                         f'"{node.id} should call {dep_id} but did not"')
        body_lines.append("")

    if needs_decimal:
        lines.append("from decimal import Decimal")
    if needs_datetime:
        lines.append("from datetime import datetime")
    lines.append("")
    lines.extend(body_lines)

    if test_count == 0:
        lines.append("# No node had a dependency on another leaf with a signature --")
        lines.append("# nothing to wire-test yet.")

    return "\n".join(lines)


# ---------------------------------------------------------------- driver

def scaffold(graph_path: Path, out_dir: Path, mode: str):
    graph = Graph.load(graph_path)

    enum_defs, enum_warnings = collect_enum_types(graph)
    for w in enum_warnings:
        print(f"WARNING: {w}")

    dm_shapes, dm_warnings = collect_data_model_types(graph)
    for w in dm_warnings:
        print(f"WARNING: {w}")

    constants, constant_warnings = collect_constant_declarations(graph)
    for w in constant_warnings:
        print(f"WARNING: {w}")

    app_dir = out_dir / "app"
    tests_dir = out_dir / "tests"
    app_dir.mkdir(parents=True, exist_ok=True)
    tests_dir.mkdir(parents=True, exist_ok=True)
    (app_dir / "__init__.py").write_text("")

    (app_dir / "models.py").write_text(generate_models_file(dm_shapes, enum_defs, constants))

    # Derive each leaf's REAL target directory directly from its full
    # dotted module path (module_path_for's first return value), not
    # just the single last path segment (its second return value,
    # `pkg_dir`) -- using only `pkg_dir` here silently flattened any
    # nesting deeper than one level to a single top-level folder
    # (e.g. 'app.storage_service.flat_file_backend.flat_file_list'
    # would create 'app/flat_file_backend/', dropping 'storage_service'
    # entirely) even though module_path_for itself already computes the
    # correct full nested path. A real, previously-latent bug -- found
    # by actually generating and running a genuinely two-level-nested
    # real graph, not by inspection.
    package_dirs: set[str] = set()
    for node in graph.nodes.values():
        if not is_leaf_with_signature(node):
            continue
        dotted, _ = module_path_for(node, graph)
        parts = dotted.split(".")[1:-1]  # drop "app" prefix and the leaf's own filename
        if parts:
            package_dirs.add("/".join(parts))

    for pkg in package_dirs:
        pkg_path = app_dir / pkg
        # every intermediate directory needs its own __init__.py, not
        # just the leaf-most one, or the package chain doesn't import.
        d = app_dir
        for part in pkg.split("/"):
            d = d / part
            d.mkdir(exist_ok=True)
            init = d / "__init__.py"
            if not init.exists():
                init.write_text("")

    for node in graph.nodes.values():
        if not is_leaf_with_signature(node):
            continue
        dotted, _ = module_path_for(node, graph)
        parts = dotted.split(".")[1:-1]
        target_dir = app_dir.joinpath(*parts) if parts else app_dir
        (target_dir / f"{node.id}.py").write_text(generate_stub_file(node, graph, mode))

    (app_dir / "main.py").write_text(generate_main_file(graph))
    (tests_dir / "__init__.py").write_text("")
    (tests_dir / "test_wiring.py").write_text(generate_wiring_test_file(graph))
    (out_dir / "requirements.txt").write_text("fastapi\nuvicorn\npytest\n")

    return graph, package_dirs


if __name__ == "__main__":
    ap = argparse.ArgumentParser(description="Generate a Python project scaffold from a graph_runner YAML file.")
    ap.add_argument("graph_file", type=Path)
    ap.add_argument("out_dir", type=Path)
    ap.add_argument("--mode", choices=["flat", "wired"], default="wired")
    args = ap.parse_args()

    graph, pkgs = scaffold(args.graph_file, args.out_dir, args.mode)
    leaf_count = sum(1 for n in graph.nodes.values() if is_leaf_with_signature(n))
    print(f"Scaffolded {leaf_count} leaf modules across {len(pkgs)} service packages -> {args.out_dir}")
    print(f"Mode: {args.mode}")
