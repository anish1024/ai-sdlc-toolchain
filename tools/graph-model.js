/**
 * graph-model.js — MODEL layer.
 *
 * Everything in this file is a pure function or a plain-data constant:
 * no DOM access, no D3, no `document`/`window` reads. It turns a parsed
 * graph.yaml object into a renderable hierarchy + cross-cutting edge
 * list (read side), and provides the mutation functions the editor
 * uses to add/delete nodes, manage dependencies, and register custom
 * protocols (write side).
 *
 * Because it's pure, it is directly unit-testable in Node with zero
 * setup:
 *
 *   node -e "const m = require('./graph-model.js'); console.log(m.STATUS_ORDER)"
 *
 * The View and Controller layers never mutate graph state directly —
 * they always go through the functions here, so every rule about what
 * makes a graph valid lives in exactly one place.
 */

/* =======================================================================
 * READ SIDE — turning raw parsed YAML into a tree + cross edges
 * ===================================================================== */

/**
 * Normalizes a raw parsed graph.yaml object (plain JS object from
 * js-yaml) into the shape every other function in this file expects:
 * { project, backbone, defaultBoundary, nodesById }.
 */
function normalizeGraph(raw) {
  const nodesById = {};
  for (const n of raw.nodes || []) {
    nodesById[n.id] = n;
  }
  return { project: raw.project, backbone: raw.backbone, defaultBoundary: raw.default_boundary, nodesById };
}

function childrenOf(nodeId, nodesById) {
  return Object.values(nodesById).filter((n) => n.parent === nodeId);
}

/**
 * Builds a d3.hierarchy-ready tree object rooted at the backbone,
 * using each node's `parent` field. Throws if the backbone id isn't
 * present, or if a node's parent points at a nonexistent id (both are
 * real error conditions worth surfacing loudly to whoever is using
 * this to VALIDATE a graph, not silently skipping them).
 */
function buildTree(normalized) {
  const { backbone, nodesById } = normalized;
  if (!nodesById[backbone]) {
    throw new Error(`backbone '${backbone}' not found among nodes`);
  }
  for (const n of Object.values(nodesById)) {
    if (n.parent && !nodesById[n.parent]) {
      throw new Error(`node '${n.id}' has parent '${n.parent}' which does not exist`);
    }
  }

  function build(id) {
    const node = nodesById[id];
    const kids = childrenOf(id, nodesById).map((c) => build(c.id));
    return { id, node, children: kids.length ? kids : undefined };
  }
  return build(backbone);
}

/**
 * Every dependency that is NOT the source node's own child (per the
 * `parent` field) is a "cross edge" worth drawing separately from the
 * tree — for a split/parent node, dependencies always equal its own
 * children (an established schema rule), so those are redundant with
 * the tree edges already drawn; for a leaf, EVERY dependency is a
 * cross edge, since leaves have no children of their own.
 */
function computeCrossEdges(normalized) {
  const { nodesById } = normalized;
  const edges = [];
  for (const n of Object.values(nodesById)) {
    const childIds = new Set(childrenOf(n.id, nodesById).map((c) => c.id));
    const ids = depIds(n);
    for (const dep of ids) {
      if (!childIds.has(dep)) {
        if (!nodesById[dep]) {
          // Dangling dependency reference -- a real data error, worth
          // surfacing rather than silently dropping.
          edges.push({ source: n.id, target: dep, dangling: true });
        } else {
          edges.push({ source: n.id, target: dep, dangling: false });
        }
      }
    }
  }
  return edges;
}

const STATUS_ORDER = ["unsplit", "contract_defined", "stub", "implementing", "implemented", "tested", "integrated"];
const STATUS_ENUM = STATUS_ORDER; // same array reference; kept as two names for call-site clarity (read vs. edit UI)

const STATUS_COLORS = {
  unsplit: "#9ca3af",
  contract_defined: "#3b82f6",
  stub: "#f59e0b",
  implementing: "#f97316",
  implemented: "#eab308",
  tested: "#a855f7",
  integrated: "#22c55e",
};

const BOUNDARY_MODULE = "module";
const BOUNDARY_SERVICE = "service";
const BOUNDARY_ENUM = [BOUNDARY_MODULE, BOUNDARY_SERVICE]; // node.boundary, when set, must be one of these

