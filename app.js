/* ============================================
   AI 图片 / 视频 生成工作台 - 核心逻辑
   ============================================ */

const PEAR_API_BASE = 'https://api.pearapi.ai';
const IMAGE_API = `${PEAR_API_BASE}/api/image_generate`;
const VIDEO_API = `${PEAR_API_BASE}/api/video_generate`;
const IMGBB_KEY = 'c2d0c798539d2dab9107049c7f544d1d';
const POLL_INTERVAL = 5000;
const VIDEO_MODEL_META = {
  'grok-video-20s': { seconds: 20, maxImages: 5, label: 'Grok Video 20s' },
  'grok-video-16s': { seconds: 16, maxImages: 5, label: 'Grok Video 16s' },
  'grok3-video': { seconds: 6, maxImages: 1, label: 'Grok 3 Video' },
  'grok3-video-10s': { seconds: 10, maxImages: 1, label: 'Grok 3 Video 10s' },
};

function getVideoUrl(data) {
  return data?.api_file_url || data?.video_url || data?.output?.video_url || null;
}

// ---- 状态 ----
const state = {
  tasks: [],          // { type:'image'|'video', id, taskId, status, progress, model, prompt, ...extra }
  pollers: {},
  selectedSize: '16:9',
  uploadedImages: [],
  videoRefImageUrls: [], // 当前选中用于生成视频的参考图
};

// ---- DOM ----
const dom = {};
function cacheDom() {
  Object.assign(dom, {
    // 图片 API
    keyInput:       document.getElementById('input-key'),
    toggleKey:      document.getElementById('btn-toggle-key'),
    // 图片生成控件
    modelSelect:    document.getElementById('select-model'),
    ratioGroup:     document.getElementById('ratio-group'),
    dropZone:       document.getElementById('image-drop-zone'),
    fileInput:      document.getElementById('image-file-input'),
    previewList:    document.getElementById('image-preview-list'),
    imageTip:       document.getElementById('image-tip'),
    promptInput:    document.getElementById('input-prompt'),
    charCount:      document.getElementById('char-count'),
    submitBtn:      document.getElementById('btn-submit'),
    openVideoBtn:   document.getElementById('btn-open-video-dialog'),
    // 任务列表
    taskList:       document.getElementById('task-list'),
    taskCount:      document.getElementById('task-count'),
    emptyState:     document.getElementById('empty-state'),
    // 图片模态框
    modalOverlay:   document.getElementById('modal-overlay'),
    modalImage:     document.getElementById('modal-image'),
    modalDownload:  document.getElementById('modal-download'),
    modalClose:     document.getElementById('modal-close'),
    // 视频模态框
    videoModalOverlay: document.getElementById('video-modal-overlay'),
    modalVideo:     document.getElementById('modal-video'),
    videoModalDownload: document.getElementById('video-modal-download'),
    videoModalClose: document.getElementById('video-modal-close'),
    // 视频生成对话框
    vdOverlay:      document.getElementById('vdialog-overlay'),
    vdClose:        document.getElementById('vdialog-close'),
    vdRef:          document.getElementById('vdialog-ref'),
    vdRefList:      document.getElementById('vdialog-ref-list'),
    vdRefLabel:     document.getElementById('vdialog-ref-label'),
    vdModel:        document.getElementById('select-video-model'),
    vdRatio:        document.getElementById('select-video-ratio'),
    vdPrompt:       document.getElementById('input-video-prompt'),
    vdSubmit:       document.getElementById('btn-submit-video'),
    // 其他
    toastContainer: document.getElementById('toast-container'),
    canvas:         document.getElementById('particles-canvas'),
  });
}

// ======================= 初始化 =======================
function init() {
  cacheDom();
  loadState();
  bindEvents();
  initParticles();
  renderTaskList();
  resumePolling();
}

