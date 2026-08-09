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
  const n = Number(value || 0);
  if (n < 1000) return String(n);
  // Compact style: 1 décimale + unité (ex. 11,7k+). Le séparateur décimal est
  // une virgule (fr-FR). Le "+" signale que la valeur est arrondie.
  if (n < 999500) return (n / 1000).toFixed(1).replace(".", ",") + "k+";
  return (n / 1_000_000).toFixed(1).replace(".", ",") + "M+";
}

function renderStatsLoading(container) {
  container.innerHTML = `
    <div class="col-12">
      <section class="stats-overview stats-overview-loading" aria-label="Chargement des statistiques">
        <div class="stats-overview-head">
          <div class="stats-heading-skeleton"></div>
        </div>
        <div class="stats-grid">
          ${Array.from({ length: 3 }, () => '<div class="stat-card stat-card-skeleton"><span></span><b></b><i></i></div>').join("")}
        </div>
      </section>
    </div>`;
}

// --- RSS schedule display helpers ---

function formatCountdown(ms) {
  if (ms == null || !Number.isFinite(ms)) return "—";
  if (ms <= 0) return "à l'instant";
  const totalMin = Math.ceil(ms / 60000);
  if (totalMin < 2) return "<1 min";
  if (totalMin < 60) return `${totalMin} min`;
  const h = Math.floor(totalMin / 60);
  const m = totalMin % 60;
  if (h < 24) return m > 0 ? `${h}h ${String(m).padStart(2, "0")}` : `${h}h`;
  return `${Math.floor(h / 24)}j ${h % 24}h`;
}

function formatTimeAgo(ms) {
  if (ms == null || !Number.isFinite(ms) || ms <= 0) return "jamais";
  const diff = Date.now() - ms;
  if (diff < 60000) return "à l'instant";
  const min = Math.floor(diff / 60000);
  if (min < 60) return `il y a ${min} min`;
  const h = Math.floor(min / 60);
  if (h < 24) return `il y a ${h}h`;
  const d = Math.floor(h / 24);
  if (d < 7) return `il y a ${d}j`;
  return `il y a ${Math.floor(d / 7)} sem`;
}

let rssCountdownTimer = null;
let rssStatsSyncAt = 0;
let rssStatsSyncPromise = null;

function syncRssStats() {
  if (rssStatsSyncPromise) return rssStatsSyncPromise;
  rssStatsSyncAt = Date.now();
  rssStatsSyncPromise = loadStats().finally(() => {
    rssStatsSyncPromise = null;
  });
  return rssStatsSyncPromise;
}

function updateRssCountdown() {
  const card = document.querySelector(".stats-card--rss");
  if (!card) {
    if (rssCountdownTimer) { clearInterval(rssCountdownTimer); rssCountdownTimer = null; }
    return;
  }
  const running = card.dataset.running === "1";
  const nextAt = Number(card.dataset.next) || 0;
  const lastAt = Number(card.dataset.last) || 0;
  const valueEl = card.querySelector(".stat-value");
  const detailEl = card.querySelector(".stat-detail");
  if (!valueEl || !detailEl) return;
  if (running) {
    valueEl.textContent = "En cours…";
    detailEl.textContent = "Rafraîchissement des flux";
    if (Date.now() - rssStatsSyncAt > 30000) syncRssStats();
    return;
  }
  const remaining = nextAt ? nextAt - Date.now() : null;
  valueEl.textContent = formatCountdown(remaining);
  detailEl.textContent = `Dernier : ${formatTimeAgo(lastAt)}`;
  // The cron publishes a new nextRunAt after the job finishes. Refresh the
  // schedule when the displayed deadline is reached instead of getting stuck.
  if (remaining != null && remaining <= 0 && Date.now() - rssStatsSyncAt > 10000) syncRssStats();
  // Keep the last-run label accurate even when the countdown is long.
  else if (Date.now() - rssStatsSyncAt > 60000) syncRssStats();
}

