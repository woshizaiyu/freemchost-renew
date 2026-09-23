#!/usr/bin/env node
/* eslint-disable no-useless-escape */
/**
 * ============================================================================
 *  FreeMCHost (https://freemchost.com) 免费 Minecraft 服务器自动续期
 * ----------------------------------------------------------------------------
 *  技术栈 : Node.js 18+ / Playwright (Chromium) / GitHub Actions
 *  参考   : wittyconan/freemchost-renew (kingwgb) 弹窗清理 + 时间提取 + 事件穿透
 *           AgentScribe 真实录制（Manage 菜单 → Renew now → 60 小时 → _serverFn POST）
 *  主路线 : 浏览器 UI 自动化（前端构建哈希 /_serverFn/<hash> 会随版本变化，故不做纯 API 主链路；
 *           本脚本会嗅探并打印真实的 _serverFn 端点与载荷，便于后续升级纯 API 模式）
 *
 *  必填环境变量:
 *    FREE_EMAIL / FREE_PASSWORD          账号密码登录（或二选一提供 AUTH_STATE）
 *    SERVER_PAGE_URL                     服务器页面地址，多个用换行/逗号分隔
 *  可选环境变量:
 *    AUTH_STATE / AUTH_STATE_FILE        Playwright storageState JSON（登录态直达，前端会自动刷新 Supabase token）
 *    GH_TOKEN + AUTO_UPDATE_STATE=true   登录成功后把最新 storageState 回写到 Actions Secret: AUTH_STATE
 *    SERVER_ID                           只填服务器 ID（可多个），自动拼 https://freemchost.com/app/servers/<ID>
 *    PROXY_URL                           http://127.0.0.1:1080 或 socks5://user:pass@ip:port
 *    TG_BOT_TOKEN / TG_CHAT_ID           Telegram 通知
 *    RENEW_THRESHOLD_HOURS               剩余时长低于该值才续期（默认 46）
 *    RENEW_DURATION_LABEL                续期时长文案（默认 "60 hours"，可逗号分隔多个候选）
 *    VERIFY_MIN_HOURS                    入库验真最小增量小时（默认 20）
 *    DRY_RUN / HEADLESS / TIMEZONE / LOCALE / BROWSER_CHANNEL / NAV_TIMEOUT
 * ============================================================================
 */

'use strict';

const fs = require('fs');
const path = require('path');
const https = require('https');
const { chromium } = require('playwright');

/* ============================== 配置区 ============================== */

const env = (k, d = '') => (process.env[k] === undefined ? d : String(process.env[k])).trim() || d;
const bool = (k, d = false) => {
  const v = env(k).toLowerCase();
  if (!v) return d;
  return ['1', 'true', 'yes', 'y', 'on'].includes(v);
};
const num = (k, d) => {
  const v = parseFloat(env(k));
  return Number.isFinite(v) ? v : d;
};

