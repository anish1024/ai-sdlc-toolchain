"""
graph_runner.py — orchestrates the module/service contract graph
(see contract_schema_v1.md for the file format this reads/writes).

This module is NOT an LLM caller. It is a pure state machine:
- loads graph.yaml
- re-derives every node's status from ground truth (never trusts a
  possibly-stale field blindly — this is the crash-safe resume property)
- decides the single next action to take, enforcing:
    * breadth-first splitting (don't go deep until siblings are defined)
    * dependency-readiness (don't integrate before deps are integrated)
- writes graph.yaml back atomically (temp file + os.replace)

The caller (Telegram bot / CLI wrapper) asks `next_action()`, does the
actual work (call frontier model to split, call OpenCode to implement,
run tests), and writes the result back via the Graph API. This module
deliberately knows nothing about LLMs, OpenCode, or Telegram.

DATA-MODEL NODES (DTOs / DB schemas): this module is otherwise fully
protocol-agnostic (it never reads interface.protocol for anything
else), but data-shape-only nodes need one small exception -- see
NON_EXECUTABLE_PROTOCOLS below for why, and rederive_status()/
next_action() for what it changes.
"""

from __future__ import annotations

import argparse
import importlib
import json
import os
import tempfile
from dataclasses import dataclass, field
from enum import Enum
from pathlib import Path
from typing import Callable, Optional

import yaml


class Status(str, Enum):
    UNSPLIT = "unsplit"
    CONTRACT_DEFINED = "contract_defined"
    STUB = "stub"
    IMPLEMENTING = "implementing"
    IMPLEMENTED = "implemented"
    TESTED = "tested"
    INTEGRATED = "integrated"


STATUS_ORDER = [s.value for s in Status]  # index = "how far along"

# Protocols whose nodes are pure data-shape/spec declarations rather
# than executable code -- nothing to hand to OpenCode, nothing to run
# pytest against independently. Without accounting for this,
# rederive_status() caps such a node at IMPLEMENTED forever (its
# "if not node.tests: return IMPLEMENTED" branch, since neither kind
# of node legitimately has its own tests), which then permanently
# blocks deps_ready() for every node that depends on it -- a real
# deadlock, confirmed against the actual graph this project uses
# (get_current_user depends on the data-model node user_record).
#
# `contract` (added alongside the existing `data-model`) is the same
# situation for the same reason: a contract node is a fixed set of
# method signatures, not code with a body -- there's no "implement
# this contract" step independent of the concrete `class` nodes that
# implement it (those classes' own python-function children are what
# actually gets implemented and tested). `class` itself is
# deliberately NOT in this set -- like python-module, its real
# substance lives in its children, and it gets no special-casing here,
# matching how python-module containers are already handled.
#
# This module is otherwise deliberately protocol-agnostic (it never
# reads interface.protocol anywhere else) -- this constant is the
# single, explicit exception, kept intentionally small and named
# rather than open-ended, so a genuinely executable future protocol
# never gets silently swept in here by accident.
#
# Hand-synced with graph-model.js's PROTOCOL_REGISTRY and
# validate_graph.py's PROTOCOL_REGISTRY (all three mark data-model AND
# contract with language=None for the same underlying reason) -- see
# each file's own note about this being a manual sync, not a shared
# import, to avoid a circular import between graph_runner.py and
# validate_graph.py (which already imports FROM graph_runner.py).
NON_EXECUTABLE_PROTOCOLS = {"data-model", "contract"}


def _is_non_executable(node: "Node") -> bool:
    return node.interface.get("protocol") in NON_EXECUTABLE_PROTOCOLS


@dataclass
class TestResult:
    all_passed: bool
    details: str = ""


