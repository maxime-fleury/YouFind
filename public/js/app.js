let currentPage = localStorage.getItem("youfind-page") || "videos";
let rejectChannelId = null;
let resolvedChannelData = null;
let previewDebounce = null;
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

async function api(path, opts = {}) {
  const { timeout: timeoutMs, signal: userSignal, ...fetchOpts } = opts;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs || 60000);
  try {
    const res = await fetch(`/api${path}`, {
      headers: { "Content-Type": "application/json" },
      signal: userSignal || controller.signal,
      ...fetchOpts,
    });
    if (!res.ok) {
      const text = await res.text();
      let err;
      try { err = JSON.parse(text).error || text; } catch { err = text; }
      if (res.status === 422) {
        console.error(`[API] 422 Unprocessable Entity on ${path}:`, text);
        throw new Error("Requete invalide (422). Verifiez la cle API ou les parametres.");
      }
      throw new Error(err || `HTTP ${res.status}`);
    }
    return res.json();
  } finally {
    clearTimeout(timer);
  }
}

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
  return Number(value || 0).toLocaleString("fr-FR");
}

function renderStatsLoading(container) {
  container.innerHTML = `
    <div class="col-12">
      <section class="stats-overview stats-overview-loading" aria-label="Chargement des statistiques">
        <div class="stats-overview-head">
          <div class="stats-heading-skeleton"></div>
          <div class="stats-total-skeleton"></div>
        </div>
        <div class="stats-grid">
          ${Array.from({ length: 6 }, () => '<div class="stat-card stat-card-skeleton"><span></span><b></b><i></i></div>').join("")}
        </div>
      </section>
    </div>`;
}

async function loadStats() {
  const container = document.getElementById("stats-bar");
  if (!container) return;
  if (!container.dataset.loaded) renderStatsLoading(container);

  try {
    const stats = await api("/stats");
    const validated = Number(stats.validated_channels) || 0;
    const pending = Number(stats.pending_channels) || 0;
    const rejected = Number(stats.rejected_channels) || 0;
    const toReview = pending + rejected;
    const ratio = Number(stats.validated_channel_ratio) || 0;
    const total = Number(stats.total_channels) || validated + toReview;
    const ratioWidth = Math.min(100, Math.max(0, ratio));

    container.innerHTML = `
      <div class="col-12">
        <section class="stats-overview" aria-label="Vue d'ensemble des statistiques">
          <div class="stats-overview-head">
            <div>
              <span class="stats-eyebrow"><i class="bi bi-bar-chart-line-fill"></i> Tableau de bord</span>
              <h2 class="stats-overview-title">Vue d'ensemble</h2>
              <p class="stats-overview-subtitle">Un aperçu rapide de ta bibliothèque et de ta file de tri.</p>
            </div>
            <div class="stats-total-pill">
              <span class="stats-total-icon"><i class="bi bi-collection-play-fill"></i></span>
              <span><strong>${formatStatCount(total)}</strong> chaînes suivies</span>
            </div>
          </div>

          <div class="stats-grid">
            <article class="stat-card stats-card--validated">
              <div class="stats-card-top"><span class="stats-card-icon"><i class="bi bi-check2-circle"></i></span><span class="stats-card-kicker">Bibliothèque</span></div>
              <div class="stat-value">${formatStatCount(validated)}</div>
              <div class="stat-label">Chaînes validées</div>
              <div class="stat-detail">Dans ton feed vidéo</div>
            </article>
            <article class="stat-card stats-card--pending">
              <div class="stats-card-top"><span class="stats-card-icon"><i class="bi bi-hourglass-split"></i></span><span class="stats-card-kicker">À décider</span></div>
              <div class="stat-value">${formatStatCount(pending)}</div>
              <div class="stat-label">En attente</div>
              <div class="stat-detail">Prêtes pour ton tri</div>
            </article>
            <article class="stat-card stats-card--rejected">
              <div class="stats-card-top"><span class="stats-card-icon"><i class="bi bi-x-circle"></i></span><span class="stats-card-kicker">Historique</span></div>
              <div class="stat-value">${formatStatCount(rejected)}</div>
              <div class="stat-label">Rejetées</div>
              <div class="stat-detail">Exclues de la sélection</div>
            </article>
            <article class="stat-card stat-card-ratio stats-card--ratio">
              <div class="stats-card-top"><span class="stats-card-icon"><i class="bi bi-pie-chart-fill"></i></span><span class="stats-card-kicker">Progression</span></div>
              <div class="stat-value">${ratio.toFixed(1)}%</div>
              <div class="stat-label">Validées / (rejetées + attente)</div>
              <div class="stat-detail">${formatStatCount(validated)} validées sur ${formatStatCount(toReview)} à traiter</div>
              <div class="stat-progress" role="progressbar" aria-label="Ratio des chaînes validées sur les chaînes rejetées et en attente" aria-valuenow="${ratio}" aria-valuemin="0" aria-valuemax="100"><div style="width:${ratioWidth}%"></div></div>
            </article>
            <article class="stat-card stats-card--topics">
              <div class="stats-card-top"><span class="stats-card-icon"><i class="bi bi-bookmark-star-fill"></i></span><span class="stats-card-kicker">Organisation</span></div>
              <div class="stat-value">${formatStatCount(stats.total_topics)}</div>
              <div class="stat-label">Topics</div>
              <div class="stat-detail">Pour classer tes chaînes</div>
            </article>
            <article class="stat-card stats-card--quota" id="quota-stat">
              <div class="stats-card-top"><span class="stats-card-icon"><i class="bi bi-lightning-charge-fill"></i></span><span class="stats-card-kicker">YouTube API</span></div>
              <div class="stat-value" id="quota-value">--</div>
              <div class="stat-label">Quota utilisé</div>
              <div class="stat-detail">Requêtes consommées aujourd'hui</div>
              <div class="stat-progress" aria-hidden="true"><div id="quota-bar" style="width:0%"></div></div>
            </article>
          </div>
        </section>
      </div>`;
    container.dataset.loaded = "true";
    loadQuota();
  } catch (err) {
    console.error("Failed to load stats:", err);
    delete container.dataset.loaded;
    container.innerHTML = `
      <div class="col-12">
        <div class="stats-error" role="alert">
          <span class="stats-error-icon"><i class="bi bi-bar-chart-line"></i></span>
          <div><strong>Statistiques indisponibles</strong><p>Impossible de récupérer les chiffres pour le moment.</p></div>
          <button class="btn btn-sm-glass" onclick="loadStats()"><i class="bi bi-arrow-clockwise"></i> Réessayer</button>
        </div>
      </div>`;
  }
}

function renderVideoCard(v, seenSet) {
  const seenClass = seenSet.has(v.url) ? "seen" : "";
  const thumbnailUrl = safeImageUrl(v.thumbnail);
  const fallbackThumbnailUrl = safeYoutubeThumbnailUrl(v.url);
  const thumbnail = thumbnailUrl
    ? `<img src="${thumbnailUrl}" alt="" loading="lazy"${fallbackThumbnailUrl ? ` onerror="this.onerror=null;this.src='${fallbackThumbnailUrl}'"` : ""}>`
    : fallbackThumbnailUrl
      ? `<img src="${fallbackThumbnailUrl}" alt="" loading="lazy">`
      : "";
  return `
    <div class="col-sm-6 col-md-4 col-xl-3">
      <div class="video-card h-100 ${seenClass}" data-video-url="${escapeHtml(v.url)}" onclick="playVideo('${escapeInlineJs(v.url)}')" title="${seenClass ? 'Déjà vu' : ''}">
        <div class="thumb-wrap">
            ${thumbnail}
            <div class="play-overlay" aria-hidden="true"><i class="bi bi-play-circle-fill"></i></div>
            ${seenClass ? `<span class="seen-badge"><i class="bi bi-check-circle-fill"></i> Vu</span>` : ""}
            <span class="views-badge"><i class="bi bi-eye"></i> ${formatNumber(v.vues)}</span>
            ${v.duration ? `<span class="duration-badge">${formatDuration(v.duration)}</span>` : ""}
          </div>
        <div class="card-body">
          <div class="video-title">
            <span>${escapeHtml(v.titre)}</span>
          </div>
          <div class="video-meta">
            <i class="bi bi-person-circle"></i>
            ${escapeHtml(v.channel_nom || "")}
            <span>·</span>
            <i class="bi bi-clock"></i>
            ${formatDate(v.date_pub)}
          </div>
        </div>
      </div>
    </div>`;
}

function showVideoSkeletons(count) {
  const container = document.getElementById("videos-loading");
  container.innerHTML = Array.from({ length: count }, () => `
    <div class="col-sm-6 col-md-4 col-xl-3">
      <div class="video-card h-100" style="background: transparent; border: none; box-shadow: none; pointer-events: none;">
        <div class="thumb-wrap" style="padding-top: 0; aspect-ratio: 16/9;">
          <div class="skeleton" style="position: absolute; inset: 0; border-radius: 14px 14px 0 0;"></div>
        </div>
        <div class="card-body">
          <div class="skeleton mb-2" style="height: 14px; width: 92%;"></div>
          <div class="skeleton mb-3" style="height: 14px; width: 64%;"></div>
          <div class="skeleton" style="height: 12px; width: 42%;"></div>
        </div>
      </div>
    </div>
  `).join("");
  container.classList.remove("d-none");
}

function hideVideoSkeletons() {
  const container = document.getElementById("videos-loading");
  if (container) container.classList.add("d-none");
}

function debounceVideoSearch() {
  clearTimeout(videoSearchDebounce);
  videoSearchDebounce = setTimeout(() => loadVideos(true), 300);
}

