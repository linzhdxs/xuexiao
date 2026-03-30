/* ============================================
   AI 视频生成工作台 - 核心逻辑
   ============================================ */

const API_DIRECT = 'https://api.pearktrue.cn/api/video_generate';
const IMGBB_KEY = 'c2d0c798539d2dab9107049c7f544d1d';
const POLL_INTERVAL = 5000;

function getApiUrl() {
  const proxy = localStorage.getItem('video_gen_proxy') || '';
  if (proxy) {
    return proxy.replace(/\/+$/, '') + '/api/video_generate';
  }
  return API_DIRECT;
}

// ---- 状态管理 ----
const state = {
  tasks: [],
  pollers: {},
  selectedRatio: '16:9',
  uploadedImages: [], // { id, fileName, previewUrl, imgbbUrl, uploading, error }
};

// ---- DOM 缓存 ----
const dom = {
  keyInput: document.getElementById('input-key'),
  proxyInput: document.getElementById('input-proxy'),
  toggleKey: document.getElementById('btn-toggle-key'),
  modelSelect: document.getElementById('select-model'),
  ratioGroup: document.getElementById('ratio-group'),
  dropZone: document.getElementById('image-drop-zone'),
  fileInput: document.getElementById('image-file-input'),
  previewList: document.getElementById('image-preview-list'),
  imageTip: document.getElementById('image-tip'),
  promptInput: document.getElementById('input-prompt'),
  charCount: document.getElementById('char-count'),
  submitBtn: document.getElementById('btn-submit'),
  taskList: document.getElementById('task-list'),
  taskCount: document.getElementById('task-count'),
  emptyState: document.getElementById('empty-state'),
  toastContainer: document.getElementById('toast-container'),
  modalOverlay: document.getElementById('modal-overlay'),
  modalVideo: document.getElementById('modal-video'),
  modalDownload: document.getElementById('modal-download'),
  modalClose: document.getElementById('modal-close'),
  canvas: document.getElementById('particles-canvas'),
};

// ---- 初始化 ----
function init() {
  loadState();
  bindEvents();
  initParticles();
  renderTaskList();
  resumePolling();
}

// ---- API Key 哈希（用于隔离不同密钥的任务记录） ----
function hashKey(key) {
  let hash = 0;
  for (let i = 0; i < key.length; i++) {
    hash = ((hash << 5) - hash) + key.charCodeAt(i);
    hash |= 0;
  }
  return Math.abs(hash).toString(36);
}

function getTasksStorageKey() {
  const key = dom.keyInput.value.trim();
  if (!key) return 'video_gen_tasks_default';
  return 'video_gen_tasks_' + hashKey(key);
}

// ---- 本地持久化 ----
function saveState() {
  try {
    localStorage.setItem('video_gen_key', dom.keyInput.value);
    localStorage.setItem('video_gen_proxy', dom.proxyInput.value.trim());
    localStorage.setItem(getTasksStorageKey(), JSON.stringify(state.tasks));
  } catch (e) { /* ignore */ }
}

function loadState() {
  try {
    const key = localStorage.getItem('video_gen_key');
    if (key) dom.keyInput.value = key;
    const proxy = localStorage.getItem('video_gen_proxy');
    if (proxy) dom.proxyInput.value = proxy;

    // 迁移旧版数据：旧版用固定 key "video_gen_tasks"，新版按 API Key 隔离
    migrateOldTasks();

    loadTasksForCurrentKey();
  } catch (e) { /* ignore */ }
}

function migrateOldTasks() {
  try {
    const oldRaw = localStorage.getItem('video_gen_tasks');
    if (!oldRaw) return; // 没有旧数据，跳过

    const oldTasks = JSON.parse(oldRaw);
    if (!Array.isArray(oldTasks) || oldTasks.length === 0) {
      localStorage.removeItem('video_gen_tasks');
      return;
    }

    // 把旧数据合并到当前 key 的存储中
    const newKey = getTasksStorageKey();
    const existingRaw = localStorage.getItem(newKey);
    const existing = existingRaw ? JSON.parse(existingRaw) : [];

    // 去重合并（按 taskId）
    const existingIds = new Set(existing.map(t => t.taskId));
    const merged = [...existing];
    for (const task of oldTasks) {
      if (!existingIds.has(task.taskId)) {
        merged.push(task);
      }
    }

    localStorage.setItem(newKey, JSON.stringify(merged));
    localStorage.removeItem('video_gen_tasks'); // 清除旧键
  } catch (e) { /* ignore */ }
}

