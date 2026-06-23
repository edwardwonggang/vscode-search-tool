(function () {
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

  window.RipgrepToolIcons = class RipgrepToolIcons {
    constructor(options) {
      this.iconUris = options.iconUris || {};
      this.escapeHtml = options.escapeHtml;
      this.codicons = {
        eye: '&#128065;',
        eyeClosed: '&#128064;',
        chevronRight: '&#9656;',
        chevronDown: '&#9662;'
      };
      this.fileTypeIcons = {};
    }

    async initialize() {
      const fileTypeKeys = this.iconUris.fileTypes ? Object.keys(this.iconUris.fileTypes) : [];
      const fileTypePromises = fileTypeKeys.map(async (key) => [
        key,
        await loadSvgMarkup(this.iconUris.fileTypes[key])
      ]);

      const [caseSensitiveSvg, wholeWordSvg, regexSvg, settingsSvg, definitionSvg, eyeSvg, eyeClosedSvg, chevronRightSvg, chevronDownSvg, closeSvg, ...fileTypeResults] =
        await Promise.all([
          loadSvgMarkup(this.iconUris.caseSensitive),
          loadSvgMarkup(this.iconUris.wholeWord),
          loadSvgMarkup(this.iconUris.regex),
          loadSvgMarkup(this.iconUris.settings),
          loadSvgMarkup(this.iconUris.definition),
          loadSvgMarkup(this.iconUris.eye),
          loadSvgMarkup(this.iconUris.eyeClosed),
          loadSvgMarkup(this.iconUris.chevronRight),
          loadSvgMarkup(this.iconUris.chevronDown),
          loadSvgMarkup(this.iconUris.close),
          ...fileTypePromises
        ]);

      for (const [key, svg] of fileTypeResults) {
        if (svg) {
          this.fileTypeIcons[key] = svg;
        }
      }

      this.codicons.eye = eyeSvg || this.codicons.eye;
      this.codicons.eyeClosed = eyeClosedSvg || this.codicons.eyeClosed;
      this.codicons.chevronRight = chevronRightSvg || this.codicons.chevronRight;
      this.codicons.chevronDown = chevronDownSvg || this.codicons.chevronDown;

      this.setIcon('caseSensitiveIcon', caseSensitiveSvg, 'Aa');
      this.setIcon('wholeWordIcon', wholeWordSvg, 'W');
      this.setIcon('useRegexIcon', regexSvg, '.*');
      this.setIcon('definitionModeIcon', definitionSvg, 'D');
      this.setIcon('settingsIcon', settingsSvg, '&#9881;');
      this.setIcon('closeSettingsIcon', closeSvg, '×');
      this.setIcon('togglePasswordIcon', this.codicons.eye, '&#128065;');
    }

    setIcon(id, svg, fallbackText) {
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

    renderFileIcon(relativePath) {
      const extension = getExtension(relativePath);
      const svg = this.fileTypeIcons[extension] || this.fileTypeIcons.default;
      if (svg) {
        return `<span class="fileIcon" aria-hidden="true"><span class="fileImg">${svg}</span></span>`;
      }
      const badge = fileTypeBadge[extension] || { label: 'F', color: '#8c8c8c' };
      return `<span class="fileIcon" aria-hidden="true" style="background:${badge.color};color:#fff;font-size:7px;font-weight:700;border-radius:2px;display:inline-flex;align-items:center;justify-content:center;min-width:16px;min-height:16px;width:16px;height:16px;box-sizing:border-box;">${this.escapeHtml(badge.label)}</span>`;
    }

    get(name) {
      return this.codicons[name] || '';
    }
  };

  async function loadSvgMarkup(uri) {
    if (!uri) {
      return '';
    }
    try {
      const response = await fetch(uri);
      return response.ok ? await response.text() : '';
    } catch {
      return '';
    }
  }

  function getExtension(relativePath) {
    const parts = String(relativePath).toLowerCase().split('.');
    return parts.length > 1 ? parts[parts.length - 1] : '';
  }
})();
