/* ============================================================
   Rental Manager — app.js
   Shared helpers used across all pages
   ============================================================ */

// ── Format currency ─────────────────────────────────────────
function fmt(value) {
  const n = parseFloat(value) || 0;
  return '$' + n.toLocaleString('en-AU', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

// ── Format date string (YYYY-MM-DD → "12 Apr 2026") ────────
function fmtDate(str) {
  if (!str) return '—';
  const d = new Date(str + 'T00:00:00');
  if (isNaN(d)) return str;
  return d.toLocaleDateString('en-AU', { day: '2-digit', month: 'short', year: 'numeric' });
}

// ── Toast notification ───────────────────────────────────────
function showToast(message, type = 'info') {
  const toast = $('#appToast');
  toast.removeClass('toast-success toast-error toast-info');
  toast.addClass(`toast-${type}`);
  $('#toastBody').text(message);
  const bsToast = new bootstrap.Toast(toast[0], { delay: 3000 });
  bsToast.show();
}

// ── Property context (persisted in localStorage) ─────────────
function getProp() {
  try { return JSON.parse(localStorage.getItem('selectedProperty')) || null; }
  catch(e) { return null; }
}

function setProp(prop) {
  localStorage.setItem('selectedProperty', JSON.stringify(prop));
}

// Call on any page that requires a property to be selected.
// Returns the property object, or null after redirecting to /properties.
function requireProp() {
  const p = getProp();
  if (!p) {
    window.location.href = '/properties';
    return null;
  }
  return p;
}

// Switch to a different property and reload the current page
function switchProp(id, name, type, address) {
  setProp({ id, name, type, address });
  // Drop ?property= param from URL then reload
  const url = new URL(window.location.href);
  url.searchParams.delete('property');
  window.location.href = url.toString();
}

// ── Sidebar toggle + live clock + property switcher ──────────
$(function () {
  // Sidebar toggle
  $('#sidebarToggle').on('click', function () {
    $('body').toggleClass('sidebar-collapsed');
  });

  // Live clock
  function updateClock() {
    const now = new Date();
    $('#sidebarDate').text(now.toLocaleDateString('en-AU', {
      weekday: 'short', day: 'numeric', month: 'short', year: 'numeric'
    }));
    $('#topbarTime').text(now.toLocaleTimeString('en-AU', {
      hour: '2-digit', minute: '2-digit'
    }));
  }
  updateClock();
  setInterval(updateClock, 10000);

  // Property switcher in topbar
  const prop = getProp();
  if (prop) {
    $('#propSwitcherName').text(prop.name);
    $('#propSwitcher').show();
  } else {
    $('#propSwitcher').show();
    $('#propSwitcherName').text('Select Property');
  }

  // Load all properties into the switcher dropdown
  $.getJSON('/api/properties', function(res) {
    if (!res.success) return;
    const menu = $('#propSwitcherMenu');
    menu.empty();
    if (res.data.length === 0) {
      menu.append('<li><span class="dropdown-item-text text-muted small fst-italic">No properties yet</span></li>');
    } else {
      res.data.forEach(function(p) {
        const active = prop && p.id === prop.id;
        const icon   = p.type === 'rooming' ? 'bi-door-open' : 'bi-house-door';
        menu.append(`<li><a class="dropdown-item ${active ? 'active' : ''}" href="#"
          onclick="switchProp(${p.id},'${escPropStr(p.name)}','${p.type}','${escPropStr(p.address||'')}');return false;">
          <i class="bi ${icon} me-2"></i>${p.name}
        </a></li>`);
      });
    }
    menu.append('<li><hr class="dropdown-divider"></li>');
    menu.append('<li><a class="dropdown-item text-muted small" href="/properties"><i class="bi bi-building me-2"></i>Manage Properties</a></li>');
  });
});

function escPropStr(s) {
  return String(s).replace(/\\/g,'\\\\').replace(/'/g,"\\'");
}
