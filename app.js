/* ============================================
   AI 图片 / 视频 生成工作台 - 核心逻辑
   ============================================ */

const PEAR_API_BASE = 'https://api.pearapi.ai';
const GEEK_API_BASE = 'https://api.geeknow.top';
const IMAGE_API = `${PEAR_API_BASE}/api/image_generate`;
const VIDEO_API = `${PEAR_API_BASE}/api/video_generate`;
const GEEK_VIDEO_API = `${GEEK_API_BASE}/v1/videos`;
const VIDEO_MODEL_CACHE_KEY = 'gen_video_models_cache_v2';
const IMGBB_KEY = 'c2d0c798539d2dab9107049c7f544d1d';
const POLL_INTERVAL = 5000;
const ASSET_VERSION = '20260607-5';

const VIDEO_PROVIDERS = {
  pear: {
    name: 'PearAPI',
    baseUrl: PEAR_API_BASE,
    pricingUrl: `${PEAR_API_BASE}/api/pricing`,
    defaultEndpointPath: '/v1/videos/generations',
    auth: 'bearer',
  },
  geek: {
    name: 'GeekAPI',
    baseUrl: GEEK_API_BASE,
    pricingUrl: `${GEEK_API_BASE}/api/pricing`,
    defaultEndpointPath: '/v1/videos',
    auth: 'bearer',
  },
};

const FALLBACK_VIDEO_MODELS = [
  { provider: 'pear', id: 'gemini-omni', label: 'gemini-omni', price: 0.4, priceUnit: '次', maxImages: 3, secondsOptions: [4, 6, 8, 10], endpointPath: '/v1/videos/generations', requestMode: 'openai-video' },
  { provider: 'pear', id: 'sora-2', label: 'sora-2', price: 0.27, priceUnit: '次', maxImages: 1, secondsOptions: [4, 8, 12], endpointPath: '/v1/videos/generations', requestMode: 'openai-video' },
  { provider: 'pear', id: 'veo-3.1-fast', label: 'veo-3.1-fast', price: 1.28, priceUnit: '次', maxImages: 2, secondsOptions: [5, 8], endpointPath: '/v1/videos/generations', requestMode: 'openai-video' },
  { provider: 'geek', id: 'grok-video-3', label: 'grok-video-3', price: 0.2, priceUnit: '次', maxImages: 6, secondsOptions: [5], endpointPath: '/v1/videos', requestMode: 'multipart' },
  { provider: 'geek', id: 'grok-video-3-pro', label: 'grok-video-3-pro', price: 0.2, priceUnit: '次', maxImages: 6, secondsOptions: [10], endpointPath: '/v1/videos', requestMode: 'multipart' },
  { provider: 'geek', id: 'grok-video-3-max', label: 'grok-video-3-max', price: 0.2, priceUnit: '次', maxImages: 6, secondsOptions: [15], endpointPath: '/v1/videos', requestMode: 'multipart' },
  { provider: 'geek', id: 'omni-fast', label: 'omni-fast', price: 0.6, priceUnit: '次', maxImages: 5, secondsOptions: [10], endpointPath: '/v1/videos', requestMode: 'json-url' },
  { provider: 'geek', id: 'omni-fast-v2v', label: 'omni-fast-v2v', price: 1, priceUnit: '次', maxVideos: 1, secondsOptions: [10], endpointPath: '/v1/videos', requestMode: 'json-url' },
];

