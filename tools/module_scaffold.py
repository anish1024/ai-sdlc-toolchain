"""
scaffolder/module_scaffold.py — a coarser-grained scaffolder than
scaffold.py: every node with interface.protocol == 'python-module' OR
'class' becomes ONE FILE, and its functions become stubs INSIDE that
file (scaffold.py instead makes one file per leaf function — a different,
also-valid granularity choice for a different purpose; this tool is
for a "service.py with several functions" shape).

'class' nodes go through the exact same kharcha-style rendering path
as 'python-module' -- a class's real substance is its python-function
children (same `parent` mechanism), same as a module's. 'contract'
nodes are NOT included: a contract's `methods` are structural
signatures, not function bodies to stub, and generating a real Python
ABC/Protocol from them is a new capability this pass didn't attempt
(no way to verify it against typedsl.py in this environment -- see
this project's README).

Handles TWO real conventions, verified against real graphs, not just
assumed to be the same shape:

  KHARCHA-STYLE (hand-authored, top-down build):
    A python-module node (e.g. auth_service) has no functions of its
    own — its `dependencies` list points at separate python-function
    leaf nodes, each with a real `interface.signature` in the small
    DSL parsed by typedsl.py. Those dependencies become the file's
    functions.

  A2D-STYLE (mechanically imported from an existing repo):
    EVERY node is python-module, `parent` is always null (flat, no
    hierarchy), and a node's own functions/classes live directly in
    `interface.exports` (a list of {kind, name, signature} — where
    `signature` is a free-text string like "class Foo [def bar(...)]",
    NOT the parseable DSL typedsl.py handles). These are emitted as
    descriptive stubs without a fully type-checked Python signature,
    since the source data isn't structured enough for that — printing
    a confidently-wrong parsed signature would be worse than an
    honest free-text one.

Every function stub's docstring embeds the source node's (or, for
a2d-style modules, the whole module's) `notes` field inside a clearly
delimited "OPENCODE PROMPT" block — this is meant to be mechanically
extractable later and fed to opencode_bridge.build_prompt() as extra
context when a real implementation pass runs.

Dotted node ids (a2d's `server.tasks.router` etc.) become nested
directories under services/ (services/server/tasks/router.py), not a
literal dotted filename — keeps the output an importable Python
package. Kharcha's flat ids degrade to a flat services/*.py file.
"""

from __future__ import annotations

import argparse
from pathlib import Path

from graph_runner import Graph, Node
from type_resolve import resolve_annotation, referenced_node_ids, derive_pascal
from scaffold import (
    generate_models_file, collect_data_model_types, collect_enum_types,
    collect_constant_declarations, generate_main_file, generate_stub_file,
    is_leaf_with_signature, is_data_model, data_model_type_name, resolve_model_fields,
    generate_single_dataclass_file, generate_single_enum_file, generate_single_constant_file,
)


PROMPT_START = "--- OPENCODE PROMPT (from graph notes) ---"
PROMPT_END = "--- END PROMPT ---"


def inferred_layout(node: Node, graph: Graph) -> str:
    """Mirrors graph-model.js's inferredLayout exactly -- a module is
    layout: folder unless EVERY direct child is protocol 'function'
    (vacuously 'file' with zero children too). If `interface.layout`
    is explicitly set, that's honored as-is (validate_graph.py enforces
    the invariant as an error, not this function).

    THE BUG THIS FIXES: this rule was built and documented -- in the
    JS editor's own inferredLayout(), in validate_graph.py's check 3g
    docstring, in the accepted Revision 3 proposal -- but never
    actually WIRED into this file's own folder-vs-file decision, which
    checked ONLY for the literal string 'folder' everywhere. A module
    with layout unset (the common case -- layout is supposed to be an
    optional override, not something you set every time) and any
    non-function child (e.g. a module of data-model nodes) silently
    stayed file-style, producing an empty placeholder for real content
    that should have gotten its own files. Found by actually generating
    and inspecting a real module's output, not by inspection of this
    function alone."""
    layout = node.interface.get("layout")
    if layout:
        return layout
    children = graph.children_of(node.id)
    all_functions = all(c.interface.get("protocol") == "function" for c in children)
    return "file" if all_functions else "folder"