// ======================= 存储 =======================
function hashKey(key) {
  let h = 0;
  for (let i = 0; i < key.length; i++) { h = ((h << 5) - h) + key.charCodeAt(i); h |= 0; }
  return Math.abs(h).toString(36);
}
function getTasksStorageKey() {
  const k = dom.keyInput.value.trim();
  return k ? 'gen_tasks_' + hashKey(k) : 'gen_tasks_default';
}
function saveState() {
  try {
    localStorage.setItem('gen_key', dom.keyInput.value);
    localStorage.setItem(getTasksStorageKey(), JSON.stringify(state.tasks));
  } catch {}
}
function loadState() {
  try {
    const k = localStorage.getItem('gen_key');
    const legacyVideoKey = localStorage.getItem('gen_video_key');
    if (k) dom.keyInput.value = k;
    else if (legacyVideoKey) {
      dom.keyInput.value = legacyVideoKey;
      localStorage.setItem('gen_key', legacyVideoKey);
    }
    migrateOldTasks();
    localStorage.removeItem('gen_video_key');
    loadTasksForCurrentKey();
  } catch {}
}
function migrateOldTasks() {
  const ik = dom.keyInput.value.trim();
  const vk = (localStorage.getItem('gen_video_key') || '').trim();
  const hImg = ik ? hashKey(ik) : '';
  // 固定旧键 + 各版本哈希键
  const sources = [
    'video_gen_tasks', 'video_gen_tasks_default',
    'img_gen_tasks', 'img_gen_tasks_default',
    'gen_tasks_default',
  ];
  if (hImg) {
    sources.push('img_gen_tasks_' + hImg, 'video_gen_tasks_' + hImg);
    // 旧版组合哈希残留数据
    if (vk) sources.push('gen_tasks_' + hashKey(ik + '|' + vk));
    sources.push('gen_tasks_' + hashKey(ik + '|'));
  }
  const newKey = getTasksStorageKey();
  for (const src of sources) {
    if (src === newKey) continue;
    const raw = localStorage.getItem(src);
    if (!raw) continue;
    let old; try { old = JSON.parse(raw); } catch { continue; }
    if (!Array.isArray(old) || !old.length) { localStorage.removeItem(src); continue; }
    const existRaw = localStorage.getItem(newKey);
    const exist = existRaw ? JSON.parse(existRaw) : [];
    const ids = new Set(exist.map(t => t.taskId));
    const merged = [...exist];
    for (const t of old) { if (t.taskId && !ids.has(t.taskId)) { merged.push(t); ids.add(t.taskId); } }
    localStorage.setItem(newKey, JSON.stringify(merged));
    localStorage.removeItem(src);
  }
}
function loadTasksForCurrentKey() {
  try { const r = localStorage.getItem(getTasksStorageKey()); state.tasks = r ? JSON.parse(r) : []; } catch { state.tasks = []; }
}

