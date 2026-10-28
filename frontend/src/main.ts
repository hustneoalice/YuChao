/* 入口：导航 / 全局搜索 / 主题 / SSE 接线 / 启动 */
import "./styles.css";
import { ic, injectIcons } from "./icons";
import { marketApi } from "./api";
import { fmtChg } from "./fmt";
import { applyAppearance, getState, patch, subscribe } from "./store";
import { toast } from "./ui";
import { initAuth, refreshVipUI } from "./auth";
import { initMarket, klResize, openStock, renderKline, renderStockHead } from "./pages/market";
import { initWatchlist, renderWatchlist } from "./pages/watchlist";
import { initSectors, loadSectors } from "./pages/sectors";
import { initCorepicks, renderCorepicks } from "./pages/corepicks";
import { initCards, renderCards } from "./pages/cards";
import { initSettings, refreshDatachip, openSettingsTab } from "./pages/settings";
import { SseClient } from "./sse";

const loaded = { watchlist: false, sectors: false, corepicks: false };

function goPage(p: string): void {
  document.querySelectorAll(".page").forEach((x) => x.classList.toggle("on", x.id === "page-" + p));
  document.querySelectorAll("#rail a").forEach((a) => a.classList.toggle("on", (a as HTMLElement).dataset.page === p));
  document.querySelectorAll("#mtabs a").forEach((a) => a.classList.toggle("on", (a as HTMLElement).dataset.page === p));
  if (p === "market") renderKline();
  if (p === "watchlist" && !loaded.watchlist) { loaded.watchlist = true; renderWatchlist(); }
  if (p === "sectors" && !loaded.sectors) { loaded.sectors = true; void loadSectors(); }
  if (p === "corepicks" && !loaded.corepicks) { loaded.corepicks = true; initCorepicks(); }
  if (p === "cards") renderCards();
}