def file_path_for(node_id: str, base: Path, all_ids: set[str]) -> Path:
    """Dotted id -> nested path under `base`; flat id -> flat file.

    Special case, found by actually testing against a2d (not
    theoretical): if `node_id` is itself a dotted-prefix of some OTHER
    node id (e.g. 'models' is a prefix of 'models.action_item'), then
    both a `models.py` file AND a `models/` directory would exist
    side by side. Python's import system silently prefers the
    package over the same-named module in that case — `models.py`'s
    content becomes permanently unreachable dead code with no error
    raised anywhere. Fix: when this happens, the prefix node's own
    content goes in that package's `__init__.py` instead of a
    sibling `.py` file, so there's only ever one real `services.models`."""
    parts = node_id.split(".")
    is_a_package_prefix = any(other != node_id and other.startswith(node_id + ".") for other in all_ids)
    if is_a_package_prefix:
        return base.joinpath(*parts, "__init__.py")
    return base.joinpath(*parts[:-1], f"{parts[-1]}.py")


def render_prompt_block(notes: str | None, indent: str) -> list[str]:
    if not notes or not notes.strip():
        return []
    lines = [f"{indent}{PROMPT_START}"]
    for line in notes.strip().splitlines():
        lines.append(f"{indent}{line}")
    lines.append(f"{indent}{PROMPT_END}")
    return lines


def render_kharcha_style_function(dep_node: Node) -> tuple[list[str], set[str]]:
    """dep_node is a `function` leaf with structured params/returns
    (Revision 3 -- no more free-text signature to parse; type_resolve
    turns each descriptor directly into an annotation, no `known` set
    needed at all, since a reference IS a real node id, trusted here
    the same way scaffold.py's collect_data_model_types now trusts it).
    Returns (lines, referenced_node_ids) so the caller can emit a
    correct `from services._scaffold_types import ...` line —
    annotations are stringified by `from __future__ import annotations`
    so a MISSING import wouldn't actually break a plain import, but it
    WOULD break anything that later calls typing.get_type_hints() on
    these stubs, so it's worth getting right rather than relying on
    that loophole."""
    fname = dep_node.interface.get("name") or dep_node.id
    params = dep_node.interface.get("params", [])
    returns = dep_node.interface.get("returns")
    referenced: set[str] = set()

    if returns is None:
        header = f"def {dep_node.id}(*args, **kwargs):  # no returns declared yet"
    else:
        for p in params:
            referenced |= referenced_node_ids(p["type"])
        referenced |= referenced_node_ids(returns)
        params_str = ", ".join(f"{p['name']}: {resolve_annotation(p['type'])}" for p in params)
        header = f"def {fname}({params_str}) -> {resolve_annotation(returns)}:"
    body = f"    raise NotImplementedError({dep_node.id!r})"

    lines = [header]
    lines.append(f'    """')
    lines.append(f"    {dep_node.title}")
    lines.append("")
    if dep_node.stub_behavior:
        lines.append(f"    Stub behavior: {dep_node.stub_behavior.strip()}")
        lines.append("")
    prompt_lines = render_prompt_block(dep_node.notes, "    ")
    if prompt_lines:
        lines.extend(prompt_lines)
        lines.append("")
    lines.append(f'    """')
    lines.append(body)
    lines.append("")
    return lines, referenced


def render_a2d_style_export(export: dict, module_notes: str | None) -> list[str]:
    """export is a raw {kind, name, signature} dict from interface.exports
    (free-text signature, not parseable — see module docstring)."""
    kind = export.get("kind", "function")
    name = export.get("name", "unknown")
    raw_sig = export.get("signature", "")

    if kind == "class":
        lines = [f"class {name}:"]
        lines.append(f'    """')
        lines.append(f"    Imported class — original signature: {raw_sig}")
        lines.append(f"    (Free-text from mechanical import — not a parsed contract.")
        lines.append(f"    Review before treating this as authoritative.)")
        lines.append(f'    """')
        lines.append("    pass")
        lines.append("")
        return lines

    lines = [f"def {name}(*args, **kwargs):  # original signature: {raw_sig}"]
    lines.append(f'    """')
    lines.append(f"    Imported function — original signature: {raw_sig}")
    lines.append(f"    (Free-text from mechanical import — not a parsed contract.")
    lines.append(f"    Review before treating this as authoritative.)")
    lines.append(f'    """')
    lines.append(f"    raise NotImplementedError({name!r})")
    lines.append("")
    return lines


