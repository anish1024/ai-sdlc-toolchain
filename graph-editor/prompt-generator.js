/**
 * prompt-generator.js — turns a loaded graph.yaml directly into
 * prompts/prompt.json, so a small LLM can act on the graph without
 * any of the Python tool scripts running first.
 *
 * Composition model (per the accepted design): a node's final prompt
 * is assembled from `interface` (params/returns/errors/preconditions/
 * postconditions/methods/model_fields/... depending on protocol) +
 * `notes` (whatever the structured interface doesn't cover) +
 * `calls`/`data_flows` (relationship detail sharper than plain
 * `dependencies`) + `dependencies` + a guardrail block derived from
 * `status` and `contract_version` (see buildGuardrail below). These
 * stay separate FIELDS on the node (graph-model.js) -- this file is
 * the one place that composes them into text, so there is exactly one
 * definition of "what a prompt looks like," not one hardcoded here
 * and a second guess baked into graph-model.js's schema.
 *
 * `node.prompt_template`, when non-empty, overrides the built-in
 * default template for that node's protocol. A template is a plain
 * string with `{placeholder}` tokens (see PLACEHOLDER_BUILDERS below
 * for the full set) -- substitution is a single pass, no nested/
 * conditional template logic, deliberately: the structured fields
 * already carry the real information; the template just decides
 * ordering/wording around them.
 *
 * Pure, DOM-free, Node-testable like graph-model.js:
 *   node -e "const p = require('./prompt-generator.js'); ..."
 */

/* =======================================================================
 * Guardrail: version + status -> action + scope restriction
 * ===================================================================== */

/**
 * status -> action mapping. 'stub' means the file/function doesn't
 * exist yet for this node -- CREATE. 'implementing' means a previous
 * pass already created it and this is a follow-up (a fix, an
 * enhancement, a resync after the graph changed) -- UPDATE, scoped
 * strictly to this node's own file/function. Everything else (unsplit,
 * contract_defined, implemented, tested, integrated) is not a
 * generation target today -- see isPromptable below, which is what
 * actually gates inclusion in prompt.json; this function only decides
 * the wording for nodes that ARE included.
 */
function actionForStatus(status) {
  if (status === "stub") return "CREATE";
  if (status === "implementing") return "UPDATE";
  return null;
}

/**
 * Only nodes a small model should be handed a prompt for: leaf-capable
 * (per the registry -- function/browser-js/data-model today) AND at a
 * status this project's generation flow actually targets (stub or
 * implementing -- mirrors the old Python tool's READY_STATUSES, note
 * this file skips 'contract_defined' deliberately: that status means
 * "the contract exists but hasn't been queued for implementation yet,"
 * not "ready to hand to a model right now").
 */
function isLeafCapable(node, registry) {
  const proto = node.interface && node.interface.protocol;
  const rule = registry[proto];
  return !!(rule && rule.leafCapable);
}

/**
 * Container nodes eligible for a SKELETON prompt (imports, class/module
 * wiring, empty function stubs -- NOT function bodies, which stay a
 * separate per-function pass). Deliberately NOT expressed via the
 * registry's `leafCapable` flag -- that flag means something else
 * already (module/class/contract are correctly `leafCapable: false`
 * because they have children, and other code, e.g.
 * registerCustomProtocol's default heuristic, relies on that meaning).
 * This is a second, independent classification.
 *
 *   contract -- always: generate the ABC/Protocol shell from `methods`.
 *   class    -- always: generate the class shell + stub methods for
 *               every `function` child (bodies deferred).
 *   module   -- ONLY if its effective layout is "file" (a single
 *               shared file). A `layout: folder` module has no shared
 *               file to skeleton -- every function child already gets
 *               its own complete file via its own implementation
 *               prompt, imports included. Skeleton generation for a
 *               folder-layout module would have nothing real to do.
 */
function isSkeletonEligible(node, normalized, registry) {
  const proto = node.interface && node.interface.protocol;
  if (proto === "contract") return true;
  if (proto === "class") return true;
  if (proto === "module") {
    return GraphModel.inferredLayout(node.id, normalized) === GraphModel.LAYOUT_FILE;
  }
  return false;
}

