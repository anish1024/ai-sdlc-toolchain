/**
 * validate-graph.js — VALIDATION layer, browser-side port of
 * validate_graph.py's validate() function.
 *
 * Deliberately NOT a reimplementation from scratch: graph-model.js
 * already carries live mirrors of several of validate_graph.py's
 * checks (checkTypeDescriptorShape ~ resolve_type_descriptor's
 * structural half, resolveLanguage ~ resolve_language,
 * checkCrossLanguageBoundary ~ check 8) -- those are reused here
 * rather than duplicated. This file adds the checks that don't yet
 * have a JS mirror: backbone existence, dangling parent/dependency/
 * maps_to/implements/calls/data_flows references, model_fields
 * duplicate names, status/test consistency, node-id collision risk,
 * and the full protocol/child-type/required-field sweep over every
 * node in the loaded graph (validateAddChild only checks one node
 * being added at a time, not a whole loaded/hand-edited graph).
 *
 * Like graph-model.js, this file is pure (no DOM) and Node-testable:
 *   node -e "const v = require('./validate-graph.js'); ..."
 *
 * Runs against the SAME normalized+registry shape graph-model.js and
 * graph-view.js already use -- no separate parse step needed, since
 * graph-controller.js always has `normalized`/`registry` in memory
 * already by the time Save is clicked.
 */

/**
 * required_fields per protocol -- kept as validate-graph.js's OWN
 * constant, deliberately NOT derived from the registry's `fields`
 * list (that list is "what the form shows", a superset -- not the
 * same thing as "must be present once this node is past unsplit").
 * Mirrors validate_graph.py's PROTOCOL_REGISTRY required_fields
 * exactly. Custom (non-built-in) protocols get [] here, same
 * reasoning as the Python file's load_full_registry -- no invented
 * requirement for a protocol this file doesn't know the shape of.
 */
const REQUIRED_FIELDS_BY_PROTOCOL = {
  entrypoint: [],
  module: [],
  function: ["params", "returns"],
  "browser-js": ["exports"],
  "data-model": ["model_kind"],
  contract: ["methods"],
  class: ["fields"],
};

const MODEL_KIND_REQUIRED_FIELDS = {
  dto: ["model_fields"],
  db_schema: ["model_fields"],
  enum: ["enum_type", "enum_values"],
  constant: ["constants"],
};

/**
 * Mirrors resolve_type_descriptor exactly, including the existence
 * check graph-model.js's checkTypeDescriptorShape deliberately leaves
 * out (that function is a live, per-keystroke UI check against nodes
 * that may not all be loaded yet; this is the authoritative,
 * whole-graph-loaded check). Returns null if legal, an error string
 * otherwise.
 */
function resolveTypeDescriptor(desc, nodesById) {
  if (!desc || typeof desc !== "object" || !("type" in desc)) {
    return "a type descriptor needs a 'type' key";
  }
  const t = desc.type;
  if (GraphModel.CANONICAL_PRIMITIVE_TYPES.includes(t)) return null;
  if (t === "list") {
    if (!("items" in desc)) return "type: list needs an 'items' descriptor";
    return resolveTypeDescriptor(desc.items, nodesById);
  }
  if (t === "map") {
    if (!("key" in desc) || !("value" in desc)) return "type: map needs 'key' and 'value' descriptors";
    const err = resolveTypeDescriptor(desc.key, nodesById);
    return err || resolveTypeDescriptor(desc.value, nodesById);
  }
  if (t === "optional") {
    if (!("of" in desc)) return "type: optional needs an 'of' descriptor";
    return resolveTypeDescriptor(desc.of, nodesById);
  }
  if (!nodesById[t]) {
    return `'${t}' is neither a canonical primitive (${GraphModel.CANONICAL_PRIMITIVE_TYPES.slice().sort().join(", ")}) nor an existing node id`;
  }
  return null;
}