const MODEL_KIND_DTO = "dto";
const MODEL_KIND_DB_SCHEMA = "db_schema";
const MODEL_KIND_ENUM_TYPE = "enum";     // named _TYPE to avoid colliding with MODEL_KIND_VALUES below
const MODEL_KIND_CONSTANT = "constant";
// interface.model_kind, for data-model nodes. Renamed from the old
// `MODEL_KIND_ENUM` (this is the list of *values* model_kind can take,
// and "enum" is now also one of those values — keeping the old name
// would have made `MODEL_KIND_ENUM` include `"enum"` as a member,
// which reads badly at every call site).
const MODEL_KIND_VALUES = [MODEL_KIND_DTO, MODEL_KIND_DB_SCHEMA, MODEL_KIND_ENUM_TYPE, MODEL_KIND_CONSTANT];

/**
 * Overwrites STATUS_COLORS / STATUS_ORDER (and therefore STATUS_ENUM,
 * the same array) IN PLACE with an externally-loaded config, rather
 * than reassigning the module-level `const`s -- every other file
 * holds a direct reference to these exact objects (via the
 * `GraphModel` export below), so mutating in place is what makes a
 * config loaded after this module first runs actually take effect
 * everywhere without any file needing to re-fetch `GraphModel.*`.
 *
 * This is a boot-time configuration hook, not a general mutation API
 * -- it's meant to be called once, before any graph is rendered, not
 * during normal editing. See graph-config.js for the (browser-only)
 * fetch-from-JSON caller; this function itself stays DOM-free so
 * graph-model.js remains directly Node-testable with its built-in
 * defaults, with or without a config file ever being loaded.
 *
 * @param {Object<string,string>} statusColorMap  status -> hex color, in the order statuses should be enumerated
 */
function applyStatusConfig(statusColorMap) {
  if (!statusColorMap || typeof statusColorMap !== "object") return;
  const keys = Object.keys(statusColorMap);
  if (!keys.length) return;
  for (const k of Object.keys(STATUS_COLORS)) delete STATUS_COLORS[k];
  Object.assign(STATUS_COLORS, statusColorMap);
  STATUS_ORDER.length = 0;
  STATUS_ORDER.push(...keys);
}

/* =======================================================================
 * WRITE SIDE — mutation functions used by the editor
 * ===================================================================== */

const PROTOCOL_REGISTRY = {
  "rest": {
    label: "REST API (backbone)",
    color: "#a78bfa", // purple
    allowedChildren: ["python-module", "python-function"],
    fields: [],
    leafCapable: false,
    language: "python",
  },
  "python-module": {
    label: "Python module (service/package)",
    color: "#2dd4bf", // teal
    // "contract" and "class" added alongside the pre-existing three --
    // found missing during Python-side validator verification: without
    // these, a module could never actually contain the contract/class
    // pair the whole feature exists for, and a hand-edited graph.yaml
    // doing so anyway would (correctly) fail validate_graph.py's
    // matching check. See that file's own PROTOCOL_REGISTRY for the
    // Python-side mirror of this fix.
    allowedChildren: ["python-function", "python-module", "data-model", "contract", "class"],
    fields: ["exports"],
    leafCapable: false,
    language: "python",
  },
  "python-function": {
    label: "Python function (leaf)",
    color: "#fb7185", // coral
    allowedChildren: [],
    fields: ["signature", "types", "tests", "stub_behavior"],
    leafCapable: true,
    language: "python",
  },
  "browser-js": {
    label: "Frontend/JS surface",
    color: "#fbbf24", // amber
    allowedChildren: [],
    fields: ["exports"],
    leafCapable: true,
    connectsVia: "dependencies",
    language: "javascript",
  },
  "data-model": {
    label: "Data model (DTO / DB schema / enum / constant)",
    color: "#60a5fa", // blue
    allowedChildren: [],
    fields: ["model_kind", "model_fields"],
    leafCapable: true,
    // Deliberately no `language`: a data model is a shape, not
    // executable code in a given language, so it shouldn't trip
    // checkCrossLanguageBoundary just because a Python function
    // references it. See checkCrossLanguageBoundary below.
    language: null,
  },
  "contract": {
    label: "Contract (data-transfer interface)",
    color: "#c084fc", // violet
    allowedChildren: [],
    fields: ["methods"],
    leafCapable: false,
    // No language, same reasoning as data-model: a contract is a
    // boundary spec, not code in any one language. Per the "language
    // is a property of a subtree, not an individual node" principle,
    // the concrete `class` nodes that implement it (and THEIR
    // language-tagged function children) are where language lives.
    language: null,
  },
  "class": {
    label: "Class (implements a contract)",
    color: "#34d399", // emerald
    // Only python-function today because that's the only leaf-function
    // protocol this registry ships with. When a second language's leaf
    // function protocol is registered (custom or built-in), add it here
    // too -- same as python-module's allowedChildren already names
    // python-function explicitly rather than something more generic.
    allowedChildren: ["python-function"],
    fields: [],
    leafCapable: false,
    // No language on the class node itself either -- see `contract`
    // above. A class's language is implied by its function children's
    // own `language`, not declared redundantly on the class.
    language: null,
  },
};

