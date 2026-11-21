const API_BASE = window.location.hostname === "localhost" || window.location.hostname === "127.0.0.1"
  ? "http://localhost:8000"
  : "/api";

// Abstract, decorative city positions (not literal cartography) on a 560x340 map.
// `filterValue` is what's sent to the API (must match backend CITY_ALIASES keys
// where an alias exists); `match` is how we tally counts client-side from
// whatever raw city strings the LLM extraction actually produced.
const MAP_NODES = [
  { label: "Delhi NCR", filterValue: "Delhi", match: ["delhi", "noida", "gurgaon", "gurugram"], x: 290, y: 55 },
  { label: "Ahmedabad", filterValue: "Ahmedabad", match: ["ahmedabad"], x: 140, y: 150 },
  { label: "Kolkata", filterValue: "Kolkata", match: ["kolkata"], x: 460, y: 165 },
  { label: "Kharagpur", filterValue: "Kharagpur", match: ["kharagpur"], x: 460, y: 220 },
  { label: "Mumbai", filterValue: "Mumbai", match: ["mumbai"], x: 190, y: 175 },
  { label: "Pune", filterValue: "Pune", match: ["pune"], x: 205, y: 215 },
  { label: "Goa", filterValue: "Goa", match: ["goa"], x: 160, y: 250 },
  { label: "Hyderabad", filterValue: "Hyderabad", match: ["hyderabad"], x: 305, y: 200 },
  { label: "Bengaluru", filterValue: "Bengaluru", match: ["bangalore", "bengaluru"], x: 255, y: 285 },
  { label: "Chennai", filterValue: "Chennai", match: ["chennai"], x: 330, y: 300 },
];

const state = {
  events: [],
  filtered: [],
  // status/event_type/category/mode/is_new are server-side (query params).
  // city is client-side only — see loadEvents()'s comment for why.
  filters: { status: "upcoming", event_type: "", category: "", mode: "" },
  cityFilter: "",
  searchQuery: "",
  view: "grid",
  showNewOnly: false,
  // P0 additions
  freeOnly: false,
  viewFilter: "", // open | week | new | closing (server-side `view=`)
  sort: "score",  // score | closing | soonest | newest
  stats: null,
};

// ── P0-4: state <-> URL ────────────────────────────────────────
// Every filter/search/sort lives in the query string so any view can be
// shared (and hero counters / future collections are just saved URLs).
function readURLState() {
  const p = new URLSearchParams(window.location.search);
  if (p.get("q") !== null) state.searchQuery = p.get("q").toLowerCase();
  if (p.get("category") !== null) state.filters.category = p.get("category");
  if (p.get("status") !== null) state.filters.status = p.get("status");
  if (p.get("event_type") !== null) state.filters.event_type = p.get("event_type");
  if (p.get("mode") !== null) state.filters.mode = p.get("mode");
  if (p.get("city") !== null) state.cityFilter = p.get("city");
  state.freeOnly = p.get("free") === "1";
  if (p.get("view") !== null) state.viewFilter = p.get("view");
  if (p.get("sort") !== null) state.sort = p.get("sort");
  state.showNewOnly = state.viewFilter === "new";
}

function writeURLState() {
  const p = new URLSearchParams();
  const q = document.getElementById("search-input")?.value.trim();
  if (q) p.set("q", q);
  if (state.filters.category) p.set("category", state.filters.category);
  if (state.filters.status && state.filters.status !== "upcoming") p.set("status", state.filters.status);
  if (state.filters.event_type) p.set("event_type", state.filters.event_type);
  if (state.filters.mode) p.set("mode", state.filters.mode);
  if (state.cityFilter) p.set("city", state.cityFilter);
  if (state.freeOnly) p.set("free", "1");
  if (state.viewFilter) p.set("view", state.viewFilter);
  if (state.sort && state.sort !== "score") p.set("sort", state.sort);
  const qs = p.toString();
  try {
    history.replaceState(null, "", window.location.pathname + (qs ? "?" + qs : "") + window.location.hash);
  } catch (e) { /* file:// in some browsers — sharebar text below still shows the URL */ }
  const el = document.getElementById("share-url");
  if (el) el.textContent = window.location.href.split("?")[0].split("#")[0] + (qs ? "?" + qs : "");
}

