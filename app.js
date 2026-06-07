/* ============================================
   AI 图片 / 视频 生成工作台 - 核心逻辑
   ============================================ */

const PEAR_API_BASE = 'https://api.pearapi.ai';
const GEEK_API_BASE = 'https://api.geeknow.top';
const IMAGE_API = `${PEAR_API_BASE}/api/image_generate`;
const VIDEO_API = `${PEAR_API_BASE}/api/video_generate`;
const GEEK_VIDEO_API = `${GEEK_API_BASE}/v1/videos`;
const IMGBB_KEY = 'c2d0c798539d2dab9107049c7f544d1d';
const POLL_INTERVAL = 5000;
const ASSET_VERSION = '20260429-4';
const VIDEO_MODEL_META = {
  'gemini-omni-1080-10s': { seconds: 10, maxImages: 3, label: 'Gemini Omni 1080 10s' },
  'sora-2-12s': { seconds: 12, maxImages: 1, label: 'Sora 2 12s' },
  'veo-3.1-fast': { seconds: 5, maxImages: 2, label: 'Veo 3.1 Fast' },
  'grok-video-3': { seconds: 5, maxImages: 6, label: 'Grok Video 3', isGeek: true },
  'grok-video-3-pro': { seconds: 10, maxImages: 6, label: 'Grok Video 3 Pro', isGeek: true },
  'grok-video-3-max': { seconds: 15, maxImages: 6, label: 'Grok Video 3 Max', isGeek: true },
  'omni-fast': { seconds: 10, maxImages: 5, label: 'Omni Fast', isGeek: true },
  'omni-fast-v2v': { seconds: 10, maxImages: 1, label: 'Omni Fast V2V', isGeek: true },
};

function getVideoUrl(data) {
  return data?.api_file_url || data?.video_url || data?.output?.video_url || null;
}

function getImageUrls(data) {
  if (Array.isArray(data?.image_urls)) return data.image_urls;
  if (data?.image_url) return [data.image_url];
  return null;
}

// ---- 状态 ----
const state = {
  tasks: [],          // { type:'image'|'video', id, taskId, status, progress, model, prompt, ...extra }
  pollers: {},
  mode: 'image',
  selectedSize: '16:9',
  uploadedImages: [],
  videoRefImageUrls: [], // 当前选中用于生成视频的参考图
  videoRefSource: 'uploads',
};