async function loadVideos(reset = true) {
  const grid = document.getElementById("videos-grid");
  const topicFilter = document.getElementById("video-topic-filter")?.value || "";
  const sort = document.getElementById("video-sort")?.value || "newest";
  const search = document.getElementById("video-search")?.value.trim() || "";

  if (reset) {
    videoOffset = 0;
    hasMoreVideos = true;
    isFetchingVideos = false;
    prefetchedVideos = null;
    prefetchPromise = null;
    if (prefetchAbortController) {
      prefetchAbortController.abort();
      prefetchAbortController = null;
    }
    currentVideoFilter = `${topicFilter}:${sort}:${search}`;
    if (videoObserver) {
      videoObserver.disconnect();
      videoObserver = null;
    }
    grid.innerHTML = "";
    document.getElementById("videos-empty")?.classList.add("d-none");
    showVideoSkeletons(12);
  }

  // Filter/sort/search changed mid-stream: discard stale prefetch and restart
  if (currentVideoFilter !== `${topicFilter}:${sort}:${search}`) {
    return loadVideos(true);
  }

  if (isFetchingVideos || !hasMoreVideos) return;
  isFetchingVideos = true;

  // Hide empty state and remove any existing end-of-feed message before fetching
  document.getElementById("videos-empty")?.classList.add("d-none");
  document.getElementById("video-end-message")?.remove();

  let url = `/videos?limit=${VIDEO_PAGE_SIZE}&offset=${videoOffset}&sort=${sort}`;
  if (topicFilter) url += `&topic=${topicFilter}`;
  if (search) url += `&q=${encodeURIComponent(search)}`;

  try {
    // Use prefetched page if available, otherwise fetch live
    let videos = prefetchedVideos;
    if (!videos) {
      videos = await api(url);
    }
    prefetchedVideos = null;
    hideVideoSkeletons();

    if (reset && videos.length === 0) {
      document.getElementById("videos-empty")?.classList.remove("d-none");
      return;
    }

    const seenSet = getSeenVideos();
    const html = videos.map((v) => renderVideoCard(v, seenSet)).join("");

    if (reset) grid.innerHTML = html;
    else grid.insertAdjacentHTML("beforeend", html);

    videoOffset += videos.length;

    if (videos.length < VIDEO_PAGE_SIZE) {
      hasMoreVideos = false;
      grid.insertAdjacentHTML("beforeend", '<div id="video-end-message" class="col-12 text-center py-4 text-muted"><small>Fin des vidéos</small></div>');
    } else {
      ensureVideoScrollTrigger(grid);
      // Prefetch the next page in the background
      prefetchNextPage(topicFilter, search);
    }
  } catch (err) {
    showToast("Erreur lors du chargement des vidéos: " + err.message, "error");
  } finally {
    hideVideoSkeletons();
    isFetchingVideos = false;
  }
}

function prefetchNextPage(topicFilter, search) {
  if (prefetchedVideos || prefetchPromise) return; // already cached or in flight
  const nextOffset = videoOffset;
  const sort = document.getElementById("video-sort")?.value || "newest";
  let url = `/videos?limit=${VIDEO_PAGE_SIZE}&offset=${nextOffset}&sort=${sort}`;
  if (topicFilter) url += `&topic=${topicFilter}`;
  if (search) url += `&q=${encodeURIComponent(search)}`;
  prefetchAbortController = new AbortController();
  prefetchPromise = api(url, { signal: prefetchAbortController.signal })
    .then((data) => {
      if (Array.isArray(data)) {
        prefetchedVideos = data;
      }
    })
    .catch(() => {
      prefetchedVideos = null;
    })
    .finally(() => {
      prefetchPromise = null;
      prefetchAbortController = null;
    });
}

function ensureVideoScrollTrigger(grid) {
  let trigger = document.getElementById("video-scroll-trigger");
  if (!trigger) {
    grid.insertAdjacentHTML("beforeend", '<div id="video-scroll-trigger" class="col-12 py-3"></div>');
    trigger = document.getElementById("video-scroll-trigger");
    videoObserver = new IntersectionObserver(
      (entries) => {
        if (entries[0].isIntersecting) loadVideos(false);
      },
      { rootMargin: "400px" }
    );
  }
  // Move trigger to the end of the grid so it observes the latest page
  grid.appendChild(trigger);
  videoObserver.observe(trigger);
}

let _allChannels = [];

async function loadChannels() {
  const list = document.getElementById("channels-list");
  const savedScrollY = window.scrollY;
  const listScrollTop = list.scrollTop;
  list.innerHTML = '<div class="text-center py-4"><div class="spinner-glass"></div></div>';
  document.getElementById("channel-search").value = "";

  try {
    const filter = document.getElementById("channel-filter").value;
    const params = new URLSearchParams({ include: "topics,preview" });
    if (filter) params.set("status", filter);
    _allChannels = await api(`/channels?${params.toString()}`);
    renderChannels();
    requestAnimationFrame(() => {
      window.scrollTo(0, savedScrollY);
      list.scrollTop = listScrollTop;
    });
  } catch (err) {
    console.error("[loadChannels]", err);
    list.innerHTML = '<div class="empty-state"><i class="bi bi-exclamation-triangle"></i><h5>Erreur de chargement</h5><p>' + escapeHtml(err.message) + '</p></div>';
  }
}

function fuzzyMatch(text, query) {
  if (!query) return { match: true, score: 1 };
  const lower = text.toLowerCase();
  const q = query.toLowerCase();
  let qi = 0;
  let prev = -2;
  let score = 0;
  for (let i = 0; i < lower.length && qi < q.length; i++) {
    if (lower[i] === q[qi]) {
      if (i === prev + 1) score += 3;
      else score += 1;
      prev = i;
      qi++;
    }
  }
  return { match: qi >= q.length, score };
}

function filterChannels() {
  const q = document.getElementById("channel-search").value.trim();
  renderChannels(q);
}

function renderChannels(searchQuery) {
  const list = document.getElementById("channels-list");

  let channels = _allChannels;
  if (searchQuery) {
    const results = channels.map((ch) => ({ ch, ...fuzzyMatch(ch.nom, searchQuery) })).filter((r) => r.match);
    results.sort((a, b) => b.score - a.score);
    channels = results.map((r) => r.ch);
  }

  if (channels.length === 0) {
    list.innerHTML = `
      <div class="empty-state">
        <i class="bi bi-search"></i>
        <h5>Aucun resultat</h5>
        <p>${searchQuery ? 'Aucune chaine ne correspond a "' + escapeHtml(searchQuery) + '".' : 'Aucune chaine.'}</p>
      </div>`;
    return;
  }

  const topicsPromise = api("/topics");

  list.innerHTML = channels
    .map(
      (ch) => `
      <div class="channel-card mb-3" id="ch-${ch.id}">
        <div class="ch-avatar" style="cursor:pointer" onclick="openChannelDetail(${ch.id})">
          ${ch.thumbnail ? `<img src="${safeImageUrl(ch.thumbnail)}" alt="">` : escapeHtml(ch.nom.charAt(0).toUpperCase())}
        </div>
        <div class="ch-info">
          <div class="d-flex align-items-center gap-2">
            <a href="javascript:void(0)" onclick="openChannelDetail(${ch.id})" class="ch-name" style="text-decoration:none">${escapeHtml(ch.nom)} <i class="bi bi-box-arrow-up-right" style="font-size:0.6rem;opacity:0.4"></i></a>
            <span class="status-badge ${ch.status}">${ch.status}</span>
            ${ch.llm_score != null ? `<span class="llm-score ${ch.llm_score >= 70 ? "high" : ch.llm_score >= 40 ? "medium" : "low"}">${ch.llm_score}/100</span>` : ""}
          </div>
          <div class="ch-meta">
            <span><i class="bi bi-people"></i> ${formatNumber(ch.subscriber_count)} abonnes</span>
            <span><i class="bi bi-calendar3"></i> ${formatDate(ch.date_ajout)}</span>
          </div>
          ${ch.llm_summary ? `<div class="llm-summary">${escapeHtml(ch.llm_summary)}</div>` : ""}
          ${ch.raison_rejet ? `<div class="mt-1" style="font-size:0.78rem;color:var(--accent-red)"><i class="bi bi-x-circle"></i> ${escapeHtml(ch.raison_rejet)}</div>` : ""}
          <div class="d-flex align-items-center gap-2 mt-2" style="flex-wrap:wrap">
            <div id="ch-topics-${ch.id}"></div>
            ${ch.status === "pending" ? `<button class="btn btn-sm-glass btn-sm ms-auto" onclick="scoreSingle('${safeChannelId(ch.channel_id)}', ${ch.id})" title="Score LLM"><i class="bi bi-stars"></i> Score</button>` : ""}
          </div>
          ${ch.status === "pending" ? `<div class="mt-2" id="ch-preview-${ch.id}"><div class="spinner-glass"></div></div>` : ""}
        </div>
        <div class="ch-actions">
          ${
            ch.status === "pending"
              ? `<div class="ch-actions-row">
              <button class="btn btn-success-glass btn-sm" onclick="validateChannel(${ch.id})" title="Valider">
                <i class="bi bi-check-lg"></i> Valider
              </button>
              <button class="btn btn-danger-glass btn-sm" onclick="openReject(${ch.id}, '${escapeInlineJs(ch.nom)}')" title="Rejeter">
                <i class="bi bi-x-lg"></i> Rejeter
              </button>
            </div>
            <div class="ch-actions-divider"></div>
            <div class="ch-actions-row">
              <span class="quick-reject-pill" onclick="quickRejectChannel(${ch.id}, 'Anglais / Non Français')">Anglais</span>
              <span class="quick-reject-pill" onclick="quickRejectChannel(${ch.id}, 'Pas interessant, hors topic')">Hors topic</span>
              <span class="quick-reject-pill" onclick="quickRejectChannel(${ch.id}, 'Pas active')">Inactive</span>
            </div>
            <div class="ch-actions-divider"></div>`
              : ch.status === "validated"
                ? `<div class="ch-actions-row">
              <button class="btn btn-danger-glass btn-sm" onclick="openReject(${ch.id}, '${escapeInlineJs(ch.nom)}')" title="Rejeter">
                <i class="bi bi-x-lg"></i> Rejeter
              </button>
            </div>
            <div class="ch-actions-divider"></div>`
                : ""
          }
          <div class="ch-actions-row">
            <button class="btn btn-sm-glass btn-sm" onclick="window.open('https://youtube.com/channel/${safeChannelId(ch.channel_id)}','_blank')" title="Voir sur YouTube">
              <i class="bi bi-youtube"></i> Voir
            </button>
          </div>
        </div>
      </div>`
    )
    .join("");

  if (searchQuery) {
    new Mark(list).mark(searchQuery, {
      element: "mark",
      className: "",
      accuracy: "partially",
      separateWordSearch: false,
    });
  }

  topicsPromise.then((allTopics) => {
    channels.forEach((ch) => {
      const sel = document.getElementById(`topic-select-${ch.id}`);
      if (sel) {
        sel.innerHTML = `<option value="">+ Topic</option>
          ${allTopics.map((t) => `<option value="${t.id}">${escapeHtml(t.nom)}</option>`).join("")}`;
      }
      renderChannelTopicBadges(ch.id, ch.topics || [], ch.nom);
      if (ch.status === "pending") renderChannelPreview(ch.id, ch.preview_videos || []);
    });
  });
}