/**
 * "implementation" (a real function/data-model/browser-js body),
 * "skeleton" (container wiring only), or null (not a generation
 * target at all, e.g. `entrypoint`).
 */
function nodeKind(node, normalized, registry) {
  if (isLeafCapable(node, registry)) return "implementation";
  if (isSkeletonEligible(node, normalized, registry)) return "skeleton";
  return null;
}

function isPromptable(node, normalized, registry) {
  if (!nodeKind(node, normalized, registry)) return false;
  return node.status === "stub" || node.status === "implementing";
}

function buildGuardrail(node, nodeId) {
  const action = actionForStatus(node.status);
  const version = node.contract_version || "0.0.0";
  if (action === "CREATE") {
    return (
      `ACTION: CREATE (status=stub, version=${version}). This file/function does not exist yet. ` +
      `Create it. Do not modify any file or function belonging to any node other than '${nodeId}'.`
    );
  }
  if (action === "UPDATE") {
    return (
      `ACTION: UPDATE (status=implementing, version=${version}). An implementation for '${nodeId}' ` +
      `already exists. This is a targeted change -- touch only '${nodeId}''s own file/function. ` +
      `Do not modify unrelated files, functions, or other nodes' contracts.`
    );
  }
  return `ACTION: none -- status='${node.status}' is not a generation target.`;
}

/* =======================================================================
 * Per-protocol interface rendering (plain text, not markup -- this
 * feeds an LLM prompt, not the DOM)
 * ===================================================================== */

/**
 * Display labels for `model_kind`'s raw enum values, used in the
 * `{interface}` block instead of the raw string -- e.g. `dto` ->
 * "Data Transfer Object(DTO)". Purely cosmetic -- graph-model.js's
 * MODEL_KIND_VALUES remains the actual enum this is keyed off of;
 * this table doesn't add or validate values, just how they print.
 */
const MODEL_KIND_LABELS = {
  dto: "Data Transfer Object(DTO)",
  db_schema: "Database Schema",
  enum: "Enum",
  constant: "Constant group",
};

function renderInterfaceBlock(node, nodeId) {
  const proto = node.interface && node.interface.protocol;
  const lines = [];
  if (proto === "function") {
    lines.push(`Signature: ${GraphView.formatSignature({ ...node, id: nodeId })}`);
    if (node.interface.http_method && node.interface.route) {
      lines.push(`HTTP: ${node.interface.http_method.toUpperCase()} ${node.interface.route}`);
    }
    for (const p of node.interface.preconditions || []) lines.push(`Precondition: ${p}`);
    for (const p of node.interface.postconditions || []) lines.push(`Postcondition: ${p}`);
    for (const e of node.interface.errors || []) lines.push(`Error ${e.code}: ${e.description}`);
  } else if (proto === "data-model") {
    const label = MODEL_KIND_LABELS[node.interface.model_kind] || node.interface.model_kind;
    lines.push(`model_kind: ${label}`);
    for (const f of node.interface.model_fields || []) {
      lines.push(`Field ${f.name}: ${GraphView.formatTypeDescriptor(f.type)}${f.required === false ? " (optional)" : ""}${f.notes ? " -- " + f.notes : ""}`);
    }
    for (const v of node.interface.enum_values || []) lines.push(`Enum member ${v.name} = ${v.value}${v.notes ? " -- " + v.notes : ""}`);
    for (const c of node.interface.constants || []) lines.push(`Constant ${c.name}: ${c.type} = ${c.value}${c.notes ? " -- " + c.notes : ""}`);
  } else if (proto === "browser-js") {
    for (const exp of node.interface.exports || []) lines.push(`Export ${exp.kind} ${exp.name}: ${exp.signature}`);
  } else if (proto === "contract") {
    for (const m of node.interface.methods || []) {
      const params = (m.params || []).map((p) => `${p.name}: ${GraphView.formatTypeDescriptor(p.type)}`).join(", ");
      lines.push(`Method ${m.name}(${params}) -> ${GraphView.formatTypeDescriptor(m.returns)}`);
    }
  } else if (proto === "class") {
    for (const f of node.interface.fields || []) {
      lines.push(`Instance field self.${f.name}: ${GraphView.formatTypeDescriptor(f.type)}`);
    }
    const implTargets = GraphModel.implementsIds(node);
    if (implTargets.length) lines.push(`Implements contract(s): ${implTargets.join(", ")}`);
  }
  return lines.join("\n");
}

