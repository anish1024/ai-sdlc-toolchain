"""
opencode_bridge.py — ties graph_runner.py's state machine to real
OpenCode invocations, iterating through leaf nodes either
automatically (following next_action()) or over an explicit
human-given list.

===========================================================================
DESIGN NOTE / PUSHBACK RESOLUTION (read this before using --nodes)
===========================================================================
A human picking which leaf to implement next, out of order, is SAFE and
useful once a leaf is contract_defined: implementation only needs a
node's own fixed contract plus its dependencies' INTERFACES (never
their real behavior — see contract_schema_v1.md's "context.include"
rule), so implementation order among already-decomposed leaves doesn't
affect correctness. The ordering enforced by next_action() protects a
DIFFERENT phase — breadth-first *decomposition* (deciding contracts),
not implementation.

What would NOT be safe: letting --nodes target a node that's still
`unsplit` or `stub`. That node has no real contract yet — no fixed
signature, no fixed tests — so OpenCode would have to improvise one
itself, which is exactly the self-grading failure mode this whole
project exists to prevent, just reached through "the human asked for
it" instead of "the small model wandered into it."

So: --nodes REFUSES (loudly, not silently) any node whose status isn't
already contract_defined or implementing. --auto follows next_action()
but ONLY executes 'implement' actions automatically — it STOPS and
reports on 'split' or 'blocked' rather than attempting them, since
those need a human/frontier pass (or graph_editor.html), not a bigger
prompt to a small model.
===========================================================================

Two entry points:
  --auto                 follow next_action() until nothing more can be
                          auto-implemented; stops (does not fail) on the
                          first 'split' or 'blocked' action and reports it.
  --nodes id1,id2,...     explicit list, processed in the given order,
                          each checked for contract-readiness first.
"""

from __future__ import annotations

import argparse
import json
import subprocess
from dataclasses import dataclass
from pathlib import Path
from typing import Callable, Optional

from graph_runner import Graph, Node, Status, TestResult, next_action, resync_graph
from scaffold import module_path_for, is_leaf_with_signature, collect_data_model_types
from generate_pytest import generate_test_for_node
from exceptions_gen import collect_exception_names, generate_exceptions_file


# ---------------------------------------------------------------- prompt building

def build_prompt(node: Node, graph: Graph, task_description: str, test_file_rel: str, previous_failure: Optional[str] = None) -> str:
    """Scoped prompt: this node's own contract + named dependencies'
    INTERFACES only (never their implementations, never any other
    node) + a pointer at the FIXED, pre-generated test file it must
    satisfy but must never edit. If a prior attempt failed, its real
    pytest output is included so this fresh session isn't repeating
    the same blind guess -- still a brand-new, stateless `opencode
    run` call (no --continue), just handed one more fact than the
    first attempt got."""
    parts = [
        f"# Task context: {graph.project}",
        "You are implementing exactly ONE component below. Do not modify, "
        "explore, or reason about any other file or component in the project.",
        "",
        f"## Component: {node.id} — {node.title}",
        "Interface (must match exactly, do not change the signature):",
        json.dumps(node.interface, indent=2),
    ]

    if node.stub_behavior:
        parts += ["", "## Stub behavior this replaces:", node.stub_behavior]

    dep_interfaces = []
    for dep_id in node.dep_ids:
        dep = graph.nodes.get(dep_id)
        if dep is not None:
            dep_interfaces.append({"node": dep_id, "interface": dep.interface})
    if dep_interfaces:
        parts += [
            "",
            "## Dependency contracts — call these, do NOT reimplement or "
            "inline their logic, and do not read their source files:",
            json.dumps(dep_interfaces, indent=2),
        ]

    parts += [
        "",
        f"## FIXED TEST FILE — {test_file_rel}",
        f"Run it with: pytest {test_file_rel} -v",
        "Your implementation is correct once every test in that file passes "
        "(tests marked skip with a TODO don't need to pass — they need a "
        "human, not you). If a test fails, read the failure output, fix ONLY "
        f"the implementation, and re-run. DO NOT EDIT {test_file_rel} under "
        "any circumstances, even if a test looks wrong to you — if you "
        "believe a test is incorrect, stop and say so instead of changing it.",
    ]

    if previous_failure:
        parts += [
            "",
            "## A PREVIOUS ATTEMPT FAILED — real pytest output below",
            "This is a fresh attempt, but the same test suite. Read this failure "
            "carefully before writing anything — don't repeat whatever caused it:",
            previous_failure,
        ]

    if node.notes:
        parts += ["", f"## Notes from the contract (treat as binding requirements):", node.notes]

    parts += ["", f"## Overall task (context only — stay scoped to {node.id}):", task_description]


    return "\n".join(parts)