let isDiscovering = false;

function updateDiscoverInputState() {
  const input = document.getElementById("discover-input");
  const clearButton = document.getElementById("discover-input-clear");
  if (!input) return;
  clearButton?.classList.toggle("d-none", !input.value.trim() || isDiscovering);
}

function clearDiscoveryInput() {
  const input = document.getElementById("discover-input");
  if (!input || isDiscovering) return;
  input.value = "";
  input.focus();
  updateDiscoverInputState();
}

function useDiscoverySuggestion(topic) {
  const input = document.getElementById("discover-input");
  if (!input || isDiscovering) return;
  input.value = topic;
  updateDiscoverInputState();
  runDiscovery();
}

async function loadTopics() {
  const grid = document.getElementById("topics-grid");
  const count = document.getElementById("topics-count");
  if (!grid) return;
  grid.innerHTML = '<div class="topics-loading"><span class="spinner-glass"></span> Chargement des topics...</div>';
  try {
    const topics = await api("/topics");
    if (count) count.innerHTML = `<i class="bi bi-tag"></i> ${topics.length} topic${topics.length === 1 ? "" : "s"}`;

    if (!topics.length) {
      grid.innerHTML = `
        <div class="topics-empty">
          <i class="bi bi-bookmark-heart"></i>
          <div><strong>Aucun topic sauvegardé</strong><p class="mb-0">Enregistre une recherche pour la retrouver ici.</p></div>
        </div>`;
      return;
    }

    grid.innerHTML = topics.map((t) => `
      <div class="topic-card-modern">
        <button class="topic-card-main" type="button" onclick="discoverTopic('${escapeInlineJs(t.nom)}')" title="Explorer ${escapeHtml(t.nom)}">
          <span class="topic-card-icon"><i class="bi bi-hash"></i></span>
          <span class="topic-card-copy"><strong>${escapeHtml(t.nom)}</strong>${t.description ? `<small>${escapeHtml(t.description)}</small>` : ""}</span>
          <i class="bi bi-arrow-up-right topic-card-arrow"></i>
        </button>
        <button class="topic-card-delete" type="button" onclick="deleteTopic(${t.id})" title="Supprimer ${escapeHtml(t.nom)}" aria-label="Supprimer ${escapeHtml(t.nom)}"><i class="bi bi-trash3"></i></button>
      </div>`).join("");
  } catch (err) {
    console.error("[loadTopics]", err);
    if (count) count.textContent = "Indisponible";
    grid.innerHTML = '<div class="topics-empty error"><i class="bi bi-exclamation-triangle"></i><div><strong>Impossible de charger les topics</strong><p class="mb-0">Réessaie dans un instant.</p></div></div>';
  }
}

function discoverTopic(topicName) {
  const input = document.getElementById("discover-input");
  if (!input) return;
  input.value = topicName;
  navigateTo("discover");
  updateDiscoverInputState();
  runDiscovery();
}

async function addTopic() {
  const input = document.getElementById("discover-input");
  const nom = input?.value.trim();
  if (!nom) return showToast("Saisis un sujet avant de le sauvegarder", "error");

  const button = document.getElementById("discover-save-topic");
  if (button) { button.disabled = true; button.innerHTML = '<span class="spinner-glass spinner-glass-sm"></span> Sauvegarde...'; }
  try {
    await api("/topics", { method: "POST", body: JSON.stringify({ nom, description: "" }) });
    showToast("Topic sauvegardé", "success");
    await loadTopics();
    populateTopicFilter();
  } catch (err) {
    showToast("Impossible de sauvegarder le topic : " + err.message, "error");
  } finally {
    if (button) { button.disabled = false; button.innerHTML = '<i class="bi bi-bookmark-plus"></i> Garder le topic'; }
  }
}

async function deleteTopic(id) {
  if (!confirm("Supprimer ce topic ?")) return;
  try {
    await api(`/topics?id=${id}`, { method: "DELETE" });
    showToast("Topic supprimé", "info");
    await loadTopics();
    populateTopicFilter();
  } catch (err) {
    showToast("Impossible de supprimer le topic : " + err.message, "error");
  }
}

function renderDiscoveryResults(channels, currentChannels) {
  const results = document.getElementById("discover-results");
  if (!results) return;
  const byChannelId = new Map((currentChannels || []).map((ch) => [ch.channel_id, ch]));
  const labels = { pending: "En attente", validated: "Validée", rejected: "Rejetée" };

  if (!channels.length) {
    results.innerHTML = `<div class="discover-empty-results"><i class="bi bi-compass"></i><h5>Aucune chaîne trouvée</h5><p>Essaie un sujet plus précis ou une autre formulation.</p></div>`;
    return;
  }

  results.innerHTML = channels.map((ch) => {
    const channelId = safeChannelId(ch.channelId);
    const existing = byChannelId.get(ch.channelId);
    const state = existing?.status || "pending";
    const stateClass = state === "validated" ? "validated" : state === "rejected" ? "rejected" : "pending";
    const action = state === "pending"
      ? `<button class="btn btn-success-glass btn-sm" onclick="event.stopPropagation();validateChannelByYtId('${channelId}')" title="Valider cette chaîne"><i class="bi bi-check-lg"></i><span>Valider</span></button><button class="btn btn-danger-glass btn-sm" onclick="event.stopPropagation();rejectChannelByYtId('${channelId}', '${escapeInlineJs(ch.nom)}')" title="Rejeter cette chaîne"><i class="bi bi-x-lg"></i><span>Rejeter</span></button>`
      : `<span class="discover-processed"><i class="bi bi-${state === "validated" ? "check-circle" : "x-circle"}"></i> ${labels[state]}</span>`;
    return `<article class="discover-result discover-result-modern" id="dr-${channelId}">
      <div class="dr-avatar">${ch.thumbnail ? `<img src="${safeImageUrl(ch.thumbnail)}" alt="Miniature de ${escapeHtml(ch.nom)}" loading="lazy">` : '<i class="bi bi-person"></i>'}</div>
      <div class="dr-info"><div class="dr-title-row"><a href="https://youtube.com/channel/${channelId}" target="_blank" rel="noopener noreferrer" class="dr-name">${escapeHtml(ch.nom)} <i class="bi bi-box-arrow-up-right"></i></a><span class="status-badge ${stateClass}">${labels[state]}</span></div><div class="dr-stats"><i class="bi bi-people"></i> ${formatNumber(ch.subscriberCount)} abonnés <span class="dr-dot">·</span><span>${state === "pending" ? "À trier" : "Déjà traitée"}</span></div></div>
      <div class="dr-actions">${action}</div>
    </article>`;
  }).join("");
}

async function runDiscovery() {
  const input = document.getElementById("discover-input");
  const status = document.getElementById("discover-status");
  const results = document.getElementById("discover-results");
  const badge = document.getElementById("discover-method-badge");
  const submit = document.getElementById("discover-submit");
  const topicQuery = input?.value.trim();
  if (!topicQuery || isDiscovering) {
    if (!topicQuery) showToast("Saisis un sujet à explorer", "error");
    return;
  }

  isDiscovering = true;
  if (submit) { submit.disabled = true; submit.innerHTML = '<span class="spinner-glass spinner-glass-sm"></span> Exploration...'; }
  if (input) input.disabled = true;
  document.getElementById("discover-save-topic")?.setAttribute("disabled", "true");
  updateDiscoverInputState();
  if (badge) badge.innerHTML = '<span class="status-badge pending"><i class="bi bi-search"></i> Recherche en cours</span>';
  if (status) status.innerHTML = '<span class="spinner-glass"></span> Exploration de YouTube en cours...';
  if (results) results.innerHTML = '<div class="discover-loading-grid"><div class="discover-skeleton"></div><div class="discover-skeleton"></div><div class="discover-skeleton"></div></div>';
  document.getElementById("discover-results-subtitle")?.replaceChildren(document.createTextNode(`Recherche de chaînes pour « ${topicQuery} »...`));
  document.getElementById("discover-clear-results")?.classList.add("d-none");

  try {
    const data = await api("/discover", { method: "POST", body: JSON.stringify({ topic: topicQuery }) });
    const methodUsed = data.method === "scraping" ? "Scraping" : "API fallback";
    const channels = Array.isArray(data?.channels) ? data.channels : null;
    if (!channels) throw new Error("Réponse de découverte invalide : aucune liste de chaînes reçue");
    if (badge) badge.innerHTML = data.method === "scraping"
      ? '<span class="status-badge validated"><i class="bi bi-lightning-charge"></i> Scraping gratuit</span>'
      : '<span class="status-badge pending"><i class="bi bi-cloud-download"></i> API fallback</span>';
    if (status) status.innerHTML = `<span class="discover-success"><i class="bi bi-check-circle-fill"></i> ${data.found ?? channels.length} chaîne${(data.found ?? channels.length) === 1 ? "" : "s"} trouvée${(data.found ?? channels.length) === 1 ? "" : "s"} via ${methodUsed}</span>`;
    const currentChannels = await api("/channels").catch(() => []);
    renderDiscoveryResults(channels, currentChannels);
    document.getElementById("discover-results-subtitle")?.replaceChildren(document.createTextNode(`${channels.length} résultat${channels.length === 1 ? "" : "s"} pour « ${topicQuery} »`));
    document.getElementById("discover-clear-results")?.classList.toggle("d-none", channels.length === 0);
    loadStats();
    loadTopics();
    populateTopicFilter();
  } catch (err) {
    if (badge) badge.innerHTML = '<span class="status-badge rejected"><i class="bi bi-x-circle"></i> Échec</span>';
    if (status) status.innerHTML = `<span class="discover-error"><i class="bi bi-exclamation-circle-fill"></i> ${escapeHtml(err.message)}</span>`;
    if (results) results.innerHTML = '<div class="discover-empty-results error"><i class="bi bi-wifi-off"></i><h5>La recherche a échoué</h5><p>Vérifie la connexion puis réessaie.</p></div>';
  } finally {
    isDiscovering = false;
    if (submit) { submit.disabled = false; submit.innerHTML = '<i class="bi bi-compass"></i> Explorer'; }
    if (input) input.disabled = false;
    document.getElementById("discover-save-topic")?.removeAttribute("disabled");
    updateDiscoverInputState();
  }
}

