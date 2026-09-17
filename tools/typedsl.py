"""
scaffolder/typedsl.py — parses the small type DSL used in
kharcha_graph.yaml's `interface.signature` and `interface.types`
strings (e.g. "list[str]", "dict[str, Decimal]", "str | None",
"'pending' | 'completed'", or a bare custom type name like
"ExpenseRecord") into:
  - a real Python type annotation string
  - a dummy-value expression string (for stub function bodies)
  - the set of custom type names referenced (so callers know what to import)

This is NOT a general Python type-expression parser — it covers
exactly the vocabulary observed across kharcha_graph.yaml's 7 custom
types and 22 leaf signatures (str, int, float, bool, Decimal, None,
list[X], dict[K,V], X | None, quoted-literal unions, and bare custom
type references). Extend it if a future graph uses something outside
that vocabulary — it will raise rather than silently guess wrong.
"""

from __future__ import annotations

from dataclasses import dataclass


class TypeDslError(ValueError):
    pass


def _split_top_level(s: str, sep: str) -> list[str]:
    """Split on `sep` but only at bracket-depth 0, so list[str, int]-
    style inner commas (or unions inside brackets) don't get split."""
    parts = []
    depth = 0
    current = ""
    i = 0
    while i < len(s):
        ch = s[i]
        if ch in "[{(":
            depth += 1
        elif ch in "]})":
            depth -= 1
        if depth == 0 and s[i:i + len(sep)] == sep:
            parts.append(current)
            current = ""
            i += len(sep)
            continue
        current += ch
        i += 1
    parts.append(current)
    return [p.strip() for p in parts]


@dataclass
class ParsedType:
    annotation: str          # real Python type annotation, e.g. "list[str]"
    dummy_expr: str            # e.g. "[]", 'Decimal("0")', "dummy_ExpenseRecord()"
    referenced_types: set      # custom type names referenced, e.g. {"ExpenseRecord"}


PRIMITIVES = {
    "str": ("str", '""'),
    "int": ("int", "0"),
    "float": ("float", "0.0"),
    "bool": ("bool", "False"),
    "Decimal": ("Decimal", 'Decimal("0")'),
    "None": ("None", "None"),
    "dict": ("dict", "{}"),   # bare, untyped dict (e.g. edit_expense's `updates: dict`)
    "list": ("list", "[]"),   # bare, untyped list, for symmetry
    # Added: the real example graphs use these four as type names
    # throughout (30 field occurrences across kharcha-tracker-v2.yaml
    # alone) but none were recognized -- every one silently degraded to
    # a 'str' placeholder via collect_data_model_types's tiered
    # fallback, which never crashes but does quietly lose real type
    # information across most of the schema's id/timestamp/string
    # fields. This is the "legitimate new pattern" this module's own
    # docstring says to extend for, not a graph-authoring mistake to
    # fix instead (unlike the raw-snake_case-id mistake documented in
    # validate_graph.py's own check for that separate issue).
    "string": ("str", '""'),        # plain alias for str -- same annotation and dummy
    "number": ("float", "0.0"),     # JSON-schema-style "number"; chose float as the safer numeric superset over int
    "UUID": ("str", '""'),          # plain str alias, not uuid.UUID -- no new import needed
    "timestamp": ("datetime", "datetime(1970, 1, 1)"),  # real datetime.datetime; callers must add `from datetime import datetime` when this dummy_expr is used -- see scaffold.py's needs_datetime (mirrors its existing needs_decimal)
}