// The 5 protocols shipped with this tool -- anything else in a working
// registry is a custom registration and needs to be exported alongside
// the graph, or it becomes an orphaned reference the moment the file
// is reloaded anywhere else.
const BUILTIN_PROTOCOL_IDS = new Set(Object.keys(PROTOCOL_REGISTRY));

/**
 * Overwrites PROTOCOL_REGISTRY (and BUILTIN_PROTOCOL_IDS, derived
 * from its keys) IN PLACE with an externally-loaded config. Same
 * boot-time-only, mutate-not-reassign rationale as applyStatusConfig
 * above -- see that function's doc comment.
 *
 * Each entry's shape must match a PROTOCOL_REGISTRY entry: label,
 * color (hex string), allowedChildren, fields, leafCapable, language
 * (null is valid -- see the built-in `data-model` entry above).
 *
 * @param {Object} protocolDefs  { [protocolId]: {label, color, allowedChildren, fields, leafCapable, language} }
 */
function applyProtocolRegistryConfig(protocolDefs) {
  if (!protocolDefs || typeof protocolDefs !== "object") return;
  const keys = Object.keys(protocolDefs);
  if (!keys.length) return;
  for (const k of Object.keys(PROTOCOL_REGISTRY)) delete PROTOCOL_REGISTRY[k];
  Object.assign(PROTOCOL_REGISTRY, protocolDefs);
  BUILTIN_PROTOCOL_IDS.clear();
  for (const k of keys) BUILTIN_PROTOCOL_IDS.add(k);
}

function depIds(node) {
  return (node.dependencies || []).map((d) => (typeof d === "string" ? d : d.node));
}

/**
 * Restores any custom protocols found in a loaded YAML's top-level
 * `protocol_registry` block into the working registry -- the other
 * half of graphToYamlObject below. Safe to call on a graph with no
 * such block (does nothing). Skips (with a console warning, not a
 * throw) any entry that collides with an already-registered id,
 * rather than silently overwriting a built-in.
 */
function restoreCustomProtocols(registry, rawYaml) {
  const block = rawYaml.protocol_registry;
  if (!block) return registry;
  for (const [id, def] of Object.entries(block)) {
    if (registry[id]) {
      console.warn(`protocol_registry entry '${id}' from the loaded file collides with an ` +
                   `already-registered protocol -- keeping the existing one, not overwriting it.`);
      continue;
    }
    registerCustomProtocol(registry, id, def);
  }
  return registry;
}

function registerCustomProtocol(registry, id, def) {
  if (registry[id]) {
    throw new Error(`Protocol '${id}' is already registered.`);
  }
  if (!id || !/^[a-z][a-z0-9-]*$/.test(id)) {
    throw new Error(`Protocol id must be lowercase, start with a letter, and use only letters/digits/hyphens. Got: '${id}'`);
  }
  if (!def.language || !def.language.trim()) {
    throw new Error(
      `A custom protocol must declare its language (e.g. 'python', 'swift', ` +
      `'kotlin', 'javascript') -- this is what lets validate_graph.py and the ` +
      `editor catch a same-process ('module') dependency edge that's actually ` +
      `impossible because it crosses a language boundary.`
    );
  }
  registry[id] = {
    label: def.label || id,
    color: def.color || "gray",
    allowedChildren: def.allowedChildren || [],
    fields: def.fields || ["note"],
    leafCapable: def.leafCapable ?? (def.fields || []).includes("signature"),
    language: def.language.trim(),
  };
  return registry;
}

