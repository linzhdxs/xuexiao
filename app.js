/* Seedance video workspace - frontend logic */

const API_ROOT = window.SEEDANCE_API_ROOT || '/api/video';
const STORAGE_KEY = 'seedance_video_tasks_v1';
const POLL_INTERVAL = 5000;
const MAX_PROMPT_LENGTH = 2000;
const MODEL = {
  id: 'seedance-2.0',
  label: 'Seedance 2.0',
};

const state = {
  tasks: [],
  pollers: {},
};

const dom = {};

function cacheDom() {
  Object.assign(dom, {
    serviceStatus: document.getElementById('service-status'),
    modelSelect: document.getElementById('select-video-model'),
    ratioSelect: document.getElementById('select-video-ratio'),
    secondsSelect: document.getElementById('select-video-seconds'),
    promptInput: document.getElementById('input-video-prompt'),
    charCount: document.getElementById('char-count'),
    submitBtn: document.getElementById('btn-submit-video'),
    clearCompletedBtn: document.getElementById('btn-clear-completed'),
    taskCount: document.getElementById('task-count'),
    taskList: document.getElementById('task-list'),
    emptyState: document.getElementById('empty-state'),
    toastContainer: document.getElementById('toast-container'),
    videoModalOverlay: document.getElementById('video-modal-overlay'),
    modalVideo: document.getElementById('modal-video'),
    videoModalDownload: document.getElementById('video-modal-download'),
    videoModalClose: document.getElementById('video-modal-close'),
  });
}

function init() {
  cacheDom();
  bindEvents();
  loadTasks();
  renderTaskList();
  resumePolling();
  updateServiceStatus();
  updateCharCount();
  dom.modelSelect.disabled = true;
}

function bindEvents() {
  dom.promptInput.addEventListener('input', updateCharCount);
  dom.submitBtn.addEventListener('click', submitVideoTask);
  dom.promptInput.addEventListener('keydown', event => {
    if ((event.ctrlKey || event.metaKey) && event.key === 'Enter') submitVideoTask();
  });
  dom.clearCompletedBtn.addEventListener('click', clearCompletedTasks);
  dom.taskList.addEventListener('click', handleTaskAction);
  dom.videoModalClose.addEventListener('click', closeVideoModal);
  dom.videoModalOverlay.addEventListener('click', event => {
    if (event.target === dom.videoModalOverlay) closeVideoModal();
  });
  document.addEventListener('keydown', event => {
    if (event.key === 'Escape') closeVideoModal();
  });
}

async function updateServiceStatus() {
  try {
    const response = await fetch(`${API_ROOT}/health`, { cache: 'no-store' });
    const data = await response.json();
    if (!response.ok || data.ok === false) throw new Error('offline');
    setServiceStatus('服务在线', true);
  } catch {
    setServiceStatus('服务未连接', false);
  }
}

function setServiceStatus(text, online) {
  const label = dom.serviceStatus.querySelector('span:last-child');
  label.textContent = text;
  dom.serviceStatus.classList.toggle('offline', !online);
}

function updateCharCount() {
  dom.charCount.textContent = String(dom.promptInput.value.length);
}

async function submitVideoTask() {
  const prompt = dom.promptInput.value.trim();
  const aspectRatio = dom.ratioSelect.value;
  const seconds = Number(dom.secondsSelect.value || 5);

  if (!prompt) return showToast('请输入提示词', 'warning');
  if (prompt.length > MAX_PROMPT_LENGTH) return showToast(`提示词不能超过 ${MAX_PROMPT_LENGTH} 字`, 'warning');

  setSubmitLoading(true, '提交中');
  try {
    const payload = { prompt, aspectRatio, seconds };
    const response = await fetch(`${API_ROOT}/create`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });
    const json = await readApiResponse(response);
    const data = json.data || {};
    const task = createTaskFromResponse(data, { prompt, aspectRatio, seconds });

    state.tasks.unshift(task);
    trimTasks();
    saveTasks();
    renderTaskList();

    if (task.status === 'completed') {
      showToast('视频生成完成', 'success');
    } else {
      startVideoPolling(task.taskId);
      showToast('任务已提交', 'success');
    }

    dom.promptInput.value = '';
    updateCharCount();
  } catch (error) {
    showToast(error.message || '任务提交失败', 'error');
  } finally {
    setSubmitLoading(false, '生成视频');
  }
}

