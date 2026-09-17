"""
testgen/generate_pytest.py — translates each leaf node's `tests:`
block in graph.yaml into a real pytest file, so OpenCode's
implementation gets checked against a FIXED, pre-written test it
cannot alter -- not a test it wrote itself (which would reintroduce
the self-grading risk flagged early in this project's design).

Surveyed the real kharcha_graph.yaml test data before building this:
`given` maps cleanly to call arguments (matched by parameter name).
`expect` is a genuine MIX -- some keys are literal fields on the
return type (status, shares, balances), others are informal derived
checks (token_present, invite_code_matches, count_matches_pending_only)
that don't have one universal mechanical translation. Rather than
guess and risk a wrong (or vacuously-true) assertion, this uses THREE
tiers:

  Tier A: exact field match against the return type's declared shape
          -> real equality assertion.
  Tier B: recognized naming conventions (_present, _matches, boolean
          success/failure claims) -> real assertion via a documented
          convention.
  Tier C: anything else -> emitted as a skipped test with a TODO
          comment showing the raw expect block, not a guessed assert.

This means the generated suite is trustworthy where it asserts
something, and honest about where it doesn't -- a partially-automated
real test beats a fully-automated fake one.

REVISION 3: `signature` (a free-text string typedsl.py had to parse)
is retired in favor of structured `params`/`returns` -- see
type_resolve.py, which replaced typedsl.py's parsing role entirely.
No more `known_types` set to build/thread through this file at all:
a type descriptor's reference IS a real node id, trusted directly.
"""

from __future__ import annotations

import json
from pathlib import Path

from graph_runner import Graph, Node
from type_resolve import derive_pascal, referenced_node_ids
from scaffold import module_path_for, is_leaf_with_signature, func_name_for, collect_data_model_types


def _py_literal(value) -> str:
    """Render a YAML-parsed Python value (dict/list/str/int/bool/None)
    as a Python source literal usable directly in generated code."""
    return repr(value)


def _build_call_args(params: list[dict], given: dict) -> str:
    """Match `given`'s keys to the function's own parameter names, in
    declared order -- positional args in signature order, keyword
    fallback for anything given-but-unmatched by position."""
    args = []
    for p in params:
        if p["name"] in given:
            args.append(_py_literal(given[p["name"]]))
        else:
            # Missing from `given` -- pass a clearly-marked placeholder
            # rather than silently omitting (which could shift
            # positional args) or guessing a default.
            args.append("None  # TODO: no value given in graph.yaml test for this param")
    return ", ".join(args)


# --- Tier B: recognized naming-convention translators -----------------
# Each returns a Python assertion source line, or None if the pattern
# doesn't apply (falls through to the next tier).

def _tier_b_assertion(key: str, expected, result_var: str) -> str | None:
    if key.endswith("_present"):
        base = key[: -len("_present")]
        want = bool(expected)
        return f"assert (getattr({result_var}, {base!r}, None) is not None) == {want!r}"
    if key.endswith("_matches"):
        base = key[: -len("_matches")]
        return f"assert re.match({expected!r}, str(getattr({result_var}, {base!r})))"
    if key in ("raised", "error") and expected in (False, None):
        return None  # trivially true if we reached this line without an exception -- no assert needed, just a comment
    if key == "found":
        want = bool(expected)
        return f"assert ({result_var} is not None) == {want!r}"
    return None


# Keys we know are literal fields on common return shapes -- checked
# via getattr with a dict fallback, since some nodes return plain
# dicts (e.g. balance_aggregator's balances) rather than dataclasses.
def _tier_a_assertion(key: str, expected, result_var: str) -> str:
    return (
        f"_actual = {result_var}[{key!r}] if isinstance({result_var}, dict) "
        f"else getattr({result_var}, {key!r})\n"
        f"    assert _actual == {expected!r}, f\"{key}: expected {{{expected!r}}}, got {{_actual}}\""
    )


def _known_return_fields(node: Node, graph: Graph, dm_shapes: dict[str, list[dict]]) -> set[str]:
    """Field names declared on the node's own return type, if it
    references a real data-model node -- used to decide Tier A
    eligibility. Revision 3: `returns` is already a resolved type
    descriptor, so this is a direct lookup, not a parse."""
    returns = node.interface.get("returns")
    if not returns:
        return set()
    fields = set()
    for rid in referenced_node_ids(returns):
        type_name = derive_pascal(rid)
        for f in dm_shapes.get(type_name, []):
            fields.add(f["name"])
    return fields