/* ── 全局搜索 ── */
function initSearch(): void {
  const input = document.getElementById("ginput") as HTMLInputElement;
  const drop = document.getElementById("gdrop")!;
  let seq = 0;
  let hits: { symbol: string; name?: string }[] = [];
  const chgCache = new Map<string, number | null>(); // symbol → pct_chg（会话级缓存，避免重复请求）
  // 搜索历史（全局，最近 10 条，新的在前）
  const HKEY = "yc_search_history";
  const loadHist = (): { symbol: string; name?: string }[] => {
    try { return JSON.parse(localStorage.getItem(HKEY) || "[]") as typeof hits; } catch { return []; }
  };
  const saveHist = (u: { symbol: string; name?: string }) => {
    const list = loadHist().filter((x) => x.symbol !== u.symbol);
    list.unshift({ symbol: u.symbol, name: u.name });
    localStorage.setItem(HKEY, JSON.stringify(list.slice(0, 10)));
  };
  const itemHtml = (u: { symbol: string; name?: string }) => {
    const chg = chgCache.get(u.symbol);
    const chgHtml = chg == null ? "" :
      `<span class="chg num ${chg >= 0 ? "up" : "down"}">${fmtChg(chg)}%</span>`;
    return `<div class="gitem" data-c="${u.symbol}" data-n="${u.name || ""}"><b>${u.name || u.symbol}</b><span class="num">${u.symbol}</span>${chgHtml}</div>`;
  };
  const draw = () => {
    drop.innerHTML = hits.map(itemHtml).join("") ||
      `<div class="gitem" style="color:var(--faint)">未找到匹配标的</div>`;
    drop.classList.add("on");
  };
  // 空输入 / 聚焦 → 历史下拉（复用 hits 与涨跌幅回填通道）
  const drawHist = () => {
    hits = loadHist();
    if (!hits.length) { drop.classList.remove("on"); return; }
    drop.innerHTML = `<div class="ghead">最近搜索<span id="ghist-clear">清空</span></div>` +
      hits.map(itemHtml).join("");
    drop.classList.add("on");
    fetchChg(seq);
  };
  // 事件委托绑定一次：fetchChg 回填涨跌幅会就地插入 .chg span，
  // 绝不整体重绘 innerHTML——mousedown/mouseup 之间 DOM 被替换会让 click 被吞
  drop.addEventListener("click", (e) => {
    const t = e.target as HTMLElement;
    if (t.closest("#ghist-clear")) {
      localStorage.removeItem(HKEY);
      drop.classList.remove("on");
      return;
    }
    const it = t.closest<HTMLElement>(".gitem[data-c]");
    if (!it) return;
    const sym = it.dataset.c!, name = it.dataset.n || sym;
    saveHist({ symbol: sym, name });
    void openStock({ symbol: sym, name });
    input.value = "";
    input.blur();
    drop.classList.remove("on");
    toast(`已切换至 ${name}`);
  });
  // 并发补拉涨跌幅（quote 未命中/失败时缓存 null，不阻塞首屏下拉）。
  // 回填时只就地插入 .chg span，绝不整体重绘 innerHTML——
  // mousedown/mouseup 之间 DOM 被替换会让 click 落到容器上被丢弃（点击被吞）
  const fetchChg = (mySeq: number) => {
    void Promise.allSettled(
      hits.map(async (u) => {
        if (chgCache.has(u.symbol)) return;
        try {
          const qt = await marketApi.quote(u.symbol);
          chgCache.set(u.symbol, qt.pct_chg ?? null);
        } catch { chgCache.set(u.symbol, null); }
      })
    ).then(() => {
      if (mySeq !== seq) return;
      hits.forEach((u) => {
        const chg = chgCache.get(u.symbol);
        if (chg == null) return;
        const el = drop.querySelector<HTMLElement>(`.gitem[data-c="${u.symbol}"]`);
        if (!el || el.querySelector(".chg")) return;
        el.insertAdjacentHTML("beforeend",
          `<span class="chg num ${chg >= 0 ? "up" : "down"}">${fmtChg(chg)}%</span>`);
      });
    });
  };
  const filter = async () => {
    const q = input.value.trim();
    const mySeq = ++seq;
    if (!q) { drawHist(); return; }
    try {
      const r = await marketApi.search(q, 10);
      if (mySeq !== seq) return;
      hits = r.items;
      draw();
      fetchChg(mySeq);
    } catch {
      if (mySeq === seq) {
        drop.innerHTML = `<div class="gitem" style="color:var(--faint)">搜索服务不可达</div>`;
        drop.classList.add("on");
      }
    }
  };
  input.addEventListener("input", filter);
  input.addEventListener("focus", () => { if (!input.value.trim()) drawHist(); });
  input.addEventListener("keydown", (e) => {
    if (e.key === "Enter") {
      const f = drop.querySelector<HTMLElement>(".gitem[data-c]");
      if (f) f.click();
    }
    if (e.key === "Escape") drop.classList.remove("on");
  });
  document.addEventListener("click", (e) => {
    if (!(e.target as HTMLElement).closest(".gsearch")) drop.classList.remove("on");
  });
  document.addEventListener("keydown", (e) => {
    if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "k") {
      e.preventDefault();
      input.focus();
      input.select();
    }
  });
}

/* ── 侧栏宽度拖拽（--rail-w，localStorage 持久化） ── */
function initRailResize(): void {
  const grip = document.getElementById("rail-grip")!;
  const apply = (w: number) =>
    document.documentElement.style.setProperty("--rail-w", `${w}px`);
  const saved = Number(localStorage.getItem("yc_rail_w"));
  if (saved >= 64 && saved <= 220) apply(saved);
  grip.addEventListener("mousedown", (e) => {
    e.preventDefault();
    grip.classList.add("on");
    document.body.style.cursor = "col-resize";
    document.body.style.userSelect = "none";
    const move = (ev: MouseEvent) => {
      // 预留拖拽手柄自身 3px 悬出，取指针位置即目标宽度
      const w = Math.min(220, Math.max(64, ev.clientX));
      apply(w);
      localStorage.setItem("yc_rail_w", String(w));
      // 行情页图表跟随重排
      clearTimeout((window as unknown as { _rz?: number })._rz);
      (window as unknown as { _rz?: number })._rz = window.setTimeout(() => {
        if (document.getElementById("page-market")!.classList.contains("on")) klResize();
      }, 120);
    };
    const up = () => {
      grip.classList.remove("on");
      document.body.style.cursor = "";
      document.body.style.userSelect = "";
      window.removeEventListener("mousemove", move);
      window.removeEventListener("mouseup", up);
    };
    window.addEventListener("mousemove", move);
    window.addEventListener("mouseup", up);
  });
}

