// YouFind videos page.

// ═══════════════════════════════════════════
//  PAGE: Videos
// ═══════════════════════════════════════════
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
  videoSearchDebounce = setTimeout(() => loadVideos(true), FRONTEND_DELAYS.VIDEO_SEARCH_DEBOUNCE_MS);
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

  let url = `/videos?limit=${FRONTEND_LIMITS.VIDEO_PAGE_SIZE}&offset=${videoOffset}&sort=${sort}`;
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

    if (videos.length < FRONTEND_LIMITS.VIDEO_PAGE_SIZE) {
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
  let url = `/videos?limit=${FRONTEND_LIMITS.VIDEO_PAGE_SIZE}&offset=${nextOffset}&sort=${sort}`;
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
