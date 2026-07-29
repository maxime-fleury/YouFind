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

async function loadStats() {
  try {
    const stats = await api("/stats");
    document.getElementById("stats-bar").innerHTML = `
    <div class="col-6 col-md-3 col-lg-2">
      <div class="stat-card">
        <div class="stat-value">${stats.total_videos || 0}</div>
        <div class="stat-label">Videos</div>
      </div>
    </div>
    <div class="col-6 col-md-3 col-lg-2">
      <div class="stat-card">
        <div class="stat-value">${stats.validated_channels || 0}</div>
        <div class="stat-label">Validees</div>
      </div>
    </div>
    <div class="col-6 col-md-3 col-lg-2">
      <div class="stat-card">
        <div class="stat-value">${stats.pending_channels || 0}</div>
        <div class="stat-label">En attente</div>
      </div>
    </div>
    <div class="col-6 col-md-3 col-lg-2">
      <div class="stat-card">
        <div class="stat-value">${stats.rejected_channels || 0}</div>
        <div class="stat-label">Rejetees</div>
      </div>
    </div>
    <div class="col-6 col-md-3 col-lg-2">
      <div class="stat-card">
        <div class="stat-value">${stats.total_topics || 0}</div>
        <div class="stat-label">Topics</div>
      </div>
    </div>
    <div class="col-6 col-md-3 col-lg-2" id="quota-stat">
      <div class="stat-card">
        <div class="stat-value" id="quota-value" style="font-size:1.2rem">--</div>
        <div class="stat-label">Quota API</div>
        <div style="height:3px;background:var(--glass-border);border-radius:2px;margin-top:4px">
          <div id="quota-bar" style="height:100%;width:0%;background:var(--accent-green);border-radius:2px;transition:width 0.3s"></div>
        </div>
      </div>
    </div>
    `;
    loadQuota();
  } catch (err) {
    console.error("Failed to load stats:", err);
    document.getElementById("stats-bar").innerHTML = '';
  }
}