const CFG = {
  loginUrl: env('LOGIN_URL', 'https://freemchost.com/login'),
  serverBase: env('SERVER_BASE', 'https://freemchost.com/app/servers/'),
  email: env('FREE_EMAIL'),
  password: env('FREE_PASSWORD'),
  authStateRaw: env('AUTH_STATE'),
  authStateFile: env('AUTH_STATE_FILE'),
  ghToken: env('GH_TOKEN'),
  autoUpdateState: bool('AUTO_UPDATE_STATE', false),
  repo: env('GITHUB_REPOSITORY'),
  tgToken: env('TG_BOT_TOKEN'),
  tgChatId: env('TG_CHAT_ID'),
  proxyUrl: env('PROXY_URL'),
  thresholdHours: num('RENEW_THRESHOLD_HOURS', 46),
  verifyMinHours: num('VERIFY_MIN_HOURS', 20),
  durationLabels: (env('RENEW_DURATION_LABEL', '60 hours') + ',60h,60 小时,3 days,3 天')
    .split(/[,|\n]/).map((s) => s.trim()).filter(Boolean),
  headless: bool('HEADLESS', true),
  dryRun: bool('DRY_RUN', false),
  apiDirect: env('API_DIRECT', 'check'), // check = 先直调查续期资格再走浏览器; off = 纯浏览器
  serverFnHash: env('SERVERFN_HASH'), // 为空用录制hash；漂移时手动覆盖
  serverFnF: num('SERVERFN_F', 63), // 续期意图函数号(录制值63,随构建漂移;直调失败时改这里或置空回退)
  timezone: env('TIMEZONE', 'Asia/Shanghai'),
  locale: env('LOCALE', 'en-US'),
  channel: env('BROWSER_CHANNEL'),
  navTimeout: num('NAV_TIMEOUT', 90000),
  shotDir: env('SHOT_DIR', 'screenshots'),
  ua: env('USER_AGENT',
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36'),
};

/* 受保护的关键词：清理弹窗时绝不删除包含这些内容的容器（防止误伤续期面板） */
const PROTECT_WORDS = ['Keep your server online', 'Renew', 'Time Until Expiry', 'TIME UNTIL EXPIRY', 'Billing'];
/* 干扰弹窗特征：评分 / 反馈 / 建议 / 社区 / 升级推销 */
const NOISE_WORDS = [
  'How would you rate', 'Your feedback', 'Got an idea to make', 'Help us improve',
  'Join the FreeMCHost community', 'Get Free+', 'Upgrade to Free+', 'Share on Discord',
  'How was your experience', 'Tell us what you think',
];

/* ============================== 小工具 ============================== */

const nowStr = () => new Date().toLocaleString('zh-CN', { hour12: false });
const log = (...a) => console.log(`[${nowStr()}]`, ...a);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function maskUrl(u) {
  return String(u || '').replace(/(code=|token=|access_token=)[^&]+/gi, '$1***');
}

/** TCP 探测 host:port 是否可连（代理存活校验），ms 超时 */
function tcpProbe(host, port, ms = 5000) {
  return new Promise((resolve) => {
    const net = require('net');
    const s = new net.Socket();
    let done = false;
    const fin = (ok) => { if (!done) { done = true; s.destroy(); resolve(ok); } };
    s.setTimeout(ms);
    s.once('connect', () => fin(true));
    s.once('timeout', () => fin(false));
    s.once('error', () => fin(false));
    s.connect(port, host);
  });
}

/** 解析 PROXY_URL 为 {host,port}，非法返回 null */
function parseProxyHostPort(p) {
  try {
    const u = new URL(p);
    if (!u.hostname || !u.port) return null;
    return { host: u.hostname, port: Number(u.port) };
  } catch { return null; }
}

/** page.goto 带重试：ERR_CONNECTION_RESET 等网络抖动退避重试 */
async function gotoRetry(page, url, opts = {}, retries = 3) {
  let last;
  for (let i = 1; i <= retries; i++) {
    try { return await page.goto(url, opts); } catch (e) {
      last = e;
      log(`⚠️ 导航失败(${i}/${retries}): ${String(e.message).split('\n')[0].slice(0, 120)}`);
      if (i < retries) await sleep(3000 * i);
    }
  }
  throw last;
}

/** 解析目标服务器列表：完整 URL 或裸 ID */
function parseTargets() {
  const raw = [env('SERVER_PAGE_URL'), env('SERVER_ID')].filter(Boolean).join('\n');
  const out = [];
  for (const line of raw.split(/[\r\n,;]+/)) {
    const t = line.trim();
    if (!t) continue;
    if (/^https?:\/\//i.test(t)) out.push(t);
    else if (/^[0-9a-zA-Z_-]{4,}$/.test(t)) out.push(CFG.serverBase + t);
  }
  return [...new Set(out)];
}

function serverIdOf(url) {
  const m = String(url).match(/servers?\/([0-9a-zA-Z-]+)/);
  return m ? m[1] : (String(url).split('/').pop() || 'unknown');
}

/* ============================== API 直调预检 ==============================
 * 录制证据(session 17820de0)：POST /_serverFn/<hash> {f:63, m:[], t:{...id...}}
 * 回包result含 window_hours / renewable / remaining_ms。
 * 仅做资格预检(剩时>阈值则跳过浏览器)；真正续期确认仍走浏览器UI，
 * 因 _serverFn hash 随前端构建漂移，直调确认易失效。
 * ponytail: 全API续期(直调确认)在hash+f长期稳定时再做，需解析回包token+min_dwell_ms语义。
 */
const RECORDED_POST_HASH = '8a85876cf1da47edc9a524dcba6145449f36592433445062fd5cb967b0bc9453';

/** 从 storageState 中提取 Supabase access_token（未登录/过期返回 null） */
function accessTokenFromState(state) {
  try {
    for (const o of state.origins || []) {
      for (const kv of o.localStorage || []) {
        if (!/^sb-.*-auth-token$/.test(kv.name)) continue;
        const j = JSON.parse(kv.value);
        if (j && j.access_token && j.expires_at * 1000 > Date.now() + 60000) return j.access_token;
      }
    }
  } catch { /* ignore */ }
  return null;
}

/** 在 TanStack framed 响应里按 key 名取并行 v 数组的值 */
function framedValue(obj, key) {
  let hit;
  const walk = (n) => {
    if (hit !== undefined || !n || typeof n !== 'object') return;
    if (Array.isArray(n)) { n.forEach(walk); return; }
    if (Array.isArray(n.k) && Array.isArray(n.v)) {
      const i = n.k.indexOf(key);
      if (i >= 0 && n.v[i] && n.v[i].s !== undefined) { hit = n.v[i].s; return; }
    }
    Object.values(n).forEach(walk);
  };
  walk(obj);
  return hit;
}

function httpsPostJson(urlStr, body, headers) {
  return new Promise((resolve) => {
    const u = new URL(urlStr);
    const data = JSON.stringify(body);
    const req = https.request({
      hostname: u.hostname, path: u.pathname + u.search, method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data), ...headers },
      timeout: 20000,
    }, (r) => {
      let buf = '';
      r.on('data', (c) => (buf += c));
      r.on('end', () => resolve({ status: r.statusCode, body: buf }));
    });
    req.on('error', (e) => resolve({ status: 0, body: '', error: e.message }));
    req.on('timeout', () => { req.destroy(new Error('timeout')); resolve({ status: 0, body: '', error: 'timeout' }); });
    req.write(data);
    req.end();
  });
}

/**
 * 直调查续期资格。返回 { decision: 'SKIP' | 'GO' | 'FALLBACK', remainingH?, note }。
 * SKIP=剩时充足免开浏览器；GO=到期走浏览器；FALLBACK=直调失败走浏览器。
 */
async function apiCheckOne(url, id, state) {
  const fail = (note) => ({ decision: 'FALLBACK', note });
  const token = state ? accessTokenFromState(state) : null;
  if (!token) return fail('无有效 Supabase token，直调跳过');
  const hash = CFG.serverFnHash || RECORDED_POST_HASH;
  const body = { t: { t: 10, i: 0, p: { k: ['data'], v: [{ t: 10, i: 1, p: { k: ['id'], v: [{ t: 1, s: id }] }, o: 0 }] }, o: 0 }, f: CFG.serverFnF, m: [] };
  const r = await httpsPostJson(`https://freemchost.com/_serverFn/${hash}`, body, {
    Referer: url, 'User-Agent': CFG.ua,
    accept: 'application/x-tss-framed, application/x-ndjson, application/json',
    authorization: `Bearer ${token}`, 'x-tsr-serverfn': 'true',
  });
  if (r.status !== 200) {
    log(`📡 直调预检 HTTP ${r.status}${r.error ? ` (${r.error})` : ''}，回退浏览器（hash 可能已漂移，看上次嗅探日志更新 SERVERFN_HASH）`);
    return fail(`HTTP ${r.status}`);
  }
  let remainMs, winH;
  try {
    const j = JSON.parse(r.body);
    remainMs = framedValue(j, 'remaining_ms');
    winH = framedValue(j, 'window_hours');
  } catch { /* ignore */ }
  if (typeof remainMs !== 'number') {
    log('📡 直调回包形状变化，无法解析 remaining_ms，回退浏览器');
    return fail('回包无法解析');
  }
  const remainingH = remainMs / 3600000;
  log(`📡 直调预检: 剩余 ${remainingH.toFixed(1)}h（窗口 ${winH || '?'}h）`);
  if (remainingH > CFG.thresholdHours) {
    return { decision: 'SKIP', remainingH, note: `剩余 ${remainingH.toFixed(1)}h ≥ 阈值 ${CFG.thresholdHours}h` };
  }
  return { decision: 'GO', remainingH, note: `剩余 ${remainingH.toFixed(1)}h，需续期` };
}