function syncControlsFromState() {
  const search = document.getElementById("search-input");
  if (search && state.searchQuery) search.value = state.searchQuery;
  const sortSel = document.getElementById("sort-select");
  if (sortSel) sortSel.value = state.sort;
  document.getElementById("show-new-btn").textContent = state.showNewOnly ? "Show All Events" : "Show New Only";
  document.querySelectorAll(".pill[data-filter]").forEach(chip => {
    const key = chip.dataset.filter, val = chip.dataset.value;
    let active = false;
    if (key === "city") active = state.cityFilter === val;
    else if (key === "free") active = state.freeOnly;
    else active = (state.filters[key] ?? "") === val;
    chip.classList.toggle("active", active);
  });
}

async function copyShareLink() {
  writeURLState();
  const url = document.getElementById("share-url").textContent;
  try {
    await navigator.clipboard.writeText(url);
    showToast("Link copied — this exact view reopens from it");
  } catch (e) {
    showToast("Copy blocked by browser — copy the URL from the share bar");
  }
}

function clearAllFilters() {
  state.filters = { status: "upcoming", event_type: "", category: "", mode: "" };
  state.cityFilter = ""; state.freeOnly = false; state.viewFilter = "";
  state.showNewOnly = false; state.sort = "score"; state.searchQuery = "";
  const search = document.getElementById("search-input");
  if (search) search.value = "";
  syncControlsFromState();
  loadEvents();
}

// ── Bootstrap ──────────────────────────────────────────────────

async function init() {
  readURLState();
  buildCityFilters();
  setupFilterChips();
  syncControlsFromState();
  startAmbient();
  await loadStats();
  await loadEvents();
  loadClosingRail();
}

function buildCityFilters() {
  const group = document.getElementById("city-filters");
  MAP_NODES.forEach(node => {
    const btn = document.createElement("button");
    btn.className = "pill";
    btn.dataset.filter = "city";
    btn.dataset.value = node.filterValue;
    btn.textContent = node.label;
    group.appendChild(btn);
  });
}

// ── API calls ──────────────────────────────────────────────────

async function loadEvents() {
  showLoading();
  try {
    // City is deliberately NOT sent as a server param — the map needs the
    // full (status/category-filtered) set to keep every node's count and
    // click-ability accurate no matter which city is currently selected.
    // Narrowing server-side would make selecting a city hide every other
    // node (nothing left to click back to). City filtering happens
    // client-side instead, in applyClientFilters().
    const params = new URLSearchParams();
    if (state.filters.status)     params.set("status", state.filters.status);
    if (state.filters.event_type) params.set("event_type", state.filters.event_type);
    if (state.filters.category)   params.set("category", state.filters.category);
    if (state.filters.mode)       params.set("mode", state.filters.mode);
    if (state.freeOnly)           params.set("is_free", "true");
    if (state.viewFilter)         params.set("view", state.viewFilter);
    params.set("sort", state.sort);
    params.set("limit", "300");

    const res = await fetch(`${API_BASE}/events?${params}`);
    if (!res.ok) throw new Error(res.statusText);
    const data = await res.json();
    state.events = data.events;
    applyClientFilters();
    renderMap(state.events);
    updateHeroEyebrow();
  } catch (e) {
    showError("Could not load events. Is the backend running?");
    console.error(e);
  }
}

