// Updates: the dialog behind the top bar's Updates button. It asks the backend what GitHub's latest release is,
// shows the notes, downloads the file for this device with a progress bar, and applies it: the Windows exe swaps
// itself and restarts, the Android app hands the APK to the system installer. A quiet check on start marks the
// button when a newer version exists.

import { api } from './api.js';
import { esc, fmtDate } from './format.js';
import { openModal, closeModal, toast } from './ui.js';

const mb = (n) => `${(n / 1048576).toFixed(1)} MB`;
const android = () => (window.AndroidApp && typeof window.AndroidApp.installApk === 'function' ? window.AndroidApp : null);

export async function quietUpdateCheck() {
  try {
    const r = await api.get('/api/update/check');
    const btn = document.getElementById('btn-update');
    if (btn && r.newer) { btn.textContent = `Update to ${r.latest}`; btn.classList.add('has-update'); document.getElementById('btn-menu')?.classList.add('has-dot'); btn.title = `Version ${r.latest} is available`; }
  } catch { /* offline, or GitHub busy: the button still checks on demand */ }
}

export async function openUpdateModal() {
  const modal = openModal('Updates', '<p class="empty small">Checking GitHub for the latest version…</p>');
  const box = modal.querySelector('.modal-body') || modal;
  let timer = null;
  const stop = () => { if (timer) { clearInterval(timer); timer = null; } };
  const close = () => { stop(); closeModal(); };
  const foot = (extra = '') => `<div class="form-actions">${extra}<button type="button" class="btn ghost" data-close>Close</button></div>`;
  const wireClose = () => box.querySelectorAll('[data-close]').forEach((b) => b.addEventListener('click', close));

  let info;
  try {
    info = await api.get('/api/update/check');
  } catch (e) {
    box.innerHTML = `<p class="form-error">${esc(e.message)}</p>${foot('<button type="button" class="btn ghost" id="upd-retry">Try again</button>')}`;
    wireClose();
    box.querySelector('#upd-retry').addEventListener('click', () => { close(); openUpdateModal(); });
    return;
  }

  const where = info.platform === 'android' ? 'Android will ask you to confirm the install; the new version goes over this one and your data stays.'
    : info.platform === 'windows' ? 'The app closes and reopens as the new version; your data folder is untouched.'
      : 'This copy runs from source: update it with git pull.';
  const head = `<p>This device has <b>version ${esc(info.current)}</b>. ${info.newer ? `<b>Version ${esc(info.latest)}</b> is available${info.published ? `, published ${fmtDate(info.published.slice(0, 10))}` : ''}.` : `That is the latest version${info.published ? ` (published ${fmtDate(info.published.slice(0, 10))})` : ''}.`}</p>`;
  const notes = info.notes ? `<details class="small" ${info.newer ? 'open' : ''}><summary>What is in ${esc(info.latest)}</summary><div class="update-notes">${esc(info.notes)}</div></details>` : '';
  const page = `<a href="${esc(info.page)}" target="_blank" rel="noopener">Release page on GitHub</a>`;

  function idle() {
    const can = info.newer && info.can_install;
    box.innerHTML = `${head}${notes}
      <p class="muted small">${info.newer ? esc(where) : ''} ${page}${info.newer && info.asset ? ` · ${esc(info.asset.name)} · ${mb(info.asset.size)}` : ''}</p>
      <div class="form-error" hidden></div>
      ${foot(can ? '<button type="button" class="btn primary" id="upd-go">Download and install</button>' : '')}`;
    wireClose();
    box.querySelector('#upd-go')?.addEventListener('click', start);
  }

  async function start() {
    const err = box.querySelector('.form-error');
    try {
      await api.post('/api/update/download', {});
    } catch (e) { err.textContent = e.message; err.hidden = false; return; }
    box.innerHTML = `${head}
      <p id="upd-line" class="small">Downloading…</p>
      <div class="progress-bar"><div id="upd-bar" style="width:0%"></div></div>
      <div class="form-error" hidden></div>
      ${foot()}`;
    wireClose();
    stop();
    timer = setInterval(poll, 700);
  }

  async function poll() {
    if (!document.body.contains(box)) { stop(); return; }
    let st;
    try { st = await api.get('/api/update/status'); } catch { return; }
    const line = box.querySelector('#upd-line');
    const bar = box.querySelector('#upd-bar');
    if (st.state === 'downloading') {
      const pct = st.total ? Math.min(100, (st.done / st.total) * 100) : 0;
      if (bar) bar.style.width = `${pct.toFixed(1)}%`;
      if (line) line.textContent = `Downloading ${st.name}: ${mb(st.done || 0)}${st.total ? ` of ${mb(st.total)}` : ''}`;
    } else if (st.state === 'error') {
      stop();
      const err = box.querySelector('.form-error');
      err.textContent = st.error || 'The download failed.';
      err.hidden = false;
      if (line) line.textContent = 'Not downloaded.';
    } else if (st.state === 'ready') {
      stop();
      if (bar) bar.style.width = '100%';
      await install(st, line);
    }
  }

  async function install(st, line) {
    const checked = st.verified ? 'checksum verified' : 'size checked';
    if (st.platform === 'android') {
      const bridge = android();
      if (!bridge) { line.textContent = `Downloaded (${checked}), but this version of the app cannot start the installer; install it from the release page.`; return; }
      line.innerHTML = `Downloaded (${checked}). Android's installer is opening: tap <b>Update</b> there. <button type="button" class="link-btn" id="upd-again">Open the installer again</button>`;
      box.querySelector('#upd-again').addEventListener('click', () => bridge.installApk(st.path));
      bridge.installApk(st.path);
      return;
    }
    line.textContent = `Downloaded (${checked}). Restarting as version ${st.version}…`;
    try {
      await api.post('/api/update/apply', {});
      toast(`Restarting as version ${st.version}`);
    } catch (e) {
      const err = box.querySelector('.form-error');
      err.textContent = e.message;
      err.hidden = false;
    }
  }

  // a download already under way or finished (the dialog was closed meanwhile) picks up where it was
  const st = await api.get('/api/update/status').catch(() => ({ state: 'idle' }));
  if (info.newer && st.version === info.latest && (st.state === 'downloading' || st.state === 'ready')) {
    box.innerHTML = `${head}<p id="upd-line" class="small">Downloading…</p><div class="progress-bar"><div id="upd-bar" style="width:0%"></div></div><div class="form-error" hidden></div>${foot()}`;
    wireClose();
    timer = setInterval(poll, 700);
    poll();
  } else idle();
}
