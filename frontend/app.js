const API_BASE = window.ENV_API_BASE || "http://localhost:8000";

const state = {
  events: [],
  filtered: [],
  filters: { status: "upcoming", event_type: "", city: "" },
  searchQuery: "",
  view: "grid",
  showNewOnly: false,
};

// ── Bootstrap ──────────────────────────────────────────────────

async function init() {
  await loadStats();
  await loadEvents();
  setupFilterChips();
}

// ── API calls ──────────────────────────────────────────────────

async function loadEvents() {
  showLoading();
  try {
    const params = new URLSearchParams();
    if (state.filters.status)     params.set("status", state.filters.status);
    if (state.filters.event_type) params.set("event_type", state.filters.event_type);
    if (state.filters.city)       params.set("city", state.filters.city);
    if (state.showNewOnly)        params.set("is_new", "true");
    params.set("limit", "200");

    const res = await fetch(`${API_BASE}/events?${params}`);
    if (!res.ok) throw new Error(res.statusText);
    const data = await res.json();
    state.events = data.events;
    applySearch();
  } catch (e) {
    showError("Could not load events. Is the backend running?");
    console.error(e);
  }
}

async function loadStats() {
  try {
    const res = await fetch(`${API_BASE}/stats`);
    const data = await res.json();
    document.getElementById("stat-total").textContent    = data.total ?? "—";
    document.getElementById("stat-new").textContent      = data.new ?? "—";
    document.getElementById("stat-upcoming").textContent = data.upcoming ?? "—";

    const newBadge = document.getElementById("new-badge");
    if (data.new > 0) {
      newBadge.textContent = `${data.new} new`;
      newBadge.classList.remove("hidden");
    } else {
      newBadge.classList.add("hidden");
    }
  } catch (e) {
    console.warn("Stats failed:", e);
  }
}

async function triggerScrape() {
  const btn = document.getElementById("refresh-btn");
  const label = document.getElementById("refresh-label");
  btn.disabled = true;
  label.textContent = "Searching...";

  try {
    await fetch(`${API_BASE}/scrape`, { method: "POST" });
    showToast("Scraping in progress — check back in ~30 seconds");

    setTimeout(async () => {
      await loadStats();
      await loadEvents();
      btn.disabled = false;
      label.textContent = "Refresh Events";
      showToast("Done! Events updated.");
    }, 35000);
  } catch (e) {
    showToast("Scrape failed. Check backend logs.");
    btn.disabled = false;
    label.textContent = "Refresh Events";
  }
}

async function markAllSeen() {
  await fetch(`${API_BASE}/events/mark-seen`, { method: "POST" });
  await loadStats();
  await loadEvents();
  document.getElementById("new-badge").classList.add("hidden");
  showToast("All events marked as seen");
}

// ── Filters ────────────────────────────────────────────────────

function setupFilterChips() {
  document.querySelectorAll(".filter-chip[data-filter]").forEach(chip => {
    chip.addEventListener("click", () => {
      const filterKey = chip.dataset.filter;
      const value = chip.dataset.value;

      // Update active chip in the same group
      const group = chip.closest(".filter-group");
      group.querySelectorAll(".filter-chip").forEach(c => c.classList.remove("active"));
      chip.classList.add("active");

      state.filters[filterKey] = value;
      state.showNewOnly = false;
      document.getElementById("show-new-btn").textContent = "Show New Only";
      loadEvents();
    });
  });
}

function showNewOnly() {
  state.showNewOnly = !state.showNewOnly;
  const btn = document.getElementById("show-new-btn");
  btn.textContent = state.showNewOnly ? "Show All Events" : "Show New Only";
  loadEvents();
}

function handleSearch() {
  state.searchQuery = document.getElementById("search-input").value.toLowerCase();
  applySearch();
}

function applySearch() {
  const q = state.searchQuery;
  state.filtered = q
    ? state.events.filter(e =>
        (e.name || "").toLowerCase().includes(q) ||
        (e.city || "").toLowerCase().includes(q) ||
        (e.organizer || "").toLowerCase().includes(q) ||
        (e.description || "").toLowerCase().includes(q)
      )
    : state.events;
  render();
}

