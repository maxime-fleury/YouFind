// YouFind dashboard statistics page.

// ═══════════════════════════════════════════
//  PAGE: Stats
// ═══════════════════════════════════════════
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