async function loadStats() {
  try {
    const res = await fetch(`${API_BASE}/stats`);
    const data = await res.json();
    state.stats = data;
    document.getElementById("stat-total").textContent    = data.total ?? "—";
    document.getElementById("stat-new").textContent      = data.new ?? "—";
    document.getElementById("stat-upcoming").textContent = data.upcoming ?? "—";
    document.getElementById("hero-open").textContent     = data.open_now ?? data.upcoming ?? "—";
    renderCounters(data);
    if (data.cities) {
      document.getElementById("source-line").textContent =
        `Scanned daily from organizer sites, NASSCOM & community listings · ${data.cities} cities · updated 07:00 IST`;
    }

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

// ── P0-1: hero counters ────────────────────────────────────────
function renderCounters(data) {
  const defs = [
    { view: "open",    n: data.open_now ?? data.upcoming, label: `open now<br><span>browse all →</span>` },
    { view: "week",    n: data.starting_7d,               label: `start in next 7 days<br><span>this week →</span>` },
    { view: "new",     n: data.new_7d,                    label: `new this week<br><span>just found →</span>` },
    { view: "closing", n: data.closing_7d,                label: `registration / CFP closing ≤7d<br><span>act fast →</span>` },
  ];
  const box = document.getElementById("counters");
  box.innerHTML = defs.map(x =>
    `<button type="button" class="counter${state.viewFilter === x.view ? " active" : ""}" data-view="${x.view}">
       <span class="n">${x.n ?? "—"}</span><span class="l">${x.label}</span>
     </button>`).join("");
  box.querySelectorAll(".counter").forEach(btn => btn.addEventListener("click", () => {
    state.viewFilter = state.viewFilter === btn.dataset.view ? "" : btn.dataset.view;
    state.showNewOnly = state.viewFilter === "new";
    if (state.viewFilter === "closing") state.sort = "closing";
    syncControlsFromState();
    loadEvents();
    document.getElementById("browse-anchor").scrollIntoView({ behavior: "smooth" });
  }));
}

// ── P0-2: closing-soon rail ────────────────────────────────────
async function loadClosingRail() {
  try {
    const res = await fetch(`${API_BASE}/events?status=upcoming&view=closing&sort=closing&limit=12`);
    if (!res.ok) throw new Error(res.statusText);
    const { events } = await res.json();
    const rail = document.getElementById("closing-rail");
    if (!events.length) { rail.classList.add("hidden"); return; }
    rail.classList.remove("hidden");
    document.getElementById("rail-items").innerHTML = events.map(e => {
      const r = daysUntil(e.registration_deadline), c = daysUntil(e.cfp_deadline);
      const chip = (r !== null && r <= 7)
        ? `<span class="chip ${r <= 3 ? "danger" : "warn"}">⏳ ${relDays(r, "Reg closes")}</span>`
        : `<span class="chip cfp">✎ CFP ${relDays(c, "closes")}</span>`;
      const when = e.start_date ? formatDateRange(e.start_date, e.end_date) : "";
      return `<a class="rail-item" href="${e.registration_url || e.url || "#"}" target="_blank" rel="noopener">
        ${chip}<div class="t">${escHtml(e.name)}</div>
        <div class="m">${escHtml(e.city || "India")}${when ? " · " + when : ""}${e.quality_score != null ? " · ★" + e.quality_score : ""}</div>
      </a>`;
    }).join("");
  } catch (e) {
    console.warn("Closing rail failed:", e);
  }
}

async function triggerScrape() {
  const btn = document.getElementById("refresh-btn");
  const label = document.getElementById("refresh-label");
  btn.disabled = true;
  label.textContent = "⟳ Scanning…";

  try {
    await fetch(`${API_BASE}/scrape`, { method: "POST" });
    showToast("Scraping in progress — check back in ~30 seconds");

    setTimeout(async () => {
      await loadStats();
      await loadEvents();
      loadClosingRail();
      btn.disabled = false;
      label.textContent = "⟳ Refresh signal";
      showToast("Done! Events updated.");
    }, 35000);
  } catch (e) {
    showToast("Scrape failed. Check backend logs.");
    btn.disabled = false;
    label.textContent = "⟳ Refresh signal";
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
  document.querySelectorAll(".pill[data-filter]").forEach(chip => {
    chip.addEventListener("click", () => {
      const filterKey = chip.dataset.filter;
      const value = chip.dataset.value;

      if (filterKey === "free") {
        state.freeOnly = !state.freeOnly;
        chip.classList.toggle("active", state.freeOnly);
        loadEvents();
        return;
      }

      const group = chip.closest(".pillgroup");
      group.querySelectorAll(".pill").forEach(c => c.classList.remove("active"));
      chip.classList.add("active");

      if (filterKey === "city") {
        // client-side only — see loadEvents()'s comment
        state.cityFilter = value;
        selectMapNode(value);
        applyClientFilters();
        return;
      }

      state.filters[filterKey] = value;
      loadEvents();
    });
  });

  document.getElementById("refresh-btn").addEventListener("click", triggerScrape);
}

function showNewOnly() {
  state.showNewOnly = !state.showNewOnly;
  state.viewFilter = state.showNewOnly ? "new" : "";
  const btn = document.getElementById("show-new-btn");
  btn.textContent = state.showNewOnly ? "Show All Events" : "Show New Only";
  if (state.stats) renderCounters(state.stats);
  loadEvents();
}

function handleSort() {
  state.sort = document.getElementById("sort-select").value;
  loadEvents();
}

function handleSearch() {
  state.searchQuery = document.getElementById("search-input").value.toLowerCase();
  applyClientFilters();
}

function applyClientFilters() {
  const q = state.searchQuery;
  const cityNode = MAP_NODES.find(n => n.filterValue === state.cityFilter);

  state.filtered = state.events.filter(e => {
    if (cityNode) {
      const city = (e.city || "").toLowerCase();
      if (!cityNode.match.some(term => city.includes(term))) return false;
    }
    if (q) {
      const hit = (e.name || "").toLowerCase().includes(q) ||
        (e.city || "").toLowerCase().includes(q) ||
        (e.organizer || "").toLowerCase().includes(q) ||
        (e.description || "").toLowerCase().includes(q);
      if (!hit) return false;
    }
    return true;
  });
  writeURLState();
  render();
}

// ── Map ────────────────────────────────────────────────────────

function renderMap(events) {
  const g = document.getElementById("map-nodes");
  g.innerHTML = "";
  const svgNS = "http://www.w3.org/2000/svg";

  MAP_NODES.forEach(node => {
    const count = events.filter(e => {
      const city = (e.city || "").toLowerCase();
      return node.match.some(term => city.includes(term));
    }).length;
    const active = count > 0;

    const group = document.createElementNS(svgNS, "g");
    group.setAttribute("class", "node" + (active ? " active" : ""));
    group.dataset.filterValue = node.filterValue;
    if (active) {
      group.setAttribute("tabindex", "0");
      group.setAttribute("role", "button");
      group.setAttribute("aria-label", `Filter to ${node.label}, ${count} event${count === 1 ? "" : "s"}`);
    }

    const title = document.createElementNS(svgNS, "title");
    title.textContent = `${node.label}${active ? ` — ${count} event${count === 1 ? "" : "s"}` : ""}`;
    group.appendChild(title);

    const ring = document.createElementNS(svgNS, "circle");
    ring.setAttribute("class", "ring"); ring.setAttribute("cx", node.x); ring.setAttribute("cy", node.y); ring.setAttribute("r", "6");
    group.appendChild(ring);

    const core = document.createElementNS(svgNS, "circle");
    core.setAttribute("class", "core"); core.setAttribute("cx", node.x); core.setAttribute("cy", node.y); core.setAttribute("r", "4");
    group.appendChild(core);

    const cityText = document.createElementNS(svgNS, "text");
    cityText.setAttribute("class", "city"); cityText.setAttribute("x", node.x); cityText.setAttribute("y", node.y - 10); cityText.setAttribute("text-anchor", "middle");
    cityText.textContent = node.label.toUpperCase();
    group.appendChild(cityText);

    if (active) {
      const countText = document.createElementNS(svgNS, "text");
      countText.setAttribute("class", "count"); countText.setAttribute("x", node.x); countText.setAttribute("y", node.y + 18); countText.setAttribute("text-anchor", "middle");
      countText.textContent = `${count} EVENT${count === 1 ? "" : "S"}`;
      group.appendChild(countText);

      function activate() {
        const pill = document.querySelector(`.pill[data-filter="city"][data-value="${node.filterValue}"]`);
        if (pill) pill.click();
      }
      group.addEventListener("click", activate);
      group.addEventListener("keydown", e => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); activate(); } });
    }

    g.appendChild(group);
  });

  selectMapNode(state.cityFilter);
}