function scheduleRssCountdown() {
  if (rssCountdownTimer) return;
  rssCountdownTimer = setInterval(updateRssCountdown, 15000);
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
    const total = Number(stats.total_channels) || 0;
    const videos = Number(stats.total_videos) || 0;
    const validPct = total > 0 ? Math.min(100, Math.max(0, Math.round((validated / total) * 100))) : 0;
    const rejectedPct = total > 0 ? Math.min(100, Math.max(0, (rejected / total) * 100)) : 0;
    const rss = stats.rss || {};
    const rssRunning = Boolean(stats.refreshRunning);
    const nextAt = Number(rss.nextRunAt) || 0;
    const lastAt = Number(rss.lastRunAt) || 0;

    container.innerHTML = `
      <div class="col-12">
        <section class="stats-overview" aria-label="Vue d'ensemble des statistiques">
          <div class="stats-overview-head">
            <div>
              <span class="stats-eyebrow"><i class="bi bi-bar-chart-line-fill"></i> Tableau de bord</span>
              <h2 class="stats-overview-title">Vue d'ensemble</h2>
            </div>
            <span class="stats-overview-subtitle">Ta bibliothèque en un coup d'œil</span>
          </div>

          <div class="stats-grid">
            <article class="stat-card stats-card--overview">
              <div class="stats-card-top">
                <span class="stats-card-icon"><i class="bi bi-check2-circle"></i></span>
                <span class="stats-card-kicker">Suivi des chaînes</span>
                <span class="stats-overview-total">${formatStatCount(total)} au total</span>
              </div>
              <div class="stats-overview-main">
                <div class="stats-overview-primary">
                  <div class="stat-value">${formatStatCount(validated)}</div>
                  <div class="stat-label">chaînes validées <span>sur ${formatStatCount(total)}</span></div>
                </div>
                <div class="stats-overview-share">
                  <strong>${validPct}%</strong>
                  <span>de ta bibliothèque</span>
                </div>
              </div>
              <div class="stat-progress" role="progressbar" aria-label="Part des chaînes validées sur le total" aria-valuenow="${validPct}" aria-valuemin="0" aria-valuemax="100"><div style="width:${validPct}%"></div></div>
              <div class="stats-overview-breakdown">
                <div class="stats-overview-metric stats-overview-metric--rejected">
                  <strong>${formatStatCount(rejected)}</strong>
                  <span>rejetées <em>${rejectedPct.toFixed(1)}%</em></span>
                </div>
                <span class="stats-overview-divider" aria-hidden="true"></span>
                <div class="stats-overview-metric stats-overview-metric--pending">
                  <strong>${formatStatCount(pending)}</strong>
                  <span>en attente</span>
                </div>
              </div>
            </article>
            <article class="stat-card stats-card--compact stats-card--videos">
              <div class="stats-compact-header">
                <span class="stats-card-kicker">Feed</span>
                <span class="stats-card-icon"><i class="bi bi-camera-reels-fill"></i></span>
              </div>
              <div class="stat-value stats-compact-value">${formatStatCount(videos)}</div>
              <div class="stats-compact-footer">
                <span class="stats-detail-compact">Ton feed vidéo</span>
                <span class="stats-label-compact">Vidéos suivies</span>
              </div>
            </article>
            <article class="stat-card stats-card--compact stats-card--rss" data-next="${nextAt}" data-last="${lastAt}" data-running="${rssRunning ? 1 : 0}">
              <div class="stats-compact-header">
                <span class="stats-card-kicker">Automatique</span>
                <span class="stats-card-icon"><i class="bi bi-rss"></i></span>
              </div>
              <div class="stats-detail stats-detail-compact">${rssRunning ? "Rafraîchissement des flux" : `Dernier : ${formatTimeAgo(lastAt)}`}</div>
              <div class="stat-value stats-compact-value">${rssRunning ? "En cours…" : formatCountdown(nextAt ? nextAt - Date.now() : null)}</div>
              <div class="stats-compact-footer">
                <span class="stats-label-compact">Prochain refresh RSS <button class="stat-card-action" type="button" onclick="event.stopPropagation();refreshRSS()" title="Actualiser les flux maintenant" aria-label="Actualiser les flux RSS maintenant"><i class="bi bi-arrow-clockwise"></i></button></span>
              </div>
            </article>
          </div>
        </section>
      </div>`;
    container.dataset.loaded = "true";
    scheduleRssCountdown();
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
            <button class="seen-toggle-btn" onclick="toggleVideoSeen('${escapeInlineJs(v.url)}', event)" title="${seenClass ? 'Marquer comme non vu' : 'Marquer comme vu'}">
              <i class="bi ${seenClass ? 'bi-eye-slash-fill' : 'bi-eye-fill'}"></i>
            </button>
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
  const savedScrollY = window.scrollY;

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

    if (reset) {
      grid.innerHTML = html;
      requestAnimationFrame(() => window.scrollTo(0, savedScrollY));
    } else {
      grid.insertAdjacentHTML("beforeend", html);
    }

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
  list.innerHTML = '<div class="text-center py-4"><div class="spinner-glass"></div></div>';

  try {
    const filter = document.getElementById("channel-filter").value;
    const sort = document.getElementById("channel-sort").value;
    const params = new URLSearchParams({ include: "topics,preview" });
    if (filter) params.set("status", filter);
    if (sort) params.set("sort", sort);
    _allChannels = await api(`/channels?${params.toString()}`);
    updateChannelsCount(_allChannels.length);
    updateChannelsRssBadge();
    renderChannels();
  } catch (err) {
    console.error("[loadChannels]", err);
    list.innerHTML = '<div class="empty-state"><i class="bi bi-exclamation-triangle"></i><h5>Erreur de chargement</h5><p>' + escapeHtml(err.message) + '</p></div>';
  }
}

function updateChannelsCount(count) {
  const el = document.getElementById("channels-count");
  if (el) el.textContent = `${count} chaîne${count === 1 ? "" : "s"}`;
}