# ---------------------------------------------------------------- OpenCode call

@dataclass
class OpenCodeResult:
    success: bool
    raw_output: str
    error: Optional[str] = None


def run_opencode(
    prompt: str,
    *,
    model: str,
    cwd: Path,
    timeout_seconds: int = 300,
    opencode_bin: str = "opencode",
) -> OpenCodeResult:
    """One-shot, stateless invocation — deliberately not --continue.
    Every retry attempt gets a fresh call built from build_prompt()
    again (see implement_with_retry), not a continued conversation,
    so failures don't compound into a growing, noisy context."""
    cmd = [opencode_bin, "run", "--model", model, "--format", "json",
           "--dangerously-skip-permissions", prompt]
    try:
        proc = subprocess.run(cmd, cwd=str(cwd), capture_output=True, text=True, timeout=timeout_seconds)
    except subprocess.TimeoutExpired:
        return OpenCodeResult(False, "", f"timed out after {timeout_seconds}s")
    except FileNotFoundError:
        return OpenCodeResult(False, "", f"'{opencode_bin}' not found on PATH")
    if proc.returncode != 0:
        return OpenCodeResult(False, proc.stdout, proc.stderr.strip() or f"exit code {proc.returncode}")
    return OpenCodeResult(True, proc.stdout)


# ---------------------------------------------------------------- test running

def ensure_test_file(node: Node, graph: Graph, project_dir: Path, dm_shapes: dict[str, list[dict]]) -> Optional[Path]:
    """Generates tests/test_<id>.py from the node's graph.yaml `tests`
    if it doesn't already exist. Never regenerates an existing file --
    once written, it's the fixed ground truth OpenCode implements
    against; regenerating mid-session could silently change what
    'passing' means between attempts."""
    tests_dir = project_dir / "tests"
    tests_dir.mkdir(exist_ok=True)
    init = tests_dir / "__init__.py"
    if not init.exists():
        init.write_text("")
    path = tests_dir / f"test_{node.id}.py"
    if path.exists():
        return path
    content = generate_test_for_node(node, graph, dm_shapes)
    if content is None:
        return None  # node has no tests -- nothing to generate or check
    path.write_text(content)
    return path


def ensure_exceptions_file(graph: Graph, project_dir: Path) -> None:
    path = project_dir / "app" / "exceptions.py"
    if path.exists():
        return
    names = collect_exception_names(graph)
    path.write_text(generate_exceptions_file(names))


def run_pytest(test_file_rel: str, project_dir: Path) -> TestResult:
    try:
        proc = subprocess.run(
            ["python3", "-m", "pytest", test_file_rel, "-v"],
            cwd=str(project_dir), capture_output=True, text=True, timeout=60,
        )
    except subprocess.TimeoutExpired:
        return TestResult(all_passed=False, details="pytest timed out")
    passed = proc.returncode == 0
    return TestResult(all_passed=passed, details=proc.stdout[-2000:] + proc.stderr[-500:])


def make_project_test_runner(graph_ref: Graph, project_dir: Path, dm_shapes: dict[str, list[dict]]) -> Callable[[Node], TestResult]:
    """Builds the real test_runner function graph_runner.resync_graph()
    expects: (Node) -> TestResult. Runs each node's OWN generated test
    file if one exists; nodes with no tests can never be verified past
    'implemented', per the schema's own rule -- this runner just tells
    the truth about that rather than working around it."""
    def runner(node: Node) -> TestResult:
        if not node.tests:
            return TestResult(all_passed=False, details="no tests defined for this node")
        test_path = ensure_test_file(node, graph_ref, project_dir, dm_shapes)
        if test_path is None:
            return TestResult(all_passed=False, details="test generation produced nothing")
        _, pkg_dir = module_path_for(node, graph_ref)
        rel = str(test_path.relative_to(project_dir))
        return run_pytest(rel, project_dir)
    return runner