function createTaskFromResponse(data, input) {
  const taskId = data.taskId || data.id || `local-${Date.now()}`;
  const status = normalizeStatus(data.status);
  const videoUrl = data.videoUrl || '';
  return {
    type: 'video',
    taskId,
    status: videoUrl ? 'completed' : status,
    progress: videoUrl ? 100 : clampProgress(data.progress),
    model: data.model || MODEL.label,
    prompt: input.prompt,
    videoUrl,
    errorMsg: '',
    videoLength: input.seconds,
    videoRatio: input.aspectRatio,
    createdAt: formatTime(new Date()),
    pollErrorCount: 0,
  };
}

function startVideoPolling(taskId) {
  if (state.pollers[taskId]) return;

  const poll = async () => {
    const task = state.tasks.find(item => item.taskId === taskId);
    if (!task) return stopPolling(taskId);

    try {
      const response = await fetch(`${API_ROOT}/status`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ taskId }),
      });
      const json = await readApiResponse(response);
      const data = json.data || {};

      task.pollErrorCount = 0;
      task.status = normalizeStatus(data.status || task.status);
      task.progress = clampProgress(data.progress ?? task.progress);
      task.model = data.model || task.model;
      task.videoUrl = data.videoUrl || task.videoUrl;

      if (task.status === 'completed') {
        task.progress = 100;
        if (!task.videoUrl) task.videoUrl = `${API_ROOT}/content?taskId=${encodeURIComponent(taskId)}`;
        stopPolling(taskId);
        showToast('视频生成完成', 'success');
      }

      if (task.status === 'failed') {
        task.errorMsg = data.error || '任务生成失败';
        stopPolling(taskId);
        showToast(task.errorMsg, 'error');
      }

      saveTasks();
      updateTaskCard(taskId);
    } catch (error) {
      task.pollErrorCount = (task.pollErrorCount || 0) + 1;
      if (task.pollErrorCount >= 3) {
        task.status = 'failed';
        task.errorMsg = error.message || '任务查询失败';
        stopPolling(taskId);
        saveTasks();
        updateTaskCard(taskId);
        showToast(task.errorMsg, 'error');
      }
    }
  };

  poll();
  state.pollers[taskId] = window.setInterval(poll, POLL_INTERVAL);
}

function stopPolling(taskId) {
  if (!state.pollers[taskId]) return;
  window.clearInterval(state.pollers[taskId]);
  delete state.pollers[taskId];
}

function resumePolling() {
  state.tasks.forEach(task => {
    if (['queued', 'running'].includes(task.status)) startVideoPolling(task.taskId);
  });
}

function renderTaskList() {
  dom.taskCount.textContent = `${state.tasks.length} 个任务`;
  dom.emptyState.style.display = state.tasks.length ? 'none' : 'flex';
  dom.taskList.innerHTML = state.tasks.map(buildTaskCard).join('');
}

function updateTaskCard(taskId) {
  const task = state.tasks.find(item => item.taskId === taskId);
  const card = dom.taskList.querySelector(`[data-task-id="${cssEscape(taskId)}"]`);
  if (!task || !card) return renderTaskList();
  card.outerHTML = buildTaskCard(task);
  dom.taskCount.textContent = `${state.tasks.length} 个任务`;
}

function buildTaskCard(task) {
  const statusText = getStatusText(task.status);
  const playable = task.status === 'completed' && task.videoUrl;
  const media = playable
    ? `<button class="video-preview" type="button" data-action="play" data-url="${escAttr(task.videoUrl)}" aria-label="播放视频"><video src="${escAttr(task.videoUrl)}#t=0.001" muted preload="metadata"></video><span class="play-mark"><svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><path d="M8 5v14l11-7L8 5Z" /></svg></span></button>`
    : `<div class="video-placeholder ${task.status}"><span>${statusText}</span></div>`;

  return `
    <article class="task-card ${task.status}" data-task-id="${escAttr(task.taskId)}">
      <div class="task-topline">
        <span class="task-model">${esc(task.model)}</span>
        <span class="task-status ${task.status}">${statusText}</span>
      </div>
      ${media}
      <p class="task-prompt">${esc(task.prompt)}</p>
      ${task.errorMsg ? `<p class="task-error">${esc(task.errorMsg)}</p>` : ''}
      <div class="progress-track" aria-hidden="true"><span style="width:${clampProgress(task.progress)}%"></span></div>
      <div class="task-meta">
        <span>${esc(String(task.videoRatio))} · ${esc(String(task.videoLength))} 秒</span>
        <span>${esc(task.createdAt)}</span>
      </div>
      <div class="task-footer">
        <span class="task-id" title="${escAttr(task.taskId)}">${esc(shortTaskId(task.taskId))}</span>
        <div class="task-actions">
          ${playable ? `<button class="btn-task primary" type="button" data-action="play" data-url="${escAttr(task.videoUrl)}">播放</button>` : ''}
          <button class="btn-task" type="button" data-action="delete" data-task-id="${escAttr(task.taskId)}">删除</button>
        </div>
      </div>
    </article>`;
}