function renderVideoCard(v, seenSet) {
  const seenClass = seenSet.has(v.url) ? "seen" : "";
  return `
    <div class="col-sm-6 col-md-4 col-xl-3">
      <div class="video-card h-100 ${seenClass}" data-video-url="${escapeHtml(v.url)}" onclick="playVideo('${escapeInlineJs(v.url)}')" title="${seenClass ? 'Déjà vu' : ''}">
        <div class="thumb-wrap">
            ${v.thumbnail ? `<img src="${v.thumbnail}" alt="" loading="lazy">` : ""}
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
          ${ch.thumbnail ? `<img src="${ch.thumbnail}" alt="">` : escapeHtml(ch.nom.charAt(0).toUpperCase())}
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
            ${ch.status === "pending" ? `<button class="btn btn-sm-glass btn-sm ms-auto" onclick="scoreSingle('${ch.channel_id}', ${ch.id})" title="Score LLM"><i class="bi bi-stars"></i> Score</button>` : ""}
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
            <button class="btn btn-sm-glass btn-sm" onclick="window.open('https://youtube.com/channel/${ch.channel_id}','_blank')" title="Voir sur YouTube">
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

async function loadTopics() {
  const grid = document.getElementById("topics-grid");
  try {
    const topics = await api("/topics");

    if (topics.length === 0) {
      grid.innerHTML = `
        <div class="col-12">
          <div class="empty-state">
            <i class="bi bi-tags"></i>
            <h5>Aucun topic</h5>
            <p>Ajoute un topic pour lancer la decouverte.</p>
          </div>
        </div>`;
      return;
    }

    grid.innerHTML = topics
      .map(
        (t) => `
      <div class="col-sm-6 col-md-4 col-lg-3">
        <div class="glass-card p-3 h-100 d-flex flex-column">
          <div class="flex-grow-1 mb-2">
            <div class="topic-name">${escapeHtml(t.nom)}</div>
            ${t.description ? `<div class="topic-desc mt-1">${escapeHtml(t.description)}</div>` : ""}
          </div>
          <div class="d-flex gap-2">
            <button class="btn btn-primary-glass btn-sm flex-grow-1" onclick="discoverTopic('${escapeInlineJs(t.nom)}')" title="Decouvrir">
              <i class="bi bi-compass"></i> Decouvrir
            </button>
            <button class="btn btn-sm-glass" onclick="deleteTopic(${t.id})" title="Supprimer">
              <i class="bi bi-trash3"></i>
            </button>
          </div>
        </div>
      </div>`
      )
      .join("");
  } catch (err) {
    console.error("[loadTopics]", err);
    grid.innerHTML = '<div class="col-12"><div class="empty-state"><p class="text-muted">Erreur de chargement des topics</p></div></div>';
  }
}

function discoverTopic(topicName) {
  document.getElementById("discover-input").value = topicName;
  navigateTo("discover");
  runDiscovery();
}

async function addTopic() {
  const nom = document.getElementById("discover-input").value.trim();
  if (!nom) return showToast("Entrez un nom de topic", "error");

  await api("/topics", {
    method: "POST",
    body: JSON.stringify({ nom, description: "" }),
  });
  document.getElementById("discover-input").value = "";
  showToast("Topic ajoute", "success");
  loadTopics();
  populateTopicFilter();
}

async function deleteTopic(id) {
  await api(`/topics?id=${id}`, { method: "DELETE" });
  showToast("Topic supprime", "info");
  loadTopics();
  populateTopicFilter();
}

async function runDiscovery() {
  const input = document.getElementById("discover-input");
  const status = document.getElementById("discover-status");
  const results = document.getElementById("discover-results");
  const badge = document.getElementById("discover-method-badge");
  const topicQuery = input.value.trim();
  if (!topicQuery) return showToast("Entrez un topic", "error");

  try {
    badge.innerHTML = '<span class="status-badge pending"><i class="bi bi-search"></i> Scraping YouTube...</span> <span class="api-cost free">0 credit</span>';
    status.innerHTML = '<span class="spinner-glass"></span> Recherche via scraping (gratuit, 0 credit API)...';
    results.innerHTML = "";

    const data = await api("/discover", {
      method: "POST",
      body: JSON.stringify({ topic: topicQuery }),
    });

    const methodUsed = data.method === "scraping" ? "Scraping" : "API";
    badge.innerHTML = data.method === "scraping"
      ? '<span class="status-badge validated"><i class="bi bi-lightning-charge"></i> Scraping</span> <span class="api-cost free">0 credit</span>'
      : '<span class="status-badge pending"><i class="bi bi-cloud-download"></i> API fallback</span> <span class="api-cost paid">~100 credits</span>';

    status.innerHTML = `<span style="color:var(--accent-green)"><i class="bi bi-check-circle"></i> ${data.found} chaines trouvees pour "${data.topic}" (via ${methodUsed})</span>`;

    if (data.channels && data.channels.length > 0) {
      results.innerHTML = data.channels
        .map(
          (ch) => `
        <div class="discover-result" id="dr-${ch.channelId}">
          <div class="dr-avatar">
            ${ch.thumbnail ? `<img src="${ch.thumbnail}" alt="">` : '<i class="bi bi-person"></i>'}
          </div>
          <div class="dr-info">
            <a href="https://youtube.com/channel/${ch.channelId}" target="_blank" class="dr-name" style="text-decoration:none;color:inherit">${escapeHtml(ch.nom)} <i class="bi bi-box-arrow-up-right" style="font-size:0.65rem;opacity:0.4"></i></a>
            <div class="dr-stats">
              <i class="bi bi-people"></i> ${formatNumber(ch.subscriberCount)} abonnes
              <span class="status-badge pending" style="margin-left:8px">en attente</span>
            </div>
          </div>
          <div class="dr-actions" style="display:flex;gap:4px;flex-shrink:0">
            <button class="btn btn-success-glass btn-sm" onclick="event.stopPropagation();validateChannelByYtId('${escapeInlineJs(ch.channelId)}')" title="Valider" style="padding:4px 8px;font-size:0.7rem">
              <i class="bi bi-check-lg"></i>
            </button>
            <button class="btn btn-danger-glass btn-sm" onclick="event.stopPropagation();rejectChannelByYtId('${escapeInlineJs(ch.channelId)}', '${escapeInlineJs(ch.nom)}')" title="Rejeter" style="padding:4px 8px;font-size:0.7rem">
              <i class="bi bi-x-lg"></i>
            </button>
          </div>
        </div>`
        )
        .join("");
    }

    loadStats();
    loadTopics();
    populateTopicFilter();
  } catch (err) {
    badge.innerHTML = '<span class="status-badge rejected"><i class="bi bi-x-circle"></i> Echec</span>';
    status.innerHTML = `<span style="color:var(--accent-red)"><i class="bi bi-exclamation-circle"></i> Erreur: ${err.message}</span>`;
  }
}

async function scoreAll() {
  const status = document.getElementById("score-status");
  status.innerHTML = '<span class="spinner-glass"></span> Scoring en cours... (peut prendre un moment)';

  try {
    const data = await api("/score-all", { method: "POST" });
    status.innerHTML = `<span style="color:var(--accent-green)"><i class="bi bi-check-circle"></i> ${data.scored} chaines scorees</span>`;
    loadChannels();
    loadStats();
  } catch (err) {
    status.innerHTML = `<span style="color:var(--accent-red)"><i class="bi bi-exclamation-circle"></i> Erreur: ${err.message}</span>`;
  }
}

async function scoreAllUnscored() {
  const status = document.getElementById("score-status");
  status.innerHTML = '<span class="spinner-glass"></span> Scoring des chaines non-scorees...';

  try {
    const data = await api("/score-unscored", { method: "POST", timeout: 300000 });
    status.innerHTML = `<span style="color:var(--accent-green)"><i class="bi bi-check-circle"></i> ${data.scored} chaines scorees</span>`;
    loadChannels();
    loadStats();
  } catch (err) {
    status.innerHTML = `<span style="color:var(--accent-red)"><i class="bi bi-exclamation-circle"></i> Erreur: ${err.message}</span>`;
  }
}

async function rescoreAll() {
  const status = document.getElementById("score-status");
  status.innerHTML = '<span class="spinner-glass"></span> Rescore de toutes les chaines... (peut prendre beaucoup de temps)';

  try {
    const data = await api("/rescore-all", { method: "POST", timeout: 600000 });
    status.innerHTML = `<span style="color:var(--accent-green)"><i class="bi bi-check-circle"></i> ${data.scored} chaines rescorees</span>`;
    loadChannels();
    loadStats();
  } catch (err) {
    status.innerHTML = `<span style="color:var(--accent-red)"><i class="bi bi-exclamation-circle"></i> Erreur: ${err.message}</span>`;
  }
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
          <img src="${data.thumbnail || ""}" alt="" class="rounded-circle" 
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
  while (!done) {
    await new Promise((r) => setTimeout(r, 1500));
    let status;
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

  // Done
  bar.classList.remove("progress-bar-striped", "progress-bar-animated");
  bar.style.width = "100%";
  count.textContent = `✓ ${status.completed} chaines`;
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
  try {
    const quota = await api("/quota");
    const pct = Math.min(100, Math.round((quota.used / quota.limit) * 100));
    const color = pct > 50 ? "var(--accent-red)" : pct > 20 ? "var(--accent-yellow)" : "var(--accent-green)";
    const valEl = document.getElementById("quota-value");
    const barEl = document.getElementById("quota-bar");
    if (valEl) valEl.innerHTML = `${quota.used}<span style="font-size:0.7rem;opacity:0.6"> / ${quota.limit}</span>`;
    if (barEl) { barEl.style.width = `${pct}%`; barEl.style.background = color; }
  } catch { /* ignore */ }
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

async function loadSettings() {
  try {
    const settings = await api("/settings");
    for (const key of SETTINGS_KEYS) {
      const el = document.getElementById(`set-${key}`);
      if (el) el.value = settings[key] || "";
    }
    toggleLLMFields();
    loadLLMHealth();
  } catch (err) {
    console.error("[loadSettings]", err);
    showToast("Erreur de chargement des settings", "error");
  }
}

function toggleLLMFields() {
  const provider = document.getElementById("set-llm_provider")?.value;
  document.getElementById("ollama-fields")?.classList.toggle("d-none", provider !== "ollama");
  document.getElementById("lmstudio-fields")?.classList.toggle("d-none", provider !== "lmstudio");
  document.getElementById("openrouter-fields")?.classList.toggle("d-none", provider !== "openrouter");
}

async function saveSettings() {
  const body = {};
  for (const key of SETTINGS_KEYS) {
    const el = document.getElementById(`set-${key}`);
    if (el) body[key] = el.value;
  }

  try {
    await api("/settings", { method: "POST", body: JSON.stringify(body) });
    showToast("Settings sauvegardees", "success");
    loadLLMHealth();
  } catch (err) {
    showToast("Erreur: " + err.message, "error");
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

  try {
    const data = await api("/discover/related", {
      method: "POST",
      timeout: 300000,
    });

    if (data.found === 0) {
      status.innerHTML = '<p class="text-muted" style="font-size:0.88rem">Aucune nouvelle chaine similaire trouvee. Ajoute plus de chaines validees pour enrichir la decouverte.</p>';
      return;
    }

    status.innerHTML = `<span style="color:var(--accent-green)"><i class="bi bi-check-circle"></i> ${data.found} chaines francaises trouvees</span>`;

    results.innerHTML = data.channels.map((ch) => `
      <div class="discover-result" id="rel-${ch.channelId}">
        <div class="dr-avatar">
          ${ch.thumbnail ? `<img src="${ch.thumbnail}" alt="">` : '<i class="bi bi-person"></i>'}
        </div>
        <div class="dr-info">
          <a href="https://youtube.com/channel/${ch.channelId}" target="_blank" class="dr-name" style="text-decoration:none;color:inherit">${escapeHtml(ch.nom)} <i class="bi bi-box-arrow-up-right" style="font-size:0.65rem;opacity:0.4"></i></a>
          <div class="dr-stats">
            <i class="bi bi-people"></i> ${formatNumber(ch.subscriberCount)} abonnes
            <span class="status-badge pending" style="margin-left:8px">en attente</span>
            <span class="text-muted" style="margin-left:6px;font-size:0.75rem"><i class="bi bi-diagram-2"></i> via ${escapeHtml(ch.source_channel || "")}</span>
          </div>
        </div>
        <div class="dr-actions" style="display:flex;gap:4px;flex-shrink:0">
          <button class="btn btn-success-glass btn-sm" onclick="event.stopPropagation();quickValidate('${escapeInlineJs(ch.channelId)}', this)" title="Valider" style="padding:4px 8px;font-size:0.7rem">
            <i class="bi bi-check-lg"></i>
          </button>
          <button class="btn btn-danger-glass btn-sm" onclick="event.stopPropagation();quickReject('${escapeInlineJs(ch.channelId)}', '${escapeInlineJs(ch.nom)}', this)" title="Rejeter" style="padding:4px 8px;font-size:0.7rem">
            <i class="bi bi-x-lg"></i>
          </button>
        </div>
      </div>
    `).join("");

    // Re-fetch stats after adding channels
    loadStats();
  } catch (err) {
    status.innerHTML = `<span style="color:var(--accent-red)"><i class="bi bi-exclamation-circle"></i> Erreur: ${err.message}</span>`;
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
    document.getElementById("detail-ch-link").href = `https://youtube.com/channel/${ch.channel_id}`;

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
          ${ch.thumbnail ? `<img src="${ch.thumbnail}" alt="">` : '<i class="bi bi-person"></i>'}
        </div>
        <div class="dr-info">
          <a href="https://youtube.com/channel/${ch.channelId}" target="_blank" class="dr-name" style="text-decoration:none;color:inherit;font-size:0.88rem">${escapeHtml(ch.nom)}</a>
        </div>
        <div class="dr-actions">
          <button class="btn btn-sm-glass" onclick="event.stopPropagation();addRelatedChannel('${escapeInlineJs(ch.channelId)}', '${escapeInlineJs(ch.nom)}')" title="Ajouter" style="padding:3px 8px;font-size:0.7rem">
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
      ${v.thumbnail ? `<img src="${v.thumbnail}" alt="">` : ""}
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
