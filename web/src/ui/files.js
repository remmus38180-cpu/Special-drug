// 使用者觸發之另存／下載。以另存對話框帶入預設檔名為主；不支援時改用下載。
export async function saveTextAs(suggestedName, text, mime = 'application/json') {
  const blob = new Blob([text], { type: mime + ';charset=utf-8' });
  return saveBlobAs(suggestedName, blob);
}

export async function saveBlobAs(suggestedName, blob) {
  if (typeof window.showSaveFilePicker === 'function') {
    let fh;
    try {
      fh = await window.showSaveFilePicker({ suggestedName });
    } catch (e) {
      if (e && e.name === 'AbortError') return { saved: false, cancelled: true };
      throw e;
    }
    const w = await fh.createWritable();
    try {
      await w.write(blob);
      await w.close();
    } catch (e) {
      try { await w.abort(); } catch (e2) { /* 忽略 */ }
      throw e;
    }
    return { saved: true, name: fh.name, method: 'saveAs' };
  }
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = suggestedName;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 30000);
  return { saved: true, name: suggestedName, method: 'download' };
}