function handleTaskAction(event) {
  const target = event.target.closest('[data-action]');
  if (!target) return;
  const action = target.dataset.action;
  if (action === 'play') openVideoModal(target.dataset.url);
  if (action === 'delete') deleteTask(target.dataset.taskId);
}

function deleteTask(taskId) {
  stopPolling(taskId);
  state.tasks = state.tasks.filter(task => task.taskId !== taskId);
  saveTasks();
  renderTaskList();
  showToast('已删除', 'info');
}

function clearCompletedTasks() {
  const before = state.tasks.length;
  state.tasks = state.tasks.filter(task => task.status !== 'completed');
  if (state.tasks.length === before) return showToast('没有可清理的任务', 'info');
  saveTasks();
  renderTaskList();
  showToast('已清理完成任务', 'success');
}

function openVideoModal(url) {
  if (!url) return;
  dom.modalVideo.src = url;
  dom.videoModalDownload.href = url;
  dom.videoModalOverlay.classList.add('active');
  dom.videoModalOverlay.setAttribute('aria-hidden', 'false');
}

function closeVideoModal() {
  dom.videoModalOverlay.classList.remove('active');
  dom.videoModalOverlay.setAttribute('aria-hidden', 'true');
  dom.modalVideo.pause();
  dom.modalVideo.removeAttribute('src');
  dom.modalVideo.load();
}

async function readApiResponse(response) {
  const text = await response.text();
  let json = {};
  try {
    json = text ? JSON.parse(text) : {};
  } catch {
    json = { error: text || '响应格式错误' };
  }

  if (!response.ok || json.ok === false || json.error) {
    throw new Error(json.error || json.message || `请求失败：${response.status}`);
  }
  return json;
}

function normalizeStatus(status) {
  const value = String(status || '').toLowerCase();
  if (['completed', 'complete', 'succeeded', 'success', 'finished', 'done'].includes(value)) return 'completed';
  if (['failed', 'fail', 'error', 'cancelled', 'canceled'].includes(value)) return 'failed';
  if (['running', 'processing', 'in_progress', 'generating'].includes(value)) return 'running';
  return value || 'queued';
}

function getStatusText(status) {
  return ({
    queued: '排队中',
    running: '生成中',
    completed: '已完成',
    failed: '失败',
  })[status] || status;
}

function setSubmitLoading(loading, text) {
  dom.submitBtn.disabled = loading;
  dom.submitBtn.classList.toggle('loading', loading);
  dom.submitBtn.querySelector('span').textContent = text;
}

function loadTasks() {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    state.tasks = raw ? JSON.parse(raw) : [];
  } catch {
    state.tasks = [];
  }
}

function saveTasks() {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(state.tasks));
}

function trimTasks() {
  state.tasks = state.tasks.slice(0, 80);
}

function showToast(message, type = 'info') {
  const toast = document.createElement('div');
  toast.className = `toast ${type}`;
  toast.textContent = message;
  dom.toastContainer.appendChild(toast);
  window.setTimeout(() => {
    toast.classList.add('leaving');
    window.setTimeout(() => toast.remove(), 220);
  }, 3600);
}

function formatTime(date) {
  return date.toLocaleString('zh-CN', { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' });
}

function shortTaskId(taskId) {
  const value = String(taskId || '');
  return value.length > 18 ? `${value.slice(0, 8)}...${value.slice(-6)}` : value;
}

function clampProgress(value) {
  const number = Number(value);
  if (!Number.isFinite(number)) return 0;
  return Math.max(0, Math.min(100, Math.round(number)));
}

function esc(value) {
  const div = document.createElement('div');
  div.textContent = String(value ?? '');
  return div.innerHTML;
}

function escAttr(value) {
  return esc(value).replace(/"/g, '&quot;');
}

function cssEscape(value) {
  if (window.CSS && typeof window.CSS.escape === 'function') return window.CSS.escape(value);
  return String(value).replace(/[^a-zA-Z0-9_-]/g, '\\$&');
}

document.addEventListener('DOMContentLoaded', init);