# ---------------------------------------------------------------- implement + retry

def implement_with_retry(
    node_id: str,
    graph: Graph,
    project_dir: Path,
    task_description: str,
    dm_shapes: dict[str, list[dict]],
    model: str,
    max_attempts: int = 3,
    opencode_runner: Callable[..., OpenCodeResult] = run_opencode,
) -> bool:
    node = graph.nodes[node_id]
    test_path = ensure_test_file(node, graph, project_dir, dm_shapes)
    test_file_rel = str(test_path.relative_to(project_dir)) if test_path else "(no test file — node has no tests)"
    todo_path = project_dir / "TODO.md"

    node.status = Status.IMPLEMENTING.value
    previous_failure: Optional[str] = None

    for attempt in range(1, max_attempts + 1):
        _mark_todo_if_present(todo_path, node_id, "in_progress", attempt, max_attempts)
        prompt = build_prompt(node, graph, task_description, test_file_rel, previous_failure)
        result = opencode_runner(prompt, model=model, cwd=project_dir)
        if not result.success:
            print(f"  [{node_id}] attempt {attempt}/{max_attempts}: OpenCode call failed: {result.error}")
            previous_failure = f"OpenCode call itself failed (not a test failure): {result.error}"
            continue

        node.status = Status.IMPLEMENTED.value
        if test_path is None:
            print(f"  [{node_id}] implemented (no tests to verify against — cannot claim tested)")
            _mark_todo_if_present(todo_path, node_id, "done", attempt, max_attempts)
            return True

        test_result = run_pytest(test_file_rel, project_dir)
        if test_result.all_passed:
            print(f"  [{node_id}] attempt {attempt}/{max_attempts}: tests passed")
            _mark_todo_if_present(todo_path, node_id, "done", attempt, max_attempts)
            return True
        print(f"  [{node_id}] attempt {attempt}/{max_attempts}: tests failed, retrying" if attempt < max_attempts else
              f"  [{node_id}] attempt {attempt}/{max_attempts}: tests still failing, giving up")
        previous_failure = test_result.details

    node.status = Status.CONTRACT_DEFINED.value  # retry-able later, not stuck as "implementing" forever
    _mark_todo_if_present(todo_path, node_id, "failed", max_attempts, max_attempts)
    return False


def _mark_todo_if_present(todo_path: Path, node_id: str, status: str, attempts: int, max_attempts: int) -> None:
    """TODO.md is optional -- only present if generate_prompts.py was
    run first. Import is local to avoid a hard dependency for callers
    that don't use the prompt-generation workflow at all."""
    if not todo_path.exists():
        return
    try:
        from generate_prompts import mark_todo_item
        mark_todo_item(todo_path, node_id, status, attempts, max_attempts)
    except ImportError:
        pass  # generate_prompts.py not available in this environment -- TODO.md just won't update


# ---------------------------------------------------------------- orchestration

READY_STATUSES = {Status.CONTRACT_DEFINED.value, Status.IMPLEMENTING.value}


def run_explicit_list(
    graph_path: Path, project_dir: Path, node_ids: list[str], task_description: str,
    model: str, max_attempts: int = 3, opencode_runner: Callable[..., OpenCodeResult] = run_opencode,
) -> dict:
    graph = Graph.load(graph_path)
    dm_shapes, dm_warnings = collect_data_model_types(graph)
    for w in dm_warnings:
        print(f"WARNING: {w}")
    ensure_exceptions_file(graph, project_dir)

    refused, succeeded, failed = [], [], []
    for node_id in node_ids:
        node = graph.nodes.get(node_id)
        if node is None:
            refused.append((node_id, "node does not exist in graph.yaml"))
            continue
        if not is_leaf_with_signature(node):
            refused.append((node_id, "not a leaf node with a real signature (it's a grouping/module node)"))
            continue
        if node.status not in READY_STATUSES:
            refused.append((
                node_id,
                f"status is '{node.status}', not contract_defined/implementing -- this node has no "
                f"fixed contract yet. Decompose and author its contract first (graph_editor.html or "
                f"by hand), then retry. Refusing rather than letting OpenCode improvise one."
            ))
            continue

        print(f"Implementing '{node_id}'...")
        ok = implement_with_retry(node_id, graph, project_dir, task_description, dm_shapes, model, max_attempts, opencode_runner)
        graph.save(graph_path)
        (succeeded if ok else failed).append(node_id)

    # Without this, a node that genuinely passed its own test in
    # implement_with_retry would stay stuck at 'implemented' forever --
    # resync_graph() is what actually promotes it through the real
    # state machine (implemented -> tested -> integrated), using the
    # same test runner, cascading correctly through any dependents too.
    test_runner = make_project_test_runner(graph, project_dir, dm_shapes)
    resync_graph(graph, test_runner)
    graph.save(graph_path)

    return {"succeeded": succeeded, "failed": failed, "refused": refused}


