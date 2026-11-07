// 極小DOM輔助：一律以 textContent 放文字，不用 innerHTML。
export function h(tag, props, ...children) {
  const el = document.createElement(tag);
  if (props) {
    for (const [k, v] of Object.entries(props)) {
      if (v === undefined || v === null || v === false) continue;
      if (k === 'class') el.className = v;
      else if (k === 'text') el.textContent = v;
      else if (k === 'on') for (const [ev, fn] of Object.entries(v)) el.addEventListener(ev, fn);
      else if (k === 'style') el.setAttribute('style', v);
      else if (k in el && typeof v !== 'string') el[k] = v;
      else el.setAttribute(k, v === true ? '' : String(v));
    }
  }
  append(el, children);
  return el;
}

function append(el, children) {
  for (const c of children) {
    if (c === null || c === undefined || c === false) continue;
    if (Array.isArray(c)) append(el, c);
    else if (c instanceof Node) el.appendChild(c);
    else el.appendChild(document.createTextNode(String(c)));
  }
}

export function clear(el) {
  while (el.firstChild) el.removeChild(el.firstChild);
  return el;
}

export function table(headers, rows) {
  const t = h('table', null,
    h('thead', null, h('tr', null, headers.map((x) => h('th', { text: x })))),
    h('tbody', null, rows.map((r) => h('tr', null, r.map((c) => (c instanceof Node ? h('td', null, c) : h('td', { text: c === null || c === undefined ? '' : String(c) })))))));
  return sortable(t);
}

// 表頭點選排序（只重排目前畫面已顯示之列，不暗中載入或選取未顯示資料）；數值欄依數值、其餘依文字
const NUM = /^-?\d+(\.\d+)?$/;
export function sortable(t) {
  const ths = [...t.querySelectorAll('thead th')];
  ths.forEach((th, i) => {
    th.classList.add('sortable');
    th.setAttribute('tabindex', '0');
    th.title = '點選依此欄排序';
    const go = () => {
      const dir = th.getAttribute('aria-sort') === 'ascending' ? 'descending' : 'ascending';
      ths.forEach((x) => x.removeAttribute('aria-sort'));
      th.setAttribute('aria-sort', dir);
      const body = t.querySelector('tbody');
      const rows = [...body.children];
      const key = (tr) => (tr.children[i] ? tr.children[i].textContent.trim() : '');
      rows.sort((a, b) => {
        const x = key(a); const y = key(b);
        const c = NUM.test(x.replace(/,/g, '')) && NUM.test(y.replace(/,/g, '')) ? Number(x.replace(/,/g, '')) - Number(y.replace(/,/g, '')) : x.localeCompare(y, 'zh-Hant');
        return dir === 'ascending' ? c : -c;
      });
      for (const r of rows) body.appendChild(r);
    };
    th.addEventListener('click', go);
    th.addEventListener('keydown', (e) => { if (e.key === 'Enter') go(); });
  });
  return t;
}

// 模態對話框；buttons：[{label, value, primary}]；回傳 Promise<value>（Esc→null）
export function dialog(title, body, buttons) {
  return new Promise((resolve) => {
    const dlg = h('dialog', { class: 'dlg', 'aria-label': title });
    const done = (v) => { dlg.close(); dlg.remove(); resolve(v); };
    dlg.appendChild(h('h2', { text: title }));
    dlg.appendChild(h('div', { class: 'dlg-body' }, body));
    const bar = h('div', { class: 'dlg-buttons' });
    for (const b of buttons) {
      bar.appendChild(h('button', { type: 'button', class: b.primary ? 'primary' : '', text: b.label, on: { click: () => {
        if (b.validate && !b.validate()) return;
        done(b.value);
      } } }));
    }
    dlg.appendChild(bar);
    dlg.addEventListener('cancel', (e) => { e.preventDefault(); done(null); });
    document.body.appendChild(dlg);
    dlg.showModal();
  });
}

export function alertBox(title, ...lines) {
  return dialog(title, lines.map((l) => (l instanceof Node ? l : h('p', { text: l }))), [{ label: '確定', value: true, primary: true }]);
}
