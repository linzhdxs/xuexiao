/* ============================================
   AI 视频生成工作台 - 核心逻辑
   ============================================ */

const API_DIRECT = 'https://api.pearktrue.cn/api/video_generate';
const POLL_INTERVAL = 5000; // 5 秒轮询

// 代理 URL：部署 Cloudflare Worker 后填入，格式如 https://your-worker.your-name.workers.dev
// 实际请求会发到 {PROXY_URL}/api/video_generate
function getApiUrl() {
  const proxy = localStorage.getItem('video_gen_proxy') || '';
  if (proxy) {
    return proxy.replace(/\/+$/, '') + '/api/video_generate';
  }
  return API_DIRECT;
}

// ---- 状态管理 ----
const state = {
  tasks: [],       // { id, taskId, status, progress, model, prompt, ratio, videoUrl, createdAt }
  pollers: {},     // taskId -> intervalId
  selectedRatio: '16:9',
};

// ---- DOM 缓存 ----
const dom = {
  keyInput: document.getElementById('input-key'),
  proxyInput: document.getElementById('input-proxy'),
  toggleKey: document.getElementById('btn-toggle-key'),
  modelSelect: document.getElementById('select-model'),
  ratioGroup: document.getElementById('ratio-group'),
  imageList: document.getElementById('image-url-list'),
  addUrlBtn: document.getElementById('btn-add-url'),
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

// ---- 本地持久化 ----
function saveState() {
  try {
    localStorage.setItem('video_gen_key', dom.keyInput.value);
    localStorage.setItem('video_gen_proxy', dom.proxyInput.value.trim());
    localStorage.setItem('video_gen_tasks', JSON.stringify(state.tasks));
  } catch (e) { /* ignore */ }
}

function loadState() {
  try {
    const key = localStorage.getItem('video_gen_key');
    if (key) dom.keyInput.value = key;
    const proxy = localStorage.getItem('video_gen_proxy');
    if (proxy) dom.proxyInput.value = proxy;
    const tasks = localStorage.getItem('video_gen_tasks');
    if (tasks) state.tasks = JSON.parse(tasks);
  } catch (e) { /* ignore */ }
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

  // 添加图片 URL
  dom.addUrlBtn.addEventListener('click', addImageUrlRow);

  // 移除图片 URL (委托)
  dom.imageList.addEventListener('click', (e) => {
    const btn = e.target.closest('.btn-remove-url');
    if (!btn) return;
    const rows = dom.imageList.querySelectorAll('.image-url-row');
    if (rows.length > 1) {
      btn.closest('.image-url-row').remove();
      updateRemoveButtons();
    }
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

  // key/proxy 变更保存
  dom.keyInput.addEventListener('change', saveState);
  dom.proxyInput.addEventListener('change', saveState);
}

// ---- 图片 URL 行 ----
function addImageUrlRow() {
  const row = document.createElement('div');
  row.className = 'image-url-row';
  row.innerHTML = `
    <input type="url" class="form-input image-url-input" placeholder="https://example.com/image.jpg" />
    <button class="btn-icon btn-remove-url" title="移除">
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><line x1="18" y1="6" x2="6" y2="18" /><line x1="6" y1="6" x2="18" y2="18" /></svg>
    </button>
  `;
  dom.imageList.appendChild(row);
  updateRemoveButtons();
}

function updateRemoveButtons() {
  const rows = dom.imageList.querySelectorAll('.image-url-row');
  rows.forEach((row, i) => {
    const btn = row.querySelector('.btn-remove-url');
    btn.style.visibility = rows.length > 1 ? 'visible' : 'hidden';
  });
}

// ---- 获取图片 URL 数组 ----
function getImageUrls() {
  const inputs = dom.imageList.querySelectorAll('.image-url-input');
  return Array.from(inputs).map(i => i.value.trim()).filter(Boolean);
}

// ---- 提交任务 ----
async function submitTask() {
  const key = dom.keyInput.value.trim();
  const prompt = dom.promptInput.value.trim();
  const model = dom.modelSelect.value;
  const images = getImageUrls();

  // 校验
  if (!key) return showToast('请输入 API Key', 'error');
  if (!prompt) return showToast('请输入提示词', 'error');

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

    // images 只在有值时传
    if (images.length > 0) {
      body.images = images;
    }

    const resp = await fetch(API_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });

    const json = await resp.json();

    if (json.code !== 200 || !json.data?.task_id) {
      throw new Error(json.msg || '任务提交失败');
    }

    // 保存任务
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

  // 立即查一次
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

  // 更新状态 badge
  const statusBadge = card.querySelector('.task-status-badge');
  statusBadge.className = `task-status-badge ${task.status}`;
  statusBadge.innerHTML = `<span class="status-dot-badge"></span>${statusLabel(task.status)}`;

  // 更新进度条
  const progressFill = card.querySelector('.task-progress-fill');
  progressFill.style.width = `${task.progress}%`;
  progressFill.className = `task-progress-fill ${task.status === 'running' ? 'running' : ''}`;

  // 更新进度文字
  const progressText = card.querySelector('.progress-percent');
  progressText.textContent = `${task.progress}%`;

  // 更新按钮
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

    // 连线
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