// ---- DOM ----
const dom = {};
function cacheDom() {
  Object.assign(dom, {
    // 设置与 API
    openSettingsBtn: document.getElementById('btn-open-settings'),
    settingsModal:   document.getElementById('settings-modal-overlay'),
    settingsClose:   document.getElementById('settings-modal-close'),
    saveSettingsBtn: document.getElementById('btn-save-settings'),

    pearKeyInput:    document.getElementById('input-pear-key'),
    togglePearKey:   document.getElementById('btn-toggle-pear-key'),
    queryPearBtn:    document.getElementById('btn-query-pear-quota'),
    pearQuotaDisp:   document.getElementById('pear-quota-display'),

    geekKeyInput:    document.getElementById('input-geek-key'),
    toggleGeekKey:   document.getElementById('btn-toggle-geek-key'),
    queryGeekBtn:    document.getElementById('btn-query-geek-quota'),
    geekQuotaDisp:   document.getElementById('geek-quota-display'),
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
    modeSwitch:     document.getElementById('mode-switch'),
    imageModePanel: document.getElementById('image-mode-panel'),
    videoModePanel: document.getElementById('video-mode-panel'),
    imageActionPanel: document.getElementById('image-action-panel'),
    videoActionPanel: document.getElementById('video-action-panel'),
    referenceTitle: document.getElementById('reference-title'),
    referenceSub:   document.getElementById('reference-sub'),
    // 任务列表
    taskList:       document.getElementById('task-list'),
    taskCount:      document.getElementById('task-count'),
    emptyState:     document.getElementById('empty-state'),
    btnMockData:    document.getElementById('btn-mock-data'),
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
    // 视频生成控件
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
  const missing = Object.entries(dom).filter(([, el]) => !el).map(([key]) => key);
  if (missing.length) {
    const msg = `页面结构未加载完整，请强制刷新后重试。缺失节点：${missing.join(', ')}`;
    console.error(msg);
    alert(msg);
    return;
  }
  bindEvents();
  loadState();
  initParticles();
  window.addEventListener('resize', initParticles);
  updateReferenceText();
  renderVideoRefPreview();
  setMode(state.mode);
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
  const pk = dom.pearKeyInput ? dom.pearKeyInput.value.trim() : '';
  const gk = dom.geekKeyInput ? dom.geekKeyInput.value.trim() : '';
  const combined = pk + '|' + gk;
  return (pk || gk) ? 'gen_tasks_' + hashKey(combined) : 'gen_tasks_default';
}
function saveState() {
  try {
    localStorage.setItem('gen_pear_key', dom.pearKeyInput.value);
    localStorage.setItem('gen_geek_key', dom.geekKeyInput.value);
    localStorage.setItem(getTasksStorageKey(), JSON.stringify(state.tasks));
    if (dom.modelSelect.value) localStorage.setItem('gen_image_model', dom.modelSelect.value);
    if (dom.vdModel.value) localStorage.setItem('gen_video_model', dom.vdModel.value);
    if (state.mode) localStorage.setItem('gen_mode', state.mode);
  } catch (e) { console.error('保存数据失败:', e); }
}
function loadState() {
  try {
    const pk = localStorage.getItem('gen_pear_key');
    const gk = localStorage.getItem('gen_geek_key');
    const legacyKey = localStorage.getItem('gen_key');
    
    if (pk) dom.pearKeyInput.value = pk;
    else if (legacyKey) {
      dom.pearKeyInput.value = legacyKey;
      localStorage.setItem('gen_pear_key', legacyKey);
    }
    if (gk) dom.geekKeyInput.value = gk;
    
    const savedImageModel = localStorage.getItem('gen_image_model');
    if (savedImageModel) dom.modelSelect.value = savedImageModel;
    const savedVideoModel = localStorage.getItem('gen_video_model');
    if (savedVideoModel) dom.vdModel.value = savedVideoModel;
    const savedMode = localStorage.getItem('gen_mode');
    if (savedMode) state.mode = savedMode;
    
    migrateOldTasks();
    localStorage.removeItem('gen_video_key');
    loadTasksForCurrentKey();
  } catch {}
}
function migrateOldTasks() {
  const newKey = getTasksStorageKey();
  
  // 收集需要迁移的源 key，避免边遍历边删除导致索引偏移
  const sourcesToMigrate = [];
  for (let i = 0; i < localStorage.length; i++) {
    const src = localStorage.key(i);
    if (src && src.startsWith('gen_tasks_') && src !== newKey) {
      sourcesToMigrate.push(src);
    }
  }
  
  for (const src of sourcesToMigrate) {
    const raw = localStorage.getItem(src);
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
  // 设置显隐
  if (dom.openSettingsBtn) {
    dom.openSettingsBtn.addEventListener('click', () => { dom.settingsModal.classList.add('active'); });
  }
  if (dom.settingsClose) {
    dom.settingsClose.addEventListener('click', () => { dom.settingsModal.classList.remove('active'); });
  }
  if (dom.btnMockData) {
    dom.btnMockData.addEventListener('click', generateMockTasks);
  }
  if (dom.pearKeyInput) dom.pearKeyInput.addEventListener('input', saveState);
  if (dom.geekKeyInput) dom.geekKeyInput.addEventListener('input', saveState);
  
  if (dom.saveSettingsBtn) {
    dom.saveSettingsBtn.addEventListener('click', () => {
      saveState();
      dom.settingsModal.classList.remove('active');
      showToast('设置已保存', 'success');
    });
  }

  // Key 显隐
  if (dom.togglePearKey) dom.togglePearKey.addEventListener('click', () => { dom.pearKeyInput.type = dom.pearKeyInput.type === 'password' ? 'text' : 'password'; });
  if (dom.toggleGeekKey) dom.toggleGeekKey.addEventListener('click', () => { dom.geekKeyInput.type = dom.geekKeyInput.type === 'password' ? 'text' : 'password'; });
  
  // 额度查询
  if (dom.queryPearBtn) dom.queryPearBtn.addEventListener('click', () => queryQuota('pear'));
  if (dom.queryGeekBtn) dom.queryGeekBtn.addEventListener('click', () => queryQuota('geek'));

  // 字数
  dom.promptInput.addEventListener('input', () => { dom.charCount.textContent = dom.promptInput.value.length; });

  dom.modeSwitch.addEventListener('click', (e) => {
    const btn = e.target.closest('[data-mode]');
    if (!btn) return;
    if (btn.dataset.mode === 'video') setMode('video', { refs: getUploadedImageUrls(), source: 'uploads' });
    else setMode('image');
  });

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
  dom.vdSubmit.addEventListener('click', submitVideoTask);

  // 图片模态框
  dom.modalClose.addEventListener('click', closeImageModal);
  dom.modalOverlay.addEventListener('click', (e) => { if (e.target === dom.modalOverlay) closeImageModal(); });

  // 视频模态框
  dom.videoModalClose.addEventListener('click', closeVideoModal);
  dom.videoModalOverlay.addEventListener('click', (e) => { if (e.target === dom.videoModalOverlay) closeVideoModal(); });

  dom.modelSelect.addEventListener('change', saveState);
  dom.vdModel.addEventListener('change', () => { saveState(); updateReferenceText(); renderVideoRefPreview(); });

  document.addEventListener('keydown', (e) => { if (e.key === 'Escape') { closeImageModal(); closeVideoModal(); } });

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
  dom.pearKeyInput.addEventListener('input', reloadOnKeyChange);
  dom.pearKeyInput.addEventListener('change', reloadOnKeyChange);
  dom.geekKeyInput.addEventListener('input', reloadOnKeyChange);
  dom.geekKeyInput.addEventListener('change', reloadOnKeyChange);
}

// ======================= 额度查询 =======================
async function queryQuota(type) {
  let key, btn, disp, url, options;
  if (type === 'pear') {
    key = dom.pearKeyInput.value.trim();
    btn = dom.queryPearBtn;
    disp = dom.pearQuotaDisp;
    url = `${PEAR_API_BASE}/system/auth/user-keys/quota?key=${encodeURIComponent(key)}`;
    options = {};
  } else {
    key = dom.geekKeyInput.value.trim();
    btn = dom.queryGeekBtn;
    disp = dom.geekQuotaDisp;
    url = `${GEEK_API_BASE}/v1/dashboard/billing/subscription`;
    options = { headers: { 'Authorization': `Bearer ${key}` } };
  }
  
  if (!key) return showToast('请输入 API Key', 'warning');
  
  setSubmitLoading(btn, true, '查询中...');
  disp.style.display = 'none';
  try {
    const r = await fetch(url, options);
    const j = await r.json();
    if (j.code === 200 || j.data !== undefined || j.object === 'billing_subscription' || j.hard_limit_usd !== undefined) {
      let quotaInfo = '';
      if (j.object === 'billing_subscription') {
        quotaInfo = j.hard_limit_usd !== undefined ? j.hard_limit_usd : j.balance;
      } else if (typeof j.data === 'object' && j.data !== null) {
        quotaInfo = j.data.quota_balance !== undefined ? j.data.quota_balance : (j.data.quota !== undefined ? j.data.quota : (j.data.balance !== undefined ? j.data.balance : JSON.stringify(j.data)));
      } else {
        quotaInfo = j.data;
      }
      disp.textContent = `当前可用额度: ${quotaInfo}`;
      disp.style.display = 'block';
      showToast('额度查询成功', 'success');
    } else {
      throw new Error(j.msg || j.detail || j.message || '查询失败');
    }
  } catch (e) {
    showToast(e.message, 'error');
    disp.textContent = `查询失败: ${e.message}`;
    disp.style.display = 'block';
  } finally {
    setSubmitLoading(btn, false, '查询额度');
  }
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
  updateReferenceText();
  if (!state.uploadedImages.length) {
    dom.previewList.innerHTML = '';
    dom.imageTip.style.display = 'none';
    syncVideoRefsFromUploads();
    return;
  }
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
  syncVideoRefsFromUploads();
}
function getUploadedImageUrls() {
  return state.uploadedImages.filter(x => x.imgbbUrl && !x.uploading && !x.error).map(x => x.imgbbUrl);
}

// ======================= 图片生成 (PearAPI) =======================
// Pro 模型不支持异步模式，需要走同步
const SYNC_ONLY_MODELS = ['nano-banana-pro', 'nano-banana-pro-4k'];

async function submitImageTask() {
  const key = dom.pearKeyInput.value.trim();
  const prompt = dom.promptInput.value.trim();
  const model = dom.modelSelect.value;
  if (!key) return showToast('请输入 PearAPI API Key', 'error');
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
    } else if (getImageUrls(json.data)) {
      const task = { type: 'image', id: Date.now(), taskId: 'sync_' + Date.now(), status: 'completed', progress: 100, model, prompt, size: state.selectedSize, imageUrls: getImageUrls(json.data), createdAt: now() };
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
    const key = dom.pearKeyInput.value.trim(); if (!key) return;
    try {
      const r = await fetch(IMAGE_API, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ key, task_id: taskId }) });
      const j = await r.json();
      if (j.code === 200 && j.data) {
        const t = state.tasks.find(x => x.taskId === taskId); if (!t) return stopPolling(taskId);
        t.pollErrorCount = 0;
        t.status = j.data.status || t.status; t.progress = j.data.progress ?? t.progress;
        if (j.data.status === 'completed') { t.imageUrls = getImageUrls(j.data); t.progress = 100; stopPolling(taskId); showToast(t.imageUrls?.length ? '图片生成完成！' : '图片生成完成但未返回地址', t.imageUrls?.length ? 'success' : 'warning'); }
        if (j.data.status === 'failed') { t.errorMsg = j.detail || j.msg || '图片任务失败'; stopPolling(taskId); showToast(t.errorMsg, 'error'); }
        saveState(); updateTaskCard(taskId);
      } else if (j.code && j.code !== 200) {
        const t = state.tasks.find(x => x.taskId === taskId); if (!t) return stopPolling(taskId);
        t.status = 'failed';
        t.errorMsg = j.msg || j.detail || '图片任务查询失败';
        stopPolling(taskId);
        saveState(); updateTaskCard(taskId);
        showToast(t.errorMsg, 'error');
      }
    } catch (e) {
      const t = state.tasks.find(x => x.taskId === taskId); if (!t) return stopPolling(taskId);
      t.pollErrorCount = (t.pollErrorCount || 0) + 1;
      if (t.pollErrorCount >= 3) {
        t.status = 'failed';
        t.errorMsg = e.message || '图片任务查询失败';
        stopPolling(taskId);
        saveState(); updateTaskCard(taskId);
        showToast(t.errorMsg, 'error');
      }
    }
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

function setMode(mode, options = {}) {
  state.mode = mode === 'video' ? 'video' : 'image';
  const isVideo = state.mode === 'video';

  dom.modeSwitch.querySelectorAll('[data-mode]').forEach(btn => {
    const active = btn.dataset.mode === state.mode;
    btn.classList.toggle('active', active);
    btn.setAttribute('aria-selected', active ? 'true' : 'false');
  });

  dom.imageModePanel.hidden = isVideo;
  dom.imageActionPanel.hidden = isVideo;
  dom.videoModePanel.hidden = !isVideo;
  dom.videoActionPanel.hidden = !isVideo;
  dom.imageModePanel.classList.toggle('active', !isVideo);
  dom.imageActionPanel.classList.toggle('active', !isVideo);
  dom.videoModePanel.classList.toggle('active', isVideo);
  dom.videoActionPanel.classList.toggle('active', isVideo);

  if (isVideo) {
    if (Object.prototype.hasOwnProperty.call(options, 'refs')) {
      state.videoRefImageUrls = normalizeVideoRefs(options.refs);
      state.videoRefSource = options.source || 'task';
    } else if (state.videoRefSource !== 'task') {
      state.videoRefImageUrls = getUploadedImageUrls();
      state.videoRefSource = 'uploads';
    }
    if (!dom.vdPrompt.value.trim() && state.videoRefImageUrls.length) {
      dom.vdPrompt.value = '让@图1中的画面动起来';
    }
    renderVideoRefPreview();
  } else {
    state.videoRefSource = 'uploads';
  }

  updateReferenceText();
}

function updateReferenceText() {
  if (state.mode === 'video') {
    const meta = getVideoModelMeta();
    dom.referenceTitle.textContent = '视频参考图';
    dom.referenceSub.textContent = `(当前模型最多${meta.maxImages}张, 选填)`;
    dom.imageTip.textContent = '💡 视频提示词中用 @图1、@图2 引用对应参考图';
  } else {
    dom.referenceTitle.textContent = '参考图片';
    dom.referenceSub.textContent = '(最多8张, 选填)';
    dom.imageTip.textContent = '💡 提示词中用"图片1""图片2"引用对应参考图';
  }
}

function syncVideoRefsFromUploads() {
  if (state.mode !== 'video' || state.videoRefSource === 'task') return;
  state.videoRefImageUrls = getUploadedImageUrls();
  renderVideoRefPreview();
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
  setMode('video', { refs: imageRefs, source: 'task' });
  dom.vdPrompt.value = state.videoRefImageUrls.length ? '让@图1中的画面动起来' : dom.vdPrompt.value;
  document.getElementById('config-panel')?.scrollIntoView({ block: 'start', behavior: 'smooth' });
}

async function submitVideoTask() {
  const prompt = dom.vdPrompt.value.trim();
  const model = dom.vdModel.value;
  const meta = VIDEO_MODEL_META[model] || {};
  const isGeek = !!meta.isGeek;
  const apiKey = isGeek ? dom.geekKeyInput.value.trim() : dom.pearKeyInput.value.trim();
  
  if (!apiKey) return showToast(`请输入 ${isGeek ? 'GeekAPI' : 'PearAPI'} API Key`, 'error');
  if (!prompt) return showToast('请输入视频提示词', 'error');
  if (state.videoRefSource !== 'task' && state.uploadedImages.some(x => x.uploading)) return showToast('请等待参考图片上传完成', 'warning');

  if (state.videoRefSource !== 'task') state.videoRefImageUrls = getUploadedImageUrls();
  const imageUrls = getLimitedVideoRefs();

  let reqUrl, reqOptions;
  if (isGeek) {
    reqUrl = GEEK_VIDEO_API;
    const isGrok = model.includes('grok');
    if (isGrok) {
      const fd = new FormData();
      fd.append('model', model);
      fd.append('prompt', prompt);
      fd.append('aspect_ratio', dom.vdRatio.value);
      if (meta.seconds) fd.append('seconds', meta.seconds);
      imageUrls.forEach(url => fd.append('input_reference', url));
      reqOptions = {
        method: 'POST',
        headers: { 'Authorization': `Bearer ${apiKey}` },
        body: fd
      };
    } else {
      const body = { model, prompt, aspect_ratio: dom.vdRatio.value };
      if (meta.seconds) body.seconds = meta.seconds;
      if (imageUrls.length === 1) body.first_image_url = imageUrls[0];
      else if (imageUrls.length === 2) { body.first_image_url = imageUrls[0]; body.last_image_url = imageUrls[1]; }
      else if (imageUrls.length > 2) body.images = imageUrls;
      reqOptions = {
        method: 'POST',
        headers: { 'Authorization': `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
        body: JSON.stringify(body)
      };
    }
  } else {
    reqUrl = VIDEO_API;
    const body = { key: apiKey, prompt, model, aspect_ratio: dom.vdRatio.value };
    if (imageUrls.length) body.images = imageUrls;
    reqOptions = {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    };
  }

  setSubmitLoading(dom.vdSubmit, true, '生成中...');
  try {
    const resp = await fetch(reqUrl, reqOptions);
    const json = await resp.json();
    let taskId = '';
    if (isGeek) {
      if (json.id || json.task_id) taskId = json.id || json.task_id;
      else throw new Error(json.error?.message || json.msg || JSON.stringify(json));
    } else {
      if (json.code !== 200 || !json.data?.task_id) throw new Error(json.msg || json.detail || JSON.stringify(json));
      taskId = json.data.task_id;
    }

    const task = {
      type: 'video', id: Date.now(), taskId: taskId,
      status: (isGeek ? json.status : json.data?.status) || 'queued',
      progress: (isGeek ? json.progress : json.data?.progress) || 0,
      model: model, prompt,
      videoUrl: getVideoUrl(isGeek ? json : json.data),
      imageRef: imageUrls[0] || null,
      imageRefs: imageUrls,
      errorMsg: null,
      videoLength: meta.seconds || '',
      videoRatio: dom.vdRatio.value,
      createdAt: now(),
      isGeek: isGeek
    };
    if (task.videoUrl) { task.status = 'completed'; task.progress = 100; }
    state.tasks.unshift(task); saveState(); renderTaskList();
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
    const t = state.tasks.find(x => x.taskId === taskId); if (!t) return stopPolling(taskId);
    let key, reqUrl, reqOptions;
    if (t.isGeek) {
      key = dom.geekKeyInput.value.trim(); if (!key) return;
      reqUrl = `${GEEK_VIDEO_API}/${taskId}`;
      reqOptions = { method: 'GET', headers: { 'Authorization': `Bearer ${key}` } };
    } else {
      key = dom.pearKeyInput.value.trim(); if (!key) return;
      reqUrl = VIDEO_API;
      reqOptions = { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ key, taskid: taskId }) };
    }

    try {
      const r = await fetch(reqUrl, reqOptions);
      const j = await r.json();
      
      let isSuccess = false;
      let data = null;
      let errorMsg = '';
      if (t.isGeek) {
        if (!j.error && j.status) { isSuccess = true; data = j; }
        else { errorMsg = j.error?.message || '视频任务查询失败'; }
      } else {
        if (j.code === 200 && j.data) { isSuccess = true; data = j.data; }
        else { errorMsg = j.msg || j.detail || '视频任务查询失败'; }
      }

      if (isSuccess && data) {
        t.pollErrorCount = 0;
        t.status = data.status || t.status;
        t.progress = data.progress ?? t.progress;
        t.model = data.model || t.model;
        t.videoUrl = getVideoUrl(data) || t.videoUrl;
        if (t.status === 'completed') {
          t.progress = 100;
          stopPolling(taskId);
          if (t.isGeek && !t.videoUrl) t.videoUrl = `${GEEK_VIDEO_API}/${taskId}/content`;
          if (!t.videoUrl) t.errorMsg = '视频已完成，但未返回视频地址';
          showToast(t.videoUrl ? '视频生成完成！' : '视频生成完成但未返回地址', t.videoUrl ? 'success' : 'warning');
        }
        if (t.status === 'failed') {
          t.errorMsg = data.error?.message || j.detail || j.msg || '视频任务失败';
          stopPolling(taskId);
          showToast(t.errorMsg, 'error');
        }
        saveState(); updateTaskCard(taskId);
      } else {
        t.status = 'failed';
        t.errorMsg = errorMsg || '视频任务查询失败';
        stopPolling(taskId);
        saveState(); updateTaskCard(taskId);
        showToast(t.errorMsg, 'error');
      }
    } catch (e) {
      const t = state.tasks.find(x => x.taskId === taskId); if (!t) return stopPolling(taskId);
      t.pollErrorCount = (t.pollErrorCount || 0) + 1;
      if (t.pollErrorCount >= 3) {
        t.status = 'failed';
        t.errorMsg = e.message || '视频任务查询失败';
        stopPolling(taskId);
        saveState(); updateTaskCard(taskId);
        showToast(t.errorMsg, 'error');
      }
    }
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
      <button class="btn-task-action" data-action="gen-video" data-url="${u}" title="用图${i+1}生成视频">🎬 生视频(图${i+1})</button>
    `).join('');
    actionsHTML += `<button class="btn-task-action primary" data-action="preview-image" data-url="${t.imageUrls[0]}">👁 查看全部</button>`;
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

function generateMockTasks() {
  // 点击后如果已经有 mock 任务就先清理掉，重新生成 9 个
  state.tasks = state.tasks.filter(t => !(t.taskId && t.taskId.startsWith('mock-task')));
  const models = ['gemini-omni-1080-10s', 'sora-2-12s', 'veo-3.1-fast', 'grok-video-3', 'omni-fast', 'nano-banana-2'];
  const prompts = [
    '一只赛博朋克风格的机器猫穿梭在霓虹闪烁的东京街头',
    '火星基地的日出，宇航员正在采矿',
    '一杯正在拉花的咖啡，热气腾腾',
    '史诗级的雪山航拍，气势磅礴',
    '微观镜头下的水滴溅起瞬间',
    '可爱的小狗在草地上奔跑追逐飞盘',
    '充满未来科技感的飞行汽车穿过云层',
    '深海中发光的水母群缓慢游动',
    '一幅印象派风格的向日葵画作逐渐变为真实画面'
  ];
  for (let i = 0; i < 9; i++) {
    const isVideo = i !== 5; // 让其中一个是图片任务
    const model = isVideo ? models[i % 5] : models[5];
    const task = {
      type: isVideo ? 'video' : 'image',
      id: Date.now() - i * 10000,
      taskId: 'mock-task-' + (i + 1),
      status: i === 0 ? 'running' : (i % 3 === 2 ? 'failed' : 'completed'),
      progress: i === 0 ? 45 : (i % 3 === 2 ? 0 : 100),
      model: model,
      prompt: prompts[i],
      videoUrl: (i !== 5 && i % 3 !== 2) ? 'https://www.w3schools.com/html/mov_bbb.mp4' : null,
      imageUrls: (!isVideo && i % 3 !== 2) ? ['https://picsum.photos/400/300?1', 'https://picsum.photos/400/300?2'] : [],
      errorMsg: (i % 3 === 2) ? '连接超时，生成失败。' : null,
      videoLength: isVideo ? '10' : '',
      videoRatio: '16:9',
      createdAt: new Date(Date.now() - i * 60000).toLocaleString(),
      isGeek: i === 3 || i === 4
    };
    state.tasks.unshift(task);
  }
  saveState();
  renderTaskList();
  showToast('已生成9条模拟数据', 'success');
}
