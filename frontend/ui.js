// Modal dialog, confirmation and toast helpers.

const modalRoot = document.getElementById('modal-root');
const toastRoot = document.getElementById('toast-root');
let escHandler = null;

export function openModal(title, bodyHtml, { wide = false } = {}) {
  closeModal();
  modalRoot.innerHTML = `
    <div class="modal-backdrop">
      <div class="modal card${wide ? ' wide' : ''}" role="dialog" aria-modal="true" aria-labelledby="modal-title">
        <div class="modal-head">
          <h2 id="modal-title">${title}</h2>
          <button type="button" class="icon-btn" data-close aria-label="Close">&times;</button>
        </div>
        <div class="modal-body">${bodyHtml}</div>
      </div>
    </div>`;
  const backdrop = modalRoot.firstElementChild;
  backdrop.addEventListener('click', (e) => {
    if (e.target === backdrop || e.target.closest('button[data-close]')) closeModal();
  });
  escHandler = (e) => { if (e.key === 'Escape') closeModal(); };
  document.addEventListener('keydown', escHandler);
  document.body.classList.add('modal-open');
  backdrop.querySelector('input, select, button:not([data-close])')?.focus();
  return backdrop.querySelector('.modal');
}

export function closeModal() {
  modalRoot.innerHTML = '';
  document.body.classList.remove('modal-open');
  if (escHandler) {
    document.removeEventListener('keydown', escHandler);
    escHandler = null;
  }
}

export function toast(message, kind = 'info') {
  const el = document.createElement('div');
  el.className = `toast ${kind}`;
  el.textContent = message;
  toastRoot.appendChild(el);
  requestAnimationFrame(() => el.classList.add('show'));
  setTimeout(() => {
    el.classList.remove('show');
    setTimeout(() => el.remove(), 300);
  }, kind === 'info' ? 3500 : 6000);
}

export function confirmDialog(title, message, { confirmLabel = 'Delete', danger = true } = {}) {
  return new Promise((resolve) => {
    const modal = openModal(
      title,
      `<p class="confirm-text">${message}</p>
       <div class="form-actions">
         <button type="button" class="btn ghost" data-close>Cancel</button>
         <button type="button" class="btn ${danger ? 'danger' : 'primary'}" id="confirm-ok">${confirmLabel}</button>
       </div>`,
    );
    let settled = false;
    modal.querySelector('#confirm-ok').addEventListener('click', () => {
      settled = true;
      resolve(true);
      closeModal();
    });
    const obs = new MutationObserver(() => {
      if (!modalRoot.firstElementChild) {
        if (!settled) resolve(false);
        obs.disconnect();
      }
    });
    obs.observe(modalRoot, { childList: true });
  });
}
