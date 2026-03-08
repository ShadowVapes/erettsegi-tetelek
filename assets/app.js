const APP_VERSION = 2;
const STATIC_DATA_PATH = 'data/content.json';
const GITHUB_DATA_PATH = 'data/content.json';
const CONFIG_KEY = 'erettsegi_config_current_v2';
const LOCAL_FALLBACK_SCOPE = 'local-only';

const els = {
  subjectList: document.getElementById('subjectList'),
  pageList: document.getElementById('pageList'),
  currentSubjectTitle: document.getElementById('currentSubjectTitle'),
  currentSubjectMeta: document.getElementById('currentSubjectMeta'),
  pageTitleInput: document.getElementById('pageTitleInput'),
  pageInfo: document.getElementById('pageInfo'),
  editor: document.getElementById('editor'),
  imageTools: document.getElementById('imageTools'),
  statusText: document.getElementById('statusText'),
  sourceText: document.getElementById('sourceText'),
  ghOwner: document.getElementById('ghOwner'),
  ghRepo: document.getElementById('ghRepo'),
  ghBranch: document.getElementById('ghBranch'),
  ghToken: document.getElementById('ghToken'),
  preferRemoteToggle: document.getElementById('preferRemoteToggle'),
  imageInput: document.getElementById('imageInput'),
  modalBackdrop: document.getElementById('modalBackdrop'),
  modalTitle: document.getElementById('modalTitle'),
  modalMessage: document.getElementById('modalMessage'),
  modalCancel: document.getElementById('modalCancel'),
  modalConfirm: document.getElementById('modalConfirm'),
  settingsPanel: document.getElementById('settingsPanel'),
};

const stateRef = {
  state: createEmptyState(),
  selectedSubjectId: null,
  selectedPageId: null,
  selectedImage: null,
  githubSaveQueue: Promise.resolve(),
  autosaveTimer: null,
  modalResolver: null,
  loadedSource: 'Kezdés',
};

function createEmptyState() {
  return {
    version: APP_VERSION,
    updatedAt: new Date(0).toISOString(),
    subjects: [],
    deletedSubjects: [],
    deletedPages: [],
  };
}

function uid(prefix = 'id') {
  if (window.crypto?.randomUUID) return `${prefix}_${crypto.randomUUID()}`;
  return `${prefix}_${Date.now()}_${Math.random().toString(16).slice(2)}`;
}

function nowIso() {
  return new Date().toISOString();
}

function safeJsonParse(text, fallback = null) {
  try { return JSON.parse(text); } catch { return fallback; }
}

function deepClone(obj) {
  return JSON.parse(JSON.stringify(obj));
}

function getTimestampValue(value) {
  const time = Date.parse(value || 0);
  return Number.isFinite(time) ? time : 0;
}

function chooseNewer(a, b) {
  if (!a) return b ? deepClone(b) : null;
  if (!b) return a ? deepClone(a) : null;
  return getTimestampValue(a.updatedAt) >= getTimestampValue(b.updatedAt) ? deepClone(a) : deepClone(b);
}

function toRepoScope(config = getConfig()) {
  const owner = (config.owner || '').trim();
  const repo = (config.repo || '').trim();
  if (!owner || !repo) return LOCAL_FALLBACK_SCOPE;
  return `${owner}__${repo}`.toLowerCase();
}

function stateKey(scope = toRepoScope()) {
  return `erettsegi_state_${scope}_v2`;
}

function tokenKey(scope = toRepoScope()) {
  return `erettsegi_token_${scope}_v2`;
}

function setStatus(message, tone = 'normal') {
  els.statusText.textContent = message;
  els.statusText.style.color = tone === 'error'
    ? 'var(--danger)'
    : tone === 'success'
      ? 'var(--success)'
      : tone === 'warning'
        ? 'var(--warning)'
        : '';
}

function setSource(text) {
  stateRef.loadedSource = text;
  els.sourceText.textContent = text;
}