/** 原生 https 发 TG 通知（不引额外依赖），HTML 失败自动降级纯文本 */
function sendTelegram(text) {
  return new Promise((resolve) => {
    if (!CFG.tgToken || !CFG.tgChatId) {
      log('⚠️ 未配置 TG_BOT_TOKEN / TG_CHAT_ID，跳过通知');
      return resolve(false);
    }
    const post = (bodyObj) => new Promise((res2) => {
      const data = JSON.stringify(bodyObj);
      const req = https.request({
        hostname: 'api.telegram.org',
        path: `/bot${CFG.tgToken}/sendMessage`,
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data) },
        timeout: 15000,
      }, (r) => {
        let buf = '';
        r.on('data', (c) => (buf += c));
        r.on('end', () => {
          try { res2(JSON.parse(buf)); } catch { res2({ ok: false, description: buf.slice(0, 120) }); }
        });
      });
      req.on('error', (e) => res2({ ok: false, description: e.message }));
      req.on('timeout', () => { req.destroy(new Error('timeout')); });
      req.write(data);
      req.end();
    });

    (async () => {
      let r = await post({ chat_id: CFG.tgChatId, text, parse_mode: 'HTML', disable_web_page_preview: true });
      if (!r.ok && r.description && /can't parse entities/i.test(r.description)) {
        log('🔄 TG HTML 实体冲突，改用纯文本重发');
        r = await post({ chat_id: CFG.tgChatId, text: text.replace(/<[^>]+>/g, '') });
      }
      log(r.ok ? '📢 TG 通知已送达' : `⚠️ TG 通知失败: ${r.description || 'unknown'}`);
      resolve(!!r.ok);
    })();
  });
}

async function safeShot(page, name) {
  try {
    if (!fs.existsSync(CFG.shotDir)) fs.mkdirSync(CFG.shotDir, { recursive: true });
    const file = path.join(CFG.shotDir, name.endsWith('.png') ? name : `${name}.png`);
    await page.screenshot({ path: file, fullPage: false, timeout: 8000 });
    log(`📸 截图: ${file}`);
    return file;
  } catch (e) {
    log(`⚠️ 截图跳过: ${e.message}`);
    return null;
  }
}

/* ============================== 登录态 ============================== */

/** 读取 AUTH_STATE（内联 JSON / base64(JSON) / 文件路径）；兼容 storageState: {...} 前缀粘贴 */
function loadAuthState() {
  const candidates = [];
  if (CFG.authStateFile && fs.existsSync(CFG.authStateFile)) candidates.push(fs.readFileSync(CFG.authStateFile, 'utf8'));
  if (CFG.authStateRaw) candidates.push(CFG.authStateRaw);
  const stripPrefix = (s) => {
    let t = String(s || '').trim();
    // 去掉 storageState: / storageState = / const storageState = 等前缀，只留 {...}
    const m = t.match(/^(?:(?:const|let|var)\s+)?storageState\s*[:=]\s*(\{[\s\S]*\})\s*;?\s*$/);
    if (m) return m[1];
    // 首个 { 起截（容忍前导注释/说明文字）
    const i = t.indexOf('{');
    const j = t.lastIndexOf('}');
    if (i >= 0 && j > i && (i > 0)) {
      const sub = t.slice(i, j + 1);
      try { JSON.parse(sub); return sub; } catch { /* not json */ }
    }
    return t;
  };
  for (const c of candidates) {
    const cleaned = stripPrefix(c);
    const tries = [cleaned];
    try { tries.push(Buffer.from(cleaned, 'base64').toString('utf8')); } catch { /* ignore */ }
    for (const t of tries) {
      try {
        const j = JSON.parse(t);
        if (j && (Array.isArray(j.cookies) || Array.isArray(j.origins))) return j;
      } catch { /* ignore */ }
    }
  }
  if (CFG.authStateRaw) log(`⚠️ AUTH_STATE 已配置(${CFG.authStateRaw.length}字)但解析失败：需纯JSON{"cookies":[],"origins":[]}，去掉storageState:前缀或转base64`);
  return null;
}

function hasSupabaseToken(value) {
  try {
    const j = JSON.parse(value);
    return !!(j && (j.access_token || j.refresh_token));
  } catch { return false; }
}

async function loginStateInfo(page) {
  const st = await page.evaluate(() => {
    const out = { token: null, tokenKeys: [], url: location.href };
    try {
      for (let i = 0; i < localStorage.length; i++) {
        const k = localStorage.key(i);
        if (!k) continue;
        if (/^sb-.*-auth-token$/.test(k) || /auth-token/i.test(k)) {
          const v = localStorage.getItem(k) || '';
          if (v && v.length > 20) { out.tokenKeys.push(k); if (!out.token) out.token = v; }
        }
      }
    } catch { /* ignore */ }
    return out;
  }).catch(() => ({ token: null, tokenKeys: [], url: page.url() }));
  const token = st.token && st.token.length > 40 ? st.token : (st.token || null);
  return { ok: /sb-.*-auth-token/.test((st.tokenKeys || []).join(',')) && hasSupabaseToken(token || '{}'), info: st };
}

/** 是否已登录：不在 /login 且 localStorage 中存在 Supabase 令牌 */
async function isLoggedIn(page) {
  const { ok } = await loginStateInfo(page);
  return ok;
}

