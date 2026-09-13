// Shared helpers for both pages.
const COLORS = {
  YES: "#2ea043",
  NO: "#d29922",
  LATE: "#db6d28",
  MISSED: "#f85149",
  PENDING: "#6e7681",
};
const ORDER = ["YES", "NO", "LATE", "MISSED", "PENDING"];

// `window.STATIC_MODE = true` is injected at dump time by `validator-healths dump`.
// In static mode:
//   - fetch URLs are rewritten from `/api/...` to `data/...json`
//   - the "By future stake" toggle is hidden (no live edit possible)
//   - the Refresh button is hidden
//   - drag-to-filter on the chart is disabled (would need extra per-poll dump)
const STATIC_MODE = typeof window !== "undefined" && window.STATIC_MODE === true;

// "count"  = treat each validator's vote as 1
// "stake"  = chain's quadratic snapshot weight (consensus math)
// "future" = stake-weighted, but with operators in future-removals.txt excluded
//            from both numerator and the BondedWeight denominator (dynamic only)
const VIEW_MODES = STATIC_MODE ? ["count", "stake"] : ["count", "stake", "future"];
function getViewMode() {
  const m = localStorage.getItem("viewMode");
  return VIEW_MODES.includes(m) ? m : "stake";
}
function setViewMode(m) {
  localStorage.setItem("viewMode", VIEW_MODES.includes(m) ? m : "stake");
}

// Lookup the appropriate value on a bucket / chain-summary row given an outcome.
// Bucket fields: yes/no/late/missed/pending + yes_power/no_power/... + yes_future_power/...
function valFor(row, outcome, mode) {
  const k = outcome.toLowerCase();
  if (mode === "future") return row[k + "_future_power"] ?? 0;
  if (mode === "stake")  return row[k + "_power"] ?? 0;
  return row[k] ?? 0;
}
// Denominator for percentages.
//   - count mode: sum of YES + NO + LATE + MISSED (so bands sum to 100 %).
//   - stake mode: chain's BondedWeight summed across the polls in this row. Using
//     BondedWeight makes the chart's % literally "% of bonded stake", which is
//     what the chain's 51 % consensus rule cares about. Trade-off: bands no
//     longer sum to 100 % — the gap between Σ(YES+NO+LATE+MISSED) and
//     bonded_weight_total represents bonded validators that aren't maintainers
//     of this chain (so they couldn't vote on these polls).
//     Falls back to the participants-sum if bonded_weight_total isn't populated
//     yet (fresh DB, before the indexer has stamped a chunk).
function totalFor(row, mode) {
  if (mode === "stake") {
    const bonded = row.bonded_weight_total ?? 0;
    if (bonded > 0) return bonded;
  }
  if (mode === "future") {
    const bonded = row.bonded_weight_total_future ?? 0;
    if (bonded > 0) return bonded;
  }
  return ["YES", "NO", "LATE", "MISSED"].reduce((a, o) => a + valFor(row, o, mode), 0);
}

// Render the count/stake/future segmented toggle into the given container.
// Calls `onChange(newMode)` when the user flips it.
const TOGGLE_LABELS = {
  count: "By votes",
  stake: "By stake",
  future: "By future stake",
};
function renderViewToggle(container, onChange) {
  container.innerHTML = "";
  container.classList.add("view-toggle");
  const cur = getViewMode();
  for (const m of VIEW_MODES) {
    const btn = document.createElement("button");
    btn.type = "button";
    btn.textContent = TOGGLE_LABELS[m];
    btn.dataset.mode = m;
    btn.className = "view-toggle-btn" + (cur === m ? " active" : "");
    if (m === "future") {
      btn.title = "Same as 'By stake' but excludes operators listed in future-removals.txt";
    }
    btn.onclick = () => {
      if (getViewMode() === m) return;
      setViewMode(m);
      container.querySelectorAll(".view-toggle-btn").forEach((b) =>
        b.classList.toggle("active", b.dataset.mode === m)
      );
      // Preserve scroll position across the re-render. Pages that respond to
      // toggle changes typically `innerHTML = ""` their grid/table before
      // rebuilding, which briefly collapses layout height — that's what makes
      // the browser jump to the top. Snapshot scrollY before, restore after the
      // browser has had a frame to lay things out again.
      const scrollY = window.scrollY;
      onChange(m);
      requestAnimationFrame(() => {
        window.scrollTo({ top: scrollY, behavior: "instant" });
        // One more frame as a safety: chart resize/reflow can land later.
        requestAnimationFrame(() => window.scrollTo({ top: scrollY, behavior: "instant" }));
      });
    };
    container.appendChild(btn);
  }
}