function normalizeState(raw) {
  const base = createEmptyState();
  if (!raw || typeof raw !== 'object') return base;

  const normalized = {
    version: APP_VERSION,
    updatedAt: raw.updatedAt || nowIso(),
    subjects: [],
    deletedSubjects: Array.isArray(raw.deletedSubjects) ? raw.deletedSubjects : [],
    deletedPages: Array.isArray(raw.deletedPages) ? raw.deletedPages : [],
  };

  const subjects = Array.isArray(raw.subjects) ? raw.subjects : [];
  normalized.subjects = subjects.map((subject, subjectIndex) => {
    const subjectCreated = subject.createdAt || subject.updatedAt || nowIso();
    const pages = Array.isArray(subject.pages) ? subject.pages : [];
    return {
      id: subject.id || uid(`subject_${subjectIndex}`),
      title: subject.title || `Tantárgy ${subjectIndex + 1}`,
      createdAt: subjectCreated,
      updatedAt: subject.updatedAt || subjectCreated,
      pages: pages.map((page, pageIndex) => {
        const pageCreated = page.createdAt || page.updatedAt || nowIso();
        return {
          id: page.id || uid(`page_${pageIndex}`),
          title: page.title || `Oldal ${pageIndex + 1}`,
          content: typeof page.content === 'string' ? page.content : '',
          createdAt: pageCreated,
          updatedAt: page.updatedAt || pageCreated,
        };
      }),
    };
  });

  normalized.deletedSubjects = normalized.deletedSubjects
    .filter(item => item && item.id)
    .map(item => ({ id: item.id, updatedAt: item.updatedAt || nowIso() }));

  normalized.deletedPages = normalized.deletedPages
    .filter(item => item && item.id)
    .map(item => ({ id: item.id, subjectId: item.subjectId || null, updatedAt: item.updatedAt || nowIso() }));

  normalized.subjects.sort((a, b) => getTimestampValue(a.createdAt) - getTimestampValue(b.createdAt));
  normalized.subjects.forEach(subject => {
    subject.pages.sort((a, b) => getTimestampValue(a.createdAt) - getTimestampValue(b.createdAt));
  });

  return normalized;
}

function mergeStates(remoteRaw, localRaw) {
  const remote = normalizeState(remoteRaw);
  const local = normalizeState(localRaw);

  const deletedSubjectMap = new Map();
  const deletedPageMap = new Map();

  for (const item of [...remote.deletedSubjects, ...local.deletedSubjects]) {
    const existing = deletedSubjectMap.get(item.id);
    if (!existing || getTimestampValue(item.updatedAt) > getTimestampValue(existing.updatedAt)) {
      deletedSubjectMap.set(item.id, deepClone(item));
    }
  }

  for (const item of [...remote.deletedPages, ...local.deletedPages]) {
    const existing = deletedPageMap.get(item.id);
    if (!existing || getTimestampValue(item.updatedAt) > getTimestampValue(existing.updatedAt)) {
      deletedPageMap.set(item.id, deepClone(item));
    }
  }

  const remoteSubjects = new Map(remote.subjects.map(subject => [subject.id, subject]));
  const localSubjects = new Map(local.subjects.map(subject => [subject.id, subject]));
  const subjectIds = new Set([...remoteSubjects.keys(), ...localSubjects.keys()]);
  const mergedSubjects = [];

  for (const subjectId of subjectIds) {
    const remoteSubject = remoteSubjects.get(subjectId);
    const localSubject = localSubjects.get(subjectId);
    const deletedSubject = deletedSubjectMap.get(subjectId);
    const chosenSubject = chooseNewer(remoteSubject, localSubject);
    if (!chosenSubject) continue;
    if (deletedSubject && getTimestampValue(deletedSubject.updatedAt) >= getTimestampValue(chosenSubject.updatedAt)) continue;

    const remotePages = new Map((remoteSubject?.pages || []).map(page => [page.id, page]));
    const localPages = new Map((localSubject?.pages || []).map(page => [page.id, page]));
    const pageIds = new Set([...remotePages.keys(), ...localPages.keys()]);
    const mergedPages = [];

    for (const pageId of pageIds) {
      const deletedPage = deletedPageMap.get(pageId);
      const chosenPage = chooseNewer(remotePages.get(pageId), localPages.get(pageId));
      if (!chosenPage) continue;
      if (deletedPage && getTimestampValue(deletedPage.updatedAt) >= getTimestampValue(chosenPage.updatedAt)) continue;
      mergedPages.push(chosenPage);
    }

    mergedPages.sort((a, b) => getTimestampValue(a.createdAt) - getTimestampValue(b.createdAt));
    chosenSubject.pages = mergedPages;
    mergedSubjects.push(chosenSubject);
  }

  mergedSubjects.sort((a, b) => getTimestampValue(a.createdAt) - getTimestampValue(b.createdAt));

  const mergedState = {
    version: APP_VERSION,
    updatedAt: [remote.updatedAt, local.updatedAt, nowIso()].sort((a, b) => getTimestampValue(a) - getTimestampValue(b)).at(-1),
    subjects: mergedSubjects,
    deletedSubjects: [...deletedSubjectMap.values()].sort((a, b) => getTimestampValue(a.updatedAt) - getTimestampValue(b.updatedAt)),
    deletedPages: [...deletedPageMap.values()].sort((a, b) => getTimestampValue(a.updatedAt) - getTimestampValue(b.updatedAt)),
  };

  return mergedState;
}

