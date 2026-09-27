// جدول الحكم — static app + a small proxy to the Claude API for the coach
const http = require('http');
const fs = require('fs');
const path = require('path');

const PORT = process.env.PORT || 3000;
const API_KEY = process.env.ANTHROPIC_API_KEY;
const PASSCODE = process.env.APP_PASSCODE || '';
const MODEL = process.env.CLAUDE_MODEL || 'claude-sonnet-5';
const PUBLIC = path.join(__dirname, 'public');
const TYPES = { '.html':'text/html; charset=utf-8', '.js':'text/javascript', '.webmanifest':'application/manifest+json', '.json':'application/json', '.png':'image/png', '.jpg':'image/jpeg', '.svg':'image/svg+xml', '.ico':'image/x-icon' };

// simple per-IP rate limit: 30 coach calls / 10 minutes
const hits = new Map();
function limited(ip){ const now=Date.now(), w=10*60*1000; const a=(hits.get(ip)||[]).filter(t=>now-t<w); a.push(now); hits.set(ip,a); return a.length>30; }

function send(res, code, body, type='application/json'){ res.writeHead(code, {'Content-Type':type}); res.end(typeof body==='string'?body:JSON.stringify(body)); }

async function coach(req, res){
  if (PASSCODE && req.headers['x-passcode'] !== PASSCODE) return send(res, 401, {error:'passcode'});
  const ip = (req.headers['x-forwarded-for']||req.socket.remoteAddress||'').split(',')[0].trim();
  if (limited(ip)) return send(res, 429, {error:'rate'});
  if (!API_KEY) return send(res, 500, {error:'ANTHROPIC_API_KEY is not set'});
  let raw=''; for await (const c of req){ raw+=c; if (raw.length>400000) return send(res, 413, {error:'too large'}); }
  let messages; try { messages = JSON.parse(raw).messages; } catch { return send(res, 400, {error:'bad json'}); }
  if (!Array.isArray(messages) || !messages.length) return send(res, 400, {error:'no messages'});
  // merge consecutive same-role turns (the app may send two user turns in a row)
  const merged=[]; for (const m of messages){ const role=m.role==='assistant'?'assistant':'user', content=String(m.content||''); if (merged.length && merged[merged.length-1].role===role) merged[merged.length-1].content += '\n\n'+content; else merged.push({role,content}); }
  if (merged[0].role!=='user') merged.unshift({role:'user',content:'.'});
  try {
    const r = await fetch('https://api.anthropic.com/v1/messages', { method:'POST',
      headers:{'content-type':'application/json','x-api-key':API_KEY,'anthropic-version':'2023-06-01'},
      body: JSON.stringify({ model: MODEL, max_tokens: 2000, messages: merged }) });
    const d = await r.json();
    if (!r.ok) { console.error('Claude API error', r.status, d); return send(res, r.status===429?429:502, {error:'upstream'}); }
    const text = (d.content||[]).filter(b=>b.type==='text').map(b=>b.text).join('\n');
    send(res, 200, {text});
  } catch (e) { console.error(e); send(res, 502, {error:'network'}); }
}

http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://x');
  if (url.pathname === '/api/claude' && req.method === 'POST') return coach(req, res);
  if (url.pathname === '/healthz') return send(res, 200, 'ok', 'text/plain');
  let file = path.normalize(path.join(PUBLIC, decodeURIComponent(url.pathname)));
  if (!file.startsWith(PUBLIC)) return send(res, 403, 'forbidden', 'text/plain');
  if (url.pathname === '/' ) file = path.join(PUBLIC, 'index.html');
  fs.readFile(file, (err, data) => {
    if (err) { fs.readFile(path.join(PUBLIC,'index.html'), (e2, d2) => e2 ? send(res,404,'not found','text/plain') : send(res,200,d2,TYPES['.html'])); return; }
    const ext = path.extname(file);
    const cache = ext==='.html'||file.endsWith('sw.js') ? 'no-cache' : 'public, max-age=604800';
    res.writeHead(200, {'Content-Type': TYPES[ext]||'application/octet-stream', 'Cache-Control': cache}); res.end(data);
  });
}).listen(PORT, () => console.log('referee coach on :'+PORT));
