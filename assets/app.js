import { createClient } from 'https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2/+esm';

const APP_VERSION = 3;
const STATIC_DATA_PATH = 'data/content.json';
const SINGLETON_ROW_ID = 1;
const PATH_SCOPE = hashString(window.location.pathname || 'root');
const CONFIG_KEY = `erettsegi_supabase_config_${PATH_SCOPE}_v1`;
const LOCAL_STATE_KEY = `erettsegi_supabase_state_${PATH_SCOPE}_v1`;
const SAVE_DEBOUNCE_MS = 0;
const GITHUB_TEXT_SYNC_DEBOUNCE_MS = 800;
const DEFAULT_IMAGE_BUCKET = 'page-images';
const DEFAULT_SYNC_FUNCTION = 'sync-github';
const DEFAULT_GITHUB_BRANCH = 'main';
const GITHUB_CONTENT_PATH = 'data/content.json';
const GITHUB_BACKUP_COOLDOWN_MS = 120000;

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
  sbUrl: document.getElementById('sbUrl'),
  sbAnonKey: document.getElementById('sbAnonKey'),
  sbBucket: document.getElementById('sbBucket'),
  syncFunctionName: document.getElementById('syncFunctionName'),
  ghOwner: document.getElementById('ghOwner'),
  ghRepo: document.getElementById('ghRepo'),
  ghBranch: document.getElementById('ghBranch'),
  ghToken: document.getElementById('ghToken'),
  autoGithubToggle: document.getElementById('autoGithubToggle'),
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
  autosaveTimer: null,
  githubSyncTimer: null,
  modalResolver: null,
  loadedSource: 'Kezdés',
  supabase: null,
  realtimeChannel: null,
  clientId: uid('client'),
  remoteRevision: 0,
  localVersion: 0,
  syncedVersion: 0,
  hasUnsavedLocalChanges: false,
  saveInFlight: false,
  saveRequested: false,
  pendingSaveOptions: { reason: 'Mentés', triggerGithub: true, immediateGithub: false, forceBackup: false },
  githubSyncInFlight: false,
  githubSyncRequested: false,
  pendingGithubOptions: { reason: 'GitHub sync', immediate: false, forceBackup: false },
  lastStatusAt: 0,
  lastRemoteEditorId: null,
  githubSyncAvailable: true,
  lastGithubSyncedFingerprint: '',
  lastGithubBackupAt: 0,
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

function hashString(text) {
  let hash = 0;
  const normalized = String(text ?? '');
  for (let index = 0; index < normalized.length; index += 1) {
    hash = ((hash << 5) - hash) + normalized.charCodeAt(index);
    hash |= 0;
  }
  return `h${Math.abs(hash)}`;
}

function stateFingerprint(state) {
  return hashString(JSON.stringify(normalizeState(state)));
}

function mergeSaveOptions(current, next = {}) {
  return {
    reason: next.reason || current?.reason || 'Mentés',
    triggerGithub: next.triggerGithub !== false || current?.triggerGithub !== false,
    immediateGithub: Boolean(current?.immediateGithub || next.immediateGithub),
    forceBackup: Boolean(current?.forceBackup || next.forceBackup),
  };
}