async function updateChannelsRssBadge() {
  const el = document.getElementById("channels-rss-badge");
  if (!el) return;
  try {
    const res = await api("/rss-info");
    if (res.lastRunAt) {
      el.innerHTML = `<i class="bi bi-rss"></i> ${formatTimeAgo(res.lastRunAt)}`;
      el.title = `Dernier refresh RSS: ${new Date(res.lastRunAt).toLocaleString()}`;
    } else {
      el.textContent = "";
    }
  } catch {
    el.textContent = "";
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

let channelSearchDebounce = null;
let channelSearchSeq = 0;

function filterChannels() {
  clearTimeout(channelSearchDebounce);
  channelSearchDebounce = setTimeout(() => {
    const q = document.getElementById("channel-search").value.trim();
    searchChannels(q);
  }, 150);
}

async function searchChannels(q) {
  const seq = ++channelSearchSeq;
  if (!q) return renderChannels("");
  const filter = document.getElementById("channel-filter").value;
  let serverMatches = null;
  try {
    const params = new URLSearchParams({ include: "topics,preview", q });
    if (filter) params.set("status", filter);
    serverMatches = await api(`/channels?${params.toString()}`);
  } catch (err) {
    console.error("[searchChannels]", err);
    serverMatches = null;
  }
  // Ignore stale responses: a newer keystroke may have superseded this one.
  if (seq !== channelSearchSeq) return;
  // Server-side FTS5 gave candidates: re-rank them with fuzzy to keep fuzzy behavior.
  // Otherwise fall back to local fuzzy over the cached list (typos / very short queries).
  if (Array.isArray(serverMatches) && serverMatches.length > 0) {
    renderChannels(q, serverMatches);
  } else {
    renderChannels(q, _allChannels);
  }
}

const CHANNEL_RENDER_CAP = 200;

function renderChannels(searchQuery, channels = _allChannels) {
  const list = document.getElementById("channels-list");
  const compact = document.getElementById("channels-compact");

  if (searchQuery) {
    const results = channels.map((ch) => ({ ch, ...fuzzyMatch(ch.nom, searchQuery) })).filter((r) => r.match);
    results.sort((a, b) => b.score - a.score);
    channels = results.map((r) => r.ch);
  }

  updateChannelsCount(channels.length);

  // Compact mode
  if (channelsCompactMode && !searchQuery) {
    list.classList.add("d-none");
    compact.classList.remove("d-none");
    if (channels.length === 0) {
      compact.innerHTML = '<div class="empty-state"><i class="bi bi-search"></i><h5>Aucune chaine</h5></div>';
    } else {
      compact.innerHTML = renderCompactTable(channels);
    }
    return;
  }

  list.classList.remove("d-none");
  compact.classList.add("d-none");

  if (channels.length === 0) {
    list.innerHTML = `
      <div class="empty-state">
        <i class="bi bi-search"></i>
        <h5>Aucun resultat</h5>
        <p>${searchQuery ? 'Aucune chaine ne correspond a "' + escapeHtml(searchQuery) + '".' : 'Aucune chaine.'}</p>
      </div>`;
    return;
  }

  const shown = channels.slice(0, CHANNEL_RENDER_CAP);
  const hiddenCount = channels.length - shown.length;

  list.innerHTML = shown
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
            ${ch.video_count != null ? `<span><i class="bi bi-camera-reels"></i> ${ch.video_count} vidéo${ch.video_count === 1 ? "" : "s"}</span>` : ""}
            <span><i class="bi bi-calendar3"></i> ${formatDate(ch.date_ajout)}</span>
            ${isNewChannel(ch) ? '<span class="status-badge" style="background:rgba(52,211,153,0.15);color:var(--accent-green);animation:pulse-new 2s ease-in-out infinite">New</span>' : ""}
          </div>
          ${ch.llm_summary || ch.description ? `<div class="llm-summary${ch.llm_summary ? "" : " fallback"}">${escapeHtml(ch.llm_summary || ch.description)}</div>` : ""}
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
                : ch.status === "rejected"
                  ? `<div class="ch-actions-row">
              <button class="btn btn-success-glass btn-sm" onclick="validateChannel(${ch.id})" title="Valider cette chaîne rejetée">
                <i class="bi bi-check-lg"></i> Valider
              </button>
            </div>
            <div class="ch-actions-divider"></div>`
                  : ""
          }
          <div class="ch-actions-row">
            <button class="btn btn-sm-glass btn-sm" onclick="window.open('https://youtube.com/channel/${safeChannelId(ch.channel_id)}/videos','_blank')" title="Voir les vidéos sur YouTube">
              <i class="bi bi-youtube"></i> Voir
            </button>
          </div>
        </div>
      </div>`
    )
    .join("")
    + (hiddenCount > 0
      ? `<div class="text-center text-muted py-3" style="font-size:0.78rem">${hiddenCount} autre${hiddenCount > 1 ? "s" : ""} chaîne${hiddenCount > 1 ? "s" : ""} — affines ta recherche pour en voir plus</div>`
      : "");

  if (searchQuery) {
    new Mark(list).mark(searchQuery, {
      element: "mark",
      className: "",
      accuracy: "partially",
      separateWordSearch: false,
    });
  }

  channels.forEach((ch) => {
    renderChannelTopicBadges(ch.id, ch.topics || [], ch.nom);
    if (ch.status === "pending") renderChannelPreview(ch.id, ch.preview_videos || []);
  });
}

function isNewChannel(ch) {
  if (!ch.date_ajout) return false;
  const added = new Date(ch.date_ajout.replace(" ", "T") + (ch.date_ajout.includes("Z") ? "" : "Z"));
  if (isNaN(added.getTime())) return false;
  return (Date.now() - added.getTime()) < 24 * 60 * 60 * 1000;
}

let channelsCompactMode = false;

function toggleChannelsCompact() {
  channelsCompactMode = !channelsCompactMode;
  const btn = document.getElementById("channels-compact-btn");
  if (btn) btn.innerHTML = channelsCompactMode ? '<i class="bi bi-grid-3x3-gap"></i>' : '<i class="bi bi-list-ul"></i>';
  renderChannels();
}

function setCompactSort(sort) {
  document.getElementById("channel-sort").value = sort;
  loadChannels();
}

function renderCompactTable(channels) {
  return `
    <div class="glass-card" style="overflow-x:auto">
      <table class="compact-channels-table">
        <thead>
          <tr>
            <th style="cursor:pointer" onclick="setCompactSort('name')" title="Trier par nom">Chaîne</th>
            <th>Statut</th>
            <th style="cursor:pointer" onclick="setCompactSort('score')" title="Trier par score">Score</th>
            <th style="cursor:pointer" onclick="setCompactSort('subs')" title="Trier par abonnés">Abonnés</th>
            <th>Vidéos</th>
            <th style="cursor:pointer" onclick="setCompactSort('date_desc')" title="Trier par date">Ajoutée</th>
            <th></th>
          </tr>
        </thead>
        <tbody>
          ${channels.slice(0, CHANNEL_RENDER_CAP).map(ch => `
            <tr class="${isNewChannel(ch) ? 'ch-row-new' : ''}" style="cursor:pointer" onclick="openChannelDetail(${ch.id})">
              <td>
                <div class="d-flex align-items-center gap-2">
                  ${ch.thumbnail ? `<img src="${safeImageUrl(ch.thumbnail)}" alt="" style="width:28px;height:28px;border-radius:50%;object-fit:cover">` : ''}
                  <span class="fw-medium">${escapeHtml(ch.nom)}</span>
                  ${isNewChannel(ch) ? '<span class="status-badge" style="background:rgba(52,211,153,0.15);color:var(--accent-green);font-size:0.65rem">New</span>' : ''}
                </div>
              </td>
              <td><span class="status-badge ${ch.status}" style="font-size:0.7rem">${ch.status}</span></td>
              <td>${ch.llm_score != null ? `<span class="llm-score ${ch.llm_score >= 70 ? 'high' : ch.llm_score >= 40 ? 'medium' : 'low'}" style="font-size:0.75rem">${ch.llm_score}/100</span>` : '—'}</td>
              <td>${formatNumber(ch.subscriber_count)}</td>
              <td>${ch.video_count ?? '—'}</td>
              <td style="font-size:0.78rem;color:var(--text-muted)">${formatDate(ch.date_ajout)}</td>
              <td>
                ${ch.status === 'pending' ? `<button class="btn btn-success-glass btn-sm" onclick="event.stopPropagation();validateChannel(${ch.id})" style="padding:2px 8px;font-size:0.68rem"><i class="bi bi-check-lg"></i></button>` : ''}
                <button class="btn btn-sm-glass btn-sm" onclick="event.stopPropagation();window.open('https://youtube.com/channel/${safeChannelId(ch.channel_id)}/videos','_blank')" style="padding:2px 6px;font-size:0.68rem"><i class="bi bi-youtube"></i></button>
              </td>
            </tr>
          `).join("")}
        </tbody>
      </table>
      ${channels.length > CHANNEL_RENDER_CAP ? `<div class="text-center text-muted py-2" style="font-size:0.75rem">${channels.length - CHANNEL_RENDER_CAP} autre${channels.length - CHANNEL_RENDER_CAP > 1 ? 's' : ''} chaîne${channels.length - CHANNEL_RENDER_CAP > 1 ? 's' : ''} — affines ta recherche</div>` : ''}
    </div>`;
}

function downloadTextFile(content, filename, mime) {
  const blob = new Blob([content], { type: mime });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

// Prevent CSV formula injection (Excel interprets =, +, -, @ as formulas).
function csvEscape(value) {
  let s = String(value ?? "");
  if (/^[=+\-@]/.test(s)) s = `'${s}`;
  return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

async function exportChannels(format) {
  try {
    // Toutes les chaines, quel que soit le filtre courant
    const channels = await api("/channels");
    const rows = channels.map((ch) => {
      const id = safeChannelId(ch.channel_id);
      return {
        nom: ch.nom || "",
        url: id ? `https://youtube.com/channel/${id}` : "",
      };
    }).filter((r) => r.url);
    if (!rows.length) return showToast("Aucune chaine a exporter", "info");

    const date = new Date().toISOString().slice(0, 10);
    if (format === "csv") {
      const header = "nom,url";
      const lines = rows.map((r) => `${csvEscape(r.nom)},${csvEscape(r.url)}`);
      downloadTextFile("\uFEFF" + [header, ...lines].join("\n"), `youfind-chaines-${date}.csv`, "text/csv;charset=utf-8");
    } else {
      downloadTextFile(JSON.stringify(rows, null, 2), `youfind-chaines-${date}.json`, "application/json;charset=utf-8");
    }
    showToast(`Export ${format.toUpperCase()} : ${rows.length} chaines`, "success");
  } catch (err) {
    showToast("Erreur export : " + err.message, "error");
  }
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

    grid.innerHTML = topics.map((t, i) => `
      <div class="topic-card-modern topic-card" draggable="true" data-topic-id="${t.id}" data-topic-index="${i}">
        <span class="topic-card-grip" title="Glisser pour réordonner"><i class="bi bi-grip-vertical"></i></span>
        <button class="topic-card-main" type="button" onclick="discoverTopic('${escapeInlineJs(t.nom)}')" title="Explorer ${escapeHtml(t.nom)}">
          <span class="topic-card-icon"><i class="bi bi-hash"></i></span>
          <span class="topic-card-copy"><strong>${escapeHtml(t.nom)}</strong>${t.description ? `<small>${escapeHtml(t.description)}</small>` : ""}</span>
          <i class="bi bi-arrow-up-right topic-card-arrow"></i>
        </button>
        <button class="topic-card-delete" type="button" onclick="deleteTopic(${t.id})" title="Supprimer ${escapeHtml(t.nom)}" aria-label="Supprimer ${escapeHtml(t.nom)}"><i class="bi bi-trash3"></i></button>
      </div>`).join("");

    initTopicDragDrop(grid);
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

async function initTopicDragDrop(grid) {
  let draggedEl = null;

  grid.querySelectorAll('.topic-card').forEach(card => {
    card.addEventListener('dragstart', (e) => {
      draggedEl = card;
      card.classList.add('dragging');
      e.dataTransfer.effectAllowed = 'move';
      e.dataTransfer.setData('text/plain', card.dataset.topicId);
    });

    card.addEventListener('dragend', () => {
      card.classList.remove('dragging');
      grid.querySelectorAll('.drag-over').forEach(c => c.classList.remove('drag-over'));
      draggedEl = null;
    });

    card.addEventListener('dragover', (e) => {
      e.preventDefault();
      e.dataTransfer.dropEffect = 'move';
      if (card !== draggedEl) card.classList.add('drag-over');
    });

    card.addEventListener('dragleave', () => {
      card.classList.remove('drag-over');
    });

    card.addEventListener('drop', async (e) => {
      e.preventDefault();
      card.classList.remove('drag-over');
      if (card === draggedEl || !draggedEl) return;

      const cards = [...grid.querySelectorAll('.topic-card')];
      const fromIndex = cards.indexOf(draggedEl);
      const toIndex = cards.indexOf(card);
      if (fromIndex < 0 || toIndex < 0) return;

      // Reorder DOM
      if (fromIndex < toIndex) {
        card.after(draggedEl);
      } else {
        card.before(draggedEl);
      }

      // Save new order to server
      const newCards = [...grid.querySelectorAll('.topic-card')];
      const order = newCards.map((c, i) => ({ id: Number(c.dataset.topicId), display_order: i }));
      try {
        await api('/topics', { method: 'PATCH', body: JSON.stringify({ order }) });
      } catch (err) {
        console.error('[TopicReorder]', err);
      }
    });
  });
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

function updateScoreProgress(data, labelText, prefix = "score") {
  const progress = document.getElementById(`${prefix}-progress`);
  const label = document.getElementById(`${prefix}-progress-label`);
  const count = document.getElementById(`${prefix}-progress-count`);
  const bar = document.getElementById(`${prefix}-progress-bar`);
  const detail = document.getElementById(`${prefix}-progress-detail`);
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
    let dt = `${data.scored || 0} chaîne${data.scored === 1 ? "" : "s"} scorée${data.scored === 1 ? "" : "s"}`;
    if (data.failed) {
      dt += ` · ${data.failed} échec${data.failed === 1 ? "" : "s"}`;
      const failures = Array.isArray(data.failures) ? data.failures : [];
      if (failures.length === 1) {
        dt += ` (${failures[0].channel}: ${failures[0].reason})`;
      }
    }
    detail.textContent = dt;
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

async function runScoreJob(endpoint, labelText, successText, prefix = "score") {
  if (isScoreProgressRunning) {
    showToast("Un scoring est déjà en cours...", "info");
    return;
  }
  isScoreProgressRunning = true;

  const status = document.getElementById(`${prefix}-status`);
  const scopeId = prefix === "score" ? "page-discover" : "page-related";
  const buttons = document.querySelectorAll(`#${scopeId} button[onclick^="score"], #${scopeId} button[onclick^="rescore"]`);
  buttons.forEach((button) => { button.disabled = true; });
  status.innerHTML = `<span class="spinner-glass"></span> ${escapeHtml(labelText)}`;
  updateScoreProgress({ status: "running", total: 0, completed: 0, scored: 0 }, labelText, prefix);

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
      updateScoreProgress(data, labelText, prefix);

      if (data.status === "done") {
        const failures = Array.isArray(data.failures) ? data.failures : [];
        let msg = `<span style="color:var(--accent-green)"><i class="bi bi-check-circle"></i> ${successText}: ${data.scored || 0} chaine${data.scored === 1 ? "" : "s"}`;
        if (failures.length > 0) {
          msg += ` · <span style="color:var(--accent-yellow)">${failures.length} échec${failures.length === 1 ? "" : "s"}</span>`;
          console.groupCollapsed(`[Scoring] ${failures.length} échec${failures.length === 1 ? "" : "s"} de scoring`);
          failures.forEach((f) => console.log(`${f.channel}: ${f.reason}`));
          console.groupEnd();
        }
        msg += '</span>';
        status.innerHTML = msg;
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
    updateScoreProgress(lastStatus || { status: "error", error: err.message, total: 0, completed: 0, scored: 0 }, labelText, prefix);
    status.innerHTML = `<span style="color:var(--accent-red)"><i class="bi bi-exclamation-circle"></i> Erreur: ${escapeHtml(err.message)}</span>`;
  } finally {
    isScoreProgressRunning = false;
    buttons.forEach((button) => { button.disabled = false; });
  }
}

function scoreAll() {
  return runScoreJob("/score-all", "Scoring des chaînes en attente...", "Chaînes scorées");
}

function scoreAllUnscored(prefix = "score") {
  return runScoreJob("/score-unscored", "Scoring des chaînes non scorées...", "Chaînes scorées", prefix);
}

function rescoreAll() {
  return runScoreJob("/rescore-all", "Rescore de toutes les chaînes...", "Chaînes rescorrées");
}

async function scoreSingle(channelId, elemId) {
  const card = document.getElementById(`ch-${elemId}`);
  const scoreBtn = card?.querySelector(`button[onclick*="scoreSingle"]`);
  const originalHTML = scoreBtn?.innerHTML;
  if (scoreBtn) {
    scoreBtn.disabled = true;
    scoreBtn.innerHTML = '<span class="spinner-glass"></span>';
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
    if (scoreBtn) {
      scoreBtn.disabled = false;
      scoreBtn.innerHTML = originalHTML || '<i class="bi bi-stars"></i> Score';
    }
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
  btn.innerHTML = '<span class="spinner-glass"></span> Stats...';
  showToast("Mise a jour des stats en arriere-plan...", "info");

  try {
    await api("/channels/refresh-stats", { method: "POST" });
    // Poll progress
    const deadline = Date.now() + 30 * 60 * 1000;
    let failures = 0;
    while (Date.now() < deadline) {
      await new Promise(r => setTimeout(r, 1500));
      try {
        const prog = await api("/refresh-stats/status");
        failures = 0;
        if (prog.status === "done") {
          btn.innerHTML = `<i class="bi bi-check-circle"></i> ${prog.completed}/${prog.total}`;
          showToast("Stats mises a jour !", "success");
          break;
        }
        if (prog.status === "error") throw new Error("Refresh stats failed");
        btn.innerHTML = `<span class="spinner-glass"></span> ${prog.completed || 0}/${prog.total || "?"}`;
      } catch {
        failures++;
        if (failures >= 5) throw new Error("Connexion perdue");
      }
    }
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
  return runRefreshJob("rss");
}

async function refreshVideos() {
  return runRefreshJob("videos");
}

async function refreshPendingVideos() {
  return runRefreshJob("pending-videos");
}

async function runRefreshJob(mode) {
  const isVideos = mode === "videos";
  const isPendingVideos = mode === "pending-videos";
  const startPath = isVideos ? "/refresh-videos" : isPendingVideos ? "/refresh-pending-videos" : "/refresh";
  const statusPath = isVideos ? "/refresh-videos/status" : isPendingVideos ? "/refresh-pending-videos/status" : "/refresh/status";
  const btnId = isVideos ? "btn-refresh-videos" : isPendingVideos ? "btn-refresh-pending-videos" : "btn-refresh-rss";
  const btn = document.getElementById(btnId);
  const icon = btn?.querySelector(".btn-icon");
  icon?.classList.add("spinning");
  btn?.setAttribute("disabled", "true");
  btn?.setAttribute("aria-busy", "true");

  try {
    await api(startPath, { method: "POST" });
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
      status = await api(statusPath);
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
    watchRefreshInBackground({ statusPath, mode, btn, icon, banner, bar, count, detail });
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
  if (isPendingVideos) loadChannels();
  icon?.classList.remove("spinning");
  btn?.removeAttribute("disabled");
  btn?.removeAttribute("aria-busy");
}

async function watchRefreshInBackground({ statusPath, mode, btn, icon, banner, bar, count, detail }) {
  const watcherDeadline = Date.now() + 2 * 60 * 60 * 1000;
  while (Date.now() < watcherDeadline) {
    await new Promise((resolve) => setTimeout(resolve, 5000));
    let status;
    try {
      status = await api(statusPath);
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
    if (mode === "pending-videos") loadChannels();
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

let _seenCache = null;
let _seenLoaded = false;
let _seenLoadPromise = null;

async function loadSeenVideos() {
  if (_seenLoaded) return;
  if (_seenLoadPromise) return _seenLoadPromise;
  _seenLoadPromise = (async () => {
    try {
      const urls = await api("/watched");
      _seenCache = new Set(urls);
    } catch {
      // Fallback to localStorage
      try {
        _seenCache = new Set(JSON.parse(localStorage.getItem("youfind-seen") || "[]"));
      } catch {
        _seenCache = new Set();
      }
    }
    _seenLoaded = true;
    _seenLoadPromise = null;
  })();
  return _seenLoadPromise;
}

function getSeenVideos() {
  if (!_seenLoaded) return new Set();
  return _seenCache || new Set();
}

function markVideoSeen(url) {
  if (_seenCache) _seenCache.add(url);
  api("/watched", { method: "POST", body: JSON.stringify({ url }) }).catch(() => {});
}

function unmarkVideoSeen(url) {
  if (_seenCache) _seenCache.delete(url);
  api("/watched", { method: "DELETE", body: JSON.stringify({ url }) }).catch(() => {});
}

async function toggleVideoSeen(url, event) {
  event.stopPropagation();
  if (getSeenVideos().has(url)) {
    unmarkVideoSeen(url);
  } else {
    markVideoSeen(url);
  }
  // Update the card UI immediately
  const card = document.querySelector(`.video-card[data-video-url="${CSS.escape(url)}"]`);
  if (card) {
    const seen = getSeenVideos().has(url);
    card.classList.toggle("seen", seen);
    card.title = seen ? "Déjà vu" : "";
    const thumb = card.querySelector(".thumb-wrap");
    const badge = thumb?.querySelector(".seen-badge");
    if (seen && !badge) {
      const b = document.createElement("span");
      b.className = "seen-badge";
      b.innerHTML = '<i class="bi bi-check-circle-fill"></i> Vu';
      thumb?.appendChild(b);
    } else if (!seen && badge) {
      badge.remove();
    }
    // Toggle the eye button icon
    const btn = card.querySelector(".seen-toggle-btn");
    if (btn) {
      btn.innerHTML = seen ? '<i class="bi bi-eye-slash-fill"></i>' : '<i class="bi bi-eye-fill"></i>';
      btn.title = seen ? "Marquer comme non vu" : "Marquer comme vu";
    }
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

async function exportBackup() {
  try {
    const data = await api("/export");
    const blob = new Blob([JSON.stringify(data, null, 2)], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `youfind-backup-${new Date().toISOString().slice(0, 10)}.json`;
    a.click();
    URL.revokeObjectURL(url);
    showToast("Backup exporté !", "success");
  } catch (err) {
    showToast("Erreur export: " + err.message, "error");
  }
}

async function importBackup(file) {
  if (!file) return;
  const status = document.getElementById("import-backup-status");
  status.innerHTML = '<span class="spinner-glass"></span> Import en cours...';
  try {
    const text = await file.text();
    const body = JSON.parse(text);
    const result = await api("/import", { method: "POST", body: JSON.stringify(body), timeout: 60000 });
    status.innerHTML = `<span style="color:var(--accent-green)"><i class="bi bi-check-circle"></i> ${result.imported.channels} chaînes, ${result.imported.topics} topics, ${result.imported.watched} vidéos vues, ${result.imported.settings} réglages importés</span>`;
    showToast("Import terminé !", "success");
    loadSettings();
    loadTopics();
    _seenLoaded = false;
    loadSeenVideos();
  } catch (err) {
    status.innerHTML = `<span style="color:var(--accent-red)">Erreur: ${escapeHtml(err.message)}</span>`;
  }
  document.getElementById("import-backup-input").value = "";
}

// --- Player control bindings ---
document.addEventListener("DOMContentLoaded", () => {
  const backdrop = document.getElementById("playerBackdrop");
  const closeBtn = document.getElementById("playerClose");

  closeBtn.addEventListener("click", closePlayer);
  backdrop.addEventListener("click", (e) => { if (e.target === backdrop) closePlayer(); });
  document.addEventListener("keydown", (e) => { if (e.key === "Escape") closePlayer(); });

  // Preload watched videos from DB in the background
  loadSeenVideos();
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
  const status = document.getElementById("llm-health");
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
let relatedJobId = null;

function showRelatedControls(running) {
  document.getElementById('related-btn').classList.toggle('d-none', running);
  document.getElementById('related-cancel-btn').classList.toggle('d-none', !running);
  document.getElementById('related-pause-btn').classList.toggle('d-none', !running);
}

function resetRelatedPauseButton() {
  const btn = document.getElementById('related-pause-btn');
  btn.innerHTML = '<i class="bi bi-pause-fill"></i> Pause';
}

async function cancelRelatedDiscovery() {
  try {
    await api('/discover/related/cancel', { method: 'POST' });
    showToast('Exploration annulée', 'info');
  } catch (err) {
    showToast('Erreur: ' + err.message, 'error');
  }
}

async function toggleRelatedPause() {
  const btn = document.getElementById('related-pause-btn');
  try {
    const res = await api('/discover/related/pause', { method: 'POST' });
    if (res.paused) {
      btn.innerHTML = '<i class="bi bi-play-fill"></i> Reprendre';
    } else {
      btn.innerHTML = '<i class="bi bi-pause-fill"></i> Pause';
    }
  } catch (err) {
    showToast('Erreur: ' + err.message, 'error');
  }
}

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

// Run the related exploration once, streaming results into the container.
// `passes` duplicates each seed channel in the seed list so every channel
// is scraped `passes` times (Google's suggestions vary between fetches).
async function runRelatedPass({ status, results, passes, statuses }) {
  let cursor = 0;
  let lastStatus = null;
  let jobId = "";
  let pollFailures = 0;
  const pollingDeadline = Date.now() + 2 * 60 * 60 * 1000;
  const multi = (passes || 1) > 1;

  const startJob = () => api("/discover/related", {
    method: "POST",
    body: JSON.stringify({ passes: passes || 1, statuses }),
    timeout: 30000,
  });

  // The server rejects a second job while one is still releasing its lock.
  let started;
  try {
    started = await startJob();
  } catch (err) {
    if (!/in progress|409/i.test(err.message)) throw err;
    await new Promise((resolve) => setTimeout(resolve, 2000));
    started = await startJob();
  }
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
      status.innerHTML = `<span class="related-live-status"><i class="bi bi-broadcast-pin"></i> ${multi ? `Exploration x${passes} — ` : ""}${data.found} chaîne${data.found === 1 ? "" : "s"} affichée${data.found === 1 ? "" : "s"} en temps réel</span>`;
    }

    if (data.status === "done") {
      return { found: Number(data.found) || 0, lastStatus: data };
    }
    if (data.status === "cancelled") {
      return { found: Number(data.found) || 0, lastStatus: data, cancelled: true };
    }
    if (data.status === "error") {
      throw new Error(data.error || "Erreur pendant la découverte");
    }

    // Sync pause button state with server
    if (typeof data.paused === 'boolean') {
      const pauseBtn = document.getElementById('related-pause-btn');
      if (pauseBtn) {
        pauseBtn.innerHTML = data.paused
          ? '<i class="bi bi-play-fill"></i> Reprendre'
          : '<i class="bi bi-pause-fill"></i> Pause';
      }
    }
  }

  throw new Error("Le suivi a expiré après deux heures, mais la découverte peut continuer sur le serveur.");
}

async function runRelatedDiscovery() {
  if (isRelatedRunning) return showToast("Deja en cours...", "info");
  isRelatedRunning = true;

  const btn = document.getElementById("related-btn");
  const status = document.getElementById("related-status");
  const results = document.getElementById("related-results");
  const badge = document.getElementById("related-badge");

  showRelatedControls(true);
  resetRelatedPauseButton();

  const runsInput = document.getElementById("related-runs");
  const passes = Math.max(1, Math.min(10, parseInt(runsInput?.value || "1", 10) || 1));

  // Read selected statuses from the multi-select
  const statusSelect = document.getElementById("related-statuses");
  const statuses = statusSelect
    ? Array.from(statusSelect.selectedOptions).map(o => o.value)
    : ["validated"];

  btn.disabled = true;
  btn.innerHTML = '<span class="spinner-glass"></span> Exploration...';
  status.innerHTML = "";
  results.innerHTML = "";
  badge.style.display = "inline-flex";
  document.getElementById("related-progress")?.classList.remove("d-none");
  updateRelatedProgress({ status: "running", total: 0, completed: 0, found: 0 });

  let lastStatus = null;
  let wasCancelled = false;

  try {
    const pass = await runRelatedPass({ status, results, passes, statuses });
    lastStatus = pass.lastStatus;
    wasCancelled = pass.cancelled || false;

    if (wasCancelled) {
      status.innerHTML = '<p class="text-muted" style="font-size:0.88rem"><i class="bi bi-slash-circle"></i> Exploration annulée. ' + (pass.found || 0) + ' chaîne(s) trouvée(s) avant l\'annulation.</p>';
    } else if (pass.found === 0) {
      status.innerHTML = '<p class="text-muted" style="font-size:0.88rem">Aucune nouvelle chaine similaire trouvee. Ajoute plus de chaines ou elargis les statuts pour enrichir la decouverte.</p>';
    }
    if (!wasCancelled) {
      loadStats();
      scoreAllUnscored("related-score");
    }
  } catch (err) {
    updateRelatedProgress(lastStatus || { status: "error", error: err.message, total: 0, completed: 0, found: 0 });
    status.innerHTML = `<span style="color:var(--accent-red)"><i class="bi bi-exclamation-circle"></i> ${escapeHtml(err.message)}</span>`;
  } finally {
    isRelatedRunning = false;
    btn.disabled = false;
    btn.innerHTML = '<i class="bi bi-search"></i> Explorer les similaires';
    showRelatedControls(false);
    resetRelatedPauseButton();
  }
}

async function quickValidate(channelId, btn) {
  if (isRelatedRunning) return showToast("Attends la fin de l'exploration", "info");
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
  if (isRelatedRunning) return showToast("Attends la fin de l'exploration", "info");
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
let currentDetailChannel = null;
// Ordered queue of pending channels for the "valider/refuser + suivant" triage flow.
let detailQueue = null; // [{ id, nom }] in pending-list order
let detailQueueIndex = -1;
let detailPrefetch = null; // { id, data } prefetched for next channel

channelDetailModal._element.addEventListener("hidden.bs.modal", () => {
  detailQueue = null;
  detailQueueIndex = -1;
  detailPrefetch = null;
});

async function openChannelDetail(id, opts = {}) {
  // Starting a fresh triage session unless we are advancing inside the queue.
  if (!opts.keepQueue) {
    detailQueue = null;
    detailQueueIndex = -1;
  }
  document.getElementById("detail-ch-name").textContent = "Chargement...";
  document.getElementById("detail-ch-meta").textContent = "";
  document.getElementById("detail-ch-summary").innerHTML = "";
  document.getElementById("detail-ch-topics").innerHTML = "";
  document.getElementById("detail-ch-videos").innerHTML = '<div class="col-12 text-center py-3"><div class="spinner-glass"></div></div>';
  document.getElementById("detail-ch-related").innerHTML = '<div class="text-muted" style="font-size:0.85rem"><span class="spinner-glass"></span> Chargement...</div>';
  channelDetailModal.show();

  try {
    // Use prefetched data if available for this channel
    let data;
    if (detailPrefetch?.id === id) {
      data = detailPrefetch.data;
      detailPrefetch = null;
    } else {
      data = await api(`/channels/${id}/detail`);
    }
    const ch = data.channel;
    currentDetailChannel = { id, channel_id: ch.channel_id, nom: ch.nom, status: ch.status };

    // Triage buttons (valider/refuser + suivant) only make sense for pending channels.
    const isPending = ch.status === "pending";
    document.getElementById("btn-detail-accept-next")?.classList.toggle("d-none", !isPending);
    document.getElementById("btn-detail-reject-next")?.classList.toggle("d-none", !isPending);

    // Reset the refresh button state in case a previous run left it disabled.
    const refreshBtn = document.getElementById("btn-detail-refresh-videos");
    refreshBtn?.querySelector(".btn-icon")?.classList.remove("spinning");
    refreshBtn?.removeAttribute("disabled");
    refreshBtn?.removeAttribute("aria-busy");

    document.getElementById("detail-ch-thumb").src = ch.thumbnail || "";
    document.getElementById("detail-ch-name").textContent = ch.nom;
    document.getElementById("detail-ch-meta").textContent = `${formatNumber(ch.subscriber_count)} abonnes | ${ch.status}`;
    document.getElementById("detail-ch-link").href = `https://youtube.com/channel/${safeChannelId(ch.channel_id)}/videos`;

    const summaryText = ch.llm_summary || ch.description || "";
    if (summaryText) {
      document.getElementById("detail-ch-summary").innerHTML = `
        <div class="glass-card p-3">
          <div class="llm-score ${ch.llm_score >= 70 ? 'high' : ch.llm_score >= 40 ? 'medium' : 'low'} mb-1">${ch.llm_score != null ? ch.llm_score + '/100' : "Non score"}</div>
          <div class="llm-summary">${escapeHtml(summaryText)}</div>
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

    // Prefetch the next channel in the queue for instant "suivant"
    if (opts.keepQueue && detailQueue && detailQueueIndex + 1 < detailQueue.length) {
      const nextId = detailQueue[detailQueueIndex + 1].id;
      api(`/channels/${nextId}/detail`).then(data => {
        detailPrefetch = { id: nextId, data };
      }).catch(() => { detailPrefetch = null; });
    }
  } catch (err) {
    document.getElementById("detail-ch-name").textContent = "Erreur";
    document.getElementById("detail-ch-related").innerHTML = `<div class="text-muted">${err.message}</div>`;
  }
}

// Ordered list of pending channels, reusing the already-loaded list when the
// channels page is currently filtered on pending.
async function getPendingList() {
  const filter = document.getElementById("channel-filter")?.value;
  if (filter === "pending" && _allChannels.length) return _allChannels;
  return await api("/channels?status=pending");
}

async function ensureDetailQueue() {
  if (detailQueue) return;
  const list = await getPendingList();
  detailQueue = list.map((c) => ({ id: c.id, nom: c.nom }));
  detailQueueIndex = detailQueue.findIndex((c) => c.id === currentDetailChannel?.id);
}

// Advance the modal to the next pending channel in the queue; close it when
// the pending list is exhausted.
async function showNextInQueue() {
  await ensureDetailQueue();
  const next = detailQueue[detailQueueIndex + 1];
  if (!next) {
    showToast("Plus de chaines en attente", "info");
    channelDetailModal.hide();
    return;
  }
  detailQueueIndex++;
  await openChannelDetail(next.id, { keepQueue: true });
}

// Modal footer: validate the current channel, then open the next pending one.
async function acceptCurrentAndNext() {
  if (!currentDetailChannel) return;
  try {
    await ensureDetailQueue();
    await api(`/channels/${currentDetailChannel.id}/validate`, { method: "POST" });
    showToast("Chaine validee !", "success");
    loadChannels();
    loadStats();
    await showNextInQueue();
  } catch (err) {
    showToast("Erreur: " + err.message, "error");
  }
}

// Modal footer: reject the current channel with a preset reason, then open
// the next pending one — no reject modal.
async function openRejectAndNext() {
  if (!currentDetailChannel) return;
  const raison = "Pas interessant, hors topic";
  try {
    await ensureDetailQueue();
    await api(`/channels/${currentDetailChannel.id}/reject`, {
      method: "POST",
      body: JSON.stringify({ raison }),
    });
    showToast("Chaine rejetee: " + raison, "info");
    loadChannels();
    loadStats();
    await showNextInQueue();
  } catch (err) {
    showToast("Erreur: " + err.message, "error");
  }
}

// Deep-crawl the currently open channel: fetch its full backlog (up to 500
// videos) and add whatever is missing, then refresh the modal's video list.
async function refreshChannelVideos() {
  if (!currentDetailChannel) return;
  const btn = document.getElementById("btn-detail-refresh-videos");
  const icon = btn?.querySelector(".btn-icon");
  icon?.classList.add("spinning");
  btn?.setAttribute("disabled", "true");
  btn?.setAttribute("aria-busy", "true");

  try {
    const result = await api(`/ingest/${currentDetailChannel.channel_id}/deep`, {
      method: "POST",
      timeout: 10 * 60 * 1000,
    });
    showToast(
      `Refresh videos : ${result.added} vidéo${result.added > 1 ? "s" : ""} ajoutée${result.added > 1 ? "s" : ""} (${result.total} trouvées)`,
      "success"
    );
    await reloadChannelDetailVideos(currentDetailChannel.id);
  } catch (err) {
    showToast("Erreur refresh videos : " + err.message, "error");
  } finally {
    icon?.classList.remove("spinning");
    btn?.removeAttribute("disabled");
    btn?.removeAttribute("aria-busy");
  }
}

async function reloadChannelDetailVideos(id) {
  try {
    const data = await api(`/channels/${id}/detail`);
    document.getElementById("detail-ch-meta").textContent =
      `${formatNumber(data.channel.subscriber_count)} abonnes | ${data.channel.status}`;
    const container = document.getElementById("detail-ch-videos");
    if (data.videos.length === 0) {
      container.innerHTML = '<div class="col-12 text-muted text-center py-3" style="font-size:0.85rem">Aucune video</div>';
    } else {
      const seenSet = getSeenVideos();
      container.innerHTML = data.videos.map((v) => renderVideoCard(v, seenSet)).join("");
    }
  } catch { /* keep the current list if the reload fails */ }
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

// --- Scroll-to-top floating button ---
(function initScrollTopButton() {
  const btn = document.getElementById("scrollTopBtn");
  if (!btn) return;
  let ticking = false;
  const update = () => {
    btn.classList.toggle("visible", window.scrollY > 400);
    ticking = false;
  };
  window.addEventListener("scroll", () => {
    if (!ticking) {
      requestAnimationFrame(update);
      ticking = true;
    }
  }, { passive: true });
  btn.addEventListener("click", () => window.scrollTo({ top: 0, behavior: "smooth" }));
  update();
})();

// Fallback if stored page no longer exists
(async () => {
  if (!document.getElementById(`page-${currentPage}`)) {
    currentPage = "videos";
    localStorage.setItem("youfind-page", "videos");
  }
  // Wait for seen videos to load before rendering (avoids flash of un-watched state)
  await loadSeenVideos();
  navigateTo(currentPage);
  loadStats();
  loadLLMHealth();
  populateTopicFilter();
})();
