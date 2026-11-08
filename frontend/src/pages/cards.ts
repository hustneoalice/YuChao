/* 功能卡片页：与行情页右列共用 store.cards；布局对齐设计稿（图标+标题+开关一行，底部状态行） */
import { ic } from "../icons";
import { CARD_DEFS, getState, setCardPref, resetCards } from "../store";
import { toast } from "../ui";

export function renderCards(): void {
  const st = getState();
  const grid = document.getElementById("cardgrid")!;
  const defs = [...CARD_DEFS].sort((a, b) => st.cards[a.id].order - st.cards[b.id].order);
  grid.innerHTML = defs.map((c) => {
    const p = st.cards[c.id];
    const vip = c.id === "signals";
    return `<div class="fcard${p.on ? "" : " off"}" data-card="${c.id}">` +
      `<div class="fcard-h"><span class="fi">${ic(c.icon, 14)}</span><b>${c.name}</b>` +
      (vip ? `<span class="tag vip" style="font-size:9.5px">VIP</span>` : "") +
      `<span class="sp"></span><span class="switch${p.on ? " on" : ""}" data-sw="${c.id}" title="${p.on ? "点击停用" : "点击启用"}"><i></i></span></div>` +
      `<p>${c.desc}</p>` +
      `<div class="ffoot"><span>行情页右列</span><span class="sp"></span><span>${p.on ? "已启用" : "已关闭"}</span></div></div>`;
  }).join("");
  grid.querySelectorAll<HTMLElement>("[data-sw]").forEach((sw) =>
    sw.addEventListener("click", (e) => {
      e.stopPropagation();
      const id = sw.dataset.sw!;
      const cur = getState().cards[id];
      setCardPref(id, { on: !cur.on });
      toast(`${CARD_DEFS.find((c) => c.id === id)!.name}${!cur.on ? " 已启用" : " 已停用"}`);
    }));
}

export function initCards(): void {
  document.getElementById("cards-reset")!.addEventListener("click", () => {
    resetCards();
    toast("卡片已恢复默认布局");
  });
}