// ======================= 事件绑定 =======================
function bindEvents() {
  // Key 显隐
  dom.toggleKey.addEventListener('click', () => { dom.keyInput.type = dom.keyInput.type === 'password' ? 'text' : 'password'; });

  // 字数
  dom.promptInput.addEventListener('input', () => { dom.charCount.textContent = dom.promptInput.value.length; });

  // 图片尺寸
  dom.ratioGroup.addEventListener('click', (e) => {
    const btn = e.target.closest('.ratio-btn'); if (!btn) return;
    dom.ratioGroup.querySelectorAll('.ratio-btn').forEach(b => b.classList.remove('active'));
    btn.classList.add('active');
    state.selectedSize = btn.dataset.ratio;
  });

  // 图片拖拽
  dom.dropZone.addEventListener('click', () => dom.fileInput.click());
  dom.fileInput.addEventListener('change', (e) => { handleFiles(e.target.files); dom.fileInput.value = ''; });
  dom.dropZone.addEventListener('dragover', (e) => { e.preventDefault(); dom.dropZone.classList.add('dragover'); });
  dom.dropZone.addEventListener('dragleave', () => dom.dropZone.classList.remove('dragover'));
  dom.dropZone.addEventListener('drop', (e) => {
    e.preventDefault(); dom.dropZone.classList.remove('dragover');
    const f = Array.from(e.dataTransfer.files).filter(f => f.type.startsWith('image/'));
    if (f.length) handleFiles(f);
  });
  dom.previewList.addEventListener('click', (e) => {
    const btn = e.target.closest('.img-remove-btn');
    if (btn) removeUploadedImage(parseFloat(btn.dataset.id));
  });

  // 生成图片 / 生成视频
  dom.submitBtn.addEventListener('click', submitImageTask);
  dom.openVideoBtn.addEventListener('click', () => {
    const urls = getUploadedImageUrls();
    openVideoDialog(urls);
  });

  // 图片模态框
  dom.modalClose.addEventListener('click', closeImageModal);
  dom.modalOverlay.addEventListener('click', (e) => { if (e.target === dom.modalOverlay) closeImageModal(); });

  // 视频模态框
  dom.videoModalClose.addEventListener('click', closeVideoModal);
  dom.videoModalOverlay.addEventListener('click', (e) => { if (e.target === dom.videoModalOverlay) closeVideoModal(); });

  // 视频生成对话框
  dom.vdClose.addEventListener('click', closeVideoDialog);
  dom.vdOverlay.addEventListener('click', (e) => { if (e.target === dom.vdOverlay) closeVideoDialog(); });
  dom.vdSubmit.addEventListener('click', submitVideoTask);
  dom.vdModel.addEventListener('change', renderVideoRefPreview);

  document.addEventListener('keydown', (e) => { if (e.key === 'Escape') { closeImageModal(); closeVideoModal(); closeVideoDialog(); } });

  // 密钥变更 — input 事件 + 防抖，输入即触发
  let _keyDebounce = null;
  const reloadOnKeyChange = () => {
    clearTimeout(_keyDebounce);
    _keyDebounce = setTimeout(() => {
      Object.keys(state.pollers).forEach(stopPolling);
      saveState();
      migrateOldTasks();
      loadTasksForCurrentKey(); renderTaskList(); resumePolling();
    }, 400);
  };
  dom.keyInput.addEventListener('input', reloadOnKeyChange);
  dom.keyInput.addEventListener('change', reloadOnKeyChange);
}

// ======================= ImgBB 上传 =======================
async function uploadToImgbb(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = async () => {
      try {
        const b64 = reader.result.split(',')[1];
        const fd = new FormData(); fd.append('key', IMGBB_KEY); fd.append('image', b64);
        const r = await fetch('https://api.imgbb.com/1/upload', { method: 'POST', body: fd });
        const j = await r.json();
        j.success && j.data?.url ? resolve(j.data.url) : reject(new Error(j.error?.message || '上传失败'));
      } catch (e) { reject(e); }
    };
    reader.onerror = () => reject(new Error('读取文件失败'));
    reader.readAsDataURL(file);
  });
}