function loadTasksForCurrentKey() {
  try {
    const raw = localStorage.getItem(getTasksStorageKey());
    state.tasks = raw ? JSON.parse(raw) : [];
  } catch (e) {
    state.tasks = [];
  }
}

// ---- 事件绑定 ----
function bindEvents() {
  // Key 显隐
  dom.toggleKey.addEventListener('click', () => {
    dom.keyInput.type = dom.keyInput.type === 'password' ? 'text' : 'password';
  });

  // 字数统计
  dom.promptInput.addEventListener('input', () => {
    dom.charCount.textContent = dom.promptInput.value.length;
  });

  // 画面比例
  dom.ratioGroup.addEventListener('click', (e) => {
    const btn = e.target.closest('.ratio-btn');
    if (!btn) return;
    dom.ratioGroup.querySelectorAll('.ratio-btn').forEach(b => b.classList.remove('active'));
    btn.classList.add('active');
    state.selectedRatio = btn.dataset.ratio;
  });

  // ---- 图片拖拽上传 ----
  dom.dropZone.addEventListener('click', () => dom.fileInput.click());

  dom.fileInput.addEventListener('change', (e) => {
    handleFiles(e.target.files);
    dom.fileInput.value = ''; // 允许重复选择同名文件
  });

  dom.dropZone.addEventListener('dragover', (e) => {
    e.preventDefault();
    dom.dropZone.classList.add('dragover');
  });

  dom.dropZone.addEventListener('dragleave', () => {
    dom.dropZone.classList.remove('dragover');
  });

  dom.dropZone.addEventListener('drop', (e) => {
    e.preventDefault();
    dom.dropZone.classList.remove('dragover');
    const files = Array.from(e.dataTransfer.files).filter(f => f.type.startsWith('image/'));
    if (files.length) handleFiles(files);
  });

  // 图片预览列表 - 事件委托（删除）
  dom.previewList.addEventListener('click', (e) => {
    const btn = e.target.closest('.img-remove-btn');
    if (!btn) return;
    const id = parseFloat(btn.dataset.id);
    removeUploadedImage(id);
  });

  // 提交
  dom.submitBtn.addEventListener('click', submitTask);

  // 模态框
  dom.modalClose.addEventListener('click', closeModal);
  dom.modalOverlay.addEventListener('click', (e) => {
    if (e.target === dom.modalOverlay) closeModal();
  });
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') closeModal();
  });

  // Key 变更 → 切换任务记录
  dom.keyInput.addEventListener('change', () => {
    localStorage.setItem('video_gen_key', dom.keyInput.value);
    // 停掉当前所有轮询
    Object.keys(state.pollers).forEach(stopPolling);
    // 加载新 key 对应的任务
    loadTasksForCurrentKey();
    renderTaskList();
    resumePolling();
  });

  dom.proxyInput.addEventListener('change', saveState);
}

// ---- imgbb 上传 ----
async function uploadToImgbb(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = async () => {
      try {
        const base64 = reader.result.split(',')[1];
        const formData = new FormData();
        formData.append('key', IMGBB_KEY);
        formData.append('image', base64);
        formData.append('name', file.name.replace(/\.[^.]+$/, ''));

        const resp = await fetch('https://api.imgbb.com/1/upload', {
          method: 'POST',
          body: formData,
        });
        const json = await resp.json();

        if (json.success && json.data?.url) {
          resolve(json.data.url);
        } else {
          reject(new Error(json.error?.message || '图片上传失败'));
        }
      } catch (err) {
        reject(err);
      }
    };
    reader.onerror = () => reject(new Error('读取文件失败'));
    reader.readAsDataURL(file);
  });
}

// ---- 图片处理 ----
function handleFiles(files) {
  Array.from(files).forEach(file => {
    if (!file.type.startsWith('image/')) return;

    const img = {
      id: Date.now() + Math.random(),
      fileName: file.name,
      previewUrl: URL.createObjectURL(file),
      imgbbUrl: null,
      uploading: true,
      error: null,
    };

    state.uploadedImages.push(img);
    renderImagePreviews();

    uploadToImgbb(file)
      .then(url => {
        img.imgbbUrl = url;
        img.uploading = false;
        renderImagePreviews();
      })
      .catch(err => {
        img.uploading = false;
        img.error = err.message;
        renderImagePreviews();
        showToast(`图片 ${file.name} 上传失败: ${err.message}`, 'error');
      });
  });
}