@dataclass
class Node:
    id: str
    title: str = ""
    boundary: Optional[str] = None  # None -> inherit project default_boundary
    status: str = Status.UNSPLIT.value
    last_touched_by: str = "frontier"
    parent: Optional[str] = None  # which node's decomposition created this one
    interface: dict = field(default_factory=dict)
    contract_version: str = "0.0.0"
    dependencies: list = field(default_factory=list)  # [{node, contract_version}]
    maps_to: list = field(default_factory=list)  # [node_id, ...] -- type-mapping edges (e.g. a DB schema -> the DTO it's realized as), NOT calls. See _is_non_executable below for why this is a distinct field from `dependencies`.
    implements: list = field(default_factory=list)  # [{node}, ...] -- "this class fulfills this contract" edges, NOT calls either, for the same reason maps_to isn't. See NON_EXECUTABLE_PROTOCOLS above for the `contract` side of this relationship.
    calls: list = field(default_factory=list)  # [{node, operation_name}, ...] -- sharpens ONE dependencies edge down to a named operation. Third instance of the maps_to/implements pattern -- see graph-model.js's addCall doc comment.
    data_flows: list = field(default_factory=list)  # [{node, data_model, direction}, ...] -- what data moves where. Fourth instance of the same pattern.
    stub_behavior: str = ""
    tests: list = field(default_factory=list)
    context_include: list = field(default_factory=list)
    notes: str = ""
    prompt_template: str = ""  # optional per-node override of the default prompt composition template -- see prompt-generator.js
    prompt: str = ""  # the reviewed/edited generated prompt itself -- distinct from prompt_template (the recipe)

    @property
    def dep_ids(self) -> list[str]:
        out = []
        for d in self.dependencies:
            out.append(d["node"] if isinstance(d, dict) else d)
        return out

    @property
    def maps_to_ids(self) -> list[str]:
        out = []
        for d in self.maps_to:
            out.append(d["node"] if isinstance(d, dict) else d)
        return out

    @property
    def implements_ids(self) -> list[str]:
        out = []
        for d in self.implements:
            out.append(d["node"] if isinstance(d, dict) else d)
        return out

    @property
    def calls_ids(self) -> list[str]:
        out = []
        for d in self.calls:
            out.append(d["node"] if isinstance(d, dict) else d)
        return out

    @property
    def data_flows_ids(self) -> list[str]:
        out = []
        for d in self.data_flows:
            out.append(d["node"] if isinstance(d, dict) else d)
        return out


@dataclass
class Action:
    node_id: str
    kind: str  # "split" | "implement" | "resync" | "backbone_wire" | "test" | "integrate" | "blocked"
    reason: str