function emptyNodeFor(id, protocol, parentId, registry) {
  if (!registry[protocol]) {
    throw new Error(`Unknown protocol '${protocol}'. Registered: ${Object.keys(registry).join(", ")}`);
  }
  const node = {
    id,
    title: "",
    status: "unsplit",
    boundary: null,
    parent: parentId || null,
    interface: { protocol },
    contract_version: "0.0.0",
    dependencies: [],
    stub_behavior: "",
    tests: [],
    notes: "",
  };
  if (protocol === "data-model") {
    // model_kind/model_fields are this protocol's own interface
    // fields (see PROTOCOL_REGISTRY); maps_to is a top-level,
    // sibling-to-dependencies relationship, not an interface field --
    // see addMapsTo's doc comment for why it isn't folded into
    // `dependencies`. Defaults to dto/model_fields shape; switching
    // model_kind to enum/constant in the edit form swaps which
    // interface sub-fields are actually used (see renderEditForm).
    node.interface.model_kind = MODEL_KIND_DTO;
    node.interface.model_fields = {};
    node.maps_to = [];
  }
  if (protocol === "contract") {
    node.interface.methods = [];
  }
  if (protocol === "class") {
    // implements is a top-level, sibling-to-dependencies/maps_to
    // relationship, not an interface field -- same reasoning as
    // maps_to: it's a structural "fulfills this contract" fact, not
    // a call, so it shouldn't feed checkCrossLanguageBoundary or blur
    // dependencies' meaning. See addImplements's doc comment.
    node.implements = [];
  }
  return node;
}

function validateAddChild(nodesById, parentId, childProtocol, registry) {
  const parent = nodesById[parentId];
  if (!parent) throw new Error(`Parent '${parentId}' does not exist.`);
  const parentProtocol = parent.interface && parent.interface.protocol;
  const rule = registry[parentProtocol];
  if (!rule) throw new Error(`Parent '${parentId}' has unknown protocol '${parentProtocol}'.`);
  if (!rule.allowedChildren.includes(childProtocol)) {
    const allowed = rule.allowedChildren.length ? rule.allowedChildren.join(", ") : "(none)";
    throw new Error(
      `'${parentProtocol}' nodes cannot have a '${childProtocol}' child. Allowed: ${allowed}`
    );
  }
}

function addNode(nodesById, node) {
  if (!node.id || !node.id.trim()) throw new Error("Node id cannot be empty.");
  if (nodesById[node.id]) throw new Error(`Node id '${node.id}' already exists.`);
  if (node.parent && !nodesById[node.parent]) {
    throw new Error(`Parent '${node.parent}' does not exist.`);
  }
  nodesById[node.id] = node;
  return nodesById;
}

function deleteNode(nodesById, nodeId) {
  if (!nodesById[nodeId]) throw new Error(`Node '${nodeId}' does not exist.`);
  const children = Object.values(nodesById).filter((n) => n.parent === nodeId);
  if (children.length > 0) {
    throw new Error(
      `Cannot delete '${nodeId}': it has ${children.length} child node(s) ` +
      `(${children.map((c) => c.id).join(", ")}). Delete or reparent them first.`
    );
  }
  const dependents = Object.values(nodesById).filter((n) => depIds(n).includes(nodeId));
  if (dependents.length > 0) {
    throw new Error(
      `Cannot delete '${nodeId}': ${dependents.length} node(s) depend on it ` +
      `(${dependents.map((d) => d.id).join(", ")}). Remove those dependencies first.`
    );
  }
  const mappers = Object.values(nodesById).filter((n) => mapsToIds(n).includes(nodeId));
  if (mappers.length > 0) {
    throw new Error(
      `Cannot delete '${nodeId}': ${mappers.length} node(s) map to it ` +
      `(${mappers.map((m) => m.id).join(", ")}). Remove those mappings first.`
    );
  }
  const implementers = Object.values(nodesById).filter((n) => implementsIds(n).includes(nodeId));
  if (implementers.length > 0) {
    throw new Error(
      `Cannot delete '${nodeId}': ${implementers.length} node(s) implement it ` +
      `(${implementers.map((m) => m.id).join(", ")}). Remove those relationships first.`
    );
  }
  delete nodesById[nodeId];
  return nodesById;
}

