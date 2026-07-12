// Cloudflare Worker - Seedance video API facade
// Required secrets/env vars:
// - SEEDANCE_BASE_URL: upstream API origin, for example from the integration document
// - SEEDANCE_API_KEY: upstream API key
// Optional env vars:
// - SEEDANCE_MODEL, SEEDANCE_GENERATE_PATH, SEEDANCE_STATUS_PATH_TEMPLATE
// - SEEDANCE_CONTENT_PATH_TEMPLATE, SEEDANCE_AUTH_HEADER, ALLOWED_ORIGIN

const DEFAULT_MODEL = 'seedance-2.0';
const DEFAULT_GENERATE_PATH = '/v1/videos/generations';
const DEFAULT_STATUS_TEMPLATE = '/v1/videos/generations/{id}';
const DEFAULT_DURATION_FIELD = 'duration';
const DEFAULT_RATIO_FIELD = 'aspect_ratio';
const MAX_PROMPT_LENGTH = 2000;
const MAX_BODY_BYTES = 32 * 1024;
const RATE_LIMIT_WINDOW_MS = 60 * 1000;
const RATE_LIMIT_MAX = 30;
const ALLOWED_RATIOS = new Set(['16:9', '9:16', '1:1', '4:3', '3:4']);
const ALLOWED_SECONDS = new Set([5, 10]);
const rateBuckets = new Map();

export default {
  async fetch(request, env) {
    const cors = buildCorsHeaders(request, env);
    if (!cors) return jsonResponse({ error: 'Origin is not allowed' }, 403, {});

    if (request.method === 'OPTIONS') {
      return new Response(null, { status: 204, headers: cors });
    }

    try {
      const url = new URL(request.url);
      const path = url.pathname.replace(/\/+$/, '') || '/';

      if (path === '/api/video/health' && request.method === 'GET') {
        return jsonResponse({ ok: true, model: getSeedanceModel(env) }, 200, cors);
      }

      if (!path.startsWith('/api/video')) {
        return jsonResponse({ error: 'Not found' }, 404, cors);
      }

      assertRateLimit(request);

      if (path === '/api/video/create' && request.method === 'POST') {
        return await handleCreate(request, env, cors);
      }

      if (path === '/api/video/status' && request.method === 'POST') {
        return await handleStatus(request, env, cors);
      }

      if (path === '/api/video/content' && request.method === 'GET') {
        return await handleContent(url, env, cors);
      }

      return jsonResponse({ error: 'Not found' }, 404, cors);
    } catch (error) {
      const status = Number(error.status) || 500;
      const message = status >= 500 ? 'Video service is temporarily unavailable' : error.message;
      return jsonResponse({ error: message }, status, cors);
    }
  },
};

async function handleCreate(request, env, cors) {
  const input = await readJson(request);
  const prompt = cleanPrompt(input.prompt);
  const aspectRatio = cleanAspectRatio(input.aspectRatio || input.aspect_ratio);
  const seconds = cleanSeconds(input.seconds || input.duration);
  const upstreamBody = buildCreatePayload(env, { prompt, aspectRatio, seconds });

  const upstream = await seedanceFetch(env, getGeneratePath(env), {
    method: 'POST',
    body: JSON.stringify(upstreamBody),
  });

  const task = normalizeTask(upstream.payload, env);
  return jsonResponse({ ok: true, data: task }, 200, cors);
}

async function handleStatus(request, env, cors) {
  const input = await readJson(request);
  const taskId = cleanTaskId(input.taskId || input.id);
  const statusPath = templatePath(env.SEEDANCE_STATUS_PATH_TEMPLATE || DEFAULT_STATUS_TEMPLATE, taskId);

  const upstream = await seedanceFetch(env, statusPath, { method: 'GET' });
  const task = normalizeTask(upstream.payload, env, taskId);
  return jsonResponse({ ok: true, data: task }, 200, cors);
}

async function handleContent(url, env, cors) {
  const template = env.SEEDANCE_CONTENT_PATH_TEMPLATE;
  if (!template) throw httpError(404, 'Content proxy is not configured');

  const taskId = cleanTaskId(url.searchParams.get('taskId'));
  const contentPath = templatePath(template, taskId);
  const upstream = await seedanceFetch(env, contentPath, { method: 'GET', raw: true });

  const headers = new Headers(cors);
  const contentType = upstream.response.headers.get('Content-Type') || 'video/mp4';
  headers.set('Content-Type', contentType);
  headers.set('Cache-Control', 'private, max-age=300');
  return new Response(upstream.response.body, { status: upstream.response.status, headers });
}

