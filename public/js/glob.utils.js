// YouFind global frontend utilities.
// Loaded before page modules so classic inline handlers can use these functions.

function formatNumber(n) {
  if (!n) return "0";
  if (n >= 1_000_000) return (n / 1_000_000).toFixed(1) + "M";
  if (n >= 1_000) return (n / 1_000).toFixed(1) + "K";
  return String(n);
}

function formatDuration(sec) {
  if (!sec) return "";
  const h = Math.floor(sec / 3600);
  const m = Math.floor((sec % 3600) / 60);
  const s = sec % 60;
  if (h > 0) return `${h}:${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}`;
  return `${m}:${String(s).padStart(2, "0")}`;
}

function formatDate(d) {
  if (!d) return "";
  const date = new Date(d);
  const now = new Date();
  const diff = now - date;
  const days = Math.floor(diff / 86400000);
  if (days === 0) return "Aujourd'hui";
  if (days === 1) return "Hier";
  if (days < 7) return `Il y a ${days}j`;
  if (days < 30) return `Il y a ${Math.floor(days / 7)}sem`;
  return date.toLocaleDateString("fr-FR", { day: "numeric", month: "short" });
}

function formatStatCount(value) {
  const n = Number(value || 0);
  if (n < 1000) return String(n);
  if (n < 999500) return (n / 1000).toFixed(1).replace(".", ",") + "k+";
  return (n / 1_000_000).toFixed(1).replace(".", ",") + "M+";
}

function escapeHtml(str) {
  if (!str) return "";
  const div = document.createElement("div");
  div.textContent = str;
  return div.innerHTML;
}

function safeImageUrl(value) {
  if (!value) return "";
  try {
    const url = new URL(value, window.location.origin);
    if (url.protocol !== "https:" && url.protocol !== "http:") return "";
    return escapeHtml(url.href);
  } catch {
    return "";
  }
}

function safeYoutubeThumbnailUrl(videoUrl) {
  const videoId = extractVideoId(videoUrl);
  return videoId ? `https://i.ytimg.com/vi/${videoId}/hqdefault.jpg` : "";
}

function safeChannelId(value) {
  return /^[A-Za-z0-9_-]{1,64}$/.test(String(value || "")) ? String(value) : "";
}

function extractVideoId(url) {
  if (!url) return null;
  const patterns = [
    /[?&]v=([\w-]{11})/,
    /youtu\.be\/([\w-]{11})/,
    /youtube\.com\/embed\/([\w-]{11})/,
    /youtube\.com\/shorts\/([\w-]{11})/,
    /youtube\.com\/v\/([\w-]{11})/,
  ];
  for (const pattern of patterns) {
    const match = url.match(pattern);
    if (match) return match[1];
  }
  const fallback = url.split("/").pop();
  return fallback?.length === 11 ? fallback : null;
}

function escapeJs(str) {
  if (!str) return "";
  return str.replace(/\\/g, "\\\\").replace(/'/g, "\\'").replace(/"/g, '\\"').replace(/\n/g, "\\n").replace(/\r/g, "\\r").replace(/`/g, "\\`");
}

function escapeInlineJs(str) {
  if (!str) return "";
  const jsSafe = str.replace(/\\/g, "\\\\").replace(/'/g, "\\'").replace(/\n/g, "\\n").replace(/\r/g, "\\r").replace(/`/g, "\\`");
  return jsSafe.replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

function downloadTextFile(content, filename, mime) {
  const blob = new Blob([content], { type: mime });
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = filename;
  document.body.appendChild(link);
  link.click();
  link.remove();
  setTimeout(() => URL.revokeObjectURL(url), FRONTEND_DELAYS.DOWNLOAD_REVOKE_MS);
}

// Prevent CSV formula injection (Excel interprets =, +, -, @ as formulas).
function csvEscape(value) {
  let text = String(value ?? "");
  if (/^[=+\-@]/.test(text)) text = `'${text}`;
  return /[",\n\r]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}

function showToast(message, type = "info") {
  const container = document.getElementById("toast-container");
  const colors = {
    success: "var(--accent-green)",
    error: "var(--accent-red)",
    info: "var(--purple-400)",
  };
  const icons = {
    success: "bi-check-circle-fill",
    error: "bi-exclamation-circle-fill",
    info: "bi-info-circle-fill",
  };

  const toast = document.createElement("div");
  toast.className = "glass-card-dark px-3 py-2";
  toast.style.cssText = `border-left: 3px solid ${colors[type]}; min-width: 200px; max-width:360px; animation: slideIn 0.3s ease; pointer-events:auto;`;
  toast.innerHTML = `
    <div class="d-flex align-items-center gap-2">
      <i class="bi ${icons[type]}" style="color:${colors[type]}"></i>
      <span style="font-size:0.82rem">${escapeHtml(message)}</span>
    </div>
  `;
  container.appendChild(toast);
  setTimeout(() => {
    toast.style.opacity = "0";
    toast.style.transition = "opacity 0.3s";
    setTimeout(() => toast.remove(), FRONTEND_DELAYS.TOAST_FADE_MS);
  }, FRONTEND_DELAYS.TOAST_DURATION_MS);
}