// ======================= 图片处理 =======================
function handleFiles(files) {
  const remaining = 8 - state.uploadedImages.length;
  if (remaining <= 0) { showToast('最多支持 8 张参考图片', 'warning'); return; }
  const list = Array.from(files).filter(f => f.type.startsWith('image/')).slice(0, remaining);
  if (list.length < files.length) showToast(`仅上传前 ${list.length} 张`, 'warning');
  list.forEach(file => {
    const img = { id: Date.now() + Math.random(), fileName: file.name, previewUrl: URL.createObjectURL(file), imgbbUrl: null, uploading: true, error: null };
    state.uploadedImages.push(img);
    renderImagePreviews();
    uploadToImgbb(file)
      .then(url => { img.imgbbUrl = url; img.uploading = false; renderImagePreviews(); })
      .catch(err => { img.uploading = false; img.error = err.message; renderImagePreviews(); showToast(`${file.name} 上传失败`, 'error'); });
  });
}
function removeUploadedImage(id) {
  const i = state.uploadedImages.findIndex(x => x.id === id);
  if (i !== -1) { URL.revokeObjectURL(state.uploadedImages[i].previewUrl); state.uploadedImages.splice(i, 1); renderImagePreviews(); }
}
function renderImagePreviews() {
  if (!state.uploadedImages.length) { dom.previewList.innerHTML = ''; dom.imageTip.style.display = 'none'; return; }
  dom.imageTip.style.display = 'block';
  dom.previewList.innerHTML = state.uploadedImages.map((img, i) => `
    <div class="img-preview-item ${img.uploading ? 'uploading' : ''} ${img.error ? 'error' : ''}">
      <img src="${img.previewUrl}" alt="${esc(img.fileName)}" class="img-thumb" />
      <div class="img-info">
        <span class="img-name">${esc(img.fileName)}</span>
        <span class="img-label">图片 ${i + 1}</span>
        ${img.uploading ? '<span class="img-status uploading-text">上传中...</span>' : ''}
        ${img.error ? `<span class="img-status error-text">${esc(img.error)}</span>` : ''}
        ${img.imgbbUrl ? '<span class="img-status success-text">✓ 已上传</span>' : ''}
      </div>
      <button class="img-remove-btn" data-id="${img.id}" title="移除"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><line x1="18" y1="6" x2="6" y2="18" /><line x1="6" y1="6" x2="18" y2="18" /></svg></button>
    </div>`).join('');
}
function getUploadedImageUrls() {
  return state.uploadedImages.filter(x => x.imgbbUrl && !x.uploading && !x.error).map(x => x.imgbbUrl);
}

// ======================= 图片生成 (PearAPI) =======================
// Pro 模型不支持异步模式，需要走同步
const SYNC_ONLY_MODELS = ['nano-banana-pro', 'nano-banana-pro-4k'];

async function submitImageTask() {
  const key = dom.keyInput.value.trim();
  const prompt = dom.promptInput.value.trim();
  const model = dom.modelSelect.value;
  if (!key) return showToast('请输入图片 API Key', 'error');
  if (!prompt) return showToast('请输入提示词', 'error');
  if (state.uploadedImages.some(x => x.uploading)) return showToast('请等待图片上传完成', 'warning');

  setSubmitLoading(dom.submitBtn, true, '生成中...');
  const images = getUploadedImageUrls();
  const isSyncOnly = SYNC_ONLY_MODELS.includes(model);

  try {
    const body = { prompt, model, size: state.selectedSize, key };
    if (!isSyncOnly) body.task_type = 'async';
    if (images.length) body.images = images;

    const resp = await fetch(IMAGE_API, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
    const json = await resp.json();
    if (json.code !== 200) throw new Error(json.msg || json.detail || JSON.stringify(json));

    if (json.data?.task_id) {
      const task = { type: 'image', id: Date.now(), taskId: json.data.task_id, status: json.data.status || 'queued', progress: json.data.progress || 0, model: json.data.model || model, prompt, size: state.selectedSize, imageUrls: null, createdAt: now() };
      state.tasks.unshift(task); saveState(); renderTaskList(); startImagePolling(task.taskId);
      showToast('图片任务已提交（异步）', 'success');
    } else if (json.data?.image_urls) {
      const task = { type: 'image', id: Date.now(), taskId: 'sync_' + Date.now(), status: 'completed', progress: 100, model, prompt, size: state.selectedSize, imageUrls: json.data.image_urls, createdAt: now() };
      state.tasks.unshift(task); saveState(); renderTaskList();
      showToast('图片生成成功！', 'success');
    } else if (json.data?.image_url) {
      // 某些模型返回单张 image_url 而非数组
      const task = { type: 'image', id: Date.now(), taskId: 'sync_' + Date.now(), status: 'completed', progress: 100, model, prompt, size: state.selectedSize, imageUrls: [json.data.image_url], createdAt: now() };
      state.tasks.unshift(task); saveState(); renderTaskList();
      showToast('图片生成成功！', 'success');
    } else throw new Error('未知响应: ' + JSON.stringify(json.data).slice(0, 200));

    dom.promptInput.value = ''; dom.charCount.textContent = '0';
    state.uploadedImages.forEach(x => URL.revokeObjectURL(x.previewUrl)); state.uploadedImages = []; renderImagePreviews();
  } catch (e) { showToast(e.message, 'error'); console.error('Image gen error:', e); }
  finally { setSubmitLoading(dom.submitBtn, false, '生成图片'); }
}

// ---- 图片任务轮询 ----
function startImagePolling(taskId) {
  if (state.pollers[taskId]) return;
  const poll = async () => {
    const key = dom.keyInput.value.trim(); if (!key) return;
    try {
      const r = await fetch(IMAGE_API, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ key, task_id: taskId }) });
      const j = await r.json();
      if (j.code === 200 && j.data) {
        const t = state.tasks.find(x => x.taskId === taskId); if (!t) return stopPolling(taskId);
        t.status = j.data.status || t.status; t.progress = j.data.progress || t.progress;
        if (j.data.status === 'completed') { t.imageUrls = j.data.image_urls; t.progress = 100; stopPolling(taskId); showToast('图片生成完成！', 'success'); }
        if (j.data.status === 'failed') { stopPolling(taskId); showToast('图片任务失败', 'error'); }
        saveState(); updateTaskCard(taskId);
      }
    } catch {}
  };
  poll(); state.pollers[taskId] = setInterval(poll, POLL_INTERVAL);
}
function stopPolling(id) { if (state.pollers[id]) { clearInterval(state.pollers[id]); delete state.pollers[id]; } }
function resumePolling() {
  state.tasks.forEach(t => {
    if (t.type === 'image' && (t.status === 'queued' || t.status === 'running')) startImagePolling(t.taskId);
    if (t.type === 'video' && (t.status === 'queued' || t.status === 'running')) startVideoPolling(t.taskId);
  });
}

