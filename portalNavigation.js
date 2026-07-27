(function (window, document) {
  'use strict';

  const VERSION = '2.1.0';
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

  function createWorkspaceSelect(workspaces, selectedWorkspaceId, role, className) {
    const select = document.createElement('select');
    select.className = `${CLASSNAMES.workspaceSelect}${className ? ` ${className}` : ''}`;
    select.setAttribute('aria-label', 'Select workspace');

    workspaces.forEach(workspace => {
      const option = document.createElement('option');
      option.value = workspace.id;
      option.textContent = workspace.label;
      option.selected = workspace.id === selectedWorkspaceId;
      select.appendChild(option);
    });

    select.addEventListener('change', () => {
      const page = window.PortalRegistry.getLandingPage(role, select.value);
      if (page && page.href) window.location.assign(page.href);
    });
    return select;
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
    control.appendChild(createWorkspaceSelect(workspaces, currentWorkspace.id, role));
    host.appendChild(control);
  }

  function findWorkspaceNavigation(nav) {
    const parent = nav.parentElement;
    if (!parent) return null;
    return Array.from(parent.children).find(element => element.matches(SELECTORS.workspaceNavigation)) || null;
  }

  function renderWorkspaceNavigation(nav, role, workspaces, currentWorkspace, activePage) {
    const existing = findWorkspaceNavigation(nav);
    if (existing) existing.remove();

    const bar = document.createElement('nav');
    bar.className = CLASSNAMES.workspaceNavigation;
    bar.dataset.portalWorkspaceNavigation = 'true';
    bar.dataset.workspaceCount = String(workspaces.length);
    bar.setAttribute('aria-label', `${currentWorkspace.label} navigation`);

    if (workspaces.length > 1) {
      const title = textElement('span', 'workspace-nav-title', currentWorkspace.label);
      title.setAttribute('aria-hidden', 'true');
      bar.appendChild(title);
    } else {
      bar.classList.add('single-workspace-nav');
    }

    const links = document.createElement('div');
    links.className = 'workspace-page-links';
    sortedPages(currentWorkspace).forEach(page => {
      links.appendChild(createPageLink(page, activePage, role, false));
    });

    bar.appendChild(links);
    nav.insertAdjacentElement('afterend', bar);
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
      panel.appendChild(createWorkspaceSelect(workspaces, currentWorkspace.id, role, 'mobile-workspace-select'));
      host.appendChild(panel);
      host.appendChild(textElement('div', 'mobile-workspace-heading', currentWorkspace.label));
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
        if (event.key === 'Escape') closeMobileNavigation(nav);
      });
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
