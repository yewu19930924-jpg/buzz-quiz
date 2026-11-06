#!/usr/bin/env node
/* =========================================================================
 * 四人跨网抢答 · 零依赖单文件服务
 * -------------------------------------------------------------------------
 * 本地启动：  node server.js
 * 云端部署：  平台自动注入 PORT，无需改动
 * 改口令：    ROOM_KEY=mykey node server.js
 *
 * 地址：
 *   大屏   http://<host>/host?k=<口令>
 *   玩家   http://<host>/play?name=玩家1&k=<口令>
 * ========================================================================= */
'use strict';

const http = require('http');
const os = require('os');

/* ----------------------------- 可调参数 --------------------------------- */
const PORT     = process.env.PORT || 3000;
const ROOM_KEY = process.env.ROOM_KEY || 'qd2026';

const BUZZ_MS   = 10000;   // 抢答窗口（毫秒）
const ANSWER_MS = 8000;    // 作答窗口（毫秒）
const WINDOW_MS = 180;     // 抢答收集窗口：抵消网络差异
const PTS_OK    = 10;      // 答对得分
const PTS_BAD   = -5;      // 答错 / 超时扣分
const RTT_CAP   = 1500;    // RTT 上限，防作弊

/* ------------------------------- 题库 ----------------------------------- */
const QUESTIONS = [
  { q: '长电科技收购晟碟半导体的股权比例是多少？',
    a: '80%',
    t: '长电科技通过收购取得晟碟半导体 80% 股权，由此实现控股合并。' },
  { q: '长电科技在 2025 年全球委外封装测试（OSAT）行业营收排名第几？',
    a: '第 3 名',
    t: '按 2025 年营收口径，长电科技在全球 OSAT 行业位列第 3。' },
  { q: '长电科技在中国大陆封测企业中排名第几？',
    a: '第 1 名',
    t: '长电科技是中国大陆封测企业第 1，为本土封装测试龙头。' },
  { q: '晟碟半导体成立于哪一年？',
    a: '2006 年 8 月',
    t: '晟碟半导体成立于 2006 年 8 月。' }
];

/* --------------------------- 唯一裁判：状态 ------------------------------ */
const state = {
  phase: 'idle',
  qi: 0,
  deadline: 0,
  span: 0,
  roundStart: 0,
  winner: null,
  runnerUp: null,
  margin: null,
  result: null,
  scores: {}
};

let timer = null;
let settleTimer = null;
let pending = [];
const sse = new Set();

/* ------------------------------ 工具函数 -------------------------------- */
function arm(ms, fn) {
  clearTimeout(timer);
  timer = setTimeout(function () { timer = null; fn(); }, ms);
}

function payload() {
  const q = QUESTIONS[state.qi] || null;
  const reveal = state.phase === 'judge' || state.phase === 'final';
  return {
    phase: state.phase,
    qi: state.qi,
    total: QUESTIONS.length,
    q: state.phase === 'idle' ? null : (q ? q.q : null),
    answer: reveal && q ? q.a : null,
    tip: reveal && q ? q.t : null,
    remain: Math.max(0, state.deadline - Date.now()),
    span: state.span,
    winner: state.winner ? state.winner.name : null,
    runnerUp: state.runnerUp,
    margin: state.margin,
    react: state.winner && state.roundStart
      ? Math.max(0, Math.round(state.winner.at - state.roundStart)) : null,
    result: state.result,
    scores: state.scores
  };
}

function broadcast() {
  const line = 'data: ' + JSON.stringify(payload()) + '\n\n';
  for (const res of sse) {
    try { res.write(line); } catch (e) { /* 客户端已断开 */ }
  }
}

/* ---------------------------- 状态机：游戏流程 -------------------------- */
function start() {
  clearTimeout(timer); timer = null;
  clearTimeout(settleTimer); settleTimer = null;
  pending = [];

  state.phase = 'buzz';
  state.qi = 0;
  state.winner = null;
  state.runnerUp = null;
  state.margin = null;
  state.result = null;
  state.scores = {};

  state.roundStart = Date.now();
  state.deadline = state.roundStart + BUZZ_MS;
  state.span = BUZZ_MS;

  arm(BUZZ_MS, noBuzz);
  broadcast();
}