def parse_type(expr: str, known_custom_types: set[str]) -> ParsedType:
    expr = expr.strip()

    # Union: "str | None", "'pending' | 'completed'"
    union_parts = _split_top_level(expr, "|")
    if len(union_parts) > 1:
        return _parse_union(union_parts, known_custom_types)

    # Quoted literal on its own (rare without a union, but handle it)
    if (expr.startswith("'") and expr.endswith("'")) or (expr.startswith('"') and expr.endswith('"')):
        literal = expr[1:-1]
        return ParsedType("str", f'"{literal}"', set())

    if expr in PRIMITIVES:
        ann, dummy = PRIMITIVES[expr]
        return ParsedType(ann, dummy, set())

    if expr.startswith("list[") and expr.endswith("]"):
        inner = parse_type(expr[5:-1], known_custom_types)
        return ParsedType(f"list[{inner.annotation}]", "[]", inner.referenced_types)

    if expr.startswith("dict[") and expr.endswith("]"):
        inner_parts = _split_top_level(expr[5:-1], ",")
        if len(inner_parts) != 2:
            raise TypeDslError(f"dict[...] must have exactly 2 params, got: {expr}")
        k = parse_type(inner_parts[0], known_custom_types)
        v = parse_type(inner_parts[1], known_custom_types)
        return ParsedType(f"dict[{k.annotation}, {v.annotation}]", "{}", k.referenced_types | v.referenced_types)

    if expr in known_custom_types:
        return ParsedType(expr, f"dummy_{expr}()", {expr})

    raise TypeDslError(
        f"Unrecognized type expression: {expr!r}. Not in the known "
        f"vocabulary (primitives, list[X], dict[K,V], X|None, quoted "
        f"literals, or a declared custom type). Extend typedsl.py if "
        f"this is a legitimate new pattern."
    )


def _parse_union(parts: list[str], known_custom_types: set[str]) -> ParsedType:
    # All-quoted-literal union (e.g. 'pending' | 'completed') -> plain
    # str, dummy = first literal.
    if all((p.startswith("'") and p.endswith("'")) or (p.startswith('"') and p.endswith('"')) for p in parts):
        first_literal = parts[0][1:-1]
        return ParsedType("str", f'"{first_literal}"', set())

    # Optional pattern: "X | None"
    non_none = [p for p in parts if p != "None"]
    has_none = len(non_none) < len(parts)
    if has_none and len(non_none) == 1:
        inner = parse_type(non_none[0], known_custom_types)
        return ParsedType(f"{inner.annotation} | None", "None", inner.referenced_types)

    raise TypeDslError(f"Unsupported union shape: {' | '.join(parts)}")


@dataclass
class ParsedField:
    name: str
    parsed: ParsedType


def parse_type_shape(shape: str, known_custom_types: set[str]) -> list[ParsedField]:
    """Parses a type's shape string, e.g.
    "{ id: str, shares: dict[str, Decimal], status: 'pending' }"
    into an ordered list of (field_name, ParsedType)."""
    s = shape.strip()
    if not (s.startswith("{") and s.endswith("}")):
        raise TypeDslError(f"Type shape must be {{...}}: {shape!r}")
    inner = s[1:-1].strip()
    if not inner:
        return []
    fields = []
    for part in _split_top_level(inner, ","):
        if ":" not in part:
            raise TypeDslError(f"Field missing ':' in shape: {part!r}")
        name, type_expr = part.split(":", 1)
        fields.append(ParsedField(name.strip(), parse_type(type_expr.strip(), known_custom_types)))
    return fields


@dataclass
class ParsedParam:
    name: str
    parsed: ParsedType


@dataclass
class ParsedSignature:
    func_name: str
    params: list[ParsedParam]
    return_type: ParsedType


def parse_signature(sig: str, known_custom_types: set[str]) -> ParsedSignature:
    """Parses "func_name(a: str, b: list[int]) -> ReturnType"."""
    if "->" not in sig:
        raise TypeDslError(f"Signature missing '->': {sig!r}")
    head, ret_expr = sig.rsplit("->", 1)
    head = head.strip()
    ret_expr = ret_expr.strip()

    if "(" not in head or not head.endswith(")"):
        raise TypeDslError(f"Signature missing parens: {sig!r}")
    func_name, paren_rest = head.split("(", 1)
    func_name = func_name.strip()
    params_str = paren_rest[:-1].strip()  # drop trailing ')'

    params = []
    if params_str:
        for part in _split_top_level(params_str, ","):
            if ":" not in part:
                raise TypeDslError(f"Param missing ':' in signature: {part!r}")
            pname, ptype = part.split(":", 1)
            params.append(ParsedParam(pname.strip(), parse_type(ptype.strip(), known_custom_types)))

    return_type = parse_type(ret_expr, known_custom_types)
    return ParsedSignature(func_name, params, return_type)
