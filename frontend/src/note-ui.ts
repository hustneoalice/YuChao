/* 自选标注 UI：hover 浮层 + 编辑弹窗（自选表格 / 个股详情信息条共用）
 * 表格与信息条都会频繁重绘，事件一律用委托绑定在稳定的容器上。 */
import { esc } from "./fmt";
import { ic } from "./icons";
import { toast, openModal } from "./ui";
import {
  getState, getWatchNotes, addWatchNote, updateWatchNote, removeWatchNote, todayYmd,
} from "./store";

let pop: HTMLElement | null = null;
let popSym = "";
let hideTimer = 0;
let editingSym = "";
let editorBound = false;
let scrollBound = false;

export function hideNotePop(): void {
  window.clearTimeout(hideTimer);
  pop?.remove();
  pop = null;
  popSym = "";
}

function showNotePop(el: HTMLElement): void {
  const sym = el.dataset.note!;
  const w = getState().watchlist.find((x) => x.symbol === sym);
  if (!w) return;
  const notes = getWatchNotes(sym);
  hideNotePop();
  popSym = sym;
  const node = document.createElement("div");
  node.className = "wl-note-pop";
  node.innerHTML = `<div class="wnp-h">${esc(w.name)}<span class="mono">${esc(sym)}</span></div>` +
    (notes.length
      ? `<div class="wnp-b">${notes.map((n) =>
          `<div class="wnp-i"><span class="wnp-d">${esc(n.date)}</span><span class="wnp-t">${esc(n.text)}</span></div>`).join("")}</div>` +
        `<div class="wnp-f">点击「标注」可新增 / 修改 / 删除</div>`
      : `<div class="wnp-f">暂无标注 · 点击添加操作策略</div>`);
  document.body.appendChild(node);
  const r = el.getBoundingClientRect();
  const pr = node.getBoundingClientRect();
  let left = r.left + r.width / 2 - pr.width / 2;
  left = Math.max(8, Math.min(left, window.innerWidth - pr.width - 8));
  let top = r.bottom + 6;
  if (top + pr.height > window.innerHeight - 8) top = r.top - pr.height - 6;
  top = Math.max(8, top);
  node.style.left = `${left}px`;
  node.style.top = `${top}px`;
  pop = node;
}

function shortDate(d: string): string {
  const y = String(new Date().getFullYear());
  return d.startsWith(`${y}-`) ? d.slice(5) : d;
}

function barText(t: string): string {
  const one = t.replace(/\s+/g, " ").trim();
  return one.length > 48 ? `${one.slice(0, 48)}…` : one;
}

/** 标注徽标：cell = 自选表格紧凑图标；bar = 个股信息条（带最新一条内容） */
export function noteChipHtml(symbol: string, variant: "cell" | "bar" = "cell"): string {
  const w = getState().watchlist.find((x) => x.symbol === symbol);
  if (!w) return "";
  const notes = getWatchNotes(symbol);
  const n = notes.length;
  if (variant === "cell") {
    return `<span class="wl-note${n ? " has" : ""}" data-note="${esc(symbol)}">` +
      `${ic("pencil-simple", 11)}${n ? `<b>${n}</b>` : ""}</span>`;
  }
  const latest = notes[0];
  return `<span class="wl-note bar${n ? " has" : ""}" data-note="${esc(symbol)}">` +
    `${ic("pencil-simple", 11)}<span class="lb">标注${n ? ` ${n}` : ""}</span>` +
    (latest
      ? `<span class="lt">${esc(shortDate(latest.date))} · ${esc(barText(latest.text))}</span>`
      : `<span class="lt none">添加操作策略</span>`) + `</span>`;
}

/** 悬停展示全部标注；delegation，容器重绘后仍然生效 */
export function bindNoteHover(root: HTMLElement): void {
  root.addEventListener("mouseover", (e) => {
    const t = (e.target as HTMLElement).closest(".wl-note") as HTMLElement | null;
    if (!t) return;
    window.clearTimeout(hideTimer);
    if (popSym !== t.dataset.note) showNotePop(t);
  });
  root.addEventListener("mouseout", (e) => {
    const t = (e.target as HTMLElement).closest(".wl-note");
    if (!t) return;
    const to = (e as MouseEvent).relatedTarget as Node | null;
    if (to && (t as HTMLElement).contains(to)) return;
    window.clearTimeout(hideTimer);
    hideTimer = window.setTimeout(hideNotePop, 90);
  });
  if (!scrollBound) {
    scrollBound = true;
    window.addEventListener("scroll", hideNotePop, true);   // 浮层跟随失效 → 直接收起
  }
}