function removeUploadedImage(id) {
  const idx = state.uploadedImages.findIndex(img => img.id === id);
  if (idx !== -1) {
    if (state.uploadedImages[idx].previewUrl) {
      URL.revokeObjectURL(state.uploadedImages[idx].previewUrl);
    }
    state.uploadedImages.splice(idx, 1);
    renderImagePreviews();
  }
}

function renderImagePreviews() {
  if (state.uploadedImages.length === 0) {
    dom.previewList.innerHTML = '';
    dom.imageTip.style.display = 'none';
    return;
  }

  dom.imageTip.style.display = 'block';

  dom.previewList.innerHTML = state.uploadedImages.map((img, index) => `
    <div class="img-preview-item ${img.uploading ? 'uploading' : ''} ${img.error ? 'error' : ''}">
      <img src="${img.previewUrl}" alt="${escapeHtml(img.fileName)}" class="img-thumb" />
      <div class="img-info">
        <span class="img-name">${escapeHtml(img.fileName)}</span>
        <span class="img-label">图片 ${index + 1}</span>
        ${img.uploading ? '<span class="img-status uploading-text">上传中...</span>' : ''}
        ${img.error ? `<span class="img-status error-text">${escapeHtml(img.error)}</span>` : ''}
        ${img.imgbbUrl ? '<span class="img-status success-text">\u2713 已上传</span>' : ''}
      </div>
      <button class="img-remove-btn" data-id="${img.id}" title="移除">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><line x1="18" y1="6" x2="6" y2="18" /><line x1="6" y1="6" x2="18" y2="18" /></svg>
      </button>
    </div>
  `).join('');
}

function getUploadedImageUrls() {
  return state.uploadedImages
    .filter(img => img.imgbbUrl && !img.uploading && !img.error)
    .map(img => img.imgbbUrl);
}

// ---- 提交任务 ----
async function submitTask() {
  const key = dom.keyInput.value.trim();
  const prompt = dom.promptInput.value.trim();
  const model = dom.modelSelect.value;
  const images = getUploadedImageUrls();

  if (!key) return showToast('请输入 API Key', 'error');
  if (!prompt) return showToast('请输入提示词', 'error');

  // 检查是否有图片还在上传中
  if (state.uploadedImages.some(img => img.uploading)) {
    return showToast('请等待图片上传完成', 'warning');
  }

  dom.submitBtn.disabled = true;
  dom.submitBtn.classList.add('loading');
  dom.submitBtn.querySelector('span').textContent = '提交中...';

  try {
    const body = {
      prompt,
      model,
      aspect_ratio: state.selectedRatio,
      key,
      taskid: '',
    };

    if (images.length > 0) {
      body.images = images;
    }

    const resp = await fetch(getApiUrl(), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });

    const json = await resp.json();

    if (json.code !== 200 || !json.data?.task_id) {
      throw new Error(json.msg || '任务提交失败');
    }

    const task = {
      id: Date.now(),
      taskId: json.data.task_id,
      status: json.data.status || 'queued',
      progress: json.data.progress || 0,
      model: json.data.model || model,
      prompt,
      ratio: state.selectedRatio,
      videoUrl: null,
      createdAt: new Date().toLocaleString('zh-CN'),
    };

    state.tasks.unshift(task);
    saveState();
    renderTaskList();
    startPolling(task.taskId);

    showToast('任务提交成功，开始生成...', 'success');

    // 清空提示词
    dom.promptInput.value = '';
    dom.charCount.textContent = '0';

    // 清空已上传图片
    state.uploadedImages.forEach(img => {
      if (img.previewUrl) URL.revokeObjectURL(img.previewUrl);
    });
    state.uploadedImages = [];
    renderImagePreviews();

  } catch (err) {
    showToast(err.message || '提交失败，请检查参数', 'error');
  } finally {
    dom.submitBtn.disabled = false;
    dom.submitBtn.classList.remove('loading');
    dom.submitBtn.querySelector('span').textContent = '提交生成任务';
  }
}

