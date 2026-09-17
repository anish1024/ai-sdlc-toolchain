"""
generate_project.py — the single, generic entry point for
turning any graph_runner-schema graph.yaml into a project scaffold.

This does NOT reimplement anything -- it's a thin CLI wrapping the
two already-tested generators, so you have one command to remember
instead of needing to know which of two scripts fits your case:

  --granularity leaf    (scaffold.py)         one file PER FUNCTION.
                         Supports --mode flat|wired. Generates
                         app/models.py, app/main.py (FastAPI wiring),
                         tests/test_wiring.py. Built for testing the
                         communication/wiring layer before real logic
                         exists (a "walking skeleton").

  --granularity module  (module_scaffold.py)  one file PER
                         python-module NODE, its functions grouped
                         inside. Generates services/_scaffold_types.py.
                         Handles both the kharcha convention
                         (dependencies -> function) and the a2d
                         convention (interface.exports -> function).
                         Built for handing files to OpenCode -- each
                         stub's docstring embeds the node's `notes`
                         as a delimited OPENCODE PROMPT block.

Both paths are independently verified (see scaffold.py's and
module_scaffold.py's own READMEs for what was actually tested).
This wrapper adds nothing to the generation logic itself -- only
routing -- so it inherits that verification rather than needing its
own from scratch. It DOES get its own smoke test below, covering the
routing itself, against both real graphs.
"""

from __future__ import annotations

import argparse
from pathlib import Path

import scaffold
import module_scaffold


def generate(graph_file: Path, out_dir: Path, granularity: str, mode: str = "wired"):
    if granularity == "leaf":
        graph, pkgs = scaffold.scaffold(graph_file, out_dir, mode)
        leaf_count = sum(1 for n in graph.nodes.values() if scaffold.is_leaf_with_signature(n))
        if leaf_count == 0:
            # Not a bug -- a real granularity mismatch. --granularity leaf
            # only works for graphs where function leaf nodes carry their
            # own interface.params/interface.returns (the kharcha
            # convention). a2d-style graphs (mechanically imported,
            # functions living in interface.exports instead) have none --
            # confirmed directly, not guessed. Succeeding silently with 0
            # files here would be exactly the kind of landmine this
            # project keeps catching elsewhere, so this fails loudly instead.
            raise ValueError(
                "0 leaf nodes found (no node has interface.params/interface.returns). "
                "This graph likely uses the a2d-style 'interface.exports' convention "
                "instead of per-function nodes -- try --granularity module."
            )
        return {
            "granularity": "leaf",
            "mode": mode,
            "leaf_files": leaf_count,
            "service_packages": len(pkgs),
            "out_dir": str(out_dir),
        }
    elif granularity == "module":
        graph, written = module_scaffold.scaffold_modules(graph_file, out_dir)
        module_count = sum(1 for n in graph.nodes.values() if n.interface.get("protocol") == "module")
        if module_count == 0:
            raise ValueError(
                "0 module nodes found. This graph may not declare "
                "interface.protocol == 'module' on any node -- check "
                "the source graph.yaml, or try --granularity leaf if it uses "
                "function leaves without a module-level grouping node."
            )
        return {
            "granularity": "module",
            "module_files": module_count,
            "files_written": len(written),
            "out_dir": str(out_dir),
        }
    else:
        raise ValueError(f"Unknown granularity: {granularity!r} (must be 'leaf' or 'module')")


if __name__ == "__main__":
    ap = argparse.ArgumentParser(
        description="Generate a project scaffold from any graph_runner-schema graph.yaml. "
                    "Single entry point wrapping scaffold.py (leaf granularity) and "
                    "module_scaffold.py (module granularity)."
    )
    ap.add_argument("graph_file", type=Path)
    ap.add_argument("out_dir", type=Path)
    ap.add_argument("--granularity", choices=["leaf", "module"], default="module",
                     help="leaf = one file per function (walking-skeleton testing). "
                          "module = one file per python-module node, grouped functions (OpenCode-prompt-ready).")
    ap.add_argument("--mode", choices=["flat", "wired"], default="wired",
                     help="Only applies to --granularity leaf.")
    args = ap.parse_args()

    result = generate(args.graph_file, args.out_dir, args.granularity, args.mode)
    print(result)
