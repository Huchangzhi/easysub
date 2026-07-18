import { getLang, setLang, tSync } from './i18n';

const statusEl = document.getElementById('status')!;
const btn = document.getElementById('btnGrant') as HTMLButtonElement;
const btnLang = document.getElementById('btnLang') as HTMLButtonElement;

let currentLang = 'zh_CN';

async function applyLang() {
  currentLang = await getLang();
  const tr = (key: string) => tSync(currentLang, key);
  document.getElementById('permissionTitle')!.textContent = tr('permissionTitle');
  document.getElementById('permissionDesc')!.textContent = tr('permissionDesc');
  document.getElementById('permissionBtnText')!.textContent = tr('permissionGrant');
  btnLang.textContent = tr('langSwitch');
}

btnLang.onclick = async () => {
  const newLang = currentLang === 'zh_CN' ? 'en' : 'zh_CN';
  await setLang(newLang);
  await applyLang();
};

btn.onclick = async () => {
  btn.disabled = true;
  const tr = (key: string) => tSync(currentLang, key);
  statusEl.textContent = tr('permissionRequesting');
  try {
    const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    stream.getTracks().forEach(t => t.stop());
    statusEl.innerHTML = '<span class="ok">' + tr('permissionGranted') + '</span>';
    chrome.storage.local.set({ micGranted: true });
  } catch (e) {
    statusEl.innerHTML = `<span class="err">✗ ${tr('permissionFailed')}: ${e}</span>`;
    btn.disabled = false;
  }
};

applyLang();
