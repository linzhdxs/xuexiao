// Cloudflare Worker - API 代理
// 部署方式：https://dash.cloudflare.com → Workers & Pages → 创建 → 粘贴此代码 → 部署

const TARGET = 'https://api.pearktrue.cn';

export default {
  async fetch(request) {
    // 处理预检请求
    if (request.method === 'OPTIONS') {
      return new Response(null, { status: 204, headers: corsHeaders() });
    }

    const url = new URL(request.url);
    const target = TARGET + url.pathname + url.search;

    const init = {
      method: request.method,
      headers: {
        'Content-Type': 'application/json',
        'User-Agent': 'VideoGenProxy/1.0',
      },
    };

    if (request.method === 'POST') {
      init.body = await request.text();
    }

    try {
      const resp = await fetch(target, init);
      const body = await resp.text();

      return new Response(body, {
        status: resp.status,
        headers: {
          ...corsHeaders(),
          'Content-Type': 'application/json',
        },
      });
    } catch (err) {
      return new Response(JSON.stringify({ code: 500, msg: err.message }), {
        status: 500,
        headers: { ...corsHeaders(), 'Content-Type': 'application/json' },
      });
    }
  },
};

function corsHeaders() {
  return {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Access-Control-Max-Age': '86400',
  };
}