async function dumpState(context) {
  try {
    if (!fs.existsSync(CFG.shotDir)) fs.mkdirSync(CFG.shotDir, { recursive: true });
    const file = path.join(CFG.shotDir, 'storage-state.json');
    const st = await context.storageState({ path: file });
    const s = JSON.stringify(st);
    log(`💾 登录态已导出 ${file} (${s.length} bytes)`);
    return s;
  } catch (e) {
    log(`⚠️ 导出登录态失败: ${e.message}`);
    return null;
  }
}

/** 用 GH_TOKEN 把最新登录态回写到仓库 Secret: AUTH_STATE */
async function updateGithubSecret(name, value) {
  if (!CFG.ghToken || !CFG.repo) { log('ℹ️ 未提供 GH_TOKEN/GITHUB_REPOSITORY，跳过回写 Secret'); return false; }
  const [owner, repo] = CFG.repo.split('/');

  // gh CLI 自带 sealed-box 加密，直接调，不做 https 取公钥（原 pubkey 分支死代码，已删）
  try {
    const { execFile } = require('child_process');
    await new Promise((resolve, reject) => {
      const p = execFile('gh', ['secret', 'set', name, '--body', value, '--repo', `${owner}/${repo}`],
        { env: { ...process.env, GH_TOKEN: CFG.ghToken }, timeout: 60000 },
        (err, so, se) => (err ? reject(new Error(se || err.message)) : resolve(so)));
      p.stdout && p.stdout.on('data', () => {});
    });
    log(`✅ 已更新 Secret: ${name}`);
    return true;
  } catch (e) {
    log(`⚠️ gh CLI 写入失败: ${String(e.message).slice(0, 200)}`);
    return false;
  }
}

/* ============================== 页面干扰清理 ============================== */

async function dismissNoise(page, tag = '') {
  // 1) Cookie 同意条
  for (const t of ['Accept all', 'Accept All', '接受全部', 'I agree', 'OK']) {
    try {
      const b = page.locator(`button:has-text("${t}")`).first();
      if (await b.isVisible({ timeout: 350 })) { await b.click({ timeout: 1000 }); log(`🍪 已关闭 Cookie 提示 [${t}]${tag}`); await sleep(300); break; }
    } catch { /* ignore */ }
  }
  // 2) Maybe later / Skip（评分与推广弹窗常见出口）
  try {
    const b = page.locator('button, a[role="button"]')
      .filter({ hasText: /^\s*(Maybe later|Later|Skip|Dismiss|No thanks|Not now)\s*$/i }).first();
    if (await b.isVisible({ timeout: 400 })) {
      const owner = await b.evaluate((el) => (el.closest('[role="dialog"]') ? el.closest('[role="dialog"]').innerText : el.innerText)).catch(() => '');
      if (!PROTECT_WORDS.some((p) => String(owner).includes(p))) {
        await b.click({ force: true, timeout: 1500 });
        log(`🛡️ 已点击 [Maybe later] 关闭干扰弹窗${tag}`);
        await sleep(300);
      }
    }
  } catch { /* ignore */ }

  // 3) DOM 层清理：删噪点对话框、遗留 backdrop（严格保护含 Renew/Keep your server online 的容器）
  await page.evaluate(({ noise, protect }) => {
    const hit = (t, words) => words.some((w) => t && t.includes(w));
    const dialogs = Array.from(document.querySelectorAll('[role="dialog"], [data-radix-popper-content-wrapper]'));
    for (const d of dialogs) {
      const txt = d.innerText || '';
      if (hit(txt, protect)) continue;
      if (!hit(txt, noise)) continue;
      // 先试着点自身右上角关闭按钮（radix 的 X 常是 button>svg）
      const x = d.querySelector('button.absolute svg, button[class*="absolute"] svg, [aria-label="Close"], [aria-label="关闭"]');
      if (x && x.closest('button')) { try { x.closest('button').click(); } catch { /* ignore */ } }
      else { try { d.remove(); } catch { /* ignore */ } }
    }
    // 遗留的透明遮罩：fixed inset-0 + data-state=open，且没有对应受保护对话框时才删
    const openDialog = Array.from(document.querySelectorAll('[role="dialog"]')).some((d) => hit(d.innerText || '', protect));
    if (!openDialog) {
      document.querySelectorAll('div.fixed.inset-0').forEach((el) => {
        if (el.getAttribute('data-state') === 'open' && !hit(el.innerText || '', protect)) el.remove();
      });
    }
  }, { noise: NOISE_WORDS, protect: PROTECT_WORDS }).catch(() => {});
  await sleep(200);
}

/* ============================== 时间提取 ============================== */

/**
 * 读取"距离到期剩余时间"。
 * 兼容形态：TIME UNTIL EXPIRY 区块的 "x D y H z M"、正文任意位置的同类倒计时、
 *           绝对日期（2026-09-25 / 09/25/2026 / Sep 25, 2026）、"Expires on ..."
 * 返回 { totalHours, raw } 或 null
 */