def run_auto(
    graph_path: Path, project_dir: Path, task_description: str, model: str,
    max_attempts: int = 3, max_nodes: int = 20,
    opencode_runner: Callable[..., OpenCodeResult] = run_opencode,
) -> dict:
    """Follows next_action() automatically, but ONLY executes 'implement'
    actions -- stops and reports on the first 'split'/'blocked' rather
    than attempting them (see module docstring for why)."""
    graph = Graph.load(graph_path)
    dm_shapes, dm_warnings = collect_data_model_types(graph)
    for w in dm_warnings:
        print(f"WARNING: {w}")
    ensure_exceptions_file(graph, project_dir)

    test_runner = make_project_test_runner(graph, project_dir, dm_shapes)

    succeeded, failed = [], []
    stop_reason = None

    for _ in range(max_nodes):
        resync_graph(graph, test_runner)
        graph.save(graph_path)
        action = next_action(graph)

        if action is None:
            stop_reason = "done -- graph is fully integrated"
            break
        if action.kind in ("split", "blocked"):
            stop_reason = f"stopped at '{action.node_id}' ({action.kind}): {action.reason} -- needs a human/frontier pass, not OpenCode"
            break
        if action.kind != "implement":
            # test / integrate / backbone_wire / resync -- all handled by
            # resync_graph() on the next loop iteration (resync runs at
            # the TOP of this loop, before next_action is even called
            # again), no OpenCode call needed for any of these. 'resync'
            # specifically is a data-model node with a fixed contract --
            # see graph_runner.py's NON_EXECUTABLE_PROTOCOLS -- it just
            # needs rederive_status() to promote it, not an LLM call.
            continue

        print(f"Implementing '{action.node_id}' (auto)...")
        ok = implement_with_retry(action.node_id, graph, project_dir, task_description, dm_shapes, model, max_attempts, opencode_runner)
        graph.save(graph_path)
        (succeeded if ok else failed).append(action.node_id)
        if not ok:
            stop_reason = f"stopped after '{action.node_id}' failed all {max_attempts} attempts -- needs a human look"
            break

    return {"succeeded": succeeded, "failed": failed, "stop_reason": stop_reason}


# ---------------------------------------------------------------- CLI

if __name__ == "__main__":
    ap = argparse.ArgumentParser(description="Orchestrate OpenCode implementation of graph.yaml leaves.")
    ap.add_argument("graph_file", type=Path)
    ap.add_argument("project_dir", type=Path)
    ap.add_argument("--task-description", default="")
    ap.add_argument("--model", default="lmstudio/qwen3.5-9b")
    ap.add_argument("--max-attempts", type=int, default=3)
    group = ap.add_mutually_exclusive_group(required=True)
    group.add_argument("--nodes", help="comma-separated node ids to implement, in order")
    group.add_argument("--auto", action="store_true", help="follow next_action() automatically")
    args = ap.parse_args()

    if args.nodes:
        result = run_explicit_list(
            args.graph_file, args.project_dir, args.nodes.split(","),
            args.task_description, args.model, args.max_attempts,
        )
    else:
        result = run_auto(
            args.graph_file, args.project_dir, args.task_description,
            args.model, args.max_attempts,
        )
    print(json.dumps(result, indent=2))
