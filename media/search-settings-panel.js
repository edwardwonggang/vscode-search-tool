(function () {
  window.RipgrepToolSettingsPanel = class RipgrepToolSettingsPanel {
    constructor(options) {
      this.elements = options.elements;
      this.defaultRemotePort = options.defaultRemotePort;
      this.defaultIncludeGlobs = options.defaultIncludeGlobs;
      this.defaultExcludeGlobs = options.defaultExcludeGlobs;
      this.getCurrentSettings = options.getCurrentSettings;
      this.translate = options.translate;
      this.renderBlocked = options.renderBlocked;
      this.isGitRootOk = options.isGitRootOk;
      this.persistState = options.persistState;
      this.syncCurrentRemotePathDisplay = options.syncCurrentRemotePathDisplay;
      this.setIcon = options.setIcon;
      this.getEyeIcon = options.getEyeIcon;
      this.getEyeClosedIcon = options.getEyeClosedIcon;
    }

    open() {
      if (!this.isGitRootOk()) {
        this.renderBlocked();
        return;
      }
      const settings = this.getCurrentSettings();
      this.elements.remoteHost.value = settings.remoteHost || '';
      this.elements.remotePort.value = String(settings.remotePort || this.defaultRemotePort);
      this.elements.remoteUsername.value = settings.remoteUsername || '';
      this.elements.remotePassword.value = settings.remotePassword || '';
      this.elements.remoteSearchPath.value = settings.remoteSearchPath || '';
      this.elements.includeGlobs.value = settings.includeGlobs.join('\n');
      this.elements.excludeGlobs.value = settings.excludeGlobs.join('\n');
      this.elements.connectionStatus.textContent = '';
      this.syncCurrentRemotePathDisplay();
      this.elements.layer.classList.add('open');
      this.elements.remoteHost.focus();
    }

    close() {
      this.elements.layer.classList.remove('open');
      this.persistState();
    }

    reset() {
      if (!this.isGitRootOk()) {
        this.renderBlocked();
        return;
      }
      this.elements.remoteHost.value = '';
      this.elements.remotePort.value = String(this.defaultRemotePort);
      this.elements.remoteUsername.value = '';
      this.elements.remotePassword.value = '';
      this.elements.remoteSearchPath.value = '';
      this.elements.includeGlobs.value = this.defaultIncludeGlobs.join('\n');
      this.elements.excludeGlobs.value = this.defaultExcludeGlobs.join('\n');
      this.elements.connectionStatus.textContent = '';
      this.syncCurrentRemotePathDisplay('');
    }

    buildPayload() {
      const remotePort = Number.parseInt(this.elements.remotePort.value, 10);
      return {
        remoteHost: this.elements.remoteHost.value.trim(),
        remotePort: Number.isFinite(remotePort) ? remotePort : this.defaultRemotePort,
        remoteUsername: this.elements.remoteUsername.value.trim(),
        remotePassword: this.elements.remotePassword.value,
        remoteSearchPath: this.elements.remoteSearchPath.value.trim(),
        includeGlobs: splitLines(this.elements.includeGlobs.value),
        excludeGlobs: splitLines(this.elements.excludeGlobs.value)
      };
    }

    togglePassword() {
      if (!this.isGitRootOk()) {
        return;
      }
      this.elements.remotePassword.type = this.elements.remotePassword.type === 'password' ? 'text' : 'password';
      this.syncPasswordToggle();
    }

    syncPasswordToggle() {
      this.elements.togglePasswordButton.title = this.elements.remotePassword.type === 'password'
        ? this.translate('show_password')
        : this.translate('hide_password');
      this.setIcon(
        'togglePasswordIcon',
        this.elements.remotePassword.type === 'password'
          ? (this.getEyeIcon() || '')
          : (this.getEyeClosedIcon() || '')
      );
    }

    setConnectionStatus(message) {
      this.elements.connectionStatus.textContent = message || '';
    }

    isOpen() {
      return this.elements.layer.classList.contains('open');
    }
  };

  function splitLines(value) {
    return value.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
  }
})();
