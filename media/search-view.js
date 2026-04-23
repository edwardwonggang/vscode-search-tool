(function () {
  const vscode = acquireVsCodeApi();
  const bootstrap = window.RIPGREP_TOOL_BOOTSTRAP || {};
  const defaultRemotePort = Number(bootstrap.defaultRemotePort || 22);
  const defaultIncludeGlobs = Array.isArray(bootstrap.defaultIncludeGlobs) ? bootstrap.defaultIncludeGlobs : [];
  const defaultExcludeGlobs = Array.isArray(bootstrap.defaultExcludeGlobs) ? bootstrap.defaultExcludeGlobs : [];
  const iconUris = bootstrap.iconUris || {};

  const queryEl = document.getElementById('query');
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
  const togglePasswordButtonEl = document.getElementById('togglePasswordButton');
  const togglePasswordIconEl = document.getElementById('togglePasswordIcon');
  const includeGlobsInputEl = document.getElementById('includeGlobsInput');
  const excludeGlobsInputEl = document.getElementById('excludeGlobsInput');
  const closeSettingsButtonEl = document.getElementById('closeSettingsButton');
  const testConnectionButtonEl = document.getElementById('testConnectionButton');
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
  let currentSettings = {
    remoteHost: '',
    remotePort: defaultRemotePort,
    remoteUsername: '',
    remotePassword: '',
    includeGlobs: [...defaultIncludeGlobs],
    excludeGlobs: [...defaultExcludeGlobs]
  };
  const collapsedFiles = new Set(Array.isArray(vscodeState.collapsedFiles) ? vscodeState.collapsedFiles : []);
  const SEARCH_INPUT_DEBOUNCE_MS = 300;
  let searchDebounceTimer = null;

  const icons = {
    eye: null,
    eyeClosed: null,
    chevronRight: null,
    chevronDown: null
  };
  const fileTypeIcons = {};

  const fileTypeBadge = {
    c: { label: 'C', color: '#519aba' },
    h: { label: 'H', color: '#a074c4' },
    cpp: { label: 'C+', color: '#519aba' },
    cxx: { label: 'C+', color: '#519aba' },
    cc: { label: 'C+', color: '#519aba' },
    hpp: { label: 'H+', color: '#a074c4' },
    hh: { label: 'H+', color: '#a074c4' },
    hxx: { label: 'H+', color: '#a074c4' },
    sh: { label: 'SH', color: '#89e051' },
    bash: { label: 'SH', color: '#89e051' },
    ps1: { label: 'PS', color: '#4fc1ff' },
    md: { label: 'MD', color: '#519aba' },
    json: { label: '{}', color: '#cbcb41' },
    yml: { label: 'Y', color: '#f14c4c' },
    yaml: { label: 'Y', color: '#f14c4c' },
    xml: { label: 'X', color: '#e37933' },
    js: { label: 'JS', color: '#cbcb41' },
    ts: { label: 'TS', color: '#519aba' },
    jsx: { label: 'JX', color: '#61dafb' },
    tsx: { label: 'TX', color: '#61dafb' },
    py: { label: 'PY', color: '#ffd43b' },
    java: { label: 'J', color: '#cc3e44' },
    go: { label: 'GO', color: '#00add8' },
    rs: { label: 'RS', color: '#dea584' },
    txt: { label: 'T', color: '#9f9f9f' },
    log: { label: 'L', color: '#9f9f9f' }
  };

  if (typeof vscodeState.query === 'string') queryEl.value = vscodeState.query;
  if (typeof vscodeState.include === 'string') includeEl.value = vscodeState.include;
  if (typeof vscodeState.exclude === 'string') excludeEl.value = vscodeState.exclude;
  caseSensitiveEl.checked = !!vscodeState.caseSensitive;
  wholeWordEl.checked = !!vscodeState.wholeWord;
  useRegexEl.checked = !!vscodeState.useRegex;
  definitionModeEl.checked = !!vscodeState.definitionMode;
  if (typeof vscodeState.summaryText === 'string') summaryTextEl.textContent = vscodeState.summaryText;
  if (typeof vscodeState.workspaceName === 'string') workspaceNameEl.textContent = vscodeState.workspaceName;
  if (typeof vscodeState.resultsHtml === 'string') resultsEl.innerHTML = vscodeState.resultsHtml;

  void initializeIcons();
  syncDefinitionRootClass();

  function imgIcon(src, cls = 'iconImg') {
    return `<img class="${cls}" src="${src}" alt="" />`;
  }

  async function loadSvgMarkup(uri) {
    if (!uri) {
      console.warn('[Ripgrep Tool] loadSvgMarkup: uri is empty');
      return '';
    }
    try {
      const response = await fetch(uri);
      if (!response.ok) {
        console.warn(`[Ripgrep Tool] loadSvgMarkup failed: ${response.status} ${response.statusText} for ${uri}`);
        return '';
      }
      const text = await response.text();
      console.log(`[Ripgrep Tool] loadSvgMarkup success: ${uri} (${text.length} bytes)`);
      return text;
    } catch (error) {
      console.error(`[Ripgrep Tool] loadSvgMarkup error for ${uri}:`, error);
      return '';
    }
  }

  async function initializeIcons() {
    console.log('[Ripgrep Tool] initializeIcons started, iconUris:', iconUris);

    if (!iconUris || !iconUris.caseSensitive) {
      console.error('[Ripgrep Tool] iconUris is empty or invalid!');
    }

    const fileTypeKeys = iconUris.fileTypes ? Object.keys(iconUris.fileTypes) : [];
    console.log(`[Ripgrep Tool] Loading ${fileTypeKeys.length} file type icons`);

    const fileTypePromises = fileTypeKeys.map(async (key) => {
      const uri = iconUris.fileTypes[key];
      console.log(`[Ripgrep Tool] Loading file type icon: ${key} from ${uri}`);
      const svg = await loadSvgMarkup(uri);
      return [key, svg];
    });

    const [caseSensitiveSvg, wholeWordSvg, regexSvg, settingsSvg, definitionSvg, eyeSvg, eyeClosedSvg, chevronRightSvg, chevronDownSvg, closeSvg, ...fileTypeResults] =
      await Promise.all([
        loadSvgMarkup(iconUris.caseSensitive),
        loadSvgMarkup(iconUris.wholeWord),
        loadSvgMarkup(iconUris.regex),
        loadSvgMarkup(iconUris.settings),
        loadSvgMarkup(iconUris.definition),
        loadSvgMarkup(iconUris.eye),
        loadSvgMarkup(iconUris.eyeClosed),
        loadSvgMarkup(iconUris.chevronRight),
        loadSvgMarkup(iconUris.chevronDown),
        loadSvgMarkup(iconUris.close),
        ...fileTypePromises
      ]);

    console.log('[Ripgrep Tool] Codicon SVGs loaded:', {
      caseSensitive: caseSensitiveSvg ? 'yes' : 'no',
      wholeWord: wholeWordSvg ? 'yes' : 'no',
      regex: regexSvg ? 'yes' : 'no',
      settings: settingsSvg ? 'yes' : 'no',
      eye: eyeSvg ? 'yes' : 'no',
      eyeClosed: eyeClosedSvg ? 'yes' : 'no',
      chevronRight: chevronRightSvg ? 'yes' : 'no',
      chevronDown: chevronDownSvg ? 'yes' : 'no'
    });

    let loadedFileTypeCount = 0;
    for (const [key, svg] of fileTypeResults) {
      if (svg) {
        fileTypeIcons[key] = svg;
        loadedFileTypeCount++;
      }
    }
    console.log(`[Ripgrep Tool] Loaded ${loadedFileTypeCount}/${fileTypeKeys.length} file type icons`);

    icons.eye = eyeSvg || '&#128065;';
    icons.eyeClosed = eyeClosedSvg || '&#128064;';
    icons.chevronRight = chevronRightSvg || '&#9656;';
    icons.chevronDown = chevronDownSvg || '&#9662;';

    setIcon('caseSensitiveIcon', caseSensitiveSvg, 'Aa');
    setIcon('wholeWordIcon', wholeWordSvg, 'W');
    setIcon('useRegexIcon', regexSvg, '.*');
    setIcon('definitionModeIcon', definitionSvg, 'D');
    setIcon('settingsIcon', settingsSvg, '&#9881;');
    setIcon('closeSettingsIcon', closeSvg, '×');
    setIcon('togglePasswordIcon', eyeSvg || icons.eye, '&#128065;');

    console.log('[Ripgrep Tool] initializeIcons completed');
  }

  function setIcon(id, svg, fallbackText) {
    const node = document.getElementById(id);
    if (!node) return;
    if (svg && svg.trim()) {
      node.innerHTML = svg;
    } else if (fallbackText) {
      node.textContent = fallbackText;
      node.style.fontSize = '12px';
      node.style.fontWeight = 'bold';
      node.style.display = 'inline-flex';
      node.style.alignItems = 'center';
      node.style.justifyContent = 'center';
    }
  }

  function t(key) {
    return translations[key] || key;
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
    queryEl.placeholder = t('query_placeholder');
    includeEl.placeholder = '';
    excludeEl.placeholder = '';
    syncPasswordToggle();
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

  function getPayload() {
    return {
      query: queryEl.value,
      include: includeEl.value,
      exclude: excludeEl.value,
      caseSensitive: caseSensitiveEl.checked,
      wholeWord: wholeWordEl.checked,
      useRegex: useRegexEl.checked,
      definitionMode: definitionModeEl.checked
    };
  }

  function clearSearchDebounce() {
    if (searchDebounceTimer !== null) {
      clearTimeout(searchDebounceTimer);
      searchDebounceTimer = null;
    }
  }

  function postSearchToExtension(clearFileCollapse) {
    currentOptions = getPayload();
    if (clearFileCollapse) {
      collapsedFiles.clear();
    }
    persistState();
    vscode.postMessage({ type: 'search', payload: currentOptions });
  }

  function startSearch() {
    clearSearchDebounce();
    postSearchToExtension(true);
  }

  function scheduleSearchRefresh() {
    clearSearchDebounce();
    const q = String(queryEl.value).trim();
    if (!q) {
      postSearchToExtension(false);
      return;
    }
    searchDebounceTimer = window.setTimeout(() => {
      searchDebounceTimer = null;
      postSearchToExtension(false);
    }, SEARCH_INPUT_DEBOUNCE_MS);
  }

  function getFileIconMarkup(relativePath) {
    const extension = getExtension(relativePath);
    const svg = fileTypeIcons[extension] || fileTypeIcons.default;
    if (svg) {
      return `<span class="fileIcon" aria-hidden="true"><span class="fileImg">${svg}</span></span>`;
    }
    const badge = fileTypeBadge[extension] || { label: 'F', color: '#8c8c8c' };
    return `<span class="fileIcon" aria-hidden="true" style="background:${badge.color};color:#fff;font-size:7px;font-weight:700;border-radius:2px;display:inline-flex;align-items:center;justify-content:center;min-width:16px;min-height:16px;width:16px;height:16px;box-sizing:border-box;">${escapeHtml(badge.label)}</span>`;
  }

  function getExtension(relativePath) {
    const parts = String(relativePath).toLowerCase().split('.');
    return parts.length > 1 ? parts[parts.length - 1] : '';
  }

  function renderResults(items) {
    if (!items.length) {
      resultsEl.innerHTML = `<div class="empty">${escapeHtml(t('empty_results'))}</div>`;
      persistState();
      return;
    }

    resultsEl.innerHTML = items.map((file) => {
      const parts = splitPath(file.relativePath);
      const collapsed = collapsedFiles.has(file.path);
      const chevron = collapsed
        ? (icons.chevronRight || '&#9656;')
        : (icons.chevronDown || '&#9662;');
      const matches = file.matches.map((match) => {
        const payload = encodeURIComponent(JSON.stringify(match));
        return `<button class="match" type="button" data-match="${payload}">
          <span class="preview">${formatPreview(match.preview, match)}</span>
        </button>`;
      }).join('');

      return `<section class="file ${collapsed ? 'collapsed' : ''}">
        <button class="fileHeader" type="button" data-toggle-file="${encodeURIComponent(file.path)}">
          <span class="treeIcon" aria-hidden="true">${chevron}</span>
          ${getFileIconMarkup(file.relativePath)}
          <span class="fileName">
            <span class="base">${escapeHtml(parts.name)}</span>
            <span class="dir">${escapeHtml(parts.dir)}</span>
          </span>
          <span class="badge">${file.count}</span>
        </button>
        <div class="matches">${matches}</div>
      </section>`;
    }).join('');

    persistState();
  }

  function escapeHtml(value) {
    return String(value)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;');
  }

  function splitPath(relativePath) {
    const normalized = String(relativePath).replace(/\\/g, '/');
    const index = normalized.lastIndexOf('/');
    if (index === -1) {
      return { name: normalized, dir: '' };
    }
    return {
      name: normalized.slice(index + 1),
      dir: normalized.slice(0, index)
    };
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
    const pivot = Math.max(0, Math.min(collapsed.length, match.column - 1));
    const start = Math.max(0, pivot - 36);
    const end = Math.min(collapsed.length, pivot + 110);
    return `${start > 0 ? '...' : ''}${collapsed.slice(start, end).trim()}${end < collapsed.length ? '...' : ''}`;
  }

  function formatPreview(preview, match) {
    const snippet = createSnippet(preview, match);
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

  function syncToggleState() {
    for (const [toggle, input] of togglePairs) {
      toggle.classList.toggle('active', input.checked);
    }
    syncDefinitionRootClass();
    persistState();
    if (String(queryEl.value).trim()) {
      clearSearchDebounce();
      postSearchToExtension(true);
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
      include: includeEl.value,
      exclude: excludeEl.value,
      caseSensitive: caseSensitiveEl.checked,
      wholeWord: wholeWordEl.checked,
      useRegex: useRegexEl.checked,
      definitionMode: definitionModeEl.checked,
      collapsedFiles: Array.from(collapsedFiles),
      summaryText: summaryTextEl.textContent || '',
      workspaceName: workspaceNameEl.textContent || '',
      resultsHtml: resultsEl.innerHTML
    });
  }

  function openSettings() {
    remoteHostInputEl.value = currentSettings.remoteHost || '';
    remotePortInputEl.value = String(currentSettings.remotePort || defaultRemotePort);
    remoteUsernameInputEl.value = currentSettings.remoteUsername || '';
    remotePasswordInputEl.value = currentSettings.remotePassword || '';
    includeGlobsInputEl.value = currentSettings.includeGlobs.join('\n');
    excludeGlobsInputEl.value = currentSettings.excludeGlobs.join('\n');
    connectionStatusEl.textContent = '';
    settingsLayerEl.classList.add('open');
    remoteHostInputEl.focus();
  }

  function closeSettings() {
    settingsLayerEl.classList.remove('open');
    persistState();
  }

  function syncPasswordToggle() {
    togglePasswordButtonEl.title = remotePasswordInputEl.type === 'password' ? t('show_password') : t('hide_password');
    setIcon(
      'togglePasswordIcon',
      remotePasswordInputEl.type === 'password'
        ? (icons.eye || '')
        : (icons.eyeClosed || '')
    );
  }

  function buildSettingsPayload() {
    const remotePort = Number.parseInt(remotePortInputEl.value, 10);
    return {
      remoteHost: remoteHostInputEl.value.trim(),
      remotePort: Number.isFinite(remotePort) ? remotePort : defaultRemotePort,
      remoteUsername: remoteUsernameInputEl.value.trim(),
      remotePassword: remotePasswordInputEl.value,
      includeGlobs: includeGlobsInputEl.value.split(/\r?\n/).map((line) => line.trim()).filter(Boolean),
      excludeGlobs: excludeGlobsInputEl.value.split(/\r?\n/).map((line) => line.trim()).filter(Boolean)
    };
  }

  function saveSettings() {
    vscode.postMessage({ type: 'saveSettings', payload: buildSettingsPayload() });
    closeSettings();
    if (String(queryEl.value).trim()) {
      scheduleSearchRefresh();
    }
  }

  queryEl.addEventListener('keydown', (event) => {
    if (event.key === 'Enter') startSearch();
  });
  includeEl.addEventListener('keydown', (event) => {
    if (event.key === 'Enter') startSearch();
  });
  excludeEl.addEventListener('keydown', (event) => {
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
    persistState();
    scheduleSearchRefresh();
  });
  includeEl.addEventListener('input', () => {
    persistState();
    scheduleSearchRefresh();
  });
  excludeEl.addEventListener('input', () => {
    persistState();
    scheduleSearchRefresh();
  });
  settingsButton.addEventListener('click', openSettings);
  closeSettingsButtonEl.addEventListener('click', closeSettings);
  resetSettingsButtonEl.addEventListener('click', () => {
    remoteHostInputEl.value = '';
    remotePortInputEl.value = String(defaultRemotePort);
    remoteUsernameInputEl.value = '';
    remotePasswordInputEl.value = '';
    includeGlobsInputEl.value = defaultIncludeGlobs.join('\n');
    excludeGlobsInputEl.value = defaultExcludeGlobs.join('\n');
    connectionStatusEl.textContent = '';
  });
  testConnectionButtonEl.addEventListener('click', () => {
    connectionStatusEl.textContent = 'Testing...';
    vscode.postMessage({ type: 'testConnection', payload: buildSettingsPayload() });
  });
  saveSettingsButtonEl.addEventListener('click', saveSettings);
  if (rebuildTagsButtonEl) {
    rebuildTagsButtonEl.addEventListener('click', () => {
      vscode.postMessage({ type: 'rebuildTags' });
    });
  }
  togglePasswordButtonEl.addEventListener('click', () => {
    remotePasswordInputEl.type = remotePasswordInputEl.type === 'password' ? 'text' : 'password';
    syncPasswordToggle();
  });
  settingsLayerEl.addEventListener('click', (event) => {
    if (event.target === settingsLayerEl) closeSettings();
  });
  window.addEventListener('keydown', (event) => {
    if (event.key === 'Escape' && settingsLayerEl.classList.contains('open')) closeSettings();
  });
  resultsEl.addEventListener('click', (event) => {
    const toggleTarget = event.target.closest('[data-toggle-file]');
    if (toggleTarget) {
      const filePath = decodeURIComponent(toggleTarget.dataset.toggleFile);
      if (collapsedFiles.has(filePath)) collapsedFiles.delete(filePath);
      else collapsedFiles.add(filePath);
      const fileEl = toggleTarget.closest('.file');
      fileEl.classList.toggle('collapsed', collapsedFiles.has(filePath));
      toggleTarget.querySelector('.treeIcon').innerHTML = collapsedFiles.has(filePath) ? icons.chevronRight : icons.chevronDown;
      persistState();
      return;
    }
    const matchTarget = event.target.closest('[data-match]');
    if (!matchTarget) return;
    const payload = JSON.parse(decodeURIComponent(matchTarget.dataset.match));
    vscode.postMessage({ type: 'open', payload });
  });

  window.addEventListener('message', (event) => {
    const message = event.data;
    if (message.type === 'bootstrap') {
      translations = message.payload.translations || {};
      currentSettings = message.payload.settings || currentSettings;
      workspaceNameEl.textContent = message.payload.workspaceName || '';
      applyTranslations();
      syncDefinitionRootClass();
      if (message.payload.state) {
        summaryTextEl.textContent = message.payload.state.error || message.payload.state.summary || '';
      }
      if (message.payload.results) {
        renderResults(message.payload.results.items || []);
      }
      persistState();
      return;
    }
    if (message.type === 'focus') queryEl.focus();
    if (message.type === 'state') {
      summaryTextEl.textContent = message.error || message.summary || '';
      if (ctagsProgressRowEl) {
        ctagsProgressRowEl.hidden = !message.ctagsInProgress;
        const track = ctagsProgressRowEl.querySelector('.ctagsProgressTrack');
        if (track) {
          track.setAttribute('aria-label', message.summary || message.error || '');
        }
      }
      persistState();
    }
    if (message.type === 'results') renderResults(message.items);
    if (message.type === 'settings') currentSettings = message.payload;
    if (message.type === 'connectionTest') connectionStatusEl.textContent = message.payload.message || '';
  });

  syncToggleState();
  syncPasswordToggle();
  setFieldFocus(includeEl, false);
  setFieldFocus(excludeEl, false);
  vscode.postMessage({ type: 'ready' });
})();