function getConfig() {
  const raw = safeJsonParse(localStorage.getItem(CONFIG_KEY), {}) || {};
  const config = {
    owner: raw.owner || '',
    repo: raw.repo || '',
    branch: raw.branch || 'main',
    preferRemote: raw.preferRemote !== false,
  };
  const scope = toRepoScope(config);
  config.token = localStorage.getItem(tokenKey(scope)) || '';
  return config;
}

function saveConfig(config) {
  const baseConfig = {
    owner: (config.owner || '').trim(),
    repo: (config.repo || '').trim(),
    branch: (config.branch || 'main').trim() || 'main',
    preferRemote: Boolean(config.preferRemote),
  };

  localStorage.setItem(CONFIG_KEY, JSON.stringify(baseConfig));
  const scope = toRepoScope(baseConfig);
  if (config.token) {
    localStorage.setItem(tokenKey(scope), config.token.trim());
  }
  return { ...baseConfig, token: config.token?.trim() || '' };
}

function readFormConfig() {
  return {
    owner: els.ghOwner.value,
    repo: els.ghRepo.value,
    branch: els.ghBranch.value || 'main',
    token: els.ghToken.value,
    preferRemote: els.preferRemoteToggle.checked,
  };
}

function populateConfigForm(config) {
  els.ghOwner.value = config.owner || '';
  els.ghRepo.value = config.repo || '';
  els.ghBranch.value = config.branch || 'main';
  els.ghToken.value = config.token || '';
  els.preferRemoteToggle.checked = config.preferRemote !== false;
}

function saveLocalDraft(state = stateRef.state) {
  const scope = toRepoScope(getConfig());
  localStorage.setItem(stateKey(scope), JSON.stringify(state));
}

function loadLocalDraft(config = getConfig()) {
  return safeJsonParse(localStorage.getItem(stateKey(toRepoScope(config))), null);
}

function clearLocalDraft(config = getConfig()) {
  localStorage.removeItem(stateKey(toRepoScope(config)));
}

function getSelectedSubject() {
  return stateRef.state.subjects.find(subject => subject.id === stateRef.selectedSubjectId) || null;
}

function getSelectedPage() {
  const subject = getSelectedSubject();
  return subject?.pages.find(page => page.id === stateRef.selectedPageId) || null;
}

function markStateUpdated() {
  stateRef.state.updatedAt = nowIso();
}

function ensureSelectionValid() {
  const subject = getSelectedSubject();
  if (!subject) {
    stateRef.selectedSubjectId = stateRef.state.subjects[0]?.id || null;
  }
  const currentSubject = getSelectedSubject();
  if (!currentSubject) {
    stateRef.selectedPageId = null;
    return;
  }
  const hasSelectedPage = currentSubject.pages.some(page => page.id === stateRef.selectedPageId);
  if (!hasSelectedPage) {
    stateRef.selectedPageId = currentSubject.pages[0]?.id || null;
  }
}

function render() {
  ensureSelectionValid();
  renderSubjects();
  renderPages();
  renderEditor();
}

function renderSubjects() {
  els.subjectList.innerHTML = '';
  if (!stateRef.state.subjects.length) {
    const empty = document.createElement('div');
    empty.className = 'empty-state-box card';
    empty.innerHTML = '<p>Még nincs tantárgy. Hozz létre egyet.</p>';
    els.subjectList.appendChild(empty);
    return;
  }

  for (const subject of stateRef.state.subjects) {
    const card = document.createElement('div');
    card.className = `item-card ${subject.id === stateRef.selectedSubjectId ? 'active' : ''}`;

    const main = document.createElement('div');
    main.className = 'item-main';

    const selectBtn = document.createElement('button');
    selectBtn.innerHTML = `<div class="item-title">${escapeHtml(subject.title)}</div><div class="item-meta">${subject.pages.length} oldal</div>`;
    selectBtn.addEventListener('click', () => {
      syncEditorIntoState();
      stateRef.selectedSubjectId = subject.id;
      stateRef.selectedPageId = subject.pages[0]?.id || null;
      render();
    });

    const actions = document.createElement('div');
    actions.className = 'item-actions';

    const renameBtn = iconButton('Átnevez');
    renameBtn.addEventListener('click', () => renameSubject(subject.id));

    const deleteBtn = iconButton('Töröl');
    deleteBtn.addEventListener('click', () => deleteSubject(subject.id));

    actions.append(renameBtn, deleteBtn);
    main.append(selectBtn, actions);
    card.appendChild(main);
    els.subjectList.appendChild(card);
  }
}