// ---- 轮询任务 ----
function startPolling(taskId) {
  if (state.pollers[taskId]) return;

  const poll = async () => {
    const key = dom.keyInput.value.trim();
    if (!key) return;

    try {
      const resp = await fetch(getApiUrl(), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ key, taskid: taskId }),
      });
      const json = await resp.json();

      if (json.code === 200 && json.data) {
        const task = state.tasks.find(t => t.taskId === taskId);
        if (!task) return stopPolling(taskId);

        task.status = json.data.status;
        task.progress = json.data.progress || 0;

        if (json.data.status === 'completed') {
          task.videoUrl = json.data.api_file_url || null;
          task.progress = 100;
          stopPolling(taskId);
          showToast(`视频生成完成！模型: ${task.model}`, 'success');
        } else if (json.data.status === 'failed') {
          stopPolling(taskId);
          showToast(`任务失败: ${taskId.slice(0, 8)}...`, 'error');
        }

        saveState();
        updateTaskCard(taskId);
      }
    } catch (err) {
      console.error('Poll error:', err);
    }
  };

  poll();
  state.pollers[taskId] = setInterval(poll, POLL_INTERVAL);
}

function stopPolling(taskId) {
  if (state.pollers[taskId]) {
    clearInterval(state.pollers[taskId]);
    delete state.pollers[taskId];
  }
}

function resumePolling() {
  state.tasks.forEach(task => {
    if (task.status === 'queued' || task.status === 'running') {
      startPolling(task.taskId);
    }
  });
}

// ---- 渲染任务列表 ----
function renderTaskList() {
  if (state.tasks.length === 0) {
    dom.emptyState.style.display = 'flex';
    dom.taskList.innerHTML = '';
  } else {
    dom.emptyState.style.display = 'none';
    dom.taskList.innerHTML = state.tasks.map(task => buildTaskCardHTML(task)).join('');
    bindTaskCardEvents();
  }
  dom.taskCount.textContent = `${state.tasks.length} 个任务`;
}

function updateTaskCard(taskId) {
  const task = state.tasks.find(t => t.taskId === taskId);
  if (!task) return;

  const card = document.querySelector(`[data-task-id="${taskId}"]`);
  if (!card) return renderTaskList();

  const statusBadge = card.querySelector('.task-status-badge');
  statusBadge.className = `task-status-badge ${task.status}`;
  statusBadge.innerHTML = `<span class="status-dot-badge"></span>${statusLabel(task.status)}`;

  const progressFill = card.querySelector('.task-progress-fill');
  progressFill.style.width = `${task.progress}%`;
  progressFill.className = `task-progress-fill ${task.status === 'running' ? 'running' : ''}`;

  const progressText = card.querySelector('.progress-percent');
  progressText.textContent = `${task.progress}%`;

  const actionsContainer = card.querySelector('.task-actions');
  actionsContainer.innerHTML = buildTaskActionsHTML(task);
  bindTaskCardEvents();
}

function statusLabel(status) {
  const map = { queued: '排队中', running: '生成中', completed: '已完成', failed: '失败' };
  return map[status] || status;
}

function buildTaskCardHTML(task) {
  return `
    <div class="task-card" data-task-id="${task.taskId}">
      <div class="task-card-header">
        <span class="task-model-badge">${task.model}</span>
        <span class="task-status-badge ${task.status}">
          <span class="status-dot-badge"></span>
          ${statusLabel(task.status)}
        </span>
      </div>
      <p class="task-prompt">${escapeHtml(task.prompt)}</p>
      <div class="task-progress-bar">
        <div class="task-progress-fill ${task.status === 'running' ? 'running' : ''}" style="width: ${task.progress}%"></div>
      </div>
      <div class="task-progress-info">
        <span>${task.ratio} · ${task.createdAt}</span>
        <span class="progress-percent">${task.progress}%</span>
      </div>
      <div class="task-card-footer">
        <span class="task-id" title="${task.taskId}">${task.taskId}</span>
        <div class="task-actions">
          ${buildTaskActionsHTML(task)}
        </div>
      </div>
    </div>
  `;
}

function buildTaskActionsHTML(task) {
  let html = '';
  if (task.status === 'completed' && task.videoUrl) {
    html += `
      <button class="btn-task-action primary" data-action="preview" data-url="${task.videoUrl}">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polygon points="5 3 19 12 5 21 5 3" /></svg>
        预览
      </button>
    `;
  }
  html += `
    <button class="btn-task-action" data-action="delete" data-task-id="${task.taskId}">
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="3 6 5 6 21 6" /><path d="M19 6v14a2 2 0 01-2 2H7a2 2 0 01-2-2V6m3 0V4a2 2 0 012-2h4a2 2 0 012 2v2" /></svg>
      删除
    </button>
  `;
  return html;
}

function bindTaskCardEvents() {
  document.querySelectorAll('.btn-task-action').forEach(btn => {
    btn.onclick = (e) => {
      e.stopPropagation();
      const action = btn.dataset.action;
      if (action === 'preview') {
        openModal(btn.dataset.url);
      } else if (action === 'delete') {
        deleteTask(btn.dataset.taskId);
      }
    };
  });
}