async function readExpiry(page) {
  return page.evaluate(() => {
    const bodyText = document.body.innerText || '';

    const hms = (m, g1, g2, g3) => {
      const d = parseInt(m[g1], 10), h = parseInt(m[g2], 10), mi = parseInt(m[g3], 10);
      return { totalHours: d * 24 + h + mi / 60, raw: `${d}天${h}小时${mi}分` };
    };

    // 1) 结构化标题定位
    const all = Array.from(document.querySelectorAll('*'));
    const header = all.find((el) => el.children.length === 0 && /time until expiry/i.test((el.textContent || '').trim()));
    if (header) {
      let c = header.parentElement;
      for (let k = 0; c && k < 5; k++) {
        const t = (c.innerText || '').replace(/\s+/g, ' ');
        const m = t.match(/(\d{1,3})\s*D[\s.]*?(\d{1,2})\s*H[\s.]*?(\d{1,2})\s*M/i);
        if (m) return hms(m, 1, 2, 3);
        c = c.parentElement;
      }
    }

    // 2) 全文兜底
    const m2 = bodyText.replace(/\s+/g, ' ').match(/(\d{1,3})\s*D\s*(\d{1,2})\s*H\s*(\d{1,2})\s*M/i);
    if (m2) return hms(m2, 1, 2, 3);

    // 3) 倒计时 "Renew in 12:34:56"
    const m3 = bodyText.match(/renew(?:s)?\s+in\s+(\d{1,3}):(\d{2}):(\d{2})/i);
    if (m3) {
      const hh = parseInt(m3[1], 10), mm = parseInt(m3[2], 10), ss = parseInt(m3[3], 10);
      return { totalHours: hh + mm / 60 + ss / 3600, raw: `${hh}小时${mm}分${ss}秒` };
    }

    // 4) 绝对日期
    const dm = bodyText.match(/(?:expir\w*\s*(?:on|:)?\s*)?(\d{4})[-/](\d{2})[-/](\d{2})/) ||
               bodyText.match(/(\d{2})[-/](\d{2})[-/](\d{4})/) ||
               bodyText.match(/(Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)[a-z]*\s+(\d{1,2}),?\s+(\d{4})/i);
    if (dm) {
      let dt;
      if (/^\d{4}$/.test(dm[1])) dt = new Date(+dm[1], +dm[2] - 1, +dm[3]);
      else if (/^\d{2}$/.test(dm[1])) dt = new Date(+dm[3], +dm[2] - 1, +dm[1]);
      else dt = new Date(`${dm[1]} ${dm[2]} ${dm[3]}`);
      if (!isNaN(dt.getTime())) {
        const hrs = (dt.getTime() - Date.now()) / 3600000;
        return { totalHours: hrs, raw: `${dt.toISOString().slice(0, 10)} (约 ${hrs.toFixed(1)}h)` };
      }
    }
    return null;
  }).catch(() => null);
}

async function readServerName(page) {
  return page.evaluate(() => {
    const h = document.querySelector('h1, h2');
    if (h && (h.innerText || '').trim().length < 60) return (h.innerText || '').trim();
    return null;
  }).catch(() => null);
}

/* ============================== 点击工具 ============================== */

/** 文本候选点击（限定在对话框/菜单内），命中即点 */
async function clickByText(scope, texts, opts = {}) {
  for (const t of texts) {
    const sel = opts.exact
      ? scope.getByText(t, { exact: true })
      : scope.locator(`button:has-text("${t}"), a:has-text("${t}"), [role="button"]:has-text("${t}")`).first();
    try {
      const el = opts.exact ? sel.first() : sel;
      if (await el.isVisible({ timeout: opts.timeout || 1500 })) {
        const label = (await el.innerText().catch(() => t)).replace(/\s+/g, ' ').trim().slice(0, 40);
        await el.click({ force: !!opts.force, timeout: 5000 });
        log(`👆 已点击: [${label}]`);
        return true;
      }
    } catch { /* next */ }
  }
  return false;
}

/**
 * 60 小时卡片的高可靠点击：
 * 在浏览器内部定位文本叶子节点 → 上溯到 rounded/border/BUTTON 祖先 →
 * 派发 pointerdown → mousedown → focus → pointerup → mouseup → click 全事件链，
 * 再顺带触发内部真实 button/input。
 */
async function clickDurationCard(page, label) {
  return page.evaluate(({ label: lb, noise }) => {
    const clean = (s) => (s || '').replace(/\s+/g, ' ').trim().toLowerCase();
    const all = Array.from(document.querySelectorAll('body *'));
    const wanted = lb.toLowerCase();
    let leaf =
      all.find((el) => el.children.length === 0 && clean(el.textContent) === wanted) ||
      all.find((el) => el.children.length === 0 && clean(el.textContent).includes(wanted));
    if (!leaf) return { ok: false, reason: `未找到文本节点: ${lb}` };

    let card = leaf;
    for (let j = 0; j < 8; j++) {
      const p = card.parentElement;
      if (!p || p === document.body) break;
      const cls = (p.className || '').toString();
      const isScope = /rounded|border|card|option|item|grid|flex/i.test(cls) ||
        p.tagName === 'BUTTON' || p.getAttribute('role') === 'radio' || p.getAttribute('role') === 'option' ||
        p.tagName === 'LABEL';
      if (isScope) { card = p; break; }
      card = p;
    }
    if (noise.some((n) => (card.innerText || '').includes(n))) return { ok: false, reason: '命中在噪声容器内，跳过' };

    const rect = card.getBoundingClientRect();
    const x = rect.left + rect.width / 2, y = rect.top + rect.height / 2;
    const o = { bubbles: true, cancelable: true, view: window, clientX: x, clientY: y, button: 0 };
    card.scrollIntoView({ block: 'center' });
    ['pointerover', 'pointerenter', 'pointerdown', 'mousedown', 'pointerup', 'mouseup', 'click'].forEach((t) => {
      try {
        const E = t.startsWith('pointer') ? PointerEvent : MouseEvent;
        card.dispatchEvent(new E(t, o));
      } catch { /* ignore */ }
    });
    const inner = card.querySelector('button, input[type="radio"], input[type="checkbox"], [role="radio"], [role="option"], label');
    if (inner) { try { inner.click(); } catch { /* ignore */ } }
    return { ok: true, reason: `<${card.tagName.toLowerCase()}> class="${String(card.className).slice(0, 60)}"` };
  }, { label, noise: NOISE_WORDS }).catch((e) => ({ ok: false, reason: e.message }));
}

/* ============================== 核心续期流程 ============================== */

/** 打开 Manage 菜单（录制证据：id 以 "-trigger-manage" 结尾） */
async function openManageMenu(page) {
  const trigger = page.locator('[id$="-trigger-manage"], [aria-haspopup]:has-text("Manage"), button:has-text("Manage")').first();
  try {
    await trigger.waitFor({ state: 'visible', timeout: 15000 });
    await trigger.click({ timeout: 8000 });
  } catch {
    if (!(await clickByText(page, ['Manage']))) { log('❌ 未找到 Manage 菜单'); return false; }
  }
  await sleep(1200);
  await dismissNoise(page, '(菜单打开后)');
  return true;
}

