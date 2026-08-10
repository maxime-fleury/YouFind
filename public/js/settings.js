// YouFind settings page.

// For embedding user data in onclick="..." attributes (double context: HTML + JS):
// 1. JS-escape first, then HTML-escape the attribute context.
function escapeInlineJs(str) {
  if (!str) return "";
  const jsSafe = str.replace(/\\/g, "\\\\").replace(/'/g, "\\'").replace(/\n/g, "\\n").replace(/\r/g, "\\r").replace(/`/g, "\\`");
  return jsSafe.replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

async function loadLLMHealth() {
  const badge = document.getElementById("llm-badge");
  const healthDiv = document.getElementById("llm-health");
  try {
    const status = await api("/llm-status");
    const providerLabel = { ollama: "Ollama", lmstudio: "LM Studio", openrouter: "OpenRouter" };
    const name = providerLabel[status.provider] || status.provider;
    let html = "";
    if (status.ok) {
      const models = status.models?.length ? ` (${status.models[0]})` : "";
      html = `<span class="status-badge validated"><i class="bi bi-check-circle"></i> ${name}${models}</span>`;
    } else {
      html = `<span class="status-badge rejected"><i class="bi bi-x-circle"></i> ${name} indisponible</span>`;
    }
    if (badge) badge.innerHTML = html;
    if (healthDiv) healthDiv.innerHTML = html;
  } catch {
    const html = `<span class="status-badge rejected"><i class="bi bi-x-circle"></i> LLM inconnu</span>`;
    if (badge) badge.innerHTML = html;
    if (healthDiv) healthDiv.innerHTML = html;
  }
}

const SETTINGS_KEYS = [
  "llm_provider",
  "ollama_url", "ollama_model",
  "lmstudio_url", "lmstudio_model",
  "openrouter_key", "openrouter_model",
  "llm_concurrency",
];

let settingsLoading = false;

function setSettingsSaveState(message, type = "info") {
  const state = document.getElementById("settings-save-state");
  if (!state) return;
  state.className = `settings-save-state ${type}`;
  state.innerHTML = type === "success"
    ? `<i class="bi bi-check-circle-fill"></i> ${escapeHtml(message)}`
    : type === "error"
      ? `<i class="bi bi-exclamation-circle-fill"></i> ${escapeHtml(message)}`
      : `<span class="spinner-glass spinner-glass-sm"></span> ${escapeHtml(message)}`;
}

function updateSecretState(key, configured) {
  const input = document.getElementById(`set-${key}`);
  const clear = input?.parentElement?.querySelector(".secret-clear");
  if (!input) return;
  input.dataset.configured = configured ? "true" : "false";
  input.placeholder = configured ? "Clé enregistrée · saisir pour remplacer" : "sk-or-...";
  clear?.classList.toggle("d-none", !configured && !input.value);
}

function toggleSecret(id, button) {
  const input = document.getElementById(id);
  if (!input) return;
  const visible = input.type === "text";
  input.type = visible ? "password" : "text";
  button.innerHTML = `<i class="bi bi-eye${visible ? "" : "-slash"}"></i>`;
}

function clearSecret(id) {
  const input = document.getElementById(id);
  if (!input) return;
  input.value = "";
  input.dataset.clear = "true";
  input.dataset.configured = "false";
  input.parentElement?.querySelector(".secret-clear")?.classList.add("d-none");
  setSettingsSaveState("La clé sera supprimée après l'enregistrement.", "info");
}

async function loadSettings() {
  if (settingsLoading) return;
  settingsLoading = true;
  setSettingsSaveState("Chargement des réglages...", "info");
  try {
    const settings = await api("/settings");
    for (const key of SETTINGS_KEYS) {
      const el = document.getElementById(`set-${key}`);
      if (!el) continue;
      if (el.dataset.secret === "true") {
        el.value = "";
        el.dataset.clear = "false";
        updateSecretState(key, Boolean(settings[`${key}_configured`]));
      } else {
        el.value = settings[key] ?? "";
      }
    }
    toggleLLMFields();
    updateSettingsStatus(settings);
    await loadLLMHealth();
    setSettingsSaveState("Réglages chargés", "success");
  } catch (err) {
    console.error("[loadSettings]", err);
    setSettingsSaveState("Impossible de charger les réglages", "error");
    showToast("Erreur de chargement des réglages", "error");
  } finally {
    settingsLoading = false;
  }
}

function updateSettingsStatus(settings = {}) {
  const status = document.getElementById("settings-status");
  if (!status) return;
  const providerLabel = { ollama: "Ollama", lmstudio: "LM Studio", openrouter: "OpenRouter" };
  const provider = providerLabel[settings.llm_provider] || settings.llm_provider || "LLM";
  status.innerHTML = `
    <div class="settings-status-row"><span><i class="bi bi-robot"></i> Moteur LLM</span><strong>${escapeHtml(provider)}</strong></div>
  `;
}

function toggleLLMFields() {
  const provider = document.getElementById("set-llm_provider")?.value || "ollama";
  document.getElementById("ollama-fields")?.classList.toggle("d-none", provider !== "ollama");
  document.getElementById("lmstudio-fields")?.classList.toggle("d-none", provider !== "lmstudio");
  document.getElementById("openrouter-fields")?.classList.toggle("d-none", provider !== "openrouter");
  const hint = document.getElementById("provider-hint");
  if (hint) {
    hint.innerHTML = provider === "openrouter"
      ? '<i class="bi bi-cloud"></i> Les prompts seront envoyés à OpenRouter et peuvent consommer des crédits.'
      : '<i class="bi bi-shield-check"></i> Les données restent sur cet ordinateur.';
  }
}

async function testLLMConnection() {
  const button = document.getElementById("settings-test-btn");
  if (button) { button.disabled = true; button.innerHTML = '<span class="spinner-glass spinner-glass-sm"></span> Test...'; }
  try {
    const status = await api("/llm-status", { timeout: 12000 });
    updateSettingsStatus({ llm_provider: status.provider });
    if (status.ok) showToast(`${status.provider || "LLM"} est disponible`, "success");
    else showToast(status.error || "Le LLM est indisponible", "error");
    return status;
  } catch (err) {
    showToast("Test impossible : " + err.message, "error");
  } finally {
    if (button) { button.disabled = false; button.innerHTML = '<i class="bi bi-plug"></i> Tester la connexion'; }
  }
}

async function saveSettings() {
  const body = { clear_secrets: [] };
  for (const key of SETTINGS_KEYS) {
    const el = document.getElementById(`set-${key}`);
    if (!el) continue;
    if (el.dataset.secret === "true") {
      if (el.dataset.clear === "true") body.clear_secrets.push(key);
      else if (el.value.trim()) body[key] = el.value.trim();
    } else {
      body[key] = el.value.trim();
    }
  }

  const saveButton = document.getElementById("settings-save-btn");
  if (saveButton) { saveButton.disabled = true; saveButton.innerHTML = '<span class="spinner-glass spinner-glass-sm"></span> Enregistrement...'; }
  setSettingsSaveState("Enregistrement...", "info");
  try {
    const result = await api("/settings", { method: "POST", body: JSON.stringify(body) });
    for (const key of ["openrouter_key"]) {
      const input = document.getElementById(`set-${key}`);
      if (input) {
        input.value = "";
        input.dataset.clear = "false";
        updateSecretState(key, Boolean(result.settings?.[`${key}_configured`]));
      }
    }
    updateSettingsStatus(result.settings);
    toggleLLMFields();
    await loadLLMHealth();
    setSettingsSaveState("Réglages enregistrés", "success");
    showToast("Réglages enregistrés", "success");
  } catch (err) {
    setSettingsSaveState("Échec de l'enregistrement", "error");
    showToast("Erreur : " + err.message, "error");
  } finally {
    if (saveButton) { saveButton.disabled = false; saveButton.innerHTML = '<i class="bi bi-check-lg"></i> Enregistrer'; }
  }
}

const style = document.createElement("style");
style.textContent = `
  @keyframes slideIn {
    from { transform: translateX(100px); opacity: 0; }
    to { transform: translateX(0); opacity: 1; }
  }
`;
document.head.appendChild(style);