function renderPages() {
  els.pageList.innerHTML = '';
  const subject = getSelectedSubject();
  if (!subject) {
    els.pageList.classList.add('empty-state-box');
    els.pageList.innerHTML = '<p>Nincs kiválasztott tantárgy.</p>';
    els.currentSubjectTitle.textContent = 'Válassz tantárgyat';
    els.currentSubjectMeta.textContent = 'Itt tudod kezelni az oldalakat és a tartalmat.';
    return;
  }

  els.pageList.classList.remove('empty-state-box');
  els.currentSubjectTitle.textContent = subject.title;
  els.currentSubjectMeta.textContent = `${subject.pages.length} oldal · utolsó módosítás: ${formatDate(subject.updatedAt)}`;

  if (!subject.pages.length) {
    els.pageList.classList.add('empty-state-box');
    els.pageList.innerHTML = '<p>Még nincs oldal ebben a tantárgyban.</p>';
    return;
  }

  for (const page of subject.pages) {
    const card = document.createElement('div');
    card.className = `item-card ${page.id === stateRef.selectedPageId ? 'active' : ''}`;

    const main = document.createElement('div');
    main.className = 'item-main';
    const selectBtn = document.createElement('button');
    selectBtn.innerHTML = `<div class="item-title">${escapeHtml(page.title)}</div><div class="item-meta">${formatDate(page.updatedAt)}</div>`;
    selectBtn.addEventListener('click', () => {
      syncEditorIntoState();
      stateRef.selectedPageId = page.id;
      render();
    });

    const actions = document.createElement('div');
    actions.className = 'item-actions';
    const renameBtn = iconButton('Átnevez');
    renameBtn.addEventListener('click', () => renamePage(page.id));
    const deleteBtn = iconButton('Töröl');
    deleteBtn.addEventListener('click', () => deletePage(page.id));
    actions.append(renameBtn, deleteBtn);

    main.append(selectBtn, actions);
    card.appendChild(main);
    els.pageList.appendChild(card);
  }
}

function renderEditor() {
  const page = getSelectedPage();
  if (!page) {
    els.pageTitleInput.value = '';
    els.pageTitleInput.disabled = true;
    els.editor.innerHTML = '';
    els.editor.setAttribute('contenteditable', 'false');
    els.pageInfo.textContent = 'Válassz vagy hozz létre egy oldalt.';
    hideImageTools();
    return;
  }

  els.pageTitleInput.disabled = false;
  els.pageTitleInput.value = page.title;
  els.pageInfo.textContent = `Utolsó módosítás: ${formatDate(page.updatedAt)}`;
  if (els.editor.innerHTML !== page.content) {
    els.editor.innerHTML = page.content || '';
  }
  els.editor.setAttribute('contenteditable', 'true');
  hideImageTools();
}

function iconButton(label) {
  const button = document.createElement('button');
  button.className = 'icon-btn';
  button.textContent = label;
  return button;
}

function formatDate(iso) {
  if (!iso) return 'ismeretlen';
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return 'ismeretlen';
  return date.toLocaleString('hu-HU');
}

function escapeHtml(text) {
  return String(text)
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');
}

function addSubject() {
  syncEditorIntoState();
  const title = window.prompt('Tantárgy neve:', 'Új tantárgy');
  if (!title || !title.trim()) return;
  const timestamp = nowIso();
  const subject = {
    id: uid('subject'),
    title: title.trim(),
    createdAt: timestamp,
    updatedAt: timestamp,
    pages: [],
  };
  stateRef.state.subjects.push(subject);
  markStateUpdated();
  stateRef.selectedSubjectId = subject.id;
  stateRef.selectedPageId = null;
  saveLocalDraft();
  render();
  setStatus('Tantárgy létrehozva.', 'success');
}

function renameSubject(subjectId) {
  const subject = stateRef.state.subjects.find(item => item.id === subjectId);
  if (!subject) return;
  const nextTitle = window.prompt('Új tantárgynév:', subject.title);
  if (!nextTitle || !nextTitle.trim()) return;
  subject.title = nextTitle.trim();
  subject.updatedAt = nowIso();
  markStateUpdated();
  saveLocalDraft();
  render();
  setStatus('Tantárgy átnevezve.', 'success');
}