/**
 * The function-child stubs a skeleton pass needs to declare (signature
 * only, body deferred to that function's own separate implementation
 * prompt). Used for both `class` and `layout: file` `module` skeletons.
 */
function renderChildFunctionSignatures(nodeId, nodesById) {
  const kids = GraphModel.childrenOf(nodeId, nodesById).filter((c) => c.interface && c.interface.protocol === "function");
  return kids.map((c) => `Function stub: ${GraphView.formatSignature({ ...c, id: c.id })}`).join("\n");
}

/* =======================================================================
 * Template substitution
 * ===================================================================== */

/**
 * One-line, terser sibling to buildGuardrail's fuller sentence --
 * just the "touch only this file" restriction, no version/status
 * preamble. Use {guardrail} for the fuller version, {scope_note} for
 * this one; a template picks whichever fits its tone, not both.
 */
function buildScopeNote(node, nodeId) {
  const action = actionForStatus(node.status);
  if (!action) return "";
  return "This is one file update and all reads and writes must occur on this file ONLY.";
}

function placeholderValues(node, nodeId, normalized, registry) {
  const nodesById = normalized.nodesById;

  const depsText = (() => {
    const d = GraphModel.depIds(node);
    if (!d.length) return "";
    // Full relative paths, not bare node ids -- lets a reader (or a
    // downstream tool) go straight from "depends on" to the actual
    // file, without a separate lookup step. Scoped to `dependencies`
    // only, per the explicit ask -- `calls`/`data_flows` below still
    // reference node ids, not paths.
    const paths = d.map((depId) => GraphModel.buildPath(depId, normalized, registry));
    return `Depends on: ${paths.join(", ")}`;
  })();
  const callsText = (() => {
    const c = (node.calls || []).map((x) => `${typeof x === "string" ? x : x.node}.${x.operation_name || "?"}()`);
    return c.length ? `Calls:\n${c.join("\n")}` : "";
  })();
  const dataFlowsText = (() => {
    const d = (node.data_flows || []).map((x) => `(${x.direction}) ${x.data_model || "?"} <-> ${typeof x === "string" ? x : x.node}`);
    return d.length ? `Data flows:\n${d.join("\n")}` : "";
  })();
  const mapsToText = (() => {
    const m = GraphModel.mapsToIds(node);
    if (!m.length) return "";
    // Full relative paths, same treatment as `dependencies` (not
    // `calls`/`data_flows`, which stay as node ids) -- a type mapping
    // benefits from knowing exactly where the target type lives at
    // least as much as a dependency does, arguably more so for
    // writing the actual import.
    const paths = m.map((id) => GraphModel.buildPath(id, normalized, registry));
    return `Maps to: ${paths.join(", ")}`;
  })();

  return {
    id: nodeId,
    title: node.title || "",
    status: node.status || "",
    version: node.contract_version || "0.0.0",
    protocol: (node.interface && node.interface.protocol) || "",
    language: GraphModel.resolveLanguage(nodeId, nodesById, registry, normalized.defaultLanguage) || "",
    action: actionForStatus(node.status) || "",
    path: GraphModel.buildPath(nodeId, normalized, registry),
    guardrail: buildGuardrail(node, nodeId),
    scope_note: buildScopeNote(node, nodeId),
    signature: node.interface && node.interface.protocol === "function" ? GraphView.formatSignature({ ...node, id: nodeId }) : "",
    interface: (() => { const t = renderInterfaceBlock(node, nodeId); return t.trim() ? `## Interface\n${t}` : ""; })(),
    children: (() => { const t = renderChildFunctionSignatures(nodeId, nodesById); return t.trim() ? `## Function stubs to declare (bodies deferred)\n${t}` : ""; })(),
    preconditions: (node.interface.preconditions || []).join("\n"),
    postconditions: (node.interface.postconditions || []).join("\n"),
    errors: (node.interface.errors || []).map((e) => `${e.code}: ${e.description}`).join("\n"),
    // Same self-contained-label pattern throughout this object: each
    // value already includes its own heading/label when non-empty,
    // and is "" (no heading at all) when the node has nothing there --
    // so a template just placing the token on its own line never
    // prints an orphaned "## X" with nothing under it.
    dependencies: depsText,
    calls: callsText,
    data_flows: dataFlowsText,
    maps_to: mapsToText,
    // relationships_header: the OUTER "## Relationships" heading is a
    // separate placeholder from the four lines above it on purpose
    // (keeps them independently cherry-pickable in a custom template,
    // per the earlier decision to drop the old combined {relationships}
    // token) -- but it still needs to disappear when all four are
    // empty, or the section prints a heading over nothing.
    relationships_header: (depsText || callsText || dataFlowsText || mapsToText) ? "## Relationships" : "",
    notes: node.notes && node.notes.trim() ? `## Notes\n${node.notes}` : "",
    stub_behavior: node.stub_behavior && node.stub_behavior.trim() ? `## Stub behavior\n${node.stub_behavior}` : "",
  };
}