/**
 * @param {object} normalized  as returned by GraphModel.normalizeGraph
 * @param {object} registry    the working protocol registry (built-ins + any custom protocols)
 * @returns {{errors: string[], warnings: string[]}}
 */
function validateGraph(normalized, registry) {
  const errors = [];
  const warnings = [];
  const { nodesById, backbone, defaultBoundary, defaultLanguage } = normalized;
  const nodes = Object.values(nodesById);

  // 1. Backbone must exist.
  if (!nodesById[backbone]) {
    errors.push(`backbone '${backbone}' does not exist among nodes`);
    return { errors, warnings }; // nothing else can be meaningfully checked
  }

  // 2. No dangling parent references.
  for (const n of nodes) {
    if (n.parent && !nodesById[n.parent]) {
      errors.push(`node '${n.id}' has parent '${n.parent}' which does not exist`);
    }
  }

  // 3. No dangling dependency references.
  for (const n of nodes) {
    for (const depId of GraphModel.depIds(n)) {
      if (!nodesById[depId]) errors.push(`node '${n.id}' depends on '${depId}' which does not exist`);
    }
  }

  // 3b. No dangling maps_to references.
  for (const n of nodes) {
    for (const targetId of GraphModel.mapsToIds(n)) {
      if (!nodesById[targetId]) errors.push(`node '${n.id}' maps_to '${targetId}' which does not exist`);
    }
  }

  // 3c. implements target(s) must actually be `contract` nodes.
  for (const n of nodes) {
    for (const targetId of GraphModel.implementsIds(n)) {
      const target = nodesById[targetId];
      if (!target) {
        errors.push(`node '${n.id}' implements '${targetId}' which does not exist`);
      } else if (!target.interface || target.interface.protocol !== "contract") {
        errors.push(
          `node '${n.id}' implements '${targetId}', but that node has protocol ` +
          `'${target.interface && target.interface.protocol}', not 'contract'`
        );
      }
    }
  }

  // 3j. No dangling calls references (new relationship, mirrors 3b/3c's pattern).
  for (const n of nodes) {
    for (const c of n.calls || []) {
      const targetId = typeof c === "string" ? c : c.node;
      if (!nodesById[targetId]) errors.push(`node '${n.id}' calls '${targetId}' which does not exist`);
    }
  }

  // 3k. No dangling data_flows references (new relationship).
  for (const n of nodes) {
    for (const d of n.data_flows || []) {
      const targetId = typeof d === "string" ? d : d.node;
      if (!nodesById[targetId]) errors.push(`node '${n.id}' has a data_flow to '${targetId}' which does not exist`);
      if (d.data_model && !nodesById[d.data_model]) {
        warnings.push(`node '${n.id}' has a data_flow referencing data_model '${d.data_model}' which does not exist as a node`);
      }
    }
  }

  // 3d. contract method param/return types must resolve.
  for (const n of nodes) {
    if (!n.interface || n.interface.protocol !== "contract") continue;
    for (const m of n.interface.methods || []) {
      for (const p of m.params || []) {
        const err = resolveTypeDescriptor(p.type, nodesById);
        if (err) errors.push(`node '${n.id}' method '${m.name}' param '${p.name}': ${err}`);
      }
      const err = resolveTypeDescriptor(m.returns, nodesById);
      if (err) errors.push(`node '${n.id}' method '${m.name}' returns: ${err}`);
    }
  }

  // 3e. function params/returns must resolve.
  for (const n of nodes) {
    if (!n.interface || n.interface.protocol !== "function") continue;
    for (const p of n.interface.params || []) {
      const err = resolveTypeDescriptor(p.type, nodesById);
      if (err) errors.push(`node '${n.id}' param '${p.name}': ${err}`);
    }
    if (n.interface.returns) {
      const err = resolveTypeDescriptor(n.interface.returns, nodesById);
      if (err) errors.push(`node '${n.id}' returns: ${err}`);
    }
  }

  // 3f. class.fields must resolve.
  for (const n of nodes) {
    if (!n.interface || n.interface.protocol !== "class") continue;
    for (const f of n.interface.fields || []) {
      const err = resolveTypeDescriptor(f.type, nodesById);
      if (err) errors.push(`node '${n.id}' field '${f.name}': ${err}`);
    }
  }

  // 3g. layout: only on `module`, enum-checked, "file" only legal if every child is a function.
  for (const n of nodes) {
    const layout = n.interface && n.interface.layout;
    if (!layout) continue;
    if (n.interface.protocol !== "module") {
      errors.push(`node '${n.id}' sets layout='${layout}' but is protocol='${n.interface.protocol}' -- layout only applies to module`);
      continue;
    }
    if (!GraphModel.LAYOUT_ENUM.includes(layout)) {
      errors.push(`node '${n.id}' has layout='${layout}', not one of ${GraphModel.LAYOUT_ENUM.join(", ")}`);
      continue;
    }
    if (layout === GraphModel.LAYOUT_FILE) {
      const children = GraphModel.childrenOf(n.id, nodesById);
      const nonFunction = children.filter((c) => c.interface.protocol !== "function").map((c) => c.id);
      if (nonFunction.length) {
        errors.push(
          `node '${n.id}' has layout='file' but has non-function child(ren) ${nonFunction.sort().join(", ")} -- ` +
          `a module can only be layout: file if EVERY direct child is a function; set layout: folder instead ` +
          `(or remove layout to let it be inferred automatically)`
        );
      }
    }
  }

  // 3h. http_method/route must be set together.
  for (const n of nodes) {
    if (!n.interface || n.interface.protocol !== "function") continue;
    const hasMethod = !!n.interface.http_method;
    const hasRoute = !!n.interface.route;
    if (hasMethod !== hasRoute) {
      const missing = hasMethod ? "route" : "http_method";
      warnings.push(`node '${n.id}' has ${hasMethod ? "http_method" : "route"} set but not '${missing}' -- an endpoint generator requires both to wire an endpoint; as-is it silently gets no route.`);
    }
  }

  // 3i. model_fields: dup names + resolvable types.
  for (const n of nodes) {
    if (!n.interface || n.interface.protocol !== "data-model") continue;
    const mf = n.interface.model_fields;
    if (!Array.isArray(mf)) continue;
    const names = mf.map((f) => f.name);
    const dupes = [...new Set(names.filter((x, i) => names.indexOf(x) !== i))];
    if (dupes.length) errors.push(`node '${n.id}' has duplicate model_fields name(s): ${dupes.sort().join(", ")}`);
    for (const f of mf) {
      if (!("name" in f)) { errors.push(`node '${n.id}': a model_fields entry is missing 'name'`); continue; }
      const err = resolveTypeDescriptor(f.type, nodesById);
      if (err) errors.push(`node '${n.id}' field '${f.name}': ${err}`);
    }
  }

  // 4. A parent's dependencies must include ALL its children.
  for (const n of nodes) {
    const childIds = new Set(GraphModel.childrenOf(n.id, nodesById).map((c) => c.id));
    if (childIds.size) {
      const depIds = new Set(GraphModel.depIds(n));
      const missing = [...childIds].filter((id) => !depIds.has(id));
      if (missing.length) {
        errors.push(`node '${n.id}' has children ${missing.sort().join(", ")} missing from its own dependencies list (a split node must list every child it created, since it literally calls them)`);
      }
    }
  }

  // 5. Protocol-based structural rules + required fields + model_kind specifics.
  for (const n of nodes) {
    const proto = n.interface && n.interface.protocol;
    const rule = registry[proto];
    if (!rule) {
      warnings.push(`node '${n.id}' has protocol '${proto}', not in the working registry -- skipping protocol-specific checks for it.`);
      continue;
    }
    const children = GraphModel.childrenOf(n.id, nodesById);
    if (children.length && (!rule.allowedChildren || !rule.allowedChildren.length)) {
      errors.push(`node '${n.id}' (protocol=${proto}) has children ${children.map((c) => c.id).sort().join(", ")} but this protocol allows none`);
    } else {
      for (const c of children) {
        const cProto = c.interface && c.interface.protocol;
        if (!rule.allowedChildren.includes(cProto)) {
          errors.push(`node '${n.id}' (protocol=${proto}) has child '${c.id}' with protocol '${cProto}', not an allowed child type (allowed: ${(rule.allowedChildren || []).slice().sort().join(", ") || "(none)"})`);
        }
      }
    }
    for (const field of REQUIRED_FIELDS_BY_PROTOCOL[proto] || []) {
      if (n.status !== "unsplit" && !(n.interface && field in n.interface)) {
        warnings.push(`node '${n.id}' (protocol=${proto}, status=${n.status}) is missing expected interface field '${field}'`);
      }
    }
    if (proto === "data-model" && n.interface.model_kind !== undefined) {
      const modelKind = n.interface.model_kind;
      if (!GraphModel.MODEL_KIND_VALUES.includes(modelKind)) {
        errors.push(`node '${n.id}' has model_kind='${modelKind}', not one of ${GraphModel.MODEL_KIND_VALUES.slice().sort().join(", ")}`);
      } else {
        for (const kindField of MODEL_KIND_REQUIRED_FIELDS[modelKind] || []) {
          if (n.status !== "unsplit" && !(kindField in n.interface)) {
            warnings.push(`node '${n.id}' (model_kind=${modelKind}, status=${n.status}) is missing expected interface field '${kindField}'`);
          }
        }
        if (modelKind === "enum") {
          const names = (n.interface.enum_values || []).map((v) => v.name);
          const dupes = [...new Set(names.filter((x, i) => names.indexOf(x) !== i))];
          if (dupes.length) errors.push(`node '${n.id}' has duplicate enum_values name(s): ${dupes.sort().join(", ")}`);
        }
        if (modelKind === "constant") {
          const names = (n.interface.constants || []).map((c) => c.name);
          const dupes = [...new Set(names.filter((x, i) => names.indexOf(x) !== i))];
          if (dupes.length) errors.push(`node '${n.id}' has duplicate constants name(s): ${dupes.sort().join(", ")}`);
        }
      }
    }
  }

  // 6. Status/test consistency.
  for (const n of nodes) {
    if ((n.status === "tested" || n.status === "integrated") && !(n.tests && n.tests.length)) {
      errors.push(`node '${n.id}' claims status='${n.status}' but has no tests -- check for a stale or hand-edited status field`);
    }
  }

  // 7. Node-id / generated-path collision risk.
  const ids = new Set(nodesById ? Object.keys(nodesById) : []);
  for (const id of ids) {
    const hasDottedChild = [...ids].some((other) => other !== id && other.startsWith(id + "."));
    if (hasDottedChild) {
      warnings.push(`node '${id}' is a dotted-prefix of other node id(s) (e.g. '${id}.x') -- double-check generated file placement for this pattern.`);
    }
  }

  // 8. Cross-language dependency edges must declare boundary=service.
  for (const n of nodes) {
    const nProto = n.interface && n.interface.protocol;
    if (!registry[nProto]) continue; // already warned about in check 5
    for (const depId of GraphModel.depIds(n)) {
      const dep = nodesById[depId];
      if (!dep) continue; // already an error from check 3
      if (!registry[dep.interface && dep.interface.protocol]) continue;
      const warning = GraphModel.checkCrossLanguageBoundary(nodesById, registry, n.id, depId, defaultBoundary, defaultLanguage);
      if (warning) errors.push(warning);
    }
  }

  return { errors, warnings };
}

const GraphValidate = { validateGraph, resolveTypeDescriptor, REQUIRED_FIELDS_BY_PROTOCOL, MODEL_KIND_REQUIRED_FIELDS };

if (typeof module !== "undefined" && module.exports) {
  module.exports = GraphValidate;
}
if (typeof window !== "undefined") {
  window.GraphValidate = GraphValidate;
}
