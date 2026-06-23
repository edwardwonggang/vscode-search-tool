(function () {
  const DEFAULT_LIMIT = 100;

  window.RipgrepToolSearchHistory = class RipgrepToolSearchHistory {
    constructor(options) {
      this.queryInput = options.queryInput;
      this.fileQueryInput = options.fileQueryInput;
      this.onChanged = options.onChanged;
      this.onNavigate = options.onNavigate;
      this.limit = options.limit || DEFAULT_LIMIT;
      this.contentEntries = normalize(options.contentEntries, this.limit);
      this.fileEntries = normalize(options.fileEntries, this.limit);
      this.stateByInput = new Map([
        [this.queryInput, { entries: this.contentEntries, index: this.contentEntries.length, draft: '' }],
        [this.fileQueryInput, { entries: this.fileEntries, index: this.fileEntries.length, draft: '' }]
      ]);
    }

    snapshot() {
      return {
        contentSearchHistory: [...this.contentEntries],
        fileSearchHistory: [...this.fileEntries]
      };
    }

    resetCursor(input) {
      const state = this.stateByInput.get(input);
      if (!state) {
        return;
      }
      state.index = state.entries.length;
      state.draft = '';
    }

    rememberActive() {
      if (String(this.fileQueryInput.value).trim()) {
        this.remember(this.fileQueryInput);
        return;
      }
      this.remember(this.queryInput);
    }

    navigate(input, direction) {
      const state = this.stateByInput.get(input);
      if (!state || !state.entries.length) {
        return false;
      }
      if (state.index === state.entries.length) {
        state.draft = input.value;
      }
      const nextIndex = state.index + direction;
      if (nextIndex < 0 || nextIndex > state.entries.length) {
        return true;
      }
      state.index = nextIndex;
      input.value = state.index === state.entries.length ? state.draft : state.entries[state.index];
      if (input === this.queryInput && input.value) {
        this.fileQueryInput.value = '';
      } else if (input === this.fileQueryInput && input.value) {
        this.queryInput.value = '';
      }
      this.onChanged();
      this.onNavigate();
      return true;
    }

    remember(input) {
      const state = this.stateByInput.get(input);
      if (!state) {
        return;
      }
      const text = String(input.value || '').trim();
      if (!text) {
        this.resetCursor(input);
        return;
      }
      const existingIndex = state.entries.indexOf(text);
      if (existingIndex !== -1) {
        state.entries.splice(existingIndex, 1);
      }
      state.entries.push(text);
      if (state.entries.length > this.limit) {
        state.entries.splice(0, state.entries.length - this.limit);
      }
      this.resetCursor(input);
    }
  };

  function normalize(value, limit) {
    if (!Array.isArray(value)) {
      return [];
    }
    const entries = [];
    for (const item of value) {
      const text = String(item || '').trim();
      if (text && !entries.includes(text)) {
        entries.push(text);
      }
    }
    return entries.slice(-limit);
  }
})();