// Attach drag-to-select range selection to a Chart.js chart. The canvas's
// parent must be `position: relative`. `onChange(range)` fires with `{from, to}`
// in unix seconds when the selection changes, or `null` when cleared.
//
// Returns `{ setRange(range|null) }` so the caller can drive the overlay
// programmatically (e.g. to redraw on resize / re-fetch).
function attachChartRangeSelector(canvas, onChange) {
  if (STATIC_MODE) {
    // Range filter relies on re-fetching `/api/chains/:name/validators?from&to`
    // which doesn't exist in the static dump. Skip wiring entirely.
    return { setRange() {}, repaint() {} };
  }
  const wrap = canvas.parentElement;
  let overlay = wrap.querySelector(".chart-range-overlay");
  if (!overlay) {
    overlay = document.createElement("div");
    overlay.className = "chart-range-overlay";
    wrap.appendChild(overlay);
  }
  let dragStartPx = null;
  let dragEndPx = null;
  let savedRange = null; // { from: unix, to: unix }

  function paint() {
    if (savedRange == null && dragStartPx == null) {
      overlay.style.display = "none";
      return;
    }
    overlay.style.display = "block";
    if (dragStartPx != null) {
      const a = Math.min(dragStartPx, dragEndPx);
      const b = Math.max(dragStartPx, dragEndPx);
      overlay.style.left = `${a}px`;
      overlay.style.width = `${Math.max(2, b - a)}px`;
      return;
    }
    // Persisted selection: project unix times back to pixels.
    const chart = canvas._chart;
    if (!chart) {
      overlay.style.display = "none";
      return;
    }
    const xa = chart.scales.x.getPixelForValue(savedRange.from * 1000);
    const xb = chart.scales.x.getPixelForValue(savedRange.to * 1000);
    overlay.style.left = `${Math.min(xa, xb)}px`;
    overlay.style.width = `${Math.max(2, Math.abs(xb - xa))}px`;
  }

  canvas.addEventListener("mousedown", (e) => {
    if (e.button !== 0) return;
    const rect = canvas.getBoundingClientRect();
    dragStartPx = e.clientX - rect.left;
    dragEndPx = dragStartPx;
    paint();
    e.preventDefault();
  });
  window.addEventListener("mousemove", (e) => {
    if (dragStartPx == null) return;
    const rect = canvas.getBoundingClientRect();
    dragEndPx = Math.max(0, Math.min(rect.width, e.clientX - rect.left));
    paint();
  });
  window.addEventListener("mouseup", () => {
    if (dragStartPx == null) return;
    const a = Math.min(dragStartPx, dragEndPx);
    const b = Math.max(dragStartPx, dragEndPx);
    dragStartPx = null;
    dragEndPx = null;
    if (b - a < 4) {
      // tiny drag = clear
      savedRange = null;
      paint();
      onChange(null);
      return;
    }
    const chart = canvas._chart;
    if (!chart) return;
    const ta = chart.scales.x.getValueForPixel(a);
    const tb = chart.scales.x.getValueForPixel(b);
    const t1 = Math.floor(Math.min(ta, tb) / 1000);
    const t2 = Math.ceil(Math.max(ta, tb) / 1000);
    savedRange = { from: t1, to: t2 };
    paint();
    onChange(savedRange);
  });

  // Re-paint persisted overlay on window resize so it tracks the chart.
  window.addEventListener("resize", () => paint());

  return {
    setRange(range) {
      savedRange = range;
      paint();
    },
    repaint: paint,
  };
}