function clearDiscoveryResults() {
  if (isDiscovering) return;
  document.getElementById("discover-results")?.replaceChildren();
  document.getElementById("discover-results-subtitle")?.replaceChildren(document.createTextNode("Lance une recherche pour commencer ton exploration."));
  document.getElementById("discover-clear-results")?.classList.add("d-none");
  document.getElementById("discover-status")?.replaceChildren();
  document.getElementById("discover-method-badge")?.replaceChildren();
}

let isScoreProgressRunning = false;

function updateScoreProgress(data, labelText) {
  const progress = document.getElementById("score-progress");
  const label = document.getElementById("score-progress-label");
  const count = document.getElementById("score-progress-count");
  const bar = document.getElementById("score-progress-bar");
  const detail = document.getElementById("score-progress-detail");
  const track = progress?.querySelector(".score-progress-track");
  if (!progress || !label || !count || !bar || !detail) return;

  const total = Number(data?.total) || 0;
  const completed = Math.min(Number(data?.completed) || 0, total || Number(data?.completed) || 0);
  const percent = total > 0 ? Math.round((completed / total) * 100) : data?.status === "done" ? 100 : 0;
  progress.classList.remove("d-none");
  count.textContent = total > 0 ? `${completed} / ${total}` : "Préparation...";
  bar.style.width = `${percent}%`;
  track?.setAttribute("aria-valuenow", String(percent));

  if (data?.status === "done") {
    label.innerHTML = '<i class="bi bi-check-circle-fill"></i> Scoring terminé';
    detail.textContent = `${data.scored || 0} chaîne${data.scored === 1 ? "" : "s"} scorée${data.scored === 1 ? "" : "s"}${data.failed ? ` · ${data.failed} échec${data.failed === 1 ? "" : "s"}` : ""}`;
    bar.classList.remove("progress-bar-animated");
  } else if (data?.status === "error") {
    label.innerHTML = '<i class="bi bi-exclamation-circle-fill"></i> Scoring interrompu';
    detail.textContent = data.error || "Une erreur est survenue pendant le scoring.";
    bar.classList.remove("progress-bar-animated");
  } else {
    label.innerHTML = `<i class="bi bi-stars"></i> ${escapeHtml(labelText || "Scoring en cours...")}`;
    detail.textContent = data?.current
      ? `Analyse de ${data.current} · ${data.scored || 0} résultat${data.scored === 1 ? "" : "s"} reçu${data.scored === 1 ? "" : "s"}`
      : "Les chaînes sont traitées en parallèle par le LLM...";
    bar.classList.add("progress-bar-animated");
  }
}

async function runScoreJob(endpoint, labelText, successText) {
  if (isScoreProgressRunning) {
    showToast("Un scoring est déjà en cours...", "info");
    return;
  }
  isScoreProgressRunning = true;

  const status = document.getElementById("score-status");
  const buttons = document.querySelectorAll("#page-discover button[onclick^=\"score\"], #page-discover button[onclick^=\"rescore\"]");
  buttons.forEach((button) => { button.disabled = true; });
  status.innerHTML = `<span class="spinner-glass"></span> ${escapeHtml(labelText)}`;
  updateScoreProgress({ status: "running", total: 0, completed: 0, scored: 0 }, labelText);

  let jobId = "";
  let lastStatus = null;
  let failures = 0;
  const deadline = Date.now() + 2 * 60 * 60 * 1000;

  try {
    const started = await api(endpoint, { method: "POST", timeout: 30000 });
    jobId = started.jobId || "";
    if (!jobId) throw new Error("Impossible d'identifier le scoring");

    while (Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 1000));
      let data;
      try {
        data = await api(`/score-status?job=${encodeURIComponent(jobId)}`, { timeout: 30000 });
        failures = 0;
      } catch (err) {
        failures++;
        if (failures >= 10) throw err;
        status.innerHTML = `<span class="text-muted"><span class="spinner-glass"></span> Connexion interrompue — nouvelle tentative (${failures}/10)</span>`;
        continue;
      }
      lastStatus = data;
      updateScoreProgress(data, labelText);

      if (data.status === "done") {
        status.innerHTML = `<span style="color:var(--accent-green)"><i class="bi bi-check-circle"></i> ${successText}: ${data.scored || 0} chaine${data.scored === 1 ? "" : "s"}</span>`;
        loadChannels();
        loadStats();
        return;
      }
      if (data.status === "error") {
        throw new Error(data.error || "Erreur pendant le scoring");
      }
    }

    throw new Error("Le suivi a expiré après deux heures, mais le scoring peut continuer sur le serveur.");
  } catch (err) {
    updateScoreProgress(lastStatus || { status: "error", error: err.message, total: 0, completed: 0, scored: 0 }, labelText);
    status.innerHTML = `<span style="color:var(--accent-red)"><i class="bi bi-exclamation-circle"></i> Erreur: ${escapeHtml(err.message)}</span>`;
  } finally {
    isScoreProgressRunning = false;
    buttons.forEach((button) => { button.disabled = false; });
  }
}

function scoreAll() {
  return runScoreJob("/score-all", "Scoring des chaînes en attente...", "Chaînes scorées");
}

function scoreAllUnscored() {
  return runScoreJob("/score-unscored", "Scoring des chaînes non scorées...", "Chaînes scorées");
}

function rescoreAll() {
  return runScoreJob("/rescore-all", "Rescore de toutes les chaînes...", "Chaînes rescorrées");
}

async function scoreSingle(channelId, elemId) {
  const card = document.getElementById(`ch-${elemId}`);
  const actionsDiv = card?.querySelector(".ch-actions");
  if (actionsDiv) {
    actionsDiv.innerHTML = '<span class="spinner-glass"></span>';
  }

  try {
    const result = await api(`/channels/${elemId}/score`, { method: "POST" });
    if (result.score != null) {
      showToast(`Score: ${result.score}/100`, "success");
    } else {
      showToast("Scoring echoue", "error");
    }
    loadChannels();
  } catch {
    showToast("Erreur de scoring", "error");
  }
}

async function quickRejectChannel(id, raison) {
  try {
    await api(`/channels/${id}/reject`, {
      method: "POST",
      body: JSON.stringify({ raison }),
    });
    showToast("Chaine rejetee: " + raison, "info");
    document.getElementById("channel-filter").value = "pending";
    loadChannels();
    loadStats();
  } catch (err) {
    showToast("Erreur: " + err.message, "error");
  }
}

async function validateChannel(id) {
  await api(`/channels/${id}/validate`, { method: "POST" });
  showToast("Chaine validee !", "success");
  loadChannels();
  loadStats();
}

// Validate/reject from discovery results (by YouTube channel_id, not DB id)
async function validateChannelByYtId(channelId) {
  try {
    const channels = await api(`/channels?status=pending`);
    const ch = channels.find((c) => c.channel_id === channelId);
    if (!ch) return showToast("Chaine introuvable", "error");
    await validateChannel(ch.id);
    // Update the discovery result UI
    const dr = document.getElementById(`dr-${channelId}`);
    if (dr) {
      dr.querySelector(".dr-stats")?.querySelector(".status-badge")?.classList.replace("pending", "validated");
      dr.querySelector(".dr-stats .status-badge") && (dr.querySelector(".dr-stats .status-badge").textContent = "validee");
      dr.querySelector(".dr-actions") && (dr.querySelector(".dr-actions").innerHTML = '<span class="status-badge validated"><i class="bi bi-check-circle"></i></span>');
    }
  } catch (err) {
    showToast("Erreur: " + err.message, "error");
  }
}

async function rejectChannelByYtId(channelId, name) {
  try {
    const channels = await api(`/channels?status=pending`);
    const ch = channels.find((c) => c.channel_id === channelId);
    if (!ch) return showToast("Chaine introuvable", "error");
    openReject(ch.id, name);
  } catch (err) {
    showToast("Erreur: " + err.message, "error");
  }
}

function toggleRejectPill(el) {
  el.classList.toggle("active");
  const pills = document.querySelectorAll("#reject-pills .reject-pill.active");
  const reasons = Array.from(pills).map((p) => p.dataset.reason);
  document.getElementById("reject-reason").value = reasons.join(", ");
}

function openReject(id, name) {
  rejectChannelId = id;
  document.getElementById("reject-channel-name").textContent = name;
  document.getElementById("reject-reason").value = "";
  // Reset all pills
  document.querySelectorAll("#reject-pills .reject-pill").forEach((p) => p.classList.remove("active"));
  rejectModal.show();
}