/** Manage 内容区作用域 */
function manageScope(page) {
  return page.locator('[id$="-content-manage"], [role="dialog"]:has-text("Renew"), [data-radix-popper-content-wrapper]:has-text("Renew")').last();
}

/**
 * 单个服务器续期。
 * 返回 { status, before, after, note }，status ∈ SUCCESS / PENDING / NO_BUTTON / FAIL
 */
async function renewOneServer(context, url, idx, total) {
  const page = await context.newPage();
  const id = serverIdOf(url);
  const result = { idx, total, url, id, name: null, status: 'FAIL', before: null, after: null, note: '' };
  const apiHits = [];
  const t0 = Date.now();
  log(`\n──────── 服务器 [${idx}/${total}] ${id} ────────`);
  log(`🔗 ${url}`);

  try {
    page.on('response', async (res) => {
      const u = res.url();
      if (/_serverFn\//.test(u) && res.request().method() === 'POST') {
        let body = '';
        try { body = (await res.text()).slice(0, 300); } catch { /* ignore */ }
        apiHits.push({ hash: (u.match(/_serverFn\/([0-9a-f]+)/) || [])[1] || '', status: res.status(), body });
        log(`📡 捕获续期接口 POST /_serverFn/... → ${res.status()}`);
      }
    });

    await gotoRetry(page, url, { waitUntil: 'domcontentloaded', timeout: CFG.navTimeout });
    await sleep(2500);
    await dismissNoise(page);

    if (!(await isLoggedIn(page))) {
      const txt = await page.evaluate(() => (document.body.innerText || '').slice(0, 150)).catch(() => '');
      result.note = `未登录/被重定向到登录页：${txt}`;
      await safeShot(page, `server-${idx}-nologin.png`);
      result.status = 'FAIL';
      return result;
    }

    result.name = await readServerName(page);

    // 展开 Manage，切到 Billing
    if (!(await openManageMenu(page))) { result.note = '无法打开 Manage 菜单'; await safeShot(page, `server-${idx}-manage.png`); return result; }
    await clickByText(manageScope(page), ['Billing'], { timeout: 2000 }).catch(() => false);
    await sleep(1800);
    await dismissNoise(page);

    const before = await readExpiry(page);
    result.before = before ? before.raw : '未读取到';
    const remainH = before ? before.totalHours : null;
    log(`⏱️ 剩余时长: ${result.before}${remainH != null ? ` (${remainH.toFixed(1)}h)` : ''}`);

    // 续期入口（弹窗内按钮 / Renew now 文本）
    const renewBtn = manageScope(page).locator('button:has-text("Renew")').first();
    let btnText = '';
    try {
      await renewBtn.waitFor({ state: 'visible', timeout: 8000 });
      btnText = (await renewBtn.innerText().catch(() => '')).replace(/\s+/g, ' ').trim();
    } catch {
      const found = await clickByText(manageScope(page), ['Renew now', 'Renew'], { timeout: 1500 });
      if (!found) { result.note = '未找到 Renew 按钮（可能未到期或 UI 改版）'; await safeShot(page, `server-${idx}-norenew.png`); result.status = 'NO_BUTTON'; return result; }
    }
    if (btnText) log(`🔘 续期按钮文案: [${btnText.slice(0, 60)}]`);

    // "Renew in 12:34:56" = 未到期
    if (/renew\s+in\s+\d{1,3}:\d{2}:\d{2}/i.test(btnText) || (remainH != null && remainH > CFG.thresholdHours)) {
      result.status = 'PENDING';
      result.note = remainH != null ? `剩余 ${remainH.toFixed(1)}h ≥ 阈值 ${CFG.thresholdHours}h` : '未到续期窗口';
      log(`⏳ ${result.note}，本次跳过`);
      await clickByText(page.locator('body'), ['Close', 'Cancel']).catch(() => false);
      return result;
    }

    if (CFG.dryRun) { result.status = 'PENDING'; result.note = 'DRY_RUN 演练模式，未真正点击'; log('🧪 DRY_RUN，跳过点击'); return result; }

    // 打开续期弹窗
    try { await renewBtn.click({ timeout: 8000 }); } catch { await clickByText(manageScope(page), ['Renew now', 'Renew']); }
    await sleep(2000);
    await dismissNoise(page, '(续期弹窗)');
    const modal = page.locator('[role="dialog"]:has-text("Renew"), [data-state="open"][role="dialog"], [id^="radix-"][role="dialog"]').last();
    try { await modal.waitFor({ state: 'visible', timeout: 12000 }); } catch { log('⚠️ 未探测到独立弹窗，继续在页面上操作'); }

    // "come back later" 后端校验未就绪时等待解锁
    for (let poll = 0; poll < 12; poll++) {
      const locked = await page.evaluate(() => /come back later/i.test(document.body.innerText || '')).catch(() => false);
      if (!locked) break;
      log('🔒 续期窗口尚未解锁，等待中…');
      await sleep(2500);
    }

    // 选择续期时长
    let dur = { ok: false, reason: 'skipped' };
    for (const label of CFG.durationLabels) {
      dur = await clickDurationCard(page, label);
      if (dur.ok) { log(`🎯 已选择续期时长 [${label}] → ${dur.reason}`); break; }
    }
    if (!dur.ok) log(`ℹ️ 时长选择未命中（${dur.reason}），尝试直接确认（部分版本无需选择）`);
    await sleep(1200);

    // 确认续期（含可能出现的 renew_confirm_code 输入框）
    await page.evaluate(() => {
      const i = document.querySelector('input[name="renew_confirm_code"]');
      if (i && !i.value) {
        const m = (document.body.innerText || '').match(/\b([A-Z0-9]{4,8})\b/);
        if (m) { i.value = m[1]; i.dispatchEvent(new Event('input', { bubbles: true })); }
      }
    }).catch(() => {});
    await sleep(400);

    const confirmed = await clickByText(modal, [
      'Renew now', 'Confirm renew', 'Renew for', 'Confirm', 'Continue', 'Renew', 'Yes',
    ], { timeout: 1200 });
    if (!confirmed && !(await clickByText(page.locator('body'), ['Renew now', 'Confirm', 'Renew']))) {
      result.note = '弹窗内未找到确认按钮'; await safeShot(page, `server-${idx}-noconfirm.png`); return result;
    }

    // 等待落库（接口 + 时间双确认）
    await sleep(4000);

    // 跨上下文硬核验（wittyconan 的核心设计：必须真实入库才算成功）
    const verify = await context.newPage();
    try {
      await gotoRetry(verify, url, { waitUntil: 'domcontentloaded', timeout: CFG.navTimeout });
      await sleep(2200);
      await dismissNoise(verify);
      if (await openManageMenu(verify)) { await clickByText(manageScope(verify), ['Billing'], { timeout: 1500 }).catch(() => false); await sleep(1500); }
      const after = await readExpiry(verify);
      result.after = after ? after.raw : '未读取到';
      const aH = after ? after.totalHours : null;
      log(`🔍 独立页面复核: ${result.before} ➔ ${result.after}`);
      await safeShot(verify, `server-${idx}-verify.png`);
      if (before && aH != null && aH - (before.totalHours || 0) >= Math.min(CFG.verifyMinHours, 12)) {
        result.status = 'SUCCESS';
        result.note = `+${(aH - before.totalHours).toFixed(1)}h`;
        log('🎉 验证通过，后端已落库');
      } else if (before && aH != null && aH > before.totalHours) {
        result.status = 'SUCCESS';
        result.note = `+${(aH - before.totalHours).toFixed(1)}h (低于预期增量)`;
        log('✅ 时长有增加，判定成功');
      } else {
        result.status = 'FAIL';
        result.note = '点击完成但时长未变化';
        await safeShot(verify, `server-${idx}-fail.png`);
        log('❌ 后端未入账');
      }
    } finally { await verify.close().catch(() => {}); }

    if (apiHits.length) {
      const last = apiHits[apiHits.length - 1];
      log(`📡 续期接口: /_serverFn/${last.hash} → ${last.status}`);
      result.note += ` api:${last.hash.slice(0, 12)}…=${last.status}`;
    }
  } catch (e) {
    result.note = (result.note || '') + ` 异常: ${String(e.message).slice(0, 120)}`;
    await safeShot(page, `server-${idx}-error.png`);
    log(`❌ 处理异常: ${e.message}`);
  } finally {
    await page.close().catch(() => {});
    log(`⌛ 用时 ${((Date.now() - t0) / 1000).toFixed(1)}s`);
  }
  return result;
}

