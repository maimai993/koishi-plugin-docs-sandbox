'use strict';
/**
 * 探针：验证「沙盒从网络拉取图片 / 语音附件」这条链路。
 *
 * 起一个真实 koishi 实例 + 一个只会把收到的附件原样报回来的探针指令，
 * 再起一个本地静态服务当「网络」，然后分别用
 *   - 网络 URL      （新增能力）
 *   - data URL      （老写法，不能坏）
 *   - 不存在的 URL  （要给出清楚的失败提示）
 * 打 /api/run，检查机器人侧实际收到的元素。
 *
 * 用法：node scripts/probe-attachments.cjs
 */
process.env.NO_PROXY = process.env.no_proxy = '127.0.0.1,localhost';
process.env.HTTP_PROXY = process.env.http_proxy = '';
process.env.HTTPS_PROXY = process.env.https_proxy = '';

const http = require('node:http');
const { Context, h } = require('koishi');

/** CJS 里有些插件包把真正的东西挂在 .default 上 */
function load(id) {
  let mod = require(id);
  if (mod && typeof mod !== 'function' && typeof mod.apply !== 'function' && mod.default) mod = mod.default;
  if (typeof mod !== 'function' && typeof mod.apply !== 'function') {
    throw new Error('invalid plugin: ' + id);
  }
  return mod;
}

// ---- 测试素材 -------------------------------------------------------------
// 1x1 透明 PNG
const PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
  'base64',
);

// 16kHz 单声道 16bit，0.1 秒静音，套个 WAV 头
function makeWav(ms) {
  const rate = 16000;
  const pcm = Buffer.alloc(Math.round(rate * 2 * ms / 1000));
  const head = Buffer.alloc(44);
  head.write('RIFF', 0);
  head.writeUInt32LE(36 + pcm.length, 4);
  head.write('WAVE', 8);
  head.write('fmt ', 12);
  head.writeUInt32LE(16, 16);
  head.writeUInt16LE(1, 20);
  head.writeUInt16LE(1, 22);
  head.writeUInt32LE(rate, 24);
  head.writeUInt32LE(rate * 2, 28);
  head.writeUInt16LE(2, 32);
  head.writeUInt16LE(16, 34);
  head.write('data', 36);
  head.writeUInt32LE(pcm.length, 40);
  return Buffer.concat([head, pcm]);
}
const WAV = makeWav(100);

const MEDIA_PORT = 3399;
const SANDBOX_PORT = 3398;

function startMediaServer() {
  return new Promise((resolve) => {
    const server = http.createServer((req, res) => {
      const url = (req.url || '').split('?')[0];
      if (url === '/img.png') { res.writeHead(200, { 'content-type': 'image/png' }); return res.end(PNG); }
      if (url === '/tone.wav') { res.writeHead(200, { 'content-type': 'audio/wav' }); return res.end(WAV); }
      if (url === '/slow.png') {
        // 用来验证超时：一直不返回
        return setTimeout(() => { res.writeHead(200); res.end(PNG); }, 60000);
      }
      res.writeHead(404); res.end('not found');
    });
    server.listen(MEDIA_PORT, '127.0.0.1', () => resolve(server));
  });
}

// ---- 探针插件 -------------------------------------------------------------
function describeElement(el) {
  const src = String((el.attrs && (el.attrs.src || el.attrs.url || el.attrs.file)) || '');
  let bytes = 0;
  if (src.startsWith('base64://')) bytes = Buffer.from(src.slice(9), 'base64').length;
  else if (/^data:/.test(src)) bytes = Buffer.from(src.split(',')[1] || '', 'base64').length;
  const scheme = src.startsWith('base64://') ? 'base64'
    : /^data:/.test(src) ? 'data'
      : /^https?:/.test(src) ? 'http' : 'other';
  return scheme + '/' + bytes;
}

function probePlugin(ctx) {
  ctx.command('sbxtest.echo [word:text]').action(({ session }) => {
    const imgs = h.select(session.elements, 'img');
    const audios = h.select(session.elements, 'audio');
    const records = h.select(session.elements, 'record');
    const texts = h.select(session.elements, 'text').map((e) => e.attrs.content).join('').trim();
    const parts = [
      'elements=' + session.elements.length,
      'img=' + imgs.length + (imgs[0] ? '(' + describeElement(imgs[0]) + ')' : ''),
      'audio=' + audios.length + (audios[0] ? '(' + describeElement(audios[0]) + ')' : ''),
      'record=' + records.length,
      'text=' + JSON.stringify(texts.slice(0, 40)),
    ];
    return parts.join(' | ');
  });
}

