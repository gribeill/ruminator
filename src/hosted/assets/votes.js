// Copyright 2026 Guilhem Ribeill
// SPDX-License-Identifier: Apache-2.0

// Progressive enhancement only: unsupported browsers keep native form submission.
(() => {
  if (!window.fetch || !window.FormData || !window.URLSearchParams || !window.AbortController) return;
  const messages = document.querySelector('script[src="/assets/votes.js"]').dataset;
  document.addEventListener('submit', async event => {
    const form = event.target, submitter = event.submitter;
    if (!form.matches('form[data-enhanced-votes]') || !submitter || submitter.name !== 'value') return;
    event.preventDefault();
    if (form.getAttribute('aria-busy') === 'true') return;

    const body = new URLSearchParams(new FormData(form));
    body.set('value', submitter.getAttribute('value')); // Capture before disabling successful controls.
    const buttons = [...form.querySelectorAll('button[name="value"]')];
    const status = form.querySelector('[role="status"]');
    form.setAttribute('aria-busy', 'true');
    buttons.forEach(button => { button.disabled = true; });
    status.textContent = messages.saving;
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 15000);
    try {
      const response = await fetch(form.getAttribute('action'), { method: 'POST', body,
        headers: { Accept: 'application/json' }, credentials: 'same-origin',
        redirect: 'manual', signal: controller.signal });
      if (response.type === 'opaqueredirect' || response.status === 401) throw new Error(messages.login);
      if (response.status === 403 || response.status === 409) throw new Error(messages.stale);
      if (!response.ok) throw new Error(messages.failed);
      const result = await response.json(); // Access HTML/challenges must never look like a saved vote.
      if (result.paper !== body.get('paper') || result.value !== Number(body.get('value'))
          || !Array.isArray(result.buttons) || result.buttons.length !== buttons.length
          || result.buttons.some(button => ![-1, 0, 1].includes(button.value) || typeof button.pressed !== 'boolean'
            || typeof button.label !== 'string' || typeof button.title !== 'string')) throw new Error(messages.failed);
      buttons.forEach((button, index) => {
        const saved = result.buttons[index];
        button.setAttribute('value', String(saved.value));
        button.setAttribute('aria-pressed', String(saved.pressed));
        button.setAttribute('aria-label', saved.label);
        button.title = saved.title;
      });
      status.textContent = messages.saved;
    } catch (error) {
      // An interrupted response may still have persisted. Never retry or resubmit automatically.
      status.textContent = [messages.login, messages.stale].includes(error?.message) ? error.message : messages.failed;
    } finally {
      clearTimeout(timeout);
      buttons.forEach(button => { button.disabled = false; });
      form.removeAttribute('aria-busy');
    }
  });
})();