const DEFAULT_TEMPLATE =
`# {id} ({protocol}, status={status}, version={version})
Path: {path}
{guardrail}

{interface}

{relationships_header}
{dependencies}

{calls}

{data_flows}

{maps_to}

{notes}

{stub_behavior}`;

const DEFAULT_SKELETON_TEMPLATE =
`# {id} ({protocol}, status={status}, version={version}) -- SKELETON ONLY
Path: {path}
{guardrail}

This is a skeleton-generation pass: produce imports, class/module
wiring, and empty function stubs (raise NotImplementedError / pass,
language-appropriate) for the items below. Do NOT implement function
bodies -- that happens in a separate, per-function pass using each
function node's own prompt.

{interface}

{children}

{relationships_header}
{dependencies}

{calls}

{data_flows}

{maps_to}

{notes}

{stub_behavior}`;

function applyTemplate(template, values) {
  return template.replace(/\{(\w+)\}/g, (m, key) => (key in values ? values[key] : m));
}

/**
 * Composes the final prompt text for one node. Uses node.prompt_template
 * if set (non-empty), otherwise the built-in default for `kind`
 * ("implementation" or "skeleton" -- see nodeKind above; defaults to
 * "implementation" if omitted, so existing call sites that don't pass
 * a kind keep working unchanged).
 */
function buildPromptForNode(node, nodeId, normalized, kind, registry) {
  const values = placeholderValues(node, nodeId, normalized, registry);
  const builtIn = kind === "skeleton" ? DEFAULT_SKELETON_TEMPLATE : DEFAULT_TEMPLATE;
  const template = (node.prompt_template && node.prompt_template.trim()) || builtIn;
  return applyTemplate(template, values);
}

/**
 * Every node with a determinable file (see nodeKind) and its full
 * relative path -- regardless of CURRENT status. Unlike `prompts`
 * below (gated to stub/implementing, i.e. "ready to act on now"),
 * this is the INTENDED final layout: the whole target structure to
 * build toward, which is the point of making prompt.json usable to
 * start a project from scratch rather than only describing today's
 * next steps. DERIVED fresh on every call, per this project's
 * standing rule -- nothing here is ever cached on a node.
 */
function buildDirectoryStructure(normalized, registry) {
  return Object.values(normalized.nodesById)
    .filter((n) => nodeKind(n, normalized, registry))
    .map((n) => ({ node_id: n.id, path: GraphModel.buildPath(n.id, normalized, registry), kind: nodeKind(n, normalized, registry) }))
    .sort((a, b) => a.path.localeCompare(b.path));
}