// ======================= 视频生成 (PearAPI Grok) =======================
function getVideoModelMeta(model = dom.vdModel.value) {
  return VIDEO_MODEL_META[model] || { seconds: '', maxImages: 1, label: model };
}

function normalizeVideoRefs(refs) {
  if (!refs) return [];
  const list = Array.isArray(refs) ? refs : [refs];
  return list.filter(Boolean);
}

function getLimitedVideoRefs() {
  const max = getVideoModelMeta().maxImages || 1;
  return state.videoRefImageUrls.slice(0, max);
}

function renderVideoRefPreview() {
  const refs = getLimitedVideoRefs();
  const total = state.videoRefImageUrls.length;
  if (!refs.length) {
    dom.vdRef.style.display = 'none';
    dom.vdRefList.innerHTML = '';
    dom.vdRefLabel.textContent = '';
    return;
  }

  dom.vdRef.style.display = '';
  dom.vdRefList.innerHTML = refs.map((url, i) => `
    <div class="vdialog-ref-item">
      <img src="${url}" alt="参考图${i + 1}" />
      <span>@图${i + 1}</span>
    </div>
  `).join('');

  const meta = getVideoModelMeta();
  const trimmed = total > refs.length ? `，已按模型限制取前 ${refs.length} 张` : '';
  dom.vdRefLabel.textContent = `参考图 ${refs.length}/${meta.maxImages}${trimmed}`;
}

function openVideoDialog(imageRefs) {
  state.videoRefImageUrls = normalizeVideoRefs(imageRefs);
  renderVideoRefPreview();
  dom.vdPrompt.value = state.videoRefImageUrls.length ? '让@图1中的画面动起来' : '';
  dom.vdOverlay.classList.add('active');
}
function closeVideoDialog() { dom.vdOverlay.classList.remove('active'); }