function nextQuestion() {
  if (state.phase !== 'judge') return { ok: false, reason: '当前不能切题' };

  if (state.qi + 1 >= QUESTIONS.length) {
    state.phase = 'final';
    state.deadline = 0;
    state.span = 0;
    broadcast();
    return { ok: true };
  }

  clearTimeout(settleTimer); settleTimer = null;
  pending = [];

  state.qi += 1;
  state.phase = 'buzz';
  state.winner = null;
  state.runnerUp = null;
  state.margin = null;
  state.result = null;
  state.roundStart = Date.now();
  state.deadline = state.roundStart + BUZZ_MS;
  state.span = BUZZ_MS;

  arm(BUZZ_MS, noBuzz);
  broadcast();
  return { ok: true };
}

function noBuzz() {
  if (state.phase !== 'buzz') return;
  state.result = 'none';
  state.phase = 'judge';
  state.deadline = 0;
  state.span = 0;
  broadcast();
}

/* ---- 抢答：收集窗口 + RTT 补偿 ---- */
function buzz(name, rawRtt) {
  if (state.phase !== 'buzz') return { ok: false, reason: '不在抢答时间' };
  if (state.winner) return { ok: false, reason: '已被抢' };

  let rtt = Number(rawRtt);
  if (!isFinite(rtt) || rtt < 0) rtt = 0;
  if (rtt > RTT_CAP) rtt = RTT_CAP;

  const est = Date.now() - rtt / 2;
  pending.push({ name: String(name || '玩家').slice(0, 20), est: est });

  if (!settleTimer) settleTimer = setTimeout(settle, WINDOW_MS);
  return { ok: true, queued: true };
}

function settle() {
  settleTimer = null;
  const list = pending.splice(0).sort(function (a, b) { return a.est - b.est; });
  if (!list.length) return;

  const win = list[0];
  const second = list[1] || null;

  state.winner = { name: win.name, at: Math.max(state.roundStart, win.est) };
  state.runnerUp = second ? second.name : null;
  state.margin = second ? Math.round(second.est - win.est) : null;
  if (typeof state.scores[win.name] !== 'number') state.scores[win.name] = 0;

  state.phase = 'answer';
  state.deadline = Date.now() + ANSWER_MS;
  state.span = ANSWER_MS;

  arm(ANSWER_MS, function () {
    if (state.phase !== 'answer') return;
    state.scores[win.name] += PTS_BAD;
    state.result = 'timeout';
    state.phase = 'judge';
    state.deadline = 0;
    state.span = 0;
    broadcast();
  });

  broadcast();
}

/* ---- 主持人判分 ---- */
function judge(ok) {
  if (state.phase !== 'answer') return { ok: false, reason: '当前不在作答阶段' };
  const n = state.winner.name;
  state.scores[n] = (state.scores[n] || 0) + (ok ? PTS_OK : PTS_BAD);
  state.result = ok ? 'correct' : 'wrong';
  state.phase = 'judge';
  state.deadline = 0;
  state.span = 0;
  clearTimeout(timer); timer = null;
  broadcast();
  return { ok: true };
}