function mergeGithubOptions(current, next = {}) {
  return {
    reason: next.reason || current?.reason || 'GitHub sync',
    immediate: Boolean(current?.immediate || next.immediate),
    forceBackup: Boolean(current?.forceBackup || next.forceBackup),
  };
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

function normalizeState(raw) {
  const base = raw && typeof raw === 'object' ? raw : createEmptyState();
  return {
    version: APP_VERSION,
    updatedAt: base.updatedAt || nowIso(),
    subjects: Array.isArray(base.subjects)
      ? base.subjects.map(subject => {
          const subjectCreated = subject.createdAt || subject.updatedAt || nowIso();
          return {
            id: subject.id || uid('subject'),
            title: subject.title || 'Névtelen tantárgy',
            createdAt: subjectCreated,
            updatedAt: subject.updatedAt || subjectCreated,
            pages: Array.isArray(subject.pages)
              ? subject.pages.map(page => {
                  const pageCreated = page.createdAt || page.updatedAt || nowIso();
                  return {
                    id: page.id || uid('page'),
                    title: page.title || 'Névtelen oldal',
                    content: page.content || '',
                    createdAt: pageCreated,
                    updatedAt: page.updatedAt || pageCreated,
                  };
                })
              : [],
          };
        })
      : [],
    deletedSubjects: Array.isArray(base.deletedSubjects)
      ? base.deletedSubjects.map(item => ({ id: item.id, updatedAt: item.updatedAt || nowIso() }))
      : [],
    deletedPages: Array.isArray(base.deletedPages)
      ? base.deletedPages.map(item => ({ id: item.id, subjectId: item.subjectId || null, updatedAt: item.updatedAt || nowIso() }))
      : [],
  };
}

function mergeStates(remoteRaw, localRaw) {
  const remote = normalizeState(remoteRaw);
  const local = normalizeState(localRaw);

  const subjectMap = new Map();
  const deletedSubjectMap = new Map();
  const deletedPageMap = new Map();

  for (const item of [...remote.deletedSubjects, ...local.deletedSubjects]) {
    const existing = deletedSubjectMap.get(item.id);
    if (!existing || getTimestampValue(item.updatedAt) > getTimestampValue(existing.updatedAt)) {
      deletedSubjectMap.set(item.id, { ...item });
    }
  }

  for (const item of [...remote.deletedPages, ...local.deletedPages]) {
    const existing = deletedPageMap.get(item.id);
    if (!existing || getTimestampValue(item.updatedAt) > getTimestampValue(existing.updatedAt)) {
      deletedPageMap.set(item.id, { ...item });
    }
  }

  for (const subject of [...remote.subjects, ...local.subjects]) {
    const existing = subjectMap.get(subject.id);
    if (!existing) {
      subjectMap.set(subject.id, deepClone(subject));
      continue;
    }
    const chosenSubject = chooseNewer(existing, subject);
    const pageMap = new Map();
    for (const page of [...existing.pages, ...subject.pages]) {
      const current = pageMap.get(page.id);
      pageMap.set(page.id, chooseNewer(current, page));
    }
    chosenSubject.pages = [...pageMap.values()].sort((a, b) => getTimestampValue(a.createdAt) - getTimestampValue(b.createdAt));
    subjectMap.set(subject.id, chosenSubject);
  }

  const mergedSubjects = [];

  for (const subject of subjectMap.values()) {
    const deletedSubject = deletedSubjectMap.get(subject.id);
    if (deletedSubject && getTimestampValue(deletedSubject.updatedAt) >= getTimestampValue(subject.updatedAt)) continue;

    const pageMap = new Map();
    for (const page of subject.pages) {
      const current = pageMap.get(page.id);
      pageMap.set(page.id, chooseNewer(current, page));
    }

    const chosenPages = [];
    for (const page of pageMap.values()) {
      const deletedPage = deletedPageMap.get(page.id);
      if (deletedPage && getTimestampValue(deletedPage.updatedAt) >= getTimestampValue(page.updatedAt)) continue;
      chosenPages.push(page);
    }

    subject.pages = chosenPages.sort((a, b) => getTimestampValue(a.createdAt) - getTimestampValue(b.createdAt));
    mergedSubjects.push(subject);
  }

  return {
    version: APP_VERSION,
    updatedAt: [remote.updatedAt, local.updatedAt, nowIso()].sort((a, b) => getTimestampValue(a) - getTimestampValue(b)).at(-1),
    subjects: mergedSubjects.sort((a, b) => getTimestampValue(a.createdAt) - getTimestampValue(b.createdAt)),
    deletedSubjects: [...deletedSubjectMap.values()].sort((a, b) => getTimestampValue(a.updatedAt) - getTimestampValue(b.updatedAt)),
    deletedPages: [...deletedPageMap.values()].sort((a, b) => getTimestampValue(a.updatedAt) - getTimestampValue(b.updatedAt)),
  };
}

function setStatus(message, tone = 'normal') {
  stateRef.lastStatusAt = Date.now();
  els.statusText.textContent = message;
  els.statusText.dataset.tone = tone;
}

function setSource(message) {
  stateRef.loadedSource = message;
  els.sourceText.textContent = message;
}

function getConfig() {
  const raw = safeJsonParse(localStorage.getItem(CONFIG_KEY), {}) || {};
  return {
    supabaseUrl: raw.supabaseUrl || '',
    supabaseAnonKey: raw.supabaseAnonKey || '',
    imageBucket: raw.imageBucket || DEFAULT_IMAGE_BUCKET,
    syncFunction: raw.syncFunction || DEFAULT_SYNC_FUNCTION,
    githubOwner: raw.githubOwner || '',
    githubRepo: raw.githubRepo || '',
    githubBranch: raw.githubBranch || DEFAULT_GITHUB_BRANCH,
    githubToken: raw.githubToken || '',
    autoGithubSync: raw.autoGithubSync !== false,
    preferRemote: raw.preferRemote !== false,
  };
}

function saveConfig(config) {
  const next = {
    supabaseUrl: (config.supabaseUrl || '').trim(),
    supabaseAnonKey: (config.supabaseAnonKey || '').trim(),
    imageBucket: (config.imageBucket || DEFAULT_IMAGE_BUCKET).trim() || DEFAULT_IMAGE_BUCKET,
    syncFunction: (config.syncFunction || DEFAULT_SYNC_FUNCTION).trim(),
    githubOwner: (config.githubOwner || '').trim(),
    githubRepo: (config.githubRepo || '').trim(),
    githubBranch: (config.githubBranch || DEFAULT_GITHUB_BRANCH).trim() || DEFAULT_GITHUB_BRANCH,
    githubToken: (config.githubToken || '').trim(),
    autoGithubSync: Boolean(config.autoGithubSync),
    preferRemote: Boolean(config.preferRemote),
  };
  localStorage.setItem(CONFIG_KEY, JSON.stringify(next));
  return next;
}

function readFormConfig() {
  return {
    supabaseUrl: els.sbUrl.value,
    supabaseAnonKey: els.sbAnonKey.value,
    imageBucket: els.sbBucket.value,
    syncFunction: els.syncFunctionName.value,
    githubOwner: els.ghOwner.value,
    githubRepo: els.ghRepo.value,
    githubBranch: els.ghBranch.value,
    githubToken: els.ghToken.value,
    autoGithubSync: els.autoGithubToggle.checked,
    preferRemote: els.preferRemoteToggle.checked,
  };
}

function populateConfigForm(config) {
  els.sbUrl.value = config.supabaseUrl || '';
  els.sbAnonKey.value = config.supabaseAnonKey || '';
  els.sbBucket.value = config.imageBucket || DEFAULT_IMAGE_BUCKET;
  els.syncFunctionName.value = config.syncFunction || DEFAULT_SYNC_FUNCTION;
  els.ghOwner.value = config.githubOwner || '';
  els.ghRepo.value = config.githubRepo || '';
  els.ghBranch.value = config.githubBranch || DEFAULT_GITHUB_BRANCH;
  els.ghToken.value = config.githubToken || '';
  els.autoGithubToggle.checked = config.autoGithubSync !== false;
  els.preferRemoteToggle.checked = config.preferRemote !== false;
}

function saveLocalDraft(state = stateRef.state) {
  localStorage.setItem(LOCAL_STATE_KEY, JSON.stringify(normalizeState(state)));
}

function loadLocalDraft() {
  return safeJsonParse(localStorage.getItem(LOCAL_STATE_KEY), null);
}

function clearLocalDraft() {
  localStorage.removeItem(LOCAL_STATE_KEY);
}

function currentConfigIsComplete(config = getConfig()) {
  return Boolean(config.supabaseUrl && config.supabaseAnonKey);
}

function hasEdgeFunctionConfig(config = getConfig()) {
  return Boolean((config.syncFunction || '').trim());
}

function hasDirectGithubConfig(config = getConfig()) {
  return Boolean(config.githubOwner && config.githubRepo && config.githubToken);
}

function hasAnyGithubSyncConfig(config = getConfig()) {
  return hasEdgeFunctionConfig(config) || hasDirectGithubConfig(config);
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
  stateRef.hasUnsavedLocalChanges = true;
  stateRef.localVersion += 1;
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
  if (els.pageTitleInput.value !== page.title) {
    els.pageTitleInput.value = page.title;
  }
  els.pageInfo.textContent = `Utolsó módosítás: ${formatDate(page.updatedAt)}`;
  if (document.activeElement !== els.editor && els.editor.innerHTML !== page.content) {
    els.editor.innerHTML = page.content || '';
  } else if (document.activeElement !== els.editor && !page.content && els.editor.innerHTML) {
    els.editor.innerHTML = '';
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

function buildStarterState() {
  const timestamp = nowIso();
  return normalizeState({
    version: APP_VERSION,
    updatedAt: timestamp,
    subjects: [{
      id: uid('subject'),
      title: 'Első tantárgy',
      createdAt: timestamp,
      updatedAt: timestamp,
      pages: [{
        id: uid('page'),
        title: 'Első oldal',
        content: '<p>Kezdhetsz írni ide.</p>',
        createdAt: timestamp,
        updatedAt: timestamp,
      }],
    }],
    deletedSubjects: [],
    deletedPages: [],
  });
}

function isStateEffectivelyEmpty(state) {
  const normalized = normalizeState(state);
  return normalized.subjects.length === 0;
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
  requestRemoteSave({ immediate: true, reason: 'Új tantárgy', triggerGithub: true, immediateGithub: true, forceBackup: true });
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
  requestRemoteSave({ immediate: true, reason: 'Tantárgy átnevezése', triggerGithub: true, immediateGithub: true, forceBackup: true });
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
  requestRemoteSave({ immediate: true, reason: 'Tantárgy törlése', triggerGithub: true, immediateGithub: true, forceBackup: true });
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
  requestRemoteSave({ immediate: true, reason: 'Új oldal', triggerGithub: true, immediateGithub: true, forceBackup: true });
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
  requestRemoteSave({ immediate: true, reason: 'Oldal átnevezése', triggerGithub: true, immediateGithub: true, forceBackup: true });
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
  requestRemoteSave({ immediate: true, reason: 'Oldal törlése', triggerGithub: true, immediateGithub: true, forceBackup: true });
}

function syncEditorIntoState() {
  const page = getSelectedPage();
  const subject = getSelectedSubject();
  if (!page || !subject) return false;
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
  return changed;
}

function estimateInputWeight(event) {
  if (event?.inputType === 'insertFromPaste') {
    return Math.max(event.data?.length || 0, 1);
  }
  if (typeof event?.data === 'string' && event.data.length) {
    return event.data.length;
  }
  return 1;
}

function queueRealtimeAutosave(event) {
  const changed = syncEditorIntoState();
  if (!changed) return;
  const immediateGithub = String(event?.inputType || '').includes('delete') || event?.inputType === 'insertFromPaste';
  requestRemoteSave({
    immediate: false,
    delay: SAVE_DEBOUNCE_MS,
    reason: 'Automatikus mentés',
    triggerGithub: true,
    immediateGithub,
    forceBackup: false,
  });
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

function createSupabaseBrowserClient(config = getConfig()) {
  return createClient(config.supabaseUrl, config.supabaseAnonKey, {
    auth: {
      persistSession: false,
      autoRefreshToken: false,
      detectSessionInUrl: false,
    },
  });
}

function getSupabase() {
  if (!stateRef.supabase) {
    const config = getConfig();
    if (!currentConfigIsComplete(config)) return null;
    stateRef.supabase = createSupabaseBrowserClient(config);
  }
  return stateRef.supabase;
}

function resetSupabaseClient() {
  if (stateRef.realtimeChannel) {
    stateRef.supabase?.removeChannel?.(stateRef.realtimeChannel);
    stateRef.realtimeChannel = null;
  }
  stateRef.supabase = null;
  stateRef.remoteRevision = 0;
}

function disableGithubSyncTemporarily(message) {
  stateRef.githubSyncAvailable = false;
  window.clearTimeout(stateRef.githubSyncTimer);
  stateRef.githubSyncRequested = false;
  stateRef.pendingGithubOptions = { reason: 'GitHub sync', immediate: false, forceBackup: false };
  setSource('Supabase élő adat');
  setStatus(message || 'Supabase mentve. A GitHub háttérmentés most nem elérhető, de a szerkesztés megy tovább.', 'warning');
}

function enableGithubSyncAgain() {
  stateRef.githubSyncAvailable = true;
}

async function fetchRemoteRow() {
  const supabase = getSupabase();
  if (!supabase) return null;
  const { data, error } = await supabase
    .from('app_state')
    .select('id, data, revision, updated_at, editor_id')
    .eq('id', SINGLETON_ROW_ID)
    .maybeSingle();
  if (error) throw error;
  return data || null;
}

async function insertInitialRemoteRow(seedState) {
  const supabase = getSupabase();
  const payload = normalizeState(seedState);
  payload.updatedAt = nowIso();
  const { data, error } = await supabase
    .from('app_state')
    .insert({
      id: SINGLETON_ROW_ID,
      data: payload,
      revision: 1,
      updated_at: nowIso(),
      editor_id: stateRef.clientId,
    })
    .select('id, data, revision, updated_at, editor_id')
    .single();

  if (error) {
    if (String(error.code || '') === '23505') {
      return fetchRemoteRow();
    }
    throw error;
  }
  return data;
}

async function ensureRemoteRow(seedState) {
  let row = await fetchRemoteRow();
  if (row) return row;
  return insertInitialRemoteRow(seedState);
}

function applyRemoteRow(row, options = {}) {
  if (!row) return;
  const remoteState = normalizeState(row.data);
  const remoteRevision = Number(row.revision || 0);
  const incomingFingerprint = stateFingerprint(remoteState);
  const currentFingerprint = stateFingerprint(stateRef.state);

  stateRef.remoteRevision = remoteRevision;
  stateRef.lastRemoteEditorId = row.editor_id || null;

  if (options.merge) {
    stateRef.state = mergeStates(remoteState, stateRef.state);
  } else {
    stateRef.state = remoteState;
  }

  saveLocalDraft();
  if (incomingFingerprint !== currentFingerprint || options.forceRender) {
    render();
  }
}

function getEditorSignature() {
  return `${stateRef.selectedSubjectId || ''}:${stateRef.selectedPageId || ''}`;
}

async function performRemoteSave(options = {}) {
  const supabase = getSupabase();
  if (!supabase) {
    setSource('Helyi draft');
    setStatus('Helyi mentés kész. Supabase beállítás kell a közös szinkronhoz.', 'warning');
    return false;
  }

  syncEditorIntoState();
  saveLocalDraft();

  let targetVersion = stateRef.localVersion;
  let localStateToSave = normalizeState(deepClone(stateRef.state));
  localStateToSave.updatedAt = nowIso();
  const editorSignature = getEditorSignature();

  setStatus('Supabase mentés folyamatban...');

  for (let attempt = 0; attempt < 12; attempt += 1) {
    if (stateRef.remoteRevision <= 0) {
      const row = await ensureRemoteRow(localStateToSave);
      if (!row) throw new Error('A közös adat nem hozható létre.');
      stateRef.remoteRevision = Number(row.revision || 0);
      if (row.editor_id === stateRef.clientId && stateFingerprint(normalizeState(row.data)) === stateFingerprint(localStateToSave)) {
        break;
      }
    }

    const nextRevision = stateRef.remoteRevision + 1;
    const { data, error } = await supabase
      .from('app_state')
      .update({
        data: localStateToSave,
        revision: nextRevision,
        updated_at: nowIso(),
        editor_id: stateRef.clientId,
      })
      .eq('id', SINGLETON_ROW_ID)
      .eq('revision', stateRef.remoteRevision)
      .select('id, data, revision, updated_at, editor_id')
      .maybeSingle();

    if (error) {
      throw error;
    }

    if (data) {
      stateRef.remoteRevision = Number(data.revision || nextRevision);
      if (stateRef.localVersion > targetVersion) {
        stateRef.syncedVersion = Math.max(stateRef.syncedVersion, targetVersion);
        stateRef.hasUnsavedLocalChanges = stateRef.syncedVersion < stateRef.localVersion;
        saveLocalDraft();
      } else {
        stateRef.state = normalizeState(data.data);
        stateRef.syncedVersion = stateRef.localVersion;
        stateRef.hasUnsavedLocalChanges = false;
        saveLocalDraft();
        if (document.activeElement !== els.editor || editorSignature !== getEditorSignature()) {
          render();
        }
      }
      setSource('Supabase élő adat');
      setStatus('Supabase mentés kész.', 'success');
      if (options.triggerGithub !== false) {
        requestGithubSync({
          reason: options.reason || 'GitHub sync',
          immediate: Boolean(options.immediateGithub),
          forceBackup: Boolean(options.forceBackup),
        });
      }
      return true;
    }

    const remoteRow = await fetchRemoteRow();
    if (!remoteRow) {
      const inserted = await insertInitialRemoteRow(localStateToSave);
      stateRef.remoteRevision = Number(inserted?.revision || 1);
      continue;
    }

    stateRef.remoteRevision = Number(remoteRow.revision || 0);
    const remoteState = normalizeState(remoteRow.data);
    stateRef.state = mergeStates(remoteState, stateRef.state);
    saveLocalDraft();
    localStateToSave = normalizeState(deepClone(stateRef.state));
    localStateToSave.updatedAt = nowIso();
    targetVersion = stateRef.localVersion;
  }

  setStatus('Mentési ütközés volt, újrapróbáltam a legfrissebb állapottal.', 'warning');
  return false;
}

function requestRemoteSave(options = {}) {
  syncEditorIntoState();
  saveLocalDraft();

  if (!currentConfigIsComplete()) {
    setSource('Helyi draft');
    setStatus('Helyi mentés kész. Supabase URL és kulcs kell a közös mentéshez.', 'warning');
    return;
  }

  stateRef.pendingSaveOptions = mergeSaveOptions(stateRef.pendingSaveOptions, options);
  stateRef.saveRequested = true;
  window.clearTimeout(stateRef.autosaveTimer);
  const delay = options.immediate ? 0 : (options.delay ?? SAVE_DEBOUNCE_MS);
  stateRef.autosaveTimer = window.setTimeout(() => {
    stateRef.autosaveTimer = null;
    flushPendingRemoteSave();
  }, delay);
}

async function flushPendingRemoteSave() {
  if (stateRef.saveInFlight) return;
  if (!currentConfigIsComplete()) return;

  stateRef.saveInFlight = true;

  try {
    while (stateRef.saveRequested || stateRef.hasUnsavedLocalChanges || stateRef.syncedVersion < stateRef.localVersion) {
      stateRef.saveRequested = false;
      const options = { ...stateRef.pendingSaveOptions };
      stateRef.pendingSaveOptions = { reason: 'Mentés', triggerGithub: true, immediateGithub: false, forceBackup: false };
      try {
        await performRemoteSave(options);
      } catch (error) {
        const message = error?.message || 'Ismeretlen Supabase mentési hiba.';
        setStatus(`Supabase mentési hiba: ${message}`, 'error');
        stateRef.saveRequested = true;
        await sleep(300);
      }
    }
  } finally {
    stateRef.saveInFlight = false;
    if (stateRef.saveRequested || stateRef.hasUnsavedLocalChanges || stateRef.syncedVersion < stateRef.localVersion) {
      window.setTimeout(() => flushPendingRemoteSave(), 0);
    }
  }
}

function requestGithubSync(options = {}) {
  const config = getConfig();
  if (!stateRef.githubSyncAvailable || !config.autoGithubSync || !hasAnyGithubSyncConfig(config) || !currentConfigIsComplete(config)) return;
  stateRef.pendingGithubOptions = mergeGithubOptions(stateRef.pendingGithubOptions, options);
  stateRef.githubSyncRequested = true;
  window.clearTimeout(stateRef.githubSyncTimer);
  const delay = options.immediate ? 0 : GITHUB_TEXT_SYNC_DEBOUNCE_MS;
  stateRef.githubSyncTimer = window.setTimeout(() => {
    stateRef.githubSyncTimer = null;
    flushGithubSync();
  }, delay);
}

async function flushGithubSync() {
  if (stateRef.githubSyncInFlight) return;
  const config = getConfig();
  const supabase = getSupabase();
  if (!stateRef.githubSyncAvailable || !config.autoGithubSync || !hasAnyGithubSyncConfig(config)) return;

  stateRef.githubSyncInFlight = true;
  try {
    while (stateRef.githubSyncRequested) {
      stateRef.githubSyncRequested = false;
      const options = { ...stateRef.pendingGithubOptions };
      stateRef.pendingGithubOptions = { reason: 'GitHub sync', immediate: false, forceBackup: false };

      let edgeErrorMessage = '';
      let handled = false;

      if (hasEdgeFunctionConfig(config) && supabase) {
        const { data, error } = await supabase.functions.invoke(config.syncFunction, {
          body: {
            reason: options.reason || 'Mentés',
            force: Boolean(options.immediate),
            forceBackup: Boolean(options.forceBackup),
            pagePath: window.location.pathname,
          },
        });

        if (!error) {
          handled = true;
          if (data?.status === 'ok') {
            setSource('Supabase élő adat + GitHub háttérmentés');
            setStatus('Supabase mentve, GitHub háttérmentés is kész.', 'success');
          } else if (data?.status === 'noop') {
            setSource('Supabase élő adat + GitHub szinkronban');
          } else if (data?.status === 'cooldown') {
            setSource('Supabase élő adat + GitHub rövid késleltetéssel');
          }
        } else {
          edgeErrorMessage = error.message || 'ismeretlen';
        }
      }

      if (!handled && hasDirectGithubConfig(config)) {
        const result = await directGithubSync(options, config);
        handled = true;
        if (result?.status === 'ok') {
          setSource('Supabase élő adat + közvetlen GitHub mentés');
          if (edgeErrorMessage) {
            setStatus(`Supabase mentve. Az Edge Function hibázott, ezért közvetlen GitHub mentésre váltottam (${edgeErrorMessage}).`, 'warning');
          } else {
            setStatus('Supabase mentve, GitHub közvetlen mentés is kész.', 'success');
          }
        } else if (result?.status === 'noop') {
          setSource('Supabase élő adat + GitHub szinkronban');
        }
      }

      if (!handled && edgeErrorMessage) {
        disableGithubSyncTemporarily(`Supabase mentve. A GitHub háttérmentés most nem elérhető (${edgeErrorMessage}), de a szerkesztés megy tovább.`);
        return;
      }
    }
  } finally {
    stateRef.githubSyncInFlight = false;
    if (stateRef.githubSyncRequested) {
      window.setTimeout(() => flushGithubSync(), 0);
    }
  }
}

async function saveAll() {
  syncEditorIntoState();
  saveLocalDraft();
  if (!currentConfigIsComplete()) {
    setSource('Helyi draft');
    setStatus('Helyi mentés kész. Supabase mentéshez töltsd ki a beállításokat.', 'warning');
    return;
  }
  requestRemoteSave({ immediate: true, reason: 'Kézi mentés', triggerGithub: true, immediateGithub: true, forceBackup: true });
}

async function reloadFromRemote() {
  if (!currentConfigIsComplete()) {
    setStatus('Nincs beállított Supabase kapcsolat.', 'warning');
    return;
  }
  syncEditorIntoState();
  setStatus('Közös adat újratöltése...');
  try {
    const row = await fetchRemoteRow();
    if (!row) {
      setStatus('Még nincs közös adat a Supabase-ben.', 'warning');
      return;
    }
    const mergedState = mergeStates(normalizeState(row.data), stateRef.state);
    stateRef.state = mergedState;
    stateRef.remoteRevision = Number(row.revision || 0);
    saveLocalDraft();
    render();
    setSource('Supabase élő adat');
    setStatus('A közös adat betöltve és összefésülve.', 'success');
  } catch (error) {
    setStatus(`Újratöltési hiba: ${error.message || 'ismeretlen'}`, 'error');
  }
}

async function testSupabaseConnection() {
  const config = readFormConfig();
  if (!currentConfigIsComplete(config)) {
    setStatus('Add meg a Supabase URL-t és az anon / publishable kulcsot.', 'warning');
    return;
  }

  setStatus('Supabase kapcsolat teszt fut...');
  try {
    const supabase = createSupabaseBrowserClient(config);
    const { error } = await supabase.from('app_state').select('id, revision').eq('id', SINGLETON_ROW_ID).maybeSingle();
    if (error) throw error;

    if (config.autoGithubSync && hasAnyGithubSyncConfig(config)) {
      let edgeOk = false;
      let edgeMessage = '';

      if (hasEdgeFunctionConfig(config)) {
        const probe = await supabase.functions.invoke(config.syncFunction, { body: { dryRun: true } });
        if (probe.error) {
          edgeMessage = probe.error.message || 'ismeretlen';
        } else {
          edgeOk = true;
        }
      }

      if (!edgeOk && hasDirectGithubConfig(config)) {
        await testDirectGithubConnection(config);
        enableGithubSyncAgain();
        setStatus(edgeMessage
          ? `Supabase rendben. Az Edge Function most nem elérhető (${edgeMessage}), de a közvetlen GitHub mentés rendben.`
          : 'Supabase és közvetlen GitHub mentés rendben.', 'success');
        return;
      }

      if (edgeOk) {
        enableGithubSyncAgain();
        setStatus('Supabase és GitHub sync function rendben.', 'success');
      } else if (edgeMessage) {
        disableGithubSyncTemporarily(`Supabase rendben. A GitHub háttérmentés most nem elérhető (${edgeMessage}), de a szerkesztés és a realtime működik.`);
      } else {
        setStatus('Supabase kapcsolat rendben.', 'success');
      }
    } else {
      setStatus('Supabase kapcsolat rendben.', 'success');
    }
  } catch (error) {
    setStatus(`Kapcsolati hiba: ${error.message || 'ismeretlen'}`, 'error');
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

function subscribeRealtime() {
  const supabase = getSupabase();
  if (!supabase) return;

  if (stateRef.realtimeChannel) {
    supabase.removeChannel(stateRef.realtimeChannel);
    stateRef.realtimeChannel = null;
  }

  stateRef.realtimeChannel = supabase
    .channel(`app-state-${PATH_SCOPE}`)
    .on(
      'postgres_changes',
      { event: '*', schema: 'public', table: 'app_state', filter: `id=eq.${SINGLETON_ROW_ID}` },
      (payload) => {
        const nextRow = payload.new;
        if (!nextRow) return;
        const nextRevision = Number(nextRow.revision || 0);
        if (nextRevision <= stateRef.remoteRevision) return;

        stateRef.remoteRevision = nextRevision;
        stateRef.lastRemoteEditorId = nextRow.editor_id || null;

        if (nextRow.editor_id === stateRef.clientId) {
          setSource('Supabase élő adat');
          return;
        }

        const remoteState = normalizeState(nextRow.data);
        const currentFingerprint = stateFingerprint(stateRef.state);
        const mergedState = (stateRef.hasUnsavedLocalChanges || stateRef.saveInFlight)
          ? mergeStates(remoteState, stateRef.state)
          : remoteState;
        const nextFingerprint = stateFingerprint(mergedState);
        stateRef.state = mergedState;
        saveLocalDraft();

        if (nextFingerprint !== currentFingerprint && document.activeElement !== els.editor) {
          render();
        }

        if (stateRef.hasUnsavedLocalChanges) {
          requestRemoteSave({ immediate: true, reason: 'Realtime összefésülés', triggerGithub: true, immediateGithub: false, forceBackup: false });
        }

        setSource('Supabase élő adat');
        setStatus('Közös adat frissült.', 'success');
      }
    )
    .subscribe((status) => {
      if (status === 'SUBSCRIBED') {
        setSource('Supabase élő adat');
      }
    });
}

async function bootstrap() {
  const config = getConfig();
  populateConfigForm(config);

  const staticState = await loadStaticState();
  const localDraft = normalizeState(loadLocalDraft() || createEmptyState());
  let loaded = false;

  if (config.preferRemote && currentConfigIsComplete(config)) {
    try {
      getSupabase();
      const remoteRow = await ensureRemoteRow(mergeStates(staticState, localDraft));
      const mergedState = mergeStates(normalizeState(remoteRow.data), localDraft);
      stateRef.state = mergedState;
      stateRef.remoteRevision = Number(remoteRow.revision || 0);
      stateRef.syncedVersion = stateRef.localVersion;
      if (isStateEffectivelyEmpty(stateRef.state) && isStateEffectivelyEmpty(staticState) && isStateEffectivelyEmpty(localDraft)) {
        stateRef.state = buildStarterState();
        stateRef.hasUnsavedLocalChanges = true;
      }
      saveLocalDraft();
      setSource('Supabase élő adat');
      setStatus('Supabase adat betöltve.', 'success');
      subscribeRealtime();
      enableGithubSyncAgain();
      loaded = true;

      const remoteFingerprint = stateFingerprint(normalizeState(remoteRow.data));
      const mergedFingerprint = stateFingerprint(stateRef.state);
      if (mergedFingerprint !== remoteFingerprint) {
        stateRef.hasUnsavedLocalChanges = true;
        requestRemoteSave({ immediate: true, reason: 'Első összehangolás', triggerGithub: true, immediateGithub: true, forceBackup: true });
      }
    } catch (error) {
      setStatus(`Supabase betöltés sikertelen, fallback megy: ${error.message || 'ismeretlen'}`, 'warning');
      resetSupabaseClient();
    }
  }

  if (!loaded && loadLocalDraft()) {
    stateRef.state = localDraft;
    setSource('Helyi draft');
    setStatus('Helyi mentés betöltve.', 'success');
    loaded = true;
  }

  if (!loaded) {
    if (isStateEffectivelyEmpty(staticState) && isStateEffectivelyEmpty(localDraft)) {
      stateRef.state = buildStarterState();
      stateRef.hasUnsavedLocalChanges = true;
      saveLocalDraft();
      setSource('Kezdőadat');
      setStatus('Létrehoztam egy kezdő tantárgyat és oldalt, hogy egyből tudj szerkeszteni.', 'success');
      if (currentConfigIsComplete(config)) {
        requestRemoteSave({ immediate: true, reason: 'Kezdőadat létrehozása', triggerGithub: true, immediateGithub: true, forceBackup: true });
      }
    } else {
      stateRef.state = staticState;
      setSource('Statikus fájl');
      setStatus('Kezdőadat betöltve.', 'success');
    }
  }

  ensureSelectionValid();
  render();
}

function applyHeading() {
  document.execCommand('formatBlock', false, 'h2');
  syncEditorIntoState();
  requestRemoteSave({ immediate: true, reason: 'Formázás mentése', triggerGithub: true, immediateGithub: true, forceBackup: false });
}

function applyQuote() {
  document.execCommand('formatBlock', false, 'blockquote');
  syncEditorIntoState();
  requestRemoteSave({ immediate: true, reason: 'Formázás mentése', triggerGithub: true, immediateGithub: true, forceBackup: false });
}

async function uploadImageFile(file) {
  if (!file) return null;
  const config = getConfig();
  const supabase = getSupabase();
  if (!supabase || !currentConfigIsComplete(config)) {
    return readFileAsDataUrl(file);
  }

  const subjectId = stateRef.selectedSubjectId || 'general';
  const pageId = stateRef.selectedPageId || 'draft';
  const cleanName = (file.name || 'kep.png').replace(/[^a-zA-Z0-9._-]/g, '_');
  const filePath = `${subjectId}/${pageId}/${Date.now()}-${cleanName}`;

  const { error } = await supabase.storage
    .from(config.imageBucket)
    .upload(filePath, file, { upsert: false, cacheControl: '3600' });

  if (error) {
    throw error;
  }

  const { data } = supabase.storage.from(config.imageBucket).getPublicUrl(filePath);
  return data.publicUrl;
}

function readFileAsDataUrl(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result);
    reader.onerror = () => reject(new Error('A kép nem olvasható.'));
    reader.readAsDataURL(file);
  });
}

async function insertImageFromFile(file) {
  if (!file) return;
  try {
    setStatus('Kép feltöltése folyamatban...');
    const src = await uploadImageFile(file);
    insertImageAtCaret(src);
    syncEditorIntoState();
    requestRemoteSave({ immediate: true, reason: 'Kép mentése', triggerGithub: true, immediateGithub: true, forceBackup: false });
    setStatus('Kép beszúrva.', 'success');
  } catch (error) {
    setStatus(`Képfeltöltési hiba: ${error.message || 'ismeretlen'}`, 'error');
  }
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
  requestRemoteSave({ immediate: true, reason: 'Kép igazítás mentése', triggerGithub: true, immediateGithub: true, forceBackup: false });
}

function removeSelectedImage() {
  if (!stateRef.selectedImage) return;
  const nextFocus = stateRef.selectedImage.parentElement;
  stateRef.selectedImage.remove();
  hideImageTools();
  nextFocus?.focus?.();
  syncEditorIntoState();
  requestRemoteSave({ immediate: true, reason: 'Kép törlése', triggerGithub: true, immediateGithub: true, forceBackup: false });
}


async function testDirectGithubConnection(config = getConfig()) {
  if (!hasDirectGithubConfig(config)) {
    throw new Error('Hiányzik a GitHub owner / repo / token a közvetlen mentéshez.');
  }
  await githubGetFileBrowser({
    owner: config.githubOwner,
    repo: config.githubRepo,
    branch: config.githubBranch || DEFAULT_GITHUB_BRANCH,
    token: config.githubToken,
    path: GITHUB_CONTENT_PATH,
  });
  return true;
}

async function directGithubSync(options = {}, config = getConfig()) {
  if (!hasDirectGithubConfig(config)) {
    throw new Error('Hiányzik a közvetlen GitHub mentés beállítása.');
  }

  const snapshot = normalizeState(deepClone(stateRef.state));
  const contentText = JSON.stringify(snapshot, null, 2);
  const fingerprint = hashString(contentText);

  if (!options.forceBackup && stateRef.lastGithubSyncedFingerprint === fingerprint) {
    return { status: 'noop' };
  }

  const timestampLabel = new Date().toLocaleString('hu-HU');
  await putGithubFileBrowser({
    owner: config.githubOwner,
    repo: config.githubRepo,
    branch: config.githubBranch || DEFAULT_GITHUB_BRANCH,
    token: config.githubToken,
    path: GITHUB_CONTENT_PATH,
    contentText,
    message: `${options.reason || 'Közvetlen GitHub sync'} · ${timestampLabel}`,
  });

  let backupCreated = false;
  const now = Date.now();
  if (options.forceBackup || !stateRef.lastGithubBackupAt || (now - stateRef.lastGithubBackupAt) >= GITHUB_BACKUP_COOLDOWN_MS) {
    const backupTimestamp = new Date().toISOString();
    const backupText = JSON.stringify({
      savedAt: backupTimestamp,
      source: 'browser-direct-github-sync',
      data: snapshot,
    }, null, 2);

    await putGithubFileBrowser({
      owner: config.githubOwner,
      repo: config.githubRepo,
      branch: config.githubBranch || DEFAULT_GITHUB_BRANCH,
      token: config.githubToken,
      path: `backup/content-${backupTimestamp.replace(/[:.]/g, '-')}.json`,
      contentText: backupText,
      message: `Backup · ${timestampLabel}`,
    });
    stateRef.lastGithubBackupAt = now;
    backupCreated = true;
  }

  stateRef.lastGithubSyncedFingerprint = fingerprint;
  return { status: 'ok', backupCreated };
}

async function putGithubFileBrowser({ owner, repo, branch, token, path, contentText, message }) {
  let latestSha = null;

  for (let attempt = 0; attempt < 6; attempt += 1) {
    const currentFile = await githubGetFileBrowser({ owner, repo, branch, token, path });
    latestSha = currentFile.sha;

    const response = await fetch(`https://api.github.com/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/contents/${path}`, {
      method: 'PUT',
      headers: {
        'Accept': 'application/vnd.github+json',
        'Authorization': `Bearer ${token}`,
        'X-GitHub-Api-Version': '2022-11-28',
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        message,
        content: utf8ToBase64(contentText),
        branch,
        ...(latestSha ? { sha: latestSha } : {}),
      }),
    });

    const rawText = await response.text();
    const data = safeJsonParse(rawText, rawText);
    if (response.ok) {
      return data;
    }
    if (response.status === 409) {
      await sleep(250 * (attempt + 1));
      continue;
    }
    throw new Error(`GitHub hiba ${response.status}: ${typeof data === 'object' ? data?.message || 'ismeretlen' : rawText}`);
  }

  throw new Error('A GitHub mentés 409 konfliktus miatt többször sem ment át.');
}

async function githubGetFileBrowser({ owner, repo, branch, token, path }) {
  const response = await fetch(`https://api.github.com/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/contents/${path}?ref=${encodeURIComponent(branch)}`, {
    headers: {
      'Accept': 'application/vnd.github+json',
      'Authorization': `Bearer ${token}`,
      'X-GitHub-Api-Version': '2022-11-28',
    },
  });

  if (response.status === 404) {
    return { sha: null };
  }

  const rawText = await response.text();
  const data = safeJsonParse(rawText, rawText);
  if (!response.ok) {
    throw new Error(`GitHub olvasási hiba ${response.status}: ${typeof data === 'object' ? data?.message || 'ismeretlen' : rawText}`);
  }

  return { sha: data?.sha || null };
}

function utf8ToBase64(text) {
  return btoa(unescape(encodeURIComponent(text)));
}

function sleep(ms) {
  return new Promise(resolve => window.setTimeout(resolve, ms));
}

function bindEvents() {
  document.getElementById('addSubjectBtn').addEventListener('click', addSubject);
  document.getElementById('addPageBtn').addEventListener('click', addPage);
  document.getElementById('saveBtn').addEventListener('click', saveAll);
  document.getElementById('reloadRemoteBtn').addEventListener('click', reloadFromRemote);
  document.getElementById('clearLocalBtn').addEventListener('click', async () => {
    const ok = await confirmModal('Helyi cache törlése', 'Biztosan törölni akarod a helyi cache-t? A Supabase-ben és GitHubban lévő adatok nem törlődnek.');
    if (!ok) return;
    clearLocalDraft();
    setStatus('Helyi cache törölve.', 'success');
    setSource('Supabase / statikus forrás');
  });

  document.getElementById('saveSupabaseConfigBtn').addEventListener('click', () => {
    const config = saveConfig(readFormConfig());
    populateConfigForm(config);
    resetSupabaseClient();
    enableGithubSyncAgain();
    saveLocalDraft(stateRef.state);
    bootstrap();
    setStatus('Supabase beállítás elmentve.', 'success');
  });
  document.getElementById('testSupabaseBtn').addEventListener('click', testSupabaseConnection);
  document.getElementById('toggleSettingsBtn').addEventListener('click', () => {
    els.settingsPanel.classList.toggle('hidden');
  });

  els.pageTitleInput.addEventListener('input', queueRealtimeAutosave);
  els.editor.addEventListener('input', queueRealtimeAutosave);

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
      requestRemoteSave({ immediate: true, reason: 'Formázás mentése', triggerGithub: true, immediateGithub: true, forceBackup: false });
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
