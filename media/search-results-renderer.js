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
      this.itemIndexByPath = new Map();
      this.matchCounts = [];
      this.matchPrefix = [0];
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
      const beforePaths = new Set(this.itemByPath.keys());
      this.items = mergeResultItems(this.items, items, this.itemByPath);
      this.traceRenderPhase('merge-normalize', startedAt, { incomingFiles: items.length, files: this.items.length });
      let hasNewFile = false;
      for (const item of items) {
        if (!beforePaths.has(String(item?.path || ''))) {
          hasNewFile = true;
          break;
        }
      }
      if (hasNewFile) {
        // 新增文件会改变整体排序，走全量重建（文件级模型，成本与文件数相关）。
        this.requestFullRender('merge');
        return;
      }
      // 纯追加/更新：只调整受影响文件的匹配行计数与前缀和，再渲染可见行。
      this.applyMatchCountDeltas(items);
      this.renderVisibleRows();
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
      this.rebuildModel(isFileSearch);
      this.traceRenderPhase('build-model', buildStartedAt, {
        files: this.items.length,
        rows: this.totalRowCount(),
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

    // 从当前 items 全量重建文件级行模型：matchCounts 为每个文件的可见匹配行数，
    // matchPrefix[i] 为前 i 个文件的匹配行总数；行位置由固定行高推导，无需逐行存 top。
    rebuildModel(isFileSearch) {
      this.itemIndexByPath = new Map();
      this.matchCounts = this.items.map((item, index) => {
        this.itemIndexByPath.set(item.path, index);
        if (isFileSearch || this.collapsedFiles.has(item.path)) {
          return 0;
        }
        return Array.isArray(item.matches) ? item.matches.length : 0;
      });
      this.matchPrefix = [0];
      let totalMatches = 0;
      for (const count of this.matchCounts) {
        totalMatches += count;
        this.matchPrefix.push(totalMatches);
      }
      this.totalHeight = this.items.length * RESULT_FILE_ROW_HEIGHT + totalMatches * RESULT_MATCH_ROW_HEIGHT;
    }

    // 纯追加/更新场景：只调整受影响文件的匹配行数与前缀和，避免全量重建。
    applyMatchCountDeltas(changedItems) {
      const isFileSearch = this.getIsFileSearch();
      const deltas = [];
      for (const raw of changedItems) {
        const item = normalizeResultItem(raw);
        const index = this.itemIndexByPath.get(item.path);
        if (index === undefined) {
          continue;
        }
        const newCount = isFileSearch || this.collapsedFiles.has(item.path)
          ? 0
          : Array.isArray(item.matches) ? item.matches.length : 0;
        const oldCount = this.matchCounts[index] ?? 0;
        if (newCount !== oldCount) {
          this.matchCounts[index] = newCount;
          deltas.push({ index, delta: newCount - oldCount });
        }
      }
      if (!deltas.length) {
        return;
      }
      deltas.sort((left, right) => left.index - right.index);
      // 从后往前应用累计增量到 matchPrefix：matchCounts[index] 的变化影响
      // 所有 matchPrefix[i]（i > index），O(文件数) 而非 O(行数)。
      let cumulative = deltas.reduce((total, delta) => total + delta.delta, 0);
      let removeAt = deltas.length - 1;
      for (let i = this.matchPrefix.length - 1; i >= 0; i -= 1) {
        if (cumulative !== 0) {
          this.matchPrefix[i] += cumulative;
        }
        // 下一步 i-1 不再受 index === i-1 的 delta 影响，移除其贡献。
        while (removeAt >= 0 && deltas[removeAt].index === i - 1) {
          cumulative -= deltas[removeAt].delta;
          removeAt -= 1;
        }
      }
      this.totalHeight += deltas.reduce((total, delta) => total + delta.delta, 0) * RESULT_MATCH_ROW_HEIGHT;
    }

    renderVisibleRows() {
      if (!this.items.length) {
        return;
      }
      const scrollTop = this.resultsEl.scrollTop;
      const viewportHeight = this.resultsEl.clientHeight || 600;
      this.lastRenderedScrollTop = scrollTop;
      const start = Math.max(0, scrollTop - RESULT_OVERSCAN_PX);
      const end = scrollTop + viewportHeight + RESULT_OVERSCAN_PX;
      const visible = this.collectVisibleRows(start, end);
      const html = visible.rows.map((row) => this.renderRow(row)).join('');
      const domStartedAt = performance.now();
      if (!this.virtualResultsEl || this.virtualResultsEl.parentElement !== this.resultsEl || !this.virtualRowsEl) {
        this.resultsEl.innerHTML = '<div class="virtualResults"><div class="virtualSpacerTop"></div><div class="virtualRows"></div><div class="virtualSpacerBottom"></div></div>';
        this.virtualResultsEl = this.resultsEl.querySelector('.virtualResults');
        this.topSpacerEl = this.resultsEl.querySelector('.virtualSpacerTop');
        this.virtualRowsEl = this.resultsEl.querySelector('.virtualRows');
        this.bottomSpacerEl = this.resultsEl.querySelector('.virtualSpacerBottom');
      }
      this.topSpacerEl.style.height = `${visible.topSpacerHeight}px`;
      this.bottomSpacerEl.style.height = `${Math.max(0, this.totalHeight - visible.renderedEnd)}px`;
      this.virtualRowsEl.innerHTML = html;
      this.traceRenderPhase('visible-dom', domStartedAt, {
        visibleRows: visible.rows.length,
        totalRows: this.totalRowCount(),
        scrollTop: Math.round(scrollTop)
      });
      window.requestAnimationFrame(() => {
        this.finishRenderMeasure();
        if (this.items.length && this.resultsEl.scrollTop !== this.lastRenderedScrollTop) {
          this.renderVisibleRows();
        }
      });
    }

    totalRowCount() {
      return this.items.length + (this.matchPrefix[this.matchPrefix.length - 1] ?? 0);
    }

    // 收集 [start, end) 范围内的可见行。行位置由文件级模型直接推导：
    // 文件 i 的头部行 top = i*FILE_H + matchPrefix[i]*MATCH_H，其第 j 个匹配行
    // top = 头部 top + FILE_H + j*MATCH_H。
    collectVisibleRows(start, end) {
      const isFileSearch = this.getIsFileSearch();
      const rows = [];
      const firstIndex = this.findFirstVisibleItemIndex(start);
      for (let index = firstIndex; index < this.items.length; index += 1) {
        const fileTop = index * RESULT_FILE_ROW_HEIGHT + (this.matchPrefix[index] ?? 0) * RESULT_MATCH_ROW_HEIGHT;
        if (fileTop > end) {
          break;
        }
        const file = this.items[index];
        const collapsed = !isFileSearch && this.collapsedFiles.has(file.path);
        const matches = Array.isArray(file.matches) ? file.matches : [];
        let matchIndex = 0;
        const matchStartTop = fileTop + RESULT_FILE_ROW_HEIGHT;
        if (!isFileSearch && !collapsed && start > matchStartTop) {
          matchIndex = Math.max(0, Math.floor((start - matchStartTop) / RESULT_MATCH_ROW_HEIGHT));
        }
        const hasVisibleMatch = !isFileSearch && !collapsed && matchIndex < matches.length;
        if (fileTop < start && !hasVisibleMatch) {
          // 文件头在视口之前且本文件没有可见匹配行（如 start 恰好落在该文件
          // 匹配块末尾之后），整体跳过，避免 spacer 高度错位。
          continue;
        }
        if (fileTop >= start) {
          rows.push({ type: 'file', file, index, isFileSearch, collapsed, top: fileTop });
        }
        if (hasVisibleMatch) {
          for (; matchIndex < matches.length; matchIndex += 1) {
            const matchTop = matchStartTop + matchIndex * RESULT_MATCH_ROW_HEIGHT;
            if (matchTop > end) {
              break;
            }
            rows.push({ type: 'match', file, match: matches[matchIndex], top: matchTop });
          }
        }
      }
      const lastVisible = rows[rows.length - 1];
      const renderedEnd = lastVisible
        ? lastVisible.top + (lastVisible.type === 'file' ? RESULT_FILE_ROW_HEIGHT : RESULT_MATCH_ROW_HEIGHT)
        : start;
      return {
        rows,
        topSpacerHeight: rows.length ? rows[0].top : start,
        renderedEnd
      };
    }

    findFirstVisibleItemIndex(start) {
      let low = 0;
      let high = this.items.length - 1;
      let result = 0;
      while (low <= high) {
        const mid = Math.floor((low + high) / 2);
        const fileBottom = mid * RESULT_FILE_ROW_HEIGHT
          + (this.matchPrefix[mid] ?? 0) * RESULT_MATCH_ROW_HEIGHT
          + RESULT_FILE_ROW_HEIGHT
          + (this.matchCounts[mid] ?? 0) * RESULT_MATCH_ROW_HEIGHT;
        if (fileBottom >= start) {
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
        totalRows: this.totalRowCount()
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