class Graph:
    def __init__(self, project: str, backbone: str, default_boundary: str = "module", default_language: str | None = None):
        self.project = project
        self.backbone = backbone
        self.default_boundary = default_boundary
        self.default_language = default_language  # Revision 3 -- mirrors default_boundary's own fallback pattern; see validate_graph.py's resolve_language
        self.nodes: dict[str, Node] = {}

    # ---------------- load / save ----------------

    @classmethod
    def load(cls, path: Path) -> "Graph":
        raw = yaml.safe_load(path.read_text()) or {}
        g = cls(
            project=raw.get("project", "unnamed"),
            backbone=raw["backbone"],
            default_boundary=raw.get("default_boundary", "module"),
            default_language=raw.get("default_language"),
        )
        for n in raw.get("nodes", []) or []:
            g.nodes[n["id"]] = Node(
                id=n["id"],
                title=n.get("title", ""),
                boundary=n.get("boundary"),
                status=n.get("status", Status.UNSPLIT.value),
                last_touched_by=n.get("last_touched_by", "frontier"),
                parent=n.get("parent"),
                interface=n.get("interface", {}) or {},
                contract_version=n.get("contract_version", "0.0.0"),
                dependencies=n.get("dependencies", []) or [],
                maps_to=n.get("maps_to", []) or [],
                implements=n.get("implements", []) or [],
                calls=n.get("calls", []) or [],
                data_flows=n.get("data_flows", []) or [],
                stub_behavior=n.get("stub_behavior", ""),
                tests=n.get("tests", []) or [],
                context_include=(n.get("context", {}) or {}).get("include", []),
                notes=n.get("notes", ""),
                prompt_template=n.get("prompt_template", ""),
                prompt=n.get("prompt", ""),
            )
        return g

    def save(self, path: Path) -> None:
        """Atomic write: temp file in the same dir + os.replace, so a
        crash mid-write can never leave graph.yaml half-written."""
        # Defensive normalization: a caller may assign `node.status =
        # Status.TESTED` (the enum) instead of `.value` (the str) — both
        # should work rather than crashing the writer.
        for n in self.nodes.values():
            if hasattr(n.status, "value"):
                n.status = n.status.value
        payload = {
            "project": self.project,
            "backbone": self.backbone,
            "default_boundary": self.default_boundary,
            "default_language": self.default_language,
            "nodes": [
                {
                    "id": n.id,
                    "title": n.title,
                    "boundary": n.boundary,
                    "status": n.status,
                    "last_touched_by": n.last_touched_by,
                    "parent": n.parent,
                    "interface": n.interface,
                    "contract_version": n.contract_version,
                    "dependencies": n.dependencies,
                    "maps_to": n.maps_to,
                    "implements": n.implements,
                    "calls": n.calls,
                    "data_flows": n.data_flows,
                    "stub_behavior": n.stub_behavior,
                    "tests": n.tests,
                    "context": {"include": n.context_include},
                    "notes": n.notes,
                    "prompt_template": n.prompt_template,
                    "prompt": n.prompt,
                }
                for n in self.nodes.values()
            ],
        }
        fd, tmp_path = tempfile.mkstemp(dir=str(path.parent) or ".", prefix=".graph_", suffix=".tmp")
        try:
            with os.fdopen(fd, "w") as f:
                yaml.safe_dump(payload, f, sort_keys=False)
            os.replace(tmp_path, path)
        except Exception:
            os.unlink(tmp_path)
            raise

    # ---------------- graph queries ----------------

    def children_of(self, node_id: str) -> list[Node]:
        return [n for n in self.nodes.values() if n.parent == node_id]

    def siblings_of(self, node_id: str) -> list[Node]:
        parent = self.nodes[node_id].parent
        if parent is None:
            return []
        return [n for n in self.nodes.values() if n.parent == parent and n.id != node_id]

    def deps_ready(self, node_id: str) -> bool:
        """True if every dependency is fully INTEGRATED."""
        for dep_id in self.nodes[node_id].dep_ids:
            dep = self.nodes.get(dep_id)
            if dep is None or dep.status != Status.INTEGRATED.value:
                return False
        return True

    def siblings_at_least(self, node_id: str, min_status: Status) -> bool:
        """Breadth-first enforcement: are all siblings >= min_status?"""
        min_idx = STATUS_ORDER.index(min_status.value)
        for sib in self.siblings_of(node_id):
            if STATUS_ORDER.index(sib.status) < min_idx:
                return False
        return True

    def depth(self, node: Node) -> int:
        d, cur = 0, node
        while cur.parent:
            cur = self.nodes[cur.parent]
            d += 1
        return d

    def find_similar(self, description: str, threshold: float = 0.6) -> list[Node]:
        """Crude keyword-overlap check over existing titles/notes, to
        surface possible duplicate nodes before the frontier model
        creates a new one during splitting. Intentionally naive (no
        embeddings) — good enough to flag a candidate for a human/
        frontier-model glance, not to auto-decide anything on its own."""
        words = set(description.lower().split())
        hits = []
        for n in self.nodes.values():
            corpus = f"{n.title} {n.notes}".lower()
            overlap = len(words & set(corpus.split()))
            score = overlap / max(len(words), 1)
            if score >= threshold:
                hits.append(n)
        return hits


# ---------------- ground-truth status re-derivation ----------------