function deleteTask(taskId) {
  stopPolling(taskId);
  state.tasks = state.tasks.filter(t => t.taskId !== taskId);
  saveState();
  renderTaskList();
  showToast('任务已删除', 'info');
}

// ---- 模态框 ----
function openModal(url) {
  dom.modalVideo.src = url;
  dom.modalDownload.href = url;
  dom.modalOverlay.classList.add('active');
}

function closeModal() {
  dom.modalOverlay.classList.remove('active');
  dom.modalVideo.pause();
  dom.modalVideo.src = '';
}

// ---- Toast ----
function showToast(msg, type = 'info') {
  const iconMap = {
    success: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" class="toast-icon"><path d="M22 11.08V12a10 10 0 11-5.93-9.14" /><polyline points="22 4 12 14.01 9 11.01" /></svg>',
    error: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" class="toast-icon"><circle cx="12" cy="12" r="10" /><line x1="15" y1="9" x2="9" y2="15" /><line x1="9" y1="9" x2="15" y2="15" /></svg>',
    warning: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" class="toast-icon"><path d="M10.29 3.86L1.82 18a2 2 0 001.71 3h16.94a2 2 0 001.71-3L13.71 3.86a2 2 0 00-3.42 0z" /><line x1="12" y1="9" x2="12" y2="13" /><line x1="12" y1="17" x2="12.01" y2="17" /></svg>',
    info: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" class="toast-icon"><circle cx="12" cy="12" r="10" /><line x1="12" y1="16" x2="12" y2="12" /><line x1="12" y1="8" x2="12.01" y2="8" /></svg>',
  };

  const toast = document.createElement('div');
  toast.className = `toast ${type}`;
  toast.innerHTML = `${iconMap[type] || iconMap.info}<span>${escapeHtml(msg)}</span>`;
  dom.toastContainer.appendChild(toast);

  setTimeout(() => {
    toast.classList.add('removing');
    setTimeout(() => toast.remove(), 300);
  }, 4000);
}

// ---- 工具 ----
function escapeHtml(str) {
  const div = document.createElement('div');
  div.textContent = str;
  return div.innerHTML;
}

// ---- 粒子背景 ----
function initParticles() {
  const canvas = dom.canvas;
  const ctx = canvas.getContext('2d');
  let particles = [];
  let w, h;

  function resize() {
    w = canvas.width = window.innerWidth;
    h = canvas.height = window.innerHeight;
  }

  function createParticles() {
    particles = [];
    const count = Math.min(Math.floor((w * h) / 18000), 80);
    for (let i = 0; i < count; i++) {
      particles.push({
        x: Math.random() * w,
        y: Math.random() * h,
        vx: (Math.random() - 0.5) * 0.3,
        vy: (Math.random() - 0.5) * 0.3,
        r: Math.random() * 1.5 + 0.5,
        alpha: Math.random() * 0.3 + 0.05,
      });
    }
  }

  function draw() {
    ctx.clearRect(0, 0, w, h);
    for (const p of particles) {
      p.x += p.vx;
      p.y += p.vy;
      if (p.x < 0) p.x = w;
      if (p.x > w) p.x = 0;
      if (p.y < 0) p.y = h;
      if (p.y > h) p.y = 0;

      ctx.beginPath();
      ctx.arc(p.x, p.y, p.r, 0, Math.PI * 2);
      ctx.fillStyle = `rgba(129, 140, 248, ${p.alpha})`;
      ctx.fill();
    }

    for (let i = 0; i < particles.length; i++) {
      for (let j = i + 1; j < particles.length; j++) {
        const dx = particles[i].x - particles[j].x;
        const dy = particles[i].y - particles[j].y;
        const dist = Math.sqrt(dx * dx + dy * dy);
        if (dist < 120) {
          ctx.beginPath();
          ctx.moveTo(particles[i].x, particles[i].y);
          ctx.lineTo(particles[j].x, particles[j].y);
          ctx.strokeStyle = `rgba(129, 140, 248, ${0.06 * (1 - dist / 120)})`;
          ctx.lineWidth = 0.5;
          ctx.stroke();
        }
      }
    }

    requestAnimationFrame(draw);
  }

  resize();
  createParticles();
  draw();

  window.addEventListener('resize', () => {
    resize();
    createParticles();
  });
}

// ---- 启动 ----
document.addEventListener('DOMContentLoaded', init);
