/* 加入自选 + 分组管理面板（modal-watch）：
   主流做法（同花顺/雪球）——star 一键加入默认分组；面板内多选分组 / 新建分组 / 移出自选。
   供行情页工具栏 star、核心标明细弹窗等所有「加自选」入口复用。
   变更走 store（emit）→ 左侧自选页、自选股卡片自动同步。 */
import { esc } from "./fmt";
import { ic } from "./icons";
import { addWatch, addWatchGroup, allWatchGroups, getState, isWatched, removeWatch, removeWatchGroup, renameWatchGroup, setWatchGroups } from "./store";
import { closeModals, openModal, toast } from "./ui";

let cur: { symbol: string; name: string } | null = null;
let picked: string[] = ["默认"];   // 面板当前选中的分组（多选，一只股票可属于多个组）

function allGroups(): string[] {
  return allWatchGroups();
}

function drawPanel(): void {
  if (!cur) return;
  const watched = isWatched(cur.symbol);
  const list = allGroups();
  document.getElementById("wm-title")!.textContent = watched ? "自选分组" : "加入自选";
  document.getElementById("wm-stock")!.innerHTML =
    `<b>${cur.name}</b> <span class="num">${cur.symbol}</span> · 选择分组（可多选）`;
  document.getElementById("wm-groups")!.innerHTML = list.map((g) =>
    `<div class="wm-g${picked.includes(g) ? " on" : ""}" data-g="${esc(g)}"><span>${esc(g)}</span>${picked.includes(g) ? `<span class="wm-tick">${esc("✓")}</span>` : ""}</div>`).join("");
  document.querySelectorAll<HTMLElement>("#wm-groups .wm-g").forEach((el) =>
    el.addEventListener("click", () => {
      const g = el.dataset.g!;
      picked = picked.includes(g) ? picked.filter((x) => x !== g) : [...picked, g];
      if (!picked.length) picked = ["默认"];    // 至少保留一个分组
      (document.getElementById("wm-new") as HTMLInputElement).value = "";
      drawPanel();
    }));
  (document.getElementById("wm-remove") as HTMLElement).hidden = !watched;
}

/** 打开「加入自选 / 分组管理」面板（已自选 → 勾选其所在全部分组） */
export function openWatchPanel(symbol: string, name: string): void {
  cur = { symbol, name: name || symbol };
  const w = getState().watchlist.find((x) => x.symbol === symbol);
  picked = w?.groups.length ? [...w.groups] : ["默认"];
  (document.getElementById("wm-new") as HTMLInputElement).value = "";
  drawPanel();
  closeModals();              // 可能从其他弹窗（核心标明细）进入：先关避免叠加
  openModal("modal-watch");
}

/** 分组管理面板（modal-groups）：改名 / 删除 / 新建（与「一只股票多个分组」分开） */
function drawGroupPanel(): void {
  const groups = allWatchGroups();
  const wl = getState().watchlist;
  document.getElementById("gm-count")!.textContent = `${groups.length} 个分组`;
  document.getElementById("gm-list")!.innerHTML = groups.map((g) => {
    const n = wl.filter((w) => w.groups.includes(g)).length;
    const fixed = g === "默认";
    return `<div class="gm-row" data-g="${esc(g)}">
      <input class="gm-in" value="${esc(g)}" maxlength="16" ${fixed ? "readonly" : ""} title="${fixed ? "默认分组不可改名" : "改名后回车或点 ✓ 保存"}">
      <span class="gm-n num">${n} 只</span>
      ${fixed ? `<span class="gm-lock" title="默认分组不可删除">${ic("lock", 12)}</span>` :
        `<button class="gm-btn" data-gm-save title="保存改名">${ic("check", 12)}</button>
         <button class="gm-btn danger" data-gm-del title="删除分组">${ic("trash", 12)}</button>`}
    </div>`;
  }).join("");
  document.querySelectorAll<HTMLElement>("#gm-list .gm-row").forEach((row) => {
    const g = row.dataset.g!;
    if (g === "默认") return;
    const inp = row.querySelector<HTMLInputElement>(".gm-in")!;
    const save = (): void => {
      const to = inp.value.trim();
      if (!to) { toast("分组名不能为空"); inp.value = g; return; }
      if (to === g) return;
      if (!renameWatchGroup(g, to)) { toast(`分组「${to}」已存在`); inp.value = g; inp.select(); return; }
      toast(`分组已改名为「${to}」`);
      drawGroupPanel();
    };
    row.querySelector("[data-gm-save]")!.addEventListener("click", save);
    inp.addEventListener("keydown", (e) => { if (e.key === "Enter") { e.preventDefault(); save(); } });
    row.querySelector("[data-gm-del]")!.addEventListener("click", () => {
      const n = wl.filter((w) => w.groups.includes(g)).length;
      if (!removeWatchGroup(g)) return;
      toast(n ? `已删除「${g}」· ${n} 只股票回到默认` : `已删除分组「${g}」`);
      drawGroupPanel();
    });
  });
}

/** 打开分组管理面板（右卡分组栏 / 自选页均复用） */
export function openGroupPanel(): void {
  (document.getElementById("gm-new") as HTMLInputElement).value = "";
  drawGroupPanel();
  closeModals();
  openModal("modal-groups");
}

export function initWatchPanel(): void {
  const ok = document.getElementById("wm-ok")!;
  ok.addEventListener("click", () => {
    if (!cur) return;
    const custom = (document.getElementById("wm-new") as HTMLInputElement).value.trim();
    if (custom) addWatchGroup(custom);   // 新建的空分组也要进注册表，避免随股票移出而消失
    let gs = custom ? [...picked, custom] : [...picked];
    gs = Array.from(new Set(gs));
    if (isWatched(cur.symbol)) {
      setWatchGroups(cur.symbol, gs);
      toast(`分组已更新 · ${gs.join(" / ")}`);
    } else {
      addWatch(cur.symbol, cur.name, gs[0] || "默认");
      setWatchGroups(cur.symbol, gs);
      toast(`已加入自选 · ${gs.join(" / ")}`);
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

  // 分组管理：新建（改名 / 删除在 drawGroupPanel 内逐行绑定）
  const gmAdd = document.getElementById("gm-add") as HTMLElement;
  const gmNew = document.getElementById("gm-new") as HTMLInputElement;
  gmAdd.addEventListener("click", () => {
    const g = gmNew.value.trim();
    if (!g) { gmNew.focus(); return; }
    if (!addWatchGroup(g)) { toast(`分组「${g}」已存在`); gmNew.select(); return; }
    gmNew.value = "";
    toast(`已新建分组「${g}」`);
    drawGroupPanel();
  });
  gmNew.addEventListener("keydown", (e) => {
    if (e.key === "Enter") { e.preventDefault(); gmAdd.click(); }
  });
}
