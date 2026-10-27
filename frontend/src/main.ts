/* 入口：导航 / 全局搜索 / 主题 / SSE 接线 / 启动 */
import "./styles.css";
import { ic, injectIcons } from "./icons";
import { marketApi } from "./api";
import { fmtChg } from "./fmt";
import { applyAppearance, getState, patch, subscribe } from "./store";
import { toast } from "./ui";
import { initAuth, refreshVipUI } from "./auth";
import { initMarket, openStock, renderKline, renderStockHead } from "./pages/market";
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
  const draw = (q: string) => {
    if (!q) { drop.classList.remove("on"); return; }
    drop.innerHTML = hits.map((u) => {
      const chg = chgCache.get(u.symbol);
      const chgHtml = chg == null ? "" :
        `<span class="chg num ${chg >= 0 ? "up" : "down"}">${fmtChg(chg)}%</span>`;
      return `<div class="gitem" data-c="${u.symbol}"><b>${u.name || u.symbol}</b><span class="num">${u.symbol}</span>${chgHtml}</div>`;
    }).join("") ||
      `<div class="gitem" style="color:var(--faint)">未找到匹配标的</div>`;
    drop.classList.add("on");
  };
  // 事件委托绑定一次：fetchChg 回填涨跌幅会整体重绘 innerHTML，
  // 逐项 addEventListener 会把用户正要点击的项替换掉（点击被吞）
  drop.addEventListener("click", (e) => {
    const it = (e.target as HTMLElement).closest<HTMLElement>(".gitem[data-c]");
    if (!it) return;
    const sym = it.dataset.c!;
    const u = hits.find((x) => x.symbol === sym);
    void openStock({ symbol: sym, name: u?.name || sym });
    input.value = "";
    drop.classList.remove("on");
    toast(`已切换至 ${u?.name || sym}`);
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
    if (!q) { drop.classList.remove("on"); return; }
    try {
      const r = await marketApi.search(q, 10);
      if (mySeq !== seq) return;
      hits = r.items;
      draw(q);
      fetchChg(mySeq);
    } catch {
      if (mySeq === seq) {
        drop.innerHTML = `<div class="gitem" style="color:var(--faint)">搜索服务不可达</div>`;
        drop.classList.add("on");
      }
    }
  };
  input.addEventListener("input", filter);
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

/* ── 启动 ── */
function boot(): void {
  applyAppearance();
  injectIcons();
  bindNav();
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

  // 启动默认视图：若本地有上次标的则恢复，否则空态
  const last = localStorage.getItem("yc_last_symbol");
  if (last) {
    const [symbol, name] = last.split("|");
    void openStock({ symbol, name: name || symbol });
  }
}

function bindNav(): void {
  document.querySelectorAll<HTMLElement>("#rail a").forEach((a) =>
    a.addEventListener("click", () => goPage(a.dataset.page!)));
}

boot();
