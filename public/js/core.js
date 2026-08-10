// YouFind frontend core.
// This classic script is loaded before page modules so inline handlers keep working.

// ═══════════════════════════════════════════
//  STATE — Global mutable state
// ═══════════════════════════════════════════
let currentPage = localStorage.getItem(PAGE_STORAGE_KEY) || DEFAULT_PAGE;
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
  if (!PAGE_NAMES.includes(page)) return;
  currentPage = page;
  localStorage.setItem(PAGE_STORAGE_KEY, page);
  document.querySelectorAll(".page-content").forEach((el) => el.classList.add("d-none"));
  document.getElementById(`page-${page}`)?.classList.remove("d-none");
  document.querySelectorAll("[data-page]").forEach((btn) => {
    btn.classList.toggle("active", btn.dataset.page === page);
  });

  if (page === APP_PAGES.VIDEOS) loadVideos(true);
  if (page === APP_PAGES.CHANNELS) loadChannels();
  if (page === APP_PAGES.DISCOVER) { loadTopics(); populateTopicFilter(); }
  if (page === APP_PAGES.RELATED) loadRelatedPage();
  if (page === APP_PAGES.SETTINGS) loadSettings();
}