function buildCreatePayload(env, input) {
  const ratioField = env.SEEDANCE_RATIO_FIELD || DEFAULT_RATIO_FIELD;
  const durationField = env.SEEDANCE_DURATION_FIELD || DEFAULT_DURATION_FIELD;
  const payload = {
    model: getSeedanceModel(env),
    prompt: input.prompt,
  };
  payload[ratioField] = input.aspectRatio;
  payload[durationField] = input.seconds;
  return payload;
}

async function seedanceFetch(env, path, init) {
  const baseUrl = normalizeBaseUrl(env.SEEDANCE_BASE_URL);
  const apiKey = String(env.SEEDANCE_API_KEY || '').trim();
  if (!baseUrl || !apiKey) throw httpError(500, 'Seedance service is not configured');

  const headers = new Headers(init.headers || {});
  headers.set('Accept', 'application/json');
  if (!init.raw) headers.set('Content-Type', 'application/json');
  applyAuthHeader(headers, apiKey, env.SEEDANCE_AUTH_HEADER);

  const response = await fetch(baseUrl + path, {
    method: init.method,
    headers,
    body: init.body,
  });

  if (init.raw) {
    if (!response.ok) throw httpError(response.status, 'Video content is not ready');
    return { response, payload: null };
  }

  const text = await response.text();
  const payload = parseJson(text);
  if (!response.ok || payload?.error || payload?.code >= 400) {
    throw httpError(response.status || 502, extractUpstreamMessage(payload));
  }
  return { response, payload };
}

function applyAuthHeader(headers, apiKey, configuredHeader) {
  const header = String(configuredHeader || 'Authorization').trim();
  if (header.toLowerCase() === 'x-api-key') {
    headers.set('x-api-key', apiKey);
    return;
  }
  headers.set(header, header.toLowerCase() === 'authorization' ? `Bearer ${apiKey}` : apiKey);
}

function normalizeTask(payload, env, fallbackId = '') {
  const data = firstObject(payload?.data, payload?.output, payload?.result, payload);
  const nested = firstObject(data?.data, data?.output, data?.result, data);
  const taskId = String(
    payload?.id || payload?.task_id || payload?.taskId ||
    data?.id || data?.task_id || data?.taskId ||
    nested?.id || nested?.task_id || nested?.taskId || fallbackId || ''
  );
  const status = normalizeStatus(
    payload?.status || data?.status || data?.state || nested?.status || nested?.state
  );
  const videoUrl = findVideoUrl(payload) || findVideoUrl(data) || findVideoUrl(nested) || '';
  const progress = clampProgress(payload?.progress ?? data?.progress ?? nested?.progress ?? (status === 'completed' ? 100 : 0));

  return {
    taskId,
    status,
    progress,
    videoUrl,
    model: String(data?.model || payload?.model || getSeedanceModel(env)),
  };
}

function findVideoUrl(value) {
  if (!value || typeof value !== 'object') return '';
  const candidates = [
    value.video_url,
    value.videoUrl,
    value.url,
    value.file_url,
    value.output_url,
    value.content_url,
    value?.video?.url,
    value?.content?.url,
    value?.output?.video_url,
    value?.output?.url,
    value?.result?.video_url,
    value?.result?.url,
  ];
  const direct = candidates.find(item => typeof item === 'string' && item.trim());
  if (direct) return direct;
  if (Array.isArray(value.videos)) return findVideoUrl(value.videos[0]);
  if (Array.isArray(value.files)) return findVideoUrl(value.files[0]);
  return '';
}

function normalizeStatus(status) {
  const value = String(status || '').toLowerCase();
  if (['completed', 'complete', 'succeeded', 'success', 'finished', 'done'].includes(value)) return 'completed';
  if (['failed', 'fail', 'error', 'cancelled', 'canceled'].includes(value)) return 'failed';
  if (['running', 'processing', 'in_progress', 'generating'].includes(value)) return 'running';
  return value || 'queued';
}

function cleanPrompt(prompt) {
  const value = String(prompt || '').trim();
  if (!value) throw httpError(400, 'Prompt is required');
  if (value.length > MAX_PROMPT_LENGTH) throw httpError(400, `Prompt must be ${MAX_PROMPT_LENGTH} characters or fewer`);
  return value;
}

