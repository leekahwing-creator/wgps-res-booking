(function (window, document) {
  'use strict';

  const VERSION = '2.1.2-hf2';
  const SELECTORS = Object.freeze({
    navigation: '.portal-nav-v2, [data-portal-navigation]',
    desktopHost: '.nav-main, [data-portal-workspace-control]',
    mobileHost: '.mobile-drawer-links, [data-portal-mobile-links]',
    brand: '.nav-brand, [data-portal-brand]',
    workspaceNavigation: '.portal-workspace-nav, [data-portal-workspace-navigation]'
  });

  const CLASSNAMES = Object.freeze({
    workspaceNavigation: 'portal-workspace-nav',
    workspaceControl: 'global-workspace-control',
    workspaceSelect: 'workspace-select',
    pageLink: 'nav-link',
    ready: 'nav-ready',
    mobileOpen: 'mobile-open'
  });

  let currentContext = null;

  function requireRegistry() {
    if (!window.PortalRegistry) {
      console.error('PortalRegistry is required before portalNavigation.js.');
      return false;
    }
    return true;
  }

  function textElement(tag, className, text) {
    const element = document.createElement(tag);
    if (className) element.className = className;
    element.textContent = text == null ? '' : String(text);
    return element;
  }

  function sortedPages(workspace) {
    return (workspace && Array.isArray(workspace.pages) ? workspace.pages : [])
      .slice()
      .sort((a, b) => (a.order || 0) - (b.order || 0));
  }

  function closeMobileNavigation(nav) {
    if (nav) nav.classList.remove(CLASSNAMES.mobileOpen);
  }

  function closeAllWorkspaceMenus(except) {
    document.querySelectorAll('.workspace-picker.is-open').forEach(picker => {
      if (picker === except) return;
      picker.classList.remove('is-open');
      const button = picker.querySelector('.workspace-picker-button');
      if (button) button.setAttribute('aria-expanded', 'false');
    });
  }

  function createPageLink(page, activePage, role, mobile) {
    const link = document.createElement('a');
    link.href = page.href;
    link.className = CLASSNAMES.pageLink;
    link.dataset.page = page.id;

    if (page.id === activePage) {
      link.classList.add('active');
      link.setAttribute('aria-current', 'page');
    }

    const icon = textElement('span', 'nav-icon', page.icon || '•');
    icon.setAttribute('aria-hidden', 'true');
    const label = role === 'Admin' && page.adminLabel ? page.adminLabel : page.label;
    link.append(icon, textElement('span', 'nav-label', label || page.id));

    if (mobile) {
      link.addEventListener('click', () => closeMobileNavigation(link.closest(SELECTORS.navigation)));
    }
    return link;
  }

  function createWorkspacePicker(workspaces, selectedWorkspaceId, role, className) {
    const picker = document.createElement('div');
    picker.className = `workspace-picker${className ? ` ${className}` : ''}`;

    const selectedWorkspace = workspaces.find(item => item.id === selectedWorkspaceId) || workspaces[0];
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'workspace-picker-button';
    button.setAttribute('aria-haspopup', 'listbox');
    button.setAttribute('aria-expanded', 'false');
    button.innerHTML = `<span class="workspace-picker-value"></span><span class="workspace-picker-chevron" aria-hidden="true"></span>`;
    button.querySelector('.workspace-picker-value').textContent = selectedWorkspace ? selectedWorkspace.label : '';

    const menu = document.createElement('div');
    menu.className = 'workspace-picker-menu';
    menu.setAttribute('role', 'listbox');
    menu.setAttribute('aria-label', 'Select workspace');
    menu.tabIndex = -1;

    workspaces.forEach(workspace => {
      const option = document.createElement('button');
      option.type = 'button';
      option.className = 'workspace-picker-option';
      option.dataset.workspaceId = workspace.id;
      option.setAttribute('role', 'option');
      option.setAttribute('aria-selected', workspace.id === selectedWorkspaceId ? 'true' : 'false');
      option.innerHTML = `<span class="workspace-picker-option-icon" aria-hidden="true"></span><span class="workspace-picker-option-label"></span>`;
      option.querySelector('.workspace-picker-option-icon').textContent = workspace.icon || '•';
      option.querySelector('.workspace-picker-option-label').textContent = workspace.label;
      option.addEventListener('click', () => {
        picker.classList.remove('is-open');
        button.setAttribute('aria-expanded', 'false');
        if (workspace.id === selectedWorkspaceId) return;
        const page = window.PortalRegistry.getLandingPage(role, workspace.id);
        if (page && page.href) window.location.assign(page.href);
      });
      menu.appendChild(option);
    });

    button.addEventListener('click', event => {
      event.stopPropagation();
      const opening = !picker.classList.contains('is-open');
      closeAllWorkspaceMenus(picker);
      picker.classList.toggle('is-open', opening);
      button.setAttribute('aria-expanded', opening ? 'true' : 'false');
      if (opening) menu.focus({ preventScroll: true });
    });

    picker.addEventListener('keydown', event => {
      const options = Array.from(menu.querySelectorAll('.workspace-picker-option'));
      const activeIndex = options.indexOf(document.activeElement);
      if (event.key === 'Escape') {
        picker.classList.remove('is-open');
        button.setAttribute('aria-expanded', 'false');
        button.focus();
      } else if (event.key === 'ArrowDown') {
        event.preventDefault();
        if (!picker.classList.contains('is-open')) button.click();
        const next = activeIndex < 0 ? 0 : Math.min(activeIndex + 1, options.length - 1);
        options[next] && options[next].focus();
      } else if (event.key === 'ArrowUp') {
        event.preventDefault();
        if (!picker.classList.contains('is-open')) button.click();
        const next = activeIndex < 0 ? options.length - 1 : Math.max(activeIndex - 1, 0);
        options[next] && options[next].focus();
      }
    });

    picker.append(button, menu);
    return picker;
  }

  function determineCurrentWorkspace(workspaces, activePage) {
    const pageMatch = window.PortalRegistry.getPage(activePage);
    if (pageMatch && pageMatch.workspace && workspaces.some(item => item.id === pageMatch.workspace.id)) {
      return pageMatch.workspace;
    }
    return workspaces[0] || null;
  }

  function renderGlobalWorkspaceControl(nav, role, workspaces, currentWorkspace) {
    const host = nav.querySelector(SELECTORS.desktopHost);
    if (!host) return;
    host.replaceChildren();

    const hasMultipleWorkspaces = workspaces.length > 1;
    nav.classList.toggle('has-workspace-switcher', hasMultipleWorkspaces);
    nav.classList.toggle('single-workspace', !hasMultipleWorkspaces);

    if (!hasMultipleWorkspaces) {
      host.hidden = true;
      host.setAttribute('aria-hidden', 'true');
      return;
    }

    host.hidden = false;
    host.removeAttribute('aria-hidden');

    const control = document.createElement('div');
    control.className = CLASSNAMES.workspaceControl;
    control.dataset.portalComponent = 'workspace-control';
    control.appendChild(textElement('span', 'workspace-switcher-label', 'Workspace'));
    control.appendChild(createWorkspacePicker(workspaces, currentWorkspace.id, role));
    host.appendChild(control);
  }

  function findWorkspaceNavigation(nav) {
    return nav.querySelector(SELECTORS.workspaceNavigation);
  }

  function removeLegacySiblingNavigation(nav) {
    const parent = nav.parentElement;
    if (!parent) return;
    Array.from(parent.children)
      .filter(element => element !== nav && element.matches && element.matches(SELECTORS.workspaceNavigation))
      .forEach(element => element.remove());
  }

  function renderWorkspaceNavigation(nav, role, workspaces, currentWorkspace, activePage) {
    removeLegacySiblingNavigation(nav);
    const existing = findWorkspaceNavigation(nav);
    if (existing) existing.remove();

    const bar = document.createElement('div');
    bar.className = `${CLASSNAMES.workspaceNavigation} portal-header-subnav`;
    bar.dataset.portalWorkspaceNavigation = 'true';
    bar.dataset.workspaceCount = String(workspaces.length);
    bar.setAttribute('role', 'navigation');
    bar.setAttribute('aria-label', `${currentWorkspace.label} navigation`);

    if (workspaces.length === 1) bar.classList.add('single-workspace-nav');

    const cue = document.createElement('div');
    cue.className = 'workspace-nav-cue';
    cue.innerHTML = '<span class="workspace-nav-cue-icon" aria-hidden="true">▦</span><span>Workspace pages</span>';

    const links = document.createElement('div');
    links.className = 'workspace-page-links';
    sortedPages(currentWorkspace).forEach(page => {
      links.appendChild(createPageLink(page, activePage, role, false));
    });

    bar.append(cue, links);

    const mobileDrawer = nav.querySelector('.mobile-drawer, [data-portal-mobile-drawer]');
    if (mobileDrawer) nav.insertBefore(bar, mobileDrawer);
    else nav.appendChild(bar);

    return bar;
  }

  function renderMobileNavigation(nav, role, workspaces, currentWorkspace, activePage) {
    const host = nav.querySelector(SELECTORS.mobileHost);
    if (!host) return;
    host.replaceChildren();

    if (workspaces.length > 1) {
      const panel = document.createElement('div');
      panel.className = 'mobile-workspace-panel';
      panel.appendChild(textElement('span', 'workspace-switcher-label', 'Workspace'));
      panel.appendChild(createWorkspacePicker(workspaces, currentWorkspace.id, role, 'mobile-workspace-picker'));
      host.appendChild(panel);
    }

    sortedPages(currentWorkspace).forEach(page => {
      host.appendChild(createPageLink(page, activePage, role, true));
    });
  }

  function updateUserDisplay(nav, user) {
    const name = user.name || 'User';
    const email = user.email || '';
    const initial = name.trim().charAt(0).toUpperCase() || 'U';

    nav.querySelectorAll('[data-nav-name]').forEach(element => { element.textContent = name; });
    nav.querySelectorAll('[data-nav-email]').forEach(element => { element.textContent = email; });
    nav.querySelectorAll('[data-nav-initial]').forEach(element => { element.textContent = initial; });

    const legacyDisplay = document.getElementById('currentUserDisplay');
    if (legacyDisplay) legacyDisplay.textContent = `Signed in as ${name}`;
  }

  function bindResponsiveControls(nav) {
    const mobileButton = nav.querySelector('#mobileMenuButton, [data-portal-mobile-open]');
    const mobileCloseButton = nav.querySelector('#mobileCloseButton, [data-portal-mobile-close]');

    if (mobileButton && mobileButton.dataset.portalBound !== 'true') {
      mobileButton.dataset.portalBound = 'true';
      mobileButton.addEventListener('click', () => nav.classList.toggle(CLASSNAMES.mobileOpen));
    }

    if (mobileCloseButton && mobileCloseButton.dataset.portalBound !== 'true') {
      mobileCloseButton.dataset.portalBound = 'true';
      mobileCloseButton.addEventListener('click', () => closeMobileNavigation(nav));
    }

    if (nav.dataset.portalEscapeBound !== 'true') {
      nav.dataset.portalEscapeBound = 'true';
      document.addEventListener('keydown', event => {
        if (event.key === 'Escape') {
          closeMobileNavigation(nav);
          closeAllWorkspaceMenus();
        }
      });
    }

    if (document.documentElement.dataset.portalWorkspacePickerBound !== 'true') {
      document.documentElement.dataset.portalWorkspacePickerBound = 'true';
      document.addEventListener('click', () => closeAllWorkspaceMenus());
    }
  }

  function redirectIfUnauthorized(role, activePage) {
    if (window.PortalRegistry.canAccessPage(role, activePage)) return false;
    const landing = window.PortalRegistry.getLandingPage(role);
    if (landing && landing.href) {
      window.location.replace(landing.href);
      return true;
    }
    return false;
  }

  function synchronizeShell(user, activePage, role, workspace) {
    if (!window.PortalShell) return;
    window.PortalShell.initialize()
      .setUser(user)
      .setPage(activePage)
      .setRole(role)
      .setWorkspace(workspace);
  }

  function configurePortalNavigation(user, activePage, options) {
    const nav = document.querySelector((options && options.navigationSelector) || SELECTORS.navigation);
    if (!nav || !user || !requireRegistry()) return null;

    const role = window.PortalRegistry.normalizeRole(user.role);
    const workspaces = window.PortalRegistry.getAccessibleWorkspaces(role);
    const currentWorkspace = determineCurrentWorkspace(workspaces, activePage);

    if (!currentWorkspace) {
      console.error(`No enabled workspace is available for role ${role}.`);
      return null;
    }
    if (redirectIfUnauthorized(role, activePage)) return null;

    renderGlobalWorkspaceControl(nav, role, workspaces, currentWorkspace);
    const workspaceNavigation = renderWorkspaceNavigation(nav, role, workspaces, currentWorkspace, activePage);
    renderMobileNavigation(nav, role, workspaces, currentWorkspace, activePage);
    updateUserDisplay(nav, user);
    bindResponsiveControls(nav);

    const brand = nav.querySelector(SELECTORS.brand);
    const landing = window.PortalRegistry.getLandingPage(role, workspaces.length > 1 ? currentWorkspace.id : undefined);
    if (brand && landing) brand.href = landing.href;

    nav.dataset.portalRole = role;
    nav.dataset.portalWorkspace = currentWorkspace.id;
    nav.dataset.portalWorkspaceCount = String(workspaces.length);
    nav.classList.remove('nav-compact');
    nav.classList.add('nav-two-tier', CLASSNAMES.ready);

    currentContext = Object.freeze({ user, activePage, role, workspaces, currentWorkspace, nav, workspaceNavigation });
    synchronizeShell(user, activePage, role, currentWorkspace);
    return currentContext;
  }

  function refresh(options) {
    if (!currentContext) return null;
    return configurePortalNavigation(currentContext.user, currentContext.activePage, options);
  }

  const api = Object.freeze({
    version: VERSION,
    configure: configurePortalNavigation,
    refresh,
    getContext: () => currentContext
  });

  window.PortalNavigation = api;
  window.configurePortalNavigation = configurePortalNavigation;
})(window, document);
