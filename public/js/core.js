// YouFind frontend core.
// This classic script is loaded before page modules so inline handlers keep working.

// ═══════════════════════════════════════════
//  STATE — Global mutable state
// ═══════════════════════════════════════════
let currentPage = localStorage.getItem("youfind-page") || "videos";
let rejectChannelId = null;
let resolvedChannelData = null;
let previewDebounce = null;
let previewRequestSeq = 0;
let previewAbortController = null;
let currentEditingChannelId = null;
let currentEditingTopics = new Set();
let videoOffset = 0;
let isFetchingVideos = false;
let hasMoreVideos = true;
let videoObserver = null;
let prefetchedVideos = null;
let prefetchPromise = null;
let prefetchAbortController = null;
let currentVideoFilter = "";
let videoSearchDebounce = null;
const VIDEO_PAGE_SIZE = 60;
const rejectModal = new bootstrap.Modal(document.getElementById("rejectModal"));
const addChannelModal = new bootstrap.Modal(document.getElementById("addChannelModal"));
const channelTopicsModal = new bootstrap.Modal(document.getElementById("channelTopicsModal"));
const channelDetailModal = new bootstrap.Modal(document.getElementById("channelDetailModal"));

addChannelModal._element.addEventListener("hidden.bs.modal", () => {
  document.getElementById("add-ch-input").value = "";
  document.getElementById("add-ch-preview").classList.add("d-none");
  document.getElementById("add-batch-input").value = "";
  document.getElementById("add-batch-status").innerHTML = "";
  document.getElementById("add-ch-btn").disabled = true;
  resolvedChannelData = null;
});

document.querySelectorAll("[data-page]").forEach((btn) => {
  btn.addEventListener("click", () => {
    navigateTo(btn.dataset.page);
  });
});

// ═══════════════════════════════════════════
//  NAVIGATION & API
// ═══════════════════════════════════════════
function navigateTo(page) {
  currentPage = page;
  localStorage.setItem("youfind-page", page);
  document.querySelectorAll(".page-content").forEach((el) => el.classList.add("d-none"));
  document.getElementById(`page-${page}`)?.classList.remove("d-none");
  document.querySelectorAll("[data-page]").forEach((btn) => {
    btn.classList.toggle("active", btn.dataset.page === page);
  });

  if (page === "videos") loadVideos(true);
  if (page === "channels") loadChannels();
  if (page === "discover") { loadTopics(); populateTopicFilter(); }
  if (page === "related") loadRelatedPage();
  if (page === "settings") loadSettings();
}

// ═══════════════════════════════════════════
//  UTILITIES — Formatting & Toast
// ═══════════════════════════════════════════
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
    setTimeout(() => toast.remove(), 300);
  }, 3500);
}

function formatStatCount(value) {
  const n = Number(value || 0);
  if (n < 1000) return String(n);
  // Compact style: 1 décimale + unité (ex. 11,7k+). Le séparateur décimal est
  // une virgule (fr-FR). Le "+" signale que la valeur est arrondie.
  if (n < 999500) return (n / 1000).toFixed(1).replace(".", ",") + "k+";
  return (n / 1_000_000).toFixed(1).replace(".", ",") + "M+";
}
