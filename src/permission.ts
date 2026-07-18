const statusEl = document.getElementById('status')!;
const btn = document.getElementById('btnGrant') as HTMLButtonElement;

btn.onclick = async () => {
  btn.disabled = true;
  statusEl.textContent = '请求中...';
  try {
    const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    stream.getTracks().forEach(t => t.stop());
    statusEl.innerHTML = '<span class="ok">✓ 麦克风已授权，可以关闭此页面继续使用 易字幕</span>';
    chrome.storage.local.set({ micGranted: true });
  } catch (e) {
    statusEl.innerHTML = `<span class="err">✗ 授权失败: ${e}</span>`;
    btn.disabled = false;
  }
};