function cleanAspectRatio(aspectRatio) {
  const value = String(aspectRatio || '16:9').trim();
  if (!ALLOWED_RATIOS.has(value)) throw httpError(400, 'Aspect ratio is not supported');
  return value;
}

function cleanSeconds(seconds) {
  const value = Number(seconds || 5);
  if (!ALLOWED_SECONDS.has(value)) throw httpError(400, 'Duration is not supported');
  return value;
}

function cleanTaskId(taskId) {
  const value = String(taskId || '').trim();
  if (!/^[A-Za-z0-9._:-]{1,160}$/.test(value)) throw httpError(400, 'Task id is invalid');
  return value;
}

async function readJson(request) {
  const length = Number(request.headers.get('Content-Length') || 0);
  if (length > MAX_BODY_BYTES) throw httpError(413, 'Request is too large');
  const text = await request.text();
  if (text.length > MAX_BODY_BYTES) throw httpError(413, 'Request is too large');
  try {
    return text ? JSON.parse(text) : {};
  } catch {
    throw httpError(400, 'Request body must be JSON');
  }
}

function assertRateLimit(request) {
  const ip = request.headers.get('CF-Connecting-IP') || request.headers.get('X-Forwarded-For') || 'anonymous';
  const now = Date.now();
  const bucket = rateBuckets.get(ip) || { resetAt: now + RATE_LIMIT_WINDOW_MS, count: 0 };
  if (bucket.resetAt <= now) {
    bucket.resetAt = now + RATE_LIMIT_WINDOW_MS;
    bucket.count = 0;
  }
  bucket.count += 1;
  rateBuckets.set(ip, bucket);
  if (bucket.count > RATE_LIMIT_MAX) throw httpError(429, 'Too many requests');
}

function buildCorsHeaders(request, env) {
  const origin = request.headers.get('Origin') || '';
  const allowed = String(env.ALLOWED_ORIGIN || '')
    .split(',')
    .map(item => item.trim())
    .filter(Boolean);

  if (origin && allowed.length && !allowed.includes(origin)) return null;

  const headers = {
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Access-Control-Max-Age': '86400',
    'Vary': 'Origin',
  };
  if (origin && allowed.includes(origin)) headers['Access-Control-Allow-Origin'] = origin;
  return headers;
}

function getSeedanceModel(env) {
  return String(env.SEEDANCE_MODEL || DEFAULT_MODEL).trim();
}

function getGeneratePath(env) {
  return normalizePath(env.SEEDANCE_GENERATE_PATH || DEFAULT_GENERATE_PATH);
}

function templatePath(template, taskId) {
  return normalizePath(String(template).replace('{id}', encodeURIComponent(taskId)).replace('{taskId}', encodeURIComponent(taskId)));
}

function normalizePath(path) {
  const value = String(path || '').trim();
  if (!value.startsWith('/')) return `/${value}`;
  return value;
}

function normalizeBaseUrl(baseUrl) {
  const value = String(baseUrl || '').trim();
  if (!/^https:\/\//i.test(value)) return '';
  return value.replace(/\/+$/, '');
}

function parseJson(text) {
  try {
    return text ? JSON.parse(text) : {};
  } catch {
    return { raw: text };
  }
}

function firstObject(...items) {
  return items.find(item => item && typeof item === 'object' && !Array.isArray(item)) || {};
}

function clampProgress(progress) {
  const value = Number(progress);
  if (!Number.isFinite(value)) return 0;
  return Math.max(0, Math.min(100, value));
}

function extractUpstreamMessage(payload) {
  const message = payload?.error?.message || payload?.message || payload?.msg || payload?.detail || 'Seedance request failed';
  return sanitizePublicMessage(message);
}

function sanitizePublicMessage(message) {
  return String(message)
    .replace(/https?:\/\/\S+/gi, '[upstream]')
    .replace(/Bearer\s+[A-Za-z0-9._~+\/-]+/gi, 'Bearer [redacted]')
    .slice(0, 240);
}

function httpError(status, message) {
  const error = new Error(message);
  error.status = status;
  return error;
}

function jsonResponse(payload, status, cors) {
  return new Response(JSON.stringify(payload), {
    status,
    headers: {
      ...cors,
      'Content-Type': 'application/json; charset=utf-8',
      'Cache-Control': 'no-store',
    },
  });
}