async function submitVideoTask() {
  const apiKey = dom.keyInput.value.trim();
  const prompt = dom.vdPrompt.value.trim();
  if (!apiKey) return showToast('请输入 PearAPI API Key', 'error');
  if (!prompt) return showToast('请输入视频提示词', 'error');

  const model = dom.vdModel.value;
  const meta = VIDEO_MODEL_META[model] || {};
  const imageUrls = getLimitedVideoRefs();

  const body = {
    key: apiKey,
    prompt,
    model,
    aspect_ratio: dom.vdRatio.value,
  };
  if (imageUrls.length) body.images = imageUrls;

  setSubmitLoading(dom.vdSubmit, true, '生成中...');
  try {
    const resp = await fetch(VIDEO_API, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    const json = await resp.json();
    if (json.code !== 200 || !json.data?.task_id) throw new Error(json.msg || json.detail || JSON.stringify(json));

    const task = {
      type: 'video', id: Date.now(), taskId: json.data.task_id,
      status: json.data.status || 'queued',
      progress: json.data.progress || 0,
      model: json.data.model || model, prompt,
      videoUrl: getVideoUrl(json.data),
      imageRef: imageUrls[0] || null,
      imageRefs: imageUrls,
      errorMsg: null,
      videoLength: meta.seconds || '',
      videoRatio: dom.vdRatio.value,
      createdAt: now(),
    };
    if (task.videoUrl) { task.status = 'completed'; task.progress = 100; }
    state.tasks.unshift(task); saveState(); renderTaskList();
    closeVideoDialog();
    if (task.status === 'completed') showToast('视频生成完成！', 'success');
    else { startVideoPolling(task.taskId); showToast('视频任务已提交（异步）', 'success'); }
  } catch (e) {
    showToast(e.message || '视频任务提交失败', 'error');
    console.error('Video gen error:', e);
  } finally {
    setSubmitLoading(dom.vdSubmit, false, '开始生成视频');
  }
}

function startVideoPolling(taskId) {
  if (state.pollers[taskId]) return;
  const poll = async () => {
    const key = dom.keyInput.value.trim(); if (!key) return;
    try {
      const r = await fetch(VIDEO_API, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ key, taskid: taskId }),
      });
      const j = await r.json();
      if (j.code === 200 && j.data) {
        const t = state.tasks.find(x => x.taskId === taskId); if (!t) return stopPolling(taskId);
        t.status = j.data.status || t.status;
        t.progress = j.data.progress ?? t.progress;
        t.model = j.data.model || t.model;
        t.videoUrl = getVideoUrl(j.data) || t.videoUrl;
        if (t.status === 'completed') {
          t.progress = 100;
          stopPolling(taskId);
          if (!t.videoUrl) t.errorMsg = '视频已完成，但未返回视频地址';
          showToast(t.videoUrl ? '视频生成完成！' : '视频生成完成但未返回地址', t.videoUrl ? 'success' : 'warning');
        }
        if (t.status === 'failed') {
          t.errorMsg = j.data.error?.message || j.detail || j.msg || '视频任务失败';
          stopPolling(taskId);
          showToast(t.errorMsg, 'error');
        }
        saveState(); updateTaskCard(taskId);
      }
    } catch {}
  };
  poll(); state.pollers[taskId] = setInterval(poll, POLL_INTERVAL);
}

// ======================= 渲染任务列表 =======================
function renderTaskList() {
  if (!state.tasks.length) { dom.emptyState.style.display = 'flex'; dom.taskList.innerHTML = ''; }
  else { dom.emptyState.style.display = 'none'; dom.taskList.innerHTML = state.tasks.map(buildTaskCard).join(''); }
  dom.taskCount.textContent = `${state.tasks.length} 个任务`;
  bindTaskEvents();
}

function updateTaskCard(taskId) {
  const t = state.tasks.find(x => x.taskId === taskId);
  if (!t) return;
  const card = document.querySelector(`[data-task-id="${taskId}"]`);
  if (!card) return renderTaskList();
  card.outerHTML = buildTaskCard(t);
  bindTaskEvents();
}

function getTaskImageRefs(t) {
  if (Array.isArray(t.imageRefs) && t.imageRefs.length) return t.imageRefs;
  return t.imageRef ? [t.imageRef] : [];
}

