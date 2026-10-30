/* 加入自选 + 分组管理面板（modal-watch）：
   主流做法（同花顺/雪球）——star 一键加入默认分组；面板内单选分组 / 新建分组 / 移出自选。
   供行情页工具栏 star、核心标明细弹窗等所有「加自选」入口复用。
   变更走 store（emit）→ 左侧自选页、自选股卡片自动同步。 */
import { esc } from "./fmt";
import { addWatch, getState, isWatched, moveWatchGroup, removeWatch } from "./store";
import { closeModals, openModal, toast } from "./ui";

let cur: { symbol: string; name: string } | null = null;
let picked = "默认"; // 面板当前选中的分组

function allGroups(): string[] {
  const gs = Array.from(new Set(getState().watchlist.map((w) => w.group || "默认")));
  return ["默认", ...gs.filter((g) => g !== "默认")];
}

function drawPanel(): void {
  if (!cur) return;
  const watched = isWatched(cur.symbol);
  const w = getState().watchlist.find((x) => x.symbol === cur!.symbol);
  if (watched) picked = w?.group || "默认";
  const list = allGroups();
  if (watched && w && !list.includes(w.group)) list.push(w.group);
  document.getElementById("wm-title")!.textContent = watched ? "自选分组" : "加入自选";
  document.getElementById("wm-stock")!.innerHTML =
    `<b>${cur.name}</b> <span class="num">${cur.symbol}</span> · 选择分组`;
  document.getElementById("wm-groups")!.innerHTML = list.map((g) =>
    `<div class="wm-g${picked === g ? " on" : ""}" data-g="${esc(g)}"><span>${esc(g)}</span>${picked === g ? "<i></i>" : ""}</div>`).join("");
  document.querySelectorAll<HTMLElement>("#wm-groups .wm-g").forEach((el) =>
    el.addEventListener("click", () => {
      picked = el.dataset.g!;
      (document.getElementById("wm-new") as HTMLInputElement).value = "";
      drawPanel();
    }));
  (document.getElementById("wm-remove") as HTMLElement).hidden = !watched;
}

/** 打开「加入自选 / 分组管理」面板（已自选 → 选中其所在分组） */
export function openWatchPanel(symbol: string, name: string): void {
  cur = { symbol, name: name || symbol };
  const w = getState().watchlist.find((x) => x.symbol === symbol);
  picked = w ? (w.group || "默认") : "默认";
  (document.getElementById("wm-new") as HTMLInputElement).value = "";
  drawPanel();
  closeModals();              // 可能从其他弹窗（核心标明细）进入：先关避免叠加
  openModal("modal-watch");
}

export function initWatchPanel(): void {
  const ok = document.getElementById("wm-ok")!;
  ok.addEventListener("click", () => {
    if (!cur) return;
    const custom = (document.getElementById("wm-new") as HTMLInputElement).value.trim();
    const g = custom || picked || "默认";
    if (isWatched(cur.symbol)) {
      const w = getState().watchlist.find((x) => x.symbol === cur!.symbol);
      if (w && w.group !== g) { moveWatchGroup(cur.symbol, g); toast(`已移入「${g}」`); }
      else closeModals();
    } else {
      addWatch(cur.symbol, cur.name, g);
      toast(`已加入自选 · ${g}`);
    }
    closeModals();
  });
  document.getElementById("wm-remove")!.addEventListener("click", () => {
    if (!cur) return;
    removeWatch(cur.symbol);
    toast(`已将 ${cur.name} 移出自选`);
    closeModals();
  });
  (document.getElementById("wm-new") as HTMLInputElement).addEventListener("keydown", (e) => {
    if (e.key === "Enter") ok.click();
  });
}
