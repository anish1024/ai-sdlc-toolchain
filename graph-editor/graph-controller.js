/**
 * graph-controller.js — CONTROLLER layer (the "ViewModel").
 *
 * This is the only file in the app that:
 *   - holds mutable state (registry, normalized, editMode, selectedNodeId,
 *     collapsedNodes),
 *   - listens for real DOM events (clicks, file picks, form submits),
 *   - decides what a user action means (call a GraphModel mutation,
 *     then ask GraphView to re-render).
 *
 * Model functions never call View functions and never touch the DOM.
 * View functions never call Model functions and never mutate state.
 * This file is the only place those two meet — which is deliberate:
 * when the graph.yaml schema changes, you extend graph-model.js; when
 * the look of a panel changes, you extend graph-view.js; when a new
 * *interaction* is needed (a new button, a new way to trigger an
 * existing mutation), you extend this file. Each kind of change has
 * exactly one place to make it.
 */

(function () {
  "use strict";

  /* ---------------- app state ---------------- */

  // Placeholder until boot() clones GraphModel.PROTOCOL_REGISTRY --
  // deliberately deferred to AFTER config loading (see boot() at the
  // bottom of this file), so the clone picks up protocol-registry.json's
  // values if that file loaded successfully, not the JS built-in
  // defaults it would otherwise start from.
  let registry = {};
  let normalized = null;
  let editMode = false;
  let selectedNodeId = null;
  let collapsedNodes = new Set();

  /* ---------------- render orchestration ---------------- */

  function renderAll() {
    GraphView.renderGraph(
      { normalized, registry, editMode, collapsedNodes, selectedNodeId },
      { onNodeClick: handleNodeClick, onAddChildClick: handleAddChildClick, onToggleCollapse: handleToggleCollapse }
    );
    if (selectedNodeId && normalized.nodesById[selectedNodeId]) {
      // Re-open the panel content (not via handleNodeClick, which
      // toggles the panel closed if the same node is already
      // selected+open — that would close the panel immediately after
      // every Save, since Save calls renderAll() while the panel is
      // still open on the node just edited).
      openDetailPanelFor(selectedNodeId);
    }
  }

  /* ---------------- node selection / detail panel ---------------- */

  function handleNodeClick(d) {
    const nodeId = d.data.id;
    const panel = document.getElementById("detail-panel");
    if (selectedNodeId === nodeId && panel.classList.contains("open")) {
      panel.classList.remove("open");
      selectedNodeId = null;
      GraphView.clearEdgeHighlight();
      GraphView.markSelected(null);
      return;
    }
    selectedNodeId = nodeId;
    GraphView.markSelected(nodeId);
    GraphView.highlightEdgesFor(nodeId);
    openDetailPanelFor(nodeId);
  }

  function openDetailPanelFor(nodeId) {
    const node = normalized.nodesById[nodeId];
    if (!node) return;
    const panel = document.getElementById("detail-panel");
    if (editMode) {
      const otherNodeIds = Object.keys(normalized.nodesById).sort();
      const contractNodeIds = otherNodeIds.filter(
        (id) => normalized.nodesById[id].interface && normalized.nodesById[id].interface.protocol === "contract"
      );
      document.getElementById("detail-content").innerHTML =
        GraphView.renderEditForm(node, nodeId, registry, otherNodeIds, contractNodeIds, normalized.nodesById);
      panel.classList.add("open");
      wireEditFormHandlers(nodeId);
    } else {
      document.getElementById("detail-content").innerHTML = GraphView.renderViewPanel(node, nodeId);
      panel.classList.add("open");
      document.querySelectorAll(".dep-name[data-dep]").forEach((el) => {
        el.addEventListener("click", () => {
          selectedNodeId = el.getAttribute("data-dep");
          GraphView.markSelected(selectedNodeId);
          GraphView.highlightEdgesFor(selectedNodeId);
          openDetailPanelFor(selectedNodeId);
        });
      });
    }
  }

  function wireEditFormHandlers(nodeId) {
    const errBox = document.getElementById("f-error");

    document.querySelectorAll("[data-rm-dep]").forEach((el) => {
      el.addEventListener("click", () => {
        const dep = el.getAttribute("data-rm-dep");
        try {
          GraphModel.removeDependency(normalized.nodesById, nodeId, dep);
          GraphView.showToast(`Removed dependency on '${dep}'.`, "success");
          openDetailPanelFor(nodeId);
        } catch (e) {
          errBox.textContent = e.message;
          GraphView.showToast(e.message, "error");
        }
      });
    });

    const addDepSelect = document.getElementById("f-add-dep-select");
    if (addDepSelect) {
      addDepSelect.addEventListener("change", () => {
        const target = addDepSelect.value;
        if (!target) return;
        try {
          // Hard block, not a warning-with-override -- a cross-language
          // edge without boundary=service is claiming a physically
          // impossible same-process call. The fix is always the same
          // and always available: set this node's boundary to
          // 'service' first, then add the dependency. Matches the
          // same rule validate_graph.py enforces after the fact --
          // caught here at authoring time instead.
          const warning = GraphModel.checkCrossLanguageBoundary(
            normalized.nodesById, registry, nodeId, target, normalized.defaultBoundary, normalized.defaultLanguage
          );
          if (warning) {
            errBox.textContent = warning;
            GraphView.showToast(warning, "error");
            addDepSelect.value = "";
            return;
          }
          errBox.textContent = "";
          GraphModel.addDependency(normalized.nodesById, nodeId, target);
          GraphView.showToast(`Added dependency on '${target}'.`, "success");
          openDetailPanelFor(nodeId);
        } catch (e) {
          errBox.textContent = e.message;
          GraphView.showToast(e.message, "error");
        }
      });
    }

    // Pure display toggle when Model kind changes -- no data is
    // touched here, just which of the three sub-field blocks (dto,
    // enum, constant) is visible. The actual switch to whichever
    // block was visible at Save time happens in the f-save handler
    // below, reading f-model-kind.value fresh.
    const modelKindEl = document.getElementById("f-model-kind");
    if (modelKindEl) {
      modelKindEl.addEventListener("change", () => {
        const kind = modelKindEl.value;
        const dtoBox = document.getElementById("f-model-dto-fields");
        const enumBox = document.getElementById("f-model-enum-fields");
        const constBox = document.getElementById("f-model-constant-fields");
        if (dtoBox) dtoBox.style.display = (kind !== GraphModel.MODEL_KIND_ENUM_TYPE && kind !== GraphModel.MODEL_KIND_CONSTANT) ? "block" : "none";
        if (enumBox) enumBox.style.display = kind === GraphModel.MODEL_KIND_ENUM_TYPE ? "block" : "none";
        if (constBox) constBox.style.display = kind === GraphModel.MODEL_KIND_CONSTANT ? "block" : "none";
      });
    }

    document.querySelectorAll("[data-rm-implements]").forEach((el) => {
      el.addEventListener("click", () => {
        const target = el.getAttribute("data-rm-implements");
        try {
          GraphModel.removeImplements(normalized.nodesById, nodeId, target);
          GraphView.showToast(`Removed implements '${target}'.`, "success");
          openDetailPanelFor(nodeId);
        } catch (e) {
          errBox.textContent = e.message;
          GraphView.showToast(e.message, "error");
        }
      });
    });

    const addImplementsSelect = document.getElementById("f-add-implements-select");
    if (addImplementsSelect) {
      addImplementsSelect.addEventListener("change", () => {
        const target = addImplementsSelect.value;
        if (!target) return;
        try {
          // No cross-language boundary check here -- same reasoning as
          // maps_to: implementing a contract isn't a call, so it isn't
          // claiming a same-process invocation across a language
          // boundary. GraphModel.addImplements itself still enforces
          // the target is actually a `contract` node.
          errBox.textContent = "";
          GraphModel.addImplements(normalized.nodesById, nodeId, target);
          GraphView.showToast(`Now implements '${target}'.`, "success");
          openDetailPanelFor(nodeId);
        } catch (e) {
          errBox.textContent = e.message;
          GraphView.showToast(e.message, "error");
        }
      });
    }

    document.querySelectorAll("[data-rm-mapsto]").forEach((el) => {
      el.addEventListener("click", () => {
        const target = el.getAttribute("data-rm-mapsto");
        try {
          GraphModel.removeMapsTo(normalized.nodesById, nodeId, target);
          GraphView.showToast(`Removed maps_to '${target}'.`, "success");
          openDetailPanelFor(nodeId);
        } catch (e) {
          errBox.textContent = e.message;
          GraphView.showToast(e.message, "error");
        }
      });
    });

    const addMapsToSelect = document.getElementById("f-add-mapsto-select");
    if (addMapsToSelect) {
      addMapsToSelect.addEventListener("change", () => {
        const target = addMapsToSelect.value;
        if (!target) return;
        try {
          // No cross-language boundary check here -- unlike
          // Dependencies, maps_to isn't a call, so a Python DB schema
          // mapping to a shared data-model shape isn't claiming a
          // same-process call across a language boundary.
          errBox.textContent = "";
          GraphModel.addMapsTo(normalized.nodesById, nodeId, target);
          GraphView.showToast(`Added maps_to '${target}'.`, "success");
          openDetailPanelFor(nodeId);
        } catch (e) {
          errBox.textContent = e.message;
          GraphView.showToast(e.message, "error");
        }
      });
    }

    // calls -- needs a target + free-text operation name, so this is a
    // button click rather than a plain <select> onchange (see
    // renderEditForm's comment on why calls/data_flows differ from
    // maps_to/implements here).
    document.querySelectorAll("[data-rm-call]").forEach((el) => {
      el.addEventListener("click", () => {
        const target = el.getAttribute("data-rm-call");
        const op = el.getAttribute("data-rm-call-op") || undefined;
        try {
          GraphModel.removeCall(normalized.nodesById, nodeId, target, op);
          GraphView.showToast(`Removed call to '${target}'.`, "success");
          openDetailPanelFor(nodeId);
        } catch (e) {
          errBox.textContent = e.message;
          GraphView.showToast(e.message, "error");
        }
      });
    });
    const addCallBtn = document.getElementById("f-add-call-btn");
    if (addCallBtn) {
      addCallBtn.addEventListener("click", () => {
        const target = document.getElementById("f-add-call-target").value;
        const op = document.getElementById("f-add-call-op").value;
        if (!target) {
          errBox.textContent = "Pick a target node for the call.";
          GraphView.showToast("Pick a target node for the call.", "error");
          return;
        }
        try {
          errBox.textContent = "";
          GraphModel.addCall(normalized.nodesById, nodeId, target, op);
          GraphView.showToast(`Added call to '${target}'.`, "success");
          openDetailPanelFor(nodeId);
        } catch (e) {
          errBox.textContent = e.message;
          GraphView.showToast(e.message, "error");
        }
      });
    }

    // data_flows -- same reasoning as calls above.
    document.querySelectorAll("[data-rm-dataflow]").forEach((el) => {
      el.addEventListener("click", () => {
        const target = el.getAttribute("data-rm-dataflow");
        const dir = el.getAttribute("data-rm-dataflow-dir") || undefined;
        try {
          GraphModel.removeDataFlow(normalized.nodesById, nodeId, target, dir);
          GraphView.showToast(`Removed data flow to '${target}'.`, "success");
          openDetailPanelFor(nodeId);
        } catch (e) {
          errBox.textContent = e.message;
          GraphView.showToast(e.message, "error");
        }
      });
    });
    const addDataFlowBtn = document.getElementById("f-add-dataflow-btn");
    if (addDataFlowBtn) {
      addDataFlowBtn.addEventListener("click", () => {
        const target = document.getElementById("f-add-dataflow-target").value;
        const model = document.getElementById("f-add-dataflow-model").value;
        const direction = document.getElementById("f-add-dataflow-direction").value;
        if (!target) {
          errBox.textContent = "Pick a target node for the data flow.";
          GraphView.showToast("Pick a target node for the data flow.", "error");
          return;
        }
        try {
          errBox.textContent = "";
          GraphModel.addDataFlow(normalized.nodesById, nodeId, target, model, direction);
          GraphView.showToast(`Added data flow to '${target}'.`, "success");
          openDetailPanelFor(nodeId);
        } catch (e) {
          errBox.textContent = e.message;
          GraphView.showToast(e.message, "error");
        }
      });
    }

    // Single-node "Generate prompt" -- same composition + same
    // full-graph validation as the "Generate prompts.json" header
    // button, applied to just this one node. Writes into the
    // textarea in place (no re-render/openDetailPanelFor) so any
    // other in-progress, unsaved edits in this form aren't discarded;
    // the text only becomes part of the node's real data when the
    // user clicks this form's own Save button below.
    const generatePromptBtn = document.getElementById("f-generate-prompt-btn");
    if (generatePromptBtn) {
      generatePromptBtn.addEventListener("click", () => {
        const outputEl = document.getElementById("f-generated-prompt");
        if (outputEl.value.trim()) {
          if (!confirm("This will overwrite the current generated prompt text shown below (not yet saved elsewhere). Continue?")) return;
        }
        const { errors, warnings } = GraphValidate.validateGraph(normalized, registry);
        if (errors.length) {
          const msg = `Cannot generate -- ${errors.length} validation error(s) in the graph:\n` + errors.slice(0, 10).join("\n");
          errBox.textContent = msg;
          GraphView.showToast(`Cannot generate -- ${errors.length} validation error(s). See details below.`, "error");
          return;
        }
        if (warnings.length) {
          const proceed = confirm(`${warnings.length} validation warning(s) found:\n\n` + warnings.slice(0, 10).join("\n") + `\n\nGenerate anyway?`);
          if (!proceed) return;
        }
        errBox.textContent = "";
        const kind = generatePromptBtn.getAttribute("data-prompt-kind");
        const node = normalized.nodesById[nodeId];
        outputEl.value = GraphPromptGen.buildPromptForNode(node, nodeId, normalized, kind, registry);
        GraphView.showToast("Prompt generated -- review below, then Save to persist it.", "success");
      });
    }

    document.getElementById("f-save").addEventListener("click", () => {
      errBox.textContent = "";
      const node = normalized.nodesById[nodeId];
      let schemaNotesPrefix = ""; // set below if model_fields was pasted as a JSON Schema with its own top-level description
      try {
        node.title = document.getElementById("f-title").value;
        node.status = document.getElementById("f-status").value;
        node.boundary = document.getElementById("f-boundary").value || null;

        const paramsEl = document.getElementById("f-params");
        if (paramsEl) node.interface.params = paramsEl.value.trim() ? JSON.parse(paramsEl.value) : [];
        const returnsEl = document.getElementById("f-returns");
        if (returnsEl) node.interface.returns = returnsEl.value.trim() ? JSON.parse(returnsEl.value) : { type: "none" };
        const classFieldsEl = document.getElementById("f-class-fields");
        if (classFieldsEl) node.interface.fields = classFieldsEl.value.trim() ? JSON.parse(classFieldsEl.value) : [];
        const errorsEl = document.getElementById("f-errors");
        if (errorsEl) node.interface.errors = errorsEl.value.trim() ? JSON.parse(errorsEl.value) : [];
        const preconditionsEl = document.getElementById("f-preconditions");
        if (preconditionsEl) node.interface.preconditions = preconditionsEl.value.trim() ? JSON.parse(preconditionsEl.value) : [];
        const postconditionsEl = document.getElementById("f-postconditions");
        if (postconditionsEl) node.interface.postconditions = postconditionsEl.value.trim() ? JSON.parse(postconditionsEl.value) : [];
        const languageEl = document.getElementById("f-language");
        if (languageEl) {
          if (languageEl.value.trim()) node.interface.language = languageEl.value.trim();
          else delete node.interface.language;
        }
        const httpMethodEl = document.getElementById("f-http-method");
        if (httpMethodEl) {
          if (httpMethodEl.value.trim()) node.interface.http_method = httpMethodEl.value.trim();
          else delete node.interface.http_method;
        }
        const routeEl = document.getElementById("f-route");
        if (routeEl) {
          if (routeEl.value.trim()) node.interface.route = routeEl.value.trim();
          else delete node.interface.route;
        }

        const modelKindEl = document.getElementById("f-model-kind");
        if (modelKindEl) {
          const kind = modelKindEl.value;
          node.interface.model_kind = kind;
          // Only the sub-fields matching the FINAL selected kind are
          // read and kept; the other kinds' fields are cleared so a
          // dto-turned-enum node doesn't carry stale model_fields (or
          // vice versa) -- see renderEditForm's comment on why all
          // three blocks exist in the DOM simultaneously.
          if (kind === GraphModel.MODEL_KIND_ENUM_TYPE) {
            const enumTypeEl = document.getElementById("f-enum-type");
            if (enumTypeEl) node.interface.enum_type = enumTypeEl.value;
            const enumValuesEl = document.getElementById("f-enum-values");
            if (enumValuesEl) node.interface.enum_values = enumValuesEl.value.trim() ? JSON.parse(enumValuesEl.value) : [];
            delete node.interface.model_fields;
            delete node.interface.constants;
          } else if (kind === GraphModel.MODEL_KIND_CONSTANT) {
            const constantsEl = document.getElementById("f-constants");
            if (constantsEl) node.interface.constants = constantsEl.value.trim() ? JSON.parse(constantsEl.value) : [];
            delete node.interface.model_fields;
            delete node.interface.enum_type;
            delete node.interface.enum_values;
          } else {
            const modelFieldsEl = document.getElementById("f-model-fields");
            if (modelFieldsEl) {
              const raw = modelFieldsEl.value.trim();
              if (!raw) {
                node.interface.model_fields = [];
              } else {
                const parsed = JSON.parse(raw);
                if (Array.isArray(parsed)) {
                  // Already our shape -- pass through unchanged, same as before this feature existed.
                  node.interface.model_fields = parsed;
                } else if (GraphModel.looksLikeJsonSchema(parsed)) {
                  // Alternate input format: a JSON Schema object, converted
                  // once into our canonical array shape. Nothing downstream
                  // (validator, prompt composer, this form's own re-render)
                  // ever sees the JSON Schema shape again -- see
                  // convertJsonSchemaToModelFields's doc comment.
                  const result = GraphModel.convertJsonSchemaToModelFields(parsed);
                  node.interface.model_fields = result.model_fields;
                  // Backfill Title only if this submission left it empty --
                  // an intentional edit in THIS save always wins over the
                  // schema's own title.
                  if (!node.title && result.title) node.title = result.title;
                  // Notes: prepended later, never overwriting anything
                  // already typed into f-notes in this same submission.
                  if (result.notes) schemaNotesPrefix = result.notes;
                  GraphView.showToast(`Converted JSON Schema -> ${result.model_fields.length} model field(s).`, "success");
                } else {
                  throw new Error("model_fields must be either an array of field objects or a JSON Schema object with a 'properties' key.");
                }
              }
            }
            delete node.interface.enum_type;
            delete node.interface.enum_values;
            delete node.interface.constants;
          }
        }
        const methodsEl = document.getElementById("f-methods");
        if (methodsEl) node.interface.methods = methodsEl.value.trim() ? JSON.parse(methodsEl.value) : [];
        const exportsEl = document.getElementById("f-exports");
        if (exportsEl) node.interface.exports = exportsEl.value.trim() ? JSON.parse(exportsEl.value) : [];
        const layoutEl = document.getElementById("f-layout");
        // "" (the "(auto: ...)" option) means unset -- let it be inferred at generation time, don't write a literal empty string
        if (layoutEl) {
          if (layoutEl.value) node.interface.layout = layoutEl.value;
          else delete node.interface.layout;
        }

        const stubEl = document.getElementById("f-stub-behavior");
        if (stubEl) node.stub_behavior = stubEl.value;
        const testsEl = document.getElementById("f-tests");
        if (testsEl) node.tests = testsEl.value.trim() ? JSON.parse(testsEl.value) : [];

        node.notes = (schemaNotesPrefix ? schemaNotesPrefix + "\n\n" : "") + document.getElementById("f-notes").value;
        const promptTemplateEl = document.getElementById("f-prompt-template");
        if (promptTemplateEl) node.prompt_template = promptTemplateEl.value;
        const generatedPromptEl = document.getElementById("f-generated-prompt");
        if (generatedPromptEl) node.prompt = generatedPromptEl.value;

        renderAll();
        GraphView.showToast(`Saved '${nodeId}'.`, "success");
      } catch (e) {
        errBox.textContent = "Save failed (likely invalid JSON in Types/Model fields/Enum values/Constants/Methods/Exports/Tests): " + e.message;
        GraphView.showToast("Save failed: " + e.message, "error");
      }
    });

    document.getElementById("f-delete").addEventListener("click", () => {
      if (!confirm(`Delete node '${nodeId}'? This cannot be undone.`)) return;
      try {
        GraphModel.deleteNode(normalized.nodesById, nodeId);
        selectedNodeId = null;
        document.getElementById("detail-panel").classList.remove("open");
        renderAll();
        GraphView.showToast(`Deleted '${nodeId}'.`, "success");
      } catch (e) {
        errBox.textContent = e.message;
        GraphView.showToast(e.message, "error");
      }
    });
  }

  /* ---------------- collapse/expand ---------------- */

  function handleToggleCollapse(nodeId) {
    if (collapsedNodes.has(nodeId)) collapsedNodes.delete(nodeId);
    else collapsedNodes.add(nodeId);
    renderAll();
  }

  /* ---------------- add-child popup ---------------- */

  function handleAddChildClick(event, parentId) {
    const parent = normalized.nodesById[parentId];
    const parentProto = parent.interface.protocol;
    const rule = registry[parentProto];
    const popup = document.getElementById("add-child-popup");
    popup.innerHTML = GraphView.renderAddChildPopupContent(parentId, parentProto, rule, registry);
    popup.style.left = (event.clientX + 8) + "px";
    popup.style.top = (event.clientY + 8) + "px";
    popup.style.display = "block";

    popup.querySelectorAll("button[data-proto]").forEach((btn) => {
      btn.addEventListener("click", () => {
        const proto = btn.getAttribute("data-proto");
        popup.style.display = "none";
        const newId = prompt(`New '${proto}' node id (must be unique):`);
        if (!newId) return;
        try {
          GraphModel.validateAddChild(normalized.nodesById, parentId, proto, registry);
          const node = GraphModel.emptyNodeFor(newId.trim(), proto, parentId, registry);
          GraphModel.addNode(normalized.nodesById, node);
          selectedNodeId = newId.trim();
          renderAll();
          GraphView.showToast(`Created '${newId.trim()}' (${proto}).`, "success");
        } catch (e) {
          alert(e.message);
          GraphView.showToast(e.message, "error");
        }
      });
    });

    const closeOnOutsideClick = (ev) => {
      if (!popup.contains(ev.target)) {
        popup.style.display = "none";
        document.removeEventListener("click", closeOnOutsideClick, true);
      }
    };
    setTimeout(() => document.addEventListener("click", closeOnOutsideClick, true), 0);
  }

  /* ---------------- header controls ---------------- */

  document.getElementById("close-panel").addEventListener("click", () => {
    document.getElementById("detail-panel").classList.remove("open");
    selectedNodeId = null;
    GraphView.markSelected(null);
    GraphView.clearEdgeHighlight();
  });

  document.getElementById("edit-mode-toggle").addEventListener("change", (e) => {
    editMode = e.target.checked;
    document.getElementById("save-btn").style.display = editMode ? "inline-block" : "none";
    document.getElementById("prompts-btn").style.display = editMode ? "inline-block" : "none";
    document.getElementById("new-graph-btn").style.display = editMode ? "inline-block" : "none";
    document.getElementById("add-protocol-btn").style.display = editMode ? "inline-block" : "none";
    renderAll();
  });

  /**
   * Writes `text` to disk under `suggestedName`. Uses the File System
   * Access API's native save dialog when the browser supports it
   * (Chrome/Edge -- Firefox and Safari have declined to implement it),
   * passing the SAME `pickerId` across calls so the browser itself
   * remembers and reopens the last directory used for that id (its
   * built-in behavior -- no manual path-tracking needed here). Falls
   * back to the old anchor/Blob download when the API isn't available,
   * so the app still works everywhere, just without a save dialog or
   * remembered path in that case.
   *
   * Returns true if the file was actually written, false if the user
   * cancelled the native picker (so callers can skip any "saved!"
   * confirmation in that case) -- always true for the download fallback,
   * since there's no cancel step there.
   */
  async function saveTextFile(text, suggestedName, pickerId) {
    if ("showSaveFilePicker" in window) {
      try {
        const handle = await window.showSaveFilePicker({
          id: pickerId,
          suggestedName,
          types: [{ description: "YAML/JSON", accept: { "text/plain": [".yaml", ".yml", ".json"] } }],
        });
        const writable = await handle.createWritable();
        await writable.write(text);
        await writable.close();
        return true;
      } catch (e) {
        if (e && e.name === "AbortError") return false; // user cancelled the picker -- not an error
        console.warn("showSaveFilePicker failed, falling back to download:", e.message);
        // fall through to the download fallback below
      }
    }
    const blob = new Blob([text], { type: "text/plain" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = suggestedName;
    a.click();
    URL.revokeObjectURL(url);
    return true;
  }

  document.getElementById("save-btn").addEventListener("click", async () => {
    const { errors, warnings } = GraphValidate.validateGraph(normalized, registry);
    if (errors.length) {
      alert(
        `Cannot save -- ${errors.length} validation error(s):\n\n` +
        errors.slice(0, 15).join("\n") +
        (errors.length > 15 ? `\n...and ${errors.length - 15} more.` : "")
      );
      GraphView.showToast(`Cannot save -- ${errors.length} validation error(s).`, "error");
      return;
    }
    if (warnings.length) {
      const proceed = confirm(
        `${warnings.length} validation warning(s):\n\n` +
        warnings.slice(0, 10).join("\n") +
        (warnings.length > 10 ? `\n...and ${warnings.length - 10} more.` : "") +
        `\n\nSave anyway?`
      );
      if (!proceed) return;
    }
    const payload = GraphModel.graphToYamlObject(normalized, registry);
    const yamlText = jsyaml.dump(payload, { noRefs: true });
    const saved = await saveTextFile(yamlText, (normalized.project || "graph") + ".yaml", "graph-yaml-save");
    if (saved) GraphView.showToast("Graph saved.", "success");
  });

  document.getElementById("prompts-btn").addEventListener("click", async () => {
    const { errors } = GraphValidate.validateGraph(normalized, registry);
    if (errors.length) {
      alert(
        `Cannot generate prompts -- graph has ${errors.length} validation error(s). ` +
        `Fix these first (see Save for the full list):\n\n` + errors.slice(0, 10).join("\n")
      );
      GraphView.showToast(`Cannot generate prompts -- ${errors.length} validation error(s).`, "error");
      return;
    }
    const manifest = GraphPromptGen.generatePromptManifest(normalized, registry);
    if (!manifest.structure.length && !manifest.prompts.length) {
      alert("Nothing to generate yet -- no nodes with a determinable file path.");
      GraphView.showToast("Nothing to generate yet.", "error");
      return;
    }
    const json = JSON.stringify(manifest, null, 2);
    const saved = await saveTextFile(json, "prompts.json", "graph-prompts-save");
    if (saved) GraphView.showToast(`prompts.json generated (${manifest.prompts.length} prompt(s), ${manifest.structure.length} file(s) in structure).`, "success");
  });

  document.getElementById("new-graph-btn").addEventListener("click", () => {
    const projectName = prompt("New project name:", "my-project");
    if (!projectName) return;
    const backboneId = prompt("Backbone node id:", "app_backbone");
    if (!backboneId) return;
    const protoChoices = Object.keys(registry).join(", ");
    const backboneProto = prompt(`Backbone protocol type (${protoChoices}):`, "entrypoint");
    if (!backboneProto || !registry[backboneProto]) {
      alert("Unknown protocol type — aborted.");
      GraphView.showToast("Unknown protocol type -- aborted.", "error");
      return;
    }
    const nodesById = {};
    nodesById[backboneId] = GraphModel.emptyNodeFor(backboneId, backboneProto, null, registry);
    normalized = { project: projectName, backbone: backboneId, defaultBoundary: "module", nodesById };
    selectedNodeId = backboneId;
    collapsedNodes.clear();
    renderAll();
    GraphView.showToast(`New graph '${projectName}' created.`, "success");
  });

  document.getElementById("file-input").addEventListener("change", (event) => {
    const file = event.target.files[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = (e) => {
      try {
        const parsed = jsyaml.load(e.target.result);
        GraphModel.restoreCustomProtocols(registry, parsed); // any protocol_registry block in this file
        normalized = GraphModel.normalizeGraph(parsed);
        selectedNodeId = null;
        collapsedNodes.clear(); // stale node ids from a previous graph shouldn't linger
        document.getElementById("detail-panel").classList.remove("open");
        renderAll();
        GraphView.showToast(`Loaded '${file.name}'.`, "success");
      } catch (err) {
        document.getElementById("load-error").textContent = "YAML parse error: " + err.message;
        GraphView.showToast("YAML parse error: " + err.message, "error");
      }
    };
    reader.readAsText(file);
  });

  /* ---------------- custom protocol modal ---------------- */

  document.getElementById("add-protocol-btn").addEventListener("click", () => {
    const modal = document.getElementById("protocol-modal");
    modal.innerHTML = GraphView.renderProtocolModalContent(registry);
    GraphView.initCheckboxDropdowns(modal);
    document.getElementById("protocol-modal-backdrop").style.display = "flex";

    document.getElementById("p-cancel").addEventListener("click", () => {
      document.getElementById("protocol-modal-backdrop").style.display = "none";
    });

    document.getElementById("p-save").addEventListener("click", () => {
      const errBox = document.getElementById("p-error");
      try {
        const id = document.getElementById("p-id").value.trim();
        const label = document.getElementById("p-label").value.trim();
        const language = document.getElementById("p-language").value.trim();
        const color = document.getElementById("p-color").value;
        const allowedChildren = Object.keys(registry).filter((p) => document.getElementById(`p-child-${p}`).checked);
        const fields = GraphView.KNOWN_FIELD_OPTIONS.filter((f) => document.getElementById(`p-field-${f}`).checked);
        GraphModel.registerCustomProtocol(registry, id, { label, color, allowedChildren, fields, language });
        document.getElementById("protocol-modal-backdrop").style.display = "none";
        GraphView.showToast(`Custom protocol '${id}' saved.`, "success");
      } catch (e) {
        errBox.textContent = e.message;
        GraphView.showToast(e.message, "error");
      }
    });
  });

  /* ---------------- boot ---------------- */

  async function boot() {
    // Config load happens BEFORE the working registry is cloned from
    // GraphModel.PROTOCOL_REGISTRY, so if protocol-registry.json (or
    // status-colors.json) loaded successfully, the clone -- and every
    // node color drawn afterward -- reflects it, not the JS built-in
    // defaults. If loading fails (e.g. under file://), GraphConfig
    // already logged why and GraphModel's defaults are left in place,
    // so this proceeds identically either way.
    await GraphConfig.loadAndApplyConfig();
    registry = JSON.parse(JSON.stringify(GraphModel.PROTOCOL_REGISTRY));

    try {
      const yamlText = GraphDefault.decodeDefaultGraphYaml();
      const parsed = jsyaml.load(yamlText);
      GraphModel.restoreCustomProtocols(registry, parsed);
      normalized = GraphModel.normalizeGraph(parsed);
      renderAll();
    } catch (e) {
      document.getElementById("load-error").textContent = "Failed to load default graph: " + e.message;
    }
  }
  boot();
})();