function selectMapNode(filterValue) {
  document.querySelectorAll("#map-nodes .node").forEach(n => {
    n.classList.toggle("selected", !!filterValue && n.dataset.filterValue === filterValue);
  });
}

function updateHeroEyebrow() {
  const activeCities = MAP_NODES.filter(node =>
    state.events.some(e => node.match.some(term => (e.city || "").toLowerCase().includes(term)))
  ).length;
  document.getElementById("hero-eyebrow").textContent =
    `Live signal · ${activeCities} cit${activeCities === 1 ? "y" : "ies"} tracked`;
}

// ── View ───────────────────────────────────────────────────────

function setView(view) {
  state.view = view;
  const container = document.getElementById("events-container");
  container.className = `events-container ${view}`;
  document.querySelectorAll(".viewbtn").forEach(b => b.classList.toggle("active", b.dataset.view === view));
}

// ── Render ─────────────────────────────────────────────────────

function render() {
  const container = document.getElementById("events-container");
  container.className = `events-container ${state.view}`;

  const count = state.filtered.length;

  const line = document.getElementById("result-line");
  if (line) {
    const sortSel = document.getElementById("sort-select");
    const sortLabel = sortSel ? sortSel.selectedOptions[0].textContent.replace("Sort: ", "") : "";
    line.innerHTML = `Showing <b>${count}</b> event${count === 1 ? "" : "s"} · sorted by <b>${escHtml(sortLabel)}</b>` +
      (state.cityFilter ? ` · in <b>${escHtml(state.cityFilter)}</b>` : "") +
      (state.viewFilter ? ` · view: <b>${escHtml(state.viewFilter)}</b>` : "");
  }

  if (count === 0) {
    container.innerHTML = `<div class="empty-state"><span style="font-size:40px">🔍</span><p>No events match your filters.<br><button type="button" class="btn-ghost" style="margin-top:10px" onclick="clearAllFilters()">Clear filters</button></p></div>`;
    return;
  }

  container.innerHTML = state.filtered.map((e, i) => renderCard(e, i)).join("");
}