function addDependency(nodesById, fromId, toId) {
  const node = nodesById[fromId];
  if (!node) throw new Error(`Node '${fromId}' does not exist.`);
  if (!nodesById[toId]) throw new Error(`Cannot depend on '${toId}': it does not exist.`);
  if (fromId === toId) throw new Error(`A node cannot depend on itself.`);
  const existing = depIds(node);
  if (existing.includes(toId)) return nodesById; // no-op, already present
  node.dependencies = [...(node.dependencies || []), { node: toId }];
  return nodesById;
}

/**
 * Mirrors validate_graph.py's check 8: a dependency edge between two
 * nodes whose protocols declare different languages must have
 * boundary='service' -- 'module' (same-process direct call) is
 * physically impossible across languages. Returns a warning string,
 * or null if the edge is fine. Called from the editor's UI at the
 * point a dependency is added, so the mistake is caught at authoring
 * time, not only later by validate_graph.py.
 */
function checkCrossLanguageBoundary(nodesById, registry, fromId, toId, defaultBoundary) {
  const from = nodesById[fromId];
  const to = nodesById[toId];
  if (!from || !to) return null;
  const fromRule = registry[from.interface.protocol];
  const toRule = registry[to.interface.protocol];
  if (!fromRule || !toRule) return null; // unknown protocol -- nothing to check
  if (!fromRule.language || !toRule.language) return null; // a language-agnostic node (e.g. a shared data-model) makes no boundary claim
  if (fromRule.language === toRule.language) return null;
  const effectiveBoundary = from.boundary || defaultBoundary;
  if (effectiveBoundary !== BOUNDARY_SERVICE) {
    return (
      `'${fromId}' (${fromRule.language}) would depend on '${toId}' (${toRule.language}) -- ` +
      `a cross-language edge, but boundary is '${effectiveBoundary}', not 'service'. ` +
      `A same-process direct call is physically impossible across languages. ` +
      `Set '${fromId}'s boundary to 'service' before adding this dependency.`
    );
  }
  return null;
}

function removeDependency(nodesById, fromId, toId) {
  const node = nodesById[fromId];
  if (!node) throw new Error(`Node '${fromId}' does not exist.`);
  node.dependencies = (node.dependencies || []).filter((d) => (typeof d === "string" ? d : d.node) !== toId);
  return nodesById;
}

/* -----------------------------------------------------------------------
 * maps_to — a DB-schema-to-DTO (or, generically, model-to-model) type
 * mapping. Deliberately a SEPARATE relationship from `dependencies`,
 * not folded into it: `dependencies` means "calls / needs this to
 * function" and feeds checkCrossLanguageBoundary's same-process-call
 * reasoning. "This table's row shape maps to this DTO shape" isn't a
 * call, and running it through the dependency machinery would both
 * blur that meaning and risk spurious cross-language warnings for a
 * relationship that was never a call in the first place.
 * ------------------------------------------------------------------- */

function mapsToIds(node) {
  return (node.maps_to || []).map((d) => (typeof d === "string" ? d : d.node));
}

function addMapsTo(nodesById, fromId, toId) {
  const node = nodesById[fromId];
  if (!node) throw new Error(`Node '${fromId}' does not exist.`);
  if (!nodesById[toId]) throw new Error(`Cannot map to '${toId}': it does not exist.`);
  if (fromId === toId) throw new Error(`A node cannot map to itself.`);
  const existing = mapsToIds(node);
  if (existing.includes(toId)) return nodesById; // no-op, already present
  node.maps_to = [...(node.maps_to || []), toId];
  return nodesById;
}

function removeMapsTo(nodesById, fromId, toId) {
  const node = nodesById[fromId];
  if (!node) throw new Error(`Node '${fromId}' does not exist.`);
  node.maps_to = (node.maps_to || []).filter((d) => (typeof d === "string" ? d : d.node) !== toId);
  return nodesById;
}

/**
 * Read-side counterpart to computeCrossEdges, for the `maps_to`
 * relationship. Every maps_to entry is always drawn (unlike
 * dependencies, there's no "already implied by the tree" case to
 * exclude -- a type mapping is never a parent/child decomposition
 * edge). Flags dangling references the same way computeCrossEdges
 * does, for the same reason: a mapping to a deleted node is a real
 * data error worth surfacing.
 */
function computeMapsToEdges(normalized) {
  const { nodesById } = normalized;
  const edges = [];
  for (const n of Object.values(nodesById)) {
    for (const target of mapsToIds(n)) {
      edges.push({ source: n.id, target, dangling: !nodesById[target] });
    }
  }
  return edges;
}