function buildTaskCard(t) {
  const isVideo = t.type === 'video';
  const badge = isVideo ? '🎬 视频' : '🖼️ 图片';
  const statusText = { queued: '排队中', running: '生成中', completed: '已完成', failed: '失败' }[t.status] || t.status;

  let mediaHTML = '';
  if (isVideo && t.status === 'completed' && t.videoUrl) {
    mediaHTML = `<div class="task-video-area"><video src="${t.videoUrl}" class="task-video-thumb" muted data-action="play-video" data-url="${t.videoUrl}" title="点击播放"></video></div>`;
  } else if (!isVideo && t.imageUrls?.length) {
    mediaHTML = `<div class="task-thumb-area">${t.imageUrls.map((u, i) => `<img src="${u}" alt="图片${i+1}" class="task-thumb" data-action="preview-image" data-url="${u}" title="点击预览" />`).join('')}</div>`;
  }
  const refs = isVideo ? getTaskImageRefs(t) : [];
  if (refs.length) {
    mediaHTML = `
      <div class="task-ref-badge">
        ${refs.slice(0, 5).map((u, i) => `<img src="${u}" class="task-ref-mini" alt="参考图${i + 1}" />`).join('')}
        <span>参考图${refs.length > 1 ? ` × ${refs.length}` : ''}</span>
      </div>` + mediaHTML;
  }

  let actionsHTML = '';
  if (!isVideo && t.status === 'completed' && t.imageUrls?.length) {
    actionsHTML += t.imageUrls.map((u, i) => `
      <button class="btn-task-action" data-action="gen-video" data-url="${u}" title="用此图生成视频">🎬 生成视频</button>
    `).join('');
    actionsHTML += `<button class="btn-task-action primary" data-action="preview-image" data-url="${t.imageUrls[0]}">👁 查看</button>`;
  }
  if (isVideo && t.status === 'completed' && t.videoUrl) {
    actionsHTML += `<button class="btn-task-action primary" data-action="play-video" data-url="${t.videoUrl}">▶ 播放</button>`;
  }
  actionsHTML += `<button class="btn-task-action" data-action="delete" data-task-id="${t.taskId}">🗑 删除</button>`;

  return `
    <div class="task-card ${isVideo ? 'video-task' : 'image-task'}" data-task-id="${t.taskId}">
      <div class="task-card-header">
        <span class="task-type-badge ${isVideo ? 'type-video' : 'type-image'}">${badge}</span>
        <span class="task-model-badge">${t.model}</span>
        <span class="task-status-badge ${t.status}"><span class="status-dot-badge"></span>${statusText}</span>
      </div>
      <p class="task-prompt">${esc(t.prompt)}</p>
      ${t.errorMsg ? `<p class="task-error-msg">⚠️ ${esc(t.errorMsg)}</p>` : ''}
      ${mediaHTML}
      <div class="task-progress-bar"><div class="task-progress-fill ${t.status === 'running' ? 'running' : ''}" style="width:${t.progress}%"></div></div>
      <div class="task-progress-info">
        <span>${isVideo ? (t.videoLength ? `${t.videoLength}秒 · ` : '') : (t.size ? `${t.size} · ` : '')}${t.createdAt}</span>
        <span class="progress-percent">${t.progress}%</span>
      </div>
      <div class="task-card-footer">
        <span class="task-id" title="${t.taskId}">${t.taskId}</span>
        <div class="task-actions">${actionsHTML}</div>
      </div>
    </div>`;
}

function bindTaskEvents() {
  document.querySelectorAll('[data-action]').forEach(el => {
    el.onclick = (e) => {
      e.stopPropagation();
      const a = el.dataset.action;
      if (a === 'preview-image') openImageModal(el.dataset.url);
      else if (a === 'play-video') openVideoModal(el.dataset.url);
      else if (a === 'gen-video') openVideoDialog(el.dataset.url);
      else if (a === 'delete') deleteTask(el.dataset.taskId);
    };
  });
}

function deleteTask(id) { stopPolling(id); state.tasks = state.tasks.filter(t => t.taskId !== id); saveState(); renderTaskList(); showToast('已删除', 'info'); }

