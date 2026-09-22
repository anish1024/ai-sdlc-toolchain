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
 * { project, backbone, defaultBoundary, defaultLanguage, nodesById }.
 */
function normalizeGraph(raw) {
  const nodesById = {};
  for (const n of raw.nodes || []) {
    nodesById[n.id] = n;
  }
  return {
    project: raw.project,
    backbone: raw.backbone,
    defaultBoundary: raw.default_boundary,
    defaultLanguage: raw.default_language, // Revision 3 -- mirrors default_boundary's own fallback pattern, see resolveLanguage
    nodesById,
  };
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
 * Every dependency is drawn as a "cross edge", separate from the tree
 * edges `parent` already produces. `dependencies` no longer has any
 * containment meaning (there used to be a rule that a parent's
 * dependencies must mirror its own children -- removed: containment
 * is fully expressed by `parent` already, and conflating it with
 * `dependencies` blurred the one thing `dependencies` is actually
 * for -- "this node's code imports/references that node's unit". See
 * addDependency's doc comment for the current source/target rules.
 * The `!childIds.has(dep)` guard below is defensive only, in case a
 * hand-edited graph.yaml still lists a real child as a dependency.
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

const LAYOUT_FILE = "file";
const LAYOUT_FOLDER = "folder";
// interface.layout, `module` only. Revision 3: now OPTIONAL and
// INFERRED when absent -- see inferredLayout() above. "file" is only
// a legal explicit value when every direct child is protocol
// "function" (enforced by validate_graph.py as an error, not just
// documented); any module with a `module`/`class`/`data-model`/
// `contract` child must be "folder". "folder" means the module
// becomes a real package: one file per leaf `function` descendant,
// recursively -- see module_scaffold.py's write_folder_module().
// Deliberately `module` only, not `class`: a class's methods belong
// together in one file/class body.
const LAYOUT_ENUM = [LAYOUT_FILE, LAYOUT_FOLDER];

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

// --- Revision 3: the structured type system shared by model_fields,
// function params/returns, contract.methods params/returns, and
// class.fields. A "type descriptor" is:
//   { type: <scalar keyword> }                              -- a primitive
//   { type: <node id> }                                      -- a reference to a real node (an enum, a DTO, another data-model)
//   { type: "list", items: <type descriptor> }                -- fully nested, no embedded syntax
//   { type: "map", key: <type descriptor>, value: <type descriptor> }
//   { type: "optional", of: <type descriptor> }
// Deliberately NOT Python's own type names (str/int/None, the PEP 604
// `X | None` union) -- a small neutral vocabulary instead, so the same
// descriptor means the same thing regardless of target language. This
// table is also the seed of each future per-language generator's own
// type-mapping module (a csharp_lang.py, etc.) -- see the Revision 3
// proposal doc, "why this is the real path to multi-language."
const CANONICAL_PRIMITIVE_TYPES = [
  "string", "integer", "float", "boolean", "decimal", "datetime", "uuid",
  "none", // no value -- valid as a function's `returns` type only
];
const TYPE_WRAPPER_KINDS = ["list", "map", "optional"];

/**
 * Resolves whether a type descriptor's `type` value is legal: a
 * canonical primitive, one of the three structural wrappers (which
 * then need their own nested descriptor(s) checked too), or a real
 * node id. Returns {ok: true} or {ok: false, error: "..."} -- doesn't
 * throw, since callers (the editor's live form, and validate_graph.py's
 * mirror of this same logic) want to surface the message, not crash.
 * This function does the STRUCTURAL check only; validate_graph.py is
 * the one place that also confirms a referenced node id actually
 * exists and is an appropriate kind (an enum/data-model, not e.g. a
 * module) -- the editor can't always do that same existence check
 * live against nodes that may not be loaded yet, so it stays a
 * Python-side responsibility for the authoritative answer.
 */
function checkTypeDescriptorShape(desc) {
  if (!desc || typeof desc !== "object" || !desc.type) {
    return { ok: false, error: "a type descriptor needs a 'type' key" };
  }
  if (CANONICAL_PRIMITIVE_TYPES.includes(desc.type)) return { ok: true };
  if (desc.type === "list") {
    if (!desc.items) return { ok: false, error: "type: list needs an 'items' descriptor" };
    return checkTypeDescriptorShape(desc.items);
  }
  if (desc.type === "map") {
    if (!desc.key || !desc.value) return { ok: false, error: "type: map needs 'key' and 'value' descriptors" };
    const k = checkTypeDescriptorShape(desc.key);
    if (!k.ok) return k;
    return checkTypeDescriptorShape(desc.value);
  }
  if (desc.type === "optional") {
    if (!desc.of) return { ok: false, error: "type: optional needs an 'of' descriptor" };
    return checkTypeDescriptorShape(desc.of);
  }
  // Anything else is treated as a node-id reference -- existence is
  // checked by validate_graph.py, not here (see docstring above).
  return { ok: true };
}

/* -----------------------------------------------------------------------
 * JSON Schema -> model_fields conversion. Lets a `data-model` node's
 * `model_fields` textarea accept a pasted JSON Schema (draft-07 style
 * `{properties: {...}, required: [...]}` object) as an ALTERNATE
 * input format, converted once at Save time into our one canonical
 * `model_fields` array shape -- nothing downstream (validator, prompt
 * composer, edit form re-render) ever sees or needs to know about the
 * JSON Schema shape; it exists for exactly one conversion, not as a
 * second persisted representation.
 * ------------------------------------------------------------------- */

// JSON Schema `format` values that map onto one of OUR canonical
// primitives directly (see CANONICAL_PRIMITIVE_TYPES above) --
// deliberately small: an unrecognized format falls through to plain
// `string` rather than guessing at a mapping that doesn't exist.
const JSON_SCHEMA_FORMAT_TO_PRIMITIVE = {
  uuid: "uuid",
  "date-time": "datetime",
};

/**
 * A top-level object with a `properties` key is unambiguously a JSON
 * Schema -- our own model_fields shape is always an array, never an
 * object -- so this split needs no heuristics and can't misclassify
 * either shape as the other.
 */
function looksLikeJsonSchema(parsed) {
  return !!(parsed && typeof parsed === "object" && !Array.isArray(parsed)
    && parsed.properties && typeof parsed.properties === "object");
}

/**
 * One JSON Schema property definition -> one of our type descriptors.
 * Recurses for `type: array`'s `items`. Handles the `["X", "null"]`
 * nullable-union idiom by wrapping the resolved base type in our
 * `optional` wrapper -- this is independent of (not a substitute for)
 * the field's own `required` flag, which comes from the schema's
 * top-level `required` array instead (presence vs. nullability are
 * different axes; JSON Schema conflates them, we don't).
 */
function jsonSchemaPropertyToTypeDescriptor(propSchema) {
  const rawTypes = propSchema.type === undefined ? ["string"] : propSchema.type; // no "type" at all (e.g. enum-only) -- fall back to string
  const typeList = Array.isArray(rawTypes) ? rawTypes : [rawTypes];
  const isNullable = typeList.includes("null");
  const primaryType = typeList.find((t) => t !== "null") || "string";

  let base;
  if (primaryType === "array") {
    base = { type: "list", items: propSchema.items ? jsonSchemaPropertyToTypeDescriptor(propSchema.items) : { type: "string" } };
  } else if (primaryType === "string" && propSchema.format && JSON_SCHEMA_FORMAT_TO_PRIMITIVE[propSchema.format]) {
    base = { type: JSON_SCHEMA_FORMAT_TO_PRIMITIVE[propSchema.format] };
  } else if (primaryType === "number") {
    base = { type: "float" }; // JSON Schema's "number" (float) vs "integer" -- we already have both as distinct primitives
  } else if (CANONICAL_PRIMITIVE_TYPES.includes(primaryType)) {
    base = { type: primaryType }; // string/integer/boolean/etc. -- names already match ours directly
  } else {
    base = { type: "string" }; // unrecognized JSON Schema type -- safe fallback, not a guess at something more specific
  }
  return isNullable ? { type: "optional", of: base } : base;
}

/**
 * Everything a JSON Schema property can express that has NO field in
 * our shape (`enum`, `pattern`, `minLength`/`maxLength`, `default`,
 * `readOnly`) gets folded into that field's `notes` as short
 * parenthetical documentation -- preserved for a human/LLM to read,
 * not machine-enforced by our type system. `description` (if present)
 * comes first, unannotated.
 */
function jsonSchemaPropertyToNotes(propSchema) {
  const parts = [];
  if (propSchema.description) parts.push(propSchema.description);
  const annotations = [];
  if (propSchema.enum) annotations.push(`allowed: ${propSchema.enum.join(", ")}`);
  if (propSchema.pattern) annotations.push(`pattern: ${propSchema.pattern}`);
  if (propSchema.minLength !== undefined || propSchema.maxLength !== undefined) {
    annotations.push(`length: ${propSchema.minLength !== undefined ? propSchema.minLength : "0"}-${propSchema.maxLength !== undefined ? propSchema.maxLength : "*"}`);
  }
  if (propSchema.default !== undefined) annotations.push(`default: ${JSON.stringify(propSchema.default)}`);
  if (propSchema.readOnly) annotations.push("read-only");
  if (annotations.length) parts.push(`(${annotations.join("; ")})`);
  return parts.join(" ");
}

/**
 * Converts a whole JSON Schema object into `{ model_fields, title?, notes? }`.
 * `title`/`notes` are only present if the schema itself had a
 * top-level `title`/`description` -- the caller decides whether/how
 * to apply them (see graph-controller.js's f-save handler: `title`
 * only backfills an EMPTY Title field, `notes` PREPENDS rather than
 * overwrites, both deliberately non-destructive of anything the user
 * already typed in the same form).
 */
function convertJsonSchemaToModelFields(schema) {
  const requiredSet = new Set(Array.isArray(schema.required) ? schema.required : []);
  const model_fields = Object.keys(schema.properties || {}).map((name) => {
    const propSchema = schema.properties[name] || {};
    const field = {
      name,
      type: jsonSchemaPropertyToTypeDescriptor(propSchema),
      required: requiredSet.has(name),
    };
    const notes = jsonSchemaPropertyToNotes(propSchema);
    if (notes) field.notes = notes;
    return field;
  });
  const result = { model_fields };
  if (schema.title) result.title = schema.title;
  if (schema.description) result.notes = schema.description;
  return result;
}

/**
 * Revision 3's layout inference (see the proposal doc §7): a module
 * may be layout: "file" only if EVERY direct child is protocol
 * "function" (vacuously true with zero children too). If the node
 * explicitly sets `layout`, that's honored as-is (validate_graph.py
 * is what enforces the invariant as an error, not this function --
 * this is a read-side helper for the editor to display the EFFECTIVE
 * layout, not a gate). If unset, infer folder unless all-function.
 */
function inferredLayout(nodeId, normalized) {
  const node = normalized.nodesById[nodeId];
  if (!node) return LAYOUT_FILE;
  if (node.interface && node.interface.layout) return node.interface.layout;
  const children = Object.values(normalized.nodesById).filter((n) => n.parent === nodeId);
  const allFunctions = children.every((c) => c.interface && c.interface.protocol === "function");
  return allFunctions ? LAYOUT_FILE : LAYOUT_FOLDER;
}

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
  "entrypoint": {
    label: "Application entrypoint (backbone)",
    color: "#a78bfa", // purple
    // Now purely structural -- the ONE required root of the file
    // (buildPath/validate-graph.js's backbone logic both still assume
    // exactly one). It generates nothing of its own (never leaf-
    // capable, never skeleton-eligible) and now only ever holds
    // `gateway` children -- real content starts one level down.
    allowedChildren: ["gateway"],
    fields: [],
    leafCapable: false,
  },
  "gateway": {
    label: "Gateway (communication/transport boundary)",
    color: "#9ca3af", // gray -- infrastructure, deliberately understated next to service's color
    // Purely organizational, like entrypoint: groups the service(s)
    // reachable through one transport. Never itself a generated file
    // (not leaf-capable, not skeleton-eligible) -- see buildPath's
    // explicit skip of `gateway` ancestors, so it never appears as a
    // path segment either. `transport` is deliberately the only field
    // for now -- routing/load-balancer/gateway-spec details are an
    // explicitly deferred future extension, not guessed at here.
    allowedChildren: ["service"],
    fields: ["transport"],
    leafCapable: false,
  },
  "service": {
    label: "Service (independently deployable unit)",
    color: "#fb923c", // orange
    // Takes over what `entrypoint` used to allow directly -- a
    // service is "the entry-point to that service/package of
    // modules." `language` here (not on entrypoint/gateway) is what
    // resolveLanguage's ancestor-walk now also stops at, same shape
    // and inheritance-to-descendants behavior as `module.language`.
    allowedChildren: ["function", "module"],
    fields: ["language"],
    leafCapable: false,
  },
  "module": {
    label: "Module (service/package)",
    color: "#2dd4bf", // teal
    // Renamed from "python-module".
    allowedChildren: ["function", "module", "data-model", "contract", "class"],
    // "language" is a new field here (not a registry constant) --
    // optional; only `module` nodes can declare it, inherited by
    // everything below unless overridden by a nested module.
    // "tests"/"stub_behavior" here (like on every protocol below that
    // lists them) just control the edit-form's optional-field
    // visibility -- both are actually top-level node fields
    // (node.tests/node.stub_behavior), not under `interface`, and
    // exist on every node's default shape already (see emptyNodeFor).
    fields: ["exports", "layout", "language", "tests", "stub_behavior"],
    leafCapable: false,
  },
  "function": {
    label: "Function (leaf)",
    color: "#fb7185", // coral
    // Renamed from "python-function". `signature` (a free-text string
    // typedsl.py had to parse) and `types` (inline ad-hoc type shapes)
    // are BOTH retired -- see `params`/`returns` below, which reuse
    // `contract.methods`' own structured shape instead of a second,
    // parallel representation of the same concept. `types` is retired
    // for the same reason: an inline, un-named shape is exactly the
    // kind of free-text flexibility Revision 3 is removing -- a shape
    // that needs a name should be its own data-model node instead.
    allowedChildren: [],
    // errors/preconditions/postconditions: the part of a function's
    // contract that isn't a type (params/returns already cover that)
    // and isn't free-text guidance (notes/stub_behavior already cover
    // that) -- structured facts a prompt-builder iterates over. Added
    // deliberately as fields on `function` itself rather than as a
    // separate `operations` list: Revision 3 already decomposes every
    // operation into its own `function` leaf node, so a list-of-operations
    // block here would duplicate that decomposition.
    fields: ["params", "returns", "tests", "stub_behavior", "http_method", "route", "errors", "preconditions", "postconditions"],
    leafCapable: true,
  },
  "browser-js": {
    label: "Frontend/JS surface",
    color: "#fbbf24", // amber
    allowedChildren: [],
    fields: ["exports", "stub_behavior", "tests"],
    leafCapable: true,
    connectsVia: "dependencies",
    // Deliberately UNCHANGED by Revision 3 -- frontend is its own,
    // separate future design effort (Phase 2), not touched by this
    // pass. Still uses the OLD per-protocol-constant language
    // mechanism; resolveLanguage below special-cases this.
    language: "javascript",
  },
  "data-model": {
    label: "Data model (DTO / DB schema / enum / constant)",
    color: "#60a5fa", // blue
    allowedChildren: [],
    // model_fields is now a list of {name, type, required?, notes?}
    // objects -- see the TYPE_DESCRIPTOR docs below -- not a flat
    // {fieldName: typeString} map.
    fields: ["model_kind", "model_fields", "stub_behavior"],
    leafCapable: true,
    // No special-cased `language: null` needed anymore -- under the
    // new ancestor-walk resolution, a data-model node simply doesn't
    // declare its own language and inherits from its nearest module
    // ancestor like anything else. If NOTHING in the tree declares a
    // language at all, resolution falls through to `undefined`
    // uniformly for every node type, and checkCrossLanguageBoundary
    // skips the same way it used to for the old `null` sentinel --
    // same end behavior, reached by one general mechanism instead of
    // a per-protocol special case.
  },
  "contract": {
    label: "Contract (data-transfer interface)",
    color: "#c084fc", // violet
    allowedChildren: [],
    // methods[].params[]/.returns now use the same structured
    // TYPE_DESCRIPTOR shape as everything else (list/map/optional are
    // fully-nested objects, never embedded string syntax).
    fields: ["methods"],
    leafCapable: false,
  },
  "class": {
    label: "Class (implements a contract)",
    color: "#34d399", // emerald
    allowedChildren: ["function"],
    // New: `fields` (instance state -- {name, type} minimal for now,
    // per the accepted proposal). Note this is a registry `fields`
    // LIST containing the literal string "fields" (the new interface
    // sub-field name) -- a little odd to read, not a bug; the two
    // "fields" mean different things (which sub-fields this protocol
    // renders vs. this class's own instance attributes).
    fields: ["fields", "tests", "stub_behavior"],
    leafCapable: false,
  },
};

// The 5 protocols shipped with this tool -- anything else in a working
// registry is a custom registration and needs to be exported alongside
// the graph, or it becomes an orphaned reference the moment the file
// is reloaded anywhere else.
const BUILTIN_PROTOCOL_IDS = new Set(Object.keys(PROTOCOL_REGISTRY));

/**
 * Protocols that can hold a `prompt_template` override at all -- i.e.
 * everything that (per isLeafCapable/isSkeletonEligible in
 * prompt-generator.js) actually holds/produces real code and gets
 * worked on by a coding agent. `entrypoint` is deliberately excluded
 * -- it never generates anything (isLeafCapable=false,
 * isSkeletonEligible=false, so nodeKind is always null for it).
 * A protocol being IN this list doesn't guarantee a prompt gets
 * generated right now for every instance (e.g. a `layout: folder`
 * module still has no single shared file to skeleton) -- that
 * instance-level decision stays with nodeKind/isPromptable, unchanged
 * by this list. This only gates whether the override FIELD is shown
 * at all for the protocol.
 */
const PROMPT_TEMPLATE_PROTOCOLS = ["function", "module", "class", "browser-js", "data-model", "contract"];

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
    calls: [],       // third instance of the maps_to/implements pattern -- see addCall's doc comment
    data_flows: [],  // fourth instance -- see addDataFlow's doc comment
    stub_behavior: "",
    tests: [],
    notes: "",
    prompt_template: "", // optional per-node override of the default composition template -- see prompt-generator.js
    prompt: "", // the reviewed/edited generated prompt itself -- distinct from prompt_template (the recipe); see the "Generate prompt" button
  };
  if (protocol === "data-model") {
    // model_kind/model_fields are this protocol's own interface
    // fields (see PROTOCOL_REGISTRY); maps_to is a top-level,
    // sibling-to-dependencies relationship, not an interface field --
    // see addMapsTo's doc comment for why it isn't folded into
    // `dependencies`. Defaults to dto/model_fields shape; switching
    // model_kind to enum/constant in the edit form swaps which
    // interface sub-fields are actually used (see renderEditForm).
    // model_fields is now a LIST (Revision 3), not a flat map --
    // matches enum_values/constants/methods' own shape.
    node.interface.model_kind = MODEL_KIND_DTO;
    node.interface.model_fields = [];
    node.maps_to = [];
  }
  if (protocol === "contract") {
    node.interface.methods = [];
  }
  if (protocol === "function") {
    // Revision 3: structured params/returns replace the old free-text
    // `signature` string entirely -- same shape contract.methods[]
    // already used. "none" is the canonical no-return-value type.
    node.interface.params = [];
    node.interface.returns = { type: "none" };
    // errors: [{code, description}]; preconditions/postconditions:
    // [string] -- the structured-but-not-typed part of a function's
    // contract (see PROTOCOL_REGISTRY's "function" entry doc comment).
    node.interface.errors = [];
    node.interface.preconditions = [];
    node.interface.postconditions = [];
  }
  if (protocol === "class") {
    // implements is a top-level, sibling-to-dependencies/maps_to
    // relationship, not an interface field -- same reasoning as
    // maps_to: it's a structural "fulfills this contract" fact, not
    // a call, so it shouldn't feed checkCrossLanguageBoundary or blur
    // dependencies' meaning. See addImplements's doc comment.
    // `fields` (new, Revision 3) IS a real interface field, unlike
    // `implements` -- it's this class's own instance state, not a
    // relationship to another node.
    node.interface.fields = [];
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

/**
 * `dependencies` means "this node's code imports/references that
 * node's unit" -- a real import edge, not containment (containment is
 * `parent`'s job alone; see computeCrossEdges's doc comment above).
 *
 * Source: only `module`/`class` nodes may HOLD a dependency. A module
 * or class is the thing that actually has an import section in the
 * generated file; a `function` (or any other leaf) doesn't get its
 * own -- it inherits whatever its containing module/class imports.
 * See effectiveDependencies below for how a leaf's inherited set is
 * resolved (computed on the fly, never stored on the leaf itself).
 *
 * Target: only `module`, `data-model` (any model_kind: dto, db_schema,
 * enum, constant), and `contract` nodes are importable units.
 * `function`, `class`, `entrypoint`, `browser-js` are not valid
 * dependency targets -- you don't "import" a function, you call it
 * (see `calls`); a class you `implements`, not depend on.
 */
const DEPENDENCY_SOURCE_PROTOCOLS = ["module", "class"];
const DEPENDENCY_TARGET_PROTOCOLS = ["module", "data-model", "contract"];

function protocolOf(node) {
  return node && node.interface && node.interface.protocol;
}

/**
 * The subset of `nodesById` eligible as a dependency TARGET -- powers
 * the "add a dependency" <select> so it never offers an invalid
 * target to begin with. Returned as a sorted array of ids.
 */
function dependencyTargetIds(nodesById) {
  return Object.values(nodesById)
    .filter((n) => DEPENDENCY_TARGET_PROTOCOLS.includes(protocolOf(n)))
    .map((n) => n.id)
    .sort();
}

function addDependency(nodesById, fromId, toId) {
  const node = nodesById[fromId];
  if (!node) throw new Error(`Node '${fromId}' does not exist.`);
  const target = nodesById[toId];
  if (!target) throw new Error(`Cannot depend on '${toId}': it does not exist.`);
  if (fromId === toId) throw new Error(`A node cannot depend on itself.`);
  const fromProto = protocolOf(node);
  if (!DEPENDENCY_SOURCE_PROTOCOLS.includes(fromProto)) {
    throw new Error(
      `'${fromId}' is protocol '${fromProto}' -- only ${DEPENDENCY_SOURCE_PROTOCOLS.join("/")} nodes can hold a ` +
      `dependency. A function/leaf inherits its imports from its containing module or class instead.`
    );
  }
  const toProto = protocolOf(target);
  if (!DEPENDENCY_TARGET_PROTOCOLS.includes(toProto)) {
    throw new Error(
      `Cannot depend on '${toId}': it is protocol '${toProto}', not ${DEPENDENCY_TARGET_PROTOCOLS.join("/")} -- ` +
      `only modules and data-models (dto/db_schema/enum/constant) are importable units.`
    );
  }
  const existing = depIds(node);
  if (existing.includes(toId)) return nodesById; // no-op, already present
  node.dependencies = [...(node.dependencies || []), { node: toId }];
  return nodesById;
}

/**
 * A leaf's (or any non module/class node's) actual imports, resolved
 * on the fly -- never stored on the leaf itself, matching the
 * project's "derived values are computed, not cached" rule. Walks up
 * `parent` to the nearest module/class ancestor and returns THAT
 * node's own (authored) dependencies. Returns { ownerId, deps }:
 * `ownerId` is null (and `deps` []) if the node itself already is a
 * module/class (nothing to inherit -- use depIds(node) directly) or
 * if no module/class ancestor exists at all (e.g. an orphaned node).
 */
function effectiveDependencies(nodeId, nodesById) {
  const node = nodesById[nodeId];
  if (!node) return { ownerId: null, deps: [] };
  if (DEPENDENCY_SOURCE_PROTOCOLS.includes(protocolOf(node))) {
    return { ownerId: null, deps: depIds(node) }; // it owns its own list already
  }
  let cur = node;
  const seen = new Set(); // defensive: a cyclic `parent` chain should never happen, but never loop forever
  while (cur && cur.parent && !seen.has(cur.parent)) {
    seen.add(cur.parent);
    const parentNode = nodesById[cur.parent];
    if (!parentNode) break;
    if (DEPENDENCY_SOURCE_PROTOCOLS.includes(protocolOf(parentNode))) {
      return { ownerId: parentNode.id, deps: depIds(parentNode) };
    }
    cur = parentNode;
  }
  return { ownerId: null, deps: [] };
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
/**
 * Resolves a node's effective language: walk up from the node itself
 * through `parent` looking for the nearest ancestor `module` OR
 * `service` that declares `interface.language` (a `service` sits
 * above its modules in the tree, same inheritance shape as `module`'s
 * own -- either can be where a language is actually declared),
 * falling back to the graph's own `default_language` (mirrors
 * `default_boundary`'s existing fallback pattern), then `undefined` if
 * nothing anywhere declares one at all.
 *
 * Exception: `browser-js` is untouched by Revision 3 (frontend is a
 * separate future design effort) and still carries a fixed `language`
 * constant directly on its registry entry -- checked first, before
 * the walk, so it keeps working exactly as before.
 */
function resolveLanguage(nodeId, nodesById, registry, defaultLanguage) {
  const node = nodesById[nodeId];
  if (!node) return undefined;
  const rule = registry && registry[node.interface.protocol];
  if (rule && rule.language) return rule.language; // browser-js's fixed constant, or any other untouched custom protocol that still declares one this way

  let cur = node;
  while (cur) {
    const curProto = cur.interface && cur.interface.protocol;
    if ((curProto === "module" || curProto === "service") && cur.interface.language) {
      return cur.interface.language;
    }
    cur = cur.parent ? nodesById[cur.parent] : null;
  }
  return defaultLanguage || undefined;
}

/**
 * File extension per resolved language, used by buildPath below.
 * Deliberately small and explicit rather than a guess -- an
 * unrecognized/unset language yields no extension rather than a
 * wrong one.
 */
const LANGUAGE_EXTENSIONS = {
  python: ".py",
  javascript: ".js",
  typescript: ".ts",
};

/**
 * Every node gets its OWN path, unconditionally -- confirmed choice
 * over mirroring module_scaffold.py's real on-disk convention (which
 * collapses a whole non-folder-layout subtree into one shared file;
 * see python-toolchain-README.md Pass 5 for why those two conventions
 * genuinely differ and aren't interchangeable). This is
 * `{project}/<full ancestor chain by id, root to leaf, EXCLUDING the
 * backbone>/{node_id}{extension}` -- the full `parent` chain, not an
 * abbreviated one, since nothing else here has a rule for deciding
 * which ancestors to skip.
 *
 * Lives here (not in prompt-generator.js, where it was first written)
 * because it's a structural graph fact -- same category as
 * resolveLanguage/inferredLayout just above -- not something specific
 * to composing prompt text. prompt-generator.js calls this directly.
 *
 * DERIVED, COMPUTED FRESH EVERY CALL -- deliberately never cached on
 * the node itself (a `path` field lived here briefly and was removed
 * for exactly this reason: a stored derived value silently goes stale
 * the moment anything it depends on changes elsewhere -- reparenting,
 * a project rename, a hand-edit to graph.yaml outside this app --
 * with nothing in the file distinguishing "correct" from "stale").
 * Standing rule for this project going forward: derived values are
 * always computed on the fly, never stored.
 */
function buildPath(nodeId, normalized, registry) {
  const { nodesById, project, backbone } = normalized;
  const node = nodesById[nodeId];
  if (!node) return nodeId; // dangling reference -- caller's validation should have already caught this; fail soft rather than throw

  // A `function` never exists as its own file -- it's always code
  // inside whatever container (module) holds it, so its path IS its
  // parent's path, not a nested segment under it. This is what fixes
  // the collision a `layout: file` module used to produce (e.g. both
  // `auth.py` for the module AND `auth/login.py` for its function
  // child -- a real file and a real directory with the same name).
  // Scoping this to `function` specifically is sufficient for every
  // VALID graph, not just the common case: validate_graph.py/
  // validate-graph.js's layout check (3g) already REQUIRES every
  // direct child of a `layout: file` module to be a function, so a
  // function is the only node type that can ever sit directly inside
  // one -- no other protocol needs this same treatment.
  if (node.interface && node.interface.protocol === "function" && node.parent && node.parent !== backbone) {
    return buildPath(node.parent, normalized, registry);
  }

  const chain = [];
  let curId = node.parent;
  while (curId && curId !== backbone) {
    const cur = nodesById[curId];
    // `gateway` is purely organizational (which transport a service
    // sits behind) -- it never becomes a real directory. `service`
    // DOES become one (the top-level folder for that independently
    // deployable unit) -- only gateway is skipped here, nothing else.
    if (!(cur && cur.interface && cur.interface.protocol === "gateway")) {
      chain.unshift(curId);
    }
    curId = cur ? cur.parent : null;
  }
  const language = resolveLanguage(nodeId, nodesById, registry, normalized.defaultLanguage);
  const ext = LANGUAGE_EXTENSIONS[language] || "";
  return [project || "project", ...chain, `${nodeId}${ext}`].join("/");
}

/**
 * Mirrors validate_graph.py's check 8: a dependency edge between two
 * nodes whose EFFECTIVE (resolved, not registry-constant) languages
 * differ must have boundary='service' -- 'module' (same-process direct
 * call) is physically impossible across languages. Returns a warning
 * string, or null if the edge is fine. Called from the editor's UI at
 * the point a dependency is added, so the mistake is caught at
 * authoring time, not only later by validate_graph.py.
 */
function checkCrossLanguageBoundary(nodesById, registry, fromId, toId, defaultBoundary, defaultLanguage) {
  const from = nodesById[fromId];
  const to = nodesById[toId];
  if (!from || !to) return null;
  const fromRule = registry && registry[from.interface.protocol];
  const toRule = registry && registry[to.interface.protocol];
  if (!fromRule || !toRule) return null; // unknown protocol -- nothing to check
  const fromLang = resolveLanguage(fromId, nodesById, registry, defaultLanguage);
  const toLang = resolveLanguage(toId, nodesById, registry, defaultLanguage);
  if (!fromLang || !toLang) return null; // neither side makes a language claim (nothing in the tree ever declared one) -- can't compare against unknown
  if (fromLang === toLang) return null;
  const effectiveBoundary = from.boundary || defaultBoundary;
  if (effectiveBoundary !== BOUNDARY_SERVICE) {
    return (
      `'${fromId}' (${fromLang}) would depend on '${toId}' (${toLang}) -- ` +
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

/**
 * Only `data-model` nodes may hold a `maps_to` -- it's a shape-to-shape
 * type mapping (e.g. a DB row -> a DTO), so only a shape-bearing node
 * has anything to map. Target is deliberately left unrestricted
 * (a DTO can map to another DTO, a DB schema, an enum, etc.).
 */
const MAPS_TO_SOURCE_PROTOCOLS = ["data-model"];

function addMapsTo(nodesById, fromId, toId) {
  const node = nodesById[fromId];
  if (!node) throw new Error(`Node '${fromId}' does not exist.`);
  if (!nodesById[toId]) throw new Error(`Cannot map to '${toId}': it does not exist.`);
  if (fromId === toId) throw new Error(`A node cannot map to itself.`);
  const fromProto = protocolOf(node);
  if (!MAPS_TO_SOURCE_PROTOCOLS.includes(fromProto)) {
    throw new Error(
      `'${fromId}' is protocol '${fromProto}' -- only ${MAPS_TO_SOURCE_PROTOCOLS.join("/")} nodes can hold a ` +
      `maps_to (it's a shape-to-shape mapping; only a shape-bearing node has a shape to map).`
    );
  }
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

/**
 * Only `class` nodes may hold an `implements` -- a class fulfills a
 * contract's method signatures; nothing else does. Target stays
 * restricted to `contract` (checked below already).
 */
const IMPLEMENTS_SOURCE_PROTOCOLS = ["class"];

function addImplements(nodesById, fromId, toId) {
  const node = nodesById[fromId];
  if (!node) throw new Error(`Node '${fromId}' does not exist.`);
  const target = nodesById[toId];
  if (!target) throw new Error(`Cannot implement '${toId}': it does not exist.`);
  if (fromId === toId) throw new Error(`A node cannot implement itself.`);
  const fromProto = protocolOf(node);
  if (!IMPLEMENTS_SOURCE_PROTOCOLS.includes(fromProto)) {
    throw new Error(
      `'${fromId}' is protocol '${fromProto}' -- only ${IMPLEMENTS_SOURCE_PROTOCOLS.join("/")} nodes can implement a contract.`
    );
  }
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

/* -----------------------------------------------------------------------
 * calls — a call-graph edge: "this node calls this specific operation on
 * that node." Deliberately a SEPARATE relationship from `dependencies`,
 * for the same reason `maps_to` and `implements` are separate (see their
 * comments above): `dependencies` means "needs this to function" at
 * node granularity; `calls` sharpens ONE such relationship down to a
 * named operation, which is extra precision worth keeping distinct
 * rather than overloading `dependencies`' entries with an optional
 * operation name. A `calls` entry does not imply or require a matching
 * `dependencies` entry (the editor doesn't enforce that pairing) -- it's
 * additive detail, on the same "third instance of the same pattern" as
 * maps_to/implements.
 * ------------------------------------------------------------------- */

function callIds(node) {
  return (node.calls || []).map((d) => (typeof d === "string" ? d : d.node));
}

function addCall(nodesById, fromId, toId, operationName) {
  const node = nodesById[fromId];
  if (!node) throw new Error(`Node '${fromId}' does not exist.`);
  if (!nodesById[toId]) throw new Error(`Cannot call '${toId}': it does not exist.`);
  if (fromId === toId) throw new Error(`A node cannot call itself.`);
  if (!operationName || !operationName.trim()) throw new Error(`A calls entry needs an operation name.`);
  const existing = (node.calls || []).find((d) => (typeof d === "string" ? d : d.node) === toId && d.operation_name === operationName.trim());
  if (existing) return nodesById; // no-op, already present
  node.calls = [...(node.calls || []), { node: toId, operation_name: operationName.trim() }];
  return nodesById;
}

function removeCall(nodesById, fromId, toId, operationName) {
  const node = nodesById[fromId];
  if (!node) throw new Error(`Node '${fromId}' does not exist.`);
  node.calls = (node.calls || []).filter((d) => {
    const id = typeof d === "string" ? d : d.node;
    return !(id === toId && (operationName === undefined || d.operation_name === operationName));
  });
  return nodesById;
}

function computeCallsEdges(normalized) {
  const { nodesById } = normalized;
  const edges = [];
  for (const n of Object.values(nodesById)) {
    for (const c of n.calls || []) {
      const target = typeof c === "string" ? c : c.node;
      edges.push({ source: n.id, target, dangling: !nodesById[target], operationName: c.operation_name });
    }
  }
  return edges;
}

/* -----------------------------------------------------------------------
 * data_flows — "this data shape moves from this node to that node, in
 * this direction." Deliberately separate from `dependencies`/`calls` for
 * the same reason as the others: a data flow is a fact about what moves,
 * not a call or a same-process/service relationship, so it shouldn't
 * feed checkCrossLanguageBoundary or blur dependencies'/calls' meaning.
 * ------------------------------------------------------------------- */

const DATA_FLOW_DIRECTIONS = ["read", "write"];

function dataFlowIds(node) {
  return (node.data_flows || []).map((d) => (typeof d === "string" ? d : d.node));
}

function addDataFlow(nodesById, fromId, toId, dataModel, direction) {
  const node = nodesById[fromId];
  if (!node) throw new Error(`Node '${fromId}' does not exist.`);
  if (!nodesById[toId]) throw new Error(`Cannot flow data to '${toId}': it does not exist.`);
  if (fromId === toId) throw new Error(`A node cannot data-flow to itself.`);
  if (!DATA_FLOW_DIRECTIONS.includes(direction)) {
    throw new Error(`direction must be one of ${DATA_FLOW_DIRECTIONS.join(", ")}`);
  }
  const existing = (node.data_flows || []).find((d) =>
    (typeof d === "string" ? d : d.node) === toId && d.data_model === dataModel && d.direction === direction
  );
  if (existing) return nodesById; // no-op, already present
  node.data_flows = [...(node.data_flows || []), { node: toId, data_model: dataModel || null, direction }];
  return nodesById;
}

function removeDataFlow(nodesById, fromId, toId, direction) {
  const node = nodesById[fromId];
  if (!node) throw new Error(`Node '${fromId}' does not exist.`);
  node.data_flows = (node.data_flows || []).filter((d) => {
    const id = typeof d === "string" ? d : d.node;
    return !(id === toId && (direction === undefined || d.direction === direction));
  });
  return nodesById;
}

function computeDataFlowsEdges(normalized) {
  const { nodesById } = normalized;
  const edges = [];
  for (const n of Object.values(nodesById)) {
    for (const d of n.data_flows || []) {
      const target = typeof d === "string" ? d : d.node;
      edges.push({ source: n.id, target, dangling: !nodesById[target], dataModel: d.data_model, direction: d.direction });
    }
  }
  return edges;
}

function graphToYamlObject(normalized, registry) {
  const payload = {
    project: normalized.project,
    backbone: normalized.backbone,
    default_boundary: normalized.defaultBoundary,
    default_language: normalized.defaultLanguage,
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
  LAYOUT_FILE, LAYOUT_FOLDER, LAYOUT_ENUM, inferredLayout,
  MODEL_KIND_DTO, MODEL_KIND_DB_SCHEMA, MODEL_KIND_ENUM_TYPE, MODEL_KIND_CONSTANT, MODEL_KIND_VALUES,
  CANONICAL_PRIMITIVE_TYPES, TYPE_WRAPPER_KINDS, checkTypeDescriptorShape, resolveLanguage,
  looksLikeJsonSchema, convertJsonSchemaToModelFields,
  LANGUAGE_EXTENSIONS, buildPath,
  applyStatusConfig, applyProtocolRegistryConfig,
  // write side
  PROTOCOL_REGISTRY, BUILTIN_PROTOCOL_IDS, PROMPT_TEMPLATE_PROTOCOLS, depIds, mapsToIds, implementsIds,
  DEPENDENCY_SOURCE_PROTOCOLS, DEPENDENCY_TARGET_PROTOCOLS, dependencyTargetIds, effectiveDependencies,
  MAPS_TO_SOURCE_PROTOCOLS, IMPLEMENTS_SOURCE_PROTOCOLS,
  registerCustomProtocol, restoreCustomProtocols, emptyNodeFor, validateAddChild,
  addNode, deleteNode, addDependency, removeDependency, addMapsTo, removeMapsTo,
  addImplements, removeImplements,
  callIds, addCall, removeCall, computeCallsEdges,
  DATA_FLOW_DIRECTIONS, dataFlowIds, addDataFlow, removeDataFlow, computeDataFlowsEdges,
  graphToYamlObject, checkCrossLanguageBoundary,
};

if (typeof module !== "undefined" && module.exports) {
  module.exports = GraphModel;
}
if (typeof window !== "undefined") {
  window.GraphModel = GraphModel;
}