async function deleteSubject(subjectId) {
  const subject = stateRef.state.subjects.find(item => item.id === subjectId);
  if (!subject) return;
  const ok = await confirmModal('Tantárgy törlése', `Biztosan törölni akarod ezt a tantárgyat és az összes oldalát?\n\n${subject.title}`);
  if (!ok) return;

  const deletedAt = nowIso();
  stateRef.state.deletedSubjects.push({ id: subject.id, updatedAt: deletedAt });
  for (const page of subject.pages) {
    stateRef.state.deletedPages.push({ id: page.id, subjectId: subject.id, updatedAt: deletedAt });
  }

  stateRef.state.subjects = stateRef.state.subjects.filter(item => item.id !== subjectId);
  markStateUpdated();
  if (stateRef.selectedSubjectId === subjectId) {
    stateRef.selectedSubjectId = stateRef.state.subjects[0]?.id || null;
    stateRef.selectedPageId = null;
  }
  saveLocalDraft();
  render();
  setStatus('Tantárgy törölve.', 'success');
}

function addPage() {
  const subject = getSelectedSubject();
  if (!subject) {
    setStatus('Előbb válassz ki egy tantárgyat.', 'warning');
    return;
  }
  syncEditorIntoState();
  const title = window.prompt('Oldal címe:', 'Új oldal');
  if (!title || !title.trim()) return;
  const timestamp = nowIso();
  const page = {
    id: uid('page'),
    title: title.trim(),
    content: '',
    createdAt: timestamp,
    updatedAt: timestamp,
  };
  subject.pages.push(page);
  subject.updatedAt = timestamp;
  markStateUpdated();
  stateRef.selectedPageId = page.id;
  saveLocalDraft();
  render();
  focusEditorSoon();
  setStatus('Oldal létrehozva.', 'success');
}

function renamePage(pageId) {
  const page = getSelectedSubject()?.pages.find(item => item.id === pageId);
  if (!page) return;
  const nextTitle = window.prompt('Új oldalcím:', page.title);
  if (!nextTitle || !nextTitle.trim()) return;
  page.title = nextTitle.trim();
  page.updatedAt = nowIso();
  getSelectedSubject().updatedAt = page.updatedAt;
  markStateUpdated();
  saveLocalDraft();
  render();
  setStatus('Oldal átnevezve.', 'success');
}

async function deletePage(pageId) {
  const subject = getSelectedSubject();
  const page = subject?.pages.find(item => item.id === pageId);
  if (!subject || !page) return;
  const ok = await confirmModal('Oldal törlése', `Biztosan törölni akarod ezt az oldalt?\n\n${page.title}`);
  if (!ok) return;

  const deletedAt = nowIso();
  stateRef.state.deletedPages.push({ id: page.id, subjectId: subject.id, updatedAt: deletedAt });
  subject.pages = subject.pages.filter(item => item.id !== pageId);
  subject.updatedAt = deletedAt;
  markStateUpdated();
  if (stateRef.selectedPageId === pageId) {
    stateRef.selectedPageId = subject.pages[0]?.id || null;
  }
  saveLocalDraft();
  render();
  setStatus('Oldal törölve.', 'success');
}

function syncEditorIntoState() {
  const page = getSelectedPage();
  const subject = getSelectedSubject();
  if (!page || !subject) return;
  const newTitle = els.pageTitleInput.value.trim() || 'Névtelen oldal';
  const newContent = els.editor.innerHTML;
  let changed = false;
  if (page.title !== newTitle) {
    page.title = newTitle;
    changed = true;
  }
  if (page.content !== newContent) {
    page.content = newContent;
    changed = true;
  }
  if (changed) {
    const timestamp = nowIso();
    page.updatedAt = timestamp;
    subject.updatedAt = timestamp;
    markStateUpdated();
    saveLocalDraft();
    els.pageInfo.textContent = `Utolsó módosítás: ${formatDate(page.updatedAt)}`;
  }
}

function queueLocalAutosave() {
  window.clearTimeout(stateRef.autosaveTimer);
  stateRef.autosaveTimer = window.setTimeout(() => {
    syncEditorIntoState();
    setStatus('Helyi piszkozat frissítve. GitHubra még nincs kimentve.', 'warning');
  }, 350);
}

function focusEditorSoon() {
  window.setTimeout(() => els.editor.focus(), 30);
}

function confirmModal(title, message) {
  return new Promise(resolve => {
    els.modalTitle.textContent = title;
    els.modalMessage.textContent = message;
    els.modalBackdrop.classList.remove('hidden');
    stateRef.modalResolver = resolve;
  });
}

function closeModal(result) {
  els.modalBackdrop.classList.add('hidden');
  if (typeof stateRef.modalResolver === 'function') {
    stateRef.modalResolver(result);
    stateRef.modalResolver = null;
  }
}

