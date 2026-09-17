"""
promptgen/generate_prompts.py — for every implementation-ready leaf in
graph.yaml, writes:
  - prompts/prompt_<node_id>.md   the EXACT prompt opencode_bridge.py
                                    would send (reuses build_prompt(),
                                    not a reimplementation)
  - tests/test_<node_id>.py       the fixed pytest file (reuses
                                    generate_pytest.generate_test_for_node())
  - TODO.md                       ONE human-readable checklist, for
                                    tracking only

IMPORTANT — this file is NOT meant to be read or self-managed by
OpenCode. Handing an agentic model a multi-item to-do list and asking
it to self-track progress/retries across one long session reintroduces
exactly the risks this project's design exists to prevent: no
objective pass/fail check (the model would be self-reporting "done"),
no reliable self-limited retry count, and context bleeding across
unrelated items in one session. TODO.md exists for a HUMAN to glance
at; the actual checkbox updates are written by opencode_bridge.py
after each REAL pytest run, never by OpenCode itself. See
mark_todo_item() in this file, called from opencode_bridge.py.
"""

from __future__ import annotations

import argparse
import re
from pathlib import Path

from graph_runner import Graph, Status
from generate_pytest import generate_test_for_node
from opencode_bridge import build_prompt, READY_STATUSES
from scaffold import is_leaf_with_signature, collect_data_model_types


def generate_all_prompts(graph: Graph, project_dir: Path, task_description: str) -> list[str]:
    """Returns the list of node ids a prompt+test was generated for,
    in the order they'll appear in TODO.md (dependency-shallow first,
    matching graph.depth() -- purely for readability; execution order
    is still whatever opencode_bridge.py's caller chooses)."""
    dm_shapes, dm_warnings = collect_data_model_types(graph)
    for w in dm_warnings:
        print(f"WARNING: {w}")

    prompts_dir = project_dir / "prompts"
    tests_dir = project_dir / "tests"
    prompts_dir.mkdir(exist_ok=True)
    tests_dir.mkdir(exist_ok=True)
    if not (tests_dir / "__init__.py").exists():
        (tests_dir / "__init__.py").write_text("")

    ready_ids = [
        n.id for n in graph.nodes.values()
        if is_leaf_with_signature(n) and n.status in READY_STATUSES
    ]
    ready_ids.sort(key=lambda nid: (graph.depth(graph.nodes[nid]), nid))

    for node_id in ready_ids:
        node = graph.nodes[node_id]

        test_path = tests_dir / f"test_{node_id}.py"
        if not test_path.exists():
            content = generate_test_for_node(node, graph, dm_shapes)
            if content is not None:
                test_path.write_text(content)

        test_file_rel = f"tests/test_{node_id}.py" if test_path.exists() else "(no tests defined for this node)"
        prompt_text = build_prompt(node, graph, task_description, test_file_rel)
        (prompts_dir / f"prompt_{node_id}.md").write_text(prompt_text)

    return ready_ids


def generate_todo_md(graph: Graph, ready_ids: list[str], project_dir: Path) -> None:
    lines = [
        f"# Implementation checklist — {graph.project}",
        "",
        "Generated from graph.yaml. **For human tracking only** — OpenCode",
        "never reads this file or self-manages it. Each checkbox below is",
        "updated by opencode_bridge.py after a REAL pytest run, never by",
        "the model's own say-so. See prompts/*.md for what OpenCode",
        "actually receives — one narrow, single-item prompt at a time.",
        "",
    ]
    for node_id in ready_ids:
        node = graph.nodes[node_id]
        test_file = Path(project_dir / "tests" / f"test_{node_id}.py")
        test_cmd = f"pytest tests/test_{node_id}.py -v" if test_file.exists() else "(no tests defined)"
        lines.append(f"- [ ] `{node_id}` — {node.title}")
        lines.append(f"      prompt: prompts/prompt_{node_id}.md")
        lines.append(f"      test:   {test_cmd}")
        lines.append(f"      attempts: 0/3")
    lines.append("")
    (project_dir / "TODO.md").write_text("\n".join(lines))


# ---------------------------------------------------------------- checkbox updates
# Called by opencode_bridge.py after each real attempt -- NOT by OpenCode.

_ITEM_RE_TEMPLATE = r"- \[[ x!]\] `{node_id}`.*?attempts: \d+/\d+"


def mark_todo_item(todo_path: Path, node_id: str, status: str, attempts: int, max_attempts: int) -> None:
    """status: 'done' | 'failed' | 'in_progress'. Rewrites this node's
    4-line block in TODO.md in place. Safe to call repeatedly (e.g.
    once per retry attempt) -- always reflects current Python-verified
    state, never something OpenCode wrote."""
    if not todo_path.exists():
        return
    text = todo_path.read_text()

    marker = {"done": "x", "failed": "!", "in_progress": " "}[status]
    node = None  # not needed here; title isn't re-derived, kept from original generation

    pattern = re.compile(
        rf"(- \[)[ x!](\] `{re.escape(node_id)}` — [^\n]*\n"
        rf"      prompt: [^\n]*\n"
        rf"      test:   [^\n]*\n"
        rf"      attempts: )\d+/\d+"
    )

    def _replace(m: re.Match) -> str:
        return f"{m.group(1)}{marker}{m.group(2)}{attempts}/{max_attempts}"

    new_text, count = pattern.subn(_replace, text)
    if count == 1:
        todo_path.write_text(new_text)
    # count == 0 -- node_id not found in TODO.md (e.g. --nodes targeted
    # something generate_prompts.py wasn't run for). Silently skip
    # rather than error -- TODO.md is a convenience view, not load-bearing.


# ---------------------------------------------------------------- CLI

if __name__ == "__main__":
    ap = argparse.ArgumentParser(description="Generate per-leaf prompts, tests, and a TODO.md tracking manifest.")
    ap.add_argument("graph_file", type=Path)
    ap.add_argument("project_dir", type=Path)
    ap.add_argument("--task-description", default="")
    args = ap.parse_args()

    graph = Graph.load(args.graph_file)
    ready_ids = generate_all_prompts(graph, args.project_dir, args.task_description)
    generate_todo_md(graph, ready_ids, args.project_dir)
    print(f"Generated {len(ready_ids)} prompt(s) + test(s), and TODO.md, under {args.project_dir}")