/* ============================== 登录 ============================== */

async function doLogin(page) {
  log('🔑 账号密码登录 Supabase Auth（freemchost 前端登录页）');
  await gotoRetry(page, CFG.loginUrl, { waitUntil: 'domcontentloaded', timeout: CFG.navTimeout });
  await sleep(2500);
  await dismissNoise(page, '(登录页)');

  if (await isLoggedIn(page)) { log('✅ 已有有效登录态，跳过登录'); return true; }

  const email = page.locator('input[type="email"], input[name*="email" i], input[placeholder*="email" i]').first();
  const pass = page.locator('input[type="password"], input[name*="pass" i], input[placeholder*="pass" i]').first();
  await email.waitFor({ state: 'visible', timeout: 20000 });
  await email.click();
  await email.fill(CFG.email);
  await sleep(250);
  await pass.click();
  await pass.fill(CFG.password);
  await sleep(250);

  const clicked = await clickByText(page, ['Sign in', 'Log in', 'Login', 'Continue'], { timeout: 3000 });
  if (!clicked) {
    try { await page.locator('button[type="submit"]').first().click({ timeout: 5000 }); } catch { log('❌ 未找到登录提交按钮'); return false; }
  }

  try { await page.waitForURL((u) => !/\/login/i.test(u.href), { timeout: 60000 }); } catch {
    const txt = await page.evaluate(() => (document.body.innerText || '').slice(0, 220)).catch(() => '');
    if (/just a moment|verify you are human|cf-chl/i.test(txt)) { log('🛡️ 命中 Cloudflare 人机校验，建议配置 PROXY_URL / NODE_LINK 更换节点'); await sleep(20000); }
    if (/\/login/i.test(page.url())) { log(`❌ 登录超时，当前页: ${page.url()} | 文本: ${txt.slice(0, 120)}`); return false; }
  }
  await sleep(1500);
  const ok = await isLoggedIn(page);
  log(ok ? '✅ 登录成功' : '❌ 登录后未检测到 Supabase 令牌');
  return ok;
}

/* ============================== 主流程 ============================== */

