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