async function confirmReject() {
  if (!rejectChannelId) return;
  const raison = document.getElementById("reject-reason").value.trim();

  try {
    await api(`/channels/${rejectChannelId}/reject`, {
      method: "POST",
      body: JSON.stringify({ raison }),
    });

    rejectModal.hide();
    showToast("Chaine rejetee", "info");
    document.getElementById("channel-filter").value = "pending";

    loadChannels();
    loadStats();
  } catch (err) {
    showToast("Erreur: " + err.message, "error");
  }
}

async function previewChannel() {
  clearTimeout(previewDebounce);
  resolvedChannelData = null;
  const input = document.getElementById("add-ch-input").value.trim();
  const preview = document.getElementById("add-ch-preview");
  const btn = document.getElementById("add-ch-btn");

  if (!input) {
    preview.classList.add("d-none");
    btn.disabled = true;
    resolvedChannelData = null;
    return;
  }

  preview.innerHTML = '<div class="text-muted" style="font-size:0.85rem"><span class="spinner-glass"></span> Recherche...</div>';
  preview.classList.remove("d-none");
  btn.disabled = true;

  previewDebounce = setTimeout(async () => {
    try {
      const data = await api("/channels/resolve", {
        method: "POST",
        body: JSON.stringify({ input }),
      });

      if (data.error) {
        preview.innerHTML = `<div class="text-muted" style="font-size:0.85rem">Aucun resultat</div>`;
        resolvedChannelData = null;
        return;
      }

      resolvedChannelData = data;
      const exists = await api("/channels?status=");
      const alreadyExists = exists.some((ch) => ch.channel_id === data.channelId);

      let html = `
        <div class="glass-card p-3 d-flex align-items-center gap-3">
          <img src="${safeImageUrl(data.thumbnail)}" alt="" class="rounded-circle"
               style="width:48px;height:48px;object-fit:cover;background:var(--purple-800)"
               onerror="this.style.display='none'">
          <div class="flex-grow-1">
            <div class="fw-bold">${escapeHtml(data.nom)}</div>
            <div class="text-muted" style="font-size:0.82rem">${escapeHtml(data.channelId)}</div>
            ${data.subscriberCount ? `<div class="text-muted" style="font-size:0.78rem">${formatNumber(data.subscriberCount)} abonnes</div>` : ""}
            ${data.videoTitle ? `<div class="text-muted" style="font-size:0.78rem;margin-top:2px"><i class="bi bi-camera-reels"></i> ${escapeHtml(data.videoTitle)}</div>` : ""}
          </div>
          ${alreadyExists
            ? '<span class="status-badge pending">deja existant</span>'
            : '<span class="status-badge validated">pret</span>'
          }
        </div>`;

      if (data.alternatives?.length > 0) {
        html += '<div class="mt-2" style="font-size:0.8rem;color:var(--text-muted)">Autres resultats :</div>';
        for (const alt of data.alternatives) {
          html += `
            <div class="glass-card p-2 mt-1 d-flex align-items-center gap-2" style="cursor:pointer" 
                 onclick="document.getElementById('add-ch-input').value='${escapeInlineJs(alt.nom)}';previewChannel()">
              <div class="fw-bold" style="font-size:0.85rem">${escapeHtml(alt.nom)}</div>
              <div class="text-muted" style="font-size:0.75rem">${escapeHtml(alt.channelId)}</div>
            </div>`;
        }
      }

      preview.innerHTML = html;
      btn.disabled = alreadyExists;
    } catch (err) {
      preview.innerHTML = `<div class="text-muted" style="font-size:0.85rem">Erreur: ${err.message}</div>`;
      resolvedChannelData = null;
    }
  }, 600);
}

function addChannel() {
  if (!resolvedChannelData) return showToast("Entrez un lien ou un nom", "error");

  const btn = document.getElementById("add-ch-btn");
  btn.disabled = true;
  btn.innerHTML = '<span class="spinner-glass"></span> Ajout...';

  api("/channels", {
    method: "POST",
    body: JSON.stringify({ channel_id: resolvedChannelData.channelId, nom: resolvedChannelData.nom }),
  }).then((res) => {
    if (res.error) {
      showToast(res.error, "error");
      btn.disabled = false;
      btn.innerHTML = '<i class="bi bi-plus-lg"></i> Ajouter';
      return;
    }
    addChannelModal.hide();
    showToast("Chaine ajoutee !", "success");
    loadChannels();
    loadStats();
  }).catch((err) => {
    showToast("Erreur: " + err.message, "error");
    btn.disabled = false;
    btn.innerHTML = '<i class="bi bi-plus-lg"></i> Ajouter';
  });
}

async function refreshAllChannelStats() {
  const btn = document.getElementById("refresh-stats-btn");
  btn.disabled = true;
  btn.innerHTML = '<span class="spinner-glass"></span> Mise a jour...';
  showToast("Mise a jour des stats en arriere-plan...", "info");

  try {
    await api("/channels/refresh-stats", { method: "POST", timeout: 120000 });
    showToast("Stats mises a jour", "success");
    loadChannels();
    loadStats();
  } catch (err) {
    showToast("Erreur: " + err.message, "error");
  } finally {
    btn.disabled = false;
    btn.innerHTML = '<i class="bi bi-arrow-clockwise"></i> Update stats';
  }
}

async function refreshRSS() {
  const btn = document.getElementById("btn-refresh-rss");
  const icon = btn?.querySelector(".btn-icon");
  icon?.classList.add("spinning");
  btn?.setAttribute("disabled", "true");
  btn?.setAttribute("aria-busy", "true");

  try {
    await api("/refresh", { method: "POST" });
  } catch (err) {
    showToast("Erreur lors du demarrage du refresh", "error");
    icon?.classList.remove("spinning");
    btn?.removeAttribute("disabled");
    btn?.removeAttribute("aria-busy");
    return;
  }

  // Show progress banner
  const banner = document.getElementById("refreshBanner");
  const bar = document.getElementById("refreshBannerBar");
  const count = document.getElementById("refreshBannerCount");
  const detail = document.getElementById("refreshBannerDetail");
  banner.classList.remove("d-none");

  // Poll status until done
  let done = false;
  let status = null;
  const pollDeadline = Date.now() + 30 * 60 * 1000;
  while (!done && Date.now() < pollDeadline) {
    await new Promise((r) => setTimeout(r, 1500));
    try {
      status = await api("/refresh/status");
    } catch { continue; }

    const pct = status.total > 0 ? Math.round((status.completed / status.total) * 100) : 0;
    count.textContent = `${status.completed} / ${status.total}`;
    bar.style.width = `${pct}%`;
    document.getElementById("refreshBannerText").textContent = status.current
      ? `${status.completed} / ${status.total} chaines`
      : "Rafraîchissement...";
    detail.textContent = status.current || "";

    if (status.status === "done" || status.status === "error") {
      done = true;
    }
  }

  // Done (or timed out while the server continued in the background)
  if (!status || status.status === "running") {
    detail.textContent = status
      ? "Refresh toujours en cours — suivi en arrière-plan"
      : "Connexion interrompue — suivi en arrière-plan";
    watchRefreshInBackground({ btn, icon, banner, bar, count, detail });
    return;
  }

  if (status) {
    bar.classList.remove("progress-bar-striped", "progress-bar-animated");
    bar.style.width = status.status === "done" || status.total === 0 ? "100%" : `${Math.min(100, Math.round((status.completed / status.total) * 100))}%`;
    count.textContent = status.status === "done" ? `✓ ${status.completed} chaines` : "Refresh en erreur";
    detail.textContent = status.errors > 0 ? `${status.errors} erreurs` : "";
  } else {
    detail.textContent = "Impossible de lire la progression";
  }
  setTimeout(() => {
    banner.classList.add("d-none");
    bar.classList.add("progress-bar-striped", "progress-bar-animated");
    bar.style.width = "0%";
  }, 3000);

  loadVideos(true);
  loadStats();
  icon?.classList.remove("spinning");
  btn?.removeAttribute("disabled");
  btn?.removeAttribute("aria-busy");
}

async function watchRefreshInBackground({ btn, icon, banner, bar, count, detail }) {
  const watcherDeadline = Date.now() + 2 * 60 * 60 * 1000;
  while (Date.now() < watcherDeadline) {
    await new Promise((resolve) => setTimeout(resolve, 5000));
    let status;
    try {
      status = await api("/refresh/status");
    } catch {
      continue;
    }

    const pct = status.total > 0 ? Math.round((status.completed / status.total) * 100) : 0;
    count.textContent = `${status.completed} / ${status.total}`;
    bar.style.width = `${pct}%`;
    detail.textContent = status.current || "Refresh toujours en cours";
    if (status.status !== "done" && status.status !== "error") continue;

    bar.classList.remove("progress-bar-striped", "progress-bar-animated");
    bar.style.width = "100%";
    count.textContent = status.status === "done" ? `✓ ${status.completed} chaines` : "Refresh en erreur";
    detail.textContent = status.errors > 0 ? `${status.errors} erreurs` : "";
    setTimeout(() => {
      banner.classList.add("d-none");
      bar.classList.add("progress-bar-striped", "progress-bar-animated");
      bar.style.width = "0%";
    }, 3000);
    loadVideos(true);
    loadStats();
    icon?.classList.remove("spinning");
    btn?.removeAttribute("disabled");
    btn?.removeAttribute("aria-busy");
    return;
  }

  detail.textContent = "Suivi interrompu — vérifie le statut du refresh plus tard";
  setTimeout(() => {
    banner.classList.add("d-none");
    bar.classList.add("progress-bar-striped", "progress-bar-animated");
    bar.style.width = "0%";
  }, 5000);
  icon?.classList.remove("spinning");
  btn?.removeAttribute("disabled");
  btn?.removeAttribute("aria-busy");
}