const CATEGORY_LABELS = { ai: "AI", product: "Product", tech: "Tech", startup: "Startup" };
const MODE_LABELS = { in_person: "In person", online: "Online", hybrid: "Hybrid" };
const SCORE_PARTS = [
  ["completeness", "Completeness (date · venue · link)", 30],
  ["source_trust", "Source trust (official site)", 25],
  ["organizer", "Organizer track record", 25],
  ["price_clarity", "Price clarity", 20],
];

function daysUntil(dateStr) {
  if (!dateStr) return null;
  const t = new Date(); t.setHours(0, 0, 0, 0);
  const d = new Date(String(dateStr).slice(0, 10) + "T00:00:00");
  return Number.isNaN(d.getTime()) ? null : Math.round((d - t) / 864e5);
}

function relDays(n, label) {
  if (n === null) return "";
  if (n === 0) return `${label} today`;
  if (n === 1) return `${label} tomorrow`;
  return `${label} in ${n}d`;
}

function countdownChips(event) {
  const chips = [];
  const r = daysUntil(event.registration_deadline);
  const c = daysUntil(event.cfp_deadline);
  const s = daysUntil(event.start_date);
  if (r !== null && r >= 0) chips.push(`<span class="chip ${r <= 3 ? "danger" : r <= 7 ? "warn" : ""}">⏳ ${relDays(r, "Reg closes")}</span>`);
  if (c !== null && c >= 0) chips.push(`<span class="chip cfp">✎ CFP ${relDays(c, "closes")}</span>`);
  if (s !== null && s >= 0 && s <= 7) chips.push(`<span class="chip">▶ ${relDays(s, "Starts")}</span>`);
  if (event.mode && MODE_LABELS[event.mode]) chips.push(`<span class="chip mode">${MODE_LABELS[event.mode]}</span>`);
  return chips.length ? `<div class="card-countdowns">${chips.join("")}</div>` : "";
}

function priceLabel(event) {
  if (event.is_free === true || event.price_inr === 0) return "🆓 Free";
  if (event.price_inr) return `🎟 ₹${Number(event.price_inr).toLocaleString("en-IN")}`;
  return "";
}

function scoreBlock(event, index) {
  const score = event.quality_score;
  if (score === null || score === undefined) return "";
  const tier = score >= 85 ? "hi" : score >= 65 ? "mid" : "lo";
  const parts = event.score_parts || {};
  const rows = SCORE_PARTS.map(([key, label, max]) => {
    const v = parts[key] ?? 0;
    return `<div class="brow"><span class="bk">${label}</span><span class="bbar"><i style="width:${Math.round(v / max * 100)}%"></i></span><span class="bv">${v}/${max}</span></div>`;
  }).join("");
  return `
    <div class="card-score">
      <button type="button" class="score-ring ${tier}" onclick="toggleBreakdown(${index})" title="Why this score?" aria-label="Quality score ${score} of 100 — show breakdown">${score}</button>
      <span class="score-cap">Quality<br>score — why?</span>
    </div>
    <div class="score-breakdown" id="breakdown-${index}">
      <h4>Why ${score}/100?</h4>${rows}
      <p style="font-size:11px;color:var(--ink-dim);margin-top:5px">Computed automatically — no manual curation. Low scores sink in “Top scored”.</p>
    </div>`;
}