function currentConfigIsComplete(config = getConfig()) {
  return Boolean(config.owner && config.repo && config.branch);
}

function githubHeaders(config, json = true) {
  const headers = {
    'Accept': 'application/vnd.github+json',
    'X-GitHub-Api-Version': '2022-11-28',
  };
  if (config.token) headers.Authorization = `Bearer ${config.token}`;
  if (json) headers['Content-Type'] = 'application/json';
  return headers;
}

async function githubRequest(url, config, options = {}) {
  const response = await fetch(url, {
    ...options,
    headers: {
      ...githubHeaders(config, options.body !== undefined),
      ...(options.headers || {}),
    },
  });

  const text = await response.text();
  const data = safeJsonParse(text, text);
  if (!response.ok) {
    const error = new Error(`GitHub hiba: ${response.status}`);
    error.status = response.status;
    error.data = data;
    throw error;
  }
  return data;
}

function buildRepoApiBase(config) {
  return `https://api.github.com/repos/${encodeURIComponent(config.owner)}/${encodeURIComponent(config.repo)}`;
}

function utf8ToBase64(text) {
  return btoa(unescape(encodeURIComponent(text)));
}

function base64ToUtf8(base64) {
  return decodeURIComponent(escape(atob(base64.replace(/\n/g, ''))));
}

async function githubTestConnection() {
  const config = readFormConfig();
  if (!currentConfigIsComplete(config)) {
    setStatus('Add meg az owner / repo / branch adatokat is.', 'warning');
    return;
  }
  setStatus('Kapcsolat teszt fut...');
  try {
    const url = buildRepoApiBase(config);
    const repoInfo = await githubRequest(url, config, { method: 'GET' });
    saveConfig(config);
    setStatus(`Kapcsolat rendben: ${repoInfo.full_name}`, 'success');
    setSource(`GitHub repo: ${repoInfo.full_name}`);
  } catch (error) {
    setStatus(formatGithubError(error), 'error');
  }
}

async function githubGetFile(path, config) {
  const url = `${buildRepoApiBase(config)}/contents/${path}?ref=${encodeURIComponent(config.branch)}`;
  try {
    const data = await githubRequest(url, config, { method: 'GET' });
    return {
      exists: true,
      sha: data.sha,
      content: data.content ? base64ToUtf8(data.content) : '',
      raw: data,
    };
  } catch (error) {
    if (error.status === 404) {
      return { exists: false, sha: null, content: '', raw: null };
    }
    throw error;
  }
}

async function githubPutFile(path, contentText, config, sha = null, message = 'Update file') {
  const url = `${buildRepoApiBase(config)}/contents/${path}`;
  const payload = {
    message,
    content: utf8ToBase64(contentText),
    branch: config.branch,
  };
  if (sha) payload.sha = sha;
  return githubRequest(url, config, {
    method: 'PUT',
    body: JSON.stringify(payload),
  });
}

async function loadRemoteState(config = getConfig()) {
  const remoteFile = await githubGetFile(GITHUB_DATA_PATH, config);
  if (!remoteFile.exists) return createEmptyState();
  return normalizeState(safeJsonParse(remoteFile.content, createEmptyState()));
}

async function performGithubSave() {
  const config = getConfig();
  if (!currentConfigIsComplete(config) || !config.token) {
    setStatus('GitHub mentéshez owner / repo / branch / token is kell.', 'warning');
    return;
  }

  syncEditorIntoState();
  saveLocalDraft();
  setStatus('GitHub mentés folyamatban...');

  let attempt = 0;
  while (attempt < 2) {
    attempt += 1;
    try {
      const remoteFile = await githubGetFile(GITHUB_DATA_PATH, config);
      const remoteState = remoteFile.exists
        ? normalizeState(safeJsonParse(remoteFile.content, createEmptyState()))
        : createEmptyState();

      const mergedState = mergeStates(remoteState, stateRef.state);
      mergedState.updatedAt = nowIso();
      const contentText = JSON.stringify(mergedState, null, 2);

      await githubPutFile(
        GITHUB_DATA_PATH,
        contentText,
        config,
        remoteFile.sha,
        `Mentés: ${new Date().toLocaleString('hu-HU')}`,
      );

      const backupPath = `backup/content-${new Date().toISOString().replace(/[:.]/g, '-')}-${Math.random().toString(16).slice(2, 8)}.json`;
      const backupPayload = JSON.stringify({
        savedAt: nowIso(),
        source: 'browser-app',
        data: mergedState,
      }, null, 2);
      await githubPutFile(
        backupPath,
        backupPayload,
        config,
        null,
        `Backup: ${new Date().toLocaleString('hu-HU')}`,
      );

      stateRef.state = mergedState;
      saveLocalDraft();
      setSource(`GitHub: ${config.owner}/${config.repo}@${config.branch}`);
      setStatus('GitHub mentés kész. A közös adat frissült.', 'success');
      render();
      return;
    } catch (error) {
      if (error.status === 409 && attempt < 2) {
        setStatus('Ütközés volt, friss remote állapottal újrapróbálom...', 'warning');
        continue;
      }
      throw error;
    }
  }
}