/* ------------------------------ 大屏页面 -------------------------------- */
const HOST_HTML = `<!DOCTYPE html>
<html lang="zh-CN"><head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>抢答 · 大屏</title>
<style>
*{box-sizing:border-box;margin:0;padding:0}
body{font-family:-apple-system,BlinkMacSystemFont,"PingFang SC","Microsoft YaHei",sans-serif;
background:radial-gradient(900px 500px at 10% -10%,rgba(255,86,86,.18),transparent 60%),
radial-gradient(700px 500px at 100% 5%,rgba(56,132,255,.18),transparent 58%),#080a12;
color:#e9eefa;min-height:100vh;padding:24px}
.wrap{max-width:860px;margin:0 auto}
.bar{display:flex;justify-content:space-between;font-size:13px;color:#8593ab;margin-bottom:14px}
.live{color:#ff5757;font-weight:700}
.card{background:linear-gradient(180deg,rgba(255,255,255,.06),rgba(255,255,255,.02));
border:1px solid rgba(255,255,255,.09);border-radius:20px;padding:26px 24px;
box-shadow:0 26px 60px -32px rgba(0,0,0,.95)}
.qtext{font-size:25px;line-height:1.6;font-weight:700;margin-bottom:20px;min-height:80px}
.timerow{display:flex;align-items:center;gap:16px;margin-bottom:16px}
.num{font-size:44px;font-weight:800;font-variant-numeric:tabular-nums;color:#8fd0ff;min-width:100px}
.num.hot{color:#ff6b6b}
.track{flex:1;height:10px;background:rgba(255,255,255,.08);border-radius:99px;overflow:hidden}
.track i{display:block;height:100%;width:0;background:linear-gradient(90deg,#3b82f6,#22d3ee);
border-radius:99px;transition:width .1s linear}
.track i.hot{background:linear-gradient(90deg,#f43f5e,#fb923c)}
.status{font-size:18px;font-weight:700;color:#c3cfe2;min-height:26px;margin-bottom:6px}
.meta{font-size:13px;color:#ffb020;min-height:18px;margin-bottom:16px}
.ans{display:none;background:rgba(255,255,255,.04);border:1px solid rgba(255,255,255,.08);
border-radius:14px;padding:16px;margin-bottom:16px}
.ans.on{display:block}
.ans .lbl{font-size:11px;letter-spacing:.1em;color:#7e8ba6;font-weight:700;margin-bottom:6px}
.ans .val{font-size:24px;font-weight:800;color:#7dffd4;margin-bottom:8px}
.ans .tip{font-size:14px;color:#a4b2c9;line-height:1.6}
.btns{display:flex;gap:10px;flex-wrap:wrap}
button{cursor:pointer;border:0;font-family:inherit;font-size:16px;font-weight:700;
padding:14px 26px;border-radius:13px;transition:filter .2s,transform .15s}
button:hover{filter:brightness(1.1);transform:translateY(-1px)}
.primary{background:linear-gradient(100deg,#60a5fa,#34e0c4);color:#04121f}
.ok{background:linear-gradient(100deg,#34d399,#22c55e);color:#04220f}
.no{background:rgba(244,63,94,.16);color:#ffbcc6;border:1px solid rgba(244,63,94,.45)}
.board{display:grid;grid-template-columns:repeat(auto-fit,minmax(150px,1fr));gap:10px;margin-top:16px}
.pc{background:rgba(255,255,255,.045);border:1px solid rgba(255,255,255,.09);
border-radius:14px;padding:13px 16px;display:flex;justify-content:space-between;align-items:center}
.pc .n{font-size:14px;color:#a9b7ce}
.pc .s{font-size:20px;font-weight:800;font-variant-numeric:tabular-nums}
</style></head>
<body><div class="wrap">
<div class="bar"><span class="live">&#9679; 主机 / 大屏</span><span id="qtag">未开始</span></div>
<div class="card">
  <div class="qtext" id="qtext">等待开始…</div>
  <div class="timerow">
    <div class="num" id="num">--</div>
    <div class="track"><i id="fill"></i></div>
  </div>
  <div class="status" id="status">准备好后点击「开始游戏」</div>
  <div class="meta" id="meta"></div>
  <div class="ans" id="ans">
    <div class="lbl">正确答案</div>
    <div class="val" id="ansVal"></div>
    <div class="tip" id="ansTip"></div>
  </div>
  <div class="btns" id="btns"></div>
</div>
<div class="board" id="board"></div>
</div>
<script>
var KEY = '__KEY__';
var cur = null, endAt = 0;

var es = new EventSource('/events?k=' + encodeURIComponent(KEY));
es.onmessage = function (e) {
  cur = JSON.parse(e.data);
  endAt = Date.now() + cur.remain;
  paint(cur);
};

setInterval(function () {
  if (cur && (cur.phase === 'buzz' || cur.phase === 'answer')) tick();
}, 80);

function tick() {
  var left = Math.max(0, endAt - Date.now());
  var num = document.getElementById('num');
  var fill = document.getElementById('fill');
  num.textContent = (left / 1000).toFixed(1);
  fill.style.width = (cur.span ? (left / cur.span * 100) : 0) + '%';
  var hot = left <= 3000;
  num.className = 'num' + (hot ? ' hot' : '');
  fill.className = hot ? 'hot' : '';
}

function paint(s) {
  document.getElementById('qtag').textContent =
    s.phase === 'idle' ? '未开始' : ('第 ' + (s.qi + 1) + ' / ' + s.total + ' 题');
  document.getElementById('qtext').textContent = s.q || '等待开始…';
  if (!s.span) {
    document.getElementById('num').textContent = '--';
    document.getElementById('fill').style.width = '0%';
  }

  var st = document.getElementById('status');
  if (s.phase === 'idle') st.textContent = '准备好后点击「开始游戏」';
  else if (s.phase === 'buzz') st.textContent = '\u23F1 抢答中 —— 谁先按谁抢到';
  else if (s.phase === 'answer') st.textContent = '\uD83C\uDFA4 ' + s.winner + ' 抢到！请口头作答';
  else if (s.phase === 'judge') st.textContent =
    s.result === 'correct' ? '\u2705 ' + s.winner + ' 答对 +10' :
    s.result === 'wrong'   ? '\u274C ' + s.winner + ' 答错 -5' :
    s.result === 'timeout' ? '\u231B ' + s.winner + ' 超时未答 -5' :
                             '\u23F1 无人抢答，本题作废';
  else st.textContent = '\uD83C\uDFC6 比赛结束';

  var meta = document.getElementById('meta');
  var parts = [];
  var after = (s.phase === 'answer' || s.phase === 'judge');
  if (after && s.react !== null && s.react !== undefined) {
    parts.push('反应 ' + (s.react / 1000).toFixed(2) + ' 秒');
  }
  if (after && s.margin) {
    parts.push(s.runnerUp + ' 仅慢 ' + s.margin + ' 毫秒');
  }
  meta.textContent = parts.join('  \u00B7  ');

  var ans = document.getElementById('ans');
  if (s.answer) {
    ans.classList.add('on');
    document.getElementById('ansVal').textContent = s.answer;
    document.getElementById('ansTip').textContent = s.tip || '';
  } else {
    ans.classList.remove('on');
  }

  var btns = document.getElementById('btns');
  var html = '';
  if (s.phase === 'idle' || s.phase === 'final') {
    html = '<button class="primary" data-cmd="/start?k=' + encodeURIComponent(KEY) + '">' +
           (s.phase === 'final' ? '再来一局' : '开始游戏') + '</button>';
  } else if (s.phase === 'answer') {
    html = '<button class="ok" data-cmd="/judge?ok=1&k=' + encodeURIComponent(KEY) + '">答对了 +10</button>' +
           '<button class="no" data-cmd="/judge?ok=0&k=' + encodeURIComponent(KEY) + '">答错了 -5</button>';
  } else if (s.phase === 'judge') {
    html = '<button class="primary" data-cmd="/next?k=' + encodeURIComponent(KEY) + '">' +
           (s.qi + 1 >= s.total ? '查看排名' : '下一题') + '</button>';
  }
  btns.innerHTML = html;
  Array.prototype.forEach.call(btns.querySelectorAll('button'), function (b) {
    b.onclick = function () {
      fetch(b.getAttribute('data-cmd'), { cache: 'no-store' }).catch(function () {});
    };
  });

  var names = Object.keys(s.scores);
  document.getElementById('board').innerHTML = names.length ? names
    .sort(function (a, b) { return s.scores[b] - s.scores[a]; })
    .map(function (n, i) {
      return '<div class="pc"><span class="n">' + (i === 0 ? '\uD83E\uDD47 ' : '') + n +
             '</span><span class="s">' + s.scores[n] + '</span></div>';
    }).join('') : '';
}
</script>
</body></html>`;