function toggleBreakdown(index) {
  const el = document.getElementById("breakdown-" + index);
  if (el) el.classList.toggle("open");
}

function renderCard(event, index = 0) {
  const typeTag  = event.event_type || "other";
  const category = CATEGORY_LABELS[event.category] ? event.category : "ai";
  const dateStr  = formatDateRange(event.start_date, event.end_date);
  const location = [event.city, event.state].filter(Boolean).join(", ") || "City TBA";
  const isNew    = event.is_new;
  const price    = priceLabel(event);

  return `
    <div class="event-card${isNew ? " is-new" : ""} ${category}">
      <div class="card-tags">
        <span class="card-dot"></span>
        <span class="card-cat">${CATEGORY_LABELS[category]} · ${typeTag}</span>
        ${isNew ? `<span class="card-new">NEW</span>` : ""}
      </div>
      <div class="card-title">${escHtml(event.name)}</div>
      ${scoreBlock(event, index)}
      ${countdownChips(event)}
      <div class="card-meta">
        ${dateStr ? `<span class="num">📅 ${dateStr}</span>` : ""}
        <span>📍 ${escHtml(location)}</span>
        ${event.organizer ? `<span>🏢 ${escHtml(event.organizer)}</span>` : ""}
        ${price ? `<span>${price}</span>` : ""}
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
    `<div class="loading-state"><div class="spinner"></div><p>Fetching events...</p></div>`;
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

// ── Ambient background (fixed to viewport, so it backs the whole page) ──

function startAmbient() {
  const canvas = document.getElementById("ambient-canvas");
  if (!canvas) return;
  const ctx = canvas.getContext("2d");
  const reduced = window.matchMedia && window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  let particles = [];
  let w = 0, h = 0;

  function resize() {
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    w = window.innerWidth; h = window.innerHeight;
    canvas.width = w * dpr; canvas.height = h * dpr;
    canvas.style.width = w + "px"; canvas.style.height = h + "px";
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    const target = Math.min(140, Math.max(50, Math.round((w * h) / 9000)));
    if (particles.length !== target) {
      particles = [];
      for (let i = 0; i < target; i++) {
        particles.push({
          x: Math.random() * w, y: Math.random() * h, r: Math.random() * 1.3 + 0.4,
          vx: (Math.random() - 0.5) * 0.05, vy: (Math.random() - 0.5) * 0.05, phase: Math.random() * Math.PI * 2,
        });
      }
    }
  }

  function blob(t, xFrac, yFrac, driftX, driftY, periodX, periodY, radiusFrac, color) {
    const bx = w * xFrac + Math.sin(t / periodX) * w * driftX;
    const by = h * yFrac + Math.cos(t / periodY) * h * driftY;
    const r = Math.min(Math.max(w, h) * radiusFrac, 640);
    const g = ctx.createRadialGradient(bx, by, 0, bx, by, r);
    g.addColorStop(0, color); g.addColorStop(1, "rgba(0,0,0,0)");
    ctx.fillStyle = g; ctx.fillRect(0, 0, w, h);
  }

  function draw(t) {
    if (w && h) {
      ctx.clearRect(0, 0, w, h);
      blob(t, 0.25, 0.20, 0.10, 0.06, 9000, 11000, 0.55, "rgba(125,211,192,0.09)");
      blob(t, 0.75, 0.65, 0.08, 0.07, 12000, 13500, 0.55, "rgba(245,169,98,0.06)");

      particles.forEach(p => {
        if (!reduced) {
          p.x += p.vx; p.y += p.vy;
          if (p.x < 0) p.x = w; if (p.x > w) p.x = 0;
          if (p.y < 0) p.y = h; if (p.y > h) p.y = 0;
        }
        const tw = reduced ? 0.5 : 0.4 + 0.3 * Math.sin(t / 1400 + p.phase);
        ctx.beginPath(); ctx.fillStyle = `rgba(232,236,243,${tw * 0.5})`;
        ctx.arc(p.x, p.y, p.r, 0, Math.PI * 2); ctx.fill();
      });
    }
    if (!reduced) requestAnimationFrame(draw);
  }

  window.addEventListener("resize", resize);
  resize();
  if (reduced) draw(0); else requestAnimationFrame(draw);
}

// ── Start ──────────────────────────────────────────────────────
init();