function enqueueGithubSave() {
  const task = stateRef.githubSaveQueue.then(() => performGithubSave());
  stateRef.githubSaveQueue = task.catch(() => {});
  return task.catch(error => {
    setStatus(formatGithubError(error), 'error');
    throw error;
  });
}

async function saveAll() {
  syncEditorIntoState();
  saveLocalDraft();
  const config = getConfig();
  if (!currentConfigIsComplete(config) || !config.token) {
    setStatus('Helyi mentés kész. GitHub mentéshez töltsd ki a sync beállításokat.', 'warning');
    setSource('Helyi draft');
    return;
  }
  try {
    await enqueueGithubSave();
  } catch {
    // státuszt az enqueueGithubSave már kezeli
  }
}

async function reloadFromRemote() {
  const config = getConfig();
  if (!currentConfigIsComplete(config)) {
    setStatus('Nincs beállított GitHub repo.', 'warning');
    return;
  }
  syncEditorIntoState();
  setStatus('GitHub adat újratöltése...');
  try {
    const remoteState = await loadRemoteState(config);
    stateRef.state = mergeStates(remoteState, stateRef.state);
    saveLocalDraft();
    render();
    setSource(`GitHub: ${config.owner}/${config.repo}@${config.branch}`);
    setStatus('GitHub adat betöltve és összefésülve.', 'success');
  } catch (error) {
    setStatus(formatGithubError(error), 'error');
  }
}

async function loadStaticState() {
  try {
    const response = await fetch(`${STATIC_DATA_PATH}?v=${Date.now()}`);
    if (!response.ok) throw new Error('A statikus data/content.json nem tölthető be.');
    return normalizeState(await response.json());
  } catch {
    return createEmptyState();
  }
}

async function bootstrap() {
  const config = getConfig();
  populateConfigForm(config);

  let loaded = false;

  if (config.preferRemote && currentConfigIsComplete(config)) {
    try {
      const remoteState = await loadRemoteState(config);
      const localDraft = normalizeState(loadLocalDraft(config));
      stateRef.state = mergeStates(remoteState, localDraft);
      setSource(`GitHub: ${config.owner}/${config.repo}@${config.branch}`);
      setStatus('GitHub adat betöltve.', 'success');
      loaded = true;
      saveLocalDraft();
    } catch (error) {
      setStatus(`GitHub betöltés sikertelen, fallback megy: ${formatGithubError(error)}`, 'warning');
    }
  }

  if (!loaded) {
    const localDraft = loadLocalDraft(config);
    if (localDraft) {
      stateRef.state = normalizeState(localDraft);
      setSource('Helyi draft');
      setStatus('Helyi mentés betöltve.', 'success');
      loaded = true;
    }
  }

  if (!loaded) {
    stateRef.state = await loadStaticState();
    setSource('Statikus fájl');
    setStatus('Kezdőadat betöltve.', 'success');
  }

  ensureSelectionValid();
  render();
}

function formatGithubError(error) {
  if (!error) return 'Ismeretlen hiba.';
  const status = error.status ? `${error.status}` : 'ismeretlen';
  const rawMessage = typeof error.data === 'object' ? error.data?.message : error.message;
  const message = rawMessage || error.message || 'Ismeretlen GitHub hiba.';
  return `GitHub hiba: ${status} – ${message}`;
}

function applyHeading() {
  document.execCommand('formatBlock', false, 'h2');
  syncEditorIntoState();
}

function applyQuote() {
  document.execCommand('formatBlock', false, 'blockquote');
  syncEditorIntoState();
}

function insertImageFromFile(file) {
  if (!file) return;
  const reader = new FileReader();
  reader.onload = () => {
    insertImageAtCaret(reader.result);
    syncEditorIntoState();
  };
  reader.readAsDataURL(file);
}

function insertImageAtCaret(src) {
  els.editor.focus();
  const img = document.createElement('img');
  img.src = src;
  img.alt = 'Beillesztett kép';
  img.className = 'align-center';
  insertNodeAtCaret(img);
  selectImage(img);
}

