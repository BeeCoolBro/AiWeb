// api/proxy.js
// Vercel serverless function — handles all proxying

const https = require('https');
const http  = require('http');
const url   = require('url');
const zlib  = require('zlib');

// ── Helpers ───────────────────────────────────────────────────────────────────

function resolveUrl(base, relative) {
  if (!relative) return base;
  relative = relative.trim();
  if (/^https?:\/\//i.test(relative)) return relative;
  if (relative.startsWith('//')) return new URL(base).protocol + relative;
  try {
    return new URL(relative, base).href;
  } catch {
    return relative;
  }
}

function proxyUrl(targetUrl, base, selfBase) {
  if (!targetUrl) return targetUrl;
  targetUrl = targetUrl.trim();
  if (/^(javascript:|mailto:|tel:|data:|blob:|#)/i.test(targetUrl)) return targetUrl;
  try {
    const resolved = base ? resolveUrl(base, targetUrl) : targetUrl;
    if (!/^https?:\/\//i.test(resolved)) return targetUrl;
    return selfBase + '/proxy?url=' + encodeURIComponent(resolved);
  } catch {
    return targetUrl;
  }
}

// ── Rewrite HTML ──────────────────────────────────────────────────────────────

function rewriteHtml(html, baseUrl, selfBase) {
  const px = u => proxyUrl(u, baseUrl, selfBase);

  // Handle <base href>
  const baseMatch = html.match(/<base[^>]+href\s*=\s*["']([^"']+)["'][^>]*>/i);
  if (baseMatch) baseUrl = resolveUrl(baseUrl, baseMatch[1]);
  html = html.replace(/<base[^>]+>/gi, '');

  // Rewrite URL attributes
  const urlAttrs = ['href','src','action','data-src','data-href','data-url','data-lazy','data-original','poster','background'];
  for (const attr of urlAttrs) {
    html = html.replace(
      new RegExp(`(${attr})\\s*=\\s*(["\'])([^"\']+)\\2`, 'gi'),
      (match, a, q, u) => {
        if (/^(javascript:|mailto:|tel:|data:|blob:|#)/i.test(u)) return match;
        return `${a}=${q}${px(u)}${q}`;
      }
    );
  }

  // Rewrite srcset
  html = html.replace(/srcset\s*=\s*(["'])([^"']+)\1/gi, (match, q, val) => {
    const parts = val.split(',').map(part => {
      part = part.trim();
      const pieces = part.split(/\s+/);
      if (pieces[0] && !/^(data:|blob:)/i.test(pieces[0])) pieces[0] = px(pieces[0]);
      return pieces.join(' ');
    });
    return `srcset=${q}${parts.join(', ')}${q}`;
  });

  // Rewrite inline <style>
  html = html.replace(/<style([^>]*)>([\s\S]*?)<\/style>/gi, (match, attrs, css) => {
    return `<style${attrs}>${rewriteCss(css, baseUrl, selfBase)}</style>`;
  });

  // Rewrite inline style="" attributes
  html = html.replace(/style\s*=\s*(["'])([^"']+)\1/gi, (match, q, css) => {
    const rewritten = css.replace(/url\(\s*["']?([^"')]+)["']?\s*\)/gi,
      (m, u) => `url(${px(u)})`);
    return `style=${q}${rewritten}${q}`;
  });

  // Rewrite inline <script> blocks
  html = html.replace(/<script([^>]*)>([\s\S]*?)<\/script>/gi, (match, attrs, code) => {
    if (/type\s*=\s*["'](?!text\/javascript|application\/javascript|module)[^"']+["']/i.test(attrs)) return match;
    return `<script${attrs}>${rewriteJs(code, baseUrl, selfBase)}</script>`;
  });

  // Inject JS shim
  const shim = buildShim(baseUrl, selfBase);
  if (/<head/i.test(html)) {
    html = html.replace(/(<head[^>]*>)/i, `$1${shim}`);
  } else {
    html = shim + html;
  }

  // Inject navbar
  const navbar = buildNavbar(baseUrl, selfBase);
  if (/<body/i.test(html)) {
    html = html.replace(/(<body[^>]*>)/i, `$1${navbar}`);
  } else {
    html = navbar + html;
  }

  return html;
}

// ── Rewrite CSS ───────────────────────────────────────────────────────────────

function rewriteCss(css, baseUrl, selfBase) {
  const px = u => proxyUrl(u, baseUrl, selfBase);
  css = css.replace(/url\(\s*["']?([^"')]+)["']?\s*\)/gi, (m, u) => {
    if (/^(data:|blob:)/i.test(u)) return m;
    return `url(${px(u)})`;
  });
  css = css.replace(/@import\s+["']([^"']+)["']/gi, (m, u) => `@import "${px(u)}"`);
  return css;
}

// ── Rewrite JS ────────────────────────────────────────────────────────────────

function rewriteJs(js, baseUrl, selfBase) {
  return js.replace(/(['"])(https?:\/\/[^"'<>\s]{4,})\1/gi, (match, q, u) => {
    if (u.includes('fonts.googleapis') || u.includes('fonts.gstatic') ||
        u.endsWith('.woff2') || u.endsWith('.woff')) return match;
    return q + proxyUrl(u, baseUrl, selfBase) + q;
  });
}

// ── JS shim injected into every page ─────────────────────────────────────────

function buildShim(baseUrl, selfBase) {
  return `<script>
(function(){
  var PROXY=${JSON.stringify(selfBase+'/proxy')};
  var BASE=${JSON.stringify(baseUrl)};
  function wp(u){
    if(!u) return u;
    u=String(u);
    if(/^(blob:|data:|javascript:|mailto:|tel:|#)/.test(u)) return u;
    try{
      var abs=new URL(u,BASE).href;
      if(abs.startsWith(location.origin) && abs.includes('/proxy')) return u;
      if(abs.startsWith(location.origin)) return u;
      return PROXY+'?url='+encodeURIComponent(abs);
    }catch(e){return u;}
  }
  var _fetch=window.fetch;
  window.fetch=function(input,init){
    try{
      if(typeof input==='string') input=wp(input);
      else if(input&&input.url) input=new Request(wp(input.url),input);
    }catch(e){}
    return _fetch.call(this,input,init);
  };
  var _open=XMLHttpRequest.prototype.open;
  XMLHttpRequest.prototype.open=function(m,u){
    try{arguments[1]=wp(u);}catch(e){}
    return _open.apply(this,arguments);
  };
  try{
    window.location.assign=function(u){location.href=wp(u);};
    window.location.replace=function(u){location.replace(wp(u));};
  }catch(e){}
  document.addEventListener('DOMContentLoaded',function(){
    document.querySelectorAll('form').forEach(function(f){
      var a=f.getAttribute('action');
      if(a&&!/^(javascript:|#)/.test(a)) f.setAttribute('action',wp(a));
    });
    document.querySelectorAll('a[href]').forEach(function(a){
      var h=a.getAttribute('href');
      if(h&&/^https?:\\/\\//i.test(h)&&!h.includes(location.hostname))
        a.setAttribute('href',wp(h));
    });
  });
})();
</script>`;
}

// ── Floating nav bar ──────────────────────────────────────────────────────────

function buildNavbar(baseUrl, selfBase) {
  const escaped = baseUrl.replace(/"/g, '&quot;');
  return `<div id="__pxbar" style="position:fixed;top:0;left:0;right:0;z-index:2147483647;background:#0d0d0f;border-bottom:1px solid #2a2a30;padding:8px 14px;display:flex;align-items:center;gap:10px;font-family:'JetBrains Mono',monospace;font-size:12px;box-shadow:0 2px 20px rgba(0,0,0,.5);">
  <a href="${selfBase}" style="color:#00f5a0;text-decoration:none;font-weight:700;font-size:15px;flex-shrink:0">⬡</a>
  <input id="__pxinput" value="${escaped}" style="flex:1;min-width:0;background:#141417;border:1px solid #2a2a30;border-radius:8px;color:#e8e8f0;padding:5px 10px;font-family:inherit;font-size:12px;outline:none;" autocomplete="off"/>
  <button onclick="(function(){var v=document.getElementById('__pxinput').value.trim();if(!v)return;if(!/^https?:\\/\\//i.test(v))v='https://'+v;location.href='${selfBase}/proxy?url='+encodeURIComponent(v);})()" style="background:linear-gradient(135deg,#00f5a0,#00b4d8);border:none;border-radius:8px;color:#000;cursor:pointer;font-weight:700;padding:5px 14px;font-size:12px;white-space:nowrap;flex-shrink:0;">Go</button>
</div>
<div style="height:44px"></div>`;
}

// ── Fetch remote URL ──────────────────────────────────────────────────────────

function fetchUrl(targetUrl, method, body) {
  return new Promise((resolve, reject) => {
    const parsed  = new URL(targetUrl);
    const isHttps = parsed.protocol === 'https:';
    const lib     = isHttps ? https : http;

    const opts = {
      hostname: parsed.hostname,
      port:     parsed.port || (isHttps ? 443 : 80),
      path:     parsed.pathname + parsed.search,
      method:   method || 'GET',
      headers: {
        'User-Agent':      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36',
        'Accept':          'text/html,application/xhtml+xml,application/xml;q=0.9,image/webp,*/*;q=0.8',
        'Accept-Language': 'en-US,en;q=0.9',
        'Accept-Encoding': 'gzip, deflate, br',
        'Connection':      'close',
      },
      rejectUnauthorized: false,
    };

    if (body) {
      opts.headers['Content-Type']   = 'application/x-www-form-urlencoded';
      opts.headers['Content-Length'] = Buffer.byteLength(body);
    }

    const req = lib.request(opts, (res) => {
      // Handle redirects
      if ([301,302,303,307,308].includes(res.statusCode) && res.headers.location) {
        const next = resolveUrl(targetUrl, res.headers.location);
        return fetchUrl(next, 'GET').then(resolve).catch(reject);
      }

      const chunks = [];
      res.on('data', chunk => chunks.push(chunk));
      res.on('end', () => {
        const raw = Buffer.concat(chunks);
        const enc = res.headers['content-encoding'];
        const decompress = enc === 'gzip'   ? zlib.gunzip
                         : enc === 'deflate' ? zlib.inflate
                         : enc === 'br'      ? zlib.brotliDecompress
                         : null;

        if (decompress) {
          decompress(raw, (err, buf) => {
            if (err) return resolve({ body: raw.toString(), headers: res.headers, status: res.statusCode });
            resolve({ body: buf.toString('utf8'), headers: res.headers, status: res.statusCode });
          });
        } else {
          resolve({ body: raw.toString('utf8'), headers: res.headers, status: res.statusCode });
        }
      });
    });

    req.on('error', reject);
    req.setTimeout(20000, () => { req.destroy(); reject(new Error('Timeout')); });
    if (body) req.write(body);
    req.end();
  });
}

// ── Main handler ──────────────────────────────────────────────────────────────

module.exports = async (req, res) => {
  const parsed    = url.parse(req.url, true);
  const targetUrl = (parsed.query.url || '').trim();
  const selfBase  = `https://${req.headers.host}`;

  if (!targetUrl) {
    res.writeHead(302, { Location: '/' });
    return res.end();
  }

  const fullUrl = /^https?:\/\//i.test(targetUrl) ? targetUrl : 'https://' + targetUrl;

  let body = '';
  if (req.method === 'POST') {
    await new Promise(r => {
      req.on('data', c => body += c);
      req.on('end', r);
    });
  }

  try {
    const result = await fetchUrl(fullUrl, req.method, body || null);
    const ct     = (result.headers['content-type'] || '').toLowerCase();
    const isHtml = ct.includes('html');
    const isCss  = ct.includes('css');
    const isJs   = ct.includes('javascript') || ct.includes('ecmascript');
    const isText = isHtml || isCss || isJs || ct.includes('json') || ct.includes('text');

    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('X-Frame-Options', '');

    if (!isText) {
      // Binary — pass straight through
      res.setHeader('Content-Type', result.headers['content-type'] || 'application/octet-stream');
      res.setHeader('Cache-Control', 'public, max-age=86400');
      res.writeHead(result.status);
      return res.end(result.body);
    }

    if (isCss) {
      res.setHeader('Content-Type', 'text/css; charset=utf-8');
      res.writeHead(result.status);
      return res.end(rewriteCss(result.body, fullUrl, selfBase));
    }

    if (isJs) {
      res.setHeader('Content-Type', 'application/javascript; charset=utf-8');
      res.writeHead(result.status);
      return res.end(rewriteJs(result.body, fullUrl, selfBase));
    }

    // HTML
    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    res.writeHead(result.status);
    return res.end(rewriteHtml(result.body, fullUrl, selfBase));

  } catch (err) {
    res.writeHead(500, { 'Content-Type': 'text/html' });
    res.end(`<h2 style="font-family:monospace;padding:40px;color:#ff4d6d">
      ⚠ Proxy error: ${err.message}<br/><br/>
      <a href="/" style="color:#00f5a0">← Go back</a>
    </h2>`);
  }
};
