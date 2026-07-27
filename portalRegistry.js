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
      id: 'booking', label: 'Booking', icon: '⊞', order: 10,
      roles: Object.freeze(['User', 'Admin']), landingPage: 'create', enabled: true,
      pages: Object.freeze([
        Object.freeze({ id: 'create', label: 'Create Booking', href: 'index.html', icon: '⊞', order: 10 }),
        Object.freeze({ id: 'bookings', label: 'My Bookings', adminLabel: 'Manage Bookings', href: 'manage-bookings.html', icon: '▣', order: 20 })
      ])
    }),
    Object.freeze({
      id: 'deployment', label: 'Deployment', icon: '▰', order: 20,
      roles: Object.freeze(['DE', 'Admin']), landingPage: 'deployment', enabled: true,
      pages: Object.freeze([
        Object.freeze({ id: 'deployment', label: 'Deployment Dashboard', href: 'de-dashboard.html', icon: '▰', order: 10 })
      ])
    }),
    Object.freeze({
      id: 'operations', label: 'Operations', icon: '◫', order: 30,
      roles: Object.freeze(['Admin']), landingPage: null, enabled: false,
      pages: Object.freeze([])
    }),
    Object.freeze({
      id: 'administration', label: 'Administration', icon: '⚙', order: 40,
      roles: Object.freeze(['Admin']), landingPage: 'resources', enabled: true,
      pages: Object.freeze([
        Object.freeze({ id: 'resources', label: 'Resources', href: 'resources-admin.html', icon: '▤', order: 10 }),
        Object.freeze({ id: 'users', label: 'Users', href: 'admin-users.html', icon: '♟', order: 20 }),
        Object.freeze({ id: 'locations', label: 'Locations', href: 'locations-admin.html', icon: '⌖', order: 30 }),
        Object.freeze({ id: 'import', label: 'Booking Import', href: 'import-bookings.html', icon: '⇪', order: 40 })
      ])
    })
  ]);

  function normalizeRole(role) { return ROLE_ALIASES[role] || 'User'; }
  function sorted(items) { return [...items].sort((a,b)=>(a.order||0)-(b.order||0)); }
  function getAccessibleWorkspaces(userOrRole, options) {
    const role = normalizeRole(typeof userOrRole === 'string' ? userOrRole : userOrRole && userOrRole.role);
    const includeDisabled = Boolean(options && options.includeDisabled);
    return sorted(WORKSPACES.filter(w => (includeDisabled || w.enabled !== false) && w.roles.includes(role)));
  }
  function getWorkspace(id) { return WORKSPACES.find(w => w.id === id) || null; }
  function getPage(id) {
    for (const workspace of WORKSPACES) {
      const page = workspace.pages.find(p => p.id === id);
      if (page) return { workspace, page };
    }
    return null;
  }
  function canAccessWorkspace(userOrRole, id) { return getAccessibleWorkspaces(userOrRole).some(w => w.id === id); }
  function canAccessPage(userOrRole, id) {
    const match = getPage(id);
    return Boolean(match && match.workspace.enabled !== false && canAccessWorkspace(userOrRole, match.workspace.id));
  }
  function getLandingPage(userOrRole, workspaceId) {
    const accessible = getAccessibleWorkspaces(userOrRole);
    const workspace = workspaceId ? accessible.find(w => w.id === workspaceId) : accessible[0];
    if (!workspace) return null;
    return workspace.pages.find(p => p.id === workspace.landingPage) || sorted(workspace.pages)[0] || null;
  }
  window.PortalRegistry = Object.freeze({ workspaces: WORKSPACES, normalizeRole, getAccessibleWorkspaces, getWorkspace, getPage, canAccessWorkspace, canAccessPage, getLandingPage });
})();
