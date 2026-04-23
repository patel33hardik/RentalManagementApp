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

// ── Sidebar toggle + live clock ──────────────────────────────
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
});