/**
 * Renders `buildDirectoryStructure`'s flat list as an ASCII tree
 * (like the `tree` command) -- for a human or an LLM to read the
 * shape of the project at a glance, rather than parsing a flat path
 * list. Purely a display transform of the same data; `structure`
 * stays available too for anything that wants to iterate
 * programmatically instead.
 */
function renderDirectoryTree(structure) {
  const root = {};
  const seenPaths = new Set(); // multiple structure entries can share one path now (e.g. a function whose path IS its parent's -- see buildPath) -- the tree shows each real file once, `structure` itself still lists every entry
  for (const entry of structure) {
    if (seenPaths.has(entry.path)) continue;
    seenPaths.add(entry.path);
    const parts = entry.path.split("/");
    let cur = root;
    parts.forEach((part, i) => {
      if (i === parts.length - 1) {
        cur[part] = null; // leaf (file)
      } else {
        if (!cur[part] || typeof cur[part] !== "object") cur[part] = {};
        cur = cur[part];
      }
    });
  }
  const lines = [];
  function walk(node, prefix) {
    const keys = Object.keys(node).sort();
    keys.forEach((key, idx) => {
      const isLast = idx === keys.length - 1;
      lines.push(`${prefix}${isLast ? "└── " : "├── "}${key}`);
      if (node[key] && typeof node[key] === "object") {
        walk(node[key], prefix + (isLast ? "    " : "│   "));
      }
    });
  }
  walk(root, "");
  return lines.join("\n");
}

/**
 * Generates the full prompt.json payload. Shape:
 *   { project, structure, tree, prompts }
 * `structure`/`tree` cover EVERY generatable node regardless of
 * status (the full intended layout -- see buildDirectoryStructure).
 * `prompts` is the existing one-entry-per-promptable-node array (see
 * isPromptable), in dependency-shallow-first order for readability.
 * If a node's `prompt` field is already non-empty (a previously
 * generated-and-reviewed prompt), that saved text is used VERBATIM
 * instead of recomputing -- the node still appears in the manifest,
 * it just isn't regenerated out from under a reviewed edit.
 */
function generatePromptManifest(normalized, registry) {
  const { nodesById } = normalized;
  const depth = {};
  function depthOf(id) {
    if (depth[id] !== undefined) return depth[id];
    const n = nodesById[id];
    depth[id] = n && n.parent ? depthOf(n.parent) + 1 : 0;
    return depth[id];
  }
  const targets = Object.values(nodesById).filter((n) => isPromptable(n, normalized, registry));
  targets.sort((a, b) => depthOf(a.id) - depthOf(b.id) || a.id.localeCompare(b.id));

  const structure = buildDirectoryStructure(normalized, registry);

  return {
    project: normalized.project || "",
    structure,
    tree: renderDirectoryTree(structure),
    prompts: targets.map((n) => {
      const kind = nodeKind(n, normalized, registry);
      return {
        node_id: n.id,
        kind,
        status: n.status,
        version: n.contract_version || "0.0.0",
        action: actionForStatus(n.status),
        prompt: (n.prompt && n.prompt.trim()) ? n.prompt : buildPromptForNode(n, n.id, normalized, kind, registry),
      };
    }),
  };
}

const GraphPromptGen = {
  actionForStatus, isLeafCapable, isSkeletonEligible, nodeKind, isPromptable, buildGuardrail, buildScopeNote,
  renderInterfaceBlock, renderChildFunctionSignatures, MODEL_KIND_LABELS,
  buildDirectoryStructure, renderDirectoryTree,
  placeholderValues, applyTemplate, DEFAULT_TEMPLATE, DEFAULT_SKELETON_TEMPLATE,
  buildPromptForNode, generatePromptManifest,
};

if (typeof module !== "undefined" && module.exports) {
  module.exports = GraphPromptGen;
}
if (typeof window !== "undefined") {
  window.GraphPromptGen = GraphPromptGen;
}
