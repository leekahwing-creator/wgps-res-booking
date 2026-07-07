(function () {
  function configurePortalNavigation(user, activePage) {
    const nav = document.querySelector('.portal-nav-v2');
    if (!nav || !user) return;

    const role = user.role || 'User';
    const isAdmin = role === 'Admin';
    const isDE = role === 'DE';
    const isTeacherView = role === 'User' || isAdmin;
    const isDeploymentView = isDE || isAdmin;

    function shouldShowRole(linkRole) {
      if (linkRole === 'teacher') return isTeacherView;
      if (linkRole === 'de') return isDeploymentView;
      if (linkRole === 'admin') return isAdmin;
      return false;
    }

    function ensureImportNavigationLink() {
      if (!isAdmin) return;

      const moreMenu = nav.querySelector('.more-menu');
      if (moreMenu && !moreMenu.querySelector('[data-page="import"]')) {
        const importLink = document.createElement('a');
        importLink.href = 'import-bookings.html';
        importLink.className = 'nav-link';
        importLink.dataset.page = 'import';
        importLink.dataset.roleLink = 'admin';
        importLink.innerHTML = '<span class="nav-icon">⇪</span>Booking Import';
        moreMenu.appendChild(importLink);
      }

      const mobileLinks = nav.querySelector('.mobile-drawer-links');
      if (mobileLinks && !mobileLinks.querySelector('[data-page="import"]')) {
        const importLink = document.createElement('a');
        importLink.href = 'import-bookings.html';
        importLink.className = 'nav-link';
        importLink.dataset.page = 'import';
        importLink.dataset.mobileRoleLink = 'admin';
        importLink.innerHTML = '<span class="nav-icon">⇪</span>Booking Import';
        mobileLinks.appendChild(importLink);
      }
    }

    function setActiveState() {
      nav.querySelectorAll('[data-page]').forEach(link => {
        link.classList.toggle('active', link.dataset.page === activePage);
      });
    }

    function updateUserDisplay() {
      const name = user.name || 'User';
      const email = user.email || '';
      const initial = name.trim().charAt(0).toUpperCase() || 'U';

      nav.querySelectorAll('[data-nav-name]').forEach(el => { el.textContent = name; });
      nav.querySelectorAll('[data-nav-email]').forEach(el => { el.textContent = email; });
      nav.querySelectorAll('[data-nav-initial]').forEach(el => { el.textContent = initial; });

      const legacyCurrentUserDisplay = document.getElementById('currentUserDisplay');
      if (legacyCurrentUserDisplay) {
        legacyCurrentUserDisplay.textContent = `Signed in as ${name}`;
      }
    }

    function applyRoleVisibility() {
      const primaryLinks = Array.from(nav.querySelectorAll('.nav-main > [data-role-link]'));

      primaryLinks.forEach(link => {
        const shouldShow = shouldShowRole(link.dataset.roleLink);
        link.dataset.roleVisible = shouldShow ? 'true' : 'false';

        if (isDE && link.dataset.page === 'deployment') {
          link.classList.remove('desktop-extra');
        }

        link.style.display = shouldShow ? 'inline-flex' : 'none';
      });

      nav.querySelectorAll('.more-menu [data-role-link]').forEach(link => {
        const shouldShow = isAdmin && shouldShowRole(link.dataset.roleLink);
        link.style.display = shouldShow ? 'inline-flex' : 'none';
      });

      nav.querySelectorAll('[data-mobile-role-link]').forEach(link => {
        const shouldShow = shouldShowRole(link.dataset.mobileRoleLink);
        link.style.display = shouldShow ? 'flex' : 'none';
      });
    }

    function applyNavigationLayout() {
      const mobileMode = window.matchMedia('(max-width: 900px)').matches;
      const moreDropdown = nav.querySelector('#moreDropdown');

      nav.classList.toggle('nav-compact', !mobileMode && isAdmin);

      nav.querySelectorAll('.nav-main > .desktop-extra').forEach(link => {
        const shouldShow = link.dataset.roleVisible === 'true';
        link.style.display = (!mobileMode && !isAdmin && shouldShow) ? 'inline-flex' : 'none';
      });

      if (moreDropdown) {
        const showMore = !mobileMode && isAdmin;
        moreDropdown.classList.toggle('has-items', showMore);
        moreDropdown.style.display = showMore ? 'inline-flex' : 'none';
        if (!showMore) moreDropdown.classList.remove('open');
      }

      if (!mobileMode) {
        nav.classList.remove('mobile-open');
      }
    }

    ensureImportNavigationLink();
    applyRoleVisibility();
    setActiveState();
    updateUserDisplay();
    applyNavigationLayout();
    nav.classList.add('nav-ready');

    const mobileButton = nav.querySelector('#mobileMenuButton');
    const mobileCloseButton = nav.querySelector('#mobileCloseButton');
    const moreButton = nav.querySelector('#moreButton');
    const moreDropdown = nav.querySelector('#moreDropdown');

    if (mobileButton && !mobileButton.dataset.bound) {
      mobileButton.dataset.bound = 'true';
      mobileButton.addEventListener('click', () => {
        nav.classList.toggle('mobile-open');
      });
    }

    if (mobileCloseButton && !mobileCloseButton.dataset.bound) {
      mobileCloseButton.dataset.bound = 'true';
      mobileCloseButton.addEventListener('click', () => {
        nav.classList.remove('mobile-open');
      });
    }

    if (moreButton && !moreButton.dataset.bound) {
      moreButton.dataset.bound = 'true';
      moreButton.addEventListener('click', event => {
        event.stopPropagation();
        if (moreDropdown) moreDropdown.classList.toggle('open');
      });
    }

    if (!nav.dataset.resizeBound) {
      nav.dataset.resizeBound = 'true';

      let resizeTimer = null;
      const scheduleLayoutUpdate = () => {
        window.clearTimeout(resizeTimer);
        resizeTimer = window.setTimeout(applyNavigationLayout, 80);
      };

      window.addEventListener('resize', scheduleLayoutUpdate);

      if ('ResizeObserver' in window) {
        const observer = new ResizeObserver(scheduleLayoutUpdate);
        observer.observe(nav);
      }
    }

    if (!window.__portalNavOutsideClickBound) {
      window.__portalNavOutsideClickBound = true;
      document.addEventListener('click', event => {
        document.querySelectorAll('.more-dropdown.open').forEach(dropdown => {
          if (!dropdown.contains(event.target)) dropdown.classList.remove('open');
        });
      });
    }
  }

  window.configurePortalNavigation = configurePortalNavigation;
})();