function renderNoteList(): void {
  const notes = getWatchNotes(editingSym);
  document.getElementById("wn-count")!.textContent = notes.length ? `${notes.length} 条` : "暂无";
  document.getElementById("wn-list")!.innerHTML = notes.length
    ? notes.map((n) => `<div class="wn-item" data-id="${esc(n.id)}">
        <div class="wn-top">
          <input class="wn-d" type="date" value="${esc(n.date)}" title="标注日期">
          <span class="sp"></span>
          <button class="gm-btn danger" data-wn-del title="删除标注">${ic("trash", 12)}</button>
        </div>
        <textarea class="wn-t" maxlength="500" rows="2" placeholder="操作策略 / 提醒">${esc(n.text)}</textarea>
      </div>`).join("")
    : `<div class="wn-none">还没有标注。在下方选好日期、填写内容后点「添加」。</div>`;
}

/** 标注变更：重绘弹窗 + 通知页面刷新（自选表格 / 个股信息条） */
function refreshNotes(): void {
  renderNoteList();
  document.dispatchEvent(new CustomEvent("yc:notes-changed", { detail: { symbol: editingSym } }));
}

export function openNoteModal(sym: string): void {
  const w = getState().watchlist.find((x) => x.symbol === sym);
  if (!w) { toast("先加入自选，才能添加标注"); return; }
  editingSym = sym;
  document.getElementById("wn-title")!.textContent = `${w.name} · 标注`;
  (document.getElementById("wn-date") as HTMLInputElement).value = todayYmd();
  (document.getElementById("wn-text") as HTMLTextAreaElement).value = "";
  renderNoteList();
  openModal("modal-wl-note");
  window.setTimeout(() => (document.getElementById("wn-text") as HTMLTextAreaElement).focus(), 60);
}

export function initNoteEditor(): void {
  if (editorBound) return;
  editorBound = true;
  document.getElementById("wn-list")!.addEventListener("click", (e) => {
    const del = (e.target as HTMLElement).closest("[data-wn-del]");
    if (!del) return;
    const item = del.closest(".wn-item") as HTMLElement;
    if (removeWatchNote(editingSym, item.dataset.id!)) {
      toast("已删除标注");
      refreshNotes();
    }
  });
  document.getElementById("wn-list")!.addEventListener("change", (e) => {
    const d = (e.target as HTMLElement).closest(".wn-d") as HTMLInputElement | null;
    if (!d) return;
    const item = d.closest(".wn-item") as HTMLElement;
    if (updateWatchNote(editingSym, item.dataset.id!, { date: d.value })) refreshNotes();
  });
  document.getElementById("wn-list")!.addEventListener("focusout", (e) => {
    const t = (e.target as HTMLElement).closest(".wn-t") as HTMLTextAreaElement | null;
    if (!t) return;
    const item = t.closest(".wn-item") as HTMLElement;
    const prev = getWatchNotes(editingSym).find((n) => n.id === item.dataset.id);
    const val = t.value.trim();
    if (!val) { toast("标注内容不能为空"); if (prev) t.value = prev.text; return; }
    if (prev && prev.text === val) return;
    if (updateWatchNote(editingSym, item.dataset.id!, { text: val })) refreshNotes();
  });
  document.getElementById("wn-add-btn")!.addEventListener("click", () => {
    const date = (document.getElementById("wn-date") as HTMLInputElement).value || todayYmd();
    const text = (document.getElementById("wn-text") as HTMLTextAreaElement).value;
    if (!addWatchNote(editingSym, date, text)) { toast("请填写标注内容"); return; }
    (document.getElementById("wn-text") as HTMLTextAreaElement).value = "";
    (document.getElementById("wn-date") as HTMLInputElement).value = todayYmd();
    toast("已添加标注");
    refreshNotes();
    (document.getElementById("wn-text") as HTMLTextAreaElement).focus();
  });
  document.getElementById("wn-text")!.addEventListener("keydown", (e) => {
    if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
      e.preventDefault();
      document.getElementById("wn-add-btn")!.click();
    }
  });
}