function renderChannelTopicBadges(channelId, topics, channelName) {
  const container = document.getElementById(`ch-topics-${channelId}`);
  if (!container) return;
  const badges = (topics || []).map((t) =>
    `<span class="topic-badge">
      ${escapeHtml(t.nom)}
      <i class="bi bi-x" style="cursor:pointer;font-size:0.65rem;margin-left:2px"
         onclick="event.stopPropagation();removeTopicFromChannel(${channelId}, ${t.id})"></i>
    </span>`
  ).join(' ');
  const addBtn = `<span class="topic-badge topic-add" onclick="event.stopPropagation();openChannelTopics(${channelId}, '${escapeInlineJs(channelName || "")}')" title="Ajouter un topic"><i class="bi bi-plus"></i></span>`;
  container.innerHTML = badges + ' ' + addBtn;
}

async function loadChannelTopicBadges(channelId, topics = null) {
  const container = document.getElementById(`ch-topics-${channelId}`);
  if (!container) return;
  if (topics) {
    renderChannelTopicBadges(channelId, topics);
    return;
  }
  try {
    const fetched = await api(`/channels/${channelId}/topics`);
    if (!document.getElementById(`ch-topics-${channelId}`)) return;
    renderChannelTopicBadges(channelId, fetched);
  } catch {
    const el = document.getElementById(`ch-topics-${channelId}`);
    if (el) el.innerHTML = '';
  }
}

async function assignTopicToChannel(channelId, topicId) {
  if (!topicId) return;
  try {
    await api(`/channels/${channelId}/topics`, {
      method: "POST",
      body: JSON.stringify({ topic_id: parseInt(topicId) }),
    });
    showToast("Topic ajoute a la chaine", "success");
    loadChannelTopicBadges(channelId);
    populateTopicFilter();
    // Reset select
    const sel = document.getElementById(`topic-select-${channelId}`);
    if (sel) sel.value = "";
  } catch (err) {
    showToast("Erreur: " + err.message, "error");
  }
}

async function removeTopicFromChannel(channelId, topicId) {
  try {
    await api(`/channels/${channelId}/topics?topic_id=${topicId}`, { method: "DELETE" });
    loadChannelTopicBadges(channelId);
    populateTopicFilter();
  } catch (err) {
    showToast("Erreur: " + err.message, "error");
  }
}

async function openChannelTopics(channelId, channelName) {
  currentEditingChannelId = channelId;
  document.getElementById("channel-topics-channel-name").textContent = escapeHtml(channelName);
  await renderChannelTopicEditor(channelId);
  channelTopicsModal.show();
}

async function renderChannelTopicEditor(channelId) {
  const container = document.getElementById("channel-topics-list");
  const emptyState = document.getElementById("channel-topics-empty");
  try {
    const [allTopics, assigned] = await Promise.all([api("/topics"), api(`/channels/${channelId}/topics`)]);

    if (allTopics.length === 0) {
      container.innerHTML = "";
      emptyState.classList.remove("d-none");
      return;
    }

    emptyState.classList.add("d-none");
    currentEditingTopics = new Set(assigned.map((t) => t.id));

    container.innerHTML = allTopics
      .map((t) => {
        const isSelected = currentEditingTopics.has(t.id);
        return `<span class="topic-select-pill ${isSelected ? "selected" : ""}" onclick="toggleChannelTopic(${t.id}, this)" data-topic-id="${t.id}">
          ${escapeHtml(t.nom)}
        </span>`;
      })
      .join("");
  } catch (err) {
    container.innerHTML = '<p class="text-muted" style="font-size:0.85rem">Erreur de chargement</p>';
    emptyState.classList.add("d-none");
  }
}

function toggleChannelTopic(topicId, el) {
  if (currentEditingTopics.has(topicId)) {
    currentEditingTopics.delete(topicId);
    el.classList.remove("selected");
  } else {
    currentEditingTopics.add(topicId);
    el.classList.add("selected");
  }
}

async function saveChannelTopics() {
  if (!currentEditingChannelId) return;

  const saveBtn = document.querySelector("#channelTopicsModal .modal-footer .btn-primary-glass");
  try {
    saveBtn.disabled = true;

    const assigned = await api(`/channels/${currentEditingChannelId}/topics`);
    const assignedIds = new Set(assigned.map((t) => t.id));

    const toAdd = [];
    const toRemove = [];

    for (const topicId of currentEditingTopics) {
      if (!assignedIds.has(topicId)) toAdd.push(topicId);
    }
    for (const topicId of assignedIds) {
      if (!currentEditingTopics.has(topicId)) toRemove.push(topicId);
    }

    // Apply changes sequentially to avoid partially updated state on error
    for (const topicId of toAdd) {
      await api(`/channels/${currentEditingChannelId}/topics`, {
        method: "POST",
        body: JSON.stringify({ topic_id: topicId }),
      });
    }
    for (const topicId of toRemove) {
      await api(`/channels/${currentEditingChannelId}/topics?topic_id=${topicId}`, { method: "DELETE" });
    }

    channelTopicsModal.hide();
    showToast("Topics mis à jour", "success");
    loadChannels();
    populateTopicFilter();
  } catch (err) {
    showToast("Erreur: " + err.message, "error");
  } finally {
    saveBtn.disabled = false;
  }
}