/* ------------------------------ 手机页面 -------------------------------- */
const PLAY_HTML = `<!DOCTYPE html>
<html lang="zh-CN"><head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1,maximum-scale=1,user-scalable=no">
<title>抢答器</title>
<style>
*{box-sizing:border-box;margin:0;padding:0;-webkit-tap-highlight-color:transparent}
html,body{height:100%}
body{font-family:-apple-system,BlinkMacSystemFont,"PingFang SC","Microsoft YaHei",sans-serif;
background:#080a12;color:#e9eefa;display:flex;flex-direction:column;padding:16px;user-select:none}
.hdr{display:flex;justify-content:space-between;align-items:center;font-size:14px;
color:#8593ab;margin-bottom:10px}
.hdr b{color:#fff;font-size:16px}
.q{font-size:15px;line-height:1.55;color:#a9b7ce;min-height:64px;margin-bottom:8px}
.cd{text-align:center;font-size:15px;color:#7d8ba4;margin-bottom:12px;
font-variant-numeric:tabular-nums;min-height:20px}
#buzz{flex:1;width:100%;border:0;border-radius:24px;font-family:inherit;font-size:34px;
font-weight:800;letter-spacing:.2em;text-indent:.2em;color:#fff;cursor:pointer;
background:radial-gradient(circle at 35% 25%,#5a6b8a,#2a3550 70%);
transition:background .2s,transform .1s,box-shadow .2s}
#buzz.go{background:radial-gradient(circle at 35% 25%,#ff8080,#e11d2f 60%,#8d0c18);
box-shadow:0 0 0 12px rgba(255,87,87,.1),0 0 0 26px rgba(255,87,87,.05);
animation:bp 1.4s infinite}
@keyframes bp{
0%,100%{box-shadow:0 0 0 12px rgba(255,87,87,.1),0 0 0 26px rgba(255,87,87,.05)}
50%{box-shadow:0 0 0 20px rgba(255,87,87,.15),0 0 0 40px rgba(255,87,87,.06)}}
#buzz.mine{background:radial-gradient(circle at 35% 25%,#5ee9a8,#16a34a 70%);
animation:none;box-shadow:0 0 0 12px rgba(34,197,94,.14)}
#buzz.other{background:radial-gradient(circle at 35% 25%,#4a5670,#232c40);opacity:.55}
#buzz:active{transform:scale(.97)}
.foot{text-align:center;font-size:12px;color:#66748c;margin-top:12px;min-height:17px}
</style></head>
<body>
<div class="hdr"><span>玩家：<b id="who">--</b></span><span id="sc">0 分</span></div>
<div class="q" id="q">等待主持人出题…</div>
<div class="cd" id="cd"></div>
<button id="buzz">抢 答</button>
<div class="foot" id="tip">等待开始</div>
<script>
var KEY  = '__KEY__';
var NAME = new URLSearchParams(location.search).get('name') || '玩家';
var locked = true, cur = null, endAt = 0, rtt = 0;

document.getElementById('who').textContent = NAME;

function ping() {
  var t = Date.now();
  fetch('/ping?k=' + encodeURIComponent(KEY), { cache: 'no-store' })
    .then(function () { rtt = Date.now() - t; })
    .catch(function () {});
}
ping();
setInterval(ping, 2000);

var es = new EventSource('/events?k=' + encodeURIComponent(KEY));
es.onmessage = function (e) {
  cur = JSON.parse(e.data);
  endAt = Date.now() + cur.remain;
  paint(cur);
};

setInterval(function () {
  if (cur && (cur.phase === 'buzz' || cur.phase === 'answer')) tick();
}, 80);

function tick() {
  var left = Math.max(0, endAt - Date.now());
  document.getElementById('cd').textContent =
    cur.span ? (left / 1000).toFixed(1) + ' 秒' : '';
}

function paint(s) {
  var btn = document.getElementById('buzz');
  var score = s.scores[NAME] || 0;
  var sc = document.getElementById('sc');
  sc.textContent = score + ' 分';
  sc.style.color = score < 0 ? '#fb7185' : '#fff';
  document.getElementById('q').textContent = s.q || '等待主持人出题…';

  if (s.phase === 'buzz') {
    locked = false;
    btn.className = 'go';
    btn.textContent = '抢 答';
    document.getElementById('tip').textContent = '按下去就抢';
  } else if (s.phase === 'answer') {
    locked = true;
    var mine = (s.winner === NAME);
    btn.className = mine ? 'mine' : 'other';
    btn.textContent = mine ? '你抢到了' : (s.winner || '') + ' 抢到';
    document.getElementById('tip').textContent = mine
      ? ('请直接说出答案 · 反应 ' + ((s.react || 0) / 1000).toFixed(2) + ' 秒')
      : '这轮没抢到，等下一题';
  } else if (s.phase === 'judge') {
    locked = true;
    btn.className = 'other';
    btn.textContent = (s.winner === NAME)
      ? (s.result === 'correct' ? '答对了' : '答错了')
      : (s.result === 'none' ? '无人抢答' : '本轮结束');
    document.getElementById('tip').textContent = '正确答案：' + (s.answer || '');
  } else if (s.phase === 'final') {
    locked = true;
    btn.className = 'other';
    btn.textContent = '比赛结束';
    document.getElementById('tip').textContent = '总分 ' + score;
  } else {
    locked = true;
    btn.className = '';
    btn.textContent = '等待开始';
    document.getElementById('tip').textContent = '等待主持人开始';
  }
}

function fire() {
  if (locked) return;
  locked = true;
  var btn = document.getElementById('buzz');
  btn.className = 'mine';
  btn.textContent = '已发送…';

  fetch('/buzz?name=' + encodeURIComponent(NAME) +
        '&rtt=' + Math.round(rtt) +
        '&k=' + encodeURIComponent(KEY), { cache: 'no-store' })
    .then(function (r) { return r.json(); })
    .then(function (d) {
      if (!d.ok) {
        btn.className = 'other';
        btn.textContent = d.reason === '已被抢' ? '慢了' : '未开始';
      }
    })
    .catch(function () {
      locked = false;
      btn.className = 'go';
      btn.textContent = '抢 答';
    });
}

var b = document.getElementById('buzz');
b.addEventListener('touchstart', function (e) { e.preventDefault(); fire(); }, { passive: false });
b.addEventListener('mousedown', fire);
</script>
</body></html>`;

