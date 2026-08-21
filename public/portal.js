document.addEventListener('DOMContentLoaded', () => {
  // 1. Get Token from URL Query Params
  const urlParams = new URLSearchParams(window.location.search);
  const token = urlParams.get('token');

  // Elements
  const sessionLoader = document.getElementById('session-loader');
  const errorScreen = document.getElementById('error-screen');
  const errorTitle = document.getElementById('error-title');
  const errorMessage = document.getElementById('error-message');
  const portalForm = document.getElementById('portal-form');
  const displayNameSpan = document.getElementById('display-name');

  const dropZone = document.getElementById('drop-zone');
  const fileInput = document.getElementById('file-input');
  const dropZoneContent = document.querySelector('.drop-zone-content');
  const fileInfo = document.getElementById('file-info');
  const fileNameSpan = document.getElementById('file-name');
  const fileSizeSpan = document.getElementById('file-size');
  const removeFileBtn = document.getElementById('remove-file-btn');
  
  const form = document.getElementById('submission-form');
  const clipTypeSelect = document.getElementById('clip-type');
  const creatorSelect = document.getElementById('creator-select');
  const descriptionTextarea = document.getElementById('description');
  const submitBtn = document.getElementById('submit-btn');

  const fileError = document.getElementById('file-error');
  const typeError = document.getElementById('type-error');
  const creatorError = document.getElementById('creator-error');

  const uploadOverlay = document.getElementById('upload-overlay');
  const progressPercent = document.getElementById('progress-percent');
  const progressIndicator = document.getElementById('progress-indicator');
  const successScreen = document.getElementById('success-screen');
  const successId = document.getElementById('success-id');
  const doneBtn = document.querySelector('.close-tab-btn');

  let selectedFile = null;
  let redirectUrl = 'https://discord.com/channels/@me';

  // 2. Validate token on backend
  if (!token) {
    showGlobalError('Missing Security Token', 'No submission credentials provided. Please launch the link directly from Discord.');
    return;
  }

  let currentUserName = '';
  let currentDiscordUser = '';
  let currentUserId = '';

  // Validate token session
  fetch(`/api/portal-session?token=${encodeURIComponent(token)}`)
    .then(response => {
      if (!response.ok) {
        return response.json().then(data => {
          throw new Error(data.message || 'Verification failed');
        });
      }
      return response.json();
    })
    .then(data => {
      if (data.success) {
        displayNameSpan.textContent = data.displayName;
        currentUserName = data.displayName || '';
        currentDiscordUser = data.discordUser || '';
        currentUserId = data.userId || '';

        if (data.expiresAt) {
          startCountdown(data.expiresAt);
        }
        if (data.redirectUrl) {
          redirectUrl = data.redirectUrl;
        }
        // Proceed to load creator and team member options
        loadCreators();
        loadTeamMembers();
      } else {
        showGlobalError('Link Expired or Invalid', data.message || 'The token is invalid.');
      }
    })
    .catch(err => {
      showGlobalError('Session Verification Failed', err.message || 'Could not establish connection to the server.');
    });

  // Fetch creators dropdown dynamically
  function loadCreators() {
    fetch('/api/creators')
      .then(response => {
        if (!response.ok) throw new Error('Failed to retrieve creators list');
        return response.json();
      })
      .then(data => {
        if (data.success && data.creators) {
          creatorSelect.innerHTML = '<option value="" disabled selected>-- Select Creator --</option>';
          data.creators.forEach(c => {
            const opt = document.createElement('option');
            opt.value = c.id;
            opt.textContent = c.name;
            creatorSelect.appendChild(opt);
          });
          
          sessionLoader.classList.add('hidden');
          portalForm.classList.remove('hidden');
        } else {
          showGlobalError('Service Degradation', 'Creators repository failed to respond.');
        }
      })
      .catch(err => {
        showGlobalError('Data Load Error', 'A database connectivity issue prevented loading page configurations.');
      });
  }

  // Fetch team members dropdown dynamically for collaborator selection (excluding the submitter)
  const editorSelect = document.getElementById('editor-id');
  const collaboratorGroup = document.getElementById('collaborator-group');

  function loadTeamMembers() {
    if (!editorSelect) return;
    fetch('/api/team-members')
      .then(response => response.json())
      .then(data => {
        if (data.success && data.teamMembers) {
          editorSelect.innerHTML = '<option value="" selected>-- Select Team Member --</option>';
          
          const filtered = data.teamMembers.filter(m => {
            const mName = (m.name || '').toLowerCase().trim();
            const uDisplay = (currentUserName || '').toLowerCase().trim();
            const uDiscord = (currentDiscordUser || '').toLowerCase().trim();
            if (uDisplay && mName === uDisplay) return false;
            if (uDiscord && mName === uDiscord) return false;
            return true;
          });

          filtered.forEach(m => {
            const opt = document.createElement('option');
            opt.value = m.id;
            opt.textContent = `${m.name}${m.role ? ' (' + m.role + ')' : ''}`;
            editorSelect.appendChild(opt);
          });
        }
      })
      .catch(() => {
        if (editorSelect) editorSelect.innerHTML = '<option value="">(No team members loaded)</option>';
      });
  }

  let countdownInterval = null;

  function startCountdown(expiresAt) {
    const timerBanner = document.getElementById('timer-banner');
    const timeRemainingSpan = document.getElementById('time-remaining');
    if (!timerBanner || !timeRemainingSpan) return;
    
    timerBanner.classList.remove('hidden');
    
    function updateTimer() {
      const remaining = expiresAt - Date.now();
      if (remaining <= 0) {
        clearInterval(countdownInterval);
        showGlobalError('Link Expired', 'This submission session has expired. Please return to Discord and click "Submit Clip" again to request a new link.');
        submitBtn.disabled = true;
        return;
      }
      
      const minutes = Math.floor(remaining / 60000);
      const seconds = Math.floor((remaining % 60000) / 1000);
      timeRemainingSpan.textContent = `${minutes.toString().padStart(2, '0')}:${seconds.toString().padStart(2, '0')}`;
    }
    
    updateTimer();
    countdownInterval = setInterval(updateTimer, 1000);
  }

  function showGlobalError(title, msg) {
    if (countdownInterval) clearInterval(countdownInterval);
    sessionLoader.classList.add('hidden');
    errorScreen.classList.remove('hidden');
    errorTitle.textContent = title;
    errorMessage.textContent = msg;
  }

  // 3. Drag and Drop events
  ['dragenter', 'dragover'].forEach(eventName => {
    dropZone.addEventListener(eventName, (e) => {
      e.preventDefault();
      dropZone.classList.add('drag-active');
    }, false);
  });

  ['dragleave', 'drop'].forEach(eventName => {
    dropZone.addEventListener(eventName, (e) => {
      e.preventDefault();
      dropZone.classList.remove('drag-active');
    }, false);
  });

  dropZone.addEventListener('drop', (e) => {
    const dt = e.dataTransfer;
    const files = dt.files;
    if (files.length > 0) {
      handleFileSelection(files[0]);
    }
  });

  dropZone.addEventListener('click', () => {
    if (!selectedFile) {
      fileInput.click();
    }
  });

  fileInput.addEventListener('change', () => {
    if (fileInput.files.length > 0) {
      handleFileSelection(fileInput.files[0]);
    }
  });

  removeFileBtn.addEventListener('click', (e) => {
    e.stopPropagation();
    selectedFile = null;
    fileInput.value = '';
    
    fileInfo.classList.add('hidden');
    dropZoneContent.classList.remove('hidden');
    dropZone.classList.remove('has-file');
    
    validateForm();
  });

  function handleFileSelection(file) {
    const allowedExtensions = /\.(mp4|mov|avi|mkv|webm)$/i;
    if (!allowedExtensions.test(file.name)) {
      showFileError('❌ Invalid file format. Only video files (mp4, mov, avi, mkv, webm) are allowed!');
      return;
    }

    const maxSizeBytes = 200 * 1024 * 1024;
    if (file.size > maxSizeBytes) {
      showFileError('❌ File is too large! Maximum limit is 200MB.');
      return;
    }

    selectedFile = file;
    hideFileError();

    fileNameSpan.textContent = file.name;
    fileSizeSpan.textContent = `(${(file.size / (1024 * 1024)).toFixed(2)} MB)`;
    
    dropZoneContent.classList.add('hidden');
    fileInfo.classList.remove('hidden');
    dropZone.classList.add('has-file');

    validateForm();
  }

  function showFileError(msg) {
    fileError.textContent = msg;
    fileError.classList.remove('hidden');
  }

  function hideFileError() {
    fileError.classList.add('hidden');
  }

  // 4. Form inputs validations & Collaborator field toggle
  clipTypeSelect.addEventListener('change', () => {
    if (clipTypeSelect.value) typeError.classList.add('hidden');
    if (collaboratorGroup) {
      if (clipTypeSelect.value === 'Raw + Edited') {
        collaboratorGroup.classList.remove('hidden');
      } else {
        collaboratorGroup.classList.add('hidden');
      }
    }
    validateForm();
  });

  creatorSelect.addEventListener('change', () => {
    if (creatorSelect.value) creatorError.classList.add('hidden');
    validateForm();
  });

  function validateForm() {
    const isFileOk = selectedFile !== null;
    const isTypeOk = clipTypeSelect.value !== '';
    const isCreatorOk = creatorSelect.value !== '';
    submitBtn.disabled = !(isFileOk && isTypeOk && isCreatorOk);
  }

  // 5. Submit handler with live progress and Retry actions
  form.addEventListener('submit', (e) => {
    e.preventDefault();
    performUpload();
  });

  function performUpload() {
    if (!selectedFile) {
      showFileError('Please select a video file.');
      return;
    }
    if (!clipTypeSelect.value) {
      typeError.classList.remove('hidden');
      return;
    }
    if (!creatorSelect.value) {
      creatorError.classList.remove('hidden');
      return;
    }

    uploadOverlay.classList.remove('hidden');
    submitBtn.disabled = true;

    const collaboratorRoleSelect = document.getElementById('collaborator-role');

    // Step 1: Initiate metadata submission
    fetch('/api/web-submissions/init', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${token}`
      },
      body: JSON.stringify({
        clipType: clipTypeSelect.value,
        creatorId: creatorSelect.value,
        editorId: (editorSelect && editorSelect.value) ? editorSelect.value : undefined,
        collaboratorRole: (collaboratorRoleSelect && collaboratorRoleSelect.value) ? collaboratorRoleSelect.value : undefined,
        description: descriptionTextarea.value
      })
    })
    .then(response => {
      if (!response.ok) {
        return response.json().then(data => {
          throw new Error(data.message || 'Initiation failed');
        });
      }
      return response.json();
    })
    .then(data => {
      if (data.success && data.submissionId) {
        // Step 2: Stream file upload
        uploadFile(data.submissionId);
      } else {
        throw new Error('No submission ID returned');
      }
    })
    .catch(err => {
      uploadOverlay.classList.add('hidden');
      showRecoverableUploadError(err.message || 'Failed to initiate submission session.');
    });
  }

  function uploadFile(subId) {
    // 1. Fetch Presigned upload URL
    fetch(`/api/web-submissions/presign/${subId}`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${token}`
      },
      body: JSON.stringify({
        filename: selectedFile.name,
        mimeType: selectedFile.type || 'video/mp4'
      })
    })
    .then(response => {
      if (!response.ok) {
        return response.json().then(data => {
          throw new Error(data.message || 'Presigned URL generation failed');
        });
      }
      return response.json();
    })
    .then(data => {
      if (data.success && data.url) {
        // 2. Perform direct upload via PUT request
        const xhr = new XMLHttpRequest();
        
        xhr.upload.addEventListener('progress', (e) => {
          if (e.lengthComputable) {
            const percent = Math.round((e.loaded / e.total) * 100);
            progressPercent.textContent = percent;
            
            const circumference = 2 * Math.PI * 60;
            const offset = circumference - (percent / 100) * circumference;
            progressIndicator.style.strokeDashoffset = offset;
          }
        });

        xhr.addEventListener('load', () => {
          if (xhr.status === 200) {
            // 3. Mark submission as complete on our API
            completeDirectUpload(subId);
          } else {
            uploadOverlay.classList.add('hidden');
            showRecoverableUploadError(`Direct upload failed with status ${xhr.status}.`);
          }
        });

        xhr.addEventListener('error', () => {
          uploadOverlay.classList.add('hidden');
          showRecoverableUploadError('Direct upload network failure. Please try again.');
        });

        xhr.open('PUT', data.url);
        // Note: Do NOT set Authorization header for S3 PUT, but set Content-Type
        xhr.setRequestHeader('Content-Type', selectedFile.type || 'video/mp4');
        xhr.send(selectedFile);
      } else {
        throw new Error('No presigned URL returned.');
      }
    })
    .catch(err => {
      uploadOverlay.classList.add('hidden');
      showRecoverableUploadError(err.message || 'Failed to request direct upload credentials.');
    });
  }

  function completeDirectUpload(subId) {
    fetch(`/api/web-submissions/complete/${subId}`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${token}`
      },
      body: JSON.stringify({
        sizeBytes: selectedFile.size
      })
    })
    .then(response => {
      uploadOverlay.classList.add('hidden');
      if (!response.ok) {
        return response.json().then(data => {
          throw new Error(data.message || 'Finalization failed');
        });
      }
      return response.json();
    })
    .then(data => {
      if (data.success) {
        if (countdownInterval) clearInterval(countdownInterval);
        portalForm.classList.add('hidden');
        successScreen.classList.remove('hidden');
        successId.textContent = subId;
      } else {
        throw new Error(data.message || 'Finalization failed');
      }
    })
    .catch(err => {
      showRecoverableUploadError(err.message || 'Failed to finalize submission after upload.');
    });
  }

  function showRecoverableUploadError(msg) {
    alert(`Submission Error: ${msg}\n\nYou can click 'Submit' again to retry without losing progress.`);
    submitBtn.disabled = false;
    submitBtn.textContent = 'Retry Submission';
  }

  // Redirect back to Discord channel when Done is clicked
  if (doneBtn) {
    doneBtn.addEventListener('click', (e) => {
      e.preventDefault();
      window.location.href = redirectUrl;
    });
  }
});
