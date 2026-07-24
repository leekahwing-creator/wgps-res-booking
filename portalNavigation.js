(function () {
  'use strict';

  const STYLE_ID = 'portal-navigation-v2-runtime-styles';

  function ensureRuntimeStyles() {
    if (document.getElementById(STYLE_ID)) return;
    const style = document.createElement('style');
    style.id = STYLE_ID;
    style.textContent = `
      .portal-nav-v2 .workspace-switcher {
        display: inline-flex;
        align-items: center;
        gap: 8px;
        min-width: 160px;
        padding: 0 10px;
      }
      .portal-nav-v2 .workspace-switcher-label {
        font-size: 11px;
        font-weight: 800;
        letter-spacing: .05em;
        text-transform: uppercase;
        opacity: .72;
        white-space: nowrap;
      }
      .portal-nav-v2 .workspace-select {
        min-width: 145px;
        max-width: 190px;
        height: 38px;
        border: 1px solid rgba(148,163,184,.45);
        border-radius: 10px;
        background: rgba(255,255,255,.96);
        color: #15324a;
        font: inherit;
        font-weight: 750;
        padding: 0 32px 0 10px;
        cursor: pointer;
      }
      .portal-nav-v2 .workspace-divider {
        width: 1px;
        height: 30px;
        background: rgba(148,163,184,.35);
        margin: 0 2px;
      }
      .portal-nav-v2 .mobile-workspace-panel {
        display: grid;
        gap: 8px;
        padding: 12px 14px 10px;
        border-bottom: 1px solid rgba(148,163,184,.24);
      }
      .portal-nav-v2 .mobile-workspace-panel .workspace-select {
        width: 100%;
        max-width: none;
      }
      .portal-nav-v2 .mobile-workspace-heading {
        padding: 12px 16px 6px;
        font-size: 12px;
        font-weight: 800;
        letter-spacing: .05em;
        text-transform: uppercase;
        opacity: .66;
      }
      @media (max-width: 1120px) and (min-width: 901px) {
        .portal-nav-v2 .workspace-switcher-label { display: none; }
        .portal-nav-v2 .workspace-select { min-width: 128px; max-width: 150px; }
      }
      @media (max-width: 900px) {
        .portal-nav-v2 .nav-main { display: none !important; }
      }
    `;
    document.head.appendChild(style);
  }

  function createPageLink(page, activePage, role, mobile) {
    const link = document.createElement('a');
    link.href = page.href;
    link.className = 'nav-link';
    link.dataset.page = page.id;
    if (page.id === activePage) {
      link.classList.add('active');
      link.setAttribute('aria-current', 'page');
    }
    const label = role === 'Admin' && page.adminLabel ? page.adminLabel : page.label;
    link.innerHTML = `<span class="nav-icon">${page.icon || '•'}</span>${label}`;
    if (mobile) {
      link.addEventListener('click', () => {
        const nav = link.closest('.portal-nav-v2');
        if (nav) nav.classList.remove('mobile-open');
      });
    }
    return link;
  }

  function createWorkspaceSelect(workspaces, selectedWorkspaceId, className) {
    const select = document.createElement('select');
    select.className = `workspace-select${className ? ` ${className}` : ''}`;
    select.setAttribute('aria-label', 'Select workspace');

    workspaces.forEach(workspace => {
      const option = document.createElement('option');
      option.value = workspace.id;
      option.textContent = workspace.label;
      option.selected = workspace.id === selectedWorkspaceId;
      select.appendChild(option);
    });

    select.addEventListener('change', () => {
      const page = window.PortalRegistry.getLandingPage('Admin', select.value);
      if (page && page.href) window.location.href = page.href;
    });
    return select;
  }

  function determineCurrentWorkspace(workspaces, activePage) {
    const pageMatch = window.PortalRegistry.getPage(activePage);
    if (pageMatch && workspaces.some(workspace => workspace.id === pageMatch.workspace.id)) {
      return pageMatch.workspace;
    }
    return workspaces[0] || null;
  }

  function renderDesktopNavigation(nav, role, workspaces, currentWorkspace, activePage) {
    const host = nav.querySelector('.nav-main');
    if (!host) return;
    host.innerHTML = '';

    if (role === 'Admin' && workspaces.length > 1) {
      const switcher = document.createElement('div');
      switcher.className = 'workspace-switcher';
      const label = document.createElement('span');
      label.className = 'workspace-switcher-label';
      label.textContent = 'Workspace';
      switcher.appendChild(label);
      switcher.appendChild(createWorkspaceSelect(workspaces, currentWorkspace.id));
      host.appendChild(switcher);

      const divider = document.createElement('span');
      divider.className = 'workspace-divider';
      divider.setAttribute('aria-hidden', 'true');
      host.appendChild(divider);
    }

    currentWorkspace.pages
      .slice()
      .sort((a, b) => (a.order || 0) - (b.order || 0))
      .forEach(page => host.appendChild(createPageLink(page, activePage, role, false)));
  }

  function renderMobileNavigation(nav, role, workspaces, currentWorkspace, activePage) {
    const host = nav.querySelector('.mobile-drawer-links');
    if (!host) return;
    host.innerHTML = '';

    if (role === 'Admin' && workspaces.length > 1) {
      const panel = document.createElement('div');
      panel.className = 'mobile-workspace-panel';
      const label = document.createElement('span');
      label.className = 'workspace-switcher-label';
      label.textContent = 'Workspace';
      panel.appendChild(label);
      panel.appendChild(createWorkspaceSelect(workspaces, currentWorkspace.id, 'mobile-workspace-select'));
      host.appendChild(panel);

      const heading = document.createElement('div');
      heading.className = 'mobile-workspace-heading';
      heading.textContent = currentWorkspace.label;
      host.appendChild(heading);
    }

    currentWorkspace.pages
      .slice()
      .sort((a, b) => (a.order || 0) - (b.order || 0))
      .forEach(page => host.appendChild(createPageLink(page, activePage, role, true)));
  }

  function updateUserDisplay(nav, user) {
    const name = user.name || 'User';
    const email = user.email || '';
    const initial = name.trim().charAt(0).toUpperCase() || 'U';

    nav.querySelectorAll('[data-nav-name]').forEach(el => { el.textContent = name; });
    nav.querySelectorAll('[data-nav-email]').forEach(el => { el.textContent = email; });
    nav.querySelectorAll('[data-nav-initial]').forEach(el => { el.textContent = initial; });

    const legacyCurrentUserDisplay = document.getElementById('currentUserDisplay');
    if (legacyCurrentUserDisplay) legacyCurrentUserDisplay.textContent = `Signed in as ${name}`;
  }

  function bindResponsiveControls(nav) {
    const mobileButton = nav.querySelector('#mobileMenuButton');
    const mobileCloseButton = nav.querySelector('#mobileCloseButton');

    if (mobileButton && !mobileButton.dataset.bound) {
      mobileButton.dataset.bound = 'true';
      mobileButton.addEventListener('click', () => nav.classList.toggle('mobile-open'));
    }

    if (mobileCloseButton && !mobileCloseButton.dataset.bound) {
      mobileCloseButton.dataset.bound = 'true';
      mobileCloseButton.addEventListener('click', () => nav.classList.remove('mobile-open'));
    }

    if (!nav.dataset.escapeBound) {
      nav.dataset.escapeBound = 'true';
      document.addEventListener('keydown', event => {
        if (event.key === 'Escape') nav.classList.remove('mobile-open');
      });
    }
  }

  function configurePortalNavigation(user, activePage) {
    const nav = document.querySelector('.portal-nav-v2');
    if (!nav || !user) return;
    if (!window.PortalRegistry) {
      console.error('PortalRegistry is required before portalNavigation.js.');
      return;
    }

    ensureRuntimeStyles();

    const role = window.PortalRegistry.normalizeRole(user.role);
    const workspaces = window.PortalRegistry.getAccessibleWorkspaces(role);
    const currentWorkspace = determineCurrentWorkspace(workspaces, activePage);

    if (!currentWorkspace) {
      console.error(`No enabled workspace is available for role ${role}.`);
      return;
    }

    if (!window.PortalRegistry.canAccessPage(role, activePage)) {
      const landing = window.PortalRegistry.getLandingPage(role);
      if (landing && landing.href) {
        window.location.replace(landing.href);
        return;
      }
    }

    renderDesktopNavigation(nav, role, workspaces, currentWorkspace, activePage);
    renderMobileNavigation(nav, role, workspaces, currentWorkspace, activePage);
    updateUserDisplay(nav, user);
    bindResponsiveControls(nav);

    const brand = nav.querySelector('.nav-brand');
    const roleLanding = window.PortalRegistry.getLandingPage(role, role === 'Admin' ? currentWorkspace.id : undefined);
    if (brand && roleLanding) brand.href = roleLanding.href;

    nav.dataset.portalRole = role;
    nav.dataset.portalWorkspace = currentWorkspace.id;
    nav.classList.toggle('nav-compact', role === 'Admin');
    nav.classList.add('nav-ready');
  }

  window.configurePortalNavigation = configurePortalNavigation;
})();
