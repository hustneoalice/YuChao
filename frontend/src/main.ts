/* 入口：导航 / 全局搜索 / 主题 / SSE 接线 / 启动 */
import "./styles.css";
import { ic, injectIcons } from "./icons";
import { marketApi } from "./api";
import { applyAppearance, getState, patch, subscribe } from "./store";
import { toast } from "./ui";
import { initAuth, refreshVipUI } from "./auth";
import { initMarket, openStock, renderKline, renderRight, renderStockHead } from "./pages/market";
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
  const draw = (q: string) => {
    if (!q) { drop.classList.remove("on"); return; }
    drop.innerHTML = hits.map((u) =>
      `<div class="gitem" data-c="${u.symbol}"><b>${u.name || u.symbol}</b><span class="num">${u.symbol}</span></div>`).join("") ||
      `<div class="gitem" style="color:var(--faint)">未找到匹配标的</div>`;
    drop.classList.add("on");
    drop.querySelectorAll<HTMLElement>(".gitem[data-c]").forEach((it) =>
      it.addEventListener("click", () => {
        const u = hits.find((x) => x.symbol === it.dataset.c);
        void openStock({ symbol: it.dataset.c!, name: u?.name || it.dataset.c! });
        input.value = "";
        drop.classList.remove("on");
        toast(`已切换至 ${u?.name || it.dataset.c}`);
      }));
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
      renderRight();
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
