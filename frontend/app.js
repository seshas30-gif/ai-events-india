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
  // status/event_type/category/is_new are server-side (query params).
  // city is client-side only — see loadEvents()'s comment for why.
  filters: { status: "upcoming", event_type: "", category: "" },
  cityFilter: "",
  searchQuery: "",
  view: "grid",
  showNewOnly: false,
};

// ── Bootstrap ──────────────────────────────────────────────────

async function init() {
  buildCityFilters();
  setupFilterChips();
  startAmbient();
  await loadStats();
  await loadEvents();
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
    if (state.showNewOnly)        params.set("is_new", "true");
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
  label.textContent = "⟳ Scanning…";

  try {
    await fetch(`${API_BASE}/scrape`, { method: "POST" });
    showToast("Scraping in progress — check back in ~30 seconds");

    setTimeout(async () => {
      await loadStats();
      await loadEvents();
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
      state.showNewOnly = false;
      document.getElementById("show-new-btn").textContent = "Show New Only";
      loadEvents();
    });
  });

  document.getElementById("refresh-btn").addEventListener("click", triggerScrape);
}

function showNewOnly() {
  state.showNewOnly = !state.showNewOnly;
  const btn = document.getElementById("show-new-btn");
  btn.textContent = state.showNewOnly ? "Show All Events" : "Show New Only";
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

  if (count === 0) {
    container.innerHTML = `<div class="empty-state"><span style="font-size:40px">🔍</span><p>No events match your filters.</p></div>`;
    return;
  }

  container.innerHTML = state.filtered.map(e => renderCard(e)).join("");
}

function renderCard(event) {
  const typeTag  = event.event_type || "other";
  const category = event.category === "product" ? "product" : "ai";
  const dateStr  = formatDateRange(event.start_date, event.end_date);
  const location = [event.city, event.state].filter(Boolean).join(", ") || "City TBA";
  const isNew    = event.is_new;

  return `
    <div class="event-card${isNew ? " is-new" : ""} ${category}">
      <div class="card-tags">
        <span class="card-dot"></span>
        <span class="card-cat">${category === "product" ? "Product" : "AI"} · ${typeTag}</span>
        ${isNew ? `<span class="card-new">NEW</span>` : ""}
      </div>
      <div class="card-title">${escHtml(event.name)}</div>
      <div class="card-meta">
        ${dateStr ? `<span class="num">📅 ${dateStr}</span>` : ""}
        <span>📍 ${escHtml(location)}</span>
        ${event.organizer ? `<span>🏢 ${escHtml(event.organizer)}</span>` : ""}
        ${event.is_free === true ? `<span>🆓 Free</span>` : ""}
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
