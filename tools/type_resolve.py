"""
type_resolve.py — Revision 3's replacement for typedsl.py's parsing
role. graph.yaml no longer has free-text type strings to parse
("list[str]", "X | None", etc.) -- every type is already a structured
TYPE_DESCRIPTOR dict (validated by validate_graph.py's
resolve_type_descriptor, the same recursive shape this file mirrors
for code generation instead of validation):

  {"type": "string"}                                  -- a canonical primitive
  {"type": "expense_status"}                           -- a reference to a real node id
  {"type": "list", "items": <descriptor>}
  {"type": "map", "key": <descriptor>, "value": <descriptor>}
  {"type": "optional", "of": <descriptor>}

This means there is no parser here at all -- just a recursive walk
turning a descriptor into (a) a Python type annotation string, (b) a
dummy/default value expression for stub bodies, (c) the set of
referenced node ids that need a `dummy_X()`/class import. Compare to
typedsl.py's ~190 lines of string-splitting and regex; the entire
"parsing" surface here is the five `if` branches below.
"""

from __future__ import annotations


class TypeResolveError(ValueError):
    pass


def derive_pascal(node_id: str) -> str:
    """The canonical, single place this derivation happens now --
    previously every author had to get this right by hand and type it
    into a signature string; now it's purely a code-generation detail,
    invisible to whoever wrote the graph. 'expense_status' -> 'ExpenseStatus'."""
    return "".join(part.capitalize() for part in node_id.split("_") if part)


# Canonical primitive -> (Python annotation, dummy value expression).
# Mirrors graph-model.js's CANONICAL_PRIMITIVE_TYPES /
# validate_graph.py's CANONICAL_PRIMITIVE_TYPES exactly -- keep the
# three in sync by hand, same as the protocol registries already are.
PRIMITIVE_ANNOTATIONS = {
    "string": ("str", '""'),
    "integer": ("int", "0"),
    "float": ("float", "0.0"),
    "boolean": ("bool", "False"),
    "decimal": ("Decimal", 'Decimal("0")'),
    "datetime": ("datetime", "datetime(1970, 1, 1)"),
    "uuid": ("str", '""'),  # alias, not a real uuid.UUID -- same Pass-3 decision as before
    "none": ("None", "None"),
}


def resolve_annotation(desc: dict) -> str:
    """The Python type annotation string for a descriptor -- e.g.
    {"type":"list","items":{"type":"uuid"}} -> "list[str]"."""
    if not isinstance(desc, dict) or "type" not in desc:
        raise TypeResolveError(f"not a valid type descriptor: {desc!r}")
    t = desc["type"]
    if t in PRIMITIVE_ANNOTATIONS:
        return PRIMITIVE_ANNOTATIONS[t][0]
    if t == "list":
        return f"list[{resolve_annotation(desc['items'])}]"
    if t == "map":
        return f"dict[{resolve_annotation(desc['key'])}, {resolve_annotation(desc['value'])}]"
    if t == "optional":
        return f"{resolve_annotation(desc['of'])} | None"
    # a reference to another node id -- the class name IS derived, not authored
    return derive_pascal(t)


def resolve_dummy_expr(desc: dict) -> str:
    """The dummy/default value expression used in stub bodies and
    wired-call dummy arguments -- e.g. a reference to 'expense_status'
    becomes 'dummy_ExpenseStatus()', matching the SAME dummy_X()
    factory convention generate_models_file already establishes for
    every dataclass/enum it emits."""
    if not isinstance(desc, dict) or "type" not in desc:
        raise TypeResolveError(f"not a valid type descriptor: {desc!r}")
    t = desc["type"]
    if t in PRIMITIVE_ANNOTATIONS:
        return PRIMITIVE_ANNOTATIONS[t][1]
    if t == "list":
        return "[]"
    if t == "map":
        return "{}"
    if t == "optional":
        return "None"
    return f"dummy_{derive_pascal(t)}()"


def referenced_node_ids(desc: dict) -> set[str]:
    """Every real node id a descriptor (transitively) references --
    used to know which dummy_X()/class names need importing. Empty for
    a pure-primitive descriptor, however deeply nested."""
    if not isinstance(desc, dict) or "type" not in desc:
        raise TypeResolveError(f"not a valid type descriptor: {desc!r}")
    t = desc["type"]
    if t in PRIMITIVE_ANNOTATIONS:
        return set()
    if t == "list":
        return referenced_node_ids(desc["items"])
    if t == "map":
        return referenced_node_ids(desc["key"]) | referenced_node_ids(desc["value"])
    if t == "optional":
        return referenced_node_ids(desc["of"])
    return {t}