function insertNodeAtCaret(node) {
  const selection = window.getSelection();
  if (!selection || !selection.rangeCount) {
    els.editor.appendChild(node);
    return;
  }
  const range = selection.getRangeAt(0);
  range.deleteContents();
  range.insertNode(node);
  range.setStartAfter(node);
  range.setEndAfter(node);
  selection.removeAllRanges();
  selection.addRange(range);
}

function selectImage(img) {
  clearSelectedImage();
  stateRef.selectedImage = img;
  img.classList.add('selected-image');
  els.imageTools.classList.remove('hidden');
}

function clearSelectedImage() {
  if (stateRef.selectedImage) {
    stateRef.selectedImage.classList.remove('selected-image');
  }
  stateRef.selectedImage = null;
}

function hideImageTools() {
  clearSelectedImage();
  els.imageTools.classList.add('hidden');
}

function setImageAlignment(align) {
  if (!stateRef.selectedImage) return;
  stateRef.selectedImage.classList.remove('align-left', 'align-center', 'align-right');
  stateRef.selectedImage.classList.add(`align-${align}`);
  syncEditorIntoState();
}

function removeSelectedImage() {
  if (!stateRef.selectedImage) return;
  const nextFocus = stateRef.selectedImage.parentElement;
  stateRef.selectedImage.remove();
  hideImageTools();
  nextFocus?.focus?.();
  syncEditorIntoState();
}

function bindEvents() {
  document.getElementById('addSubjectBtn').addEventListener('click', addSubject);
  document.getElementById('addPageBtn').addEventListener('click', addPage);
  document.getElementById('saveBtn').addEventListener('click', saveAll);
  document.getElementById('reloadRemoteBtn').addEventListener('click', reloadFromRemote);
  document.getElementById('clearLocalBtn').addEventListener('click', async () => {
    const ok = await confirmModal('Helyi cache törlése', 'Biztosan törölni akarod a helyi cache-t? A GitHubban lévő adatok nem törlődnek.');
    if (!ok) return;
    clearLocalDraft();
    setStatus('Helyi cache törölve.', 'success');
    setSource('GitHub / statikus forrás');
  });

  document.getElementById('saveGithubConfigBtn').addEventListener('click', () => {
    const config = saveConfig(readFormConfig());
    populateConfigForm(config);
    saveLocalDraft(stateRef.state);
    setStatus('GitHub beállítás elmentve.', 'success');
  });
  document.getElementById('testGithubBtn').addEventListener('click', githubTestConnection);
  document.getElementById('toggleSettingsBtn').addEventListener('click', () => {
    els.settingsPanel.classList.toggle('hidden');
  });

  els.pageTitleInput.addEventListener('input', queueLocalAutosave);
  els.editor.addEventListener('input', queueLocalAutosave);

  els.editor.addEventListener('click', (event) => {
    if (event.target.tagName === 'IMG') {
      selectImage(event.target);
    } else {
      hideImageTools();
    }
  });

  els.editor.addEventListener('paste', (event) => {
    const items = [...(event.clipboardData?.items || [])];
    const imageItem = items.find(item => item.type.startsWith('image/'));
    if (!imageItem) return;
    event.preventDefault();
    insertImageFromFile(imageItem.getAsFile());
  });

  document.querySelectorAll('[data-cmd]').forEach(btn => {
    btn.addEventListener('click', () => {
      els.editor.focus();
      document.execCommand(btn.dataset.cmd, false, null);
      syncEditorIntoState();
    });
  });

  document.getElementById('h2Btn').addEventListener('click', applyHeading);
  document.getElementById('quoteBtn').addEventListener('click', applyQuote);
  document.getElementById('insertImageBtn').addEventListener('click', () => els.imageInput.click());
  els.imageInput.addEventListener('change', (event) => {
    const [file] = event.target.files || [];
    insertImageFromFile(file);
    event.target.value = '';
  });

  document.querySelectorAll('.align-btn').forEach(btn => {
    btn.addEventListener('click', () => setImageAlignment(btn.dataset.align));
  });
  document.getElementById('removeImageBtn').addEventListener('click', removeSelectedImage);

  els.modalCancel.addEventListener('click', () => closeModal(false));
  els.modalConfirm.addEventListener('click', () => closeModal(true));
  els.modalBackdrop.addEventListener('click', (event) => {
    if (event.target === els.modalBackdrop) closeModal(false);
  });

  window.addEventListener('beforeunload', () => {
    syncEditorIntoState();
    saveLocalDraft();
  });
}

bindEvents();
bootstrap();
