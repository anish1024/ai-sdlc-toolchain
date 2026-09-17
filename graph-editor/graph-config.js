/**
 * graph-config.js — DATA loader (browser-only), same category as
 * default-graph.js: not Model, not View, just "how does external
 * configuration get into the app."
 *
 * Two sibling JSON files hold the two sets of colors/definitions that
 * were previously hardcoded constants in graph-model.js:
 *   - status-colors.json     status -> hex color (and status ORDER, via key order)
 *   - protocol-registry.json full protocol definitions (label, color, allowedChildren, fields, leafCapable, language)
 *
 * Editing either file and reloading the page is now enough to
 * reconfigure colors / protocols — no code change needed.
 *
 * Why fetch() here works but default-graph.js deliberately avoids it:
 * default-graph.js needs to work from a raw file:// double-click with
 * zero setup, so it embeds its data as base64 rather than fetching a
 * sibling file (blocked under file://). Config is different — it's an
 * optional customization, not core functionality, so it's fine for it
 * to only take effect when served over http(s); under file:// these
 * fetches will fail silently and GraphModel's built-in defaults (the
 * same values these two JSON files ship with) are used instead. This
 * file logs a console.warn when that happens, but never throws — a
 * missing/broken config file should degrade to defaults, not break
 * the app.
 */

async function loadJsonConfig(path) {
  try {
    const res = await fetch(path);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return await res.json();
  } catch (e) {
    console.warn(`graph-config: could not load '${path}' (${e.message}) -- using GraphModel's built-in defaults.`);
    return null;
  }
}

/**
 * Loads both config files and applies whichever loaded successfully.
 * Always resolves (never rejects) — a config-loading failure is not
 * fatal, it just means defaults stay in effect for that piece.
 */
async function loadAndApplyConfig() {
  const [statusColors, protocolRegistry] = await Promise.all([
    loadJsonConfig("status-colors.json"),
    loadJsonConfig("protocol-registry.json"),
  ]);
  if (statusColors) GraphModel.applyStatusConfig(statusColors);
  if (protocolRegistry) GraphModel.applyProtocolRegistryConfig(protocolRegistry);
}

const GraphConfig = { loadAndApplyConfig, loadJsonConfig };

if (typeof window !== "undefined") {
  window.GraphConfig = GraphConfig;
}
