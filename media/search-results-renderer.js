(function () {
  const RESULT_FILE_ROW_HEIGHT = 22;
  const RESULT_MATCH_ROW_HEIGHT = 22;
  const RESULT_OVERSCAN_PX = 650;

  window.RipgrepToolResultsRenderer = class RipgrepToolResultsRenderer {
    constructor(options) {
      this.resultsEl = options.resultsEl;
      this.collapsedFiles = options.collapsedFiles;
      this.isWorkspaceOk = options.isWorkspaceOk;
      this.getWorkspaceMessage = options.getWorkspaceMessage;
      this.getIsFileSearch = options.getIsFileSearch;
      this.renderWorkspaceBlocked = options.renderWorkspaceBlocked;
      this.renderEmpty = options.renderEmpty;
      this.renderFileIcon = options.renderFileIcon;
      this.formatPreview = options.formatPreview;
      this.escapeHtml = options.escapeHtml;
      this.persistState = options.persistState;
      this.getChevronRight = options.getChevronRight;
      this.getChevronDown = options.getChevronDown;
      this.items = [];
      this.itemByPath = new Map();
      this.rows = [];
      this.totalHeight = 0;
      this.renderFrame = 0;
      this.virtualResultsEl = null;
      this.topSpacerEl = null;
      this.virtualRowsEl = null;
      this.bottomSpacerEl = null;
      this.lastRenderedScrollTop = -1;
      this.afterRender = typeof options.afterRender === 'function' ? options.afterRender : () => {};
      this.trace = typeof options.trace === 'function' ? options.trace : () => {};
      this.renderStartedAt = 0;
      this.renderedItemCount = 0;
      this.pendingRenderAll = false;
      this.pendingPersist = false;
      this.resultsEl.addEventListener('scroll', () => this.requestRender(), { passive: true, capture: true });
      this.resultsEl.addEventListener('wheel', () => this.requestRender(), { passive: true, capture: true });
    }

    replace(items) {
      const startedAt = performance.now();
      this.startRenderMeasure(items);
      this.items = normalizeResultItems(items);
      this.itemByPath = new Map(this.items.map((item) => [item.path, item]));
      this.traceRenderPhase('replace-normalize', startedAt, { incomingFiles: Array.isArray(items) ? items.length : 0 });
      this.resultsEl.scrollTop = 0;
      this.lastRenderedScrollTop = -1;
      this.requestFullRender('replace');
    }

    merge(items) {
      if (!Array.isArray(items) || !items.length) {
        return;
      }
      const startedAt = performance.now();
      this.startRenderMeasure(items);
      this.items = mergeResultItems(this.items, items, this.itemByPath);
      this.traceRenderPhase('merge-normalize', startedAt, { incomingFiles: items.length, files: this.items.length });
      this.requestFullRender('merge');
    }

    rerender() {
      this.requestFullRender('rerender');
    }

    render() {
      if (!this.isWorkspaceOk()) {
        this.renderWorkspaceBlocked(this.getWorkspaceMessage());
        return;
      }
      const isFileSearch = this.getIsFileSearch();
      if (!this.items.length) {
        this.virtualResultsEl = null;
        this.topSpacerEl = null;
        this.virtualRowsEl = null;
        this.bottomSpacerEl = null;
        this.resultsEl.innerHTML = this.renderEmpty();
        this.schedulePersistState();
        return;
      }
      const buildStartedAt = performance.now();
      this.rows = this.buildRows(this.items, isFileSearch);
      this.totalHeight = this.rows.reduce((total, row) => total + row.height, 0);
      this.traceRenderPhase('build-rows', buildStartedAt, {
        files: this.items.length,
        rows: this.rows.length,
        height: this.totalHeight
      });
      this.renderVisibleRows();
      this.schedulePersistState();
    }

    requestFullRender(reason) {
      if (this.pendingRenderAll) {
        return;
      }
      this.pendingRenderAll = true;
      requestAnimationFrame(() => {
        this.pendingRenderAll = false;
        this.trace('render-scheduled', { reason });
        this.render();
      });
    }

    requestRender() {
      if (this.renderFrame) {
        return;
      }
      this.renderFrame = requestAnimationFrame(() => {
        this.renderFrame = 0;
        this.renderVisibleRows();
      });
    }

    buildRows(items, isFileSearch) {
      let top = 0;
      const rows = [];
      items.forEach((file, index) => {
        const collapsed = !isFileSearch && this.collapsedFiles.has(file.path);
        const matches = Array.isArray(file.matches) ? file.matches : [];
        rows.push({
          type: 'file',
          file,
          index,
          isFileSearch,
          collapsed,
          top,
          height: RESULT_FILE_ROW_HEIGHT
        });
        top += RESULT_FILE_ROW_HEIGHT;
        if (!isFileSearch && !collapsed) {
          for (const match of matches) {
            rows.push({
              type: 'match',
              file,
              match,
              top,
              height: RESULT_MATCH_ROW_HEIGHT
            });
            top += RESULT_MATCH_ROW_HEIGHT;
          }
        }
      });
      return rows;
    }

    renderVisibleRows() {
      if (!this.rows.length) {
        return;
      }
      const scrollTop = this.resultsEl.scrollTop;
      const viewportHeight = this.resultsEl.clientHeight || 600;
      this.lastRenderedScrollTop = scrollTop;
      const start = Math.max(0, scrollTop - RESULT_OVERSCAN_PX);
      const end = scrollTop + viewportHeight + RESULT_OVERSCAN_PX;
      const firstIndex = this.findFirstVisibleRow(start);
      const visibleRows = [];
      for (let index = firstIndex; index < this.rows.length; index += 1) {
        const row = this.rows[index];
        if (row.top > end) {
          break;
        }
        visibleRows.push(row);
      }
      const html = visibleRows.map((row) => this.renderRow(row)).join('');
      const domStartedAt = performance.now();
      if (!this.virtualResultsEl || this.virtualResultsEl.parentElement !== this.resultsEl || !this.virtualRowsEl) {
        this.resultsEl.innerHTML = '<div class="virtualResults"><div class="virtualSpacerTop"></div><div class="virtualRows"></div><div class="virtualSpacerBottom"></div></div>';
        this.virtualResultsEl = this.resultsEl.querySelector('.virtualResults');
        this.topSpacerEl = this.resultsEl.querySelector('.virtualSpacerTop');
        this.virtualRowsEl = this.resultsEl.querySelector('.virtualRows');
        this.bottomSpacerEl = this.resultsEl.querySelector('.virtualSpacerBottom');
      }
      const topSpacerHeight = visibleRows.length ? visibleRows[0].top : 0;
      const lastVisibleRow = visibleRows[visibleRows.length - 1];
      const renderedEnd = lastVisibleRow ? lastVisibleRow.top + lastVisibleRow.height : topSpacerHeight;
      this.topSpacerEl.style.height = `${topSpacerHeight}px`;
      this.bottomSpacerEl.style.height = `${Math.max(0, this.totalHeight - renderedEnd)}px`;
      this.virtualRowsEl.innerHTML = html;
      this.traceRenderPhase('visible-dom', domStartedAt, {
        visibleRows: visibleRows.length,
        totalRows: this.rows.length,
        scrollTop: Math.round(scrollTop)
      });
      window.requestAnimationFrame(() => {
        this.finishRenderMeasure();
        if (this.rows.length && this.resultsEl.scrollTop !== this.lastRenderedScrollTop) {
          this.renderVisibleRows();
        }
      });
    }

    findFirstVisibleRow(start) {
      let low = 0;
      let high = this.rows.length - 1;
      let result = 0;
      while (low <= high) {
        const mid = Math.floor((low + high) / 2);
        const row = this.rows[mid];
        if (row.top + row.height >= start) {
          result = mid;
          high = mid - 1;
        } else {
          low = mid + 1;
        }
      }
      return result;
    }

    renderRow(row) {
      if (row.type === 'match') {
        return this.renderMatch(row.match);
      }
      return this.renderFile(row.file, row.index, row.isFileSearch, row.collapsed);
    }

    renderFile(file, index, isFileSearch, collapsed) {
      const parts = splitPath(file.relativePath);
      const chevron = collapsed ? this.getChevronRight() : this.getChevronDown();
      const matches = Array.isArray(file.matches) ? file.matches : [];
      const filePayload = encodeURIComponent(JSON.stringify(matches[0] || {
        path: file.path,
        line: 1,
        column: 1,
        endColumn: 2,
        preview: file.relativePath
      }));
      return `<div class="fileVirtualRow ${isFileSearch ? 'fileSearchResult' : ''}">
        <button class="fileHeader" type="button" ${isFileSearch ? `data-match="${filePayload}"` : `data-toggle-file="${encodeURIComponent(file.path)}"`}>
          <span class="treeIcon" aria-hidden="true">${chevron}</span>
          ${this.renderFileIcon(file.relativePath)}
          <span class="fileName fileNameColor${index % 30}">
            <span class="base">${this.escapeHtml(parts.name)}</span>
            <span class="dir">${this.escapeHtml(parts.dir)}</span>
          </span>
          <span class="badge">${isFileSearch ? '' : matches.length}</span>
        </button>
      </div>`;
    }

    renderMatch(match) {
      const payload = encodeURIComponent(JSON.stringify(match));
      return `<button class="match virtualMatchRow" type="button" data-match="${payload}">
        <span class="matchTreeSpacer" aria-hidden="true"></span>
        <span class="preview">${this.formatPreview(match.preview, match)}</span>
      </button>`;
    }

    startRenderMeasure(items) {
      this.renderStartedAt = performance.now();
      this.renderedItemCount = countMatches(items);
    }

    finishRenderMeasure() {
      if (!this.renderStartedAt) {
        return;
      }
      const elapsedMs = Math.max(0, Math.round(performance.now() - this.renderStartedAt));
      this.afterRender({
        elapsedMs,
        fileCount: this.items.length,
        matchCount: this.renderedItemCount || countMatches(this.items),
        totalRows: this.rows.length
      });
      this.renderStartedAt = 0;
      this.renderedItemCount = 0;
    }

    schedulePersistState() {
      if (this.pendingPersist) {
        return;
      }
      this.pendingPersist = true;
      window.setTimeout(() => {
        this.pendingPersist = false;
        this.persistState();
      }, 250);
    }

    traceRenderPhase(phase, startedAt, extra) {
      const elapsedMs = Math.max(0, Math.round(performance.now() - startedAt));
      if (elapsedMs < 50 && phase !== 'render-scheduled') {
        return;
      }
      this.trace(phase, { elapsedMs, ...extra });
    }
  };

  function countMatches(items) {
    if (!Array.isArray(items)) {
      return 0;
    }
    return items.reduce((total, item) => total + (Array.isArray(item?.matches) ? item.matches.length : 0), 0);
  }

  function normalizeResultItems(items) {
    if (!Array.isArray(items)) {
      return [];
    }
    return items.map((item) => normalizeResultItem(item))
      .sort((left, right) => String(left.relativePath).localeCompare(String(right.relativePath)));
  }

  function normalizeResultItem(item) {
    const matches = Array.isArray(item?.matches) ? item.matches : [];
    return {
      ...item,
      path: String(item?.path || ''),
      relativePath: String(item?.relativePath || item?.path || ''),
      count: matches.length,
      matches
    };
  }

  function mergeResultItems(currentItems, changedItems, byPath) {
    const resultByPath = byPath instanceof Map ? byPath : new Map(normalizeResultItems(currentItems).map((item) => [item.path, item]));
    let addedFile = false;
    for (const item of normalizeResultItems(changedItems)) {
      const existing = resultByPath.get(item.path);
      if (existing) {
        Object.assign(existing, mergeResultItem(existing, item));
        resultByPath.set(item.path, existing);
      } else {
        resultByPath.set(item.path, item);
        addedFile = true;
      }
    }
    if (!addedFile) {
      return currentItems;
    }
    return Array.from(resultByPath.values())
      .sort((left, right) => String(left.relativePath).localeCompare(String(right.relativePath)));
  }

  function mergeResultItem(existing, changed) {
    const matches = mergeMatches(existing.matches, changed.matches);
    return {
      ...existing,
      ...changed,
      count: matches.length,
      matches
    };
  }

  function mergeMatches(currentMatches, changedMatches) {
    const merged = [];
    const seen = new Set();
    for (const match of [...currentMatches, ...changedMatches]) {
      const key = getMatchKey(match);
      if (seen.has(key)) {
        continue;
      }
      seen.add(key);
      merged.push(match);
    }
    return merged;
  }

  function getMatchKey(match) {
    return [
      match?.uri || match?.path || '',
      match?.relativePath || '',
      match?.line || 0,
      match?.column || 0,
      match?.endColumn || 0,
      match?.symbolName || ''
    ].join('\u0001');
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
})();