function getVideoUrl(data) {
  return data?.api_file_url || data?.video_url || data?.url || data?.output?.video_url || data?.output?.url || data?.data?.video_url || null;
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
  videoRefItems: [],
  videoRefImageUrls: [], // 兼容旧任务：当前选中用于生成视频的参考图 URL
  videoRefSource: 'uploads',
  videoModels: [...FALLBACK_VIDEO_MODELS],
  videoEndpointPaths: {
    pear: VIDEO_PROVIDERS.pear.defaultEndpointPath,
    geek: VIDEO_PROVIDERS.geek.defaultEndpointPath,
  },
  videoModelsSyncedAt: null,
  savedVideoModel: '',
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
    dropText:       document.querySelector('.drop-text'),
    dropHint:       document.querySelector('.drop-hint'),
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
    vdSeconds:      document.getElementById('select-video-seconds'),
    vdRatio:        document.getElementById('select-video-ratio'),
    vdPrompt:       document.getElementById('input-video-prompt'),
    vdSubmit:       document.getElementById('btn-submit-video'),
    videoModelInfo: document.getElementById('video-model-info'),
    videoModelSyncStatus: document.getElementById('video-model-sync-status'),
    syncVideoModelsBtn: document.getElementById('btn-sync-video-models'),
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
  hydrateVideoModelsFromCache();
  renderVideoModelOptions();
  initParticles();
  window.addEventListener('resize', initParticles);
  updateReferenceText();
  renderVideoRefPreview();
  setMode(state.mode);
  renderTaskList();
  resumePolling();
  syncVideoModels({ silent: true });
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
    if (savedVideoModel) state.savedVideoModel = savedVideoModel;
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

// ======================= 视频模型同步 =======================
function getVideoModelValue(model) {
  return `${model.provider}::${model.id}`;
}

function getVideoModelsByProvider(provider) {
  return state.videoModels
    .filter(m => m.provider === provider)
    .sort((a, b) => String(a.label || a.id).localeCompare(String(b.label || b.id), 'zh-CN'));
}

function getSelectedVideoModelValue() {
  return dom.vdModel?.value || state.savedVideoModel || localStorage.getItem('gen_video_model') || '';
}

function hydrateVideoModelsFromCache() {
  try {
    const raw = localStorage.getItem(VIDEO_MODEL_CACHE_KEY);
    if (!raw) return;
    const cache = JSON.parse(raw);
    if (Array.isArray(cache.models) && cache.models.length) {
      state.videoModels = mergeVideoModels([...FALLBACK_VIDEO_MODELS, ...cache.models]);
    }
    if (cache.endpointPaths) {
      state.videoEndpointPaths = { ...state.videoEndpointPaths, ...cache.endpointPaths };
    }
    state.videoModelsSyncedAt = cache.syncedAt || null;
  } catch (e) {
    console.warn('读取视频模型缓存失败:', e);
  }
}

async function syncVideoModels({ silent = false } = {}) {
  setVideoModelSyncStatus('同步中...', 'loading');
  if (dom.syncVideoModelsBtn) dom.syncVideoModelsBtn.disabled = true;

  const results = await Promise.allSettled(Object.keys(VIDEO_PROVIDERS).map(fetchProviderVideoModels));
  const syncedModels = [];
  const syncedProviders = [];
  const errors = [];

  results.forEach(result => {
    if (result.status === 'fulfilled') {
      syncedModels.push(...result.value.models);
      syncedProviders.push(VIDEO_PROVIDERS[result.value.provider].name);
      state.videoEndpointPaths[result.value.provider] = result.value.endpointPath;
    } else {
      errors.push(result.reason?.message || String(result.reason));
    }
  });

  if (syncedModels.length) {
    state.videoModels = mergeVideoModels([...FALLBACK_VIDEO_MODELS, ...syncedModels]);
    state.videoModelsSyncedAt = new Date().toISOString();
    try {
      localStorage.setItem(VIDEO_MODEL_CACHE_KEY, JSON.stringify({
        syncedAt: state.videoModelsSyncedAt,
        endpointPaths: state.videoEndpointPaths,
        models: state.videoModels.filter(m => !m.isFallback),
      }));
    } catch (e) {
      console.warn('保存视频模型缓存失败:', e);
    }
    renderVideoModelOptions({ preserveSelection: true });
    setVideoModelSyncStatus(`已同步 ${syncedProviders.join(' / ')} · ${formatSyncedAt(state.videoModelsSyncedAt)}`, errors.length ? 'warning' : 'success');
    if (!silent) showToast('视频模型已同步', 'success');
  } else {
    renderVideoModelOptions({ preserveSelection: true });
    setVideoModelSyncStatus('同步失败，已使用本地兜底模型', 'warning');
    if (!silent) showToast(errors[0] || '视频模型同步失败', 'warning');
  }

  if (dom.syncVideoModelsBtn) dom.syncVideoModelsBtn.disabled = false;
}

async function fetchProviderVideoModels(provider) {
  const config = VIDEO_PROVIDERS[provider];
  const resp = await fetch(config.pricingUrl, { cache: 'no-store' });
  if (!resp.ok) throw new Error(`${config.name} pricing 请求失败: ${resp.status}`);
  const json = await resp.json();
  if (json.success === false) throw new Error(`${config.name} pricing 返回失败`);

  const endpointPath = json.supported_endpoint?.['openai-video']?.path || config.defaultEndpointPath;
  const rawModels = Array.isArray(json.data) ? json.data : [];
  const models = rawModels
    .filter(isVideoPricingModel)
    .map(item => mapPricingVideoModel(provider, item, endpointPath))
    .filter(Boolean);

  return { provider, endpointPath, models };
}

function isVideoPricingModel(item) {
  const name = String(item.model_name || item.id || '');
  const tags = String(item.tags || '');
  const endpointTypes = Array.isArray(item.supported_endpoint_types) ? item.supported_endpoint_types : [];
  const saysVideo = tags.includes('视频') || endpointTypes.includes('openai-video');
  const videoName = /(video|sora|veo|omni-fast|grok-video|grok-imagine-video|kling|vidu|pixverse|hailuo|sv-|gv-|happyhorse|seedance|doubao-seedance|mingmou|wan\d)/i.test(name);
  return !!name && (saysVideo || videoName);
}

function mapPricingVideoModel(provider, item, endpointPath) {
  const id = String(item.model_name || item.id || '').trim();
  if (!id) return null;
  const description = stripHtml(String(item.description || ''));
  const limits = inferReferenceLimits(id, description, item.tags);
  const secondsOptions = inferSecondsOptions(id, description);
  const endpointTypes = Array.isArray(item.supported_endpoint_types) ? item.supported_endpoint_types : [];
  const priceUnit = item.model_price_type === 'second' || /按秒计费/.test(description) ? '秒' : '次';

  return {
    provider,
    id,
    label: id,
    description,
    tags: item.tags || '',
    price: item.model_price,
    priceUnit,
    quotaType: item.quota_type,
    billingLabels: Array.isArray(item.billing_labels) ? item.billing_labels : [],
    supportedEndpointTypes: endpointTypes,
    endpointPath,
    requestMode: inferRequestMode(provider, id, endpointTypes),
    secondsOptions,
    ...limits,
    isFallback: false,
  };
}

function mergeVideoModels(models) {
  const byKey = new Map();
  models.forEach(model => {
    const key = getVideoModelValue(model);
    const prev = byKey.get(key);
    if (!prev) {
      byKey.set(key, normalizeVideoModel(model));
      return;
    }
    const next = normalizeVideoModel({ ...prev, ...model });
    ['maxImages', 'maxVideos', 'maxAudios'].forEach(field => {
      if ((model[field] === undefined || model[field] === null) && prev[field] !== undefined) next[field] = prev[field];
    });
    if ((!model.secondsOptions || !model.secondsOptions.length) && prev.secondsOptions?.length) next.secondsOptions = prev.secondsOptions;
    if (!model.requestMode && prev.requestMode) next.requestMode = prev.requestMode;
    byKey.set(key, next);
  });
  return Array.from(byKey.values()).map(model => ({ ...model, maxFiles: getModelMaxFiles(model) }));
}

function normalizeVideoModel(model) {
  const normalized = { ...model };
  normalized.label = normalized.label || normalized.id;
  normalized.maxImages = Number.isFinite(Number(normalized.maxImages)) ? Number(normalized.maxImages) : 0;
  normalized.maxVideos = Number.isFinite(Number(normalized.maxVideos)) ? Number(normalized.maxVideos) : 0;
  normalized.maxAudios = Number.isFinite(Number(normalized.maxAudios)) ? Number(normalized.maxAudios) : 0;
  normalized.maxFiles = getModelMaxFiles(normalized);
  normalized.secondsOptions = Array.isArray(normalized.secondsOptions) ? normalized.secondsOptions.map(Number).filter(Boolean) : [];
  normalized.endpointPath = normalized.endpointPath || VIDEO_PROVIDERS[normalized.provider]?.defaultEndpointPath || '/v1/videos';
  normalized.requestMode = normalized.requestMode || inferRequestMode(normalized.provider, normalized.id, normalized.supportedEndpointTypes || []);
  return normalized;
}

function inferRequestMode(provider, id, endpointTypes = []) {
  if (endpointTypes.includes('openai-video')) return 'openai-video';
  if (/grok|imagine|reference|r2v/i.test(id)) return 'multipart';
  if (provider === 'pear') return 'openai-video';
  return 'json-url';
}

function inferReferenceLimits(id, description, tags = '') {
  const text = `${id} ${description || ''} ${tags || ''}`;
  const maxImages = findNumber(text, /最多\s*(\d+)\s*(?:张|張)\s*(?:图|圖|图片|圖片)?/i)
    ?? findNumber(text, /可参考最多\s*(\d+)\s*(?:张|張)/i);
  const maxVideos = findNumber(text, /最多\s*(\d+)\s*(?:个|個)\s*视频/i)
    ?? findNumber(text, /[、,，]\s*(\d+)\s*(?:个|個)\s*视频/i)
    ?? 0;
  const maxAudios = findNumber(text, /最多\s*(\d+)\s*(?:段|个|個)\s*音频/i)
    ?? findNumber(text, /[、,，]\s*(\d+)\s*(?:段|个|個)\s*音频/i)
    ?? 0;

  let inferredImages = maxImages;
  if (inferredImages === null || inferredImages === undefined) {
    if (/仅支持单张参考图|单张参考图|单张参考|单参考图|单张图生视频|单参考图生成/.test(text)) inferredImages = 1;
    else if (/首尾帧|首尾帧视频|首尾/.test(text)) inferredImages = 2;
    else if (/首帧|参考图生视频|图生视频|参考生视频|支持设置参考图|input_reference|reference|ref|i2v|r2v/i.test(text)) inferredImages = 1;
    else inferredImages = 0;
  }

  return { maxImages: inferredImages, maxVideos, maxAudios };
}

function inferSecondsOptions(id, description = '') {
  const text = `${id} ${description}`;
  const nums = new Set();
  const listMatches = text.match(/\d+(?:\s*\/\s*\d+)+\s*(?:秒|s)/gi) || [];
  listMatches.forEach(match => {
    (match.match(/\d+/g) || []).forEach(n => nums.add(Number(n)));
  });
  const singleMatches = text.match(/\d+\s*(?:秒|s)/gi) || [];
  singleMatches.forEach(match => {
    const n = Number((match.match(/\d+/) || [])[0]);
    if (n && n <= 60) nums.add(n);
  });
  return Array.from(nums).filter(Boolean).sort((a, b) => a - b);
}

function findNumber(text, regex) {
  const match = text.match(regex);
  return match ? Number(match[1]) : null;
}

function getModelMaxFiles(model) {
  return (Number(model.maxImages) || 0) + (Number(model.maxVideos) || 0) + (Number(model.maxAudios) || 0);
}

function stripHtml(text) {
  return text.replace(/<[^>]*>/g, '').replace(/\s+/g, ' ').trim();
}

function renderVideoModelOptions({ preserveSelection = false } = {}) {
  if (!dom.vdModel) return;
  const previous = preserveSelection ? getSelectedVideoModelValue() : (state.savedVideoModel || getSelectedVideoModelValue());
  dom.vdModel.innerHTML = '';

  Object.keys(VIDEO_PROVIDERS).forEach(provider => {
    const models = getVideoModelsByProvider(provider);
    if (!models.length) return;
    const group = document.createElement('optgroup');
    group.label = `${VIDEO_PROVIDERS[provider].name} 视频模型`;
    models.forEach(model => {
      const option = document.createElement('option');
      option.value = getVideoModelValue(model);
      option.textContent = formatVideoOptionLabel(model);
      option.title = model.description || option.textContent;
      group.appendChild(option);
    });
    dom.vdModel.appendChild(group);
  });

  const allValues = state.videoModels.map(getVideoModelValue);
  if (allValues.includes(previous)) dom.vdModel.value = previous;
  else {
    const byLegacyId = state.videoModels.find(model => model.id === previous);
    dom.vdModel.value = byLegacyId ? getVideoModelValue(byLegacyId) : (allValues[0] || '');
  }

  state.savedVideoModel = dom.vdModel.value;
  renderVideoSecondsOptions();
  updateReferenceText();
  renderVideoRefPreview();
  renderVideoModelInfo();
}

function formatVideoOptionLabel(model) {
  return `${model.label || model.id} (${formatVideoPrice(model)} · ${formatVideoLimitShort(model)})`;
}

function formatVideoPrice(model) {
  if (model.price === undefined || model.price === null || model.price === '') return '价格未知';
  const n = Number(model.price);
  if (!Number.isFinite(n)) return String(model.price);
  return `¥${Number.isInteger(n) ? n : n.toFixed(3).replace(/0+$/, '').replace(/\.$/, '')}/${model.priceUnit || '次'}`;
}

function formatVideoLimitShort(model) {
  const parts = [];
  if (model.maxImages) parts.push(`${model.maxImages}图`);
  if (model.maxVideos) parts.push(`${model.maxVideos}视频`);
  if (model.maxAudios) parts.push(`${model.maxAudios}音频`);
  return parts.length ? `参考${parts.join('/')}` : '无参考文件';
}

function formatVideoLimitLong(model) {
  const parts = [];
  if (model.maxImages) parts.push(`图片 ${model.maxImages}`);
  if (model.maxVideos) parts.push(`视频 ${model.maxVideos}`);
  if (model.maxAudios) parts.push(`音频 ${model.maxAudios}`);
  return parts.length ? parts.join(' / ') : '不支持参考文件';
}

function formatSyncedAt(iso) {
  if (!iso) return '未同步';
  try { return new Date(iso).toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' }); }
  catch { return '刚刚'; }
}

function setVideoModelSyncStatus(text, type = 'info') {
  if (!dom.videoModelSyncStatus) return;
  dom.videoModelSyncStatus.textContent = text;
  dom.videoModelSyncStatus.dataset.status = type;
}

function getVideoModelMeta(value = getSelectedVideoModelValue()) {
  const [provider, ...idParts] = String(value || '').split('::');
  const id = idParts.join('::');
  let model = null;
  if (provider && id) model = state.videoModels.find(m => m.provider === provider && m.id === id);
  if (!model && value) model = state.videoModels.find(m => m.id === value || getVideoModelValue(m) === value);
  return normalizeVideoModel(model || state.videoModels[0] || FALLBACK_VIDEO_MODELS[0]);
}

function renderVideoSecondsOptions() {
  if (!dom.vdSeconds) return;
  const meta = getVideoModelMeta();
  const previous = dom.vdSeconds.value;
  dom.vdSeconds.innerHTML = '';

  if (!meta.secondsOptions.length) {
    const option = document.createElement('option');
    option.value = '';
    option.textContent = '默认时长';
    dom.vdSeconds.appendChild(option);
    dom.vdSeconds.disabled = true;
    return;
  }

  meta.secondsOptions.forEach(seconds => {
    const option = document.createElement('option');
    option.value = String(seconds);
    option.textContent = `${seconds} 秒`;
    dom.vdSeconds.appendChild(option);
  });
  dom.vdSeconds.disabled = false;
  dom.vdSeconds.value = meta.secondsOptions.map(String).includes(previous) ? previous : String(meta.secondsOptions[meta.secondsOptions.length - 1]);
}

function renderVideoModelInfo() {
  if (!dom.videoModelInfo) return;
  const meta = getVideoModelMeta();
  const provider = VIDEO_PROVIDERS[meta.provider]?.name || meta.provider;
  dom.videoModelInfo.innerHTML = `
    <span>${provider}</span>
    <span>${formatVideoPrice(meta)}</span>
    <span>${formatVideoLimitLong(meta)}</span>
    <span>${esc(meta.endpointPath || '')}</span>
  `;
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
  
  // 额度查询 / 模型同步
  if (dom.queryPearBtn) dom.queryPearBtn.addEventListener('click', () => queryQuota('pear'));
  if (dom.queryGeekBtn) dom.queryGeekBtn.addEventListener('click', () => queryQuota('geek'));
  if (dom.syncVideoModelsBtn) dom.syncVideoModelsBtn.addEventListener('click', () => syncVideoModels({ silent: false }));

  // 字数
  dom.promptInput.addEventListener('input', () => { dom.charCount.textContent = dom.promptInput.value.length; });

  dom.modeSwitch.addEventListener('click', (e) => {
    const btn = e.target.closest('[data-mode]');
    if (!btn) return;
    if (btn.dataset.mode === 'video') setMode('video', { refs: getUploadedVideoRefItems(), source: 'uploads' });
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
    const f = Array.from(e.dataTransfer.files);
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
  dom.vdModel.addEventListener('change', () => {
    state.savedVideoModel = dom.vdModel.value;
    renderVideoSecondsOptions();
    saveState();
    updateReferenceText();
    renderVideoRefPreview();
    renderVideoModelInfo();
  });
  if (dom.vdSeconds) dom.vdSeconds.addEventListener('change', saveState);

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

// ======================= 文件处理 =======================
function getFileKind(file) {
  if (file.type.startsWith('image/')) return 'image';
  if (file.type.startsWith('video/')) return 'video';
  if (file.type.startsWith('audio/')) return 'audio';
  return 'file';
}

function getAcceptedKindsForCurrentMode() {
  return state.mode === 'video' ? ['image', 'video', 'audio'] : ['image'];
}

function getMaxUploadsForCurrentMode() {
  if (state.mode !== 'video') return 8;
  const meta = getVideoModelMeta();
  return Math.max(getModelMaxFiles(meta), 0) || 8;
}

function getKindCountLimit(kind) {
  if (state.mode !== 'video') return kind === 'image' ? 8 : 0;
  const meta = getVideoModelMeta();
  if (kind === 'image') return meta.maxImages || 0;
  if (kind === 'video') return meta.maxVideos || 0;
  if (kind === 'audio') return meta.maxAudios || 0;
  return 0;
}

function countUploadedKind(kind) {
  return state.uploadedImages.filter(item => item.kind === kind).length;
}

function filterAllowedFiles(files) {
  const allowedKinds = getAcceptedKindsForCurrentMode();
  const accepted = [];
  const skipped = [];
  for (const file of Array.from(files)) {
    const kind = getFileKind(file);
    const kindLimit = getKindCountLimit(kind);
    if (!allowedKinds.includes(kind) || (state.mode === 'video' && kindLimit <= 0)) {
      skipped.push(file.name);
      continue;
    }
    if (state.mode === 'video' && countUploadedKind(kind) + accepted.filter(f => getFileKind(f) === kind).length >= kindLimit) {
      skipped.push(file.name);
      continue;
    }
    accepted.push(file);
  }
  return { accepted, skipped };
}

function handleFiles(files) {
  const maxUploads = getMaxUploadsForCurrentMode();
  const remaining = maxUploads - state.uploadedImages.length;
  if (remaining <= 0) { showToast(`当前最多支持 ${maxUploads} 个参考文件`, 'warning'); return; }

  const { accepted, skipped } = filterAllowedFiles(files);
  const list = accepted.slice(0, remaining);
  if (skipped.length || list.length < accepted.length) showToast('部分文件超过当前模型限制，已自动跳过', 'warning');
  if (!list.length) return;

  list.forEach(file => {
    const kind = getFileKind(file);
    const item = {
      id: Date.now() + Math.random(),
      file,
      kind,
      fileName: file.name,
      previewUrl: URL.createObjectURL(file),
      imgbbUrl: null,
      uploading: kind === 'image',
      error: null,
    };
    state.uploadedImages.push(item);
    renderImagePreviews();

    if (kind === 'image') {
      uploadToImgbb(file)
        .then(url => { item.imgbbUrl = url; item.uploading = false; renderImagePreviews(); })
        .catch(err => {
          item.uploading = false;
          item.error = err.message;
          renderImagePreviews();
          showToast(state.mode === 'video' ? `${file.name} 图床上传失败，视频仍可用原文件` : `${file.name} 上传失败`, state.mode === 'video' ? 'warning' : 'error');
        });
    }
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
  dom.previewList.innerHTML = state.uploadedImages.map((item, i) => `
    <div class="img-preview-item ${item.uploading ? 'uploading' : ''} ${item.error ? 'error' : ''}">
      ${renderReferenceThumb(item)}
      <div class="img-info">
        <span class="img-name">${esc(item.fileName)}</span>
        <span class="img-label">${formatRefKind(item.kind)} ${i + 1}</span>
        ${item.uploading ? '<span class="img-status uploading-text">图床上传中，视频可直接用原文件</span>' : ''}
        ${item.error ? `<span class="img-status error-text">${esc(item.error)}</span>` : ''}
        ${item.kind === 'image' && item.imgbbUrl ? '<span class="img-status success-text">✓ 已上传 URL</span>' : ''}
        ${item.kind !== 'image' ? '<span class="img-status success-text">✓ 将作为原文件上传</span>' : ''}
      </div>
      <button class="img-remove-btn" data-id="${item.id}" title="移除"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><line x1="18" y1="6" x2="6" y2="18" /><line x1="6" y1="6" x2="18" y2="18" /></svg></button>
    </div>`).join('');
  syncVideoRefsFromUploads();
}

function renderReferenceThumb(item) {
  if (item.kind === 'image') return `<img src="${item.previewUrl}" alt="${esc(item.fileName)}" class="img-thumb" />`;
  const label = item.kind === 'video' ? 'VID' : (item.kind === 'audio' ? 'AUD' : 'FILE');
  return `<div class="file-thumb ${item.kind}"><span>${label}</span></div>`;
}

function formatRefKind(kind) {
  return { image: '图片', video: '视频', audio: '音频' }[kind] || '文件';
}

function getUploadedImageUrls() {
  return state.uploadedImages.filter(x => x.kind === 'image' && x.imgbbUrl && !x.uploading && !x.error).map(x => x.imgbbUrl);
}

function getUploadedVideoRefItems() {
  return state.uploadedImages
    .filter(x => (x.file || !x.error) && ['image', 'video', 'audio'].includes(x.kind))
    .map(x => ({
      source: 'upload',
      kind: x.kind,
      file: x.file,
      url: x.imgbbUrl,
      previewUrl: x.previewUrl,
      fileName: x.fileName,
    }));
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
  updateFileInputAccept();

  if (isVideo) {
    if (Object.prototype.hasOwnProperty.call(options, 'refs')) {
      state.videoRefItems = normalizeVideoRefs(options.refs);
      state.videoRefImageUrls = state.videoRefItems.map(ref => ref.url).filter(Boolean);
      state.videoRefSource = options.source || 'task';
    } else if (state.videoRefSource !== 'task') {
      state.videoRefItems = getUploadedVideoRefItems();
      state.videoRefImageUrls = state.videoRefItems.map(ref => ref.url).filter(Boolean);
      state.videoRefSource = 'uploads';
    }
    if (!dom.vdPrompt.value.trim() && state.videoRefItems.length) {
      dom.vdPrompt.value = '让@图1中的画面动起来';
    }
    renderVideoRefPreview();
  } else {
    state.videoRefSource = 'uploads';
  }

  updateReferenceText();
  renderVideoModelInfo();
}

function updateFileInputAccept() {
  if (!dom.fileInput) return;
  dom.fileInput.accept = state.mode === 'video' ? 'image/*,video/*,audio/*' : 'image/*';
}

function updateReferenceText() {
  if (state.mode === 'video') {
    const meta = getVideoModelMeta();
    dom.referenceTitle.textContent = '视频参考文件';
    dom.referenceSub.textContent = `(${formatVideoLimitLong(meta)}, 选填)`;
    dom.imageTip.textContent = '💡 视频提示词中可用 @图1、@视频1、@音频1 引用对应参考文件';
    if (dom.dropText) dom.dropText.innerHTML = '拖拽参考文件到此处，或 <span class="drop-link">点击上传</span>';
    if (dom.dropHint) dom.dropHint.textContent = '支持图片 / 视频 / 音频，按当前模型限制自动筛选';
  } else {
    dom.referenceTitle.textContent = '参考图片';
    dom.referenceSub.textContent = '(最多8张, 选填)';
    dom.imageTip.textContent = '💡 提示词中用"图片1""图片2"引用对应参考图';
    if (dom.dropText) dom.dropText.innerHTML = '拖拽图片到此处，或 <span class="drop-link">点击上传</span>';
    if (dom.dropHint) dom.dropHint.textContent = '支持 JPG / PNG / WebP';
  }
}

function syncVideoRefsFromUploads() {
  if (state.mode !== 'video' || state.videoRefSource === 'task') return;
  state.videoRefItems = getUploadedVideoRefItems();
  state.videoRefImageUrls = state.videoRefItems.map(ref => ref.url).filter(Boolean);
  renderVideoRefPreview();
}

// ======================= 视频生成 =======================
function normalizeVideoRefs(refs) {
  if (!refs) return [];
  const list = Array.isArray(refs) ? refs : [refs];
  return list.filter(Boolean).map((ref, index) => {
    if (typeof ref === 'string') {
      return { source: 'url', kind: 'image', url: ref, previewUrl: ref, fileName: `参考图${index + 1}` };
    }
    return {
      source: ref.source || 'upload',
      kind: ref.kind || 'image',
      file: ref.file || null,
      url: ref.url || ref.imgbbUrl || null,
      previewUrl: ref.previewUrl || ref.url || ref.imgbbUrl || '',
      fileName: ref.fileName || ref.name || `参考文件${index + 1}`,
    };
  });
}

function getLimitedVideoRefs() {
  const meta = getVideoModelMeta();
  const max = getModelMaxFiles(meta);
  if (max <= 0) return [];
  const counts = { image: 0, video: 0, audio: 0 };
  const limits = { image: meta.maxImages || 0, video: meta.maxVideos || 0, audio: meta.maxAudios || 0 };
  const refs = [];
  for (const ref of state.videoRefItems) {
    if (!limits[ref.kind] || counts[ref.kind] >= limits[ref.kind]) continue;
    refs.push(ref);
    counts[ref.kind] += 1;
  }
  return refs.slice(0, max);
}

function renderVideoRefPreview() {
  const refs = getLimitedVideoRefs();
  const total = state.videoRefItems.length;
  if (!refs.length) {
    dom.vdRef.style.display = 'none';
    dom.vdRefList.innerHTML = '';
    dom.vdRefLabel.textContent = '';
    return;
  }

  dom.vdRef.style.display = '';
  const kindIndex = { image: 0, video: 0, audio: 0 };
  dom.vdRefList.innerHTML = refs.map(ref => {
    kindIndex[ref.kind] = (kindIndex[ref.kind] || 0) + 1;
    const tag = ref.kind === 'image' ? `@图${kindIndex[ref.kind]}` : (ref.kind === 'video' ? `@视频${kindIndex[ref.kind]}` : `@音频${kindIndex[ref.kind]}`);
    const thumb = ref.kind === 'image' && (ref.previewUrl || ref.url)
      ? `<img src="${ref.previewUrl || ref.url}" alt="${esc(ref.fileName)}" />`
      : `<div class="file-thumb ${ref.kind}"><span>${ref.kind === 'video' ? 'VID' : 'AUD'}</span></div>`;
    return `<div class="vdialog-ref-item">${thumb}<span>${tag}</span></div>`;
  }).join('');

  const meta = getVideoModelMeta();
  const trimmed = total > refs.length ? `，已按模型限制取前 ${refs.length} 个` : '';
  dom.vdRefLabel.textContent = `参考文件 ${refs.length}/${getModelMaxFiles(meta)}${trimmed}`;
}

function openVideoDialog(imageRefs) {
  setMode('video', { refs: imageRefs, source: 'task' });
  dom.vdPrompt.value = state.videoRefItems.length ? '让@图1中的画面动起来' : dom.vdPrompt.value;
  document.getElementById('config-panel')?.scrollIntoView({ block: 'start', behavior: 'smooth' });
}

function getProviderApiKey(provider) {
  return provider === 'geek' ? dom.geekKeyInput.value.trim() : dom.pearKeyInput.value.trim();
}

function getProviderVideoEndpoint(meta) {
  const provider = VIDEO_PROVIDERS[meta.provider];
  const path = meta.endpointPath || state.videoEndpointPaths[meta.provider] || provider.defaultEndpointPath;
  return `${provider.baseUrl}${path}`;
}

function getSelectedSeconds() {
  const value = dom.vdSeconds && !dom.vdSeconds.disabled ? dom.vdSeconds.value : '';
  return value ? Number(value) : null;
}

function buildVideoRequest(meta, apiKey, prompt, refs) {
  const url = getProviderVideoEndpoint(meta);
  const seconds = getSelectedSeconds();
  const hasLocalFile = refs.some(ref => ref.file);
  const useMultipart = hasLocalFile || meta.requestMode === 'multipart';
  const headers = { Authorization: `Bearer ${apiKey}` };

  if (useMultipart) {
    const fd = new FormData();
    fd.append('model', meta.id);
    fd.append('prompt', prompt);
    fd.append('aspect_ratio', dom.vdRatio.value);
    if (seconds) fd.append('seconds', String(seconds));
    refs.forEach(ref => appendReferenceToFormData(fd, ref));
    return { url, options: { method: 'POST', headers, body: fd } };
  }

  const body = { model: meta.id, prompt, aspect_ratio: dom.vdRatio.value };
  if (seconds) body.seconds = seconds;
  appendReferenceUrlsToBody(body, refs, meta);
  return {
    url,
    options: { method: 'POST', headers: { ...headers, 'Content-Type': 'application/json' }, body: JSON.stringify(body) },
  };
}

function appendReferenceToFormData(fd, ref) {
  if (ref.file) fd.append('input_reference', ref.file, ref.file.name || ref.fileName || 'reference');
  else if (ref.url) fd.append('input_reference', ref.url);
}

function appendReferenceUrlsToBody(body, refs, meta) {
  const urls = refs.map(ref => ref.url).filter(Boolean);
  if (!urls.length) return;
  if (meta.requestMode === 'openai-video') {
    body.input_reference = urls.length === 1 ? urls[0] : urls;
    return;
  }
  if (urls.length === 1) body.first_image_url = urls[0];
  else if (urls.length === 2) { body.first_image_url = urls[0]; body.last_image_url = urls[1]; }
  else body.images = urls;
}

async function readJsonResponse(resp) {
  const text = await resp.text();
  let json = {};
  try { json = text ? JSON.parse(text) : {}; } catch { json = { raw: text }; }
  if (!resp.ok || json.error || (json.code && json.code !== 200)) {
    throw new Error(json.error?.message || json.msg || json.detail || json.message || `请求失败: ${resp.status}`);
  }
  return json;
}

function getVideoTaskData(json) {
  if (json.data && typeof json.data === 'object') return json.data;
  return json;
}

function getVideoTaskId(json) {
  const data = getVideoTaskData(json);
  return json.id || json.task_id || data.id || data.task_id || data.taskId || '';
}

function normalizeVideoStatus(status) {
  const s = String(status || '').toLowerCase();
  if (['completed', 'complete', 'succeeded', 'success', 'finished'].includes(s)) return 'completed';
  if (['failed', 'fail', 'error', 'cancelled', 'canceled'].includes(s)) return 'failed';
  if (['running', 'processing', 'in_progress', 'generating'].includes(s)) return 'running';
  return s || 'queued';
}

function getReferencePreviewUrls(refs) {
  return refs.filter(ref => ref.kind === 'image').map(ref => ref.url || ref.previewUrl).filter(Boolean);
}

function getReferenceFileSummary(refs) {
  return refs.map(ref => ({ kind: ref.kind, name: ref.fileName || ref.file?.name || ref.url || '参考文件' }));
}

async function submitVideoTask() {
  const prompt = dom.vdPrompt.value.trim();
  const meta = getVideoModelMeta();
  const apiKey = getProviderApiKey(meta.provider);
  const providerName = VIDEO_PROVIDERS[meta.provider]?.name || meta.provider;

  if (!apiKey) return showToast(`请输入 ${providerName} API Key`, 'error');
  if (!prompt) return showToast('请输入视频提示词', 'error');

  if (state.videoRefSource !== 'task') {
    state.videoRefItems = getUploadedVideoRefItems();
    state.videoRefImageUrls = state.videoRefItems.map(ref => ref.url).filter(Boolean);
  }
  const refs = getLimitedVideoRefs();
  if (state.videoRefItems.length && !refs.length) return showToast('当前模型不支持参考文件，请移除后再生成', 'warning');

  const request = buildVideoRequest(meta, apiKey, prompt, refs);
  setSubmitLoading(dom.vdSubmit, true, '生成中...');
  try {
    const resp = await fetch(request.url, request.options);
    const json = await readJsonResponse(resp);
    const data = getVideoTaskData(json);
    const taskId = getVideoTaskId(json);
    if (!taskId && !getVideoUrl(data)) throw new Error(json.msg || json.detail || JSON.stringify(json).slice(0, 200));

    const task = {
      type: 'video', id: Date.now(), taskId: taskId || `sync_video_${Date.now()}`,
      status: normalizeVideoStatus(data.status || json.status),
      progress: data.progress ?? json.progress ?? 0,
      provider: meta.provider,
      model: meta.id,
      prompt,
      videoUrl: getVideoUrl(data) || getVideoUrl(json),
      imageRef: getReferencePreviewUrls(refs)[0] || null,
      imageRefs: getReferencePreviewUrls(refs),
      referenceFiles: getReferenceFileSummary(refs),
      errorMsg: null,
      videoLength: getSelectedSeconds() || '',
      videoRatio: dom.vdRatio.value,
      endpointPath: meta.endpointPath,
      pollMode: meta.provider === 'pear' && meta.endpointPath === '/api/video_generate' ? 'legacy-pear' : 'openai-video',
      createdAt: now(),
      isGeek: meta.provider === 'geek',
    };
    if (task.videoUrl) { task.status = 'completed'; task.progress = 100; }
    if (!task.status || task.status === 'queued') task.status = task.videoUrl ? 'completed' : 'queued';

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

function buildVideoPollRequest(t, taskId) {
  const provider = t.provider || (t.isGeek ? 'geek' : 'pear');
  const apiKey = getProviderApiKey(provider);
  if (!apiKey) return null;

  if (provider === 'pear' && (t.pollMode === 'legacy-pear' || !t.provider)) {
    return {
      provider,
      url: VIDEO_API,
      options: { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ key: apiKey, taskid: taskId }) },
      contentUrl: null,
    };
  }

  const providerConfig = VIDEO_PROVIDERS[provider];
  const endpointPath = t.endpointPath || state.videoEndpointPaths[provider] || providerConfig.defaultEndpointPath;
  const base = `${providerConfig.baseUrl}${endpointPath}/${taskId}`;
  return {
    provider,
    url: base,
    options: { method: 'GET', headers: { Authorization: `Bearer ${apiKey}` } },
    contentUrl: `${base}/content`,
  };
}

function startVideoPolling(taskId) {
  if (state.pollers[taskId]) return;
  const poll = async () => {
    const t = state.tasks.find(x => x.taskId === taskId); if (!t) return stopPolling(taskId);
    const req = buildVideoPollRequest(t, taskId);
    if (!req) return;

    try {
      const r = await fetch(req.url, req.options);
      const j = await readJsonResponse(r);
      const data = getVideoTaskData(j);
      t.pollErrorCount = 0;
      t.status = normalizeVideoStatus(data.status || j.status || t.status);
      t.progress = data.progress ?? j.progress ?? t.progress;
      t.model = data.model || t.model;
      t.videoUrl = getVideoUrl(data) || getVideoUrl(j) || t.videoUrl;

      if (t.status === 'completed') {
        t.progress = 100;
        stopPolling(taskId);
        if (!t.videoUrl && req.contentUrl) t.videoUrl = req.contentUrl;
        if (!t.videoUrl) t.errorMsg = '视频已完成，但未返回视频地址';
        showToast(t.videoUrl ? '视频生成完成！' : '视频生成完成但未返回地址', t.videoUrl ? 'success' : 'warning');
      }
      if (t.status === 'failed') {
        t.errorMsg = data.error?.message || j.detail || j.msg || '视频任务失败';
        stopPolling(taskId);
        showToast(t.errorMsg, 'error');
      }
      saveState(); updateTaskCard(taskId);
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
    mediaHTML = `<div class="task-video-area"><video src="${t.videoUrl}#t=0.001" preload="metadata" class="task-video-thumb" muted data-action="play-video" data-url="${t.videoUrl}" title="点击播放"></video></div>`;
  } else if (!isVideo && t.imageUrls?.length) {
    mediaHTML = `<div class="task-thumb-area">${t.imageUrls.map((u, i) => `<img src="${u}" alt="图片${i+1}" class="task-thumb" data-action="preview-image" data-url="${u}" title="点击预览" />`).join('')}</div>`;
  }
  const refs = isVideo ? getTaskImageRefs(t) : [];
  const refFiles = isVideo && Array.isArray(t.referenceFiles) ? t.referenceFiles : [];
  if (refs.length) {
    mediaHTML = `
      <div class="task-ref-badge">
        ${refs.slice(0, 5).map((u, i) => `<img src="${u}" class="task-ref-mini" alt="参考图${i + 1}" />`).join('')}
        <span>参考图${refs.length > 1 ? ` × ${refs.length}` : ''}${refFiles.length > refs.length ? `，文件 × ${refFiles.length}` : ''}</span>
      </div>` + mediaHTML;
  } else if (refFiles.length) {
    mediaHTML = `
      <div class="task-ref-badge">
        <span>参考文件 × ${refFiles.length}</span>
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
  const models = ['gemini-omni', 'sora-2', 'veo-3.1-fast', 'grok-video-3', 'omni-fast', 'nano-banana-2'];
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