def rederive_status(graph: Graph, node: Node, test_runner: Callable[[Node], TestResult]) -> str:
    """Never trust a stale status field blindly for anything that
    claims to be verified. Re-run what can be checked and recompute.
    Statuses earlier than IMPLEMENTED describe *pending work*, not a
    verifiable claim, so they pass through unchanged."""

    if _is_non_executable(node):
        # A pure data-shape node (see NON_EXECUTABLE_PROTOCOLS above)
        # has nothing to implement or test independently -- once its
        # contract (model_fields) is fixed, it's structurally
        # complete. `unsplit` still passes through unchanged (its
        # contract genuinely isn't written yet); anything at
        # contract_defined or later promotes straight to `integrated`
        # -- there's no meaningful implementing/implemented/tested
        # state for a shape with no independent runtime behavior.
        if node.status == Status.UNSPLIT.value:
            return node.status
        return Status.INTEGRATED.value

    if node.status in (
        Status.UNSPLIT.value,
        Status.CONTRACT_DEFINED.value,
        Status.STUB.value,
        Status.IMPLEMENTING.value,
    ):
        return node.status

    if not node.tests:
        # Nothing to verify against — cap at IMPLEMENTED, can't claim TESTED.
        return Status.IMPLEMENTED.value

    result = test_runner(node)
    if not result.all_passed:
        # Regression (or first real check failing) — demote so it re-enters the loop.
        return Status.IMPLEMENTED.value

    if graph.deps_ready(node.id):
        return Status.INTEGRATED.value

    return Status.TESTED.value


def _topological_order(graph: Graph) -> list[Node]:
    """Dependency-first order (Kahn's algorithm over dep_ids), so that
    by the time a node is (re-)evaluated, every node it depends on has
    already been re-evaluated in this same pass. Without this, a
    regression at a leaf wouldn't correctly cascade upward until a
    second resync call — a real bug if a caller only resyncs once per
    resume, which is the expected usage."""
    in_degree = {nid: 0 for nid in graph.nodes}
    dependents: dict[str, list[str]] = {nid: [] for nid in graph.nodes}
    for n in graph.nodes.values():
        for dep_id in n.dep_ids:
            if dep_id in graph.nodes:
                in_degree[n.id] += 1
                dependents[dep_id].append(n.id)

    queue = sorted([nid for nid, d in in_degree.items() if d == 0])
    order: list[Node] = []
    seen = set()
    while queue:
        queue.sort()
        nid = queue.pop(0)
        if nid in seen:
            continue
        seen.add(nid)
        order.append(graph.nodes[nid])
        for dep in dependents[nid]:
            in_degree[dep] -= 1
            if in_degree[dep] == 0:
                queue.append(dep)

    # Any node not reached (e.g. a dependency cycle, which shouldn't
    # happen in a well-formed contract graph) is appended at the end
    # rather than silently dropped, so resync still covers every node.
    for nid, n in graph.nodes.items():
        if nid not in seen:
            order.append(n)
    return order


def resync_graph(graph: Graph, test_runner: Callable[[Node], TestResult]) -> list[str]:
    """Re-derive status for every node that claims to be verified, in
    dependency order, so regressions cascade correctly in a single
    pass. Returns the list of node ids whose status changed (i.e.
    what a crash or a stale write had gotten wrong)."""
    changed = []
    for node in _topological_order(graph):
        new_status = rederive_status(graph, node, test_runner)
        if new_status != node.status:
            changed.append(node.id)
            node.status = new_status
    return changed


# ---------------- next-action decision ----------------

