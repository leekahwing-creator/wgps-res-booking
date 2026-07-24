(function () {
  'use strict';

  const STYLE_ID = 'portal-navigation-v2-two-tier-runtime-styles';
  const WORKSPACE_NAV_CLASS = 'portal-workspace-nav';

  function ensureRuntimeStyles() {
    if (document.getElementById(STYLE_ID)) return;

    const style = document.createElement('style');
    style.id = STYLE_ID;
    style.textContent = `
      /* Portal V2.1 two-tier shell */
      .portal-nav-v2 {
        margin-bottom: 10px !important;
        grid-template-columns: minmax(0, auto) minmax(180px, 1fr) auto !important;
      }

      .portal-nav-v2 .nav-main {
        justify-content: center !important;
        overflow: hidden !important;
      }

      .portal-nav-v2 .global-workspace-control {
        display: inline-flex;
        align-items: center;
        justify-content: center;
        gap: 10px;
        min-width: 0;
      }

      .portal-nav-v2 .workspace-switcher-label,
      .portal-nav-v2 .workspace-context-label {
        font-size: 11px;
        font-weight: 900;
        letter-spacing: .07em;
        text-transform: uppercase;
        color: #475569;
        white-space: nowrap;
      }

      .portal-nav-v2 .workspace-select {
        min-width: 165px;
        max-width: 220px;
        height: 42px;
        border: 1px solid rgba(148,163,184,.48);
        border-radius: 12px;
        background: rgba(255,255,255,.98);
        color: #15324a;
        font: inherit;
        font-weight: 850;
        padding: 0 36px 0 12px;
        cursor: pointer;
      }

      .portal-nav-v2 .workspace-context-pill {
        display: inline-flex;
        align-items: center;
        gap: 8px;
        min-height: 42px;
        padding: 0 14px;
        border: 1px solid rgba(148,163,184,.35);
        border-radius: 12px;
        background: #f8fafc;
        color: #334155;
        font-weight: 900;
        white-space: nowrap;
      }

      .${WORKSPACE_NAV_CLASS} {
        display: grid;
        grid-template-columns: auto minmax(0, 1fr);
        align-items: center;
        gap: 18px;
        width: 100%;
        margin: 0 0 22px;
        padding: 11px 16px;
        border: 1px solid rgba(226,232,240,.95);
        border-radius: 16px;
        background: rgba(255,255,255,.86);
        box-shadow: 0 9px 24px rgba(15,23,42,.045);
      }

      .${WORKSPACE_NAV_CLASS} .workspace-identity {
        display: flex;
        align-items: center;
        gap: 10px;
        min-width: 0;
        padding-right: 18px;
        border-right: 1px solid var(--border, #dbe4ee);
      }

      .${WORKSPACE_NAV_CLASS} .workspace-icon {
        width: 34px;
        height: 34px;
        display: inline-flex;
        align-items: center;
        justify-content: center;
        flex: 0 0 auto;
        border-radius: 11px;
        background: var(--primary-light, #ccfbf1);
        color: var(--primary-dark, #115e59);
        font-weight: 900;
      }

      .${WORKSPACE_NAV_CLASS} .workspace-copy {
        display: grid;
        gap: 1px;
        min-width: 0;
      }

      .${WORKSPACE_NAV_CLASS} .workspace-eyebrow {
        color: #64748b;
        font-size: .68rem;
        font-weight: 900;
        letter-spacing: .07em;
        text-transform: uppercase;
      }

      .${WORKSPACE_NAV_CLASS} .workspace-name {
        color: #0f172a;
        font-size: .95rem;
        font-weight: 900;
        overflow: hidden;
        text-overflow: ellipsis;
        white-space: nowrap;
      }

      .${WORKSPACE_NAV_CLASS} .workspace-page-links {
        display: flex;
        align-items: center;
        gap: 7px;
        min-width: 0;
        overflow-x: auto;
        scrollbar-width: thin;
        padding: 1px 0;
      }

      .${WORKSPACE_NAV_CLASS} .workspace-page-links .nav-link {
        flex: 0 0 auto;
        border: 0;
        text-decoration: none;
        color: #334155;
        font-weight: 900;
        padding: 10px 12px;
        border-radius: 12px;
        background: transparent;
        display: inline-flex;
        align-items: center;
        gap: 7px;
        line-height: 1;
        white-space: nowrap;
        font-size: .88rem;
      }

      .${WORKSPACE_NAV_CLASS} .workspace-page-links .nav-link:hover,
      .${WORKSPACE_NAV_CLASS} .workspace-page-links .nav-link.active {
        background: var(--primary, #0f766e);
        color: #fff;
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
        font-weight: 900;
        letter-spacing: .06em;
        text-transform: uppercase;
        color: #64748b;
      }

      @media (max-width: 1100px) and (min-width: 901px) {
        .portal-nav-v2 .workspace-switcher-label,
        .portal-nav-v2 .workspace-context-label { display: none; }
        .portal-nav-v2 .workspace-select { min-width: 145px; max-width: 180px; }
        .${WORKSPACE_NAV_CLASS} { grid-template-columns: auto minmax(0,1fr); gap: 12px; }
        .${WORKSPACE_NAV_CLASS} .workspace-identity { padding-right: 12px; }
      }

      @media (max-width: 900px) {
        .portal-nav-v2 { margin-bottom: 22px !important; }
        .portal-nav-v2 .nav-main { display: none !important; }
        .${WORKSPACE_NAV_CLASS} { display: none !important; }
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

  function renderGlobalWorkspaceControl(nav, role, workspaces, currentWorkspace) {
    const host = nav.querySelector('.nav-main');
    if (!host) return;
    host.innerHTML = '';

    const control = document.createElement('div');
    control.className = 'global-workspace-control';

    if (role === 'Admin' && workspaces.length > 1) {
      const label = document.createElement('span');
      label.className = 'workspace-switcher-label';
      label.textContent = 'Workspace';
      control.appendChild(label);
      control.appendChild(createWorkspaceSelect(workspaces, currentWorkspace.id));
    } else {
      const label = document.createElement('span');
      label.className = 'workspace-context-label';
      label.textContent = 'Workspace';

      const pill = document.createElement('span');
      pill.className = 'workspace-context-pill';
      pill.innerHTML = `<span aria-hidden="true">${currentWorkspace.icon || '•'}</span>${currentWorkspace.label}`;

      control.appendChild(label);
      control.appendChild(pill);
    }

    host.appendChild(control);
  }

  function renderWorkspaceNavigation(nav, role, currentWorkspace, activePage) {
    const existing = nav.parentElement && nav.parentElement.querySelector(`:scope > .${WORKSPACE_NAV_CLASS}`);
    if (existing) existing.remove();

    const bar = document.createElement('nav');
    bar.className = WORKSPACE_NAV_CLASS;
    bar.setAttribute('aria-label', `${currentWorkspace.label} workspace navigation`);

    const identity = document.createElement('div');
    identity.className = 'workspace-identity';
    identity.innerHTML = `
      <span class="workspace-icon" aria-hidden="true">${currentWorkspace.icon || '•'}</span>
      <span class="workspace-copy">
        <span class="workspace-eyebrow">Current workspace</span>
        <span class="workspace-name">${currentWorkspace.label}</span>
      </span>
    `;

    const links = document.createElement('div');
    links.className = 'workspace-page-links';

    currentWorkspace.pages
      .slice()
      .sort((a, b) => (a.order || 0) - (b.order || 0))
      .forEach(page => links.appendChild(createPageLink(page, activePage, role, false)));

    bar.appendChild(identity);
    bar.appendChild(links);
    nav.insertAdjacentElement('afterend', bar);
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
    }

    const heading = document.createElement('div');
    heading.className = 'mobile-workspace-heading';
    heading.textContent = `${currentWorkspace.label} workspace`;
    host.appendChild(heading);

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

    renderGlobalWorkspaceControl(nav, role, workspaces, currentWorkspace);
    renderWorkspaceNavigation(nav, role, currentWorkspace, activePage);
    renderMobileNavigation(nav, role, workspaces, currentWorkspace, activePage);
    updateUserDisplay(nav, user);
    bindResponsiveControls(nav);

    const brand = nav.querySelector('.nav-brand');
    const roleLanding = window.PortalRegistry.getLandingPage(
      role,
      role === 'Admin' ? currentWorkspace.id : undefined
    );
    if (brand && roleLanding) brand.href = roleLanding.href;

    nav.dataset.portalRole = role;
    nav.dataset.portalWorkspace = currentWorkspace.id;
    nav.classList.remove('nav-compact');
    nav.classList.add('nav-two-tier', 'nav-ready');
  }

  window.configurePortalNavigation = configurePortalNavigation;
})();
