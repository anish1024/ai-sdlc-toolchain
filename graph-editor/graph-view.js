/**
 * graph-view.js — VIEW layer.
 *
 * Responsible for turning app state into pixels: the D3 tree diagram,
 * the detail panel's read-only and edit-form markup, the tooltip, the
 * add-child popup, and the custom-protocol modal.
 *
 * Hard rule this file follows: it never touches GraphModel and never
 * mutates app state (registry / normalized / selectedNodeId / ...).
 * Every interaction the user can make (clicking a node, clicking
 * "add child", toggling a collapse arrow, editing a form field) is
 * reported upward through a `handlers` object of callbacks supplied
 * by the Controller. This is what keeps the View swappable/testable
 * independent of the app's business rules: you could point this same
 * render() function at a different data source and it would draw
 * whatever tree it's handed, without knowing what a "protocol" or a
 * "settlement round" is.
 *
 * The one exception is pure-presentation helpers with no state of
 * their own (escapeHtml, the tooltip show/move/hide trio) — those
 * stay here because they're rendering concerns, not app logic.
 */

function escapeHtml(s) {
  return String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

/**
 * Revision 3: renders a structured TYPE_DESCRIPTOR into a short,
 * readable string for DISPLAY ONLY -- e.g. {type:"list",items:{type:"uuid"}}
 * -> "list<uuid>". Never used to reconstruct data (the descriptor
 * itself, fully nested, is what's actually saved/read) -- purely a
 * presentation convenience so the tooltip/read panel don't have to
 * dump raw JSON to show something as simple as a param type.
 */
function formatTypeDescriptor(desc) {
  if (!desc || typeof desc !== "object" || !desc.type) return "?";
  const t = desc.type;
  if (t === "list") return `list<${formatTypeDescriptor(desc.items)}>`;
  if (t === "map") return `map<${formatTypeDescriptor(desc.key)}, ${formatTypeDescriptor(desc.value)}>`;
  if (t === "optional") return `optional<${formatTypeDescriptor(desc.of)}>`;
  return t; // a canonical primitive keyword, or a node-id reference -- both render as-is
}

/**
 * Renders a function-like node's params/returns as a familiar
 * "name(param: type, ...) -> returnType" string, purely for display
 * (tooltip, read panel, tree sub-label) -- mirrors what the old
 * free-text `signature` field used to show, now built from the
 * structured data instead of read verbatim from a string.
 */
function formatSignature(node) {
  const params = (node.interface.params || []).map((p) => `${p.name}: ${formatTypeDescriptor(p.type)}`).join(", ");
  const ret = node.interface.returns ? formatTypeDescriptor(node.interface.returns) : "none";
  return `${node.id || ""}(${params}) -> ${ret}`;
}

/* =======================================================================
 * Tooltip (pure DOM, no app state)
 * ===================================================================== */

function showTooltip(event, d) {
  const n = d.data.node;
  const tip = document.getElementById("tooltip");
  let html = `<div><strong>${escapeHtml(d.data.id)}</strong></div>`;
  if (n.interface && n.interface.protocol === "function" && n.interface.params) {
    html += `<div class="sig">${escapeHtml(formatSignature({ ...n, id: d.data.id }))}</div>`;
  } else {
    html += `<div class="meta">${escapeHtml((n.interface && n.interface.protocol) || "?")} — no single signature</div>`;
  }
  html += `<div class="meta">status: ${escapeHtml(n.status)}${n.boundary ? " · boundary: " + escapeHtml(n.boundary) : ""}</div>`;
  tip.innerHTML = html;
  tip.style.display = "block";
  moveTooltip(event);
}
function moveTooltip(event) {
  const tip = document.getElementById("tooltip");
  tip.style.left = (event.clientX + 16) + "px";
  tip.style.top = (event.clientY + 16) + "px";
}
function hideTooltip() {
  document.getElementById("tooltip").style.display = "none";
}

/**
 * Transient toast notification -- feedback for every button-driven
 * action (per the explicit ask), not just the failures already
 * surfaced via `#f-error`/`alert()`. `type` is "success" | "error" |
 * "info", each with its own accent color (see #toast-container's
 * CSS). Auto-dismisses after `duration`ms; multiple toasts stack via
 * plain flexbox in #toast-container, oldest on top. Never throws --
 * a missing container (e.g. a page that hasn't loaded the updated
 * HTML) degrades to a console.warn rather than breaking the action
 * that triggered it.
 */
let toastCounter = 0;
function showToast(message, type = "info", duration = 3500) {
  const container = document.getElementById("toast-container");
  if (!container) { console.warn("toast-container missing -- toast dropped:", message); return; }
  const el = document.createElement("div");
  el.className = `toast ${type}`;
  el.textContent = message;
  container.appendChild(el);
  requestAnimationFrame(() => el.classList.add("show"));
  setTimeout(() => {
    el.classList.remove("show");
    setTimeout(() => el.remove(), 250);
  }, duration);
}

/* =======================================================================
 * Detail panel — read-only view
 * ===================================================================== */

function renderViewPanel(node, nodeId) {
  const color = GraphModel.STATUS_COLORS[node.status] || "#666";
  let html = `<h2>${escapeHtml(node.title || nodeId)}</h2>`;
  html += `<div class="node-id">${escapeHtml(nodeId)}</div>`;
  html += `<span class="badge" style="background:${color}">${escapeHtml(node.status)}</span>`;
  if (node.boundary) html += `<span class="badge" style="background:#374151;color:#e5e7eb">${escapeHtml(node.boundary)}</span>`;
  html += `<span class="badge" style="background:#4b5563;color:#e5e7eb">${escapeHtml(node.interface.protocol || "?")}</span>`;
  if (node.interface.model_kind) html += `<span class="badge" style="background:#1e3a8a;color:#e5e7eb">${escapeHtml(node.interface.model_kind)}</span>`;

  if (node.interface) {
    html += `<section><h3>Interface</h3>`;
    if (node.interface.protocol === "function" && node.interface.params) {
      html += `<div class="sig-box">${escapeHtml(formatSignature({ ...node, id: nodeId }))}</div>`;
    }
    if (node.interface.http_method && node.interface.route) html += `<div class="sig-box" style="margin-top:4px">${escapeHtml(node.interface.http_method.toUpperCase())} ${escapeHtml(node.interface.route)}</div>`;
    if (node.interface.preconditions && node.interface.preconditions.length) {
      html += `<div class="readonly-note" style="margin-top:6px">Preconditions:</div>`;
      for (const p of node.interface.preconditions) html += `<div class="type-def">${escapeHtml(p)}</div>`;
    }
    if (node.interface.postconditions && node.interface.postconditions.length) {
      html += `<div class="readonly-note" style="margin-top:6px">Postconditions:</div>`;
      for (const p of node.interface.postconditions) html += `<div class="type-def">${escapeHtml(p)}</div>`;
    }
    if (node.interface.errors && node.interface.errors.length) {
      html += `<div class="readonly-note" style="margin-top:6px">Errors:</div>`;
      for (const e of node.interface.errors) html += `<div class="type-def">${escapeHtml(e.code || "")} — ${escapeHtml(e.description || "")}</div>`;
    }
    if (node.interface.language) html += `<div class="readonly-note">language: ${escapeHtml(node.interface.language)}</div>`;
    if (Array.isArray(node.interface.model_fields)) {
      html += `<div style="margin-top:6px">`;
      for (const f of node.interface.model_fields) {
        html += `<div class="type-def">${escapeHtml(f.name)}: ${escapeHtml(formatTypeDescriptor(f.type))}${f.required === false ? " (optional)" : ""}${f.notes ? " — " + escapeHtml(f.notes) : ""}</div>`;
      }
      html += `</div>`;
    }
    if (Array.isArray(node.interface.fields)) {
      html += `<div style="margin-top:6px">`;
      for (const f of node.interface.fields) {
        html += `<div class="type-def">self.${escapeHtml(f.name)}: ${escapeHtml(formatTypeDescriptor(f.type))}</div>`;
      }
      html += `</div>`;
    }
    if (node.interface.enum_values) {
      html += `<div style="margin-top:6px">`;
      for (const v of node.interface.enum_values) {
        html += `<div class="type-def">${escapeHtml(v.name)} = ${escapeHtml(String(v.value))}${v.notes ? " — " + escapeHtml(v.notes) : ""}</div>`;
      }
      html += `</div>`;
    }
    if (node.interface.constants) {
      html += `<div style="margin-top:6px">`;
      for (const c of node.interface.constants) {
        html += `<div class="type-def">${escapeHtml(c.name)}: ${escapeHtml(c.type)} = ${escapeHtml(String(c.value))}${c.scope ? " (" + escapeHtml(c.scope) + ")" : ""}${c.notes ? " — " + escapeHtml(c.notes) : ""}</div>`;
      }
      html += `</div>`;
    }
    if (node.interface.methods) {
      html += `<div style="margin-top:6px">`;
      for (const m of node.interface.methods) {
        const params = (m.params || []).map((p) => `${p.name}: ${p.type}`).join(", ");
        html += `<div class="type-def">${escapeHtml(m.name)}(${escapeHtml(params)}) -&gt; ${escapeHtml(m.returns || "")}</div>`;
      }
      html += `</div>`;
    }
    if (node.interface.exports) {
      html += `<div style="margin-top:6px">`;
      for (const exp of node.interface.exports) html += `<div class="type-def">${escapeHtml(exp.kind)} ${escapeHtml(exp.name)}: ${escapeHtml(exp.signature)}</div>`;
      html += `</div>`;
    }
    html += `</section>`;
  }

  const deps = GraphModel.depIds(node);
  if (deps.length) {
    html += `<section><h3>Dependencies (${deps.length})</h3>`;
    for (const dep of deps) html += `<span class="dep-chip"><span class="dep-name" data-dep="${escapeHtml(dep)}">${escapeHtml(dep)}</span></span>`;
    html += `</section>`;
  }

  const mapsTo = GraphModel.mapsToIds(node);
  if (mapsTo.length) {
    html += `<section><h3>Maps to (${mapsTo.length})</h3>`;
    for (const target of mapsTo) html += `<span class="dep-chip maps-to-chip"><span class="dep-name" data-dep="${escapeHtml(target)}">${escapeHtml(target)}</span></span>`;
    html += `</section>`;
  }

  const impl = GraphModel.implementsIds(node);
  if (impl.length) {
    html += `<section><h3>Implements (${impl.length})</h3>`;
    for (const target of impl) html += `<span class="dep-chip implements-chip"><span class="dep-name" data-dep="${escapeHtml(target)}">${escapeHtml(target)}</span></span>`;
    html += `</section>`;
  }

  const calls = node.calls || [];
  if (calls.length) {
    html += `<section><h3>Calls (${calls.length})</h3>`;
    for (const c of calls) {
      const target = typeof c === "string" ? c : c.node;
      html += `<span class="dep-chip calls-chip"><span class="dep-name" data-dep="${escapeHtml(target)}">${escapeHtml(target)}${c.operation_name ? "." + escapeHtml(c.operation_name) + "()" : ""}</span></span>`;
    }
    html += `</section>`;
  }

  const dataFlows = node.data_flows || [];
  if (dataFlows.length) {
    html += `<section><h3>Data flows (${dataFlows.length})</h3>`;
    for (const d of dataFlows) {
      const target = typeof d === "string" ? d : d.node;
      html += `<span class="dep-chip data-flow-chip"><span class="dep-name" data-dep="${escapeHtml(target)}">${escapeHtml(d.direction || "")} ${escapeHtml(d.data_model || "")} → ${escapeHtml(target)}</span></span>`;
    }
    html += `</section>`;
  }

  if (node.stub_behavior) html += `<section><h3>Stub behavior</h3><div class="stub-box">${escapeHtml(node.stub_behavior)}</div></section>`;

  if (node.tests && node.tests.length) {
    html += `<section><h3>Tests (${node.tests.length})</h3>`;
    for (const t of node.tests) {
      html += `<div class="test-card"><span class="tid">${escapeHtml(t.id || "")}</span>`;
      if (t.description) html += `<div class="tdesc">${escapeHtml(t.description)}</div>`;
      if (t.given) html += `<pre>given: ${escapeHtml(JSON.stringify(t.given))}</pre>`;
      if (t.expect) html += `<pre>expect: ${escapeHtml(JSON.stringify(t.expect))}</pre>`;
      if (t.expect_raises) html += `<pre>expect_raises: ${escapeHtml(t.expect_raises)}</pre>`;
      html += `</div>`;
    }
    html += `</section>`;
  }

  if (node.notes) html += `<section><h3>Notes</h3><div class="note-box">${escapeHtml(node.notes)}</div></section>`;
  if (node.prompt) html += `<section><h3>Generated prompt</h3><div class="note-box" style="white-space:pre-wrap">${escapeHtml(node.prompt)}</div></section>`;
  return html;
}

/* =======================================================================
 * Detail panel — edit form
 * ===================================================================== */

/**
 * `otherNodeIds` is the sorted list of every node id in the graph
 * (used to populate the "add a dependency" <select>) -- passed in
 * rather than looked up here so this function stays a pure
 * (state, id) -> html mapping with no implicit read of app state.
 *
 * `contractNodeIds` is the sorted list of node ids whose protocol is
 * `contract` -- passed in separately (rather than filtered here from
 * `otherNodeIds`) for the same "stay a pure mapping, no implicit
 * state" reason; it populates the "add an implements relationship"
 * <select>, which is intentionally restricted to contract nodes only
 * (unlike Maps to / Dependencies, which offer every node).
 */
function renderEditForm(node, nodeId, registry, otherNodeIds, contractNodeIds, nodesById) {
  const proto = node.interface.protocol;
  const rule = registry[proto] || { fields: [] };

  let html = `<h2>${escapeHtml(nodeId)}</h2>`;
  html += `<div class="node-id">protocol: ${escapeHtml(proto)} (fixed after creation)</div>`;

  html += `<label class="field-label">Title</label>
    <input type="text" id="f-title" value="${escapeHtml(node.title || "")}">`;

  html += `<label class="field-label">Status</label><select id="f-status">`;
  for (const s of GraphModel.STATUS_ENUM) html += `<option value="${s}" ${s === node.status ? "selected" : ""}>${s}</option>`;
  html += `</select>`;

  html += `<label class="field-label">Boundary</label><select id="f-boundary">`;
  html += `<option value="" ${!node.boundary ? "selected" : ""}>(inherit graph default)</option>`;
  for (const b of GraphModel.BOUNDARY_ENUM) {
    html += `<option value="${b}" ${b === node.boundary ? "selected" : ""}>${b}</option>`;
  }
  html += `</select>`;

  html += `<section><h3>Interface (${escapeHtml(proto)})</h3>`;
  if (rule.fields.includes("params")) {
    html += `<label class="field-label">Params (JSON array of {name, type: &lt;descriptor&gt;})</label><textarea id="f-params" style="min-height:80px">${escapeHtml(JSON.stringify(node.interface.params || [], null, 2))}</textarea>`;
  }
  if (rule.fields.includes("returns")) {
    html += `<label class="field-label">Returns (JSON type descriptor, e.g. {"type":"string"} or {"type":"none"})</label><textarea id="f-returns">${escapeHtml(JSON.stringify(node.interface.returns || { type: "none" }, null, 2))}</textarea>`;
    html += `<div class="readonly-note">A type descriptor is {"type": "string"|"integer"|"float"|"boolean"|"decimal"|"datetime"|"uuid"|"none"}, {"type": "&lt;node id&gt;"} (a reference), {"type":"list","items":&lt;descriptor&gt;}, {"type":"map","key":&lt;descriptor&gt;,"value":&lt;descriptor&gt;}, or {"type":"optional","of":&lt;descriptor&gt;} -- fully nested, never a string to parse.</div>`;
  }
  if (rule.fields.includes("errors")) {
    html += `<label class="field-label">Errors (JSON array of {code, description})</label><textarea id="f-errors">${escapeHtml(JSON.stringify(node.interface.errors || [], null, 2))}</textarea>`;
  }
  if (rule.fields.includes("preconditions")) {
    html += `<label class="field-label">Preconditions (JSON array of strings)</label><textarea id="f-preconditions">${escapeHtml(JSON.stringify(node.interface.preconditions || [], null, 2))}</textarea>`;
  }
  if (rule.fields.includes("postconditions")) {
    html += `<label class="field-label">Postconditions (JSON array of strings)</label><textarea id="f-postconditions">${escapeHtml(JSON.stringify(node.interface.postconditions || [], null, 2))}</textarea>`;
  }
  if (rule.fields.includes("fields")) {
    html += `<label class="field-label">Fields — instance state (JSON array of {name, type: &lt;descriptor&gt;})</label><textarea id="f-class-fields" style="min-height:80px">${escapeHtml(JSON.stringify(node.interface.fields || [], null, 2))}</textarea>`;
  }
  if (rule.fields.includes("language")) {
    html += `<label class="field-label">Language (optional — inherited by everything under this module unless overridden by a nested module)</label><input type="text" id="f-language" placeholder="e.g. python" value="${escapeHtml(node.interface.language || "")}">`;
  }
  if (rule.fields.includes("http_method")) {
    html += `<label class="field-label">HTTP method (leave both this and Route blank if not a REST endpoint)</label><input type="text" id="f-http-method" placeholder="e.g. POST" value="${escapeHtml(node.interface.http_method || "")}">`;
  }
  if (rule.fields.includes("route")) {
    html += `<label class="field-label">Route</label><input type="text" id="f-route" placeholder="e.g. /api/v1/auth/signup" value="${escapeHtml(node.interface.route || "")}">`;
  }
  if (rule.fields.includes("model_kind")) {
    const kind = node.interface.model_kind || GraphModel.MODEL_KIND_DTO;
    html += `<label class="field-label">Model kind</label><select id="f-model-kind">`;
    for (const k of GraphModel.MODEL_KIND_VALUES) {
      html += `<option value="${k}" ${k === kind ? "selected" : ""}>${k}</option>`;
    }
    html += `</select>`;

    // All three sub-field blocks always exist in the DOM (so Save can
    // read whichever one applies without a full form re-render); only
    // the block matching the CURRENT model_kind starts visible.
    // graph-controller.js wires f-model-kind's onchange to toggle
    // which block is shown -- a plain display toggle, no data touched,
    // same pattern as initCheckboxDropdowns' open/close elsewhere in
    // this file.
    const isEnum = kind === GraphModel.MODEL_KIND_ENUM_TYPE;
    const isConstant = kind === GraphModel.MODEL_KIND_CONSTANT;
    const isDto = !isEnum && !isConstant;

    if (rule.fields.includes("model_fields")) {
      html += `<div id="f-model-dto-fields" style="display:${isDto ? "block" : "none"}">`;
      html += `<label class="field-label">Model fields — JSON array of {name, type: &lt;descriptor&gt;, required?, notes?}, OR paste a JSON Schema object ({properties: {...}, required: [...]}) and it's converted automatically on Save</label><textarea id="f-model-fields" style="min-height:100px">${escapeHtml(JSON.stringify(node.interface.model_fields || [], null, 2))}</textarea>`;
      html += `</div>`;

      html += `<div id="f-model-enum-fields" style="display:${isEnum ? "block" : "none"}">`;
      html += `<label class="field-label">Enum type</label><select id="f-enum-type">`;
      for (const t of ["string", "integer"]) html += `<option value="${t}" ${t === (node.interface.enum_type || "string") ? "selected" : ""}>${t}</option>`;
      html += `</select>`;
      html += `<label class="field-label">Enum values (JSON array of {name, value, notes?})</label><textarea id="f-enum-values">${escapeHtml(JSON.stringify(node.interface.enum_values || [], null, 2))}</textarea>`;
      html += `</div>`;

      html += `<div id="f-model-constant-fields" style="display:${isConstant ? "block" : "none"}">`;
      html += `<label class="field-label">Constants (JSON array of {name, type, value, scope, notes?})</label><textarea id="f-constants">${escapeHtml(JSON.stringify(node.interface.constants || [], null, 2))}</textarea>`;
      html += `</div>`;
    }
  }
  if (rule.fields.includes("methods")) {
    html += `<label class="field-label">Methods (JSON array of {name, params:[{name,type:&lt;descriptor&gt;}], returns:&lt;descriptor&gt;})</label><textarea id="f-methods" style="min-height:120px">${escapeHtml(JSON.stringify(node.interface.methods || [], null, 2))}</textarea>`;
  }
  if (rule.fields.includes("exports")) {
    html += `<label class="field-label">Exports (JSON array of {kind,name,signature})</label><textarea id="f-exports">${escapeHtml(JSON.stringify(node.interface.exports || [], null, 2))}</textarea>`;
  }
  if (rule.fields.includes("layout")) {
    const inferred = GraphModel.inferredLayout(nodeId, { nodesById });
    html += `<label class="field-label">Layout (optional — auto-inferred from children if left blank)</label><select id="f-layout">`;
    html += `<option value="" ${!node.interface.layout ? "selected" : ""}>(auto: ${inferred})</option>`;
    for (const l of GraphModel.LAYOUT_ENUM) {
      html += `<option value="${l}" ${l === node.interface.layout ? "selected" : ""}>${l}</option>`;
    }
    html += `</select>`;
    html += `<div class="readonly-note">"file" is only valid if every direct child is a function -- otherwise "folder" is required (enforced by validate_graph.py). folder = a real package, one file per leaf function, recursively.</div>`;
  }
  html += `</section>`;

  html += `<section><h3>Dependencies</h3><div id="f-deps-list">`;
  const deps = GraphModel.depIds(node);
  for (const dep of deps) {
    html += `<span class="dep-chip"><span class="dep-name">${escapeHtml(dep)}</span><span class="rm" data-rm-dep="${escapeHtml(dep)}">×</span></span>`;
  }
  html += `</div>`;
  html += `<select id="f-add-dep-select" style="margin-top:8px">`;
  html += `<option value="">— add a dependency —</option>`;
  for (const id of otherNodeIds) {
    if (id === nodeId || deps.includes(id)) continue;
    html += `<option value="${escapeHtml(id)}">${escapeHtml(id)}</option>`;
  }
  html += `</select>`;
  html += `</section>`;

  // maps_to is a top-level, sibling-to-dependencies node property
  // (not an interface field governed by the registry's `fields`
  // list -- see graph-model.js's addMapsTo doc comment), so it's
  // gated on the protocol directly rather than on `rule.fields`.
  // Only data-model nodes have a meaningful use for it today, but any
  // node could in principle map to a data-model, so the section is
  // offered whenever there's at least one data-model node to target.
  const mapsTo = GraphModel.mapsToIds(node);
  html += `<section><h3>Maps to</h3><div id="f-mapsto-list">`;
  for (const target of mapsTo) {
    html += `<span class="dep-chip maps-to-chip"><span class="dep-name">${escapeHtml(target)}</span><span class="rm" data-rm-mapsto="${escapeHtml(target)}">×</span></span>`;
  }
  html += `</div>`;
  html += `<select id="f-add-mapsto-select" style="margin-top:8px">`;
  html += `<option value="">— add a maps-to mapping —</option>`;
  for (const id of otherNodeIds) {
    if (id === nodeId || mapsTo.includes(id)) continue;
    html += `<option value="${escapeHtml(id)}">${escapeHtml(id)}</option>`;
  }
  html += `</select>`;
  html += `<div class="readonly-note">A type mapping (e.g. a DB row shape → a service DTO), not a call — kept separate from Dependencies.</div>`;
  html += `</section>`;

  // implements is a top-level, sibling-to-dependencies/maps_to node
  // property (not an interface field -- see graph-model.js's
  // addImplements doc comment), same reason maps_to is gated outside
  // `rule.fields`. Offered whenever there's at least one contract node
  // to target, regardless of this node's own protocol -- same
  // generosity as the Maps to section above.
  const impl = GraphModel.implementsIds(node);
  if (impl.length || contractNodeIds.length) {
    html += `<section><h3>Implements</h3><div id="f-implements-list">`;
    for (const target of impl) {
      html += `<span class="dep-chip implements-chip"><span class="dep-name">${escapeHtml(target)}</span><span class="rm" data-rm-implements="${escapeHtml(target)}">×</span></span>`;
    }
    html += `</div>`;
    html += `<select id="f-add-implements-select" style="margin-top:8px">`;
    html += `<option value="">— implement a contract —</option>`;
    for (const id of contractNodeIds) {
      if (id === nodeId || impl.includes(id)) continue;
      html += `<option value="${escapeHtml(id)}">${escapeHtml(id)}</option>`;
    }
    html += `</select>`;
    html += `<div class="readonly-note">"This class fulfills this contract's method signatures" — a structural fact, not a call, kept separate from Dependencies.</div>`;
    html += `</section>`;
  }

  // calls -- a third top-level, sibling-to-dependencies relationship
  // (see graph-model.js's addCall doc comment). Needs a free-text
  // operation name alongside the target, so unlike Maps to/Implements
  // (a single <select> is enough) this needs its own target+text+button
  // trio -- wired in graph-controller.js's wireEditFormHandlers.
  const calls = GraphModel.callIds(node);
  html += `<section><h3>Calls</h3><div id="f-calls-list">`;
  for (const c of node.calls || []) {
    const target = typeof c === "string" ? c : c.node;
    html += `<span class="dep-chip calls-chip"><span class="dep-name">${escapeHtml(target)}${c.operation_name ? "." + escapeHtml(c.operation_name) + "()" : ""}</span><span class="rm" data-rm-call="${escapeHtml(target)}" data-rm-call-op="${escapeHtml(c.operation_name || "")}">×</span></span>`;
  }
  html += `</div>`;
  html += `<select id="f-add-call-target">`;
  html += `<option value="">— target node —</option>`;
  for (const id of otherNodeIds) {
    if (id === nodeId) continue;
    html += `<option value="${escapeHtml(id)}">${escapeHtml(id)}</option>`;
  }
  html += `</select>`;
  html += `<input type="text" id="f-add-call-op" placeholder="operation name, e.g. save_record" style="margin-top:6px">`;
  html += `<button type="button" class="btn secondary" id="f-add-call-btn" style="margin-top:6px">Add call</button>`;
  html += `<div class="readonly-note">Sharpens a dependency down to a named operation — for prompt composition, not a substitute for Dependencies.</div>`;
  html += `</section>`;

  // data_flows -- a fourth top-level, sibling relationship (see
  // graph-model.js's addDataFlow doc comment). Same reasoning as calls
  // for needing its own add-controls rather than a plain <select>.
  html += `<section><h3>Data flows</h3><div id="f-dataflows-list">`;
  for (const d of node.data_flows || []) {
    const target = typeof d === "string" ? d : d.node;
    html += `<span class="dep-chip data-flow-chip"><span class="dep-name">${escapeHtml(d.direction || "")} ${escapeHtml(d.data_model || "")} → ${escapeHtml(target)}</span><span class="rm" data-rm-dataflow="${escapeHtml(target)}" data-rm-dataflow-dir="${escapeHtml(d.direction || "")}">×</span></span>`;
  }
  html += `</div>`;
  html += `<select id="f-add-dataflow-target">`;
  html += `<option value="">— target node —</option>`;
  for (const id of otherNodeIds) {
    if (id === nodeId) continue;
    html += `<option value="${escapeHtml(id)}">${escapeHtml(id)}</option>`;
  }
  html += `</select>`;
  html += `<input type="text" id="f-add-dataflow-model" placeholder="data model id, e.g. expense_record" style="margin-top:6px">`;
  html += `<select id="f-add-dataflow-direction" style="margin-top:6px">`;
  for (const dir of GraphModel.DATA_FLOW_DIRECTIONS) html += `<option value="${dir}">${dir}</option>`;
  html += `</select>`;
  html += `<button type="button" class="btn secondary" id="f-add-dataflow-btn" style="margin-top:6px">Add data flow</button>`;
  html += `</section>`;

  // stub_behavior: function/browser-js/data-model opt in via their
  // registry `fields` list (a static, per-protocol decision). `module`
  // is different -- whether a module has ONE stub-behavior worth
  // describing depends on its LAYOUT (an per-instance interface
  // field, not a protocol constant): a `layout: file` module is a
  // single shared file (skeleton-eligible, see prompt-generator.js's
  // isSkeletonEligible), so it can meaningfully have one; a
  // `layout: folder` module has no single file for "its" behavior to
  // describe (each function child already has its own). Hence the
  // extra instance-level check here rather than adding it to
  // `module`'s static fields list, which would show it unconditionally.
  const isFileLayoutModule = node.interface.protocol === "module" && GraphModel.inferredLayout(nodeId, { nodesById }) === GraphModel.LAYOUT_FILE;
  if (rule.fields.includes("stub_behavior") || isFileLayoutModule) {
    html += `<label class="field-label">Stub behavior</label><textarea id="f-stub-behavior">${escapeHtml(node.stub_behavior || "")}</textarea>`;
  }
  if (rule.fields.includes("tests")) {
    html += `<label class="field-label">Tests (JSON array)</label><textarea id="f-tests" style="min-height:120px">${escapeHtml(JSON.stringify(node.tests || [], null, 2))}</textarea>`;
  }

  html += `<label class="field-label">Notes</label><textarea id="f-notes">${escapeHtml(node.notes || "")}</textarea>`;

  html += `<label class="field-label">Prompt template override (optional — blank uses the built-in default for this protocol; see prompt-generator.js)</label><textarea id="f-prompt-template" placeholder="{id} {path} {language} {action} {signature} {preconditions} {postconditions} {errors} {calls} {data_flows} {dependencies} {children} {notes} {stub_behavior} {guardrail} {scope_note}">${escapeHtml(node.prompt_template || "")}</textarea>`;

  const promptKind = GraphPromptGen.nodeKind(node, { nodesById }, registry);
  if (promptKind) {
    html += `<button type="button" class="btn secondary" id="f-generate-prompt-btn" data-prompt-kind="${promptKind}" style="margin-top:8px">Generate prompt (${promptKind})</button>`;
    html += `<label class="field-label">Generated prompt — review/edit, then Save to persist it into this node's own 'prompt' field</label><textarea id="f-generated-prompt" style="min-height:180px">${escapeHtml(node.prompt || "")}</textarea>`;
  }

  html += `<div id="f-error" class="form-error"></div>`;
  html += `<div class="save-row">
    <button class="btn" id="f-save">Save</button>
    <button class="btn danger" id="f-delete">Delete node</button>
  </div>`;

  return html;
}

/* =======================================================================
 * Add-child popup + custom-protocol modal (markup only)
 * ===================================================================== */

function renderAddChildPopupContent(parentId, parentProto, rule, registry) {
  let html = `<h4>Add child of '${escapeHtml(parentId)}' (${escapeHtml(parentProto)})</h4>`;
  if (!rule.allowedChildren.length) {
    html += `<div class="none-note">This protocol allows no children.</div>`;
  } else {
    for (const childProto of rule.allowedChildren) {
      const label = (registry[childProto] && registry[childProto].label) || childProto;
      html += `<button data-proto="${escapeHtml(childProto)}">${escapeHtml(label)}</button>`;
    }
  }
  return html;
}

const KNOWN_FIELD_OPTIONS = ["params", "returns", "exports", "model_kind", "model_fields", "methods", "tests", "stub_behavior", "http_method", "route", "layout", "fields", "language", "errors", "preconditions", "postconditions"];
// Curated palette offered when registering a custom protocol. Now
// that a protocol's `color` is actually rendered (D3 node-box fill —
// see renderGraph below), these need to be real hex values, not the
// human-readable names `color` used to hold back when it was unused.
const KNOWN_COLORS = [
  { name: "purple", hex: "#a78bfa" },
  { name: "teal", hex: "#2dd4bf" },
  { name: "coral", hex: "#fb7185" },
  { name: "pink", hex: "#f472b6" },
  { name: "gray", hex: "#9ca3af" },
  { name: "blue", hex: "#60a5fa" },
  { name: "green", hex: "#4ade80" },
  { name: "amber", hex: "#fbbf24" },
  { name: "red", hex: "#f87171" },
];

/**
 * Renders a closed-by-default "dropdown with checkboxes" control:
 * a button (shows a live "(n selected)" count) that toggles a
 * scrollable checkbox list. Purely presentational markup — the
 * checkbox `id`s are the real form fields (unchanged from the plain
 * checkbox-list version this replaced), so the Controller reads them
 * exactly as before; only how they're *displayed* changed.
 *
 * @param {string} menuId    unique id for the dropdown menu, used to wire open/close
 * @param {string} placeholder button text shown before anything is checked
 * @param {Array<{id: string, text: string}>} options  checkbox id + label per option
 */
function renderCheckboxDropdown(menuId, placeholder, options) {
  let html = `<div class="ms-dropdown">`;
  html += `<button type="button" class="ms-toggle" data-ms-menu="${menuId}">`;
  html += `<span class="ms-toggle-label" data-ms-label="${menuId}">${escapeHtml(placeholder)}</span>`;
  html += `<span class="ms-caret">▾</span></button>`;
  html += `<div class="ms-menu" id="${menuId}">`;
  for (const opt of options) {
    html += `<label class="ms-option"><input type="checkbox" id="${opt.id}" value="${escapeHtml(opt.value)}"> ${escapeHtml(opt.text)}</label>`;
  }
  html += `</div></div>`;
  return html;
}

function renderProtocolModalContent(registry) {
  let html = `<h3>Register a custom protocol type</h3>`;
  html += `<label>Protocol id (lowercase, hyphenated)</label><input type="text" id="p-id" placeholder="swift-ios-module">`;
  html += `<label>Display label</label><input type="text" id="p-label" placeholder="Swift iOS module">`;
  html += `<label>Language (required — enables the cross-language boundary check)</label><input type="text" id="p-language" placeholder="swift">`;
  html += `<label>Color</label><select id="p-color">`;
  for (const c of KNOWN_COLORS) html += `<option value="${c.hex}">${c.name}</option>`;
  html += `</select>`;

  html += `<label>Allowed children</label>`;
  html += renderCheckboxDropdown(
    "p-children-menu",
    "Select allowed children…",
    Object.keys(registry).map((protoId) => ({ id: `p-child-${protoId}`, value: protoId, text: protoId }))
  );

  html += `<label>Template fields</label>`;
  html += renderCheckboxDropdown(
    "p-fields-menu",
    "Select template fields…",
    KNOWN_FIELD_OPTIONS.map((f) => ({ id: `p-field-${f}`, value: f, text: f }))
  );

  html += `<div id="p-error" class="form-error"></div>`;
  html += `<div class="save-row"><button class="btn" id="p-save">Register</button><button class="btn secondary" id="p-cancel">Cancel</button></div>`;
  return html;
}

/**
 * Wires open/close + live "(n selected)" label updates for every
 * `.ms-dropdown` checkbox-dropdown inside `container`. Purely
 * presentational — like the tooltip helpers above, it holds no app
 * state and reports nothing upward; the Controller still reads the
 * checkbox values directly by id when the form is saved.
 */
function initCheckboxDropdowns(container) {
  container.querySelectorAll(".ms-dropdown").forEach((dropdown) => {
    const toggle = dropdown.querySelector(".ms-toggle");
    const menuId = toggle.getAttribute("data-ms-menu");
    const menu = document.getElementById(menuId);
    const labelEl = dropdown.querySelector(`[data-ms-label="${menuId}"]`);
    const placeholder = labelEl.textContent;

    function updateLabel() {
      const n = menu.querySelectorAll("input[type=checkbox]:checked").length;
      labelEl.textContent = n > 0 ? `${n} selected` : placeholder;
    }

    toggle.addEventListener("click", (event) => {
      event.stopPropagation();
      const isOpen = menu.classList.contains("open");
      document.querySelectorAll(".ms-menu.open").forEach((m) => m.classList.remove("open"));
      if (!isOpen) menu.classList.add("open");
    });
    menu.addEventListener("click", (event) => event.stopPropagation()); // keep menu open while checking boxes
    menu.addEventListener("change", updateLabel);
    updateLabel();
  });
}

// Single, module-level outside-click closer for all checkbox-dropdowns
// (registered once, not per modal-open, so repeated opens of the
// protocol modal never accumulate duplicate listeners).
if (typeof document !== "undefined") {
  document.addEventListener("click", (event) => {
    if (!event.target.closest(".ms-dropdown")) {
      document.querySelectorAll(".ms-menu.open").forEach((m) => m.classList.remove("open"));
    }
  });
}

/* =======================================================================
 * Main tree render (D3)
 * ===================================================================== */

/**
 * Draws the whole SVG tree + cross-edges for the current state and
 * wires up per-node interactions via `handlers`. Nothing here reads
 * or writes app state directly — everything the user might have
 * changed (editMode, collapsedNodes, selectedNodeId) is passed in as
 * plain arguments, and every click is reported back through a handler.
 *
 * @param {object} state
 *   normalized, registry, editMode, collapsedNodes (Set), selectedNodeId
 * @param {object} handlers
 *   onNodeClick(d), onAddChildClick(event, parentId), onToggleCollapse(nodeId)
 */
function renderGraph(state, handlers) {
  const { normalized, registry, editMode, collapsedNodes, selectedNodeId } = state;

  document.getElementById("load-error").textContent = "";
  let tree, crossEdges, mapsToEdges, implementsEdges, callsEdges, dataFlowEdges;
  try {
    tree = GraphModel.buildTree(normalized);
    crossEdges = GraphModel.computeCrossEdges(normalized);
    mapsToEdges = GraphModel.computeMapsToEdges(normalized);
    implementsEdges = GraphModel.computeImplementsEdges(normalized);
    callsEdges = GraphModel.computeCallsEdges(normalized);
    dataFlowEdges = GraphModel.computeDataFlowsEdges(normalized);
  } catch (e) {
    document.getElementById("load-error").textContent = "Graph error: " + e.message;
    return;
  }

  document.getElementById("project-name-display").textContent = normalized.project || "(unnamed)";
  document.getElementById("node-count-display").textContent =
    Object.keys(normalized.nodesById).length + " nodes, " + crossEdges.length + " dependency edges" +
    (mapsToEdges.length ? `, ${mapsToEdges.length} type mapping${mapsToEdges.length === 1 ? "" : "s"}` : "") +
    (implementsEdges.length ? `, ${implementsEdges.length} implements edge${implementsEdges.length === 1 ? "" : "s"}` : "") +
    (callsEdges.length ? `, ${callsEdges.length} call${callsEdges.length === 1 ? "" : "s"}` : "") +
    (dataFlowEdges.length ? `, ${dataFlowEdges.length} data flow${dataFlowEdges.length === 1 ? "" : "s"}` : "");

  const svg = d3.select("#svg");
  svg.classed("edit-mode", editMode);
  svg.selectAll("*").remove();
  const g = svg.append("g");

  const zoom = d3.zoom().scaleExtent([0.2, 3]).on("zoom", (event) => g.attr("transform", event.transform));
  svg.call(zoom);

  const root = d3.hierarchy(tree, (d) => (collapsedNodes.has(d.id) ? null : d.children));
  const treeLayout = d3.tree().nodeSize([46, 280]);
  treeLayout(root);
  root.each((d) => { const t = d.x; d.x = d.y; d.y = t; });

  const nodeById = {};
  root.each((d) => { nodeById[d.data.id] = d; });

  g.selectAll(".link").data(root.links()).join("path")
    .attr("class", "link")
    .attr("data-source", (d) => d.source.data.id)
    .attr("data-target", (d) => d.target.data.id)
    .attr("d", d3.linkHorizontal().x((d) => d.x).y((d) => d.y));

  const crossLinkData = [];
  for (const e of crossEdges) {
    const s = nodeById[e.source], t = nodeById[e.target];
    if (!s || !t) continue;
    crossLinkData.push({ source: s, target: t, dangling: e.dangling, sourceId: e.source, targetId: e.target });
  }
  g.selectAll(".cross-link").data(crossLinkData).join("path")
    .attr("class", (d) => "cross-link" + (d.dangling ? " dangling" : ""))
    .attr("data-source", (d) => d.sourceId)
    .attr("data-target", (d) => d.targetId)
    .attr("d", d3.linkHorizontal().x((d) => d.x).y((d) => d.y));

  const mapsToLinkData = [];
  for (const e of mapsToEdges) {
    const s = nodeById[e.source], t = nodeById[e.target];
    if (!s || !t) continue;
    mapsToLinkData.push({ source: s, target: t, dangling: e.dangling, sourceId: e.source, targetId: e.target });
  }
  g.selectAll(".maps-to-link").data(mapsToLinkData).join("path")
    .attr("class", (d) => "maps-to-link" + (d.dangling ? " dangling" : ""))
    .attr("data-source", (d) => d.sourceId)
    .attr("data-target", (d) => d.targetId)
    .attr("d", d3.linkHorizontal().x((d) => d.x).y((d) => d.y));

  const implementsLinkData = [];
  for (const e of implementsEdges) {
    const s = nodeById[e.source], t = nodeById[e.target];
    if (!s || !t) continue;
    implementsLinkData.push({ source: s, target: t, dangling: e.dangling, sourceId: e.source, targetId: e.target });
  }
  g.selectAll(".implements-link").data(implementsLinkData).join("path")
    .attr("class", (d) => "implements-link" + (d.dangling ? " dangling" : ""))
    .attr("data-source", (d) => d.sourceId)
    .attr("data-target", (d) => d.targetId)
    .attr("d", d3.linkHorizontal().x((d) => d.x).y((d) => d.y));

  const callsLinkData = [];
  for (const e of callsEdges) {
    const s = nodeById[e.source], t = nodeById[e.target];
    if (!s || !t) continue;
    callsLinkData.push({ source: s, target: t, dangling: e.dangling, sourceId: e.source, targetId: e.target });
  }
  g.selectAll(".calls-link").data(callsLinkData).join("path")
    .attr("class", (d) => "calls-link" + (d.dangling ? " dangling" : ""))
    .attr("data-source", (d) => d.sourceId)
    .attr("data-target", (d) => d.targetId)
    .attr("d", d3.linkHorizontal().x((d) => d.x).y((d) => d.y));

  const dataFlowLinkData = [];
  for (const e of dataFlowEdges) {
    const s = nodeById[e.source], t = nodeById[e.target];
    if (!s || !t) continue;
    dataFlowLinkData.push({ source: s, target: t, dangling: e.dangling, sourceId: e.source, targetId: e.target });
  }
  g.selectAll(".data-flow-link").data(dataFlowLinkData).join("path")
    .attr("class", (d) => "data-flow-link" + (d.dangling ? " dangling" : ""))
    .attr("data-source", (d) => d.sourceId)
    .attr("data-target", (d) => d.targetId)
    .attr("d", d3.linkHorizontal().x((d) => d.x).y((d) => d.y));

  const nodeG = g.selectAll(".node").data(root.descendants()).join("g")
    .attr("class", "node")
    .attr("transform", (d) => `translate(${d.x},${d.y})`);

  const boxWidth = (d) => Math.max(70, d.data.id.length * 6.2 + 16);
  const boxHeight = 30;

  nodeG.append("rect")
    .attr("class", "node-box")
    .attr("x", (d) => -boxWidth(d) / 2)
    .attr("y", -boxHeight / 2)
    .attr("width", boxWidth)
    .attr("height", boxHeight)
    .attr("rx", 6)
    // Fill = protocol type (what kind of node this is); border = status
    // (how far along it is). Two independent facts, two independent
    // colors, both configurable via protocol-registry.json /
    // status-colors.json respectively -- see graph-config.js.
    .attr("fill", (d) => {
      const proto = d.data.node.interface && d.data.node.interface.protocol;
      return (registry[proto] && registry[proto].color) || "#666";
    })
    .attr("stroke", (d) => GraphModel.STATUS_COLORS[d.data.node.status] || "#000")
    .on("click", (event, d) => handlers.onNodeClick(d))
    .on("mouseenter", (event, d) => showTooltip(event, d))
    .on("mousemove", (event) => moveTooltip(event))
    .on("mouseleave", hideTooltip);

  nodeG.append("text").attr("class", "node-label").attr("text-anchor", "middle")
    .attr("dy", (d) => (d.data.node.interface && d.data.node.interface.protocol === "function") ? -2 : 4)
    .text((d) => d.data.id).style("pointer-events", "none");

  nodeG.filter((d) => d.data.node.interface && d.data.node.interface.protocol === "function")
    .append("text").attr("class", "node-sublabel").attr("text-anchor", "middle").attr("dy", 10)
    .text((d) => "ƒ leaf").style("pointer-events", "none");

  nodeG.filter((d) => {
    if (!editMode) return false; // must not be creatable/clickable outside edit mode
    const proto = d.data.node.interface && d.data.node.interface.protocol;
    const rule = registry[proto];
    return rule && rule.allowedChildren && rule.allowedChildren.length > 0;
  }).append("g")
    .attr("class", "add-child-btn")
    .attr("transform", (d) => `translate(${boxWidth(d) / 2 - 2}, ${-boxHeight / 2 + 2})`)
    .on("click", (event, d) => { event.stopPropagation(); handlers.onAddChildClick(event, d.data.id); })
    .call((sel) => {
      sel.append("circle").attr("r", 9);
      sel.append("text").attr("dy", 4).text("+");
    });

  // Collapse/expand toggle -- works in BOTH view and edit mode (this is
  // navigation, not editing). Checks the FULL, unpruned children list
  // (childrenOf against normalized.nodesById), not d.children -- a
  // collapsed node's own d.children is empty in the pruned d3.hierarchy,
  // which would otherwise make the toggle vanish the moment you use it.
  const toggleG = nodeG.filter((d) => GraphModel.childrenOf(d.data.id, normalized.nodesById).length > 0)
    .append("g")
    .attr("class", "collapse-toggle")
    .attr("transform", (d) => `translate(${-boxWidth(d) / 2 + 2}, ${-boxHeight / 2 + 2})`)
    .on("click", (event, d) => { event.stopPropagation(); handlers.onToggleCollapse(d.data.id); });
  toggleG.append("circle").attr("r", 9);
  toggleG.append("text").attr("dy", 4)
    .text((d) => (collapsedNodes.has(d.data.id) ? "+" : "\u2212"));
  toggleG.filter((d) => collapsedNodes.has(d.data.id))
    .append("text")
    .attr("class", "collapse-badge")
    .attr("x", 11).attr("y", -8)
    .text((d) => GraphModel.childrenOf(d.data.id, normalized.nodesById).length);

  const bounds = g.node().getBBox();
  const containerEl = document.getElementById("canvas-container");
  const initialScale = Math.min(1, containerEl.clientWidth / (bounds.width + 100)) || 1;
  const initialTransform = d3.zoomIdentity
    .translate(containerEl.clientWidth / 2 - (bounds.x + bounds.width * 0.15) * initialScale,
               containerEl.clientHeight / 2 - (bounds.y + bounds.height / 2) * initialScale)
    .scale(initialScale);
  svg.call(zoom.transform, initialTransform);

  if (selectedNodeId && normalized.nodesById[selectedNodeId]) {
    markSelected(selectedNodeId);
    highlightEdgesFor(selectedNodeId);
  }

  renderLegend(registry);
}

/**
 * Rebuilds the legend's status and protocol swatch lists from the
 * CURRENT (possibly config-loaded, possibly custom-protocol-extended)
 * color values, rather than the hardcoded list this replaced. Cheap
 * to call on every render, and keeps the legend from silently going
 * stale the moment status-colors.json / protocol-registry.json (or a
 * runtime-registered custom protocol) changes what a color means.
 */
function renderLegend(registry) {
  const statusList = document.getElementById("legend-status-list");
  if (statusList) {
    statusList.innerHTML = GraphModel.STATUS_ORDER.map((s) =>
      `<div class="row"><span class="swatch status-swatch" style="border-color:${escapeHtml(GraphModel.STATUS_COLORS[s] || "#666")}"></span> ${escapeHtml(s)}</div>`
    ).join("");
  }
  const protoList = document.getElementById("legend-protocol-list");
  if (protoList) {
    protoList.innerHTML = Object.entries(registry).map(([id, def]) =>
      `<div class="row"><span class="swatch" style="background:${escapeHtml(def.color || "#666")}"></span> ${escapeHtml(def.label || id)}</div>`
    ).join("");
  }
}

function markSelected(nodeId) {
  d3.selectAll(".node-box").classed("selected", false);
  d3.selectAll(".node").filter((dd) => dd.data.id === nodeId).select(".node-box").classed("selected", true);
}

/**
 * Bold + brighten every edge touching this node (either direction --
 * a node can be the source of a dependency or the target of one, both
 * matter for "what connects to this node"), dim everything else. This
 * is the direct fix for edges that are structurally correct but
 * visually easy to lose -- e.g. several same-depth sibling services
 * all pointing at one shared node (storage_service) can overlap into
 * what looks like a single line; highlighting separates them without
 * needing to change the underlying layout.
 */
function highlightEdgesFor(nodeId) {
  d3.selectAll(".link, .cross-link, .maps-to-link, .implements-link, .calls-link, .data-flow-link").each(function () {
    const el = d3.select(this);
    const touches = el.attr("data-source") === nodeId || el.attr("data-target") === nodeId;
    el.classed("edge-highlighted", touches).classed("edge-dimmed", !touches);
  });
}

function clearEdgeHighlight() {
  d3.selectAll(".link, .cross-link, .maps-to-link, .implements-link, .calls-link, .data-flow-link").classed("edge-highlighted", false).classed("edge-dimmed", false);
}

/* =======================================================================
 * Export — `window.GraphView`. Browser-only (this file manipulates the
 * DOM directly, so unlike graph-model.js it is not Node-testable as-is).
 * ===================================================================== */

const GraphView = {
  escapeHtml, formatTypeDescriptor, formatSignature,
  showTooltip, moveTooltip, hideTooltip, showToast,
  renderViewPanel, renderEditForm,
  renderAddChildPopupContent, renderProtocolModalContent, initCheckboxDropdowns,
  KNOWN_FIELD_OPTIONS, KNOWN_COLORS,
  renderGraph, renderLegend, markSelected, highlightEdgesFor, clearEdgeHighlight,
};

if (typeof window !== "undefined") {
  window.GraphView = GraphView;
}