def generate_module_file(node: Node, graph: Graph, type_import_path: dict[str, str] | None = None) -> tuple[str, set[str]]:
    type_import_path = type_import_path or {}
    lines = [
        f'"""',
        f"Generated from graph node '{node.id}' — {node.title or ''}",
        f"See the source graph.yaml for the authoritative contract; this file",
        f"is a scaffold with empty stubs, not a finished implementation.",
        f'"""',
        "",
        "from __future__ import annotations",
    ]

    dep_nodes = [graph.nodes[d] for d in node.dep_ids if d in graph.nodes]
    # Revision 3: "has a real signature" is "protocol function AND
    # returns is present" (see scaffold.py's is_leaf_with_signature) --
    # not the old `interface.get("signature")` truthiness check.
    kharcha_style_deps = [d for d in dep_nodes if d.interface.get("protocol") == "function" and "returns" in d.interface]

    all_referenced: set[str] = set()
    body_lines: list[str] = []

    if kharcha_style_deps:
        for dep in kharcha_style_deps:
            func_lines, referenced = render_kharcha_style_function(dep)
            body_lines.extend(func_lines)
            body_lines.append("")
            all_referenced |= referenced
    elif node.interface.get("exports"):
        module_prompt = render_prompt_block(node.notes, "")
        if module_prompt:
            body_lines.append('"""')
            body_lines.extend(module_prompt)
            body_lines.append('"""')
            body_lines.append("")
        for export in node.interface["exports"]:
            body_lines.extend(render_a2d_style_export(export, node.notes))
            body_lines.append("")
    else:
        body_lines.append("# No dependencies and no exports found for this module node.")
        body_lines.append("# Nothing to stub yet -- check the source graph.yaml.")
        body_lines.append("")

    if all_referenced:
        # Revision 3: each referenced data-model node may now have its
        # OWN file (see write_folder_module's data-model branch) rather
        # than always living in the shared `_scaffold_types.py` -- so
        # this groups referenced ids by their ACTUAL resolved import
        # path (type_import_path), emitting one import line per source
        # file, rather than a single hardcoded
        # `from services._scaffold_types import ...` line regardless of
        # where each type really ended up. Falls back to
        # `services._scaffold_types` for anything not in the map (a
        # node whose data-model wasn't organized under any folder --
        # still aggregated the old way), so nothing breaks for graphs
        # that don't use folder layout at all.
        by_path: dict[str, list[str]] = {}
        for rid in sorted(all_referenced):
            cls_name = derive_pascal(rid)
            path = type_import_path.get(rid, "services._scaffold_types")
            by_path.setdefault(path, []).extend([cls_name, f"dummy_{cls_name}"])
        for path, names in sorted(by_path.items()):
            lines.append(f"from {path} import {', '.join(sorted(set(names)))}")

    lines.append("")
    lines.extend(body_lines)

    return "\n".join(lines), all_referenced