// ── View ───────────────────────────────────────────────────────

function setView(view) {
  state.view = view;
  const container = document.getElementById("events-container");
  container.className = `events-container ${view}`;
  document.getElementById("grid-btn").classList.toggle("active", view === "grid");
  document.getElementById("list-btn").classList.toggle("active", view === "list");
}

// ── Render ─────────────────────────────────────────────────────

function render() {
  const container = document.getElementById("events-container");
  container.className = `events-container ${state.view}`;

  const count = state.filtered.length;
  document.getElementById("event-count").textContent =
    count === 0 ? "No events" : `${count} event${count !== 1 ? "s" : ""}`;

  if (count === 0) {
    container.innerHTML = `<div class="empty-state"><span style="font-size:40px">🔍</span><p>No events match your filters.</p></div>`;
    return;
  }

  container.innerHTML = state.filtered.map(e => renderCard(e)).join("");
}

function renderCard(event) {
  const typeTag  = event.event_type || "other";
  const dateStr  = formatDateRange(event.start_date, event.end_date);
  const location = [event.city, event.state].filter(Boolean).join(", ") || "India";
  const isNew    = event.is_new;

  return `
    <div class="event-card${isNew ? " is-new" : ""}">
      <span class="card-type-tag tag-${typeTag}">${typeTag}</span>
      <div class="card-title">${escHtml(event.name)}</div>
      <div class="card-meta">
        ${dateStr ? `<div class="card-meta-row">📅 ${dateStr}</div>` : ""}
        <div class="card-meta-row">📍 ${escHtml(location)}</div>
        ${event.organizer ? `<div class="card-meta-row">🏢 ${escHtml(event.organizer)}</div>` : ""}
        ${event.is_free === true ? `<div class="card-meta-row">🆓 Free</div>` : ""}
      </div>
      ${event.description ? `<div class="card-description">${escHtml(event.description)}</div>` : ""}
      <div class="card-actions">
        ${event.url
          ? `<a href="${event.url}" target="_blank" rel="noopener" class="card-link primary">View Event</a>`
          : ""}
        ${event.registration_url && event.registration_url !== event.url
          ? `<a href="${event.registration_url}" target="_blank" rel="noopener" class="card-link secondary">Register</a>`
          : ""}
      </div>
    </div>
  `;
}

// ── Helpers ────────────────────────────────────────────────────

function formatDateRange(start, end) {
  if (!start) return null;
  const s = new Date(start);
  const opts = { day: "numeric", month: "short", year: "numeric" };
  if (!end || end === start) return s.toLocaleDateString("en-IN", opts);
  const e = new Date(end);
  if (s.getMonth() === e.getMonth() && s.getFullYear() === e.getFullYear()) {
    return `${s.getDate()}–${e.toLocaleDateString("en-IN", opts)}`;
  }
  return `${s.toLocaleDateString("en-IN", { day: "numeric", month: "short" })} – ${e.toLocaleDateString("en-IN", opts)}`;
}

function escHtml(str) {
  if (!str) return "";
  return str.replace(/&/g,"&amp;").replace(/</g,"&lt;").replace(/>/g,"&gt;").replace(/"/g,"&quot;");
}

function showLoading() {
  document.getElementById("events-container").innerHTML =
    `<div class="loading-state"><div class="spinner"></div><p>Fetching AI events...</p></div>`;
}

function showError(msg) {
  document.getElementById("events-container").innerHTML =
    `<div class="empty-state"><span style="font-size:40px">⚠️</span><p>${msg}</p></div>`;
}

let toastTimer;
function showToast(msg) {
  const toast = document.getElementById("toast");
  toast.textContent = msg;
  toast.classList.remove("hidden");
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => toast.classList.add("hidden"), 4000);
}

// ── Start ──────────────────────────────────────────────────────
init();