/* -------------------------------- 路由 ---------------------------------- */
function html(res, body, code) {
  res.writeHead(code || 200, { 'Content-Type': 'text/html; charset=utf-8' });
  res.end(body);
}
function json(res, obj) {
  res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify(obj));
}

const server = http.createServer(function (req, res) {
  const u = new URL(req.url, 'http://local');
  const p = u.pathname;
  const key = u.searchParams.get('k') || '';

  // 健康探测：不需要口令
  if (p === '/ping') return json(res, { ok: true, t: Date.now() });

  // 口令校验
  if (key !== ROOM_KEY) {
    res.writeHead(403, { 'Content-Type': 'text/plain; charset=utf-8' });
    return res.end('403 需要口令：在链接后加 ?k=你的口令');
  }

  // SSE 实时推送
  if (p === '/events') {
    res.writeHead(200, {
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-cache, no-transform',
      'Connection': 'keep-alive',
      'X-Accel-Buffering': 'no'
    });
    res.write('retry: 1000\n\n');
    sse.add(res);
    res.write('data: ' + JSON.stringify(payload()) + '\n\n');
    req.on('close', function () { sse.delete(res); });
    return;
  }

  // 指令
  if (p === '/start') return json(res, (start(), { ok: true }));
  if (p === '/next')  return json(res, nextQuestion());
  if (p === '/judge') return json(res, judge(u.searchParams.get('ok') === '1'));
  if (p === '/buzz')  return json(res, buzz(u.searchParams.get('name'), u.searchParams.get('rtt')));
  if (p === '/state') return json(res, payload());

  // 页面
  if (p === '/host') return html(res, HOST_HTML.replace(/__KEY__/g, function () { return ROOM_KEY; }));
  if (p === '/play') return html(res, PLAY_HTML.replace(/__KEY__/g, function () { return ROOM_KEY; }));

  res.writeHead(302, { Location: '/host?k=' + encodeURIComponent(ROOM_KEY) });
  res.end();
});

/* --------------------- SSE 心跳（云平台保活必需） ----------------------- */
setInterval(function () {
  for (const res of sse) {
    try { res.write(': ping\n\n'); } catch (e) { /* 已断开 */ }
  }
}, 25000);

server.listen(PORT, function () {
  const ips = [];
  const nets = os.networkInterfaces();
  for (const k in nets) {
    for (const n of nets[k]) {
      if (n.family === 'IPv4' && !n.internal) ips.push(n.address);
    }
  }
  const base = ips.length ? 'http://' + ips[0] + ':' + PORT : 'http://localhost:' + PORT;

  console.log('');
  console.log('  ✅ 抢答服务已启动   口令：' + ROOM_KEY);
  console.log('');
  console.log('  大屏：  http://localhost:' + PORT + '/host?k=' + ROOM_KEY);
  for (let i = 1; i <= 4; i++) {
    console.log('  玩家' + i + '： ' + base + '/play?name=玩家' + i + '&k=' + ROOM_KEY);
  }
  console.log('');
});