function fmtRange(range) {
  if (!range) return null;
  const a = new Date(range.from * 1000);
  const b = new Date(range.to * 1000);
  const sameDay = a.toDateString() === b.toDateString();
  const f = (d) =>
    sameDay
      ? d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })
      : d.toLocaleString([], { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" });
  return `${f(a)} → ${f(b)}`;
}

function fmtPower(uaxl) {
  if (uaxl == null) return "—";
  // uaxl → AXL (10^6 base units), human formatting.
  const axl = Number(uaxl) / 1e6;
  if (axl >= 1e6) return `${(axl / 1e6).toFixed(2)}M`;
  if (axl >= 1e3) return `${(axl / 1e3).toFixed(1)}K`;
  return axl.toFixed(0);
}

async function getJSON(url, opts = {}) {
  if (STATIC_MODE) {
    return getJSONStatic(url, opts);
  }
  const res = await fetch(url, opts);
  if (!res.ok) throw new Error(`${url}: HTTP ${res.status}`);
  return await res.json();
}

// Static-mode shim: rewrite `/api/...` paths to the static JSON tree the dump
// tool produced, and turn write methods (POST /update) into no-ops.
async function getJSONStatic(url, opts = {}) {
  if (opts.method && opts.method !== "GET") {
    return await getJSONStatic("/api/status");  // refresh button just re-reads status
  }
  // /api/validators/<op>/series?chain=X — bundled by chain in series.json
  const m = url.match(/^\/api\/validators\/([^\/?]+)\/series\?chain=(.+)$/);
  if (m) {
    const op = decodeURIComponent(m[1]);
    const chain = decodeURIComponent(m[2]);
    const bundle = await fetchStaticFile(`data/validators/${encodeURIComponent(op)}/series.json`);
    return bundle[chain] ?? [];
  }
  // Drop ?from=&to= query (no client-side range filter in static mode)
  const cleaned = url.split("?")[0];
  if (!cleaned.startsWith("/api/")) return await fetchStaticFile(cleaned);
  const path = cleaned.replace(/^\/api\//, "data/") + ".json";
  return await fetchStaticFile(path);
}
async function fetchStaticFile(path) {
  const res = await fetch(path);
  if (!res.ok) throw new Error(`${path}: HTTP ${res.status}`);
  return await res.json();
}

function fmtTs(unix) {
  if (!unix) return "—";
  const d = new Date(unix * 1000);
  return d.toLocaleString();
}

function pct(n, total) {
  if (!total) return "—";
  return `${((100 * n) / total).toFixed(1)}%`;
}

async function refreshStatus(el) {
  const s = await getJSON("/api/status");
  const behind = s.blocks_behind == null ? "?" : s.blocks_behind.toLocaleString();
  el.textContent =
    `top ${s.top_height ?? "—"} • bottom ${s.bottom_height ?? "—"} • ` +
    `head ${s.head ?? "—"} • behind ${behind} • ` +
    `polls ${s.poll_count} • votes ${s.vote_count} • last run ${fmtTs(s.last_run_at)}`;
  return s;
}

async function doUpdate(btn, statusEl) {
  if (STATIC_MODE) {
    // No live update path in a static deployment.
    return;
  }
  btn.disabled = true;
  const orig = btn.textContent;
  btn.textContent = "Indexing…";
  try {
    await getJSON("/update", { method: "POST" });
    await refreshStatus(statusEl);
  } catch (e) {
    alert(`Update failed: ${e.message}`);
  } finally {
    btn.disabled = false;
    btn.textContent = orig;
  }
}

// Hide every Refresh button on the page when STATIC_MODE is active.
// Called once at DOMContentLoaded by each page.
function hideRefreshIfStatic() {
  if (!STATIC_MODE) return;
  document.querySelectorAll("#refresh").forEach((b) => (b.style.display = "none"));
  // Rewrite the "← all chains" link too. Using `homePageUrl()` keeps relative
  // paths working under whatever base path the static deploy lives at.
  document.querySelectorAll("#home-link").forEach((a) => (a.href = homePageUrl()));
}

// Page-link helpers that pick path-style URLs (dynamic) vs query-string URLs
// (static, since GitHub Pages can't dispatch on /chain/:name).
function chainPageUrl(name) {
  return STATIC_MODE
    ? `chain.html?name=${encodeURIComponent(name)}`
    : `/chain/${encodeURIComponent(name)}`;
}
function validatorPageUrl(op) {
  return STATIC_MODE
    ? `validator.html?op=${encodeURIComponent(op)}`
    : `/validator/${encodeURIComponent(op)}`;
}
function homePageUrl() {
  return STATIC_MODE ? "index.html" : "/";
}

// Extract the chain name from either ?name=... (static) or the path tail (dynamic).
function readChainName() {
  const q = new URLSearchParams(location.search).get("name");
  if (q) return q;
  return decodeURIComponent(location.pathname.split("/").pop());
}
function readOperator() {
  const q = new URLSearchParams(location.search).get("op");
  if (q) return q;
  return decodeURIComponent(location.pathname.split("/").pop());
}

function buildStackedAreaChart(canvas, buckets) {
  const mode = getViewMode();
  const labels = buckets.map((b) => new Date(b.ts * 1000));
  const datasets = ORDER.map((k) => ({
    label: k,
    data: buckets.map((b) => {
      const denom = totalFor(b, mode) || 1;
      const v = valFor(b, k, mode);
      // Pending is shown on its own scale (overlay), since it isn't a tallied outcome.
      if (k === "PENDING") return v;
      return (100 * v) / denom;
    }),
    borderColor: COLORS[k],
    backgroundColor: COLORS[k] + "55",
    fill: k === "PENDING" ? false : true,
    stack: k === "PENDING" ? undefined : "outcome",
    tension: 0.2,
    pointRadius: 0,
    yAxisID: k === "PENDING" ? "yPending" : "y",
  }));
  // Reference line at 60% of BondedWeight — the live chain's actual EVM
  // voting_threshold (queried from `axelard q evm params <chain>` on mainnet:
  // numerator=3, denominator=5). This is per-chain in principle but currently
  // identical across every EVM chain. Hidden in vote-count mode where the
  // threshold isn't a percentage of validator-count.
  if (mode === "stake" || mode === "future") {
    datasets.push({
      label: "60% threshold",
      data: buckets.map(() => 60),
      borderColor: "#f85149",
      backgroundColor: "transparent",
      borderDash: [6, 4],
      borderWidth: 1.5,
      fill: false,
      pointRadius: 0,
      tension: 0,
      yAxisID: "y",
      // not part of the stack, draws on top of the area
      stack: undefined,
      order: 0,
    });
  }

  const pendingLabel =
    mode === "stake"  ? "PENDING (qweight)" :
    mode === "future" ? "PENDING (future qweight)" :
                        "PENDING";
  return new Chart(canvas, {
    type: "line",
    data: { labels, datasets },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      animation: false,
      interaction: { mode: "index", intersect: false },
      plugins: {
        legend: { labels: { color: "#e6edf3", boxWidth: 10 } },
        tooltip: {
          callbacks: {
            label: (ctx) => {
              if (ctx.dataset.label === "PENDING") {
                return `${pendingLabel}: ${ctx.raw}`;
              }
              if (ctx.dataset.label === "60% threshold") {
                return `EVM consensus threshold: 60% of BondedWeight (3/5)`;
              }
              return `${ctx.dataset.label}: ${ctx.raw.toFixed(1)}% (${mode})`;
            },
          },
          // Hide the threshold's filtered-by-default index entry to keep tooltips clean
          filter: (item) => item.dataset.label !== "60% threshold" || item.parsed.y === 60,
        },
      },
      scales: {
        x: {
          type: "time",
          time: { unit: "hour" },
          ticks: { color: "#8b949e", maxTicksLimit: 8 },
          grid: { color: "#21262d" },
        },
        y: {
          stacked: true,
          min: 0,
          max: 100,
          ticks: { color: "#8b949e", callback: (v) => `${v}%` },
          grid: { color: "#21262d" },
        },
        yPending: {
          position: "right",
          min: 0,
          ticks: { color: "#6e7681" },
          grid: { drawOnChartArea: false },
        },
      },
    },
  });
}

// Find every chart point whose rendered position is within `radiusPx` of (x,y).
// Returns an array of {datasetIndex, index, raw, label} sorted by closeness.
// Used to handle overlapping points: many polls can stack on the same x,y.
function findOverlappingPoints(chart, x, y, radiusPx = 10) {
  const matches = [];
  for (let di = 0; di < chart.data.datasets.length; di++) {
    const ds = chart.data.datasets[di];
    if (!ds.data) continue;
    for (let i = 0; i < ds.data.length; i++) {
      const meta = chart.getDatasetMeta(di);
      if (meta.hidden) continue;
      const el = meta.data && meta.data[i];
      if (!el) continue;
      const dx = el.x - x;
      const dy = el.y - y;
      const dist = Math.hypot(dx, dy);
      if (dist <= radiusPx) {
        matches.push({ datasetIndex: di, index: i, raw: ds.data[i], label: ds.label, dist });
      }
    }
  }
  matches.sort((a, b) => a.dist - b.dist);
  return matches;
}

// Floating popup listing multiple overlapping polls. Persists until user picks
// one or clicks outside. Stack a single shared popup so we never end up with
// orphans when re-rendering charts.
function showPollPicker(canvas, anchor, items) {
  closePollPicker();
  const popup = document.createElement("div");
  popup.className = "poll-picker";
  popup.innerHTML = `
    <div class="poll-picker-header">
      <span>${items.length} polls at this point</span>
      <button class="poll-picker-close" type="button" aria-label="close">×</button>
    </div>
    <div class="poll-picker-body"></div>
  `;
  document.body.appendChild(popup);
  const body = popup.querySelector(".poll-picker-body");
  for (const it of items) {
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = "poll-picker-item";
    const d = new Date(it.raw.ts * 1000);
    const dateStr = d.toLocaleString([], {
      month: "short", day: "numeric", hour: "2-digit", minute: "2-digit",
    });
    btn.innerHTML = `
      <span class="poll-picker-outcome" style="color: ${COLORS[it.label] || "#e6edf3"}">${it.label}</span>
      <span class="poll-picker-pollid">#${it.raw.poll_id}</span>
      <span class="poll-picker-date">${dateStr}</span>
    `;
    btn.onclick = () => {
      window.open(`https://axelarscan.io/evm-poll/${it.raw.poll_id}`, "_blank", "noopener");
      closePollPicker();
    };
    body.appendChild(btn);
  }
  // Position near the click. Clamp into viewport.
  const rect = canvas.getBoundingClientRect();
  const desiredLeft = rect.left + window.scrollX + anchor.x + 12;
  const desiredTop = rect.top + window.scrollY + anchor.y + 12;
  popup.style.left = `${desiredLeft}px`;
  popup.style.top = `${desiredTop}px`;
  // Adjust if it would overflow the right edge.
  requestAnimationFrame(() => {
    const pr = popup.getBoundingClientRect();
    if (pr.right > window.innerWidth - 8) {
      popup.style.left = `${desiredLeft - pr.width - 24}px`;
    }
    if (pr.bottom > window.innerHeight + window.scrollY - 8) {
      popup.style.top = `${desiredTop - pr.height - 24}px`;
    }
  });
  popup.querySelector(".poll-picker-close").onclick = closePollPicker;
  // Dismiss on outside click or Escape.
  setTimeout(() => {
    document.addEventListener("mousedown", _pollPickerOutside, { once: false });
    document.addEventListener("keydown", _pollPickerEscape, { once: false });
  }, 0);
}

function closePollPicker() {
  const existing = document.querySelector(".poll-picker");
  if (existing) existing.remove();
  document.removeEventListener("mousedown", _pollPickerOutside);
  document.removeEventListener("keydown", _pollPickerEscape);
}
function _pollPickerOutside(e) {
  if (!e.target.closest(".poll-picker")) closePollPicker();
}
function _pollPickerEscape(e) {
  if (e.key === "Escape") closePollPicker();
}

function buildValidatorTimeline(canvas, points) {
  // Each point is {poll_id, ts, outcome}; render as scatter with color by outcome.
  // Carry poll_id and ts on each chart-point so the tooltip and click handler
  // can recover them — `ctx.dataIndex` is the index *within the filtered
  // dataset*, so indexing the unfiltered `points` array gives the wrong poll.
  const datasets = ORDER.map((k) => ({
    label: k,
    data: points
      .filter((p) => p.outcome === k)
      .map((p) => ({ x: new Date(p.ts * 1000), y: ORDER.indexOf(k), poll_id: p.poll_id, ts: p.ts })),
    backgroundColor: COLORS[k],
    pointRadius: 4,
    pointHoverRadius: 6,
    showLine: false,
  }));
  return new Chart(canvas, {
    type: "scatter",
    data: { datasets },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      animation: false,
      // Click a point → if exactly one poll under the cursor, open it.
      // If multiple polls overlap (same outcome at near-identical times), pop a
      // persistent picker so the user can pick which one to open.
      onClick: (evt, _active, chart) => {
        const rect = chart.canvas.getBoundingClientRect();
        const x = evt.x ?? (evt.native && evt.native.clientX - rect.left);
        const y = evt.y ?? (evt.native && evt.native.clientY - rect.top);
        if (x == null || y == null) return;
        const matches = findOverlappingPoints(chart, x, y, 10);
        if (matches.length === 0) return;
        if (matches.length === 1) {
          const r = matches[0].raw;
          window.open(`https://axelarscan.io/evm-poll/${r.poll_id}`, "_blank", "noopener");
          return;
        }
        // De-dup by poll_id (a single poll can't show twice in a real dataset,
        // but guard against future code paths).
        const seen = new Set();
        const unique = matches.filter(m => {
          if (seen.has(m.raw.poll_id)) return false;
          seen.add(m.raw.poll_id);
          return true;
        });
        showPollPicker(chart.canvas, { x, y }, unique);
      },
      onHover: (evt, _active, chart) => {
        const els = chart.getElementsAtEventForMode(evt, "nearest", { intersect: true }, true);
        chart.canvas.style.cursor = els.length ? "pointer" : "crosshair";
      },
      plugins: {
        legend: { labels: { color: "#e6edf3", boxWidth: 10 } },
        tooltip: {
          callbacks: {
            label: (ctx) => {
              const d = new Date(ctx.raw.ts * 1000);
              const date = d.toLocaleString([], {
                month: "short", day: "numeric",
                hour: "2-digit", minute: "2-digit",
              });
              return `${ctx.dataset.label} • poll ${ctx.raw.poll_id} • ${date}  (click to open)`;
            },
          },
        },
      },
      scales: {
        x: {
          type: "time",
          time: { unit: "hour" },
          ticks: { color: "#8b949e" },
          grid: { color: "#21262d" },
        },
        y: {
          ticks: {
            color: "#8b949e",
            stepSize: 1,
            callback: (v) => ORDER[v] ?? "",
          },
          min: -0.5,
          max: ORDER.length - 0.5,
          grid: { color: "#21262d" },
        },
      },
    },
  });
}
