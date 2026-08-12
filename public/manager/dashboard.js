(function () {
  let currentManager = null;
  let activeRejectId = null;

  // Cache DOM Elements
  const appHeader = document.getElementById('app-header');
  const loginView = document.getElementById('login-view');
  const dashboardView = document.getElementById('dashboard-view');
  const managerDisplayName = document.getElementById('manager-display-name');
  
  const inputManagerId = document.getElementById('manager-id');
  const inputManagerPass = document.getElementById('manager-pass');
  const btnLogin = document.getElementById('btn-login');
  const btnLogout = document.getElementById('btn-logout');
  
  const submissionsGrid = document.getElementById('submissions-grid');
  const btnRefresh = document.getElementById('btn-refresh');

  const rejectModal = document.getElementById('reject-modal');
  const rejectNoteInput = document.getElementById('reject-note-input');
  const btnModalCancel = document.getElementById('btn-modal-cancel');
  const btnModalSubmit = document.getElementById('btn-modal-submit');
  const toastContainer = document.getElementById('toast-container');

  // Initialize
  function init() {
    const saved = localStorage.getItem('clip_manager_session');
    if (saved) {
      try {
        currentManager = JSON.parse(saved);
        showDashboard();
      } catch (e) {
        localStorage.removeItem('clip_manager_session');
        showLogin();
      }
    } else {
      showLogin();
    }

    // Attach Event Listeners
    btnLogin.addEventListener('click', handleLogin);
    btnLogout.addEventListener('click', handleLogout);
    btnRefresh.addEventListener('click', loadSubmissions);
    btnModalCancel.addEventListener('click', closeRejectModal);
    btnModalSubmit.addEventListener('click', submitRejection);
  }

  function showLogin() {
    appHeader.style.display = 'none';
    dashboardView.style.display = 'none';
    loginView.style.display = 'flex';
  }

  function showDashboard() {
    loginView.style.display = 'none';
    appHeader.style.display = 'flex';
    dashboardView.style.display = 'block';
    managerDisplayName.textContent = currentManager.name;
    loadSubmissions();
  }

  async function handleLogin() {
    const id = inputManagerId.value.trim();
    const password = inputManagerPass.value;

    if (!id || !password) {
      showToast('⚠️ Please enter both Manager ID and password.', 'error');
      return;
    }

    try {
      const response = await fetch('/api/manager/login', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ id, password })
      });

      const data = await response.json();
      if (response.ok && data.success) {
        currentManager = data.manager;
        localStorage.setItem('clip_manager_session', JSON.stringify(currentManager));
        showToast(`Welcome back, ${currentManager.name}!`, 'success');
        showDashboard();
      } else {
        showToast(data.message || 'Login failed.', 'error');
      }
    } catch (err) {
      showToast('❌ Network error during sign in.', 'error');
    }
  }

  function handleLogout() {
    currentManager = null;
    localStorage.removeItem('clip_manager_session');
    showToast('Logged out successfully.', 'info');
    showLogin();
  }

  async function loadSubmissions() {
    submissionsGrid.innerHTML = '<div class="empty-state">Loading submissions...</div>';
    try {
      const response = await fetch('/api/manager/submissions');
      const data = await response.json();

      if (response.ok && data.success) {
        renderSubmissions(data.submissions);
      } else {
        showToast(data.message || 'Failed to load submissions.', 'error');
      }
    } catch (err) {
      showToast('❌ Failed to fetch queue from server.', 'error');
    }
  }

  function renderSubmissions(submissions) {
    submissionsGrid.innerHTML = '';
    
    if (submissions.length === 0) {
      submissionsGrid.innerHTML = '<div class="empty-state">🎉 No pending submissions to review!</div>';
      return;
    }

    submissions.forEach(sub => {
      const card = document.createElement('div');
      card.className = 'card';
      
      const isFlaggedByOthers = sub.flaggedByManagerId && sub.flaggedByManagerId !== currentManager.id;
      const isFlaggedByMe = sub.flaggedByManagerId === currentManager.id;

      if (isFlaggedByOthers) {
        card.classList.add('locked');
      }

      // Build Lock Overlay
      let lockOverlayHtml = '';
      if (isFlaggedByOthers) {
        lockOverlayHtml = `<div class="locked-overlay">🔒 Flagged / Locked by another manager</div>`;
      }

      // Safe description escaping
      const safeNote = escapeHtml(sub.note);
      const safeFilename = escapeHtml(sub.id);

      card.innerHTML = `
        <div class="card-video">
          ${lockOverlayHtml}
          <div style="font-size: 2.2rem; filter: drop-shadow(0 0 10px rgba(99, 102, 241, 0.4)); margin-bottom: 0.25rem;">🎬</div>
          <a href="${sub.fileUrl}" target="_blank" class="btn" style="max-width: 200px; padding: 0.5rem 1rem; font-size: 0.85rem; background: var(--primary-color); color: white; border-radius: 8px; text-decoration: none; border: none; font-weight: 700; box-shadow: 0 4px 12px var(--primary-glow); display: flex; align-items: center; gap: 0.5rem; transition: transform 0.2s;">
            Open Video File 🔗
          </a>
        </div>
        <div class="card-content">
          <div class="card-header">
            <span class="clip-id">${safeFilename}</span>
            <span class="clip-type-badge">${sub.clipType}</span>
          </div>
          
          <div class="meta-item">
            <span class="meta-label">Submitted By:</span>
            <span class="meta-val">${escapeHtml(sub.discordUsername)}</span>
          </div>
          <div class="meta-item">
            <span class="meta-label">Creator target:</span>
            <span class="meta-val">${escapeHtml(sub.creator)}</span>
          </div>
          
          ${safeNote ? `<div class="meta-label">Submitter Note:</div><div class="note-block">${safeNote}</div>` : ''}
          
          <div class="card-actions">
            <button class="btn btn-approve" data-id="${sub.id}">Approve</button>
            <button class="btn btn-reject" data-id="${sub.id}">Reject</button>
            <button class="btn btn-flag ${isFlaggedByMe ? 'flagged' : ''}" data-id="${sub.id}">
              ${isFlaggedByMe ? '📌 Flagged' : '📌 Flag'}
            </button>
          </div>
        </div>
      `;

      // Attach actions to buttons inside card
      if (!isFlaggedByOthers) {
        card.querySelector('.btn-approve').addEventListener('click', () => handleAction(sub.id, 'approve'));
        card.querySelector('.btn-reject').addEventListener('click', () => openRejectModal(sub.id));
        card.querySelector('.btn-flag').addEventListener('click', () => toggleFlag(sub.id));
      }

      submissionsGrid.appendChild(card);
    });
  }

  async function handleAction(id, action, note = '') {
    try {
      const response = await fetch(`/api/manager/submissions/${id}/review`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          action,
          note,
          managerId: currentManager.id,
          managerName: currentManager.name
        })
      });

      const data = await response.json();
      if (response.ok && data.success) {
        showToast(`Clip ${id} ${action}d successfully.`, 'success');
        loadSubmissions();
      } else {
        showToast(data.message || 'Action failed.', 'error');
      }
    } catch (err) {
      showToast('❌ Server error processing action.', 'error');
    }
  }

  async function toggleFlag(id) {
    try {
      const response = await fetch(`/api/manager/submissions/${id}/flag`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ managerId: currentManager.id })
      });

      const data = await response.json();
      if (response.ok && data.success) {
        showToast(data.message, 'success');
        loadSubmissions();
      } else {
        showToast(data.message || 'Failed to update flag state.', 'error');
      }
    } catch (err) {
      showToast('❌ Server error updating flag.', 'error');
    }
  }

  function openRejectModal(id) {
    activeRejectId = id;
    rejectNoteInput.value = '';
    rejectModal.style.display = 'flex';
  }

  function closeRejectModal() {
    activeRejectId = null;
    rejectModal.style.display = 'none';
  }

  function submitRejection() {
    const note = rejectNoteInput.value.trim();
    if (!note) {
      showToast('⚠️ Please write a rejection reason.', 'error');
      return;
    }
    
    handleAction(activeRejectId, 'reject', note);
    closeRejectModal();
  }

  function showToast(message, type = 'info') {
    const toast = document.createElement('div');
    toast.className = 'toast';
    
    if (type === 'success') {
      toast.style.borderLeftColor = 'var(--success-color)';
    } else if (type === 'error') {
      toast.style.borderLeftColor = 'var(--danger-color)';
    } else if (type === 'warning') {
      toast.style.borderLeftColor = 'var(--warning-color)';
    }

    toast.textContent = message;
    toastContainer.appendChild(toast);
    
    setTimeout(() => {
      toast.style.opacity = '0';
      toast.style.transform = 'translateX(100%)';
      toast.style.transition = 'all 0.3s ease';
      setTimeout(() => toast.remove(), 300);
    }, 4000);
  }

  function escapeHtml(str) {
    if (!str) return '';
    return str.replace(/&/g, '&amp;')
              .replace(/</g, '&lt;')
              .replace(/>/g, '&gt;')
              .replace(/"/g, '&quot;')
              .replace(/'/g, '&#039;');
  }

  // Run initial setup on load
  window.addEventListener('DOMContentLoaded', init);
})();
