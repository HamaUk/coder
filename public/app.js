// HAMA — AI Support Agent · frontend application
(function () {
  'use strict';

  // ==================================================================
  // State + helpers
  // ==================================================================
  const $ = (s) => document.querySelector(s);

  // Preferences live under `hama_*`. The app was previously called Atlas, so a
  // browser that has been here before still holds `atlas_*` — fall back to that
  // once, otherwise renaming the keys would silently reset the user's tool
  // toggles, focus mode and chat tags. Writes always go to the new key.
  const pref = (key, fallback) => {
    const current = localStorage.getItem('hama_' + key);
    if (current !== null) return current;
    return localStorage.getItem('atlas_' + key) ?? fallback;
  };

  // localStorage can hold anything — including a value written by the previous
  // generation of this app under the `atlas_*` keys `pref` falls back to. An
  // unguarded JSON.parse here runs while `state` is being built, before boot(),
  // so one malformed value used to blank the whole page instead of falling back.
  const prefJSON = (key, fallback) => {
    try { return JSON.parse(pref(key, fallback)); } catch { return JSON.parse(fallback); }
  };

  const state = {
    providers: [],
    chats: [],            // metadata list
    settings: {},
    presets: [],
    currentChatId: null,
    currentMessages: [],
    activeProviderId: null,
    streaming: false,
    streamChatId: null,
    tools: prefJSON('tools', '{"web":true,"files":true,"code":true}'),
    fpPath: '',
    fpOpen: pref('fp', '0') === '1',
    formProviderId: null,
    formPresetId: 'openai',
    formModels: [],
    chatTags: prefJSON('chat_tags', '{}'), // {chatId: [tag,...]}
    activeTagFilter: null,  // string tag currently filtering by
    promptHistory: [],      // Feature 5: sent messages history
    promptHistoryIdx: -1,   // Feature 5: current nav index
    // Every turn gets a generation number. A reply that arrives after the user
    // moved to another conversation must not be written into the new one, so
    // each stream checks its own generation before touching state or the DOM.
    streamGen: 0
  };

  /**
   * Sends a request to the console's API.
   *
   * A 401 means the session expired (a deployment protects every route), which
   * is not an error the user can act on from here — the server's login form is.
   * Redirecting keeps a long-idle tab one click from working again instead of
   * showing "Authentication required" next to every control.
   *
   * @param {string} path - API path.
   * @param {string} [method] - HTTP method.
   * @param {object} [body] - JSON body.
   * @returns {Promise<object>} the parsed response.
   */
  async function api(path, method = 'GET', body) {
    const res = await fetch(path, {
      method,
      headers: body ? { 'Content-Type': 'application/json' } : undefined,
      body: body ? JSON.stringify(body) : undefined
    });
    if (res.status === 401) {
      location.href = '/login';
      throw new Error('Your session expired — signing you in again.');
    }
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
    return data;
  }

  // ==================================================================
  // Toast notification system (Feature 3)
  // ==================================================================
  const TOAST_ICONS = {
    success: 'i-check', error: 'i-close', warning: 'i-bolt', info: 'i-sparkle'
  };

  // ==================================================================
  // Stale-backend badge
  //
  // The browser reloads public/*.js from disk on every refresh, but the server
  // reads its own code ONCE. So after a `src/` edit the page can be running new
  // front-end code against an old back end, and the only symptom is a fix that
  // plainly did not take — which reads as "you did not fix it".
  //
  // The toast the server triggers on load only helps someone who happens to
  // refresh at the right moment. This badge is persistent, and the recheck below
  // catches an edit made while the tab is already open.
  // ==================================================================
  let staleTimer = null;
  function setStaleBadge(stale) {
    const existing = document.getElementById('staleBadge');
    if (!stale) { if (existing) existing.remove(); return; }
    if (existing) return;
    const host = document.querySelector('.topbar') || document.body;
    const el = document.createElement('button');
    el.id = 'staleBadge';
    el.type = 'button';
    el.className = 'stale-badge';
    el.title = 'The server is running the code it loaded when it started. Restart it to apply the edit you just made.';
    el.innerHTML = '<svg class="ic"><use href="#i-bolt"/></svg><span>Server running old code — restart it</span>';
    el.addEventListener('click', () => {
      toast('Restart the server to apply backend changes.\nStop it with Ctrl+C, then run npm start — or use npm run dev to reload on every edit.', 'warning', 12000);
    });
    host.appendChild(el);
  }

  /** Re-asks the server whether its code is stale, once a minute. */
  function startStaleWatch() {
    if (staleTimer) return;
    staleTimer = setInterval(async () => {
      try {
        // A dedicated endpoint rather than /api/bootstrap: the full bootstrap is
        // a large payload (every chat and provider) and this only needs one bit.
        const r = await fetch('/api/health', { cache: 'no-store' });
        const data = await r.json();
        setStaleBadge(Boolean(data.staleCode));
      } catch { /* the server is restarting or gone; the badge stays as it was */ }
    }, 60000);
  }

  function toast(msg, type = 'info', ms = 3600) {
    const container = $('#toasts');
    const el = document.createElement('div');
    el.className = `toast ${type}`;
    el.style.setProperty('--toast-ms', ms + 'ms');
    const icon = TOAST_ICONS[type] || 'i-logo';
    // Split msg into title + optional detail at newline
    const parts = String(msg).split('\n');
    const title = parts[0];
    const body = parts.slice(1).join('\n').trim();
    el.innerHTML = `
      <div class="toast-icon"><svg class="ic"><use href="#${icon}"/></svg></div>
      <div class="toast-body">
        <div class="toast-title"></div>
        ${body ? '<div class="toast-msg"></div>' : ''}
      </div>
      <button class="toast-close" title="Dismiss"><svg class="ic"><use href="#i-close"/></svg></button>`;
    el.querySelector('.toast-title').textContent = title;
    if (body) el.querySelector('.toast-msg').textContent = body;
    container.appendChild(el);

    // Auto-dismiss with hover-pause
    let remaining = ms;
    let startTime = Date.now();
    let timer = setTimeout(dismiss, ms);

    el.addEventListener('mouseenter', () => {
      clearTimeout(timer);
      remaining -= (Date.now() - startTime);
    });
    el.addEventListener('mouseleave', () => {
      startTime = Date.now();
      timer = setTimeout(dismiss, Math.max(0, remaining));
    });

    function dismiss() {
      clearTimeout(timer);
      el.classList.add('leaving');
      setTimeout(() => el.remove(), 250);
    }
    el.addEventListener('click', dismiss);
    el.querySelector('.toast-close').addEventListener('click', (e) => { e.stopPropagation(); dismiss(); });
  }

  const fmtTime = (ts) => new Date(ts).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  const fmtBytes = (n) => n < 1024 ? n + ' B' : n < 1048576 ? (n / 1024).toFixed(1) + ' KB' : (n / 1048576).toFixed(1) + ' MB';

  function monogram(label) {
    const clean = (label || '?').replace(/\(.*?\)/g, '').trim();
    const parts = clean.split(/\s+/);
    return ((parts[0]?.[0] || '?') + (parts[1]?.[0] || '')).toUpperCase();
  }

  function getProvider(id) { return state.providers.find(p => p.id === id); }

  function activeProvider() {
    let p = getProvider(state.activeProviderId);
    if (p && p.enabled) return p;
    p = getProvider(state.settings.defaultProviderId);
    if (p && p.enabled) return p;
    return state.providers.find(x => x.enabled) || state.providers[0] || null;
  }

  // Whether the active provider can actually READ an attached image. The flag
  // rides on the preset (OpenAI / Anthropic / Gemini / OpenRouter), so a
  // text-only model no longer silently receives a picture it cannot see.
  function providerSupportsVision(p) {
    if (!p) return false;
    if (p.vision === true) return true;
    const preset = (state.presets || []).find((x) => x.id === p.presetId);
    return !!(preset && preset.vision === true);
  }

  async function copyText(text, done) {
    try {
      await navigator.clipboard.writeText(text);
    } catch {
      const ta = document.createElement('textarea');
      ta.value = text;
      document.body.appendChild(ta);
      ta.select();
      try { document.execCommand('copy'); } catch { /* ignore */ }
      ta.remove();
    }
    if (done) done();
  }

  // ==================================================================
  // Theme
  // ==================================================================
  function applyTheme(theme) {
    document.documentElement.dataset.theme = theme;
    $('#themeIcon').innerHTML = `<use href="#${theme === 'dark' ? 'i-sun' : 'i-moon'}"/>`;
  }
  $('#themeBtn').addEventListener('click', async () => {
    const next = document.documentElement.dataset.theme === 'dark' ? 'light' : 'dark';
    applyTheme(next);
    state.settings.theme = next;
    try { await api('/api/settings', 'PUT', { theme: next }); } catch { /* non-fatal */ }
  });

  // ==================================================================
  // Sidebar — chat list
  // ==================================================================
  // ==================================================================
  // Chat Tagging helpers (Feature 1)
  // ==================================================================
  function getChatTags(chatId) { return state.chatTags[chatId] || []; }
  function saveChatTags() { localStorage.setItem('hama_chat_tags', JSON.stringify(state.chatTags)); }
  function addChatTag(chatId, tag) {
    const t = tag.trim().toLowerCase().replace(/[^a-z0-9-_]/g, '-').slice(0, 24);
    if (!t) return;
    if (!state.chatTags[chatId]) state.chatTags[chatId] = [];
    if (!state.chatTags[chatId].includes(t)) {
      state.chatTags[chatId].push(t);
      saveChatTags();
      renderChatList($('#chatSearch').value);
      renderTagFilterBar();
    }
  }
  function removeChatTag(chatId, tag) {
    if (!state.chatTags[chatId]) return;
    state.chatTags[chatId] = state.chatTags[chatId].filter(t => t !== tag);
    if (!state.chatTags[chatId].length) delete state.chatTags[chatId];
    saveChatTags();
    // If we just removed the active filter tag, clear it if nothing uses it
    if (state.activeTagFilter === tag) {
      const allTags = Object.values(state.chatTags).flat();
      if (!allTags.includes(tag)) state.activeTagFilter = null;
    }
    renderChatList($('#chatSearch').value);
    renderTagFilterBar();
  }
  function getAllTags() {
    const tagSet = new Set();
    for (const tags of Object.values(state.chatTags)) tags.forEach(t => tagSet.add(t));
    return [...tagSet].sort();
  }
  function renderTagFilterBar() {
    const bar = $('#tagFilterBar');
    const allTags = getAllTags();
    if (!allTags.length) { bar.classList.add('hidden'); return; }
    bar.classList.remove('hidden');
    bar.innerHTML = '';
    const label = document.createElement('span');
    label.className = 'tag-filter-bar-label';
    label.textContent = 'Filter:';
    bar.appendChild(label);
    for (const tag of allTags) {
      const chip = document.createElement('button');
      chip.className = 'tag-filter-chip' + (state.activeTagFilter === tag ? ' active' : '');
      chip.textContent = tag;
      chip.addEventListener('click', () => {
        state.activeTagFilter = (state.activeTagFilter === tag) ? null : tag;
        renderTagFilterBar();
        renderChatList($('#chatSearch').value);
      });
      bar.appendChild(chip);
    }
  }

  function renderChatList(filter = '') {
    const list = $('#chatList');
    const q = filter.trim().toLowerCase();
    let chats = state.chats.filter(c => !q || (c.title || '').toLowerCase().includes(q));
    // Tag filter
    if (state.activeTagFilter) {
      chats = chats.filter(c => (state.chatTags[c.id] || []).includes(state.activeTagFilter));
    }
    if (!chats.length) {
      list.innerHTML = `<div class="cl-empty">${q || state.activeTagFilter ? 'No conversations match.' : 'No conversations yet.<br>Start a new chat to begin.'}</div>`;
      return;
    }
    list.innerHTML = '';
    for (const c of chats) {
      const tags = getChatTags(c.id);
      const el = document.createElement('div');
      el.className = 'chat-item' + (c.id === state.currentChatId ? ' active' : '');
      el.style.flexWrap = 'wrap';
      el.innerHTML = `
        <svg class="ic" style="flex-shrink:0"><use href="#i-chat"/></svg>
        <span class="ci-title"></span>
        <span class="ci-time"></span>
        <span class="ci-actions">
          <button data-act="tag" class="tag-btn" title="Add tag"><svg class="ic"><use href="#i-checklist"/></svg></button>
          <button data-act="rename" title="Rename"><svg class="ic" style="width:13px;height:13px"><use href="#i-pencil"/></svg></button>
          <button data-act="delete" title="Delete"><svg class="ic" style="width:13px;height:13px"><use href="#i-trash"/></svg></button>
        </span>
        ${tags.length ? `<div class="ci-tags" style="width:100%;padding-left:25px">${tags.map(t => `<span class="ci-tag removable" data-tag="${Markdown.escape(t)}">${Markdown.escape(t)}</span>`).join('')}</div>` : ''}`;
      const timeEl = el.querySelector('.ci-time');
      timeEl.dataset.ts = String(c.updatedAt || c.createdAt || 0);
      timeEl.textContent = AgentRows.formatRelative(c.updatedAt || c.createdAt, Date.now());
      timeEl.title = c.updatedAt ? new Date(c.updatedAt).toLocaleString() : '';
      el.querySelector('.ci-title').textContent = c.title || 'Untitled';

      // Click tag pill → remove tag
      el.querySelectorAll('.ci-tag.removable').forEach(pill => {
        pill.addEventListener('click', (e) => { e.stopPropagation(); removeChatTag(c.id, pill.dataset.tag); });
      });

      el.addEventListener('click', (e) => {
        if (e.target.closest('.ci-actions') || e.target.closest('.ci-tags')) return;
        selectChat(c.id);
        closeSidebarMobile();
      });

      // Tag button → inline input
      el.querySelector('[data-act="tag"]').addEventListener('click', (e) => {
        e.stopPropagation();
        const input = document.createElement('input');
        input.className = 'ci-tag-input';
        input.placeholder = 'tag name…';
        input.maxLength = 24;
        let existing = el.querySelector('.ci-tags');
        if (!existing) {
          existing = document.createElement('div');
          existing.className = 'ci-tags';
          existing.style.cssText = 'width:100%;padding-left:25px';
          el.appendChild(existing);
        }
        existing.appendChild(input);
        input.focus();
        const commit = () => { addChatTag(c.id, input.value); input.remove(); };
        input.addEventListener('keydown', (ev) => {
          ev.stopPropagation();
          if (ev.key === 'Enter') commit();
          if (ev.key === 'Escape') input.remove();
        });
        input.addEventListener('blur', () => setTimeout(() => input.remove(), 100));
      });

      el.querySelector('[data-act="rename"]').addEventListener('click', () => startRename(el, c));
      const delBtn = el.querySelector('[data-act="delete"]');
      delBtn.addEventListener('click', async () => {
        if (delBtn.dataset.armed) {
          try {
            await api(`/api/chats/${c.id}`, 'DELETE');
            state.chats = state.chats.filter(x => x.id !== c.id);
            delete state.chatTags[c.id]; saveChatTags();
            // A tag filter whose last holder was just deleted has to be cleared
            // here. `removeChatTag` did it; the delete path did not, so the
            // filter stayed active with nothing matching it — the sidebar read
            // "No conversations match." and the filter bar was hidden, leaving
            // no visible way back to the list.
            if (state.activeTagFilter &&
                !Object.values(state.chatTags).some(tags => tags.includes(state.activeTagFilter))) {
              state.activeTagFilter = null;
            }
            if (state.currentChatId === c.id) resetToWelcome();
            renderChatList($('#chatSearch').value);
            renderTagFilterBar();
            toast('Conversation deleted', 'success');
          } catch (e) { toast(e.message, 'error'); }
        } else {
          delBtn.dataset.armed = '1';
          delBtn.classList.add('danger-armed');
          delBtn.title = 'Click again to confirm';
          setTimeout(() => { delete delBtn.dataset.armed; delBtn.classList.remove('danger-armed'); delBtn.title = 'Delete'; }, 3000);
        }
      });
      list.appendChild(el);
    }
  }

  function startRename(itemEl, chat) {
    const titleEl = itemEl.querySelector('.ci-title');
    const input = document.createElement('input');
    input.className = 'ci-rename';
    input.value = chat.title || '';
    titleEl.replaceWith(input);
    input.focus();
    input.select();
    let done = false;
    const finish = async (save) => {
      if (done) return;
      done = true;
      const val = input.value.trim();
      if (save && val && val !== chat.title) {
        try {
          await api(`/api/chats/${chat.id}`, 'PATCH', { title: val });
          chat.title = val;
          if (state.currentChatId === chat.id) $('#topTitle').textContent = val;
          toast('Renamed', 'success');
        } catch (e) { toast(e.message, 'error'); }
      }
      renderChatList($('#chatSearch').value);
    };
    input.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') finish(true);
      if (e.key === 'Escape') finish(false);
      e.stopPropagation();
    });
    input.addEventListener('blur', () => finish(true));
    input.addEventListener('click', (e) => e.stopPropagation());
  }

  $('#chatSearch').addEventListener('input', (e) => renderChatList(e.target.value));

  // Keep the trailing ages honest as time passes. Re-rendering the list would
  // close an open rename box and drop the hover state, so only the labels move.
  setInterval(() => {
    const now = Date.now();
    document.querySelectorAll('#chatList .ci-time').forEach((el) => {
      const ts = Number(el.dataset.ts || 0);
      if (ts) el.textContent = AgentRows.formatRelative(ts, now);
    });
  }, 60000);
  $('#newChatBtn').addEventListener('click', () => { resetToWelcome(); closeSidebarMobile(); });
  $('#topNewChatBtn')?.addEventListener('click', () => { resetToWelcome(); closeSidebarMobile(); });

  // ------------------------------------------------------------------
  // Stream ownership
  //
  // A reply belongs to the view it was started from. Switching conversation —
  // or starting a new one — while it streams must both stop the server-side
  // turn (so it stops costing tokens) and invalidate the events still in
  // flight. Without this the old reply was appended to the brand-new chat and
  // its title was written over the header.
  // ------------------------------------------------------------------
  let activeStream = null; // { chatId, gen, controller }

  function abandonStream() {
    state.streamGen++;                 // every queued event from here on is stale
    const current = activeStream;
    activeStream = null;
    state.streamChatId = null;
    if (state.streaming) setStreaming(false);
    if (current) {
      try { current.controller.abort(); } catch { /* already finished */ }
      if (current.chatId) api(`/api/chat/${current.chatId}/stop`, 'POST').catch(() => {});
    }
  }

  function resetToWelcome() {
    abandonStream();
    state.currentChatId = null;
    state.currentMessages = [];
    const def = getProvider(state.settings.defaultProviderId);
    state.activeProviderId = (def && def.enabled ? def.id : null) || activeProvider()?.id || null;
    $('#messages').innerHTML = '';
    composer.value = '';
    composer.style.height = 'auto';
    $('#welcome').classList.remove('hidden');
    $('#topTitle').textContent = 'New conversation';
    renderChatList($('#chatSearch').value);
    renderProviderPill();
    state.fpPath = '';
    if (state.fpOpen) fpLoad('');
    composer.focus();
  }

  async function selectChat(id) {
    // Clicking away from a streaming reply cancels it rather than letting it
    // land in whatever conversation is opened next.
    if (state.streaming) abandonStream();
    try {
      const { chat } = await api(`/api/chats/${id}`);
      state.currentChatId = chat.id;
      state.currentMessages = chat.messages;
      state.activeProviderId = chat.providerId || state.activeProviderId;
      if (chat.model) {
        const p = activeProvider();
        if (p) p.model = chat.model;
      }
      $('#welcome').classList.add('hidden');
      $('#messages').innerHTML = '';
      for (const m of chat.messages) appendMessage(m, { animate: false });
      $('#topTitle').textContent = chat.title || 'Conversation';
      renderChatList($('#chatSearch').value);
      renderProviderPill();
      state.fpPath = '';
      if (state.fpOpen) fpLoad('');
      scrollToBottom(true);
    } catch (e) { toast(e.message, 'error'); }
  }

  // ==================================================================
  // Provider pill + menu + Chatbox Model Switcher
  // ==================================================================
  const MODEL_META = {
    'deepseek-ai/DeepSeek-V4-Flash-0731': { name: 'DeepSeek V4 Flash', badge: 'Default', desc: 'Reasoning & full-stack coding (20k ctx)' },
    'meta-llama/Llama-3.3-70B-Instruct-Turbo': { name: 'Llama 3.3 70B', badge: 'Meta', desc: '70B flagship instruction & general chat' },
    'Qwen/Qwen2.5-Coder-32B-Instruct': { name: 'Qwen 2.5 Coder', badge: 'Code', desc: 'Specialized programming & algorithms' },
    'zai-org/GLM-5.3-Flash': { name: 'GLM 5.3 Flash', badge: 'Vision', desc: 'Multimodal vision & fast reasoning' },
    'zai-org/GLM-5.2': { name: 'GLM 5.2', badge: 'Lite', desc: 'Fast conversational assistant' }
  };

  // ------------------------------------------------------------------
  // Deliberately small models, named in the picker.
  //
  // A cheap "lite"/"nano"/"mini" model writes short, minimal code no matter how
  // the prompt is worded — that is what it is. Nothing in the console said so:
  // the picker called `amazon/nova-lite-v1` just "Nova Lite" and the short output
  // read as the app being broken rather than as the model being small. (The
  // completeness round still pushes such a model to finish its files; this is
  // how the user learns to pick a bigger one in the first place.)
  // ------------------------------------------------------------------
  const SMALL_MODEL_RE = /(nano|\blite\b|\bmini\b|\btiny\b|\bsmall\b|-8b\b|\b1b\b|\b1\.5b\b|\b2b\b|\b3b\b|\b4b\b)/i;
  const SMALL_MODEL_NOTE = 'Lightweight — fast and cheap, but it writes short, minimal code. Pick a larger model for real projects.';

  function isSmallModel(id) {
    return SMALL_MODEL_RE.test(String(id || ''));
  }

  /** The one-line description shown under a model in the picker. */
  function modelDescription(id) {
    const curated = MODEL_META[id];
    if (curated && curated.desc) return curated.desc;
    if (isSmallModel(id)) return SMALL_MODEL_NOTE;
    return String(id || '');
  }

  function friendlyModelName(id) {
    if (!id) return 'Select model';
    if (MODEL_META[id]?.name) return MODEL_META[id].name;
    return id.replace(/^(deepseek-ai|meta-llama|zai-org|mistralai|Qwen)\//i, '')
             .replace(/[-_]latest$/i, '')
             .replace(/^gemini-/i, 'Gemini ')
             .replace(/^gpt-/i, 'GPT-')
             .replace(/^claude-/i, 'Claude ');
  }

  function updateComposerModelPill() {
    const p = activeProvider();
    const btnText = $('#composerModelName');
    if (!btnText) return;
    if (!p) {
      btnText.textContent = 'No provider';
      return;
    }
    btnText.textContent = friendlyModelName(p.model);
    btnText.title = `Current model: ${p.model || 'none'} (${p.name})`;
  }

  /**
   * Keeps the composer's provider chip in step with the active provider.
   *
   * This is the control that makes a phone usable: below 480px the topbar pill
   * shows only an avatar letter, so without this chip there is nothing on a
   * small screen that names — or changes — the provider a reply will come from.
   */
  function updateComposerProviderChip(p) {
    const nameEl = $('#composerProvName');
    const avatarEl = $('#composerProvAvatar');
    const btn = $('#composerProvBtn');
    if (!btn || !nameEl || !avatarEl) return;
    if (!p) {
      nameEl.textContent = 'No provider';
      avatarEl.textContent = '—';
      btn.title = 'No provider configured — open Settings → Providers';
      return;
    }
    nameEl.textContent = p.name;
    avatarEl.textContent = monogram(p.name);
    btn.title = `Current provider: ${p.name}${p.model ? ' · ' + p.model : ''}`;
  }

  function renderProviderPill() {
    const p = activeProvider();
    // With no provider the pill must say so. Returning early left the previous
    // provider's name, avatar and model chip on screen after the last provider
    // was deleted — the console claimed to be using something that no longer
    // existed, and only sending a message revealed otherwise.
    if (!p) {
      $('#ppAvatar').textContent = '—';
      $('#ppName').textContent = 'No provider';
      // updateComposerModelPill already handles the no-provider case; this is
      // the same path, so the two can never disagree.
      updateComposerModelPill();
      updateComposerProviderChip(null);
      syncToolChips();
      return;
    }
    const av = $('#ppAvatar');
    av.textContent = monogram(p.name);
    $('#ppName').textContent = p.name;
    updateComposerModelPill();
    updateComposerProviderChip(p);
    syncToolChips();
  }

  function renderProviderMenu() {
    renderProviderMenuInto($('#provMenu'));
  }

  /**
   * Fills a provider menu — the topbar's or the composer's.
   *
   * Both surfaces render the same list from the same function, so switching
   * provider from the chatbox on a phone cannot drift from switching it in the
   * header on a desktop.
   *
   * @param {HTMLElement} menu - the container to fill.
   */
  function renderProviderMenuInto(menu) {
    if (!menu) return;
    const current = activeProvider();
    menu.innerHTML = '';
    for (const p of state.providers) {
      const el = document.createElement('button');
      el.className = 'prov-item' + (current && p.id === current.id ? ' selected' : '');
      el.innerHTML = `
        <span class="prov-avatar"></span>
        <span class="pi-text">
          <span class="pi-name"><span class="pi-name-text"></span>${p.enabled ? '' : '<span class="dot-off" title="Disabled"></span>'}</span>
          <span class="pi-model"></span>
        </span>
        <svg class="ic pi-check"><use href="#i-check"/></svg>`;
      el.querySelector('.prov-avatar').textContent = monogram(p.name);
      el.querySelector('.pi-name-text').textContent = p.name;
      el.querySelector('.pi-model').textContent = p.model || '—';
      el.addEventListener('click', async () => {
        if (!p.enabled) { toast('This provider is disabled — enable it in Providers.', 'error'); return; }
        state.activeProviderId = p.id;
        if (state.currentChatId) {
          try { await api(`/api/chats/${state.currentChatId}`, 'PATCH', { providerId: p.id }); } catch { /* non-fatal */ }
        }
        renderProviderPill();
        closeProvMenu();
        closeComposerProvMenu();
        toast(`Switched to ${p.name}`, 'success');
      });
      menu.appendChild(el);
    }
    const foot = document.createElement('div');
    foot.className = 'pm-foot';
    foot.innerHTML = `<button class="prov-item" style="width:100%"><span class="prov-avatar" style="background:var(--surface-3)"><svg class="ic" style="width:14px;height:14px;color:var(--text-2)"><use href="#i-gear"/></svg></span><span class="pi-text"><span class="pi-name">Manage providers…</span><span class="pi-model">keys, models &amp; custom rules</span></span></button>`;
    foot.querySelector('button').addEventListener('click', () => { closeProvMenu(); closeComposerProvMenu(); openProviderModal(); });
    menu.appendChild(foot);
  }

  // ---- Chatbox Model Switcher Dropdown ----
  let composerModelOpen = false;
  let modelSearchTerm = '';

  function closeComposerModelDropdown() {
    composerModelOpen = false;
    $('#composerModelDropdown')?.classList.add('hidden');
    $('#composerModelBtn')?.classList.remove('open');
  }

  function renderComposerModelDropdown(targetProvId) {
    const dropdown = $('#composerModelDropdown');
    if (!dropdown) return;
    const p = (targetProvId ? getProvider(targetProvId) : null) || activeProvider();
    if (!p) {
      dropdown.innerHTML = '<div class="mp-empty">No active provider</div>';
      return;
    }

    const enabledProviders = state.providers.filter(x => x.enabled);
    let models = p.modelsCache && p.modelsCache.length
      ? p.modelsCache
      : (p.type === 'llamacoder'
        ? ['deepseek-ai/DeepSeek-V4-Flash-0731', 'meta-llama/Llama-3.3-70B-Instruct-Turbo', 'Qwen/Qwen2.5-Coder-32B-Instruct', 'zai-org/GLM-5.3-Flash', 'zai-org/GLM-5.2']
        : [p.model].filter(Boolean));

    dropdown.innerHTML = '';

    // Head
    const head = document.createElement('div');
    head.className = 'md-head';
    head.innerHTML = `
      <span class="md-title">Switch Model</span>
      <span class="md-prov-badge">${Markdown.escape(p.name)}</span>
    `;
    dropdown.appendChild(head);

    // Provider tabs come FIRST, above the list.
    //
    // They used to be appended after the model list, which on a phone meant
    // scrolling past every model before you could even change provider — and the
    // provider is the decision that comes first. On a small screen this is the
    // same choice the composer's provider chip offers, in the place the user is
    // already looking.
    if (enabledProviders.length > 1) {
      const provBar = document.createElement('div');
      provBar.className = 'md-providers';
      for (const ep of enabledProviders) {
        const tab = document.createElement('button');
        tab.type = 'button';
        tab.className = 'md-prov-tab' + (ep.id === p.id ? ' active' : '');
        tab.textContent = ep.name.replace(/\s*\(.*?\)/, '');
        tab.title = ep.name;
        tab.addEventListener('click', (e) => {
          e.stopPropagation();
          state.activeProviderId = ep.id;
          if (state.currentChatId) {
            api(`/api/chats/${state.currentChatId}`, 'PATCH', { providerId: ep.id }).catch(() => {});
          }
          renderProviderPill();
          renderComposerModelDropdown(ep.id);
        });
        provBar.appendChild(tab);
      }
      dropdown.appendChild(provBar);
    }

    // Search bar if more than 5 models
    if (models.length > 5) {
      const searchBox = document.createElement('div');
      searchBox.className = 'md-search';
      searchBox.innerHTML = `
        <svg class="ic"><use href="#i-search"/></svg>
        <input type="text" placeholder="Search models…" value="${Markdown.escape(modelSearchTerm)}" autocomplete="off" />
      `;
      const sInput = searchBox.querySelector('input');
      sInput.addEventListener('input', (e) => {
        modelSearchTerm = e.target.value.toLowerCase().trim();
        filterItems();
      });
      dropdown.appendChild(searchBox);
      setTimeout(() => sInput.focus(), 50);
    }

    // List
    const list = document.createElement('div');
    list.className = 'md-list';

    for (const m of models) {
      const meta = MODEL_META[m] || {};
      const friendly = friendlyModelName(m);
      const isSelected = p.model === m;
      const item = document.createElement('button');
      item.type = 'button';
      item.className = 'md-item' + (isSelected ? ' selected' : '');
      item.setAttribute('data-model', m.toLowerCase());
      item.setAttribute('data-name', friendly.toLowerCase());

      item.innerHTML = `
        <div class="md-item-left">
          <div class="md-item-row">
            <span class="md-item-name">${Markdown.escape(friendly)}</span>
            ${meta.badge ? `<span class="md-badge ${meta.badge === 'Default' ? 'accent' : ''}">${Markdown.escape(meta.badge)}</span>` : ''}
          </div>
          <span class="md-item-desc">${Markdown.escape(modelDescription(m))}</span>
        </div>
        <svg class="ic md-item-check"><use href="#i-check"/></svg>
      `;

      item.addEventListener('click', async (e) => {
        e.stopPropagation();
        p.model = m;
        state.activeProviderId = p.id;
        try {
          await api(`/api/providers/${p.id}`, 'PUT', { model: m });
        } catch { /* non-fatal */ }

        if (state.currentChatId) {
          try {
            await api(`/api/chats/${state.currentChatId}`, 'PATCH', { model: m, providerId: p.id });
          } catch { /* non-fatal */ }
        }

        renderProviderPill();
        updateComposerModelPill();
        closeComposerModelDropdown();
        toast(`Model switched to ${friendly}`, 'success');
      });

      list.appendChild(item);
    }
    dropdown.appendChild(list);

    function filterItems() {
      const items = list.querySelectorAll('.md-item');
      let visibleCount = 0;
      items.forEach(it => {
        const id = it.getAttribute('data-model') || '';
        const nm = it.getAttribute('data-name') || '';
        const match = !modelSearchTerm || id.includes(modelSearchTerm) || nm.includes(modelSearchTerm);
        it.style.display = match ? 'flex' : 'none';
        if (match) visibleCount++;
      });
      let empty = list.querySelector('.mp-empty');
      if (visibleCount === 0) {
        if (!empty) {
          empty = document.createElement('div');
          empty.className = 'mp-empty';
          empty.textContent = 'No matching models';
          list.appendChild(empty);
        }
      } else if (empty) {
        empty.remove();
      }
    }
    if (modelSearchTerm) filterItems();
  }

  $('#composerModelBtn')?.addEventListener('click', (e) => {
    e.stopPropagation();
    composerModelOpen = !composerModelOpen;
    if (composerModelOpen) {
      closeComposerProvMenu();
      closeProvMenu();
      modelSearchTerm = '';
      $('#composerModelBtn').classList.add('open');
      renderComposerModelDropdown();
      $('#composerModelDropdown').classList.remove('hidden');
    } else {
      closeComposerModelDropdown();
    }
  });

  document.addEventListener('click', (e) => {
    if (composerModelOpen && !e.target.closest('#modelSelectWrap')) {
      closeComposerModelDropdown();
    }
  });

  // ---- Composer provider switcher (the mobile control) ----
  let composerProvOpen = false;

  function closeComposerProvMenu() {
    composerProvOpen = false;
    $('#composerProvDropdown')?.classList.add('hidden');
  }

  $('#composerProvBtn')?.addEventListener('click', (e) => {
    e.stopPropagation();
    composerProvOpen = !composerProvOpen;
    if (composerProvOpen) {
      // One menu open at a time: the two dropdowns overlap, and leaving the
      // model list open under the provider list made the second tap a no-op.
      closeComposerModelDropdown();
      closeProvMenu();
      renderProviderMenuInto($('#composerProvDropdown'));
      $('#composerProvDropdown').classList.remove('hidden');
    } else {
      closeComposerProvMenu();
    }
  });

  document.addEventListener('click', (e) => {
    if (composerProvOpen && !e.target.closest('#composerProvWrap')) closeComposerProvMenu();
  });

  let provMenuOpen = false;
  function closeProvMenu() { provMenuOpen = false; $('#provMenu').classList.add('hidden'); }
  $('#providerPill').addEventListener('click', (e) => {
    e.stopPropagation();
    provMenuOpen = !provMenuOpen;
    if (provMenuOpen) {
      closeComposerProvMenu();
      renderProviderMenu();
      $('#provMenu').classList.remove('hidden');
    } else closeProvMenu();
  });
  document.addEventListener('click', (e) => {
    if (provMenuOpen && !e.target.closest('.provider-wrap')) closeProvMenu();
  });

  // ==================================================================
  // Tool chips
  // ==================================================================
  function syncToolChips() {
    const p = activeProvider();
    const supported = p ? p.toolsEnabled !== false : true;
    // The composer no longer carries the three tool toggles — tools are decided
    // per provider in Settings. The elements may be absent now, so every lookup
    // is optional; `state.tools` keeps the conversation's own choice for any
    // build (or test) that still renders them.
    for (const [key, id] of [['web', '#toolWeb'], ['files', '#toolFiles'], ['code', '#toolCode']]) {
      const btn = $(id);
      if (!btn) continue;
      const live = !!state.tools[key] && supported;
      btn.classList.toggle('on', live);
      btn.classList.toggle('disabled', !supported);
      // The on/off state is carried by the check badge, so mirror it for
      // screen readers and keyboard users.
      btn.setAttribute('aria-pressed', String(live));
      btn.title = supported
        ? (key === 'web' ? 'Allow the agent to search the web and read pages' : key === 'files' ? 'Allow the agent to create, read and edit workspace files' : 'Allow the agent to generate complete apps and tools via Hama AI')
        : 'The selected provider has agent tools disabled';
    }
  }
  // Optional: these controls are not in the composer any more (see index.html).
  $('#toolWeb')?.addEventListener('click', () => toggleTool('web'));
  $('#toolFiles')?.addEventListener('click', () => toggleTool('files'));
  $('#toolCode')?.addEventListener('click', () => toggleTool('code'));
  function toggleTool(key) {
    const p = activeProvider();
    if (p && p.toolsEnabled === false) { toast('Tools are disabled for this provider.', 'error'); return; }
    state.tools[key] = !state.tools[key];
    localStorage.setItem('hama_tools', JSON.stringify(state.tools));
    syncToolChips();
  }

  // ==================================================================
  // Messages rendering
  // ==================================================================
  const TOOL_ICONS = {
    web_search: 'i-globe', fetch_url: 'i-globe',
    write_file: 'i-pencil', edit_file: 'i-pencil',
    read_file: 'i-file', list_files: 'i-folder',
    delete_file: 'i-trash', create_directory: 'i-folder',
    update_todos: 'i-checklist', write_files: 'i-pencil',
    llamacoder_generate: 'i-code',
    run_shell: 'i-terminal', start_job: 'i-terminal',
    job_output: 'i-terminal', job_kill: 'i-terminal', job_list: 'i-terminal'
  };

  function toolSummary(name, args) {
    if (!args) return '';
    if (name === 'web_search') return String(args.query || '');
    if (name === 'fetch_url') return String(args.url || '');
    if (name === 'edit_file') return `${args.path || ''} — replace “${String(args.find || '').slice(0, 40)}”`;
    if (name === 'llamacoder_generate') return `App engine: "${String(args.prompt || '').slice(0, 38)}…" → ${args.save_path || 'workspace'}`;
    if (name === 'run_shell') return String(args.command || '');
    if (name === 'start_job') return String(args.description || args.command || '');
    if (name === 'job_output') return String(args.id || '');
    if (name === 'job_kill') return String(args.id || '');
    if (name === 'update_todos' && Array.isArray(args.todos)) {
      const done = args.todos.filter(t => (t && t.status) === 'completed').length;
      return `${args.todos.length} task${args.todos.length === 1 ? '' : 's'} (${done} done)`;
    }
    if (args.path !== undefined) return String(args.path);
    return JSON.stringify(args).slice(0, 80);
  }

  function toolCard(run, { animate = true } = {}) {
    const el = document.createElement('div');
    const d = AgentRows.describeRun(run);
    const state = d.state || (run.pending ? 'running' : (d.failed ? 'error' : 'ok'));
    el.className = 'tool-row' + (run.pending ? ' running' : (d.failed ? ' failed' : ''));
    el.dataset.state = state;
    el.dataset.toolId = run.id || '';

    const esc = (s) => Markdown.escape(String(s ?? ''));
    const icon = d.icon || TOOL_ICONS[run.name] || 'i-tool';

    // The chips line. Diff stats lead (they are what the eye looks for), then the
    // descriptive chips, then how long the step took.
    const chips = [];
    if (d.failed && !d.pending) chips.push('<span class="tr-chip fail">failed</span>');
    if (d.diff && (d.diff.added || d.diff.removed)) {
      chips.push(`<span class="tr-chip add">+${d.diff.added}</span>`);
      chips.push(`<span class="tr-chip del">\u2212${d.diff.removed}</span>`);
    }
    for (const c of d.chips || []) {
      const s = String(c);
      // `+12 −4` is already rendered above as its own coloured pair.
      if (d.diff && /^[+\u2212-]\d/.test(s)) continue;
      chips.push(`<span class="tr-chip">${esc(s)}</span>`);
    }
    // Warnings about the call itself — a truncated read, a job that failed, a
    // repeated or refused call — get their own colour so they are not read as
    // neutral metadata next to "exit 0".
    for (const c of d.badChips || []) {
      chips.push(`<span class="tr-chip warn">${esc(String(c))}</span>`);
    }
    if (d.ms != null && !d.timeShown) {
      chips.push(`<span class="tr-chip">${esc(AgentRows.formatMs(d.ms))}</span>`);
    }

    // A failure replaces the summary line, so what broke is readable without
    // expanding the row. A path the user can open replaces it for a file row.
    const failure = state === 'error' && d.errorSummary ? d.errorSummary : '';
    const openable = !failure && d.filePath ? d.filePath : '';
    const targetText = failure || d.target;

    // Stacked, the way a trajectory reads: what happened, to what, and what it
    // cost — one fact per line, so a long file path never squeezes the verb.
    el.innerHTML = `
      <div class="tr-head">
        <span class="tr-icon"><svg class="ic"><use href="#${icon}"/></svg></span>
        <span class="tr-text">
          <span class="tr-label">${esc(d.label)}</span>
          ${targetText
            ? (openable
              ? `<span class="tr-target"><button type="button" class="tr-filelink" title="Open ${esc(openable)} in the viewer">${esc(openable)}</button></span>`
              : `<span class="tr-target${failure ? ' error' : ''}">${esc(targetText)}</span>`)
            : ''}
          ${chips.length ? `<span class="tr-chips">${chips.join('')}</span>` : ''}
        </span>
        <span class="tr-tail">
          <span class="tr-elapsed"></span>
          <span class="tr-status"></span>
          <span class="tr-chevron"><svg class="ic"><use href="#i-chevron"/></svg></span>
        </span>
      </div>
      <div class="tr-body"></div>`;

    // The state is carried by a colour and a glyph, both invisible to assistive
    // technology, so the row also states it in words.
    const stateWord = state === 'running' ? 'running' : state === 'error' ? 'failed' : state === 'stopped' ? 'stopped' : '';
    if (stateWord) {
      const sr = document.createElement('span');
      sr.className = 'visually-hidden';
      sr.textContent = stateWord;
      el.querySelector('.tr-head').prepend(sr);
    }

    const status = el.querySelector('.tr-status');
    if (run.pending) {
      status.innerHTML = '<span class="tr-spin"></span>';
      // A one-shot tool finishes before the first tick ever arrives; a shell
      // command can run for minutes, and during that time this is the only thing
      // on screen that changes — which is what tells the user the turn is alive.
      if (run.elapsedMs != null) setElapsed(el, run.elapsedMs);
    } else if (state === 'stopped') {
      status.classList.add('stopped');
      status.innerHTML = '<svg class="ic"><use href="#i-bolt"/></svg>';
    } else if (d.failed) {
      status.classList.add('failed');
      status.innerHTML = '<svg class="ic"><use href="#i-close"/></svg>';
    } else {
      status.classList.add('done');
      status.innerHTML = '<svg class="ic"><use href="#i-check"/></svg>';
    }

    const head = el.querySelector('.tr-head');
    head.addEventListener('click', () => {
      if (!el.classList.contains('open')) fillRowBody(el, run);
      el.classList.toggle('open');
    });

    // Opening the path must not also toggle the row — the same reason the DSH row
    // stops propagation on its file link.
    const link = el.querySelector('.tr-filelink');
    if (link) {
      link.addEventListener('click', (e) => {
        e.stopPropagation();
        openFileViewer(openable);
      });
    }

    if (!animate) el.style.animation = 'none';
    return el;
  }

  function fillRowBody(el, run) {
    const body = el.querySelector('.tr-body');
    if (!body || body.dataset.filled) return;
    body.dataset.filled = '1';
    const esc = (s) => Markdown.escape(String(s ?? ''));
    const kind = AgentRows.bodyKind(run);

    if (kind === 'error') {
      body.innerHTML = `<div class="tr-error">${esc(run.result)}</div>`;
      return;
    }
    if (kind === 'diff') {
      // The server already produced a capped unified diff alongside the edit and
      // it is the authoritative one: it knows about `replace_all`, and it was
      // cut at a bounded number of lines. Recomputing here from `find`/`replace`
      // was both wrong for a replace-all edit (it showed one occurrence) and
      // unbounded (a huge edit froze the tab building an O(n·m) table).
      const serverDiff = run.meta && typeof run.meta.diff === 'string' ? run.meta.diff : '';
      if (serverDiff.trim()) {
        const lines = serverDiff.replace(/\n$/, '').split('\n');
        body.innerHTML = `<div class="tr-diff">${lines.map((l) => {
          const type = l.startsWith('+') ? 'add' : l.startsWith('-') ? 'del' : l.startsWith('@@') ? 'hunk' : 'ctx';
          return `<span class="ln ${type}">${esc(l)}</span>`;
        }).join('')}</div>`;
        return;
      }
      const lines = AgentRows.diffLines(run.args && run.args.find, run.args && run.args.replace);
      body.innerHTML = `<div class="tr-diff">${lines.map((l) => `<span class="ln ${l.type}">${esc(l.text)}</span>`).join('')}</div>`;
      return;
    }
    if (kind === 'files') {
      // Prefer the server's per-file report: it carries the size, the line count
      // and whether the file was created or replaced, none of which the raw
      // arguments know.
      const reported = Array.isArray(run.meta && run.meta.files) ? run.meta.files : null;
      const files = reported || (Array.isArray(run.args && run.args.files) ? run.args.files : []);
      body.innerHTML = `<div class="tr-files">${files.map((f) => {
        const size = f && f.bytes != null ? AgentRows.formatBytes(f.bytes) : '';
        const lines = f && f.lines != null ? (f.lines === 1 ? '1 line' : f.lines + ' lines') : '';
        const verb = f && f.created === false ? 'replaced' : (f && f.created === true ? 'created' : '');
        return `<div class="tr-file"><span class="p">${esc(f && f.path)}</span>`
          + `<span class="s">${esc([lines, size, verb].filter(Boolean).join(' · '))}</span></div>`;
      }).join('')}</div>`;
      return;
    }
    if (kind === 'todos') {
      const t = AgentRows.describeTodos(run.args);
      body.innerHTML = `<div class="tr-todos">${t.items.map((it) =>
        `<div class="tr-todo ${it.status}"><span class="box">${it.status === 'completed' ? '✓' : it.status === 'in_progress' ? '•' : ''}</span><span>${esc(it.text)}</span></div>`
      ).join('')}</div>`;
      return;
    }
    if (kind === 'preview') {
      const code = run.args && run.args.content;
      if (typeof code === 'string') {
        const lang = AgentRows.langOf(run.args && run.args.path);
        body.innerHTML = `<pre class="tr-pre"><code>${Markdown.highlight(code, lang)}</code></pre>`;
      } else {
        body.innerHTML = `<pre class="tr-pre">${esc(run.result)}</pre>`;
      }
      return;
    }
    // A read file is code — show it highlighted rather than as plain text.
    if (kind === 'text' && run.name === 'read_file' && typeof run.result === 'string') {
      const lang = AgentRows.langOf(run.args && run.args.path);
      const cappedCode = AgentRows.clipBody(run.result, 12000);
      body.innerHTML = `<pre class="tr-pre"><code>${Markdown.highlight(cappedCode.text, lang)}</code></pre>`;
      return;
    }
    // results / output / text
    const text = String(run.result ?? '');
    // clipBody already marks where content was hidden, head and tail both kept.
    const capped = AgentRows.clipBody(text, 6000);
    // A script's or a shell command's output is usually coloured; render the
    // escapes rather than showing them or throwing the colour away.
    const isTerminal = kind === 'output' || run.name === 'run_script' || run.name === 'run_shell' || run.name === 'job_output';
    if (isTerminal && typeof Ansi !== 'undefined' && Ansi.hasAnsi(capped.text)) {
      body.innerHTML = `<pre class="tr-pre tr-ansi">${Ansi.toHtml(capped.text)}</pre>`;
      return;
    }
    body.innerHTML = `<pre class="tr-pre">${esc(capped.text)}</pre>`;
  }

  // The receipt under a turn's trajectory: what all those steps added up to.
  // Built from the runs alone, so it is identical for a live turn and a
  // transcript reloaded from disk.
  /**
   * The receipt under a turn's trajectory: what all those steps added up to.
   *
   * Rendered as discrete chips rather than one sentence joined by dots, because
   * `12 steps · 5 files changed · +142 −38 · 3 commands · 2 background jobs` read
   * as a wall of text: the numbers are the part worth scanning and they were
   * buried in connectors. Each fact now gets its own chip, edits get their
   * coloured pair, and a live elapsed time ticks while the turn is running so a
   * long step still looks alive.
   *
   * @param {Array} runs - the turn's tool runs, including ones still pending.
   * @returns {HTMLElement|null} the receipt, or null when the turn did nothing.
   */
  function turnSummaryEl(runs) {
    const s = AgentRows.summarizeRuns(runs);
    if (!s.steps) return null;

    const el = document.createElement('div');
    el.className = 'turn-summary' + (s.failed ? ' has-failure' : '');
    const esc = (v) => Markdown.escape(String(v));

    const chips = [];
    chips.push(`<span class="ts-chip">${esc(s.steps === 1 ? '1 step' : s.steps + ' steps')}</span>`);
    if (s.files) {
      chips.push(`<span class="ts-chip">${esc(s.files === 1 ? '1 file changed' : s.files + ' files changed')}</span>`);
    }
    if (s.added || s.removed) {
      chips.push(`<span class="ts-chip ts-add">+${s.added}</span>`);
      chips.push(`<span class="ts-chip ts-del">−${s.removed}</span>`);
    }
    if (s.commands) chips.push(`<span class="ts-chip">${esc(s.commands === 1 ? '1 command' : s.commands + ' commands')}</span>`);
    if (s.jobs) chips.push(`<span class="ts-chip">${esc(s.jobs === 1 ? '1 background job' : s.jobs + ' background jobs')}</span>`);
    if (s.failed) chips.push(`<span class="ts-chip ts-fail">${esc(s.failed === 1 ? '1 failed' : s.failed + ' failed')}</span>`);

    el.innerHTML = '<svg class="ic"><use href="#' + (s.failed ? 'i-close' : 'i-check') + '"/></svg>'
      + '<span class="ts-chips">' + chips.join('') + '</span>'
      + '<span class="ts-elapsed"></span>';
    return el;
  }

  /** Keeps one receipt per zone, updating it in place as steps arrive. */
  function refreshTurnSummary(zone, runs) {
    if (!zone) return;
    const existing = zone.querySelector('.turn-summary');
    const next = turnSummaryEl(runs);
    if (!next) { if (existing) existing.remove(); return; }
    // Replace only the chips, so the elapsed readout the clock writes into is
    // not destroyed and recreated once per step.
    if (existing) {
      existing.className = next.className;
      const chips = existing.querySelector('.ts-chips');
      const nextChips = next.querySelector('.ts-chips');
      if (chips && nextChips) chips.innerHTML = nextChips.innerHTML;
      else existing.replaceWith(next);
      return;
    }
    zone.appendChild(next);
  }

  // The agent's trajectory: a flat, chronological list of its actions — one row
  // per tool call, exactly as they happened (Grep / Read / Edit / Ran…). A saved
  // turn has no interleaved thinking timeline, so its reasoning renders as a
  // single collapsed "Think" row above the actions.
  function renderToolRuns(zone, runs, { animate = true, reasoning = '', ms = null, thinkMs = null, crewRuns = null } = {}) {
    // The team's rows are rendered FIRST, under their own reviewer cards, so the
    // lead's trajectory below reads as the lead's work. They used to be pushed
    // into the same list as the lead's runs, which is why one turn reported ten
    // steps for five files and no row said which model had run it.
    if (crewRuns && crewRuns.length) renderCrewRuns(zone, crewRuns, { animate });
    if (reasoning) zone.appendChild(thinkingRow(reasoning, { ms: thinkMs || 0 }));
    for (const run of runs || []) zone.appendChild(toolCard(run, { animate }));
    refreshTurnSummary(zone, runs);
    // A saved turn carries its own duration; show it instead of an empty slot.
    // (A live turn gets the same value from the stream clock, and this pins it.)
    if (Number.isFinite(ms) && ms >= 1000) {
      const el = zone.querySelector('.turn-summary');
      const slot = el && el.querySelector('.ts-elapsed');
      if (slot) {
        slot.textContent = AgentRows.formatMs(ms);
        slot.classList.add('on', 'final');
      }
    }
  }

  // ------------------------------------------------------------------
  // Team (crew) cards.
  //
  // A reviewer is a whole second agent: it reads files, edits them and writes
  // prose about what it changed. Its activity belongs in one nested card, not
  // inline in the answer — which is where it used to land, so a user's reply
  // contained the reviewer's `<response>` wrapper, its `[Tool Result (…)]`
  // echoes and its shell transcripts as plain text. The same card is built for a
  // live turn and for a reloaded one, so the transcript does not change shape
  // when the stream swaps the live element for the saved message.
  // ------------------------------------------------------------------
  function teamCardShell(index, meta = {}) {
    const total = Number(meta.total) || 0;
    const card = document.createElement('div');
    card.className = 'team-card completed';
    card.dataset.crewIndex = String(index);
    card.innerHTML = `
      <div class="tc-head">
        <span class="tc-icon"><svg class="ic"><use href="#i-workflow"/></svg></span>
        <span class="tc-text">
          <span class="tc-label"></span>
          <span class="tc-who"></span>
        </span>
        <span class="tc-tail">
          <span class="tc-count"></span>
          <span class="tc-status"></span>
          <span class="tc-chevron"><svg class="ic"><use href="#i-chevron"/></svg></span>
        </span>
      </div>
      <div class="tc-body">
        <div class="tc-md md"></div>
        <div class="tc-runs"></div>
      </div>`;
    card.querySelector('.tc-label').textContent =
      total > 1 ? `Team review ${index} of ${total}` : 'Team review';
    const who = friendlyModelName(meta.model || '') || meta.provider || 'another model';
    card.querySelector('.tc-who').textContent = who;
    card.querySelector('.tc-head').addEventListener('click', () => card.classList.toggle('open'));
    return card;
  }

  /** The reviewers' tool rows for a saved turn, grouped under their reviewer. */
  function renderCrewRuns(zone, crewRuns, { animate = true } = {}) {
    const groups = new Map();
    for (const run of crewRuns || []) {
      const meta = (run && run.crew) || {};
      const index = Number(meta.index) || 1;
      if (!groups.has(index)) groups.set(index, { meta, runs: [] });
      groups.get(index).runs.push(run);
    }
    for (const [index, group] of groups) {
      const card = teamCardShell(index, group.meta);
      const runsEl = card.querySelector('.tc-runs');
      for (const run of group.runs) runsEl.appendChild(toolCard(run, { animate }));
      const count = card.querySelector('.tc-count');
      count.textContent = group.runs.length === 1 ? '1 step' : group.runs.length + ' steps';
      const status = card.querySelector('.tc-status');
      const failed = group.runs.some((r) => r && r.ok === false);
      status.classList.add(failed ? 'failed' : 'done');
      status.innerHTML = `<svg class="ic"><use href="#${failed ? 'i-close' : 'i-check'}"/></svg>`;
      // A reviewer that changed nothing is still worth one collapsed line, but
      // not an expanded body with an empty row list.
      if (group.runs.length) card.classList.add('has-runs');
      zone.appendChild(card);
    }
  }

  // A "Think" row holding the model's chain-of-thought, with a one-line snippet
  // so the reasoning is readable at a glance and expandable in full. The text is
  // placed with textContent (never HTML) so model output can't inject markup.
  function thinkingRow(reasoning, { pending = false, ms = 0 } = {}) {
    const row = document.createElement('div');
    row.className = 'stage-row' + (pending ? ' open running' : ' completed');
    const snippet = String(reasoning || '').replace(/\s+/g, ' ').trim().slice(0, 90);
    row.innerHTML = `
      <div class="sr-head">
        <span class="sr-orb"><svg class="ic"><use href="#i-brain"/></svg></span>
        <span class="sr-name">Think</span>
        <span class="sr-summary"></span>
        <span class="sr-time">${ms ? AgentRows.formatMs(ms) : ''}</span>
        <span class="sr-status"></span>
        <span class="sr-chevron"><svg class="ic"><use href="#i-chevron"/></svg></span>
      </div>
      <div class="sr-body"><pre class="tr-pre"></pre></div>`;
    row.querySelector('.sr-summary').textContent = snippet || (pending ? 'thinking…' : '');
    row.querySelector('.tr-pre').textContent = String(reasoning || '');
    const status = row.querySelector('.sr-status');
    if (pending) {
      status.innerHTML = '<span class="tr-spin"></span>';
    } else {
      status.classList.add('done');
      status.innerHTML = '<svg class="ic"><use href="#i-check"/></svg>';
    }
    row.querySelector('.sr-head').addEventListener('click', () => row.classList.toggle('open'));
    return row;
  }

  function detectPreviewTarget(m) {
    if (!m) return null;
    const cid = m.chatId || state.currentChatId || '';
    const files = [];
    const fileSet = new Set();

    function addFile(p) {
      if (!p || typeof p !== 'string') return;
      const clean = p.trim().replace(/^workspace\/chats\/[^/]+\//, '');
      if (!fileSet.has(clean)) {
        fileSet.add(clean);
        const name = clean.split('/').pop();
        const ext = name.split('.').pop().toLowerCase();
        files.push({ path: clean, name, ext });
      }
    }

    // 1. Tool runs from the turn
    const allRuns = [...(m.toolRuns || [])];

    let directCode = '';
    let runScriptTarget = '';

    for (const run of allRuns) {
      if (run.name === 'write_file' && run.args?.path) {
        addFile(run.args.path);
      }
      if (run.name === 'write_files' && Array.isArray(run.args?.files)) {
        for (const f of run.args.files) {
          if (f?.path) addFile(f.path);
        }
      }
      if (run.name === 'run_script' && run.args?.path) {
        addFile(run.args.path);
        runScriptTarget = run.args.path;
      }
      if (run.name === 'llamacoder_generate') {
        if (run.args?.save_path) addFile(run.args.save_path);
        const codeMatch = String(run.result || '').match(/```(?:[\w-]+)?\s*\n([\s\S]*?)```/);
        if (codeMatch) directCode = codeMatch[1];
      }
    }

    // 2. Scan code blocks in the message content
    const textsToCheck = [m.content || ''];

    for (const txt of textsToCheck) {
      if (!txt) continue;
      const matches = txt.matchAll(/```([\w-]+)?(?:\{path=([^}]+)\})?\s*\n([\s\S]*?)```/g);
      for (const match of matches) {
        const p = match[2];
        if (p) addFile(p);
        else if (!directCode) {
          const lang = (match[1] || '').toLowerCase();
          if (['html', 'svg', 'python', 'javascript', 'js', 'py', 'css', 'md'].includes(lang)) {
            directCode = match[3];
          }
        }
      }
      const rawHtml = txt.match(/<!DOCTYPE html[\s\S]*?<\/html>/i);
      if (rawHtml && !directCode) {
        directCode = rawHtml[0];
      }
    }

    // If the message mentions index.html explicitly, treat it as the preview
    // entry point even when no tool run named it. (This used to also scan the
    // pipeline's `artifacts` list, which no longer exists — a mention in the
    // text is the only signal a direct-mode turn gives.)
    if (/index\.html/i.test(m.content || '')) {
      addFile('index.html');
    }

    if (files.length === 0 && !directCode) return null;

    const htmlFile = files.find(f => ['html', 'htm'].includes(f.ext));
    const reactFile = files.find(f => ['tsx', 'jsx'].includes(f.ext) || /App\.(tsx|jsx|ts|js)$/i.test(f.name || ''));
    const scriptFile = files.find(f => ['py', 'js'].includes(f.ext));
    const docFile = files.find(f => ['md', 'txt'].includes(f.ext));

    let type = 'code';
    let primaryFile = '';
    let title = 'Deliverables';

    // React first. A Vite-style project ships an index.html too, and choosing it
    // made the Live App blank: that html references `/src/main.tsx`, an absolute
    // path that resolves against the console's own origin and 404s, so the frame
    // loaded an empty document and never ran a bundle. When there is a React
    // entry point the bundled preview is the only one that can work, whatever
    // other html files exist.
    if (reactFile) {
      type = 'web';
      primaryFile = reactFile.path;
      title = `React Application (${files.length} files)`;
    } else if (htmlFile) {
      type = 'web';
      primaryFile = htmlFile.path;
      title = files.length > 1 ? `Web Application (${files.length} files)` : htmlFile.name;
    } else if (scriptFile) {
      type = 'script';
      primaryFile = scriptFile.path;
      title = scriptFile.ext === 'py' ? `Python Script (${scriptFile.name})` : `Node.js Script (${scriptFile.name})`;
    } else if (docFile) {
      type = 'doc';
      primaryFile = docFile.path;
      title = docFile.name;
    } else if (files.length > 0) {
      primaryFile = files[0].path;
      title = files[0].name;
    } else if (directCode) {
      type = /<!doctype html|<html[\s>]|<body[\s>]/i.test(directCode) ? 'web' : 'code';
      title = type === 'web' ? 'Live Web Preview' : 'Code Preview';
    }

    return {
      title,
      chatId: cid,
      files,
      primaryFile,
      filePath: primaryFile,
      code: directCode,
      type,
      targetScript: runScriptTarget || (scriptFile ? scriptFile.path : '')
    };
  }

  function renderDeliverablesCard(target) {
    if (!target) return null;
    const pCard = document.createElement('div');
    pCard.className = 'app-preview-card';
    pCard.style.marginTop = '14px';

    const files = target.files || [];
    const isWeb = target.type === 'web' || files.some(f => ['html', 'htm', 'svg', 'tsx', 'jsx'].includes(f.ext || ''));
    const isScript = target.type === 'script' || (!isWeb && files.some(f => ['py', 'js'].includes(f.ext || '')));

    let desc = 'Interactive Sandbox deliverable ready';
    if (isWeb) desc = files.length > 1 ? `Full-stack web project (${files.length} files) · Live sandbox preview` : 'Live web preview ready';
    else if (isScript) desc = 'Script deliverable · Ready to execute in workspace terminal';

    let chipsHtml = '';
    if (files.length > 0) {
      chipsHtml = `<div class="ws-file-chips">` + files.map(f => {
        const ext = (f.name || f.path || f).split('.').pop().toLowerCase();
        let icon = '#i-file';
        let cls = '';
        if (['html', 'htm', 'svg'].includes(ext)) { icon = '#i-globe'; cls = 'is-html'; }
        else if (ext === 'py') { icon = '#i-terminal'; cls = 'is-py'; }
        else if (ext === 'js') { icon = '#i-code'; cls = 'is-js'; }
        else if (ext === 'css') { icon = '#i-pencil'; cls = 'is-css'; }
        else if (ext === 'md') { icon = '#i-file'; cls = 'is-md'; }
        return `<button type="button" class="ws-chip ${cls}" data-file="${Markdown.escape(f.path || f)}" title="Open ${Markdown.escape(f.name || f)} in Sandbox">
          <svg class="ic" style="width:12px;height:12px"><use href="${icon}"/></svg><span>${Markdown.escape(f.name || f.path || f)}</span>
        </button>`;
      }).join('') + `</div>`;
    }

    let actionBtnsHtml = '';
    if (isScript) {
      actionBtnsHtml += `<button type="button" class="apc-run-btn" title="Run script in workspace console"><svg class="ic"><use href="#i-play"/></svg><span>Run Script</span></button>`;
    }
    actionBtnsHtml += `<button type="button" class="apc-preview-btn"><svg class="ic"><use href="${isWeb ? '#i-eye' : isScript ? '#i-terminal' : '#i-code'}"/></svg><span>${isWeb ? 'Preview App' : 'Open Sandbox'}</span></button>`;
    actionBtnsHtml += `<button type="button" class="apc-popout-btn" title="Open in new window"><svg class="ic"><use href="#i-external"/></svg></button>`;

    pCard.innerHTML = `
      <div class="apc-left">
        <div class="apc-orb"><svg class="ic"><use href="${isWeb ? '#i-eye' : isScript ? '#i-terminal' : '#i-code'}"/></svg></div>
        <div class="apc-details">
          <div class="apc-title">${Markdown.escape(target.title || 'Deliverables')}</div>
          <div class="apc-desc">${desc}</div>
          ${chipsHtml}
        </div>
      </div>
      <div class="apc-actions">
        ${actionBtnsHtml}
      </div>
    `;

    const previewBtn = pCard.querySelector('.apc-preview-btn');
    if (previewBtn) {
      previewBtn.addEventListener('click', () => openAppPreview(target));
    }

    const runBtn = pCard.querySelector('.apc-run-btn');
    if (runBtn) {
      runBtn.addEventListener('click', () => {
        openAppPreview(target, 'terminal');
        const scriptToRun = target.targetScript || target.primaryFile || (files.find(f => /\.(py|js)$/i.test(f.name || f.path)) || {}).path;
        if (scriptToRun) setTimeout(() => runTerminalScript(scriptToRun), 100);
      });
    }

    pCard.querySelectorAll('.ws-chip').forEach(chip => {
      chip.addEventListener('click', (e) => {
        e.stopPropagation();
        const filePath = chip.dataset.file;
        openAppPreview(target, 'code', filePath);
      });
    });

    const popBtn = pCard.querySelector('.apc-popout-btn');
    if (popBtn) {
      popBtn.addEventListener('click', () => {
        const cid = target.chatId || state.currentChatId || '';
        if (isWeb && (target.primaryFile || target.filePath)) {
          const p = target.primaryFile || target.filePath;
          window.open(`/api/workspace/${encodeURIComponent(cid)}/${encodeURIComponent(p)}`, '_blank');
        } else if (target.filePath) {
          window.open(`/api/files/raw?chatId=${encodeURIComponent(cid)}&path=${encodeURIComponent(target.filePath)}`, '_blank');
        } else if (target.code) {
          const blob = new Blob([target.code], { type: isWeb ? 'text/html' : 'text/plain' });
          window.open(URL.createObjectURL(blob), '_blank');
        }
      });
    }

    return pCard;
  }

  // ------------------------------------------------------------------
  // Assistant message shell
  //
  // One builder serves both the streaming placeholder and a persisted turn, so
  // the header — name, model chip, timestamp, actions — does not jump when the
  // live element is swapped for the canonical one at message_end.
  // ------------------------------------------------------------------
  function buildAssistantShell() {
    const el = document.createElement('div');
    el.className = 'msg assistant';
    el.innerHTML = `
      <div class="msg-avatar"><svg><use href="#i-logo"/></svg></div>
      <div class="msg-body">
        <div class="msg-meta">
          <span class="msg-who"></span>
          <span class="msg-model hidden"></span>
          <span class="msg-flags"></span>
          <span class="msg-time"></span>
          <span class="msg-dur hidden"></span>
          <span class="msg-actions">
            <button type="button" class="msga-copy" title="Copy this reply"><svg class="ic"><use href="#i-copy"/></svg></button>
            <button type="button" class="msga-retry" title="Ask again — resends your request above"><svg class="ic"><use href="#i-refresh"/></svg></button>
          </span>
        </div>
        <div class="tool-zone"></div>
        <div class="md"></div>
      </div>`;
    el.querySelector('.msg-who').textContent = state.settings.agentName || 'HAMA';
    return el;
  }

  /** Friendly name of the model behind a reply, for the header chip. */
  function replyModelLabel(m) {
    if (m && m.model) return friendlyModelName(m.model);
    const p = getProvider(m && m.providerId) || activeProvider();
    return p ? friendlyModelName(p.model) : '';
  }

  function fillAssistantMeta(el, m) {
    const modelEl = el.querySelector('.msg-model');
    const label = replyModelLabel(m || {});
    if (label) {
      modelEl.textContent = label;
      modelEl.title = (m && m.model) || label;
      modelEl.classList.remove('hidden');
    }
    const flags = el.querySelector('.msg-flags');
    flags.innerHTML = '';
    if (m && m.aborted) {
      const chip = document.createElement('span');
      chip.className = 'msg-chip stopped';
      chip.textContent = 'Stopped';
      flags.appendChild(chip);
    }
    const bits = [];
    if (m && m.ts) bits.push(fmtTime(m.ts));
    // Time and duration are separate facts, not one dot-joined string: the time
    // is a caption, the duration is a measurement the eye compares between
    // turns, so it gets its own chip.
    el.querySelector('.msg-time').textContent = bits.join(' ');
    const durEl = el.querySelector('.msg-dur');
    if (durEl) {
      const ms = m && Number.isFinite(m.ms) ? m.ms : 0;
      if (ms >= 1000) {
        durEl.textContent = AgentRows.formatMs(ms);
        durEl.title = 'Time this turn took';
        durEl.classList.remove('hidden');
      } else {
        durEl.textContent = '';
        durEl.classList.add('hidden');
      }
    }
  }

  function flashIcon(btn, href, restore = '#i-copy') {
    const icon = btn && btn.querySelector('use');
    if (!icon) return;
    icon.setAttribute('href', href);
    setTimeout(() => icon.setAttribute('href', restore), 1500);
  }

  /** The user text that produced a given assistant reply. */
  function previousUserPrompt(m) {
    const list = state.currentMessages || [];
    let i = m && m.id ? list.findIndex(x => x.id === m.id) : -1;
    if (i < 0) i = list.length; // live / unsaved reply: search back from the end
    for (let n = i - 1; n >= 0; n--) {
      const item = list[n];
      if (item && item.role === 'user' && item.content) return item.content;
    }
    return '';
  }

  /** Wires copy + retry. `getText` lets the streaming placeholder copy its buffer. */
  function wireAssistantActions(el, m, getText) {
    const copyBtn = el.querySelector('.msga-copy');
    copyBtn.addEventListener('click', () => {
      copyText(getText ? getText() : ((m && m.content) || ''), () => flashIcon(copyBtn, '#i-check'));
    });
    const retryBtn = el.querySelector('.msga-retry');
    retryBtn.addEventListener('click', () => {
      if (state.streaming) { toast('Wait for the current reply to finish.', 'warning'); return; }
      const prompt = previousUserPrompt(m);
      if (!prompt) { toast('There is no earlier request to repeat.', 'info'); return; }
      sendMessage(prompt);
    });
  }

  function appendMessage(m, { animate = true } = {}) {
    const wrap = $('#messages');

    if (m.role !== 'user') {
      const el = buildAssistantShell();
      fillAssistantMeta(el, m);
      wireAssistantActions(el, m);
      el.querySelector('.md').innerHTML = Markdown.render(m.content || '', { collapseCodeLines: 120 });
      renderToolRuns(el.querySelector('.tool-zone'), m.toolRuns || [], {
        animate,
        reasoning: m.reasoning || '',
        ms: m.ms,
        thinkMs: m.thinkMs,
        crewRuns: m.crewRuns || null
      });

      const previewTarget = detectPreviewTarget(m);
      if (previewTarget) {
        const pCard = renderDeliverablesCard(previewTarget);
        if (pCard) el.querySelector('.msg-body').appendChild(pCard);
      }
      if (!animate) el.style.animation = 'none';
      wrap.appendChild(el);
      return el;
    }

    const el = document.createElement('div');
    el.className = 'msg user';
    const bubble = document.createElement('div');
    bubble.className = 'bubble';
    const textEl = document.createElement('div');
    textEl.className = 'bubble-text';
    textEl.textContent = m.content;
    bubble.appendChild(textEl);

    const atts = (m.attachments || []).filter((a) => a && a.name);
    if (atts.length) {
      const attWrap = document.createElement('div');
      attWrap.className = 'bubble-attachments';
      for (const a of atts) {
        if (a.type === 'image' && typeof a.dataUrl === 'string') {
          const img = document.createElement('img');
          img.className = 'bubble-img';
          img.src = a.dataUrl;
          img.alt = a.name;
          img.title = a.name;
          img.loading = 'lazy';
          attWrap.appendChild(img);
        } else {
          const chip = document.createElement('span');
          chip.className = 'bubble-file';
          chip.textContent = '\u{1F4CE} ' + a.name;
          attWrap.appendChild(chip);
        }
      }
      bubble.appendChild(attWrap);
    }

    const userActions = document.createElement('div');
    userActions.className = 'bubble-actions';
    userActions.innerHTML = '<button type="button" class="msga-copy" title="Copy message"><svg class="ic"><use href="#i-copy"/></svg></button>';
    const userCopy = userActions.querySelector('.msga-copy');
    userCopy.addEventListener('click', () => {
      copyText(m.content || '', () => flashIcon(userCopy, '#i-check'));
    });

    el.appendChild(bubble);
    el.appendChild(userActions);
    if (!animate) el.style.animation = 'none';
    wrap.appendChild(el);
    return el;
  }

  // ==================================================================
  // Composer + sending
  // ==================================================================
  const composer = $('#composer');
  composer.addEventListener('input', () => {
    composer.style.height = 'auto';
    composer.style.height = Math.min(composer.scrollHeight, 200) + 'px';
    // Editing a recalled prompt ends the recall, so the next ArrowUp starts from
    // the newest entry again instead of jumping to a stale position.
    state.promptHistoryIdx = -1;
  });
  composer.addEventListener('keydown', (e) => {
    // Up/Down arrows walk back through the prompts already sent. The guard has
    // to accept a non-empty composer once a recall is in progress, or the first
    // ArrowUp makes every later one a no-op and only the newest entry is ever
    // reachable.
    if (e.key === 'ArrowUp' && !e.shiftKey && (composer.value === '' || state.promptHistoryIdx >= 0)) {
      e.preventDefault();
      if (state.promptHistory.length === 0) return;
      state.promptHistoryIdx = Math.min(state.promptHistoryIdx + 1, state.promptHistory.length - 1);
      composer.value = state.promptHistory[state.promptHistoryIdx] || '';
      composer.style.height = 'auto';
      composer.style.height = Math.min(composer.scrollHeight, 200) + 'px';
      return;
    }
    if (e.key === 'ArrowDown' && !e.shiftKey && state.promptHistoryIdx >= 0) {
      e.preventDefault();
      state.promptHistoryIdx--;
      composer.value = state.promptHistoryIdx >= 0 ? (state.promptHistory[state.promptHistoryIdx] || '') : '';
      composer.style.height = 'auto';
      composer.style.height = Math.min(composer.scrollHeight, 200) + 'px';
      return;
    }
    if (e.key === 'Enter' && !e.shiftKey) {
      // Enter that COMMITS an IME composition is not a send. A CJK user pressing
      // Enter to accept a candidate fired the message early, mid-word.
      if (e.isComposing || e.keyCode === 229) return;
      e.preventDefault();
      sendMessage();
    }
    if (e.key === 'Enter' && e.ctrlKey) {
      if (e.isComposing || e.keyCode === 229) return;
      e.preventDefault();
      sendMessage();
    }
  });
  $('#sendBtn').addEventListener('click', (e) => {
    e.preventDefault();
    sendMessage();
  });
  $('#stopBtn').addEventListener('click', async () => {
    if (!state.streaming) return; // guard: only if actually streaming
    const current = activeStream;
    if (!current) { setStreaming(false); return; }
    // No "unlock the UI anyway" timer: a tool call in flight is not abortable
    // (run_script alone may take 25s), so a timer would hand the composer back
    // while the turn was still live and then let the old stream tear down the
    // state of whichever stream the user started next. The turn's own
    // message_end is what releases the UI.
    if (current.chatId) {
      try { await api(`/api/chat/${current.chatId}/stop`, 'POST'); } catch { /* non-fatal */ }
    }
    toast('Stopping…', 'info', 2000);
  });

  /**
   * The receipts that are live in the DOM right now.
   *
   * Queried rather than tracked: a receipt is created lazily when the first tool
   * row appears and may be replaced as the turn grows, so holding a reference
   * would show a stale number after any re-render.
   */
  function liveSummaries() {
    return Array.from(document.querySelectorAll('#messages .turn-summary'));
  }

  /**
   * Writes the turn's elapsed time onto every live receipt.
   *
   * The stream clock calls this once a second, which is what makes a long step
   * visibly still running. Called with `null` when the turn ends, which pins the
   * final value and freezes it.
   *
   * @param {number|null} ms - elapsed milliseconds, or null to finish.
   */
  function applySummaryElapsed(ms) {
    const text = ms == null ? '' : (ms >= 1000 ? AgentRows.formatMs(ms) : '');
    for (const el of liveSummaries()) {
      const slot = el.querySelector('.ts-elapsed');
      if (!slot) continue;
      if (ms == null) {
        // Turn over: whatever is showing becomes the final, static duration.
        slot.classList.remove('on');
        continue;
      }
      slot.textContent = text;
      slot.classList.toggle('on', Boolean(text));
    }
  }

  // A live elapsed-time readout in the composer while a reply streams. Without
  // it a long tool-heavy turn looks frozen; "working" alone tells the user
  // nothing about whether anything is still happening.
  let streamClock = null;
  // Called on every clock tick and once when the turn ends, so a live readout
  // (the receipt's elapsed time) can stay in step with the composer hint without
  // opening a second interval.
  let streamClockListeners = [];
  function onStreamTick(fn) { streamClockListeners.push(fn); }
  function emitStreamTick(ms) {
    for (const fn of streamClockListeners) {
      try { fn(ms); } catch { /* one listener must not stop the clock */ }
    }
  }
  function startStreamClock() {
    stopStreamClock();
    const startedAt = Date.now();
    const hint = $('#streamHint');
    const tick = () => {
      const ms = Date.now() - startedAt;
      if (hint) {
        const s = Math.floor(ms / 1000);
        hint.textContent = s < 3 ? 'working…' : `working · ${s}s`;
      }
      emitStreamTick(ms);
    };
    tick();
    streamClock = setInterval(tick, 1000);
  }
  function stopStreamClock() {
    if (streamClock) { clearInterval(streamClock); streamClock = null; }
    const hint = $('#streamHint');
    if (hint) hint.textContent = 'working…';
    emitStreamTick(null);
  }

  // The receipt's elapsed time rides the same clock as the composer hint, so the
  // two can never disagree and there is only one interval to clear.
  onStreamTick(applySummaryElapsed);

  function setStreaming(on) {
    state.streaming = on;
    if (!on) stopStreamClock();
    $('#sendBtn').classList.toggle('hidden', on);
    $('#stopBtn').classList.toggle('hidden', !on);
    $('#streamHint').classList.toggle('hidden', !on);
    composer.disabled = false;
  }

  const chatScroll = $('#chatScroll');
  function nearBottom() {
    return chatScroll.scrollHeight - chatScroll.scrollTop - chatScroll.clientHeight < 140;
  }
  function scrollToBottom(force) {
    if (force || nearBottom()) chatScroll.scrollTop = chatScroll.scrollHeight;
  }

  // ==================================================================
  // Attachments — files + images the model can read (vision / code)
  // ==================================================================
  let attachments = []; // { id, name, mime, type:'image'|'file', dataUrl?, text? }
  const IMAGE_MIME = /^image\/(png|jpe?g|gif|webp)$/i;
  const TEXT_EXT = /\.(py|txt|js|mjs|cjs|jsx|ts|tsx|css|scss|less|html|htm|json|md|markdown|yml|yaml|xml|csv|tsv|sh|bash|sql|toml|ini|cfg|conf|log|svg|vue|svelte|rb|go|rs|java|c|cpp|h|hpp|php|swift|kt)$/i;
  const MAX_TEXT_BYTES = 200000;

  const readAsDataURL = (file) => new Promise((res, rej) => { const r = new FileReader(); r.onload = () => res(r.result); r.onerror = rej; r.readAsDataURL(file); });
  const readAsText = (file) => new Promise((res, rej) => { const r = new FileReader(); r.onload = () => res(r.result); r.onerror = rej; r.readAsText(file); });
  const attId = () => Math.random().toString(36).slice(2, 10) + Date.now().toString(36);

  function renderAttachRow() {
    const row = $('#attachRow');
    if (!row) return;
    row.innerHTML = '';
    row.classList.toggle('hidden', !attachments.length);
    for (const a of attachments) {
      const chip = document.createElement('div');
      chip.className = 'attach-chip';
      const icon = a.type === 'image' ? 'i-eye' : 'i-file';
      chip.innerHTML = `<svg class="ic"><use href="#${icon}"/></svg><span class="ac-name"></span><button class="ac-x" title="Remove"><svg class="ic"><use href="#i-close"/></svg></button>`;
      chip.querySelector('.ac-name').textContent = a.name;
      chip.querySelector('.ac-x').addEventListener('click', () => {
        attachments = attachments.filter((x) => x.id !== a.id);
        renderAttachRow();
      });
      row.appendChild(chip);
    }
  }

  $('#attachBtn').addEventListener('click', () => $('#fileInput').click());
  $('#fileInput').addEventListener('change', async () => {
    const input = $('#fileInput');
    const files = Array.from(input.files || []);
    input.value = '';
    for (const f of files) {
      if (attachments.length >= 8) { toast('Up to 8 attachments per message.', 'error'); break; }
      if (f.size > 8 * 1024 * 1024) { toast(`${f.name} is too large (max 8 MB).`, 'error'); continue; }
      try {
        if (IMAGE_MIME.test(f.type)) {
          const dataUrl = await readAsDataURL(f);
          attachments.push({ id: attId(), name: f.name, mime: f.type, type: 'image', dataUrl });
        } else if (TEXT_EXT.test(f.name) || f.type.startsWith('text/')) {
          const text = await readAsText(f);
          if (text) attachments.push({ id: attId(), name: f.name, mime: f.type || 'text/plain', type: 'file', text: text.slice(0, MAX_TEXT_BYTES) });
        } else {
          toast(`${f.name}: unsupported type (use an image or a code/text file).`, 'error');
        }
      } catch (err) {
        // A failed FileReader read used to become an unhandled rejection with no
        // feedback at all, and the selection had already been cleared.
        toast(`Could not read ${f.name}: ${err && err.message ? err.message : 'unknown error'}`, 'error');
      }
    }
    renderAttachRow();
  });

  async function sendMessage(presetText) {
    if (state.streaming) return;
    const text = (typeof presetText === 'string' ? presetText : composer.value).trim();
    const pending = (state.attachments || []).length;
    // An attachment with no text is a complete request: the file IS the message.
    // Bailing here made Send and Enter look dead — nothing posted, nothing said,
    // and the attachment chip stayed in the composer.
    if (!text && !pending) return;
    const provider = activeProvider();
    if (!provider) { toast('Add a provider first (Providers → Add provider).', 'error'); return; }
    if (provider.type !== 'demo' && provider.type !== 'llamacoder' && !provider.hasKey && !/localhost|127\.0\.0\.1/.test(provider.baseUrl || '')) {
      toast(`Add an API key to ${provider.name} before chatting.`, 'error');
      openProviderModal(provider.id);
      return;
    }

    composer.value = '';
    composer.style.height = 'auto';
    $('#welcome').classList.add('hidden');
    // Feature 5: save to prompt history
    if (typeof presetText !== 'string') {
      state.promptHistory.unshift(text);
      if (state.promptHistory.length > 50) state.promptHistory.length = 50;
    }
    state.promptHistoryIdx = -1;

    const sendAttachments = attachments.map((a) => ({ name: a.name, mime: a.mime, type: a.type, dataUrl: a.dataUrl, text: a.text }));
    const userMsg = { role: 'user', content: text, ts: Date.now(), attachments: sendAttachments };
    appendMessage(userMsg);
    state.currentMessages.push(userMsg);

    // Images only reach vision-capable adapters (OpenAI/Anthropic/Gemini). The
    // free Hama AI engine and the demo are text-only, so warn instead of letting
    // the user wonder why the model "can't see" the picture.
    if (sendAttachments.some((a) => a.type === 'image') && !providerSupportsVision(provider)) {
      toast(`${provider.name} is not vision-capable, so it may not see the image. For images, add OpenAI, Gemini, Anthropic or OpenRouter in Providers.`, 'warning', 7000);
    }

    attachments = [];
    renderAttachRow();

    let liveEl;
    let toolZone, mdEl;
    let buffer = '';
    let dotsRemoved = false;
    let rafPending = false;

    // Trajectory: a flat, chronological list of the agent's actions (DSH-style).
    // Each tool call appends one row; thinking streams into its own "Think" row
    // where it happened, so the reasoning is visible in sequence.
    const toolNodesById = new Map();
    // The runs this turn has produced so far, in order, so the receipt under the
    // trajectory can be kept up to date while the turn is still going.
    const liveRuns = [];
    // One card per reviewer, keyed by the reviewer's index in the team. A
    // reviewer's prose and its tool rows are held here rather than in `buffer`
    // and `liveRuns`, so nothing the team does is mistaken for the lead's answer.
    const crewNodes = new Map();

    /**
     * Rings up the elapsed time on a running tool row.
     *
     * The server drives this: it emits `tool_progress` with the true elapsed time
     * every few seconds while a tool is in flight, and this only writes that
     * number onto the row. Deriving it locally from a client-side clock would
     * drift from what the server actually measured — and a stalled connection
     * would then keep counting up convincingly, which is worse than showing the
     * last true value.
     *
     * Declared HERE, inside the stream scope, because it reads `toolNodesById`.
     * A copy next to toolCard() reads a `const` declared below it — the temporal
     * dead zone — and threw "toolNodesById is not defined" on the first
     * progress event, which took the whole SSE handler down with it and left the
     * turn stuck on "running".
     */
    function setElapsed(el, ms) {
      const slot = el && el.querySelector && el.querySelector('.tr-elapsed');
      if (!slot) return;
      const text = ms >= 1000 ? AgentRows.formatMs(ms) : '';
      slot.textContent = text;
      slot.classList.toggle('on', Boolean(text));
    }

    /**
     * Applies one `tool_progress` event to the card it belongs to.
     *
     * Re-rendering the whole card here would restart its entry animation several
     * times a minute, so the update is deliberately just the number.
     */
    function applyToolProgress(ev) {
      const entry = toolNodesById.get(ev.id);
      if (!entry || !entry.card) return;
      if (entry.run) entry.run.elapsedMs = ev.elapsedMs;
      setElapsed(entry.card, ev.elapsedMs);
    }
    let thinkNode = null;
    let thinkText = '';
    let thinkStartedAt = null;

    const endThink = () => {
      if (!thinkNode) return;
      thinkNode.classList.remove('running');
      thinkNode.classList.add('completed');
      const t = thinkNode.querySelector('.sr-time');
      if (t && thinkStartedAt) t.textContent = AgentRows.formatMs(Date.now() - thinkStartedAt);
      const st = thinkNode.querySelector('.sr-status');
      if (st) { st.classList.add('done'); st.innerHTML = '<svg class="ic"><use href="#i-check"/></svg>'; }
      thinkNode = null;
    };

    const appendThink = (delta) => {
      if (!thinkNode) {
        thinkStartedAt = Date.now();
        thinkText = '';
        thinkNode = thinkingRow('', { pending: true });
        toolZone.appendChild(thinkNode);
      }
      thinkText += delta;
      const pre = thinkNode.querySelector('.tr-pre');
      if (pre) pre.textContent = thinkText;
      const sum = thinkNode.querySelector('.sr-summary');
      if (sum) sum.textContent = thinkText.replace(/\s+/g, ' ').trim().slice(0, 90) || 'thinking…';
    };

    /**
     * Closes every reviewer card the turn opened.
     *
     * A card left "running" after `message_end` is a spinner that never stops —
     * the turn is over and nothing else will ever update it. The step count is
     * filled in here too, so a reviewer card reads like the receipt it sits
     * above rather than an anonymous "Team review".
     */
    const finishCrewCards = () => {
      for (const entry of crewNodes.values()) {
        const card = entry.card;
        if (!card || card.dataset.done) continue;
        card.dataset.done = '1';
        card.classList.remove('running');
        card.classList.add('completed');
        const status = card.querySelector('.tc-status');
        if (status) {
          status.classList.add('done');
          status.innerHTML = '<svg class="ic"><use href="#i-check"/></svg>';
        }
        const count = card.querySelector('.tc-count');
        const n = entry.byId ? entry.byId.size : 0;
        if (count) count.textContent = n ? (n === 1 ? '1 step' : n + ' steps') : '';
      }
    };

    liveEl = buildAssistantShell();
    liveEl.classList.add('streaming');
    fillAssistantMeta(liveEl, { ts: Date.now(), model: provider.model, providerId: provider.id });
    wireAssistantActions(liveEl, null, () => buffer);
    mdEl = liveEl.querySelector('.md');
    mdEl.innerHTML = '<span class="stream-dots"><span></span><span></span><span></span></span>';
    $('#messages').appendChild(liveEl);
    toolZone = liveEl.querySelector('.tool-zone');

    scrollToBottom(true);
    setStreaming(true);
    startStreamClock();

    const renderBuffer = () => {
      rafPending = false;
      if (!buffer) return;
      if (!dotsRemoved) { mdEl.innerHTML = ''; dotsRemoved = true; }
      lastRenderAt = performance.now();
      mdEl.innerHTML = Markdown.render(buffer) + '<span class="stream-caret"></span>';
      scrollToBottom(false);
    };
    /**
     * Re-renders the streaming reply, at most ~12 times a second.
     *
     * `Markdown.render` re-tokenises and re-highlights the WHOLE reply on every
     * call, and this used to run once per animation frame — so a long, code-heavy
     * answer was re-parsed sixty times a second and the page paid for it in
     * stutter and a hot CPU. Text arrives in chunks far slower than that, so
     * rate-limiting costs nothing visible. The trailing rAF guarantees the last
     * chunk is always painted.
     */
    let lastRenderAt = 0;
    const RENDER_MIN_MS = 80;
    const scheduleRender = () => {
      if (rafPending) return;
      rafPending = true;
      const wait = Math.max(0, RENDER_MIN_MS - (performance.now() - lastRenderAt));
      if (wait === 0) requestAnimationFrame(renderBuffer);
      else setTimeout(() => requestAnimationFrame(renderBuffer), wait);
    };

    let finished = false;
    // This turn's generation. Every event checks it before touching shared
    // state, so a reply that arrives after the user switched conversation is
    // discarded instead of being spliced into the wrong transcript.
    const myGen = ++state.streamGen;
    const stale = () => myGen !== state.streamGen;
    const controller = new AbortController();
    activeStream = { chatId: null, gen: myGen, controller };

    let reader = null;
    const turnStartedAt = Date.now();
    try {
      const res = await fetch('/api/chat', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        signal: controller.signal,
        body: JSON.stringify({
          chatId: state.currentChatId,
          providerId: provider.id,
          model: provider.model,
          message: text,
          attachments: sendAttachments,
          tools: { web: state.tools.web, files: state.tools.files, code: state.tools.code }
        })
      });
      // An expired session must not look like a broken model call.
      if (res.status === 401) {
        location.href = '/login';
        throw new Error('Your session expired — signing you in again.');
      }
      if (!res.ok || !res.body) {
        const j = await res.json().catch(() => ({}));
        throw new Error(j.error || `HTTP ${res.status}`);
      }

      reader = res.body.getReader();
      const decoder = new TextDecoder();
      let sseBuf = '';

      // One frame is `data: <json>` followed by a blank line. CRLF is normalised
      // and a multi-line data field is joined, so a proxy that rewrites line
      // endings or wraps the payload cannot silently drop every event.
      const dispatch = (rawEvt) => {
        const data = rawEvt.split('\n')
          .filter((l) => l.startsWith('data:'))
          .map((l) => l.slice(5).replace(/^ /, ''))
          .join('\n');
        if (!data) return;
        let ev;
        try { ev = JSON.parse(data); }
        catch (err) { console.warn('Ignoring an unparseable SSE frame', rawEvt, err); return; }
        handleSSE(ev);
      };

      while (!finished) {
        const { done, value } = await reader.read();
        if (done) break;
        sseBuf += decoder.decode(value, { stream: true }).replace(/\r\n/g, '\n');
        let idx;
        while ((idx = sseBuf.indexOf('\n\n')) !== -1) {
          dispatch(sseBuf.slice(0, idx));
          sseBuf = sseBuf.slice(idx + 2);
        }
      }
      // Flush whatever the decoder and the frame buffer were still holding: a
      // final frame without its blank-line terminator used to be discarded, and
      // message_end is exactly that frame.
      sseBuf += decoder.decode().replace(/\r\n/g, '\n');
      if (sseBuf.trim()) dispatch(sseBuf);

      if (!finished && !stale()) {
        // The stream ended with no terminal event. The server may have died
        // mid-turn, or the socket was cut on the way back — and those are not the
        // same thing at all. Ask the server what it saved before reporting a
        // failure: a reply that IS on disk must never be shown as lost.
        const recovered = await recoverTurn();
        if (!recovered) {
          showError(liveEl, 'The connection to the agent was interrupted before the reply finished, and this turn was not saved. Send your message again to get a fresh answer.');
        }
      }
    } catch (e) {
      // An aborted fetch is the user's own doing (Stop, or switching chat) — not
      // a failure worth an error card.
      if (e && e.name !== 'AbortError' && !stale()) {
        const recovered = await recoverTurn();
        if (!recovered) {
          // Name the transport failure as one. "Error in input stream" is the
          // browser's own body-stream error and says nothing about the model, the
          // prompt or the key — it read as a model failure and sent the user
          // looking in the wrong place.
          showError(liveEl, 'The connection to the server dropped mid-reply (' + (e.message || e) + '), and this turn was not saved. Check that the server is still running, then send it again.');
        }
      }
    } finally {
      if (reader) { try { await reader.cancel(); } catch { /* already closed */ } }
      if (activeStream && activeStream.gen === myGen) activeStream = null;
      if (stale()) { try { liveEl.remove(); } catch { /* already gone */ } }
    }

    function handleSSE(ev) {
      // The user moved to another conversation (or pressed New chat) while this
      // event was in flight: it belongs to a view that no longer exists.
      if (stale()) return;
      switch (ev.type) {
        case 'started':
          state.streamChatId = ev.chatId;
          if (activeStream && activeStream.gen === myGen) activeStream.chatId = ev.chatId;
          if (!state.currentChatId) state.currentChatId = ev.chatId;
          if (ev.title) $('#topTitle').textContent = ev.title;
          break;

        case 'status': {
          const body = liveEl.querySelector('.msg-body');
          let st = liveEl.querySelector('.status-line');
          if (!st) {
            st = document.createElement('div');
            st.className = 'status-line';
            st.innerHTML = '<svg class="ic"><use href="#i-bolt"/></svg><span></span>';
            body.insertBefore(st, mdEl);
          }
          st.querySelector('span').textContent = ev.text || '';
          scrollToBottom(false);
          break;
        }

        case 'crew': {
          // Every reviewer gets its own card, named with the model that is
          // running. Its tokens and tool rows land inside it (see the crew_*
          // events below) instead of in the answer, which is where they used to
          // go — the reviewer's prose, its tool echoes and its command output
          // all arrived as if the lead had written them.
          const index = Number(ev.index) || (crewNodes.size + 1);
          const card = teamCardShell(index, { total: ev.total, model: ev.provider && ev.provider.model, provider: ev.provider && ev.provider.name });
          card.classList.remove('completed');
          card.classList.add('running', 'open');
          const status = card.querySelector('.tc-status');
          status.innerHTML = '<span class="tr-spin"></span>';
          toolZone.appendChild(card);
          crewNodes.set(index, {
            card,
            mdEl: card.querySelector('.tc-md'),
            runsEl: card.querySelector('.tc-runs'),
            byId: new Map(),
            text: '',
            startedAt: Date.now()
          });
          scrollToBottom(false);
          break;
        }

        // A reviewer's streamed prose. Kept out of `buffer` on purpose: this is
        // the team's working notes, not the answer the lead is composing.
        case 'crew_token':
        case 'crew_separator': {
          const entry = crewNodes.get(Number(ev.crewIndex));
          if (!entry) break;
          entry.text += ev.text || (ev.type === 'crew_separator' ? '\n\n' : '');
          // Same reason as the lead's stream: re-parsing the whole reviewer
          // answer on every delta is what a long review cannot afford.
          if (!entry.renderTimer) {
            entry.renderTimer = setTimeout(() => {
              entry.renderTimer = null;
              entry.mdEl.innerHTML = Markdown.render(entry.text);
            }, 120);
          }
          scrollToBottom(false);
          break;
        }

        // A reviewer's chain-of-thought is not shown at all: it is not the
        // answer, and mixing it into the lead's Think row made one model look
        // like it was thinking the other's thoughts.
        case 'crew_thinking':
          break;

        case 'crew_tool_start': {
          const entry = crewNodes.get(Number(ev.crewIndex));
          if (!entry) break;
          const run = { id: ev.id, name: ev.name, args: ev.args, pending: true, startedAt: ev.startedAt, step: ev.step };
          const runCard = toolCard(run);
          entry.byId.set(ev.id, { run, card: runCard });
          entry.runsEl.appendChild(runCard);
          // Registered in the SAME progress map as the lead's calls: a reviewer's
          // long command ticks exactly like anyone else's, and tool ids are
          // unique across the turn.
          toolNodesById.set(ev.id, { run, card: runCard });
          scrollToBottom(false);
          break;
        }

        case 'crew_tool_end': {
          const entry = crewNodes.get(Number(ev.crewIndex));
          if (!entry) break;
          const prev = entry.byId.get(ev.id);
          const run = {
            id: ev.id, name: ev.name,
            args: (prev && prev.run && prev.run.args) || {},
            ok: ev.ok, result: ev.result, meta: ev.meta,
            startedAt: (prev && prev.run && prev.run.startedAt) || ev.startedAt,
            ms: ev.ms, step: (prev && prev.run && prev.run.step) || ev.step,
            crewIndex: ev.crewIndex
          };
          const runCard = toolCard(run);
          if (prev && prev.card) prev.card.replaceWith(runCard); else entry.runsEl.appendChild(runCard);
          entry.byId.set(ev.id, { run, card: runCard });
          toolNodesById.set(ev.id, { run, card: runCard });
          break;
        }

        case 'crew_tool_progress':
          applyToolProgress(ev);
          break;

        case 'thinking': {
          appendThink(ev.text || '');
          scrollToBottom(false);
          break;
        }

        // The loop streamed this text and then decided not to keep it: a
        // suppressed repeat of narration the turn already produced, an echo of a
        // tool result, or an authoritative re-render of a text-protocol reply.
        // Applying the same edit to the live buffer is what stops the reply from
        // visibly shrinking when `message_end` swaps in the saved version — the
        // duplicates were on screen for the whole turn and then vanished.
        case 'retract': {
          const gone = typeof ev.text === 'string' ? ev.text : '';
          if (gone) {
            if (buffer.endsWith(gone)) buffer = buffer.slice(0, -gone.length);
            else {
              // A notice landed after it, so the tail moved: drop the last
              // occurrence instead of leaving the duplicate behind.
              const at = buffer.lastIndexOf(gone);
              if (at >= 0) buffer = buffer.slice(0, at) + buffer.slice(at + gone.length);
            }
          }
          if (typeof ev.replace === 'string') buffer += ev.replace;
          scheduleRender();
          break;
        }

        case 'token':
        case 'separator':
          liveEl.querySelector('.status-line')?.remove();
          buffer += ev.text || (ev.type === 'separator' ? '\n\n' : '');
          scheduleRender();
          break;

        case 'tool_start': {
          // The Think row is deliberately NOT closed here.
          //
          // Closing it at every tool call started a NEW row for the next burst of
          // reasoning, so a seven-step turn showed the model "thinking" seven
          // times, interleaved with the steps — while the same turn, reloaded,
          // showed exactly one Think row at the top. One row for the whole turn
          // is what both the saved transcript and the model's actual behaviour
          // describe; the reasoning simply keeps appending to it.
          const run = { id: ev.id, name: ev.name, args: ev.args, pending: true, startedAt: ev.startedAt, step: ev.step };
          const card = toolCard(run);
          toolNodesById.set(ev.id, { run, card });
          toolZone.appendChild(card);
          liveRuns.push(run);
          refreshTurnSummary(toolZone, liveRuns);
          scrollToBottom(false);
          if (/file|directory/.test(ev.name)) fpLoad(state.fpPath);
          break;
        }

        case 'tool_end': {
          const prev = toolNodesById.get(ev.id);
          const run = {
            id: ev.id, name: ev.name,
            args: (prev && prev.run && prev.run.args) || {},
            ok: ev.ok, result: ev.result, meta: ev.meta,
            startedAt: (prev && prev.run && prev.run.startedAt) || ev.startedAt,
            ms: ev.ms, step: (prev && prev.run && prev.run.step) || ev.step
          };
          const card = toolCard(run);
          if (prev && prev.card) prev.card.replaceWith(card); else toolZone.appendChild(card);
          toolNodesById.set(ev.id, { run, card });
          const at = liveRuns.findIndex((r) => r.id === ev.id);
          if (at >= 0) liveRuns[at] = run; else liveRuns.push(run);
          refreshTurnSummary(toolZone, liveRuns);
          if (/file|directory/.test(ev.name)) fpLoad(state.fpPath);
          break;
        }

        // The server's "this tool is still running" tick. It updates the row's
        // elapsed time in place rather than rebuilding the card, so a long
        // command shows progress without re-animating the step every few seconds.
        case 'tool_progress': {
          applyToolProgress(ev);
          break;
        }

        case 'aborted':
          endThink();
          finishCrewCards();
          if (buffer) {
            buffer += '\n\n*(stopped by user)*';
            scheduleRender();
          }
          break;

        case 'error':
          endThink();
          finishCrewCards();
          showError(liveEl, ev.message);
          break;

        case 'message_end': {
          finished = true;
          endThink();
          finishCrewCards();
          renderBuffer();
          setStreaming(false);
          state.streamChatId = null;
          if (ev.message) {
            state.currentMessages.push(ev.message);
            const canonical = appendMessage(ev.message, { animate: false });
            // A turn can fail *after* narration text was streamed: the server
            // persists the partial answer, so the canonical element replaces the
            // live one. Carry the error card across, or the failure disappears
            // and a truncated answer reads as a complete one.
            const errCard = liveEl.querySelector('.error-card');
            if (errCard) canonical.querySelector('.msg-body').appendChild(errCard);
            liveEl.replaceWith(canonical);
          } else {
            // Nothing was persisted — a Stop before the first token, or a model
            // that genuinely returned nothing. Say which, instead of leaving the
            // user staring at an empty bubble with no explanation.
            liveEl.querySelectorAll('.stream-caret').forEach((n) => n.remove());
            if (!liveEl.querySelector('.error-card') && !liveEl.querySelector('.msg-notice')) {
              mdEl.innerHTML = '';
              const notice = document.createElement('div');
              notice.className = 'msg-notice';
              notice.textContent = ev.aborted
                ? 'Stopped before any reply arrived.'
                : 'The model returned an empty response. Try again, or switch to a different model.';
              liveEl.querySelector('.msg-body').appendChild(notice);
            }
          }
          if (ev.chat) {
            const meta = ev.chat;
            const i = state.chats.findIndex(c => c.id === meta.id);
            if (i >= 0) state.chats[i] = meta; else state.chats.unshift(meta);
            state.chats.sort((a, b) => b.updatedAt - a.updatedAt);
            renderChatList($('#chatSearch').value);
            $('#topTitle').textContent = meta.title;
          } else if (ev.saved === false) {
            // The turn happened but could not be written to disk. The error card
            // already says why; claiming the conversation was deleted would send
            // the user looking for a chat that is still right there.
          } else {
            // The chat was deleted while this turn was streaming. Do not put it
            // back in the sidebar — just say the reply was not kept.
            toast('That conversation was deleted, so this reply was not saved.', 'warning', 5000);
          }
          fpLoad(state.fpPath);
          scrollToBottom(false);
          break;
        }

        default:
          // A server newer than this page can send an event this build does not
          // know. Silently ignoring it is how a feature "just does not work"
          // after a backend edit — the turn still ends, so nothing looks wrong.
          // The warning is gated on the tab actually streaming, which keeps it
          // out of the console for unrelated events.
          if (state.streamChatId) {
            console.warn('[HAMA] unhandled stream event:', ev.type, ev);
          }
          break;
      }
    }

    /**
     * After a dropped stream, asks the server what it actually saved.
     *
     * A dead SSE connection means the browser stopped HEARING the turn — it does
     * not mean the turn failed. The turn runs to completion on the server,
     * finalize commits it, and only the response was cut. Reporting that as
     * "Request failed" next to a reply that is safely on disk is the single most
     * misleading thing this screen did.
     *
     * Only an assistant message that belongs to THIS turn counts (its timestamp
     * must be at or after the moment the turn was sent), so the previous turn's
     * answer can never be re-rendered as if it were new.
     *
     * @returns {Promise<boolean>} true when a saved reply was recovered.
     */
    async function recoverTurn() {
      const chatId = state.currentChatId;
      if (!chatId) return false;
      let chat;
      try {
        // `/api/chats/:id` is the route that returns the MESSAGES; the list route
        // returns metadata only, so asking it would always find nothing and this
        // recovery would silently never fire.
        ({ chat } = await api(`/api/chats/${chatId}`));
      } catch { return false; }
      const msgs = (chat && chat.messages) || [];
      const last = msgs[msgs.length - 1];
      if (!last || last.role !== 'assistant') return false;
      if (!(Number(last.ts) >= turnStartedAt - 1000)) return false;
      if ((state.currentMessages || []).some((m) => m && m.id === last.id)) return false;

      state.currentMessages.push(last);
      const at = state.chats.findIndex((c) => c.id === chat.id);
      if (at >= 0) state.chats[at] = { ...state.chats[at], updatedAt: chat.updatedAt };

      // Rendered through the same path a reload uses, so what is on screen now is
      // exactly what the saved conversation will show next time it is opened.
      const canonical = appendMessage(last, { animate: false });
      liveEl.replaceWith(canonical);
      liveEl = canonical;

      const notice = document.createElement('div');
      notice.className = 'msg-notice';
      notice.textContent = 'The connection dropped while this reply was streaming — the server finished it and saved it, so nothing is lost.';
      canonical.querySelector('.msg-body').appendChild(notice);
      setStreaming(false);
      scrollToBottom(false);
      return true;
    }
  }

  function showError(liveEl, message) {
    renderErrorSafe(liveEl, message || 'Something went wrong');
    setStreaming(false);
  }
  function renderErrorSafe(liveEl, message) {
    if (!liveEl) return;
    const body = liveEl.querySelector('.msg-body') || liveEl;
    const card = document.createElement('div');
    card.className = 'error-card';
    card.innerHTML = `<svg class="ic"><use href="#i-close"/></svg><div><strong>Request failed.</strong><br><span class="err-text"></span><div class="err-hint"></div></div>`;
    card.querySelector('.err-text').textContent = message;
    const hintEl = card.querySelector('.err-hint');
    let hint = '';
    if (/429|rate limit/i.test(message)) {
      hint = 'HAMA already auto-retried a few times. This model has a tight rate limit on your plan — open Providers → Configure → Fetch and pick a model with higher limits (on Groq, llama-3.3-70b-versatile is a good choice), or try again shortly.';
    } else if (/404|does not exist|no access/i.test(message)) {
      hint = 'The model id looks wrong. Open Providers → Configure → Fetch and click a model from the list, then save.';
    } else if (/401|403|unauthorized|invalid api key|authentication/i.test(message)) {
      hint = 'Check the API key in Providers → Configure — it may be missing, expired, or lack permissions.';
    }
    hintEl.textContent = hint;
    if (!hint) hintEl.style.display = 'none';
    body.appendChild(card);
    // Both the waiting dots and the streaming caret have to go, or a caret keeps
    // blinking beside the error forever.
    liveEl.querySelectorAll('.stream-dots, .stream-caret').forEach((n) => n.remove());
    scrollToBottom(false);
  }

  // ==================================================================
  // Files panel
  // ==================================================================
  function fpSetOpen(on) {
    state.fpOpen = on;
    $('#filesPanel').classList.toggle('open', on);
    // On a phone the panel is a full-height overlay, so the scrim (tap anywhere
    // outside) is the affordance most users will reach for.
    $('#fpScrim').classList.toggle('show', on);
    localStorage.setItem('hama_fp', on ? '1' : '0');
    if (on) fpLoad(state.fpPath);
  }
  $('#filesToggle').addEventListener('click', () => fpSetOpen(!state.fpOpen));
  $('#fpClose').addEventListener('click', () => fpSetOpen(false));
  $('#fpScrim').addEventListener('click', () => fpSetOpen(false));
  $('#fpRefresh').addEventListener('click', () => fpLoad(state.fpPath));

  function fpIcon(name) {
    const ext = String(name || '').split('.').pop().toLowerCase();
    if (['tsx', 'jsx', 'ts', 'js', 'mjs', 'cjs'].includes(ext)) return 'i-code';
    if (['html', 'htm', 'svg'].includes(ext)) return 'i-globe';
    if (['css', 'scss'].includes(ext)) return 'i-pencil';
    if (ext === 'py') return 'i-terminal';
    if (['png', 'jpg', 'jpeg', 'gif', 'webp', 'ico'].includes(ext)) return 'i-eye';
    if (['json', 'yml', 'yaml'].includes(ext)) return 'i-report';
    if (['md', 'txt'].includes(ext)) return 'i-file';
    return 'i-file';
  }

  function fpTreeNode(node, depth) {
    const el = document.createElement('div');
    el.className = 'fp-node';
    const isDir = node.type === 'dir';
    const startOpen = isDir && depth === 0;
    el.innerHTML = `
      <div class="fp-row ${isDir ? 'dir' : 'file'}" style="padding-left:${10 + depth * 14}px">
        <span class="fp-tw">${isDir ? '<svg class="ic"><use href="#i-chevron"/></svg>' : ''}</span>
        <svg class="ic fp-fic"><use href="#${isDir ? 'i-folder' : fpIcon(node.name)}"/></svg>
        <span class="fi-name"></span>
        <span class="fi-size">${isDir ? '' : fmtBytes(node.size)}</span>
        <span class="fp-row-actions">
          <button class="fp-dl" title="${isDir ? 'Download folder (.zip)' : 'Download file'}"><svg class="ic"><use href="#i-download"/></svg></button>
        </span>
      </div>
      <div class="fp-children" style="display:${startOpen ? '' : 'none'}"></div>`;
    el.querySelector('.fi-name').textContent = node.name;
    const row = el.querySelector('.fp-row');
    const children = el.querySelector('.fp-children');
    row.classList.toggle('open', startOpen);

    el.querySelector('.fp-dl').addEventListener('click', (e) => {
      e.stopPropagation();
      const cid = state.currentChatId || '';
      const url = isDir
        ? `/api/files/zip?chatId=${encodeURIComponent(cid)}&path=${encodeURIComponent(node.path)}`
        : `/api/files/raw?chatId=${encodeURIComponent(cid)}&path=${encodeURIComponent(node.path)}&download=1`;
      const a = document.createElement('a');
      a.href = url;
      a.download = '';
      document.body.appendChild(a);
      a.click();
      a.remove();
    });

    if (isDir) {
      row.addEventListener('click', () => {
        const open = children.style.display !== 'none';
        children.style.display = open ? 'none' : '';
        row.classList.toggle('open', !open);
      });
      for (const c of node.children || []) children.appendChild(fpTreeNode(c, depth + 1));
    } else {
      row.addEventListener('click', () => {
        openFileViewer(node.path);
        // Auto-close files panel on mobile
        if (window.innerWidth <= 860) fpSetOpen(false);
      });
    }
    return el;
  }

  async function fpLoad(rel) {
    const list = $('#fpList');
    try {
      const chatId = state.currentChatId || '';
      const res = await api(`/api/files/tree?chatId=${encodeURIComponent(chatId)}`);
      renderCrumbs(res);
      list.innerHTML = '';
      if (!res.tree || !res.tree.length) {
        list.innerHTML = '<div class="fp-empty">This workspace is empty.<br>Ask the agent to create something!</div>';
        return;
      }
      for (const node of res.tree) list.appendChild(fpTreeNode(node, 0));
    } catch (e) {
      list.innerHTML = `<div class="fp-empty">${Markdown.escape(e.message)}</div>`;
    }
  }

  function renderCrumbs(res) {
    const crumbs = $('#fpCrumbs');
    crumbs.innerHTML = '';
    const hasTotals = res && typeof res.totalFiles === 'number';
    const label = hasTotals
      ? `${res.totalFiles} file${res.totalFiles === 1 ? '' : 's'} · ${fmtBytes(res.totalBytes || 0)}`
      : 'workspace';
    const span = document.createElement('span');
    span.className = 'fp-crumb-label';
    span.textContent = label;
    crumbs.appendChild(span);
  }

  let activePreviewTarget = null;
  let activeSandboxTab = 'web';
  let activeCodeFile = null;
  let workspaceFilesCache = [];

  async function refreshSandboxWorkspaceFiles(chatId) {
    try {
      if (!chatId) return [];
      const res = await api(`/api/files?chatId=${encodeURIComponent(chatId)}`);
      if (res && res.ok && Array.isArray(res.entries)) {
        workspaceFilesCache = res.entries.filter(e => e.type === 'file');
        return workspaceFilesCache;
      }
    } catch (e) {
      console.warn('Could not fetch workspace files for sandbox', e);
    }
    return [];
  }

  async function openAppPreview(target, initialTab = null, initialFile = null) {
    if (!target) return;
    activePreviewTarget = target;
    const cid = target.chatId || state.currentChatId || '';

    // Fetch live workspace files so all created files in this chat are immediately available
    const liveFiles = await refreshSandboxWorkspaceFiles(cid);

    // Merge discovered files with target.files
    const mergedFilesMap = new Map();
    (target.files || []).forEach(f => {
      const p = f.path || f;
      const n = f.name || p.split('/').pop();
      const ext = n.split('.').pop().toLowerCase();
      mergedFilesMap.set(p, { path: p, name: n, ext });
    });
    liveFiles.forEach(f => {
      const p = f.path;
      const n = f.name;
      const ext = n.split('.').pop().toLowerCase();
      if (!mergedFilesMap.has(p)) {
        mergedFilesMap.set(p, { path: p, name: n, ext, size: f.size });
      }
    });

    const allFiles = Array.from(mergedFilesMap.values());
    target.allFiles = allFiles;

    // Update code badge
    const codeBadge = $('#sbCodeBadge');
    if (codeBadge) codeBadge.textContent = allFiles.length;

    // Set Header titles
    $('#pmTitle').textContent = target.title || 'HAMA Sandbox';
    $('#pmSub').textContent = cid ? `workspace: ${cid.slice(0, 12)}` : 'in-memory sandbox';

    // Populate script selector for terminal
    const scriptSelect = $('#pmScriptSelect');
    if (scriptSelect) {
      scriptSelect.innerHTML = '';
      const scriptFiles = allFiles.filter(f => ['py', 'js'].includes(f.ext));
      if (scriptFiles.length === 0 && target.targetScript) {
        scriptFiles.push({ path: target.targetScript, name: target.targetScript.split('/').pop(), ext: target.targetScript.split('.').pop().toLowerCase() });
      }
      if (scriptFiles.length > 0) {
        for (const sf of scriptFiles) {
          const opt = document.createElement('option');
          opt.value = sf.path;
          opt.textContent = `${sf.ext === 'py' ? '🐍' : '⚡'} ${sf.path}`;
          scriptSelect.appendChild(opt);
        }
        if (target.targetScript && scriptFiles.some(f => f.path === target.targetScript)) {
          scriptSelect.value = target.targetScript;
        } else if (initialFile && scriptFiles.some(f => f.path === initialFile)) {
          scriptSelect.value = initialFile;
        }
      } else {
        const opt = document.createElement('option');
        opt.value = '';
        opt.textContent = '(No .py or .js scripts found)';
        scriptSelect.appendChild(opt);
      }
    }

    // Determine initial tab
    let selectedTab = initialTab;
    if (!selectedTab) {
      if (target.type === 'web' || allFiles.some(f => ['html', 'htm', 'tsx', 'jsx'].includes(f.ext)) || /<!doctype html|<html[\s>]/i.test(target.code || '')) {
        selectedTab = 'web';
      } else if (target.type === 'script' || allFiles.some(f => ['py', 'js'].includes(f.ext))) {
        selectedTab = 'terminal';
      } else if (target.type === 'doc' || allFiles.some(f => ['md'].includes(f.ext))) {
        selectedTab = 'markdown';
      } else {
        selectedTab = 'code';
      }
    }

    switchSandboxTab(selectedTab, initialFile);
    openModal('appPreviewModal');
  }

  function switchSandboxTab(tabName, targetFile = null) {
    activeSandboxTab = tabName;
    const target = activePreviewTarget || {};
    const cid = target.chatId || state.currentChatId || '';
    const allFiles = target.allFiles || target.files || [];

    // Update tab bar buttons
    document.querySelectorAll('.sb-tab-btn').forEach(btn => {
      btn.classList.toggle('active', btn.dataset.tab === tabName);
    });

    // Update tab view containers
    const views = {
      web: $('#pmViewWeb'),
      code: $('#pmViewCode'),
      terminal: $('#pmViewTerminal'),
      markdown: $('#pmViewMarkdown')
    };
    Object.entries(views).forEach(([k, v]) => {
      if (v) v.classList.toggle('hidden', k !== tabName);
    });

    // Header controls toggle
    const devControls = $('#pmDeviceControls');
    if (devControls) devControls.style.display = (tabName === 'web') ? 'flex' : 'none';

    const termControls = $('#pmTerminalControls');
    if (termControls) termControls.classList.toggle('hidden', tabName !== 'terminal');

    if (tabName === 'web') {
      setPreviewDevice('desktop');
      loadPreviewFrame(target, targetFile);
    } else if (tabName === 'code') {
      setupCodeExplorer(target, targetFile);
    } else if (tabName === 'terminal') {
      const statusBadge = $('#pmTermStatus');
      if (statusBadge && statusBadge.textContent !== 'RUNNING') {
        statusBadge.textContent = 'READY';
        statusBadge.className = 'term-status-badge idle';
      }
    } else if (tabName === 'markdown') {
      setupMarkdownView(target, targetFile);
    }
  }

  function loadPreviewFrame(target, preferred) {
    const iframe = $('#pmIframe');
    if (!iframe) return;
    const cid = target.chatId || state.currentChatId || '';
    const allFiles = target.allFiles || target.files || [];

    // `srcdoc` wins over `src` per the HTML spec, so a placeholder left behind by
    // an earlier preview kept shadowing every later one for the rest of the
    // session. Exactly one of the two attributes may be set at a time.
    iframe.removeAttribute('srcdoc');
    iframe.removeAttribute('src');

    // Prefer the file the user actually selected over "the first .html we found".
    const want = preferred || target.primaryFile || target.filePath;
    const wantedHtml = want && /\.html?$/i.test(want) && allFiles.some(f => (f.path || f) === want);
    const htmlFile = wantedHtml ? want : allFiles.find(f => ['html', 'htm'].includes(f.ext || ''))?.path;
    const hasReactFiles = allFiles.some(f => ['tsx', 'jsx'].includes(f.ext || '') || /App\.(tsx|jsx|js|ts)$/i.test(f.name || ''));

    if (cid && hasReactFiles && !wantedHtml) {
      // React & TSX sandbox runner! Prefer the bundler over a raw index.html,
      // because a Vite-style index.html only references /src/main.tsx (served as
      // text/plain, which the browser refuses) and can never run directly.
      iframe.src = `/api/workspace/${encodeURIComponent(cid)}/__react_preview__?t=${Date.now()}`;
    } else if (cid && htmlFile) {
      // Static multi-file web app — use the workspace static route so relative
      // assets (CSS, JS, images) resolve natively.
      iframe.src = `/api/workspace/${encodeURIComponent(cid)}/${encodeURIComponent(htmlFile)}?t=${Date.now()}`;
    } else if (target.code && /<!doctype html|<html/i.test(target.code)) {
      iframe.srcdoc = target.code;
    } else if (cid && want && /\.(html|htm|svg)$/i.test(want)) {
      iframe.src = `/api/workspace/${encodeURIComponent(cid)}/${encodeURIComponent(want)}?t=${Date.now()}`;
    } else {
      iframe.srcdoc = `<!DOCTYPE html><html><body style="font-family:-apple-system,sans-serif;display:flex;align-items:center;justify-content:center;height:90vh;color:#94a3b8;text-align:center;background:#090a0f;"><div><h3 style="color:#f1f5f9;margin-bottom:8px;font-size:16px;">No HTML or React App Entry</h3><p style="font-size:13px;color:#64748b;max-width:380px;line-height:1.6;">This workspace contains script or document files. Check the <b style="color:#38bdf8">Code Files</b> tab to inspect code or the <b style="color:#10b981">Terminal</b> tab to run scripts.</p></div></body></html>`;
    }
  }

  async function setupCodeExplorer(target, fileToSelect = null) {
    const pillsContainer = $('#sbCodeFilePills');
    const contentEl = $('#sbCodeContent');
    const metaEl = $('#sbCodeMeta');
    if (!pillsContainer || !contentEl) return;

    pillsContainer.innerHTML = '';
    const allFiles = target.allFiles || target.files || [];

    if (allFiles.length === 0 && target.code) {
      contentEl.textContent = target.code;
      if (metaEl) metaEl.textContent = 'in-memory code';
      return;
    }

    let activePillFile = fileToSelect || activeCodeFile || (allFiles[0] ? allFiles[0].path : null);
    if (!allFiles.some(f => f.path === activePillFile) && allFiles.length > 0) {
      activePillFile = allFiles[0].path;
    }

    for (const f of allFiles) {
      const btn = document.createElement('button');
      btn.className = `sb-file-pill ${f.path === activePillFile ? 'active' : ''}`;
      btn.dataset.file = f.path;
      let icon = '#i-file';
      if (['html', 'htm'].includes(f.ext)) icon = '#i-globe';
      else if (f.ext === 'py') icon = '#i-terminal';
      else if (f.ext === 'js') icon = '#i-code';
      else if (f.ext === 'css') icon = '#i-pencil';

      btn.innerHTML = `<svg class="ic" style="width:12px;height:12px"><use href="${icon}"/></svg><span>${Markdown.escape(f.name || f.path)}</span>`;
      btn.addEventListener('click', () => loadCodeFile(f.path));
      pillsContainer.appendChild(btn);
    }

    if (activePillFile) {
      await loadCodeFile(activePillFile);
    }
  }

  async function loadCodeFile(filePath) {
    activeCodeFile = filePath;
    const contentEl = $('#sbCodeContent');
    const metaEl = $('#sbCodeMeta');
    const target = activePreviewTarget || {};
    const cid = target.chatId || state.currentChatId || '';

    document.querySelectorAll('.sb-file-pill').forEach(p => {
      p.classList.toggle('active', p.dataset.file === filePath);
    });

    try {
      contentEl.textContent = 'Loading...';
      const res = await api(`/api/files/read?chatId=${encodeURIComponent(cid)}&path=${encodeURIComponent(filePath)}`);
      if (res && res.ok) {
        contentEl.textContent = res.content || '(Empty file)';
        if (metaEl) {
          const lines = (res.content || '').split('\n').length;
          const bytes = res.size || new Blob([res.content || '']).size;
          metaEl.textContent = `${lines} lines · ${(bytes / 1024).toFixed(1)} KB`;
        }
      } else {
        contentEl.textContent = res?.error || 'Could not read file';
      }
    } catch (e) {
      if (target.code && (!filePath || filePath === target.filePath)) {
        contentEl.textContent = target.code;
      } else {
        contentEl.textContent = 'Error reading file: ' + e.message;
      }
    }
  }

  async function setupMarkdownView(target, fileToSelect = null) {
    const mdBody = $('#pmMarkdownBody');
    if (!mdBody) return;
    const cid = target.chatId || state.currentChatId || '';
    const mdFile = (target.allFiles || target.files || []).find(f => f.ext === 'md')?.path || fileToSelect;

    if (mdFile && cid) {
      try {
        const res = await api(`/api/files/read?chatId=${encodeURIComponent(cid)}&path=${encodeURIComponent(mdFile)}`);
        if (res && res.ok) {
          mdBody.innerHTML = Markdown.render(res.content || '');
          return;
        }
      } catch (e) { /* fallback */ }
    }

    if (target.code) {
      mdBody.innerHTML = Markdown.render(target.code);
    } else {
      mdBody.innerHTML = '<p style="color:var(--text-2);padding:20px 0;">No markdown document content to display.</p>';
    }
  }

  async function runTerminalScript(scriptPath = null) {
    const target = activePreviewTarget || {};
    const cid = target.chatId || state.currentChatId || '';
    const select = $('#pmScriptSelect');
    const path = scriptPath || (select ? select.value : '') || target.targetScript;

    if (!path) {
      toast('No script selected to run', 'error');
      return;
    }

    const termPre = $('#pmTerminalPre');
    const statusBadge = $('#pmTermStatus');
    const durEl = $('#pmTermDur');
    const termDot = $('#sbTermDot');

    if (statusBadge) {
      statusBadge.textContent = 'RUNNING';
      statusBadge.className = 'term-status-badge running';
    }
    if (termDot) termDot.className = 'sb-status-dot running';
    if (durEl) durEl.textContent = 'executing...';

    const ext = path.split('.').pop().toLowerCase();
    const cmdStr = ext === 'py' ? `python -u "${path}"` : `node "${path}"`;

    const timeStr = new Date().toLocaleTimeString();
    termPre.innerHTML += `\n<span class="term-comment"># [${timeStr}] Executing in workspace/chats/${cid.slice(0, 8) || 'current'}...</span>\n<span class="term-prompt">&gt; ${Markdown.escape(cmdStr)}</span>\n`;
    termPre.scrollTop = termPre.scrollHeight;

    try {
      const res = await api('/api/run', 'POST', {
        path,
        chatId: cid,
        language: ext === 'py' ? 'python' : 'node'
      });

      if (durEl) durEl.textContent = `${res.durationMs || 0}ms`;

      if (res.stdout) {
        termPre.innerHTML += `<span class="term-stdout">${Markdown.escape(res.stdout)}</span>\n`;
      }
      if (res.stderr) {
        termPre.innerHTML += `<span class="term-stderr">${Markdown.escape(res.stderr)}</span>\n`;
      }
      if (!res.stdout && !res.stderr && res.output) {
        termPre.innerHTML += `<span class="term-stderr">${Markdown.escape(res.output)}</span>\n`;
      }

      if (res.ok) {
        if (statusBadge) {
          statusBadge.textContent = `SUCCESS (${res.exitCode || 0})`;
          statusBadge.className = 'term-status-badge success';
        }
        if (termDot) termDot.className = 'sb-status-dot success';
          termPre.innerHTML += `<span class="term-comment"># Process exited with code ${res.exitCode || 0} (success) in ${res.durationMs || 0}ms</span>\n`;
      } else {
        if (statusBadge) {
          statusBadge.textContent = res.exitCode !== undefined
            ? `EXIT (${res.exitCode})`
            : `FAILED`;
          statusBadge.className = 'term-status-badge error';
        }
        if (termDot) termDot.className = 'sb-status-dot error';
        const codeStr = res.exitCode !== undefined ? String(res.exitCode) : 'N/A';
        termPre.innerHTML += `<span class="term-stderr"># Process exited with error code ${codeStr}</span>\n`;
      }
    } catch (e) {
      if (statusBadge) {
        statusBadge.textContent = 'FAILED';
        statusBadge.className = 'term-status-badge error';
      }
      if (termDot) termDot.className = 'sb-status-dot error';
      termPre.innerHTML += `<span class="term-stderr"># Execution request failed: ${Markdown.escape(e.message)}</span>\n`;
    }

    termPre.scrollTop = termPre.scrollHeight;
  }

  function setPreviewDevice(dev) {
    const frameWrap = $('#pmFrameWrap');
    if (!frameWrap) return;
    frameWrap.classList.remove('tablet', 'mobile');
    if (dev === 'tablet') frameWrap.classList.add('tablet');
    if (dev === 'mobile') frameWrap.classList.add('mobile');

    ['desktop', 'tablet', 'mobile'].forEach(d => {
      const btn = $(`#pmDev${d.charAt(0).toUpperCase() + d.slice(1)}`);
      if (btn) btn.classList.toggle('active', d === dev);
    });
  }

  $('#pmDevDesktop')?.addEventListener('click', () => setPreviewDevice('desktop'));
  $('#pmDevTablet')?.addEventListener('click', () => setPreviewDevice('tablet'));
  $('#pmDevMobile')?.addEventListener('click', () => setPreviewDevice('mobile'));

  $('#sbTabWeb')?.addEventListener('click', () => switchSandboxTab('web'));
  $('#sbTabCode')?.addEventListener('click', () => switchSandboxTab('code'));
  $('#sbTabTerminal')?.addEventListener('click', () => switchSandboxTab('terminal'));
  $('#sbTabMarkdown')?.addEventListener('click', () => switchSandboxTab('markdown'));

  $('#pmRunBtn')?.addEventListener('click', () => runTerminalScript());
  $('#pmTermClearBtn')?.addEventListener('click', () => {
    const termPre = $('#pmTerminalPre');
    if (termPre) termPre.innerHTML = '<span class="term-comment">// Terminal console cleared</span>\n';
  });

  $('#sbCodeCopyBtn')?.addEventListener('click', () => {
    const code = $('#sbCodeContent')?.textContent || '';
    copyText(code, () => toast('Code copied to clipboard', 'success'));
  });

  $('#pmRefresh')?.addEventListener('click', () => {
    if (!activePreviewTarget) return;
    // Every tab must answer the button. The markdown tab had no branch, so the
    // control was simply dead there — the one place a Refresh is most useful,
    // because the file it shows is the one the agent most often rewrites.
    if (activeSandboxTab === 'web') loadPreviewFrame(activePreviewTarget);
    else if (activeSandboxTab === 'code') setupCodeExplorer(activePreviewTarget, activePreviewTarget.primaryFile);
    else if (activeSandboxTab === 'terminal') runTerminalScript();
    else if (activeSandboxTab === 'markdown') setupMarkdownView(activePreviewTarget, activePreviewTarget.primaryFile);
  });

  $('#pmPopout')?.addEventListener('click', () => {
    if (!activePreviewTarget) return;
    const cid = activePreviewTarget.chatId || state.currentChatId || '';
    const allFiles = activePreviewTarget.allFiles || activePreviewTarget.files || [];
    const htmlFile = allFiles.find(f => ['html', 'htm'].includes(f.ext || ''))?.path;
    const hasReactFiles = allFiles.some(f => ['tsx', 'jsx'].includes(f.ext || '') || /App\.(tsx|jsx|js|ts)$/i.test(f.name || ''));

    if (activeSandboxTab === 'web' && cid) {
      if (htmlFile) {
        window.open(`/api/workspace/${encodeURIComponent(cid)}/${encodeURIComponent(htmlFile)}`, '_blank');
      } else if (hasReactFiles) {
        window.open(`/api/workspace/${encodeURIComponent(cid)}/__react_preview__`, '_blank');
      }
    } else if (activeSandboxTab === 'code' && activeCodeFile && cid) {
      window.open(`/api/files/raw?chatId=${encodeURIComponent(cid)}&path=${encodeURIComponent(activeCodeFile)}`, '_blank');
    } else if (activePreviewTarget.filePath && cid) {
      window.open(`/api/files/raw?chatId=${encodeURIComponent(cid)}&path=${encodeURIComponent(activePreviewTarget.filePath)}`, '_blank');
    } else if (activePreviewTarget.code) {
      const blob = new Blob([activePreviewTarget.code], { type: 'text/html' });
      window.open(URL.createObjectURL(blob), '_blank');
    }
  });

  document.addEventListener('click', (e) => {
    const pBtn = e.target.closest('.preview-code-btn');
    if (pBtn && pBtn.dataset.code) {
      const raw = decodeURIComponent(pBtn.dataset.code);
      // No chatId: this is a snippet from the transcript, not a file in a
      // workspace. With a chatId the Web tab preferred the chat's index.html and
      // showed the project instead of the block the user clicked.
      openAppPreview({ title: 'Code Preview', code: raw, chatId: '' });
    }
  });

  async function openFileViewer(rel) {
    try {
      const chatId = state.currentChatId || '';
      const data = await api(`/api/files/read?chatId=${encodeURIComponent(chatId)}&path=${encodeURIComponent(rel)}`);
      $('#fvTitle').textContent = rel + (data.truncated ? ' (truncated)' : '');
      $('#fvContent').textContent = data.content;
      const ext = rel.split('.').pop().toLowerCase();
      const isWeb = ['html', 'htm', 'svg'].includes(ext);
      const isScript = ['py', 'js'].includes(ext);
      const prevBtn = $('#fvPreview');
      if (prevBtn) {
        prevBtn.style.display = '';
        prevBtn.textContent = isScript ? 'Run in Sandbox' : isWeb ? 'Preview App' : 'Open in Sandbox';
        prevBtn.onclick = () => {
          closeModal('fileViewerModal');
          openAppPreview({ title: rel, filePath: rel, primaryFile: rel, code: data.content, chatId }, isScript ? 'terminal' : isWeb ? 'web' : 'code', rel);
        };
      }
      openModal('fileViewerModal');
      $('#fvCopy').onclick = () => copyText(data.content, () => toast('Copied to clipboard', 'success'));
    } catch (e) { toast(e.message, 'error'); }
  }

  // ==================================================================
  // Modals (generic)
  // ==================================================================
  function openModal(id) { $('#' + id).classList.remove('hidden'); }
  function closeModal(id) { $('#' + id).classList.add('hidden'); }
  document.querySelectorAll('[data-close]').forEach(btn =>
    btn.addEventListener('click', () => closeModal(btn.dataset.close)));
  document.querySelectorAll('.modal-backdrop').forEach(bg =>
    bg.addEventListener('click', (e) => { if (e.target === bg) bg.classList.add('hidden'); }));
  // ==================================================================
  // Keyboard Shortcut Registry (Feature 4)
  // ==================================================================
  const SHORTCUT_REGISTRY = [
    {
      category: 'Navigation',
      shortcuts: [
        { label: 'New conversation', keys: ['Ctrl', 'N'] },
        { label: 'Focus search', keys: ['Ctrl', 'K'] },
        { label: 'Toggle sidebar', keys: ['Ctrl', 'Shift', 'S'] },
        { label: 'Toggle files panel', keys: ['Ctrl', 'Shift', 'F'] },
        { label: 'Show shortcuts', keys: ['?'] }
      ]
    },
    {
      category: 'Composer',
      shortcuts: [
        { label: 'Send message', keys: ['Enter'] },
        { label: 'New line', keys: ['Shift', 'Enter'] },
        { label: 'Previous message', keys: ['↑'] },
        { label: 'Next message / clear', keys: ['↓'] }
      ]
    },
    {
      category: 'Dialogs',
      shortcuts: [
        { label: 'Close modal / dropdown', keys: ['Esc'] },
        { label: 'Settings', keys: ['Ctrl', ','] }
      ]
    }
  ];

  function renderShortcutsModal() {
    const grid = $('#shortcutGrid');
    if (!grid) return;
    grid.innerHTML = '';
    for (const section of SHORTCUT_REGISTRY) {
      const title = document.createElement('div');
      title.className = 'shortcut-section-title';
      title.textContent = section.category;
      grid.appendChild(title);
      for (const sc of section.shortcuts) {
        const row = document.createElement('div');
        row.className = 'shortcut-row';
        const label = document.createElement('span');
        label.className = 'shortcut-label';
        label.textContent = sc.label;
        const keys = document.createElement('span');
        keys.className = 'shortcut-keys';
        sc.keys.forEach((k, idx) => {
          if (idx > 0) {
            const sep = document.createElement('span');
            sep.className = 'key-sep';
            sep.textContent = '+';
            keys.appendChild(sep);
          }
          const badge = document.createElement('kbd');
          badge.className = 'key-badge';
          badge.textContent = k;
          keys.appendChild(badge);
        });
        row.appendChild(label);
        row.appendChild(keys);
        grid.appendChild(row);
      }
    }
  }

  document.addEventListener('keydown', (e) => {
    const tag = document.activeElement?.tagName;
    const inInput = tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT';

    if (e.key === 'Escape') {
      if (composerModelOpen) { closeComposerModelDropdown(); return; }
      if (provMenuOpen) { closeProvMenu(); return; }
      // The workspace panel is an overlay on small screens; Escape has to close
      // it, or a keyboard user is stuck inside it.
      if (state.fpOpen && $('.modal-backdrop:not(.hidden)') === null) { fpSetOpen(false); return; }
      document.querySelectorAll('.modal-backdrop:not(.hidden)').forEach(m => m.classList.add('hidden'));
    }
    // Ctrl+N — new chat
    if ((e.ctrlKey || e.metaKey) && e.key === 'n' && !e.shiftKey) {
      e.preventDefault();
      resetToWelcome();
      closeSidebarMobile();
    }
    // Ctrl+K — focus search
    if ((e.ctrlKey || e.metaKey) && e.key === 'k') {
      e.preventDefault();
      const search = $('#chatSearch');
      if (search) { search.focus(); search.select(); }
      // Open sidebar on mobile
      if (window.innerWidth <= 860) $('#sidebar')?.classList.add('open');
    }
    // Ctrl+Shift+S — toggle sidebar
    if ((e.ctrlKey || e.metaKey) && e.shiftKey && e.key === 'S') {
      e.preventDefault();
      const sb = $('#sidebar');
      if (sb) sb.classList.toggle('open');
    }
    // Ctrl+Shift+F — toggle files panel
    if ((e.ctrlKey || e.metaKey) && e.shiftKey && e.key === 'F') {
      e.preventDefault();
      fpSetOpen(!state.fpOpen);
    }
    // Ctrl+, — open settings
    if ((e.ctrlKey || e.metaKey) && e.key === ',') {
      e.preventDefault();
      openModal('settingsModal');
    }
    // ? key — show shortcuts help (only when not in text input)
    if (!inInput && !e.ctrlKey && !e.metaKey && !e.altKey && e.key === '?') {
      e.preventDefault();
      renderShortcutsModal();
      openModal('shortcutsModal');
    }
    // Ctrl+/ — show shortcuts
    if ((e.ctrlKey || e.metaKey) && e.key === '/') {
      e.preventDefault();
      renderShortcutsModal();
      openModal('shortcutsModal');
    }
  });


  // ==================================================================
  // Providers modal
  // ==================================================================
  $('#providersBtn').addEventListener('click', () => openProviderModal());

  function openProviderModal(editId) {
    openModal('providerModal');
    showProvList();
    if (editId) showProvForm(editId);
  }

  function showProvList() {
    $('#provModalTitle').textContent = 'Providers';
    $('#provListView').classList.remove('hidden');
    $('#provFormView').classList.add('hidden');
    const list = $('#provList');
    list.innerHTML = '';
    for (const p of state.providers) {
      const el = document.createElement('div');
      el.className = 'prov-row';
      const badges = [];
      if (p.type === 'demo') badges.push('<span class="badge demo">built-in</span>');
      badges.push(p.enabled ? '<span class="badge ok">active</span>' : '<span class="badge off">disabled</span>');
      el.innerHTML = `
        <span class="prov-avatar"></span>
        <div class="pr-text">
          <div class="pr-name"><span class="pr-name-text"></span> ${badges.join(' ')}</div>
          <div class="pr-model"></div>
        </div>
        <button class="btn ghost sm"><svg class="ic"><use href="#i-pencil"/></svg><span>Configure</span></button>`;
      el.querySelector('.prov-avatar').textContent = monogram(p.name);
      el.querySelector('.pr-name-text').textContent = p.name;
      el.querySelector('.pr-model').textContent = (p.baseUrl ? p.baseUrl.replace(/^https?:\/\//, '') + ' · ' : '') + (p.model || '—');
      el.querySelector('button').addEventListener('click', () => showProvForm(p.id));
      list.appendChild(el);
    }
  }

  function showProvForm(editId) {
    state.formProviderId = editId || null;
    const existing = editId ? getProvider(editId) : null;
    state.formPresetId = existing ? existing.presetId : state.formPresetId || 'openai';
    if (existing && !state.presets.find(pr => pr.id === state.formPresetId)) state.formPresetId = 'custom';

    $('#provModalTitle').textContent = existing ? `Configure — ${existing.name}` : 'Add provider';
    $('#provListView').classList.add('hidden');
    $('#provFormView').classList.remove('hidden');
    $('#provFormNote').textContent = '';
    $('#deleteProviderBtn').style.display = existing && existing.type !== 'demo' ? '' : 'none';
    delete $('#deleteProviderBtn').dataset.armed;
    $('#deleteProviderBtn').classList.remove('danger-armed');

    renderPresetGrid();
    fillForm(existing);
  }

  function renderPresetGrid() {
    const grid = $('#presetGrid');
    grid.innerHTML = '';
    for (const pr of state.presets) {
      const el = document.createElement('button');
      el.type = 'button';
      el.className = 'preset-card' + (pr.id === state.formPresetId ? ' selected' : '');
      el.innerHTML = `<div class="pc-name"></div><div class="pc-sub"></div>`
        + (pr.vision ? '<span class="pc-tag" title="Can read attached images">Vision</span>' : '');
      el.querySelector('.pc-name').textContent = pr.label;
      el.querySelector('.pc-sub').textContent = pr.blurb || '';
      el.addEventListener('click', () => {
        state.formPresetId = pr.id;
        renderPresetGrid();
        fillForm(null); // apply preset defaults
      });
      grid.appendChild(el);
    }
  }

  function presetById(id) { return state.presets.find(p => p.id === id); }

  function fillForm(existing) {
    const preset = presetById(state.formPresetId) || {};
    const val = (cur, def) => cur !== undefined && cur !== null ? cur : def;
    $('#fName').value = existing ? existing.name : (preset.id === 'custom' ? '' : (preset.label || '').replace(/\s*\(.*?\)\s*/g, ''));
    // The stored key is never sent to the browser, so an existing provider opens
    // with an empty field and a placeholder saying a key is already saved.
    // Leaving it blank on save keeps the stored key (see formToProvider).
    $('#fKey').value = '';
    $('#fKey').placeholder = existing && existing.hasKey ? '•••••••• saved — leave blank to keep' : '';
    $('#fBase').value = existing ? (existing.baseUrl || '') : (preset.baseUrl || '');
    $('#fModel').value = existing ? (existing.model || '') : (preset.model || '');
    const temp = existing ? existing.temperature : 0.7;
    $('#fTemp').value = temp ?? 0.7;
    $('#tempVal').textContent = $('#fTemp').value;
    $('#fMaxTokens').value = val(existing?.maxTokens, '');
    $('#fRules').value = existing ? (existing.customInstructions || '') : '';
    $('#fTools').checked = existing ? existing.toolsEnabled !== false : preset.toolsEnabled !== false;
    $('#fEnabled').checked = existing ? existing.enabled !== false : true;
    $('#keyHint').textContent = preset.keyRequired ? '(required)' : preset.type === 'demo' ? '(not needed for demo)' : preset.type === 'llamacoder' ? '(no API key required)' : '(may be optional for local endpoints)';
    state.formModels = (existing && Array.isArray(existing.modelsCache)) ? existing.modelsCache : [];
    if ($('#mpSearch')) $('#mpSearch').value = '';
    renderModelPicker();
  }

  // ---------------- Model picker ----------------
  function renderModelPicker() {
    const picker = $('#modelPicker');
    if (!picker) return; // older cached HTML shell — picker simply unavailable
    const models = state.formModels;
    if (!models.length) { picker.classList.add('hidden'); return; }
    picker.classList.remove('hidden');

    const current = $('#fModel').value.trim();
    const filter = ($('#mpSearch')?.value || '').trim().toLowerCase();
    const shown = filter ? models.filter(m => m.toLowerCase().includes(filter)) : models;
    const countEl = $('#mpCount');
    const noteEl = $('#mpNote');
    if (countEl) countEl.textContent = filter ? `${shown.length} / ${models.length}` : `${models.length} models`;
    if (noteEl) noteEl.classList.toggle('hidden', !current || models.includes(current));

    const list = $('#mpList');
    list.innerHTML = '';
    if (!shown.length) {
      list.innerHTML = '<div class="mp-empty">No models match your filter.</div>';
      return;
    }
    const frag = document.createDocumentFragment();
    for (const m of shown.slice(0, 400)) {
      const el = document.createElement('button');
      el.type = 'button';
      el.className = 'mp-item' + (m === current ? ' selected' : '');
      el.innerHTML = `<svg class="ic"><use href="#i-check"/></svg><span class="mp-id"></span>`;
      el.querySelector('.mp-id').textContent = m;
      el.title = m;
      el.addEventListener('click', () => {
        $('#fModel').value = m;
        renderModelPicker();
      });
      frag.appendChild(el);
    }
    list.appendChild(frag);
  }
  const mpSearchEl = $('#mpSearch');
  if (mpSearchEl) mpSearchEl.addEventListener('input', renderModelPicker);
  $('#fModel').addEventListener('input', () => {
    const note = $('#mpNote');
    if (!note || !state.formModels.length) return;
    const current = $('#fModel').value.trim();
    note.classList.toggle('hidden', !current || state.formModels.includes(current));
    document.querySelectorAll('.mp-item').forEach(el => {
      el.classList.toggle('selected', el.querySelector('.mp-id').textContent === current);
    });
  });

  $('#fTemp').addEventListener('input', (e) => { $('#tempVal').textContent = e.target.value; });
  $('#provBackBtn').addEventListener('click', showProvList);
  $('#addProviderBtn').addEventListener('click', () => { state.formPresetId = 'openai'; showProvForm(null); });
  $('#keyPeek').addEventListener('click', () => {
    const inp = $('#fKey');
    const show = inp.type === 'password';
    inp.type = show ? 'text' : 'password';
    $('#keyPeek').innerHTML = `<svg class="ic"><use href="#${show ? 'i-eyeoff' : 'i-eye'}"/></svg>`;
  });

  function formToProvider() {
    const preset = presetById(state.formPresetId) || {};
    return {
      id: state.formProviderId,
      name: $('#fName').value.trim() || (preset.label || 'Custom provider'),
      type: preset.type || 'openai',
      presetId: state.formPresetId,
      // Omitted (not '') when the field is blank, so the server keeps the stored
      // key instead of clearing it.
      apiKey: $('#fKey').value.trim() || undefined,
      baseUrl: $('#fBase').value.trim(),
      model: $('#fModel').value.trim(),
      temperature: $('#fTemp').value === '' ? null : Number($('#fTemp').value),
      maxTokens: $('#fMaxTokens').value ? Number($('#fMaxTokens').value) : null,
      customInstructions: $('#fRules').value,
      toolsEnabled: $('#fTools').checked,
      enabled: $('#fEnabled').checked,
      modelsCache: state.formModels
    };
  }

  $('#checkModelsBtn').addEventListener('click', async () => {
    const draft = formToProvider();
    const btn = $('#checkModelsBtn');
    const box = $('#checkModelsResults');
    const note = $('#checkModelsNote');
    const models = (state.formModels && state.formModels.length)
      ? state.formModels.slice(0, 8)
      : ($('#fModel').value.trim() ? [$('#fModel').value.trim()] : []);
    if (!models.length) { toast('Fetch or type at least one model id first.', 'error'); return; }

    const original = btn.textContent;
    btn.disabled = true;
    btn.textContent = 'Checking…';
    if (note) note.textContent = '';
    box.classList.remove('hidden');
    box.innerHTML = '';
    const wait = document.createElement('div');
    wait.className = 'mc-row';
    wait.innerHTML = '<svg class="ic"><use href="#i-bolt"/></svg><span class="mc-name"></span>';
    wait.querySelector('.mc-name').textContent = `Checking ${models.length} model(s) — this can take a moment…`;
    box.appendChild(wait);

    try {
      const { ok, results, error } = await api('/api/models/check', 'POST', {
        type: draft.type, baseUrl: draft.baseUrl, apiKey: draft.apiKey,
        providerId: draft.id, models
      });
      if (!ok) throw new Error(error || 'Check failed');
      renderModelCheck(results);
    } catch (e) {
      box.innerHTML = '';
      const row = document.createElement('div');
      row.className = 'mc-row fail';
      row.innerHTML = '<svg class="ic"><use href="#i-close"/></svg><span class="mc-name"></span>';
      row.querySelector('.mc-name').textContent = e.message;
      box.appendChild(row);
    } finally {
      btn.disabled = false;
      btn.textContent = original;
    }
  });

  function renderModelCheck(results) {
    const box = $('#checkModelsResults');
    box.innerHTML = '';
    for (const r of results || []) {
      const row = document.createElement('div');
      row.className = 'mc-row ' + (r.ok ? (r.canCallTools ? 'pass' : 'warn') : 'fail');
      const icon = r.ok ? (r.canCallTools ? 'i-check' : 'i-bolt') : 'i-close';
      row.innerHTML = `<svg class="ic"><use href="#${icon}"/></svg><span class="mc-name"></span><span class="mc-detail"></span>`;
      row.querySelector('.mc-name').textContent = r.model;
      const bits = [];
      if (r.ok) {
        bits.push(`${r.ms}ms`);
        bits.push(r.canCallTools ? `tools: ${(r.toolCalls || []).join(', ')}` : 'answered but no tool call');
      } else {
        bits.push(String(r.error || 'failed').slice(0, 90));
      }
      row.querySelector('.mc-detail').textContent = bits.join(' · ');
      box.appendChild(row);
    }
    const pass = (results || []).filter((r) => r.ok).length;
    const tools = (results || []).filter((r) => r.canCallTools).length;
    const note = $('#checkModelsNote');
    if (note) note.textContent = `${pass}/${(results || []).length} answered · ${tools} can call tools`;
  }

  $('#fetchModelsBtn').addEventListener('click', async () => {
    const draft = formToProvider();
    const btn = $('#fetchModelsBtn');
    btn.disabled = true;
    btn.textContent = 'Fetching…';
    try {
      const { ok, models, error } = await api('/api/models', 'POST', { type: draft.type, baseUrl: draft.baseUrl, apiKey: draft.apiKey, providerId: draft.id });
      if (!ok) throw new Error(error || 'Failed to fetch models');
      state.formModels = models;
      if ($('#mpSearch')) $('#mpSearch').value = '';
      if (models.length && (!$('#fModel').value.trim() || !models.includes($('#fModel').value.trim()))) {
        // keep existing value but flag it via the note; auto-fill only when empty
        if (!$('#fModel').value.trim()) $('#fModel').value = models[0];
      }
      renderModelPicker();
      toast(`${models.length} models loaded — click one to select it.`, 'success');
    } catch (e) {
      toast(e.message, 'error');
    } finally {
      btn.disabled = false;
      btn.textContent = 'Fetch';
    }
  });

  $('#testProviderBtn').addEventListener('click', async () => {
    const draft = formToProvider();
    const btn = $('#testProviderBtn');
    btn.disabled = true;
    btn.querySelector('span').textContent = 'Testing…';
    try {
      if (draft.type === 'demo') {
        toast('Built-in demo provider — always available.', 'success');
      } else {
        const { ok, models, error } = await api('/api/models', 'POST', { type: draft.type, baseUrl: draft.baseUrl, apiKey: draft.apiKey, providerId: draft.id });
        if (ok) toast(`Connected — ${models.length} models available for ${draft.name}.`, 'success', 4500);
        else throw new Error(error || 'Connection failed');
      }
    } catch (e) {
      toast(e.message, 'error', 5000);
    } finally {
      btn.disabled = false;
      btn.querySelector('span').textContent = 'Test connection';
    }
  });

  $('#saveProviderBtn').addEventListener('click', async () => {
    const draft = formToProvider();
    if (draft.type !== 'demo') {
      if (!draft.baseUrl) { toast('Base URL is required.', 'error'); return; }
      if (!draft.model) { toast('Model is required.', 'error'); return; }
      const preset = presetById(draft.presetId);
      // A key is only required for a provider that does not have one yet. The
      // key field is deliberately blanked when editing — its placeholder says
      // "leave blank to keep" and the server keeps the stored key when the field
      // is omitted — so demanding it here made every edit of an existing
      // key-based provider impossible to save.
      const isNew = !state.formProviderId;
      if (preset?.keyRequired && !draft.apiKey && isNew) {
        toast('This provider requires an API key.', 'error');
        return;
      }
    }
    try {
      let saved;
      if (state.formProviderId) {
        ({ provider: saved } = await api(`/api/providers/${state.formProviderId}`, 'PUT', draft));
        state.providers = state.providers.map(p => p.id === saved.id ? saved : p);
      } else {
        ({ provider: saved } = await api('/api/providers', 'POST', draft));
        state.providers.push(saved);
      }
      state.activeProviderId = saved.id;
      renderProviderPill();
      toast(`Provider "${saved.name}" saved${saved.enabled ? ' — it is now selected' : ''}.`, 'success');
      showProvList();
    } catch (e) { toast(e.message, 'error', 5000); }
  });

  $('#deleteProviderBtn').addEventListener('click', async () => {
    const btn = $('#deleteProviderBtn');
    if (!state.formProviderId) return;
    if (!btn.dataset.armed) {
      btn.dataset.armed = '1';
      btn.classList.add('danger-armed');
      btn.querySelector('span').textContent = 'Click again to confirm';
      setTimeout(() => {
        delete btn.dataset.armed;
        btn.classList.remove('danger-armed');
        btn.querySelector('span').textContent = 'Delete';
      }, 3500);
      return;
    }
    try {
      await api(`/api/providers/${state.formProviderId}`, 'DELETE');
      state.providers = state.providers.filter(p => p.id !== state.formProviderId);
      if (state.activeProviderId === state.formProviderId) state.activeProviderId = activeProvider()?.id || null;
      renderProviderPill();
      toast('Provider deleted', 'success');
      showProvList();
    } catch (e) { toast(e.message, 'error'); }
  });

  // ==================================================================
  // Settings modal
  // ==================================================================
  // ---- Global rules: one setting, every provider and every model ----------
  // The field is the single source of truth for the operator's rules. Empty has
  // to mean "the agent's built-in default behaviour" — not an empty-looking
  // section bolted onto the prompt — so it is stated plainly, and resetting puts
  // the console back to exactly that default.
  function syncGlobalRulesUI() {
    const field = $('#sGlobalRules');
    const note = $('#sGlobalRulesNote');
    const reset = $('#resetGlobalRulesBtn');
    if (!field || !note) return;
    if (field.value.trim()) {
      note.textContent = 'Active — every provider and every model will follow these on your next message.';
      note.classList.add('active');
      reset?.classList.remove('hidden');
    } else {
      note.textContent = 'Empty — the agent uses its built-in default behaviour.';
      note.classList.remove('active');
      reset?.classList.add('hidden');
    }
  }
  $('#sGlobalRules')?.addEventListener('input', syncGlobalRulesUI);
  $('#resetGlobalRulesBtn')?.addEventListener('click', () => {
    $('#sGlobalRules').value = '';
    syncGlobalRulesUI();
    toast('Global rules cleared — save to apply the default.', 'info');
  });

  $('#settingsBtn').addEventListener('click', () => {
    $('#sAgentName').value = state.settings.agentName || 'HAMA';
    $('#sGlobalRules').value = state.settings.globalInstructions || '';
    syncGlobalRulesUI();
    const agent = state.settings.agent || {};
    if ($('#sAgentMode')) $('#sAgentMode').value = agent.mode || 'auto';
    if ($('#sCrewEnabled')) $('#sCrewEnabled').checked = agent.crewEnabled !== false;
    if ($('#sCrewSize')) $('#sCrewSize').value = String(agent.crewSize || 2);
    const sel = $('#sDefaultProvider');
    // Only enabled providers: the boot path and the chat route both require
    // `enabled`, so offering a disabled one stored a preference that was
    // silently ignored — the dropdown showed a choice the app never honoured.
    sel.innerHTML = '<option value="">— first enabled provider —</option>' +
      state.providers
        .filter(p => p.enabled)
        .map(p => `<option value="${p.id}" ${state.settings.defaultProviderId === p.id ? 'selected' : ''}>${Markdown.escape(p.name)}</option>`)
        .join('');
    const clearBtn = $('#clearChatsBtn');
    delete clearBtn.dataset.armed;
    clearBtn.classList.remove('danger-armed');
    clearBtn.querySelector('span').textContent = 'Clear all chats';
    openModal('settingsModal');
  });

  $('#saveSettingsBtn').addEventListener('click', async () => {
    try {
      const agent = {
        ...(state.settings.agent || {}),
        mode: $('#sAgentMode') ? ($('#sAgentMode').value || 'auto') : 'auto',
        crewEnabled: $('#sCrewEnabled') ? $('#sCrewEnabled').checked : true,
        crewSize: $('#sCrewSize') ? (Number($('#sCrewSize').value) || 2) : 2
      };
      const { settings } = await api('/api/settings', 'PUT', {
        agentName: $('#sAgentName').value.trim() || 'HAMA',
        defaultProviderId: $('#sDefaultProvider').value || null,
        globalInstructions: $('#sGlobalRules').value,
        agent
      });
      state.settings = settings;
      $('#brandName').textContent = settings.agentName;
      $('#composerNote').textContent = `${settings.agentName} can make mistakes. Verify important information.`;
      composer.placeholder = `Message ${settings.agentName}… (Shift+Enter for a new line)`;
      if (!state.currentChatId) state.activeProviderId = settings.defaultProviderId || state.activeProviderId;
      renderProviderPill();
      closeModal('settingsModal');
      toast('Settings saved', 'success');
    } catch (e) { toast(e.message, 'error'); }
  });

  $('#clearChatsBtn').addEventListener('click', async () => {
    const btn = $('#clearChatsBtn');
    if (!btn.dataset.armed) {
      btn.dataset.armed = '1';
      btn.classList.add('danger-armed');
      btn.querySelector('span').textContent = 'Click again to confirm';
      setTimeout(() => {
        delete btn.dataset.armed;
        btn.classList.remove('danger-armed');
        btn.querySelector('span').textContent = 'Clear all chats';
      }, 3500);
      return;
    }
    try {
      await api('/api/chats-clear', 'POST');
      state.chats = [];
      resetToWelcome();
      closeModal('settingsModal');
      toast('All conversations cleared', 'success');
    } catch (e) { toast(e.message, 'error'); }
  });

  // ==================================================================
  // Mobile sidebar
  // ==================================================================
  $('#menuBtn').addEventListener('click', () => {
    $('#sidebar').classList.add('open');
    $('#sideOverlay').classList.add('show');
  });
  $('#sideOverlay').addEventListener('click', closeSidebarMobile);
  function closeSidebarMobile() {
    $('#sidebar').classList.remove('open');
    $('#sideOverlay').classList.remove('show');
  }

  // ==================================================================
  // Copy buttons inside markdown code blocks (event delegation)
  // ==================================================================
  document.addEventListener('click', (e) => {
    const btn = e.target.closest('.copy-code');
    if (!btn) return;
    const code = decodeURIComponent(btn.dataset.code || '');
    copyText(code, () => {
      const span = btn.querySelector('span');
      if (span) { span.textContent = 'Copied!'; setTimeout(() => span.textContent = 'Copy', 1500); }
    });
  });

  // ==================================================================
  // Boot
  // ==================================================================
  async function boot() {
    try {
      const data = await api('/api/bootstrap');
      state.providers = data.providers;
      state.chats = data.chats;
      state.settings = data.settings;
      state.presets = data.presets;
      const def = (data.providers || []).find(p => p.id === data.settings.defaultProviderId && p.enabled);
      state.activeProviderId = def ? def.id : (data.providers.find(p => p.enabled) || data.providers[0] || {}).id || null;
      applyTheme(data.settings.theme || 'dark');
      $('#brandName').textContent = data.settings.agentName || 'HAMA';
      $('#composerNote').textContent = `${data.settings.agentName || 'HAMA'} can make mistakes. Verify important information.`;
      composer.placeholder = `Message ${data.settings.agentName || 'HAMA'}… (Shift+Enter for a new line)`;
      renderChatList();
      renderProviderPill();
      renderTagFilterBar();
      syncToolChips();
      if (state.fpOpen) fpSetOpen(true);
      composer.focus();

      // The server tells us when a src/ file was edited after it started. Without
      // this the only symptom is "my fix did not work", because the browser
      // reloads the front end from disk on every refresh while the back end keeps
      // running the code it loaded at boot.
      //
      // A one-shot toast is not enough: a tab that was already open when the edit
      // landed never reloads, so the warning is only shown to someone who happens
      // to refresh at the right moment. The badge stays until the server is
      // restarted, and the recheck below catches an edit made while the tab is
      // open.
      setStaleBadge(Boolean(data.staleCode));
      if (data.staleCode) {
        toast('Backend code changed — the server is still running the old version.\nRestart it (Ctrl+C, then npm start), or use npm run dev to reload automatically.', 'warning', 15000);
      }
      startStaleWatch();
    } catch (e) {
      toast('Failed to load: ' + e.message, 'error', 6000);
    }
  }

  boot().catch(e => {
    console.error('HAMA startup failed:', e);
    try { toast('Startup error: ' + e.message + ' — try refreshing the page.', 'error', 8000); } catch { /* ignore */ }
  });
})();