(async () => {
  const targets = parseTargets();
  if (!targets.length) {
    console.error('❌ 未配置 SERVER_PAGE_URL（或 SERVER_ID），脚本终止');
    process.exit(1);
  }
  const state = loadAuthState();
  if (!state && (!CFG.email || !CFG.password)) {
    console.error('❌ 需至少提供 AUTH_STATE，或 FREE_EMAIL + FREE_PASSWORD');
    process.exit(1);
  }

  log('#'.repeat(64));
  log('   FreeMCHost (freemchost.com) 自动续期  v1.0');
  log(`   目标数: ${targets.length} | 阈值: ${CFG.thresholdHours}h | 时长: ${CFG.durationLabels.slice(0, 2).join('/')} | DRY_RUN: ${CFG.dryRun}`);
  log(`   代理: ${CFG.proxyUrl || '直连'} | headless: ${CFG.headless} | 登录: ${state ? '登录态注入(可降级账密)' : '账密'}`);
  log('#'.repeat(64));

  if (!fs.existsSync(CFG.shotDir)) fs.mkdirSync(CFG.shotDir, { recursive: true });

  const launchOpts = {
    headless: CFG.headless,
    args: [
      '--no-sandbox', '--disable-setuid-sandbox', '--disable-blink-features=AutomationControlled',
      '--disable-dev-shm-usage', '--window-size=1920,1080', '--lang=en-US', '--no-first-run',
    ],
  };
  if (CFG.proxyUrl) {
    const hp = parseProxyHostPort(CFG.proxyUrl);
    // CI 里 PROXY_URL=127.0.0.1:1080 可能是脏环境(sing-box 起在混用端口/残留代理)：先 TCP 探测，不通直接直连
    const alive = hp ? await tcpProbe(hp.host, hp.port, 5000) : false;
    if (alive) {
      try { launchOpts.proxy = { server: CFG.proxyUrl }; log(`🔗 代理存活: ${CFG.proxyUrl}，走代理`); } catch (e) { log(`⚠️ 代理参数无效: ${e.message}`); }
    } else {
      log(`⚠️ 代理不可连(${CFG.proxyUrl})，本次直连（CI 脏代理常见：sing-box 混用1080/残留 PROXY_URL Secret）`);
      CFG.proxyUrl = '';
    }
  } else { log('🍭 直连模式（若频繁失败请配置 NODE_LINK 或 PROXY_URL）'); }
  if (CFG.channel) { launchOpts.channel = CFG.channel; log(`🧭 channel=${CFG.channel}`); }

  const browser = await chromium.launch(launchOpts);
  const ctxOpts = { viewport: { width: 1920, height: 1080 }, userAgent: CFG.ua, locale: CFG.locale, timezoneId: CFG.timezone };
  if (state) ctxOpts.storageState = state;
  const context = await browser.newContext(ctxOpts);

  let authOk = false;
  let dumped = null;
  const first = await context.newPage();
  try {
    if (state) {
      log('🍪 使用注入登录态访问目标页');
      await first.goto(targets[0], { waitUntil: 'domcontentloaded', timeout: CFG.navTimeout });
      await sleep(2500);
      await dismissNoise(first);
      if (await isLoggedIn(first)) authOk = true;
      else log('⚠️ 登录态已失效，降级为账密登录');
    }
    if (!authOk && CFG.email && CFG.password) authOk = await doLogin(first);
    if (!authOk) {
      await safeShot(first, 'login-failed.png');
      await dumpState(context);
      throw new Error('登录失败（账密或登录态均不可用）');
    }
    dumped = await dumpState(context);
    if (dumped && CFG.autoUpdateState && CFG.ghToken) await updateGithubSecret('AUTH_STATE', dumped);
  } finally { await first.close().catch(() => {}); }

  const results = [];
  let browserTargets = targets.map((url, i) => ({ url, idx: i + 1 }));
  if (CFG.apiDirect !== 'off') {
    let liveState = state;
    try { liveState = JSON.parse(dumped) || state; } catch { /* keep state */ }
    log('📡 API 直调预检中（check-only，未到期则免开浏览器）…');
    const remain = [];
    for (const t of browserTargets) {
      const c = await apiCheckOne(t.url, serverIdOf(t.url), liveState);
      if (c.decision === 'SKIP') {
        log(`⏳ [${t.idx}/${targets.length}] ${c.note}，跳过浏览器`);
        results.push({ idx: t.idx, total: targets.length, url: t.url, id: serverIdOf(t.url), name: null, status: 'PENDING', before: `${c.remainingH.toFixed(1)}h(直调)`, after: null, note: c.note });
      } else {
        log(`➡️ [${t.idx}/${targets.length}] ${c.note}，走浏览器`);
        remain.push(t);
      }
    }
    browserTargets = remain;
    if (!browserTargets.length) log('✅ 全部服务器剩余充足，本次免开浏览器操作');
  }
  for (const t of browserTargets) {
    try { results.push(await renewOneServer(context, t.url, t.idx, targets.length)); }
    catch (e) { log(`❌ 服务器 ${t.idx} 未捕获异常: ${e.message}`); results.push({ idx: t.idx, total: targets.length, url: t.url, id: serverIdOf(t.url), name: null, status: 'FAIL', before: '-', after: '-', note: e.message.slice(0, 100) }); }
    await sleep(1500);
  }
  results.sort((a, b) => a.idx - b.idx);
  await context.storageState({ path: path.join(CFG.shotDir, 'storage-state-final.json') }).catch(() => {});
  await browser.close();
  log(`🏁 浏览器已关闭${!browserTargets.length ? '（预检全跳过，实际未操作）' : ''}`);

  const ICON = { SUCCESS: '🟢', PENDING: '⚪', NO_BUTTON: '🟡', FAIL: '🔴' };
  const LABEL = { SUCCESS: '续期成功', PENDING: '无需续期', NO_BUTTON: '未找到按钮', FAIL: '失败' };
  const lines = results.map((r) => {
    const n = r.name ? ` ${r.name}` : '';
    return `${ICON[r.status] || '❔'} <b>[${r.idx}/${r.total}] ${r.id}${n}</b>\n   ${LABEL[r.status] || r.status}` +
      `${r.before ? ` | ${r.before}${r.after ? ` ➔ ${r.after}` : ''}` : ''}${r.note ? `\n   └ ${r.note}` : ''}`;
  });
  const sum = `🖥 <b>FreeMCHost 自动续期报告</b>\n\n${lines.join('\n')}\n\n<b>阈值</b> &lt;${CFG.thresholdHours}h 触发 · <b>周期</b> 每 2天巡检\n<b>时间</b> ${nowStr()}`;
  await sendTelegram(sum);
  console.log('\n================ 汇总 ================');
  results.forEach((r) => console.log(`${ICON[r.status]} [${r.idx}/${r.total}] ${r.id} ${r.before}${r.after ? ' ➔ ' + r.after : ''} ${r.note}`));
  const fails = results.filter((r) => r.status === 'FAIL').length;
  process.exitCode = fails && fails === results.length ? 1 : 0;
})().catch(async (e) => {
  console.error('❌ 全局致命错误:', e.message);
  await sendTelegram(`🚨 <b>FreeMCHost 运行异常</b>\n<code>${String(e.message).slice(0, 200)}</code>\n⏱ ${nowStr()}`);
  process.exit(1);
});
