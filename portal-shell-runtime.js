(function (window, document) {
  'use strict';

  const VERSION = '1.0.0';
  const DEFAULTS = Object.freeze({
    shellSelector: '[data-portal-shell], .portal-shell',
    navigationSelector: '.portal-nav-v2, [data-portal-navigation]',
    contentSelector: '[data-portal-content], .portal-content, main',
    autoCreateShell: false,
    dispatchEvents: true
  });

  let state = {
    initialized: false,
    options: { ...DEFAULTS },
    shell: null,
    navigation: null,
    content: null,
    user: null,
    activePage: null,
    role: null,
    workspace: null
  };

  function emit(name, detail) {
    if (!state.options.dispatchEvents || typeof window.CustomEvent !== 'function') return;
    document.dispatchEvent(new CustomEvent(name, { detail: detail || {} }));
  }

  function findElement(selector, root) {
    if (!selector) return null;
    return (root || document).querySelector(selector);
  }

  function createShell() {
    const shell = document.createElement('div');
    shell.className = 'portal-shell';
    shell.dataset.portalShell = 'true';

    const content = findElement(state.options.contentSelector);
    if (content && content.parentNode) {
      content.parentNode.insertBefore(shell, content);
      shell.appendChild(content);
    } else {
      document.body.appendChild(shell);
    }
    return shell;
  }

  function resolveElements() {
    state.shell = findElement(state.options.shellSelector);
    if (!state.shell && state.options.autoCreateShell) state.shell = createShell();

    state.navigation = findElement(state.options.navigationSelector, state.shell || document);
    if (!state.navigation) state.navigation = findElement(state.options.navigationSelector);

    state.content = findElement(state.options.contentSelector, state.shell || document);
    if (!state.content) state.content = findElement(state.options.contentSelector);
  }

  function decorateShell() {
    const shell = state.shell || document.body;
    shell.classList.add('portal-shell-ready');
    shell.dataset.portalShellVersion = VERSION;

    if (state.navigation) {
      state.navigation.dataset.portalShellRegion = 'navigation';
    }
    if (state.content) {
      state.content.dataset.portalShellRegion = 'content';
    }
  }

  function synchronizeDataset() {
    const shell = state.shell || document.body;
    const values = {
      portalRole: state.role,
      portalWorkspace: state.workspace && state.workspace.id ? state.workspace.id : state.workspace,
      portalPage: state.activePage
    };

    Object.keys(values).forEach(key => {
      const value = values[key];
      if (value === null || value === undefined || value === '') delete shell.dataset[key];
      else shell.dataset[key] = String(value);
    });
  }

  function initialize(options) {
    state.options = { ...DEFAULTS, ...(options || {}) };
    resolveElements();
    decorateShell();
    state.initialized = true;
    synchronizeDataset();

    emit('portal:shell:ready', getState());
    return api;
  }

  function ensureInitialized() {
    if (!state.initialized) initialize();
  }

  function setUser(user) {
    ensureInitialized();
    state.user = user || null;
    emit('portal:shell:user-changed', { user: state.user });
    return api;
  }

  function setPage(activePage) {
    ensureInitialized();
    state.activePage = activePage || null;
    synchronizeDataset();
    emit('portal:shell:page-changed', { activePage: state.activePage });
    return api;
  }

  function setRole(role) {
    ensureInitialized();
    state.role = role || null;
    synchronizeDataset();
    emit('portal:shell:role-changed', { role: state.role });
    return api;
  }

  function setWorkspace(workspace) {
    ensureInitialized();
    state.workspace = workspace || null;
    synchronizeDataset();
    emit('portal:shell:workspace-changed', { workspace: state.workspace });
    return api;
  }

  function refresh() {
    ensureInitialized();
    resolveElements();
    decorateShell();
    synchronizeDataset();
    emit('portal:shell:refreshed', getState());
    return api;
  }

  function getState() {
    return {
      version: VERSION,
      initialized: state.initialized,
      shell: state.shell,
      navigation: state.navigation,
      content: state.content,
      user: state.user,
      activePage: state.activePage,
      role: state.role,
      workspace: state.workspace
    };
  }

  function destroy() {
    const shell = state.shell || document.body;
    shell.classList.remove('portal-shell-ready');
    delete shell.dataset.portalShellVersion;
    delete shell.dataset.portalRole;
    delete shell.dataset.portalWorkspace;
    delete shell.dataset.portalPage;

    state = {
      initialized: false,
      options: { ...DEFAULTS },
      shell: null,
      navigation: null,
      content: null,
      user: null,
      activePage: null,
      role: null,
      workspace: null
    };
    emit('portal:shell:destroyed', {});
  }

  const api = Object.freeze({
    version: VERSION,
    initialize,
    refresh,
    setUser,
    setPage,
    setRole,
    setWorkspace,
    getState,
    destroy
  });

  window.PortalShell = api;
})(window, document);