def generate_test_for_node(node: Node, graph: Graph, dm_shapes: dict[str, list[dict]]) -> str | None:
    if not node.tests:
        return None
    if not is_leaf_with_signature(node):
        return None

    params = node.interface.get("params", [])
    fname = func_name_for(node)
    mod_path, _ = module_path_for(node, graph)
    return_fields = _known_return_fields(node, graph, dm_shapes)

    lines = [
        f'"""Auto-generated from graph.yaml node \'{node.id}\' tests.',
        "Do not hand-edit -- regenerate from graph.yaml instead.",
        'If a test is skipped with a TODO, the corresponding `expect`',
        "key wasn't mechanically translatable -- write that assertion",
        'by hand and it will be preserved on next regen IF you move it',
        "to a separate file (this one gets overwritten).\"\"\"",
        "",
        "import re",
        "import pytest",
        f"from {mod_path} import {fname}",
        "from app.models import *",
        "from app.exceptions import *",
        "",
    ]

    tier_c_count = 0
    for t in node.tests:
        test_id = t.get("id", "test").replace("-", "_")
        given = t.get("given", {})
        call_args = _build_call_args(params, given)

        lines.append(f"def test_{test_id}():")
        if t.get("description"):
            lines.append(f'    """{t["description"]}"""')

        if "expect_raises" in t:
            exc = t["expect_raises"]
            lines.append(f"    with pytest.raises({exc}):")
            lines.append(f"        {fname}({call_args})")
            lines.append("")
            continue

        expect = t.get("expect", {})
        if not expect:
            lines.append(f"    {fname}({call_args})  # no expect block -- call must simply not raise")
            lines.append("")
            continue

        lines.append(f"    result = {fname}({call_args})")
        any_real_assertion = False

        # Whole-return-value shortcut: if the return type isn't a known
        # custom dataclass (bare dict/list/primitive) and expect has
        # exactly one key, that key is almost always a human LABEL for
        # the whole return value, not a field path into it -- confirmed
        # against the real data (expense_split_calculator returns a bare
        # dict[str, Decimal]; its test's "shares" key means "the return
        # value equals this dict", not "result.shares equals this").
        if not return_fields and len(expect) == 1:
            only_key, only_val = next(iter(expect.items()))
            if not only_key.startswith("sum_of_"):
                lines.append(f"    assert result == {only_val!r}, f\"expected {{{only_val!r}}}, got {{result}}\"")
                any_real_assertion = True
                expect = {}  # handled; skip the per-key loop below

        for key, val in expect.items():
            if key.startswith("sum_of_"):
                lines.append(
                    f"    assert sum(result.values() if hasattr(result, 'values') else result) == {val!r}, "
                    f"f\"expected sum {{{val!r}}}, got {{sum(result.values() if hasattr(result, 'values') else result)}}\""
                )
                any_real_assertion = True
                continue
            if key in return_fields:
                lines.append(f"    {_tier_a_assertion(key, val, 'result')}")
                any_real_assertion = True
                continue
            b = _tier_b_assertion(key, val, "result")
            if b is not None:
                lines.append(f"    {b}")
                any_real_assertion = True
                continue
            if key in ("raised", "error") and val in (False, None):
                lines.append(f"    # '{key}': {val!r} -- satisfied trivially since no exception was raised above")
                continue
            # Tier C: honestly can't translate this one.
            lines.append(f"    # TODO: '{key}': {json.dumps(val)} -- not mechanically translatable, write by hand")
            tier_c_count += 1
        if not any_real_assertion:
            lines.append(f"    pytest.skip(\"all '{node.id}'/{test_id} expect keys need manual translation -- see TODOs above\")")
        lines.append("")

    header_note = f"# {tier_c_count} expect key(s) across this file need manual assertions (see TODOs)\n" if tier_c_count else ""
    return header_note + "\n".join(lines)


def generate_all(graph: Graph, dm_shapes: dict[str, list[dict]], out_dir: Path) -> list[str]:
    written = []
    for node in graph.nodes.values():
        if not is_leaf_with_signature(node):
            continue
        content = generate_test_for_node(node, graph, dm_shapes)
        if content is None:
            continue
        path = out_dir / f"test_{node.id}.py"
        path.write_text(content)
        written.append(str(path))
    return written


if __name__ == "__main__":
    import argparse
    ap = argparse.ArgumentParser(description="Generate pytest files from graph.yaml node tests.")
    ap.add_argument("graph_file", type=Path)
    ap.add_argument("out_dir", type=Path)
    args = ap.parse_args()

    graph = Graph.load(args.graph_file)
    dm_shapes, dm_warnings = collect_data_model_types(graph)
    for w in dm_warnings:
        print(f"WARNING: {w}")
    args.out_dir.mkdir(parents=True, exist_ok=True)
    written = generate_all(graph, dm_shapes, args.out_dir)
    print(f"Generated {len(written)} test files -> {args.out_dir}")
