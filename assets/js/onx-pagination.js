// Penomoran halaman tabel, dipakai Anomaly Alert Center dan Data & Reports:
// "Showing 1 to 10 of 365 entries" di kiri, tombol nomor halaman di kanan.
export const PAGE_SIZE = 10;

// Nomor yang ditampilkan: halaman pertama, terakhir, dan sekitar halaman yang dibuka; sisanya diringkas "…".
function pageList(page, maxPage) {
  if (maxPage <= 7) return Array.from({ length: maxPage }, (_, index) => index + 1);
  const near = page <= 4
    ? [1, 2, 3, 4, 5]
    : page >= maxPage - 3
      ? [maxPage - 4, maxPage - 3, maxPage - 2, maxPage - 1, maxPage]
      : [page - 1, page, page + 1];
  const pages = [...new Set([1, ...near, maxPage])].sort((a, b) => a - b);
  const list = [];
  pages.forEach((value, index) => {
    if (index && value - pages[index - 1] > 1) list.push(null);
    list.push(value);
  });
  return list;
}

export function renderPagination(container, { page, total, perPage = PAGE_SIZE, onPage }) {
  const maxPage = Math.max(1, Math.ceil(total / perPage));
  const first = total ? (page - 1) * perPage + 1 : 0;
  const last = Math.min(total, page * perPage);
  const button = (label, target, { active = false, disabled = false, title = "" } = {}) =>
    `<button type="button" class="onx-page-btn${active ? " is-active" : ""}" data-page="${target}"${active ? ' aria-current="page"' : ""}${disabled ? " disabled" : ""}${title ? ` aria-label="${title}" title="${title}"` : ""}>${label}</button>`;
  const arrows = maxPage > 7;

  container.innerHTML = `
    <span class="onx-page-info">${total ? `Showing ${first} to ${last} of ${total} entries` : "Showing 0 entries"}</span>
    <div class="onx-page-buttons" role="navigation" aria-label="Table pages">
      ${arrows ? button("&lsaquo;", page - 1, { disabled: page <= 1, title: "Previous page" }) : ""}
      ${(total ? pageList(page, maxPage) : []).map((value) => (value === null ? '<span class="onx-page-gap">&hellip;</span>' : button(value, value, { active: value === page }))).join("")}
      ${arrows ? button("&rsaquo;", page + 1, { disabled: page >= maxPage, title: "Next page" }) : ""}
    </div>`;

  container.onclick = (event) => {
    const target = event.target.closest("button[data-page]");
    if (!target || target.disabled) return;
    const next = Number(target.dataset.page);
    if (next >= 1 && next <= maxPage && next !== page) onPage(next);
  };
}
