'use strict';
const { Context } = require('koishi');
const { createRequire } = require('node:module');
const req = createRequire('C:/sj/koishi/package.json');

function load(p) { let m = req(p); if (m && typeof m === 'object' && typeof m.apply !== 'function' && m.default) m = m.default; return m; }

(async () => {
  const ctx = new Context({ prefix: '' });
  ctx.plugin(load('@koishijs/plugin-commands'));
  ctx.plugin(load('@koishijs/plugin-server'), { port: 3210, host: '127.0.0.1' });
  ctx.plugin(load('@koishijs/plugin-http'));
  try { ctx.plugin(load('@koishijs/plugin-database-sqlite'), { path: 'C:/sj/koishi/data/docs-sandbox/plugintest.db' }); } catch (e) {}

  // 真实插件
  for (const p of ['koishi-plugin-abbreviation', 'koishi-plugin-crazy-thursday', 'koishi-plugin-tongue-twister-picker', 'koishi-plugin-trpgdice', 'koishi-plugin-mc-tools']) {
    try { ctx.plugin(load(p), {}); } catch (e) { console.log('skip ' + p + ': ' + e.message); }
  }

  // 咱们的插件
  const sandbox = require('D:/devkoishi/plugins/koishi-plugin-docs-sandbox/lib/index.js');
  ctx.plugin(sandbox, { path: '/sandbox', waitMs: 2600 });

  await ctx.start();
  await new Promise(r => setTimeout(r, 3000));

  const base = 'http://127.0.0.1:3210/sandbox';
  const health = await (await fetch(base + '/api/health')).json();
  console.log('health:', JSON.stringify(health));

  const cmds = await (await fetch(base + '/api/commands')).json();
  console.log('commands(' + cmds.commands.length + '):', cmds.commands.slice(0, 16).join(', '));

  for (const c of ['abbr yyds', 'thursday', 'roll 1d20', '来个绕口令', 'cmd-that-does-not-exist']) {
    const r = await fetch(base + '/api/run', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ command: c }),
    });
    const j = await r.json();
    const t = (j.outputs || []).map(o => o.text || '[图片]').join(' ').replace(/\s+/g, ' ');
    console.log((j.supported ? 'OK  ' : 'N/A ') + c.padEnd(26) + ' -> ' + (t ? t.slice(0, 110) : (j.error || '(无回复)')));
  }

  // 静态页面
  const page = await fetch(base);
  const html = await page.text();
  console.log('UI page:', page.status, 'bytes=' + html.length, '含标题: ' + /在线沙盒/.test(html));

  console.log('DONE');
  process.exit(0);
})().catch(e => { console.error('FATAL', e.stack || e); process.exit(1); });