def next_action(graph: Graph) -> Optional[Action]:
    """The single entry point a caller needs. Returns the next thing
    to do, or None if the graph is genuinely fully integrated. If
    something is pending but nothing is currently actionable (e.g.
    waiting on a dependency further down the chain), returns an
    Action with kind="blocked" instead of None — the two are NOT the
    same thing, and conflating them previously caused a false "done"
    report when two same-parent siblings were both still `unsplit`
    (neither could pass the old sibling gate, since the gate was
    wrongly applied to the split decision itself)."""

    backbone = graph.nodes[graph.backbone]
    if backbone.status == Status.UNSPLIT.value:
        return Action(
            backbone.id, "split",
            "Define the backbone's direct children as stubs before anything else.",
        )

    pending = sorted(
        (n for n in graph.nodes.values() if n.status != Status.INTEGRATED.value),
        key=lambda n: (graph.depth(n), n.id),
    )
    if not pending:
        return None  # genuinely done — nothing left unintegrated

    for node in pending:
        if node.status == Status.UNSPLIT.value:
            # The split/leaf decision itself is ALWAYS allowed — gating
            # this on siblings would deadlock whenever two siblings are
            # simultaneously unsplit (neither could ever go first).
            return Action(node.id, "split", "Decompose further, or mark as a leaf contract.")

        if node.status == Status.CONTRACT_DEFINED.value:
            if _is_non_executable(node):
                # A data-model node's "implementation" is nothing more
                # than its already-fixed model_fields -- there's no
                # OpenCode call to make. Report this plainly (a new,
                # honest action kind) instead of either wrongly
                # suggesting 'implement' or falling through to a
                # generic, less accurate 'blocked'. Once `resync` runs,
                # rederive_status() promotes it straight to
                # `integrated` (see above) and it won't reach this
                # branch again.
                return Action(
                    node.id, "resync",
                    f"'{node.id}' has a fixed data-model contract and needs no "
                    f"implementation -- run resync to promote it to integrated.",
                )
            # Breadth-first belongs HERE instead: don't let one sibling
            # start real implementation while another sibling hasn't
            # even been given a contract yet.
            if graph.siblings_at_least(node.id, Status.CONTRACT_DEFINED):
                return Action(
                    node.id, "implement",
                    "Contract is fixed — hand to the local model, scoped to context.include only.",
                )
            continue  # wait for siblings to at least reach contract_defined

        if node.status == Status.STUB.value:
            return Action(
                node.id, "backbone_wire",
                "Wire this stub into its parent and test the shape end-to-end before real implementation.",
            )

        if node.status == Status.IMPLEMENTING.value:
            return Action(node.id, "implement", "Resume in-progress implementation.")

        if node.status == Status.IMPLEMENTED.value:
            return Action(node.id, "test", "Run this node's own contract tests.")

        if node.status == Status.TESTED.value:
            if graph.deps_ready(node.id):
                return Action(
                    node.id, "integrate",
                    "Dependencies are integrated — verify this node against real (non-stub) deps.",
                )
            continue  # blocked on a dependency; keep scanning

    # Pending work exists but nothing above was actionable this pass —
    # genuinely different from "done" (see docstring). Report the
    # shallowest pending node as the blocker so a caller can explain
    # *why* nothing is happening, instead of wrongly declaring victory.
    blocker = pending[0]
    return Action(
        blocker.id, "blocked",
        f"Nothing actionable right now — {blocker.id} (status={blocker.status}) "
        f"is waiting on a dependency or sibling further down the chain.",
    )


# ---------------- pluggable test runner loading ----------------

def load_test_runner(spec: Optional[str]) -> Callable[[Node], TestResult]:
    """spec is 'module.path:function_name'. Falls back to a runner
    that always reports 'unverified' if none is given, so the CLI is
    usable before you've wired a real one in."""
    if not spec:
        return lambda node: TestResult(all_passed=False, details="no test runner configured")
    mod_name, func_name = spec.split(":")
    mod = importlib.import_module(mod_name)
    return getattr(mod, func_name)


# ---------------- CLI ----------------

def main():
    ap = argparse.ArgumentParser(description="Contract-graph runner (state machine only — no LLM calls).")
    ap.add_argument("graph_file", type=Path)
    ap.add_argument("command", choices=["status", "next", "resync"])
    ap.add_argument("--test-runner", help="module.path:function_name implementing (Node) -> TestResult")
    args = ap.parse_args()

    graph = Graph.load(args.graph_file)

    if args.command == "status":
        for n in sorted(graph.nodes.values(), key=lambda n: (graph.depth(n), n.id)):
            maps_to_suffix = f" maps_to={n.maps_to_ids}" if n.maps_to_ids else ""
            implements_suffix = f" implements={n.implements_ids}" if n.implements_ids else ""
            print(f"{'  ' * graph.depth(n)}{n.id:28s} {n.status:18s} parent={n.parent}{maps_to_suffix}{implements_suffix}")
        return

    if args.command == "resync":
        runner = load_test_runner(args.test_runner)
        changed = resync_graph(graph, runner)
        graph.save(args.graph_file)
        print(json.dumps({"changed": changed}))
        return

    if args.command == "next":
        action = next_action(graph)
        print(json.dumps({"done": True}) if action is None else json.dumps(action.__dict__))
        return


if __name__ == "__main__":
    main()
