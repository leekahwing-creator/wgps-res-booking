(function () {
  'use strict';

  const ROLE_ALIASES = Object.freeze({
    Teacher: 'User',
    User: 'User',
    DE: 'DE',
    Admin: 'Admin'
  });

  const WORKSPACES = Object.freeze([
    Object.freeze({
      id: 'booking',
      label: 'Booking',
      icon: '⊞',
      order: 10,
      roles: Object.freeze(['User', 'Admin']),
      landingPage: 'create',
      enabled: true,
      pages: Object.freeze([
        Object.freeze({ id: 'create', label: 'Create Booking', href: 'index.html', icon: '⊞', order: 10 }),
        Object.freeze({ id: 'bookings', label: 'My Bookings', adminLabel: 'Manage Bookings', href: 'manage-bookings.html', icon: '▣', order: 20 })
      ])
    }),
    Object.freeze({
      id: 'deployment',
      label: 'Deployment',
      icon: '▰',
      order: 20,
      roles: Object.freeze(['DE', 'Admin']),
      landingPage: 'deployment',
      enabled: true,
      pages: Object.freeze([
        Object.freeze({ id: 'deployment', label: 'Deployment Dashboard', href: 'de-dashboard.html', icon: '▰', order: 10 })
      ])
    }),
    Object.freeze({
      id: 'operations',
      label: 'Operations',
      icon: '◫',
      order: 30,
      roles: Object.freeze(['Admin']),
      landingPage: null,
      enabled: false,
      pages: Object.freeze([])
    }),
    Object.freeze({
      id: 'administration',
      label: 'Administration',
      icon: '⚙',
      order: 40,
      roles: Object.freeze(['Admin']),
      landingPage: 'resources',
      enabled: true,
      pages: Object.freeze([
        Object.freeze({ id: 'resources', label: 'Resources', href: 'resources-admin.html', icon: '▤', order: 10 }),
        Object.freeze({ id: 'users', label: 'Users', href: 'admin-users.html', icon: '♟', order: 20 }),
        Object.freeze({ id: 'locations', label: 'Locations', href: 'locations-admin.html', icon: '⌖', order: 30 }),
        Object.freeze({ id: 'import', label: 'Booking Import', href: 'import-bookings.html', icon: '⇪', order: 40 })
      ])
    })
  ]);

  function normalizeRole(role) {
    return ROLE_ALIASES[role] || 'User';
  }

  function sorted(items) {
    return [...items].sort((a, b) => (a.order || 0) - (b.order || 0));
  }

  function getAccessibleWorkspaces(userOrRole, options) {
    const role = normalizeRole(typeof userOrRole === 'string' ? userOrRole : userOrRole && userOrRole.role);
    const includeDisabled = Boolean(options && options.includeDisabled);
    return sorted(WORKSPACES.filter(workspace =>
      (includeDisabled || workspace.enabled !== false) && workspace.roles.includes(role)
    ));
  }

  function getWorkspace(workspaceId) {
    return WORKSPACES.find(workspace => workspace.id === workspaceId) || null;
  }

  function getPage(pageId) {
    for (const workspace of WORKSPACES) {
      const page = workspace.pages.find(item => item.id === pageId);
      if (page) return { workspace, page };
    }
    return null;
  }

  function canAccessWorkspace(userOrRole, workspaceId) {
    return getAccessibleWorkspaces(userOrRole).some(workspace => workspace.id === workspaceId);
  }

  function canAccessPage(userOrRole, pageId) {
    const match = getPage(pageId);
    return Boolean(match && match.workspace.enabled !== false && canAccessWorkspace(userOrRole, match.workspace.id));
  }

  function getLandingPage(userOrRole, workspaceId) {
    const accessible = getAccessibleWorkspaces(userOrRole);
    const workspace = workspaceId
      ? accessible.find(item => item.id === workspaceId)
      : accessible[0];
    if (!workspace) return null;
    const page = workspace.pages.find(item => item.id === workspace.landingPage) || sorted(workspace.pages)[0];
    return page || null;
  }

  window.PortalRegistry = Object.freeze({
    workspaces: WORKSPACES,
    normalizeRole,
    getAccessibleWorkspaces,
    getWorkspace,
    getPage,
    canAccessWorkspace,
    canAccessPage,
    getLandingPage
  });
})();