def discover_folder_module(container: Node, dir_path: Path, package: str,
                            graph: Graph, leaf_module_path: dict[str, str],
                            type_import_path: dict[str, str],
                            pending: list[tuple[str, Node, Path]]) -> None:
    """Phase 1 of a `layout: folder` module's generation: creates the
    real directories/__init__.py files, populates `leaf_module_path`/
    `type_import_path` for everything found (functions, data-models),
    and appends a (kind, node, target_path) tuple to the SHARED
    `pending` list for each file that still needs its actual content
    written -- but does NOT write any content yet.

    THE BUG THIS FIXES: an earlier version of this rendered content
    immediately, per folder, which meant cross-references only worked
    in the direction "already-processed folder referenced by a
    not-yet-processed one" -- reordering file-style-vs-folder-style
    processing to fix one direction broke the other (confirmed by a
    real regression: `save_record`, once correctly promoted to
    folder-style, depends on `in_memory_save` etc. living in file-style
    modules -- whichever style was processed second had unresolved
    paths). The only correct fix is discovering EVERY node's target
    path -- across BOTH file-style and folder-style containers, the
    whole graph -- before rendering ANY content anywhere. See
    scaffold_modules() for the full two-phase call sequence this
    function is one half of.

    Each DIRECT child is handled according to its OWN kind, not forced
    into folder style just because its container is:
      - a function leaf -> its own file (pending as "function").
      - a data-model node -> its own file (pending as "data-model") --
        Revision 3's one-node-one-file principle (§7 of the accepted
        proposal). This is what closes the `constants`-module gap.
      - a module with layout: folder (explicit or inferred) -> recurse.
      - anything else that's a container (a plain module, i.e.
        layout: file/absent -- the default -- or a class) -> ONE file
        for that whole child subtree (pending as "collapsed"), exactly
        as if it were a top-level file-style module. A folder module
        does not force everything beneath it into folder style too.
    """
    dir_path.mkdir(parents=True, exist_ok=True)
    init = dir_path / "__init__.py"
    if not init.exists():
        init.write_text("")

    for child in graph.children_of(container.id):
        proto = child.interface.get("protocol")
        if proto == "function" and is_leaf_with_signature(child):
            leaf_module_path[child.id] = f"{package}.{child.id}"
            pending.append(("function", child, dir_path / f"{child.id}.py"))
        elif proto == "data-model":
            type_import_path[child.id] = f"{package}.{child.id}"
            pending.append(("data-model", child, dir_path / f"{child.id}.py"))
        elif proto == "module" and inferred_layout(child, graph) == "folder":
            discover_folder_module(
                child, dir_path / child.id, f"{package}.{child.id}",
                graph, leaf_module_path, type_import_path, pending,
            )
        elif proto in ("module", "class"):
            for leaf in graph.children_of(child.id):
                if leaf.interface.get("protocol") == "function":
                    leaf_module_path[leaf.id] = f"{package}.{child.id}"
            pending.append(("collapsed", child, dir_path / f"{child.id}.py"))


def render_pending(pending: list[tuple[str, Node, Path]], graph: Graph,
                    leaf_module_path: dict[str, str], type_import_path: dict[str, str],
                    enum_defs: dict[str, dict]) -> set[str]:
    """Phase 2: now that EVERY node's target path is known (both
    file-style and folder-style, the whole graph), actually render and
    write each pending item's content. Returns the union of every
    referenced-type-id set, for the caller's shared-aggregate
    exclusion logic (see scaffold_modules())."""
    def _resolver(n: Node, g: Graph) -> str:
        return leaf_module_path[n.id]

    all_referenced: set[str] = set()
    for kind, node, target in pending:
        if kind == "function":
            content = generate_stub_file(
                node, graph, mode="wired",
                import_path_for=_resolver, models_import_path="services._scaffold_types",
                type_import_path=type_import_path,
            )
            target.write_text(content)
        elif kind == "data-model":
            content, referenced = render_single_data_model_file(node, graph, type_import_path, enum_defs)
            target.write_text(content)
            all_referenced |= referenced
        elif kind == "collapsed":
            content, referenced = generate_module_file(node, graph, type_import_path)
            target.write_text(content)
            all_referenced |= referenced
    return all_referenced


def render_single_data_model_file(node: Node, graph: Graph, type_import_path: dict[str, str],
                                   enum_defs: dict[str, dict]) -> tuple[str, set[str]]:
    """Dispatches ONE data-model node to the right scaffold.py
    generate_single_*() function based on its model_kind, and reports
    which OTHER node ids it references (for the caller's own
    referenced-types bookkeeping -- mirrors generate_module_file's
    return shape)."""
    model_kind = node.interface.get("model_kind")
    type_name = data_model_type_name(node)
    warnings: list[str] = []
    if model_kind == "enum":
        enum_def = enum_defs.get(type_name)
        if enum_def is None:
            return f'"""No enum_values found for {type_name}."""\n', set()
        return generate_single_enum_file(type_name, enum_def), set()
    if model_kind == "constant":
        return generate_single_constant_file(node.interface.get("constants", [])), set()
    # dto / db_schema
    fields = resolve_model_fields(node, warnings)
    for w in warnings:
        print(f"WARNING: {w}")
    referenced = {rid for f in fields for rid in f["referenced_ids"]}
    return generate_single_dataclass_file(type_name, fields, type_import_path), referenced


