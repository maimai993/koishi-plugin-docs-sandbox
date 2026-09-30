'use strict';
// 起一个「像真 bot 一样」的进程：加载一批真实插件 + docs-sandbox，然后常驻。
const { Context } = require('koishi');
const { createRequire } = require('node:module');
const req = createRequire('C:/sj/koishi/package.json');
function load(p) {
  const cands = p.startsWith('@')
    ? [p.split('/')[0] + '/koishi-plugin-' + p.split('/')[1], p]
    : ['koishi-plugin-' + p, p];
  let last;
  for (const c of cands) {
    try {
      let m = req(c);
      if (m && typeof m === 'object' && typeof m.apply !== 'function' && m.default) m = m.default;
      if (m && (typeof m === 'function' || typeof m.apply === 'function')) return m;
    } catch (e) { last = e; }
  }
  throw last || new Error('not found: ' + p);
}

const PLUGINS = ['abbreviation','chouxianghua','crazy-thursday','tongue-twister-picker','homo','trpgdice',
  'bmi-calculator','guess-number','furry-encode-decode','martian-translator','mc-tools','idiom-dictionary',
  'ciyi','bull-card','driving-test','pighub','emojimixer','vv-bot','smmcat-daxue','smmcat-saima',
  'smmcat-signin','smmcat-transfermoney','smmcat-faqcooking','smmcat-openword','smmcat-oldmaid',
  'smmcat-gensokyo','impart-pro','wordle-game','gameinfo','bilisearch','bing','hot-search',
  'weather-qq-rainbowsky','ptcg-research','divine-oracle','qrcode','get-qq-bot-transfer-link',
  'screenshot-console','emojihub-bili','hero-search','baidu-image-search','bilibili-real-rating',
  'markdown-to-image-service','certificate-achievement','pic-splice-lizard','guild-recall','@wahaha216/jmcomic'];

(async () => {
  const ctx = new Context({ prefix: '' });
  ctx.plugin(load('@koishijs/plugin-commands'));
  ctx.plugin(load('@koishijs/plugin-server'), { port: 3210, host: '127.0.0.1' });
  ctx.plugin(load('@koishijs/plugin-http'));
  try { ctx.plugin(load('@koishijs/plugin-database-sqlite'), { path: 'C:/sj/koishi/data/docs-sandbox/serve.db' }); } catch (e) {}
  // puppeteer 占位，满足 inject
  const { Service } = req('koishi');
  class Pptr extends Service {
    constructor(c) { super(c, 'puppeteer', true); this.browser = null; }
    async render() { throw new Error('未启用图片渲染'); }
    async page() { throw new Error('未启用图片渲染'); }
  }
  ctx.plugin((c) => { c.puppeteer = new Pptr(c); });
  for (const p of ['@koishijs/plugin-notifier','@koishijs/plugin-locales','koishi-plugin-monetary','koishi-plugin-smmcat-localstorage','koishi-plugin-cache-database']) {
    try { const m = load(p); if (m && (typeof m === 'function' || typeof m.apply === 'function')) ctx.plugin(m, {}); } catch (e) {}
  }
  await ctx.start();
  let ok = 0;
  for (const p of PLUGINS) {
    try { const m = load(p); ctx.plugin(m, {}); ok++; }
    catch (e) { console.log('[skip] ' + p + ': ' + e.message.split('\n')[0]); }
  }
  const sandbox = require('C:/sj/koishi/node_modules/koishi-plugin-docs-sandbox/lib/index.js');
  ctx.plugin(sandbox, { path: '/sandbox', waitMs: 2600 });
  await new Promise(r => setTimeout(r, 3000));
  console.log('[serve] 插件已加载 ' + ok + ' 个，沙盒监听 http://127.0.0.1:3210/sandbox');
})().catch(e => { console.error('FATAL', e); process.exit(1); });
