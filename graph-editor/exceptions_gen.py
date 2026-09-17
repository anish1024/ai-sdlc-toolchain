"""
testgen/exceptions_gen.py — generates a real Python exception class
for every distinct `expect_raises` name found across a graph's node
tests. These names (e.g. "NotAGroupMember", "WeakPassword") appear
throughout kharcha_graph.yaml's tests but don't exist as real classes
anywhere -- without this, translated pytest.raises(...) calls would
have nothing real to reference. Same generation pattern as
scaffold.py's generate_models_file(), applied to a different field.
"""

from __future__ import annotations

from graph_runner import Graph


def collect_exception_names(graph: Graph) -> set[str]:
    names = set()
    for n in graph.nodes.values():
        for t in n.tests:
            if "expect_raises" in t:
                names.add(t["expect_raises"])
    return names


def generate_exceptions_file(names: set[str]) -> str:
    lines = [
        '"""Auto-generated from graph.yaml test expect_raises names --',
        "one exception class per distinct name referenced across all",
        'node tests. Regenerate rather than hand-editing this file."""',
        "",
    ]
    for name in sorted(names):
        lines.append(f"class {name}(Exception):")
        lines.append("    pass")
        lines.append("")
        lines.append("")
    return "\n".join(lines)