async function populateTopicFilter() {
  const select = document.getElementById("video-topic-filter");
  if (!select) return;
  const currentVal = select.value;
  try {
    const topics = await api("/topics");
    select.innerHTML = '<option value="">Tous les topics</option>' +
      '<option value="0"' + (currentVal === "0" ? " selected" : "") + '>Sans topic</option>' +
      topics.map((t) => `<option value="${t.id}" ${currentVal == t.id ? "selected" : ""}>${escapeHtml(t.nom)}</option>`).join("");
    select.onchange = () => loadVideos(true);
  } catch {
    select.innerHTML = '<option value="">Tous les topics</option>';
    select.onchange = () => loadVideos(true);
  }
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

function getSeenVideos() {
  try {
    return new Set(JSON.parse(localStorage.getItem("youfind-seen") || "[]"));
  } catch {
    return new Set();
  }
}

function markVideoSeen(url) {
  const seen = getSeenVideos();
  seen.add(url);
  try {
    localStorage.setItem("youfind-seen", JSON.stringify([...seen]));
  } catch {
    // Storage full or private browsing — silently ignore
  }
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
  for (const p of patterns) {
    const m = url.match(p);
    if (m) return m[1];
  }
  const fallback = url.split("/").pop();
  return fallback?.length === 11 ? fallback : null;
}

let ytPlayer = null;
let ytReady = false;
let ytCallbacks = [];

function loadYTAPI() {
  if (window.YT) { ytReady = true; return; }
  const prev = window.onYouTubeIframeAPIReady;
  window.onYouTubeIframeAPIReady = () => {
    ytReady = true;
    ytCallbacks.forEach(fn => fn());
    ytCallbacks = [];
    if (prev) prev();
  };
  const tag = document.createElement("script");
  tag.src = "https://www.youtube.com/iframe_api";
  document.head.appendChild(tag);
}
loadYTAPI();

function whenYTReady(fn) {
  if (ytReady) { fn(); return; }
  ytCallbacks.push(fn);
}

function openPlayer(videoId) {
  const backdrop = document.getElementById("playerBackdrop");
  backdrop.classList.add("open");
  document.body.style.overflow = "hidden";

  if (ytPlayer) { ytPlayer.destroy(); ytPlayer = null; }

  const container = document.getElementById("playerVid");
  // YT.Player replaces the target div with an iframe; destroy() recreates a bare
  // div that loses its CSS class. Restore it so aspect-ratio keeps working.
  container.className = "player-vid";
  container.innerHTML = "";

  // Small delay to let backdrop transition complete (YouTube API needs visible container)
  setTimeout(() => {
    ytPlayer = new YT.Player("playerVid", {
      videoId,
      width: "100%",
      height: "100%",
      playerVars: {
        autoplay: 1,
        controls: 1,
        rel: 0,
        iv_load_policy: 3,
        modestbranding: 1,
        playsinline: 1,
      },
      events: {
        onReady: onPlayerReady,
        onStateChange: onPlayerStateChange,
        onError: onPlayerError,
      },
    });
  }, 350);
}

function onPlayerReady() {
  ytPlayer.playVideo();
}

function onPlayerError(e) {
  console.error("[Player] YouTube error:", e.data);
  showToast("Erreur de lecture vidéo (code " + e.data + ")", "error");
}

function onPlayerStateChange(e) {
  const box = document.getElementById("playerBox");
  if (e.data === YT.PlayerState.PLAYING) {
    box.classList.add("playing");
  } else {
    box.classList.remove("playing");
  }
}

function closePlayer() {
  document.getElementById("playerBackdrop").classList.remove("open");
  document.body.style.overflow = "";
  // Destroy the YT player and clear the container so the invisible iframe
  // doesn't sit on top of the page and intercept clicks on video cards.
  if (ytPlayer) {
    try { ytPlayer.destroy(); } catch (e) { /* ignore */ }
    ytPlayer = null;
  }
  const container = document.getElementById("playerVid");
  container.innerHTML = "";
  container.className = "player-vid";
}

function playVideo(url) {
  markVideoSeen(url);

  const card = document.querySelector(`.video-card[data-video-url="${CSS.escape(url)}"]`);
  if (card) {
    card.classList.add("seen");
    card.title = "Déjà vu";
    const thumb = card.querySelector(".thumb-wrap");
    if (thumb && !thumb.querySelector(".seen-badge")) {
      const badge = document.createElement("span");
      badge.className = "seen-badge";
      badge.innerHTML = '<i class="bi bi-check-circle-fill"></i> Vu';
      thumb.appendChild(badge);
    }
  }

  const videoId = extractVideoId(url);
  if (!videoId) return showToast("URL de vidéo invalide", "error");

  whenYTReady(() => openPlayer(videoId));
}

// --- Player control bindings ---
document.addEventListener("DOMContentLoaded", () => {
  const backdrop = document.getElementById("playerBackdrop");
  const closeBtn = document.getElementById("playerClose");

  closeBtn.addEventListener("click", closePlayer);
  backdrop.addEventListener("click", (e) => { if (e.target === backdrop) closePlayer(); });
  document.addEventListener("keydown", (e) => { if (e.key === "Escape") closePlayer(); });
});

function escapeJs(str) {
  if (!str) return "";
  return str.replace(/\\/g, "\\\\").replace(/'/g, "\\'").replace(/"/g, '\\"').replace(/\n/g, "\\n").replace(/\r/g, "\\r").replace(/`/g, "\\`");
}

// For embedding user data in onclick="..." attributes (double context: HTML + JS):
// 1. JS-escape first (handles ', \, newlines within JS string literals)
// 2. Then HTML-escape (handles " that would break the HTML attribute, &, <, >)
function escapeInlineJs(str) {
  if (!str) return "";
  const jsSafe = str.replace(/\\/g, "\\\\").replace(/'/g, "\\'").replace(/\n/g, "\\n").replace(/\r/g, "\\r").replace(/`/g, "\\`");
  return jsSafe.replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

async function loadQuota() {
  const valEl = document.getElementById("quota-value");
  const barEl = document.getElementById("quota-bar");
  try {
    const quota = await api("/quota");
    const used = Number(quota.used);
    const limit = Number(quota.limit);
    if (!Number.isFinite(used) || !Number.isFinite(limit) || limit <= 0) {
      if (valEl) valEl.textContent = "Indisponible";
      if (barEl) barEl.style.width = "0%";
      return;
    }
    const pct = Math.min(100, Math.max(0, Math.round((used / limit) * 100)));
    const color = pct > 50 ? "var(--accent-red)" : pct > 20 ? "var(--accent-yellow)" : "var(--accent-green)";
    if (valEl) valEl.innerHTML = `${formatStatCount(used)}<span style="font-size:0.7rem;opacity:0.6"> / ${formatStatCount(limit)}</span>`;
    if (barEl) {
      barEl.style.width = `${pct}%`;
      barEl.style.background = color;
    }
  } catch {
    if (valEl) valEl.textContent = "Indisponible";
    if (barEl) barEl.style.width = "0%";
  }
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

// --- Settings ---
const SETTINGS_KEYS = [
  "youtube_api_key", "llm_provider",
  "ollama_url", "ollama_model",
  "lmstudio_url", "lmstudio_model",
  "openrouter_key", "openrouter_model",
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
  const status = document.getElementById(key === "youtube_api_key" ? "youtube-key-status" : "llm-health");
  if (!input) return;
  input.dataset.configured = configured ? "true" : "false";
  input.placeholder = configured ? "Clé enregistrée · saisir pour remplacer" : (key === "youtube_api_key" ? "AIza..." : "sk-or-...");
  clear?.classList.toggle("d-none", !configured && !input.value);
  if (key === "youtube_api_key" && status) {
    status.className = `settings-state ${configured ? "configured" : ""}`;
    status.innerHTML = configured
      ? '<i class="bi bi-shield-check"></i> Configurée'
      : '<i class="bi bi-shield-lock"></i> Non configurée';
  }
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
  if (id === "set-youtube_api_key") updateSecretState("youtube_api_key", false);
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
  const youtube = settings.youtube_api_key_configured
    ? '<span class="status-ok">Configurée</span>'
    : '<span class="status-muted">Optionnelle</span>';
  status.innerHTML = `
    <div class="settings-status-row"><span><i class="bi bi-robot"></i> Moteur LLM</span><strong>${escapeHtml(provider)}</strong></div>
    <div class="settings-status-row"><span><i class="bi bi-collection-play"></i> YouTube API</span><strong>${youtube}</strong></div>
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
    updateSettingsStatus({ llm_provider: status.provider, youtube_api_key_configured: document.getElementById("set-youtube_api_key")?.dataset.configured === "true" });
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
    for (const key of ["youtube_api_key", "openrouter_key"]) {
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



// --- Batch Import ---
async function batchImport() {
  const text = document.getElementById("add-batch-input").value.trim();
  if (!text) return showToast("Colle du texte contenant des liens YouTube", "error");

  const btn = document.getElementById("add-batch-btn");
  const status = document.getElementById("add-batch-status");
  btn.disabled = true;
  btn.innerHTML = '<span class="spinner-glass"></span> Import...';
  status.innerHTML = "";

  try {
    const result = await api("/channels/import", {
      method: "POST",
      body: JSON.stringify({ text }),
      timeout: 120000,
    });

    let html = `<div style="font-size:0.88rem">`;
    html += `<div style="color:var(--accent-green)"><i class="bi bi-check-circle"></i> ${result.added} chaines ajoutees</div>`;
    if (result.skipped > 0) html += `<div class="text-muted">${result.skipped} deja existantes</div>`;
    if (result.errors.length > 0) {
      html += `<div style="color:var(--accent-red)">${result.errors.length} erreurs:</div>`;
      result.errors.forEach((e) => { html += `<div class="text-muted" style="font-size:0.78rem">${escapeHtml(e)}</div>`; });
    }
    html += `</div>`;
    status.innerHTML = html;

    if (result.added > 0) {
      showToast(`${result.added} chaines importees !`, "success");
      loadChannels();
      loadStats();
    }
  } catch (err) {
    status.innerHTML = `<div style="color:var(--accent-red);font-size:0.88rem">Erreur: ${err.message}</div>`;
  } finally {
    btn.disabled = false;
    btn.innerHTML = '<i class="bi bi-upload"></i> Importer';
  }
}

// --- Related Channels Discovery ---

let isRelatedRunning = false;

function loadRelatedPage() {
  const status = document.getElementById("related-status");
  const results = document.getElementById("related-results");
  // Don't clear if results exist (user might navigate away and back)
  if (!results.innerHTML) {
    status.innerHTML = '<p class="text-muted" style="font-size:0.88rem">Clique sur "Explorer les similaires" pour commencer.</p>';
  }
}

function renderRelatedChannel(ch) {
  const channelId = safeChannelId(ch.channelId);
  return `
    <div class="discover-result related-result-enter" id="rel-${channelId}">
      <div class="dr-avatar">
        ${ch.thumbnail ? `<img src="${safeImageUrl(ch.thumbnail)}" alt="">` : '<i class="bi bi-person"></i>'}
      </div>
      <div class="dr-info">
        <a href="https://youtube.com/channel/${channelId}" target="_blank" rel="noopener" class="dr-name" style="text-decoration:none;color:inherit">${escapeHtml(ch.nom)} <i class="bi bi-box-arrow-up-right" style="font-size:0.65rem;opacity:0.4"></i></a>
        <div class="dr-stats">
          <i class="bi bi-people"></i> ${formatNumber(ch.subscriberCount)} abonnes
          <span class="status-badge pending" style="margin-left:8px">en attente</span>
          <span class="text-muted" style="margin-left:6px;font-size:0.75rem"><i class="bi bi-diagram-2"></i> via ${escapeHtml(ch.source_channel || "")}</span>
        </div>
      </div>
      <div class="dr-actions" style="display:flex;gap:4px;flex-shrink:0">
        <button class="btn btn-success-glass btn-sm" onclick="event.stopPropagation();quickValidate('${channelId}', this)" title="Valider" style="padding:4px 8px;font-size:0.7rem">
          <i class="bi bi-check-lg"></i>
        </button>
        <button class="btn btn-danger-glass btn-sm" onclick="event.stopPropagation();quickReject('${channelId}', '${escapeInlineJs(ch.nom)}', this)" title="Rejeter" style="padding:4px 8px;font-size:0.7rem">
          <i class="bi bi-x-lg"></i>
        </button>
      </div>
    </div>`;
}

function updateRelatedProgress(data) {
  const progress = document.getElementById("related-progress");
  const label = document.getElementById("related-progress-label");
  const count = document.getElementById("related-progress-count");
  const bar = document.getElementById("related-progress-bar");
  const detail = document.getElementById("related-progress-detail");
  const track = progress?.querySelector(".related-progress-track");
  if (!progress || !label || !count || !bar || !detail) return;

  const total = Number(data.total) || 0;
  const completed = Math.min(Number(data.completed) || 0, total || Number(data.completed) || 0);
  const percent = total > 0 ? Math.round((completed / total) * 100) : data.status === "done" ? 100 : 0;
  progress.classList.remove("d-none");
  count.textContent = total > 0 ? `${completed} / ${total}` : "Préparation...";
  bar.style.width = `${percent}%`;
  track?.setAttribute("aria-valuenow", String(percent));

  if (data.status === "done") {
    label.innerHTML = '<i class="bi bi-check-circle-fill"></i> Exploration terminée';
    detail.textContent = `${data.found || 0} chaîne${data.found === 1 ? "" : "s"} similaire${data.found === 1 ? "" : "s"} trouvée${data.found === 1 ? "" : "s"}`;
    bar.classList.remove("progress-bar-animated");
  } else if (data.status === "error") {
    label.innerHTML = '<i class="bi bi-exclamation-circle-fill"></i> Exploration interrompue';
    detail.textContent = data.error || "Une erreur est survenue pendant l'exploration.";
    bar.classList.remove("progress-bar-animated");
  } else {
    label.innerHTML = `<i class="bi bi-search"></i> Analyse de ${escapeHtml(data.current || "tes chaînes validées")}...`;
    detail.textContent = `${data.found || 0} chaîne${data.found === 1 ? "" : "s"} trouvée${data.found === 1 ? "" : "s"} pour l'instant — les résultats arrivent en direct`;
    bar.classList.add("progress-bar-animated");
  }
}

async function runRelatedDiscovery() {
  if (isRelatedRunning) return showToast("Deja en cours...", "info");
  isRelatedRunning = true;

  const btn = document.getElementById("related-btn");
  const status = document.getElementById("related-status");
  const results = document.getElementById("related-results");
  const badge = document.getElementById("related-badge");

  btn.disabled = true;
  btn.innerHTML = '<span class="spinner-glass"></span> Exploration...';
  status.innerHTML = "";
  results.innerHTML = "";
  badge.style.display = "inline-flex";
  document.getElementById("related-progress")?.classList.remove("d-none");
  updateRelatedProgress({ status: "running", total: 0, completed: 0, found: 0 });

  let cursor = 0;
  let lastStatus = null;
  let jobId = "";
  let pollFailures = 0;
  const pollingDeadline = Date.now() + 2 * 60 * 60 * 1000;

  try {
    const started = await api("/discover/related", { method: "POST", timeout: 30000 });
    jobId = started.jobId || "";
    if (!jobId) throw new Error("Impossible d'identifier l'exploration");

    while (Date.now() < pollingDeadline) {
      await new Promise((resolve) => setTimeout(resolve, 1200));
      let data;
      try {
        data = await api(`/discover/related/status?job=${encodeURIComponent(jobId)}&since=${cursor}`, { timeout: 30000 });
        pollFailures = 0;
      } catch (err) {
        pollFailures++;
        if (pollFailures >= 10) throw err;
        status.innerHTML = `<span class="text-muted"><span class="spinner-glass"></span> Connexion interrompue — nouvelle tentative (${pollFailures}/10)</span>`;
        continue;
      }
      lastStatus = data;
      updateRelatedProgress(data);

      if (Array.isArray(data.results) && data.results.length > 0) {
        results.insertAdjacentHTML("beforeend", data.results.map(renderRelatedChannel).join(""));
        cursor = data.next;
        status.innerHTML = `<span class="related-live-status"><i class="bi bi-broadcast-pin"></i> ${data.found} chaîne${data.found === 1 ? "" : "s"} affichée${data.found === 1 ? "" : "s"} en temps réel</span>`;
      }

      if (data.status === "done") {
        if (!data.found) {
          status.innerHTML = '<p class="text-muted" style="font-size:0.88rem">Aucune nouvelle chaine similaire trouvee. Ajoute plus de chaines validees pour enrichir la decouverte.</p>';
        }
        loadStats();
        return;
      }
      if (data.status === "error") {
        throw new Error(data.error || "Erreur pendant la découverte");
      }
    }

    throw new Error("Le suivi a expiré après deux heures, mais la découverte peut continuer sur le serveur.");
  } catch (err) {
    updateRelatedProgress(lastStatus || { status: "error", error: err.message, total: 0, completed: 0, found: cursor });
    status.innerHTML = `<span style="color:var(--accent-red)"><i class="bi bi-exclamation-circle"></i> ${escapeHtml(err.message)}</span>`;
  } finally {
    isRelatedRunning = false;
    btn.disabled = false;
    btn.innerHTML = '<i class="bi bi-search"></i> Explorer les similaires';
  }
}

async function quickValidate(channelId, btn) {
  try {
    const channels = await api("/channels?status=pending");
    const ch = channels.find((c) => c.channel_id === channelId);
    if (!ch) return showToast("Chaine introuvable", "error");
    await api(`/channels/${ch.id}/validate`, { method: "POST" });
    const card = btn.closest(".discover-result");
    if (card) card.style.opacity = "0.5";
    showToast("Chaine validee !", "success");
    loadStats();
  } catch (err) {
    showToast("Erreur: " + err.message, "error");
  }
}

async function quickReject(channelId, name, btn) {
  try {
    const channels = await api("/channels?status=pending");
    const ch = channels.find((c) => c.channel_id === channelId);
    if (!ch) return showToast("Chaine introuvable", "error");
    await api(`/channels/${ch.id}/reject`, {
      method: "POST",
      body: JSON.stringify({ raison: "Non pertinent" }),
    });
    const card = btn.closest(".discover-result");
    if (card) card.remove();
    showToast("Chaine rejetee", "info");
    loadStats();
  } catch (err) {
    showToast("Erreur: " + err.message, "error");
  }
}

// --- Channel Detail Modal ---
async function openChannelDetail(id) {
  document.getElementById("detail-ch-name").textContent = "Chargement...";
  document.getElementById("detail-ch-meta").textContent = "";
  document.getElementById("detail-ch-summary").innerHTML = "";
  document.getElementById("detail-ch-topics").innerHTML = "";
  document.getElementById("detail-ch-videos").innerHTML = '<div class="col-12 text-center py-3"><div class="spinner-glass"></div></div>';
  document.getElementById("detail-ch-related").innerHTML = '<div class="text-muted" style="font-size:0.85rem"><span class="spinner-glass"></span> Chargement...</div>';
  channelDetailModal.show();

  try {
    const data = await api(`/channels/${id}/detail`);
    const ch = data.channel;

    document.getElementById("detail-ch-thumb").src = ch.thumbnail || "";
    document.getElementById("detail-ch-name").textContent = ch.nom;
    document.getElementById("detail-ch-meta").textContent = `${formatNumber(ch.subscriber_count)} abonnes | ${ch.status}`;
    document.getElementById("detail-ch-link").href = `https://youtube.com/channel/${safeChannelId(ch.channel_id)}`;

    if (ch.llm_summary) {
      document.getElementById("detail-ch-summary").innerHTML = `
        <div class="glass-card p-3">
          <div class="llm-score ${ch.llm_score >= 70 ? 'high' : ch.llm_score >= 40 ? 'medium' : 'low'} mb-1">${ch.llm_score != null ? ch.llm_score + '/100' : "Non score"}</div>
          <div class="llm-summary">${escapeHtml(ch.llm_summary)}</div>
        </div>`;
    }

    if (data.topics.length > 0) {
      document.getElementById("detail-ch-topics").innerHTML = data.topics.map((t) =>
        `<span class="topic-badge">${escapeHtml(t.nom)}</span>`
      ).join(" ");
    }

    if (data.videos.length === 0) {
      document.getElementById("detail-ch-videos").innerHTML = '<div class="col-12 text-muted text-center py-3" style="font-size:0.85rem">Aucune video</div>';
    } else {
      const seenSet = getSeenVideos();
      document.getElementById("detail-ch-videos").innerHTML = data.videos.map((v) => renderVideoCard(v, seenSet)).join("");
    }

    // Load related channels
    loadRelatedChannels(id);
  } catch (err) {
    document.getElementById("detail-ch-name").textContent = "Erreur";
    document.getElementById("detail-ch-related").innerHTML = `<div class="text-muted">${err.message}</div>`;
  }
}

async function loadRelatedChannels(channelId) {
  const container = document.getElementById("detail-ch-related");
  try {
    const related = await api(`/channels/${channelId}/related`);
    if (related.length === 0) {
      container.innerHTML = '<div class="text-muted" style="font-size:0.85rem">Aucune chaine similaire trouvee</div>';
      return;
    }
    container.innerHTML = related.map((ch) => `
      <div class="discover-result" style="padding:10px;margin-bottom:8px">
        <div class="dr-avatar" style="width:36px;height:36px">
          ${ch.thumbnail ? `<img src="${safeImageUrl(ch.thumbnail)}" alt="">` : '<i class="bi bi-person"></i>'}
        </div>
        <div class="dr-info">
          <a href="https://youtube.com/channel/${safeChannelId(ch.channelId)}" target="_blank" class="dr-name" style="text-decoration:none;color:inherit;font-size:0.88rem">${escapeHtml(ch.nom)}</a>
        </div>
        <div class="dr-actions">
          <button class="btn btn-sm-glass" onclick="event.stopPropagation();addRelatedChannel('${safeChannelId(ch.channelId)}', '${escapeInlineJs(ch.nom)}')" title="Ajouter" style="padding:3px 8px;font-size:0.7rem">
            <i class="bi bi-plus-lg"></i>
          </button>
        </div>
      </div>
    `).join("");
  } catch {
    container.innerHTML = '<div class="text-muted" style="font-size:0.85rem">Erreur de chargement</div>';
  }
}

async function addRelatedChannel(channelId, nom) {
  try {
    await api("/channels", {
      method: "POST",
      body: JSON.stringify({ channel_id: channelId, nom }),
    });
    showToast(`${nom} ajoutee !`, "success");
    loadChannels();
    loadStats();
  } catch (err) {
    showToast(err.message, "error");
  }
}

// --- Channel Preview (3 recent videos for pending channels) ---
function renderChannelPreview(channelId, videos) {
  const container = document.getElementById(`ch-preview-${channelId}`);
  if (!container) return;
  if (videos.length === 0) {
    container.innerHTML = '<span class="text-muted" style="font-size:0.72rem">Pas de videos</span>';
    return;
  }
  container.innerHTML = `<div class="preview-thumbs">${videos.map((v) => `
    <div class="preview-thumb" onclick="playVideo('${escapeInlineJs(v.url)}')" title="${escapeHtml(v.titre)}">
      ${v.thumbnail ? `<img src="${safeImageUrl(v.thumbnail)}" alt="">` : ""}
      <span class="preview-views">${formatNumber(v.vues)}</span>
    </div>
  `).join("")}</div>`;
}

async function loadChannelPreview(channelId, videos = null) {
  const container = document.getElementById(`ch-preview-${channelId}`);
  if (!container) return;
  if (videos) {
    renderChannelPreview(channelId, videos);
    return;
  }
  try {
    const fetched = await api(`/channels/${channelId}/preview`);
    if (!document.getElementById(`ch-preview-${channelId}`)) return;
    renderChannelPreview(channelId, fetched);
  } catch {
    container.innerHTML = '';
  }
}

// Fallback if stored page no longer exists
if (!document.getElementById(`page-${currentPage}`)) {
  currentPage = "videos";
  localStorage.setItem("youfind-page", "videos");
}
navigateTo(currentPage);
loadStats();
loadLLMHealth();
populateTopicFilter();