/* ── 设备模式（桌面 / 手机）：顶栏 seg 切换，body.mobile 驱动移动布局 ── */
type DeviceMode = "desktop" | "mobile";
function applyDevice(m: DeviceMode, persist = true): void {
  document.body.classList.toggle("mobile", m === "mobile");
  document.querySelectorAll<HTMLElement>("#dev-toggle button").forEach((b) =>
    b.classList.toggle("on", b.dataset.dev === m));
  if (persist) localStorage.setItem("yc_device", m);
  if (document.getElementById("page-market")!.classList.contains("on")) klResize();
}
function initDevice(): void {
  const saved = localStorage.getItem("yc_device") as DeviceMode | null;
  const mode: DeviceMode = saved ?? (window.matchMedia("(max-width: 760px)").matches ? "mobile" : "desktop");
  applyDevice(mode, saved != null); // 首次访问跟随视口且不落盘，手动切换后才记忆
  document.getElementById("dev-toggle")!.addEventListener("click", (e) => {
    const b = (e.target as HTMLElement).closest<HTMLElement>("button[data-dev]");
    if (b) applyDevice(b.dataset.dev as DeviceMode);
  });
  document.querySelectorAll<HTMLElement>("#mtabs a").forEach((a) =>
    a.addEventListener("click", () => goPage(a.dataset.page!)));
}

/* ── 启动 ── */
function boot(): void {
  applyAppearance();
  injectIcons();
  bindNav();
  initDevice();
  initRailResize();
  initSearch();
  initAuth();
  initMarket();
  initWatchlist();
  initSectors();
  initCards();
  initSettings();

  // 主题按钮
  const btn = document.getElementById("btn-theme")!;
  const drawTheme = () => { btn.innerHTML = ic(getState().theme === "dark" ? "moon" : "sun", 16); };
  drawTheme();
  btn.addEventListener("click", () => {
    const next = getState().theme === "dark" ? "light" : "dark";
    localStorage.setItem("yc_theme", JSON.stringify(next));
    document.dispatchEvent(new CustomEvent("yc:patch-theme", { detail: next }));
  });
  subscribe(drawTheme);

  // 顶栏数据 chip 点击 → 数据底座看板
  document.getElementById("datachip")!.addEventListener("click", () => {
    document.dispatchEvent(new CustomEvent("yc:goto-settings", { detail: "data" }));
  });

  // 跨页事件
  document.addEventListener("yc:goto-page", (e) => goPage((e as CustomEvent).detail));
  document.addEventListener("yc:open-stock", (e) => {
    const d = (e as CustomEvent).detail;
    void openStock(d, d.from);
  });
  document.addEventListener("yc:goto-settings", (e) => { goPage("settings"); openSettingsTab((e as CustomEvent).detail); });
  document.addEventListener("yc:patch-theme", (e) => {
    patch("theme", (e as CustomEvent).detail as "dark" | "light");
  });
  subscribe(() => {
    applyAppearance();          // 主题/涨跌方向/强调色 → data-* 属性（缺此行切换不生效）
    refreshVipUI();
    if (document.getElementById("page-market")!.classList.contains("on")) {
      renderStockHead();
      renderKline();
    }
  });

  // SSE：底座状态推送 → 刷新 datachip；license 变化 → 刷新 VIP UI
  const sse = new SseClient(["data:update", "corepicks:daily"], (ch) => {
    if (ch === "data:update") void refreshDatachip();
  });
  sse.on((ev) => {
    if (ev.channel === "data:update") void refreshDatachip();
    if (ev.channel === "corepicks:daily") {
      loaded.corepicks = false;
      if (document.getElementById("page-corepicks")!.classList.contains("on")) {
        loaded.corepicks = true;
        void renderCorepicks();
      }
      toast("核心标名单已更新");
    }
  });
  sse.start();

  // 启动默认视图：有上次标的则恢复，否则默认上证指数（大盘即首页）
  const last = localStorage.getItem("yc_last_symbol");
  if (last) {
    const [symbol, name] = last.split("|");
    void openStock({ symbol, name: name || symbol });
  } else {
    void openStock({ symbol: "000001.SH", name: "上证指数" });
  }
}

function bindNav(): void {
  document.querySelectorAll<HTMLElement>("#rail a").forEach((a) =>
    a.addEventListener("click", () => goPage(a.dataset.page!)));
}

boot();
