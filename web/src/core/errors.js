// 業務／協定錯誤：code 供程式判斷，message 為繁體中文說明（第11.2節）。
export class SpecError extends Error {
  constructor(code, message, detail) {
    super(message);
    this.name = 'SpecError';
    this.code = code;
    this.detail = detail === undefined ? null : detail;
  }
}

export function errText(e) {
  if (!e) return '未知錯誤';
  if (e instanceof SpecError) return e.message;
  return (e.name ? e.name + '：' : '') + (e.message || String(e));
}