def scaffold_modules(graph_path: Path, out_dir: Path) -> tuple[Graph, list[str]]:
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

    services_base = out_dir / "services"
    services_base.mkdir(parents=True, exist_ok=True)

    RESERVED_TYPES_FILENAME = "_scaffold_types.py"

    written = []
    # "class" is included alongside "module" -- a class node's own
    # children are function leaves via the exact same `parent`
    # mechanism a module's kharcha-style dependencies already use
    # (render_kharcha_style_function doesn't care whether its caller
    # found the dep via a module or a class parent), so class nodes go
    # through this exact same one-file code path, not a separate one.
    # `contract` nodes are deliberately NOT included here -- a contract
    # has no function children to stub (its `methods` are structural
    # signatures, not code with a body); generating a real Python
    # ABC/Protocol from `interface.methods` is Phase 3.2b, not this pass.
    #
    # Split into file-style (today's behavior: one file, layout absent
    # or "file") and folder-style (layout: "folder", `module` only --
    # validate_graph.py's check 3g already rejects layout on a class).
    # A folder-style node's OWN top-level entry is handled by
    # write_folder_module below, not this loop -- but any node that is
    # itself the CHILD of some other folder-style node's subtree is
    # ALSO excluded here, since write_folder_module recurses into and
    # renders those itself; double-rendering them here would silently
    # produce two different files for the same node.
    all_module_nodes = [n for n in graph.nodes.values() if n.interface.get("protocol") in ("module", "class")]
    folder_roots = [n for n in all_module_nodes if n.interface.get("protocol") == "module" and inferred_layout(n, graph) == "folder"]

    def _under_a_folder_root(n: Node) -> bool:
        cur = graph.nodes.get(n.parent)
        while cur is not None:
            if cur.interface.get("protocol") == "module" and inferred_layout(cur, graph) == "folder":
                return True
            cur = graph.nodes.get(cur.parent)
        return False

    folder_root_ids = {n.id for n in folder_roots}
    module_nodes = [n for n in all_module_nodes if n.id not in folder_root_ids and not _under_a_folder_root(n)]

    leaf_module_path: dict[str, str] = {}  # EVERY function leaf's id -> its dotted import path, regardless of file- or folder-style container. Single source of truth for main.py's route resolver AND for wired-dependency resolution across the file/folder boundary in either direction.
    type_import_path: dict[str, str] = {}  # EVERY data-model node id that got its OWN file (i.e. organized under a folder-style module) -> its dotted import path. A data-model node NOT in this dict is still in the shared _scaffold_types.py aggregate, unchanged from before.
    pending: list[tuple[str, Node, Path]] = []  # every (kind, node, target_path) still needing its content written -- across BOTH file-style and folder-style containers, discovered in full before any of them are rendered. See discover_folder_module's docstring for the real regression this two-phase split fixes.

    # --- Phase 1: discover EVERY node's target path, write nothing yet ---

    # A function can be a DIRECT child of the entrypoint itself
    # (entrypoint's own allowedChildren includes "function", not just
    # "module") -- a real case found by hitting it, not by inspection:
    # such a function belongs to no module at all, so it was never
    # discovered by either loop below. Treated as living at the
    # services/ root, one file per function, same as any other
    # loose leaf would.
    backbone = graph.nodes.get(graph.backbone)
    if backbone and backbone.interface.get("protocol") == "entrypoint":
        for child in graph.children_of(backbone.id):
            if child.interface.get("protocol") == "function" and is_leaf_with_signature(child):
                leaf_module_path[child.id] = f"services.{child.id}"
                pending.append(("function", child, services_base / f"{child.id}.py"))

    all_ids = {n.id for n in module_nodes}
    for node in module_nodes:
        target = file_path_for(node.id, services_base, all_ids)
        if target.name == RESERVED_TYPES_FILENAME:
            raise ValueError(
                f"Node '{node.id}' would generate a file named {RESERVED_TYPES_FILENAME}, "
                f"which is reserved for this tool's own shared type definitions. Rename "
                f"the node or the reserved filename to avoid a silent collision."
            )
        target.parent.mkdir(parents=True, exist_ok=True)
        d = target.parent
        while True:
            init = d / "__init__.py"
            if not init.exists():
                init.write_text("")
            if d == services_base:
                break
            d = d.parent

        rel = target.relative_to(out_dir)
        parts = list(rel.parts)
        parts = parts[:-1] if parts[-1] == "__init__.py" else parts[:-1] + [parts[-1][:-3]]
        dotted = ".".join(parts)
        for leaf in graph.children_of(node.id):
            if leaf.interface.get("protocol") == "function":
                leaf_module_path[leaf.id] = dotted
        pending.append(("collapsed", node, target))

    for root in folder_roots:
        discover_folder_module(
            root, services_base / root.id, f"services.{root.id}",
            graph, leaf_module_path, type_import_path, pending,
        )

    # --- Phase 2: every path is now known graph-wide; render everything ---
    all_referenced_ids = render_pending(pending, graph, leaf_module_path, type_import_path, enum_defs)
    written = [str(target.relative_to(out_dir)) for _, _, target in pending]

    # Exclude from the shared aggregate any data-model node that
    # already got its own file above (type_import_path) -- otherwise
    # it would be generated TWICE: once in its own file, once again
    # inside _scaffold_types.py.
    filed_type_names = {data_model_type_name(graph.nodes[nid]) for nid in type_import_path if nid in graph.nodes}
    dm_shapes = {name: fields for name, fields in dm_shapes.items() if name not in filed_type_names}
    enum_defs_for_shared = {name: d for name, d in enum_defs.items() if name not in filed_type_names}

    if all_referenced_ids or dm_shapes or enum_defs_for_shared or constants:
        # Revision 3: dm_shapes is already collect_data_model_types()'s
        # fully-resolved output ({type_name: [resolved field dicts]}),
        # not a shape-string dict needing a `known` set to parse -- no
        # separate all_type_shapes-building step needed anymore.
        models_content = generate_models_file(dm_shapes, enum_defs_for_shared, constants)
        (services_base / RESERVED_TYPES_FILENAME).write_text(models_content)
        written.append(str((services_base / RESERVED_TYPES_FILENAME).relative_to(out_dir)))

    # main.py, driven by the same interface.http_method/interface.route
    # fields as scaffold.py's leaf-granularity path -- see that file's
    # generate_main_file for why this replaced a hardcoded ROUTE_MAP.
    # import_path_for is a single dict lookup here since leaf_module_path
    # already covers every leaf, file- or folder-style, built above.
    def _module_mode_import_path(leaf_node: Node, graph: Graph) -> str:
        return leaf_module_path[leaf_node.id]

    has_routes = any(
        n.interface.get("protocol") == "function"
        and n.interface.get("http_method") and n.interface.get("route")
        for n in graph.nodes.values()
    )
    if has_routes:
        main_content = generate_main_file(graph, import_path_for=_module_mode_import_path)
        (out_dir / "main.py").write_text(main_content)
        written.append("main.py")

    return graph, written


if __name__ == "__main__":
    ap = argparse.ArgumentParser(
        description="Generate one file per module/class graph node, with its "
                    "dependencies/exports as function stubs, grouped under services/."
    )
    ap.add_argument("graph_file", type=Path)
    ap.add_argument("out_dir", type=Path)
    args = ap.parse_args()

    graph, written = scaffold_modules(args.graph_file, args.out_dir)
    module_count = sum(1 for n in graph.nodes.values() if n.interface.get("protocol") in ("module", "class"))
    print(f"{module_count} module/class nodes -> {len(written)} files under {args.out_dir}/services/")
    for w in written:
        print(f"  {w}")