// ---- 主流程 ---------------------------------------------------------------
(async () => {
  const media = await startMediaServer();

  const ctx = new Context({ prefix: '' });
  ctx.plugin(load('@koishijs/plugin-commands'));
  ctx.plugin(load('@koishijs/plugin-server'), { port: SANDBOX_PORT, host: '127.0.0.1' });
  ctx.plugin(load('@koishijs/plugin-http'));
  ctx.plugin(probePlugin);
  ctx.plugin(load('../lib/index.js'), {
    path: '/sandbox',
    waitMs: 2000,
    idleMs: 600,
    mediaFetchMs: 6000,
  });

  await ctx.start();
  await new Promise((r) => setTimeout(r, 2500));

  const base = 'http://127.0.0.1:' + SANDBOX_PORT + '/sandbox';
  const MEDIA = 'http://127.0.0.1:' + MEDIA_PORT;

  async function run(payload) {
    const r = await fetch(base + '/api/run', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(payload),
    });
    const j = await r.json();
    const text = (j.outputs || []).map((o) => o.text || '[' + o.type + ']').join(' ').replace(/\s+/g, ' ').trim();
    return { status: r.status, text, raw: j };
  }

  const cases = [
    {
      name: '网络图片 URL',
      payload: { command: 'sbxtest.echo hi', images: [MEDIA + '/img.png'] },
      expect: (t) => t.includes('img=1(base64/' + PNG.length + ')') && t.includes('text="sbxtest.echo hi"'),
    },
    {
      name: '网络语音 URL',
      payload: { command: 'sbxtest.echo hi', audios: [MEDIA + '/tone.wav'] },
      expect: (t) => t.includes('audio=1(base64/' + WAV.length + ')'),
    },
    {
      name: '网络图片 + 网络语音',
      payload: { command: 'sbxtest.echo hi', images: [MEDIA + '/img.png'], audios: [MEDIA + '/tone.wav'] },
      expect: (t) => t.includes('img=1(base64/' + PNG.length + ')') && t.includes('audio=1(base64/' + WAV.length + ')'),
    },
    {
      name: '老写法 data URL（兼容）',
      payload: {
        command: 'sbxtest.echo hi',
        images: ['data:image/png;base64,' + PNG.toString('base64')],
      },
      expect: (t) => t.includes('img=1(base64/' + PNG.length + ')'),
    },
    {
      name: 'voices 别名',
      payload: { command: 'sbxtest.echo hi', voices: [MEDIA + '/tone.wav'] },
      expect: (t) => t.includes('audio=1(base64/' + WAV.length + ')'),
    },
    {
      name: '不存在的图片 URL（要报清楚）',
      payload: { command: 'sbxtest.echo hi', images: [MEDIA + '/missing.png'] },
      expect: (t, raw) => JSON.stringify(raw).includes('图片获取失败'),
    },
    {
      name: '一直不返回的图片 URL（超时也要报清楚）',
      payload: { command: 'sbxtest.echo hi', images: [MEDIA + '/slow.png'] },
      expect: (t, raw) => JSON.stringify(raw).includes('图片获取失败'),
    },
  ];

  let pass = 0;
  console.log('=== 附件探针 ===');
  console.log('测试素材: png=' + PNG.length + 'B, wav=' + WAV.length + 'B');

  for (const c of cases) {
    let res;
    try {
      res = await run(c.payload);
    } catch (error) {
      console.log('✗ ' + c.name + ' 请求异常: ' + error.message);
      continue;
    }
    const ok = c.expect(res.text, res.raw);
    if (ok) pass++;
    console.log((ok ? '✓ ' : '✗ ') + c.name);
    console.log('    -> ' + res.text.slice(0, 160));
  }

  console.log('---');
  console.log('通过 ' + pass + '/' + cases.length);

  media.close();
  process.exit(pass === cases.length ? 0 : 1);
})().catch((error) => {
  console.error('FATAL', error && error.stack || error);
  process.exit(2);
});
