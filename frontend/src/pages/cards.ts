/* 功能卡片页：与行情页右列共用 store.cards */
import { ic } from "../icons";
import { CARD_DEFS, getState, setCardPref, resetCards } from "../store";
import { toast } from "../ui";

export function renderCards(): void {
  const st = getState();
  const grid = document.getElementById("cardgrid")!;
  const defs = [...CARD_DEFS].sort((a, b) => st.cards[a.id].order - st.cards[b.id].order);
  grid.innerHTML = defs.map((c, i) => {
    const p = st.cards[c.id];
    const vip = c.id === "signals";
    return `<div class="fcard${p.on ? "" : " off"}" data-card="${c.id}">` +
      `<span class="fnum">#${i + 1}</span>` +
      `<div class="fico">${ic(c.icon, 18)}</div><h4>${c.name}${vip ? `<span class="tag vip" style="font-size:9.5px">VIP</span>` : ""}</h4><p>${c.desc}</p>` +
      `<div class="frow"><span class="st">${p.on ? "已启用" : "已停用"}</span><span class="sp"></span>` +
      `<span class="switch${p.on ? " on" : ""}" data-sw="${c.id}"><i></i></span></div></div>`;
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