/* -----------------------------------------------------------------------
 * implements — a class-to-contract structural relationship: "this class
 * fulfills this data-transfer contract." Deliberately a SEPARATE
 * relationship from `dependencies` and `maps_to`, for the same reason
 * `maps_to` is separate from `dependencies` (see that section's comment
 * above): `dependencies` means "calls / needs this to function" and
 * feeds checkCrossLanguageBoundary's same-process-call reasoning.
 * "This class fulfills this contract's shape" isn't a call either, so
 * it gets its own top-level field rather than being folded into
 * `dependencies` or conflated with `maps_to` (which is specifically
 * about a *data shape* mapping to another data shape, not a class
 * fulfilling a method contract).
 * ------------------------------------------------------------------- */

function implementsIds(node) {
  return (node.implements || []).map((d) => (typeof d === "string" ? d : d.node));
}

function addImplements(nodesById, fromId, toId) {
  const node = nodesById[fromId];
  if (!node) throw new Error(`Node '${fromId}' does not exist.`);
  const target = nodesById[toId];
  if (!target) throw new Error(`Cannot implement '${toId}': it does not exist.`);
  if (fromId === toId) throw new Error(`A node cannot implement itself.`);
  const targetProto = target.interface && target.interface.protocol;
  if (targetProto !== "contract") {
    throw new Error(`Cannot implement '${toId}': it is protocol '${targetProto}', not 'contract'.`);
  }
  const existing = implementsIds(node);
  if (existing.includes(toId)) return nodesById; // no-op, already present
  node.implements = [...(node.implements || []), { node: toId }];
  return nodesById;
}

function removeImplements(nodesById, fromId, toId) {
  const node = nodesById[fromId];
  if (!node) throw new Error(`Node '${fromId}' does not exist.`);
  node.implements = (node.implements || []).filter((d) => (typeof d === "string" ? d : d.node) !== toId);
  return nodesById;
}

/**
 * Read-side counterpart to computeCrossEdges/computeMapsToEdges, for
 * the `implements` relationship. Every implements entry is always
 * drawn (same reasoning as maps_to: it's never implied by the tree).
 * Flags dangling references the same way, for the same reason.
 */
function computeImplementsEdges(normalized) {
  const { nodesById } = normalized;
  const edges = [];
  for (const n of Object.values(nodesById)) {
    for (const target of implementsIds(n)) {
      edges.push({ source: n.id, target, dangling: !nodesById[target] });
    }
  }
  return edges;
}

function graphToYamlObject(normalized, registry) {
  const payload = {
    project: normalized.project,
    backbone: normalized.backbone,
    default_boundary: normalized.defaultBoundary,
    nodes: Object.values(normalized.nodesById),
  };

  if (registry) {
    const customEntries = Object.entries(registry).filter(([id]) => !BUILTIN_PROTOCOL_IDS.has(id));
    if (customEntries.length > 0) {
      payload.protocol_registry = Object.fromEntries(customEntries);
    }
  }

  return payload;
}

/* =======================================================================
 * Export — Node (CommonJS) for tests, `window.GraphModel` for the browser
 * ===================================================================== */

const GraphModel = {
  // read side
  normalizeGraph, childrenOf, buildTree, computeCrossEdges, computeMapsToEdges, computeImplementsEdges,
  STATUS_ORDER, STATUS_ENUM, STATUS_COLORS,
  BOUNDARY_MODULE, BOUNDARY_SERVICE, BOUNDARY_ENUM,
  MODEL_KIND_DTO, MODEL_KIND_DB_SCHEMA, MODEL_KIND_ENUM_TYPE, MODEL_KIND_CONSTANT, MODEL_KIND_VALUES,
  applyStatusConfig, applyProtocolRegistryConfig,
  // write side
  PROTOCOL_REGISTRY, BUILTIN_PROTOCOL_IDS, depIds, mapsToIds, implementsIds,
  registerCustomProtocol, restoreCustomProtocols, emptyNodeFor, validateAddChild,
  addNode, deleteNode, addDependency, removeDependency, addMapsTo, removeMapsTo,
  addImplements, removeImplements,
  graphToYamlObject, checkCrossLanguageBoundary,
};

if (typeof module !== "undefined" && module.exports) {
  module.exports = GraphModel;
}
if (typeof window !== "undefined") {
  window.GraphModel = GraphModel;
}
