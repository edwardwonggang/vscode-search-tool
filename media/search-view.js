(function () {
  const vscode = acquireVsCodeApi();
  const bootstrap = window.RIPGREP_TOOL_BOOTSTRAP || {};
  const defaultRemotePort = Number(bootstrap.defaultRemotePort || 22);
  const defaultIncludeGlobs = Array.isArray(bootstrap.defaultIncludeGlobs) ? bootstrap.defaultIncludeGlobs : [];
  const defaultExcludeGlobs = Array.isArray(bootstrap.defaultExcludeGlobs) ? bootstrap.defaultExcludeGlobs : [];
  const iconUris = bootstrap.iconUris || {};

  const queryEl = document.getElementById('query');
  const fileQueryEl = document.getElementById('fileQuery');
  const includeEl = document.getElementById('include');
  const excludeEl = document.getElementById('exclude');
  const caseSensitiveEl = document.getElementById('caseSensitive');
  const wholeWordEl = document.getElementById('wholeWord');
  const useRegexEl = document.getElementById('useRegex');
  const definitionModeEl = document.getElementById('definitionMode');
  const definitionModeToggleEl = document.getElementById('definitionModeToggle');
  const settingsButton = document.getElementById('settingsButton');
  const summaryTextEl = document.getElementById('summaryText');
  const workspaceNameEl = document.getElementById('workspaceName');
  const resultsEl = document.getElementById('results');
  const settingsLayerEl = document.getElementById('settingsLayer');
  const remoteHostInputEl = document.getElementById('remoteHostInput');
  const remotePortInputEl = document.getElementById('remotePortInput');
  const remoteUsernameInputEl = document.getElementById('remoteUsernameInput');
  const remotePasswordInputEl = document.getElementById('remotePasswordInput');
  const remoteSearchPathInputEl = document.getElementById('remoteSearchPathInput');
  const currentRemotePathValueEl = document.getElementById('currentRemotePathValue');
  const togglePasswordButtonEl = document.getElementById('togglePasswordButton');
  const togglePasswordIconEl = document.getElementById('togglePasswordIcon');
  const includeGlobsInputEl = document.getElementById('includeGlobsInput');
  const excludeGlobsInputEl = document.getElementById('excludeGlobsInput');
  const closeSettingsButtonEl = document.getElementById('closeSettingsButton');
  const connectButtonEl = document.getElementById('connectButton');
  const connectionStatusEl = document.getElementById('connectionStatus');
  const resetSettingsButtonEl = document.getElementById('resetSettingsButton');
  const saveSettingsButtonEl = document.getElementById('saveSettingsButton');
  const rebuildTagsButtonEl = document.getElementById('rebuildTagsButton');
  const ctagsProgressRowEl = document.getElementById('ctagsProgressRow');

  const vscodeState = vscode.getState() || {};
  const togglePairs = [
    [document.getElementById('caseSensitiveToggle'), caseSensitiveEl],
    [document.getElementById('wholeWordToggle'), wholeWordEl],
    [document.getElementById('useRegexToggle'), useRegexEl],
    [definitionModeToggleEl, definitionModeEl]
  ];

  let translations = {};
  let currentOptions = getPayload();
  let currentResultMode = 'content';
  let currentSettings = {
    remoteHost: '',
    remotePort: defaultRemotePort,
    remoteUsername: '',
    remotePassword: '',
    remoteSearchPath: '',
    includeGlobs: [...defaultIncludeGlobs],
    excludeGlobs: [...defaultExcludeGlobs]
  };
  let gitRootOk = true;
  let gitRootMessage = '';
  let workspacePath = '';
  let repositories = [];
  let currentRemotePath = '';
  let lastSearchSummaryText = '';
  let lastRenderTimingInfo = null;
  let nextSearchRequestId = Number.isFinite(vscodeState.nextSearchRequestId) ? vscodeState.nextSearchRequestId : 1;
  let activeSearchRequestId = Number.isFinite(vscodeState.activeSearchRequestId) ? vscodeState.activeSearchRequestId : 0;
  const collapsedFiles = new Set(Array.isArray(vscodeState.collapsedFiles) ? vscodeState.collapsedFiles : []);
  const SEARCH_INPUT_DEBOUNCE_MS = 300;
  const SEARCH_HISTORY_STABLE_MS = 5000;
  let searchDebounceTimer = null;
  let searchHistoryCommitTimer = null;
  let pendingHistoryKey = '';
  let lastConnectionSearchKey = '';
  let lastPostedSearchKey = '';
  let lastTraceAt = 0;
  let progressTimer = null;
  let progressInfo = null;
  let lastResultAction = { key: '', at: 0 };
  const searchHistory = new window.RipgrepToolSearchHistory({
    queryInput: queryEl,
    fileQueryInput: fileQueryEl,
    contentEntries: vscodeState.contentSearchHistory,
    fileEntries: vscodeState.fileSearchHistory,
    onChanged: persistState,
    onNavigate: persistState
  });

  const gitRootBoundControls = [
    queryEl,
    fileQueryEl,
    includeEl,
    excludeEl,
    caseSensitiveEl,
    wholeWordEl,
    useRegexEl,
    definitionModeEl,
    settingsButton,
    remoteHostInputEl,
    remotePortInputEl,
    remoteUsernameInputEl,
    remotePasswordInputEl,
    remoteSearchPathInputEl,
    togglePasswordButtonEl,
    includeGlobsInputEl,
    excludeGlobsInputEl,
    connectButtonEl,
    resetSettingsButtonEl,
    saveSettingsButtonEl,
    rebuildTagsButtonEl
  ].filter(Boolean);

  const iconRegistry = new window.RipgrepToolIcons({ iconUris, escapeHtml });
  if (typeof vscodeState.query === 'string') queryEl.value = vscodeState.query;
  if (typeof vscodeState.fileQuery === 'string') fileQueryEl.value = vscodeState.fileQuery;
  if (typeof vscodeState.include === 'string') includeEl.value = vscodeState.include;
  if (typeof vscodeState.exclude === 'string') excludeEl.value = vscodeState.exclude;
  caseSensitiveEl.checked = !!vscodeState.caseSensitive;
  wholeWordEl.checked = !!vscodeState.wholeWord;
  useRegexEl.checked = !!vscodeState.useRegex;
  definitionModeEl.checked = !!vscodeState.definitionMode;
  if (typeof vscodeState.summaryText === 'string') summaryTextEl.textContent = vscodeState.summaryText;
  if (typeof vscodeState.workspaceName === 'string') workspaceNameEl.textContent = vscodeState.workspaceName;
  if (typeof vscodeState.workspacePath === 'string') workspacePath = vscodeState.workspacePath;
  if (Array.isArray(vscodeState.repositories)) repositories = vscodeState.repositories;
  if (typeof vscodeState.currentRemotePath === 'string') currentRemotePath = vscodeState.currentRemotePath;
  void iconRegistry.initialize();
  syncDefinitionRootClass();

  function t(key) {
    return translations[key] || key;
  }

  function formatMessage(key, values) {
    return t(key).replace(/\{(\w+)\}/g, (_, name) => String(values[name] ?? ''));
  }

  function applyTranslations() {
    document.querySelectorAll('[data-i18n]').forEach((node) => {
      node.textContent = t(node.getAttribute('data-i18n'));
    });
    document.querySelectorAll('[data-i18n-title]').forEach((node) => {
      node.title = t(node.getAttribute('data-i18n-title'));
    });
    document.querySelectorAll('[data-i18n-aria-label]').forEach((node) => {
      const key = node.getAttribute('data-i18n-aria-label');
      if (key) {
        node.setAttribute('aria-label', t(key));
      }
    });
    document.querySelectorAll('[data-i18n-placeholder]').forEach((node) => {
      const key = node.getAttribute('data-i18n-placeholder');
      if (key) {
        node.placeholder = t(key);
      }
    });
    queryEl.placeholder = t('query_placeholder');
    fileQueryEl.placeholder = t('file_query_placeholder');
    includeEl.placeholder = '';
    excludeEl.placeholder = '';
    settingsPanel.syncPasswordToggle();
    if (!resultsEl.innerHTML.trim()) {
      resultsEl.innerHTML = `<div class="empty">${escapeHtml(t('empty_results'))}</div>`;
    }
  }

  function syncDefinitionRootClass() {
    const root = document.querySelector('.root');
    if (root) {
      root.classList.toggle('definitionSearch', definitionModeEl.checked);
    }
  }

  function updateWorkspacePathDisplay(value) {
    workspacePath = value || '';
    workspaceNameEl.textContent = workspacePath;
    workspaceNameEl.title = workspacePath;
    syncCurrentRemotePathDisplay();
  }

  function inferCurrentRemotePathFromInputs() {
    const configured = remoteSearchPathInputEl.value.trim();
    if (repositories.length > 0) {
      return currentRemotePath || formatRepositoryPaths(configured || workspacePath || '');
    }
    if (configured) return configured;
    if (currentRemotePath) return currentRemotePath;
    return workspacePath || '';
  }

  function syncCurrentRemotePathDisplay(value) {
    if (typeof value === 'string') {
      currentRemotePath = value;
    } else {
      currentRemotePath = currentRemotePath || '';
    }
    const displayPath = repositories.length > 0 && currentRemotePath
      ? currentRemotePath
      : inferCurrentRemotePathFromInputs();
    if (!currentRemotePathValueEl) return;
    currentRemotePathValueEl.textContent = displayPath || '-';
    currentRemotePathValueEl.title = displayPath || '';
  }

  function formatRepositoryPaths(basePath) {
    const base = (basePath || '').replace(/\/$/u, '');
    return repositories.map((repository) => {
      const relativePath = repository.relativePath || '';
      if (base) {
        return relativePath ? `${base}/${relativePath}` : base;
      }
      return repository.displayPath || relativePath || repository.name || '';
    }).join('\n');
  }

  function isCurrentSearchMessage(payload) {
    const requestId = Number(payload?.requestId || 0);
    return !requestId || !activeSearchRequestId || requestId === activeSearchRequestId;
  }

  function beginSearchIntent() {
    activeSearchRequestId = nextSearchRequestId;
    nextSearchRequestId += 1;
    return activeSearchRequestId;
  }

  function setGitRootState(ok, message) {
    gitRootOk = ok !== false;
    gitRootMessage = gitRootOk ? '' : (message || t('git_root_required'));
    syncGitRootDisabledState();
    if (!gitRootOk) {
      renderGitRootRequired(gitRootMessage);
    }
  }

  function syncGitRootDisabledState() {
    const blocked = !gitRootOk;
    const root = document.querySelector('.root');
    if (root) {
      root.classList.toggle('gitBlocked', blocked);
    }
    gitRootBoundControls.forEach((control) => {
      control.disabled = blocked;
      control.setAttribute('aria-disabled', blocked ? 'true' : 'false');
    });
    togglePairs.forEach(([toggle]) => {
      if (toggle) {
        toggle.classList.toggle('disabled', blocked);
      }
    });
    if (blocked && settingsPanel.isOpen()) {
      settingsPanel.close();
    }
  }

  function renderGitRootRequired(message) {
    resultsEl.innerHTML = `<div class="gitRootRequired">${escapeHtml(message)}</div>`;
    persistState();
  }

  function getPayload() {
    const fileQuery = fileQueryEl.value;
    return {
      query: fileQuery.trim() ? '' : queryEl.value,
      fileQuery,
      include: includeEl.value,
      exclude: excludeEl.value,
      caseSensitive: caseSensitiveEl.checked,
      wholeWord: wholeWordEl.checked,
      useRegex: useRegexEl.checked,
      definitionMode: definitionModeEl.checked
    };
  }

  function postSearchToExtension(options = {}) {
    const {
      clearFileCollapse = true,
      rememberHistory = false,
      triggerSource = 'input'
    } = options;
    enforceExclusiveSearchFields();
    if (!gitRootOk) {
      renderGitRootRequired(gitRootMessage || t('git_root_required'));
      return;
    }
    currentOptions = getPayload();
    if (rememberHistory) {
      clearSearchHistoryCommit();
      searchHistory.rememberActive();
    }
    if (clearFileCollapse) {
      collapsedFiles.clear();
    }
    const requestId = activeSearchRequestId || beginSearchIntent();
    currentResultMode = currentOptions.fileQuery && String(currentOptions.fileQuery).trim() ? 'file' : 'content';
    lastPostedSearchKey = JSON.stringify(currentOptions);
    prepareSearchUi(requestId, currentResultMode);
    persistState();
    traceWebview('search-post', {
      requestId,
      triggerSource,
      mode: currentResultMode,
      queryLength: String(currentOptions.query || '').length,
      fileQueryLength: String(currentOptions.fileQuery || '').length
    });
    settingsPanel.close();
    vscode.postMessage({
      type: 'search',
      payload: {
        ...currentOptions,
        requestId,
        triggerSource
      }
    });
  }

  function startSearch() {
    clearSearchDebounce();
    clearSearchHistoryCommit();
    beginSearchIntent();
    postSearchToExtension({ clearFileCollapse: true, rememberHistory: true, triggerSource: 'enter' });
  }

  function clearSearchDebounce() {
    if (searchDebounceTimer !== null) {
      clearTimeout(searchDebounceTimer);
      searchDebounceTimer = null;
    }
  }

  function clearSearchHistoryCommit() {
    if (searchHistoryCommitTimer !== null) {
      clearTimeout(searchHistoryCommitTimer);
      searchHistoryCommitTimer = null;
    }
    pendingHistoryKey = '';
  }

  function scheduleSearchHistoryCommit() {
    clearSearchHistoryCommit();
    const key = JSON.stringify(getPayload());
    if (!String(queryEl.value).trim() && !String(fileQueryEl.value).trim()) {
      return;
    }
    pendingHistoryKey = key;
    searchHistoryCommitTimer = window.setTimeout(() => {
      searchHistoryCommitTimer = null;
      const currentKey = JSON.stringify(getPayload());
      if (currentKey !== pendingHistoryKey) {
        return;
      }
      searchHistory.rememberActive();
      pendingHistoryKey = '';
    }, SEARCH_HISTORY_STABLE_MS);
  }

  function scheduleSearchRefresh(rememberHistory = true) {
    clearSearchDebounce();
    beginSearchIntent();
    const q = String(queryEl.value).trim() || String(fileQueryEl.value).trim();
    if (!q) {
      clearSearchHistoryCommit();
      resultsRenderer.replace([]);
      currentResultMode = String(fileQueryEl.value).trim() ? 'file' : 'content';
      persistState();
      vscode.postMessage({
        type: 'search',
        payload: {
          ...getPayload(),
          requestId: activeSearchRequestId,
          triggerSource: 'input'
        }
      });
      return;
    }
    searchDebounceTimer = window.setTimeout(() => {
      searchDebounceTimer = null;
      postSearchToExtension({ clearFileCollapse: true, rememberHistory, triggerSource: 'input' });
      if (!rememberHistory) {
        scheduleSearchHistoryCommit();
      }
    }, SEARCH_INPUT_DEBOUNCE_MS);
  }

  function searchRestoredQueryAfterConnection() {
    if (!gitRootOk) return;
    const q = String(queryEl.value).trim() || String(fileQueryEl.value).trim();
    if (!q) return;
    const key = JSON.stringify(getPayload());
    if (key === lastConnectionSearchKey || key === lastPostedSearchKey) return;
    lastConnectionSearchKey = key;
    clearSearchDebounce();
    clearSearchHistoryCommit();
    beginSearchIntent();
    currentOptions = getPayload();
    currentResultMode = currentOptions.fileQuery && String(currentOptions.fileQuery).trim() ? 'file' : 'content';
    prepareSearchUi(activeSearchRequestId, currentResultMode);
    persistState();
    vscode.postMessage({
      type: 'search',
      payload: {
        ...getPayload(),
        requestId: activeSearchRequestId,
        triggerSource: 'connection'
      }
    });
  }

  const resultsRenderer = new window.RipgrepToolResultsRenderer({
    resultsEl,
    collapsedFiles,
    isGitRootOk: () => gitRootOk,
    getGitRootMessage: () => gitRootMessage || t('git_root_required'),
    getIsFileSearch: () => currentResultMode === 'file',
    renderGitRootRequired,
    renderEmpty: () => `<div class="empty">${escapeHtml(t('empty_results'))}</div>`,
    renderFileIcon: (relativePath) => iconRegistry.renderFileIcon(relativePath),
    formatPreview,
    escapeHtml,
    persistState,
    trace: (phase, details) => traceWebview(`render:${phase}`, details),
    getChevronRight: () => iconRegistry.get('chevronRight') || '&#9656;',
    getChevronDown: () => iconRegistry.get('chevronDown') || '&#9662;',
    afterRender: updateRenderTiming
  });

  const settingsPanel = new window.RipgrepToolSettingsPanel({
    elements: {
      layer: settingsLayerEl,
      remoteHost: remoteHostInputEl,
      remotePort: remotePortInputEl,
      remoteUsername: remoteUsernameInputEl,
      remotePassword: remotePasswordInputEl,
      remoteSearchPath: remoteSearchPathInputEl,
      includeGlobs: includeGlobsInputEl,
      excludeGlobs: excludeGlobsInputEl,
      connectionStatus: connectionStatusEl,
      togglePasswordButton: togglePasswordButtonEl
    },
    defaultRemotePort,
    defaultIncludeGlobs,
    defaultExcludeGlobs,
    getCurrentSettings: () => currentSettings,
    translate: t,
    renderBlocked: () => renderGitRootRequired(gitRootMessage || t('git_root_required')),
    isGitRootOk: () => gitRootOk,
    persistState,
    syncCurrentRemotePathDisplay,
    setIcon: (id, svg, fallbackText) => iconRegistry.setIcon(id, svg, fallbackText),
    getEyeIcon: () => iconRegistry.get('eye'),
    getEyeClosedIcon: () => iconRegistry.get('eyeClosed')
  });

  function escapeHtml(value) {
    return String(value)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;');
  }

  function escapeRegExp(value) {
    return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  }

  function buildHighlightRegex() {
    const query = currentOptions.query || '';
    if (!query) return null;
    if (currentOptions.definitionMode) {
      try {
        return new RegExp(escapeRegExp(query), 'g');
      } catch {
        return null;
      }
    }
    try {
      const source = currentOptions.useRegex ? query : escapeRegExp(query);
      const wrapped = currentOptions.wholeWord ? `\\b(?:${source})\\b` : source;
      return new RegExp(wrapped, currentOptions.caseSensitive ? 'g' : 'gi');
    } catch {
      return null;
    }
  }

  function createSnippet(text, match) {
    if (!text) return '';
    const collapsed = String(text).replace(/\s+/g, ' ').trim();
    if (!collapsed) return '';
    if (collapsed.length <= 260) return collapsed;
    const symbol = String(match?.symbolName || '').trim();
    const symbolIndex = symbol ? collapsed.indexOf(symbol) : -1;
    const pivot = symbolIndex >= 0 ? symbolIndex : Math.floor(collapsed.length / 2);
    const start = Math.max(0, pivot - 80);
    const end = Math.min(collapsed.length, pivot + Math.max(160, symbol.length));
    return `${start > 0 ? '...' : ''}${collapsed.slice(start, end).trim()}${end < collapsed.length ? '...' : ''}`;
  }

  function createPreviewFallback(match) {
    const path = String(match?.relativePath || match?.path || '').trim();
    const line = Number.isFinite(match?.line) ? match.line : undefined;
    if (path && line) return `${path}:${line}`;
    if (path) return path;
    if (line) return `:${line}`;
    return '';
  }

  function formatPreview(preview, match) {
    const snippet = createSnippet(preview, match) || createPreviewFallback(match);
    const safePreview = escapeHtml(snippet);
    const regex = buildHighlightRegex();
    if (!regex) return safePreview;

    let result = '';
    let lastIndex = 0;
    let hitCount = 0;
    for (const found of snippet.matchAll(regex)) {
      const index = found.index ?? 0;
      const text = found[0];
      result += escapeHtml(snippet.slice(lastIndex, index));
      result += `<mark>${escapeHtml(text)}</mark>`;
      lastIndex = index + text.length;
      hitCount += 1;
      if (hitCount >= 12 || text.length === 0) break;
    }

    if (!result) return safePreview;
    result += escapeHtml(snippet.slice(lastIndex));
    return result;
  }

  function updateRenderTiming(info) {
    lastRenderTimingInfo = info || null;
    traceWebview('render-complete', info || {});
    applyRenderTiming();
  }

  function prepareSearchUi(requestId, mode) {
    lastSearchSummaryText = '';
    lastRenderTimingInfo = null;
    progressInfo = {
      requestId,
      mode,
      startedAt: Date.now(),
      fileCount: 0,
      matchCount: 0,
      running: true
    };
    resultsRenderer.replace([]);
    updateProgressSummary();
    startProgressTimer();
  }

  function startProgressTimer() {
    stopProgressTimer();
    progressTimer = window.setInterval(updateProgressSummary, 250);
  }

  function stopProgressTimer() {
    if (progressTimer !== null) {
      clearInterval(progressTimer);
      progressTimer = null;
    }
  }

  function updateProgressSummary() {
    if (!progressInfo || !progressInfo.running) {
      return;
    }
    const elapsedMs = Math.max(0, Date.now() - progressInfo.startedAt);
    if (progressInfo.mode === 'file') {
      summaryTextEl.textContent = `${progressInfo.fileCount} files (${elapsedMs} ms)`;
    } else {
      summaryTextEl.textContent = `${progressInfo.fileCount} files, ${progressInfo.matchCount} results (${elapsedMs} ms)`;
    }
  }

  function applyProgressState(statePayload) {
    if (statePayload.error || !statePayload.running) {
      if (progressInfo) {
        progressInfo.running = false;
      }
      stopProgressTimer();
      return;
    }
    progressInfo = {
      requestId: Number(statePayload.requestId || activeSearchRequestId),
      mode: currentResultMode,
      startedAt: Date.now() - Number(statePayload.elapsedMs || 0),
      fileCount: Number(statePayload.fileCount || 0),
      matchCount: Number(statePayload.matchCount || 0),
      running: true
    };
    updateProgressSummary();
    startProgressTimer();
  }

  function applyRenderTiming() {
    if (!lastSearchSummaryText || !lastRenderTimingInfo || lastRenderTimingInfo.elapsedMs < 80) {
      return;
    }
    summaryTextEl.textContent = `${lastSearchSummaryText} · ${formatMessage('render_timing', { elapsedMs: lastRenderTimingInfo.elapsedMs })}`;
    persistState();
  }

  function syncToggleState() {
    for (const [toggle, input] of togglePairs) {
      toggle.classList.toggle('active', input.checked);
    }
    syncDefinitionRootClass();
    persistState();
    if (String(queryEl.value).trim() || String(fileQueryEl.value).trim()) {
      clearSearchDebounce();
      clearSearchHistoryCommit();
      beginSearchIntent();
      postSearchToExtension({ clearFileCollapse: true, rememberHistory: true, triggerSource: 'toggle' });
    }
  }

  function setFieldFocus(input, focused) {
    if (input.value.trim()) return;
    if (focused) {
      input.placeholder = input === includeEl ? t('include_hint_placeholder') : t('exclude_hint_placeholder');
    } else {
      input.placeholder = '';
    }
  }

  function persistState() {
    vscode.setState({
      query: queryEl.value,
      fileQuery: fileQueryEl.value,
      include: includeEl.value,
      exclude: excludeEl.value,
      caseSensitive: caseSensitiveEl.checked,
      wholeWord: wholeWordEl.checked,
      useRegex: useRegexEl.checked,
      definitionMode: definitionModeEl.checked,
      collapsedFiles: Array.from(collapsedFiles),
      ...searchHistory.snapshot(),
      summaryText: summaryTextEl.textContent || '',
      workspaceName: workspaceNameEl.textContent || '',
      workspacePath,
      repositories,
      currentRemotePath,
      activeSearchRequestId,
      nextSearchRequestId
    });
  }

  function traceWebview(event, details) {
    const now = Date.now();
    const payload = {
      event,
      at: now,
      requestId: activeSearchRequestId,
      details: details || {}
    };
    if (event.startsWith('render:') && now - lastTraceAt < 500 && Number(payload.details.elapsedMs || 0) < 200) {
      return;
    }
    lastTraceAt = now;
    vscode.postMessage({ type: 'trace', payload });
  }

  function saveSettings() {
    if (!gitRootOk) {
      renderGitRootRequired(gitRootMessage || t('git_root_required'));
      return;
    }
    vscode.postMessage({ type: 'saveSettings', payload: settingsPanel.buildPayload() });
    settingsPanel.close();
  }

  queryEl.addEventListener('keydown', (event) => {
    if (!gitRootOk) return;
    if (event.key === 'Enter') startSearch();
    if (event.key === 'ArrowUp' || event.key === 'ArrowDown') {
      if (searchHistory.navigate(queryEl, event.key === 'ArrowUp' ? -1 : 1)) {
        event.preventDefault();
      }
    }
  });
  fileQueryEl.addEventListener('keydown', (event) => {
    if (!gitRootOk) return;
    if (event.key === 'Enter') startSearch();
    if (event.key === 'ArrowUp' || event.key === 'ArrowDown') {
      if (searchHistory.navigate(fileQueryEl, event.key === 'ArrowUp' ? -1 : 1)) {
        event.preventDefault();
      }
    }
  });
  includeEl.addEventListener('keydown', (event) => {
    if (!gitRootOk) return;
    if (event.key === 'Enter') startSearch();
  });
  excludeEl.addEventListener('keydown', (event) => {
    if (!gitRootOk) return;
    if (event.key === 'Enter') startSearch();
  });
  [includeEl, excludeEl].forEach((input) => {
    input.addEventListener('focus', () => setFieldFocus(input, true));
    input.addEventListener('blur', () => setFieldFocus(input, false));
  });
  caseSensitiveEl.addEventListener('change', syncToggleState);
  wholeWordEl.addEventListener('change', syncToggleState);
  useRegexEl.addEventListener('change', syncToggleState);
  definitionModeEl.addEventListener('change', syncToggleState);
  queryEl.addEventListener('input', () => {
    if (!gitRootOk) return;
    if (queryEl.value) {
      fileQueryEl.value = '';
    }
    searchHistory.resetCursor(queryEl);
    persistState();
    clearSearchHistoryCommit();
    scheduleSearchRefresh(false);
  });
  fileQueryEl.addEventListener('input', () => {
    if (!gitRootOk) return;
    if (fileQueryEl.value) {
      queryEl.value = '';
    }
    searchHistory.resetCursor(fileQueryEl);
    persistState();
    clearSearchHistoryCommit();
    scheduleSearchRefresh(false);
  });
  includeEl.addEventListener('input', () => {
    if (!gitRootOk) return;
    persistState();
    clearSearchHistoryCommit();
    scheduleSearchRefresh(false);
  });
  excludeEl.addEventListener('input', () => {
    if (!gitRootOk) return;
    persistState();
    clearSearchHistoryCommit();
    scheduleSearchRefresh(false);
  });
  settingsButton.addEventListener('click', () => settingsPanel.open());
  closeSettingsButtonEl.addEventListener('click', () => settingsPanel.close());
  resetSettingsButtonEl.addEventListener('click', () => settingsPanel.reset());
  remoteSearchPathInputEl.addEventListener('input', () => {
    syncCurrentRemotePathDisplay(remoteSearchPathInputEl.value.trim());
    persistState();
  });
  connectButtonEl.addEventListener('click', () => {
    if (!gitRootOk) {
      renderGitRootRequired(gitRootMessage || t('git_root_required'));
      return;
    }
    settingsPanel.setConnectionStatus(t('connection_connecting'));
    vscode.postMessage({ type: 'connect', payload: settingsPanel.buildPayload() });
  });
  saveSettingsButtonEl.addEventListener('click', saveSettings);
  if (rebuildTagsButtonEl) {
    rebuildTagsButtonEl.addEventListener('click', () => {
      if (!gitRootOk) {
        renderGitRootRequired(gitRootMessage || t('git_root_required'));
        return;
      }
      vscode.postMessage({ type: 'rebuildTags' });
    });
  }
  togglePasswordButtonEl.addEventListener('click', () => {
    if (!gitRootOk) return;
    settingsPanel.togglePassword();
  });
  settingsLayerEl.addEventListener('click', (event) => {
    if (event.target === settingsLayerEl) settingsPanel.close();
  });
  window.addEventListener('keydown', (event) => {
    if (event.key === 'Escape' && settingsPanel.isOpen()) settingsPanel.close();
  });
  function handleResultAction(event, source) {
    if (!gitRootOk) {
      renderGitRootRequired(gitRootMessage || t('git_root_required'));
      return;
    }
    const toggleTarget = event.target.closest('[data-toggle-file]');
    if (toggleTarget) {
      event.preventDefault();
      event.stopPropagation();
      const filePath = decodeURIComponent(toggleTarget.dataset.toggleFile);
      if (isDuplicateResultAction(`toggle:${filePath}`, source)) {
        return;
      }
      if (collapsedFiles.has(filePath)) collapsedFiles.delete(filePath);
      else collapsedFiles.add(filePath);
      resultsRenderer.rerender();
      persistState();
      return;
    }
    const matchTarget = event.target.closest('[data-match]');
    if (!matchTarget) return;
    event.preventDefault();
    event.stopPropagation();
    try {
      const payload = JSON.parse(decodeURIComponent(matchTarget.dataset.match));
      const key = `open:${payload.uri || payload.path || ''}:${payload.line || 0}:${payload.column || 0}`;
      if (isDuplicateResultAction(key, source)) {
        return;
      }
      traceWebview('result-open', {
        source,
        uri: payload.uri || '',
        path: payload.path || '',
        line: payload.line || 0
      });
      vscode.postMessage({ type: 'open', payload });
    } catch (error) {
      traceWebview('result-click-failed', { message: error instanceof Error ? error.message : String(error) });
    }
  }

  function isDuplicateResultAction(key, source) {
    const now = Date.now();
    if (source === 'click' && lastResultAction.key === key && now - lastResultAction.at < 800) {
      return true;
    }
    lastResultAction = { key, at: now };
    return false;
  }

  resultsEl.addEventListener('pointerdown', (event) => {
    if (event.button !== 0) {
      return;
    }
    handleResultAction(event, 'pointerdown');
  }, true);

  resultsEl.addEventListener('click', (event) => {
    handleResultAction(event, 'click');
  });

  window.addEventListener('message', (event) => {
    const message = event.data;
    if (message.type === 'bootstrap') {
      translations = message.payload.translations || {};
      currentSettings = message.payload.settings || currentSettings;
      repositories = Array.isArray(message.payload.repositories) ? message.payload.repositories : [];
      applyTranslations();
      updateWorkspacePathDisplay(message.payload.workspacePath || message.payload.workspaceName || '');
      syncDefinitionRootClass();
      setGitRootState(message.payload.gitRootOk, message.payload.gitError);
      if (message.payload.state) {
        summaryTextEl.textContent = message.payload.state.error || message.payload.state.summary || '';
      }
      if (message.payload.results) {
        currentResultMode = message.payload.results.mode || currentResultMode;
        resultsRenderer.replace(message.payload.results.items || []);
      }
      persistState();
      return;
    }
    if (message.type === 'focus') queryEl.focus();
    if (message.type === 'gitRootRequired') {
      updateWorkspacePathDisplay(message.payload.workspacePath || workspacePath);
      setGitRootState(false, message.payload.message || t('git_root_required'));
      return;
    }
    if (message.type === 'state') {
      const statePayload = message.payload || message;
      if (!isCurrentSearchMessage(statePayload)) {
        return;
      }
      summaryTextEl.textContent = statePayload.error || statePayload.summary || '';
      if (statePayload.running || statePayload.error) {
        lastSearchSummaryText = '';
        lastRenderTimingInfo = null;
      }
      applyProgressState(statePayload);
      if (statePayload.summary && !statePayload.running && !statePayload.error) {
        lastSearchSummaryText = statePayload.summary;
        applyRenderTiming();
      }
      if (ctagsProgressRowEl) {
        ctagsProgressRowEl.hidden = !statePayload.ctagsInProgress;
        const track = ctagsProgressRowEl.querySelector('.ctagsProgressTrack');
        if (track) {
          track.setAttribute('aria-label', statePayload.summary || statePayload.error || '');
        }
      }
      persistState();
    }
    if (message.type === 'results') {
      const resultsPayload = message.payload || message;
      if (!isCurrentSearchMessage(resultsPayload)) {
        return;
      }
      if (resultsPayload.mode) {
        currentResultMode = resultsPayload.mode;
      }
      if (settingsPanel.isOpen()) {
        settingsPanel.close();
      }
      traceWebview('results-received', {
        mode: currentResultMode,
        replace: resultsPayload.replace !== false,
        files: Array.isArray(resultsPayload.items) ? resultsPayload.items.length : 0
      });
      if (resultsPayload.replace !== false) {
        resultsRenderer.replace(resultsPayload.items || []);
      } else {
        resultsRenderer.merge(resultsPayload.items || []);
      }
    }
    if (message.type === 'settings') currentSettings = message.payload;
    if (message.type === 'connectionResult') {
      settingsPanel.setConnectionStatus(message.payload.message || '');
      if (message.payload.cwd) {
        currentRemotePath = message.payload.cwd;
        syncCurrentRemotePathDisplay();
      }
      persistState();
      if (message.payload.ok) {
        searchRestoredQueryAfterConnection();
      }
    }
  });

  syncToggleState(false);
  settingsPanel.syncPasswordToggle();
  setFieldFocus(includeEl, false);
  setFieldFocus(excludeEl, false);
  vscode.postMessage({ type: 'ready' });

  function enforceExclusiveSearchFields() {
    if (String(fileQueryEl.value).trim() && String(queryEl.value).trim()) {
      queryEl.value = '';
    }
  }
})();
