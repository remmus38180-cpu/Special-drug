// 表單對話框：欄位定義→輸入元件；送出前由呼叫端驗證（業務模組會再驗一次）。
import { h, dialog } from './dom.js';

// fields：[{key, label, type:'text'|'textarea'|'date'|'select'|'checks'|'note', options:[[value,label]], value, required, hint}]
export async function formDialog(title, fields, { okLabel = '確定', validate, intro } = {}) {
  const inputs = {};
  const msg = h('p', { class: 'warn-text', role: 'alert' });
  const rows = fields.map((f) => {
    if (f.type === 'note') return h('p', { class: 'note', text: f.label });
    let el;
    const v = f.value === null || f.value === undefined ? '' : f.value;
    if (f.type === 'textarea') {
      el = h('textarea', { rows: f.rows || 3, cols: 48 });
      el.value = String(v);
    } else if (f.type === 'select') {
      el = h('select', null, (f.options || []).map(([val, lab]) => h('option', { value: val, text: lab, selected: String(val) === String(v) })));
    } else if (f.type === 'checks') {
      const set = new Set(v || []);
      el = h('div', { class: 'checks' }, (f.options || []).map(([val, lab]) => h('label', { class: 'check' },
        h('input', { type: 'checkbox', value: val, checked: set.has(val) }), ' ', lab)));
    } else {
      el = h('input', { type: 'text', size: f.size || 40, placeholder: f.type === 'date' ? 'YYYY-MM-DD 或 115/03/02' : (f.placeholder || '') });
      el.value = String(v);
    }
    inputs[f.key] = { el, f };
    return h('div', { class: 'form-row' },
      h('label', { class: 'form-label' }, f.label + (f.required ? '＊' : '')), h('div', { class: 'form-input' }, el,
        f.hint ? h('div', { class: 'note', text: f.hint }) : null));
  });
  const read = () => {
    const out = {};
    for (const [k, { el, f }] of Object.entries(inputs)) {
      if (f.type === 'checks') out[k] = [...el.querySelectorAll('input:checked')].map((x) => x.value);
      else out[k] = el.value.trim() === '' ? null : el.value.trim();
    }
    return out;
  };
  const r = await dialog(title, [intro ? h('p', { text: intro }) : null, h('div', { class: 'form' }, rows), msg], [
    { label: '取消', value: null },
    { label: okLabel, value: 'ok', primary: true, validate: () => {
      const vals = read();
      for (const { f } of Object.values(inputs)) {
        if (f.required && (vals[f.key] === null || (Array.isArray(vals[f.key]) && !vals[f.key].length))) { msg.textContent = `請填「${f.label}」`; return false; }
      }
      const err = validate ? validate(vals) : null;
      if (err) { msg.textContent = err; return false; }
      return true;
    } },
  ]);
  return r ? read() : null;
}

export function opts(list) {
  return list.map((x) => [x, x]);
}