// ======================= 模态框 =======================
function openImageModal(url) { dom.modalImage.src = url; dom.modalDownload.href = url; dom.modalOverlay.classList.add('active'); }
function closeImageModal() { dom.modalOverlay.classList.remove('active'); dom.modalImage.src = ''; }
function openVideoModal(url) { dom.modalVideo.src = url; dom.videoModalDownload.href = url; dom.videoModalOverlay.classList.add('active'); }
function closeVideoModal() { dom.videoModalOverlay.classList.remove('active'); dom.modalVideo.pause(); dom.modalVideo.src = ''; }

// ======================= 工具 =======================
function setSubmitLoading(btn, loading, text) {
  btn.disabled = loading; btn.classList.toggle('loading', loading);
  btn.querySelector('span').textContent = text;
}
function now() { return new Date().toLocaleString('zh-CN'); }

function showToast(msg, type = 'info') {
  const icons = {
    success: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" class="toast-icon"><path d="M22 11.08V12a10 10 0 11-5.93-9.14" /><polyline points="22 4 12 14.01 9 11.01" /></svg>',
    error: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" class="toast-icon"><circle cx="12" cy="12" r="10" /><line x1="15" y1="9" x2="9" y2="15" /><line x1="9" y1="9" x2="15" y2="15" /></svg>',
    warning: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" class="toast-icon"><path d="M10.29 3.86L1.82 18a2 2 0 001.71 3h16.94a2 2 0 001.71-3L13.71 3.86a2 2 0 00-3.42 0z" /><line x1="12" y1="9" x2="12" y2="13" /><line x1="12" y1="17" x2="12.01" y2="17" /></svg>',
    info: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" class="toast-icon"><circle cx="12" cy="12" r="10" /><line x1="12" y1="16" x2="12" y2="12" /><line x1="12" y1="8" x2="12.01" y2="8" /></svg>',
  };
  const t = document.createElement('div'); t.className = `toast ${type}`;
  t.innerHTML = `${icons[type] || icons.info}<span>${esc(msg)}</span>`;
  dom.toastContainer.appendChild(t);
  setTimeout(() => { t.classList.add('removing'); setTimeout(() => t.remove(), 300); }, 4000);
}

function esc(s) { const d = document.createElement('div'); d.textContent = s; return d.innerHTML; }

// ======================= 粒子背景 =======================
function initParticles() {
  const c = dom.canvas, ctx = c.getContext('2d'); let pts = [], w, h;
  const resize = () => { w = c.width = window.innerWidth; h = c.height = window.innerHeight; };
  const create = () => { pts = []; const n = Math.min(Math.floor((w*h)/18000), 80); for (let i=0;i<n;i++) pts.push({x:Math.random()*w,y:Math.random()*h,vx:(Math.random()-.5)*.3,vy:(Math.random()-.5)*.3,r:Math.random()*1.5+.5,a:Math.random()*.3+.05}); };
  const draw = () => {
    ctx.clearRect(0,0,w,h);
    for (const p of pts) { p.x+=p.vx;p.y+=p.vy; if(p.x<0)p.x=w;if(p.x>w)p.x=0;if(p.y<0)p.y=h;if(p.y>h)p.y=0; ctx.beginPath();ctx.arc(p.x,p.y,p.r,0,Math.PI*2);ctx.fillStyle=`rgba(129,140,248,${p.a})`;ctx.fill(); }
    for (let i=0;i<pts.length;i++) for (let j=i+1;j<pts.length;j++) { const dx=pts[i].x-pts[j].x,dy=pts[i].y-pts[j].y,d=Math.sqrt(dx*dx+dy*dy); if(d<120){ctx.beginPath();ctx.moveTo(pts[i].x,pts[i].y);ctx.lineTo(pts[j].x,pts[j].y);ctx.strokeStyle=`rgba(129,140,248,${.06*(1-d/120)})`;ctx.lineWidth=.5;ctx.stroke();} }
    requestAnimationFrame(draw);
  };
  resize(); create(); draw();
  window.addEventListener('resize', () => { resize(); create(); });
}

document.addEventListener('DOMContentLoaded', init);
