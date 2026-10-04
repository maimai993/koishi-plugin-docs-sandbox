'use strict';
/**
 * 探针：验证沙盒交给插件的「用户身份」（头像 / 昵称 / bot.getUser）。
 *
 * 起因：线上沙盒跑 memes-api 的表情包指令直接报
 *   TypeError: User user in platform sandbox has no avatar
 *   at fallback (koishi-plugin-memes-api/lib/index.js:304)
 * memes-api（src/utils/user-info.ts）取头像的顺序是：
 *   ① session.event.user.id === userId && session.event.user.avatar
 *   ② session.bot.getUser(userId, guildId).avatar
 *   ③ 都没有 -> 抛 User xxx in platform xxx has no avatar
 * 以前沙盒的假用户只有 { id, name }，两条路都走不通。
 *
 * 这里注册一条复刻它这段逻辑的指令，检查沙盒两端都给了头像；
 * 另外顺便看一眼 memes-api 错误处理器里的 `session.memesApi.shortcut`
 * 在沙盒里到底能不能读到（读不到会把真正的报错盖成 TypeError）。
 *
 * 用法：node scripts/probe-user-identity.cjs
 */
process.env.NO_PROXY = process.env.no_proxy = '127.0.0.1,localhost';
process.env.HTTP_PROXY = process.env.http_proxy = '';
process.env.HTTPS_PROXY = process.env.https_proxy = '';

const { Context } = require('koishi');

/** CJS 里有些插件包把真正的东西挂在 .default 上 */
function load(id) {
  let mod = require(id);
  if (mod && typeof mod !== 'function' && typeof mod.apply !== 'function' && mod.default) mod = mod.default;
  if (typeof mod !== 'function' && typeof mod.apply !== 'function') {
    throw new Error('invalid plugin: ' + id);
  }
  return mod;
}

/** 插件配置里的默认值（要和 lib/index.js 的 schema 保持一致） */
const DEFAULT_AVATAR = 'https://q1.qlogo.cn/g?b=qq&nk=2237886846&s=640';
const DEFAULT_NAME = '沙盒用户';
const SANDBOX_PORT = 3397;

// ---- 复刻 memes-api 的探针插件 --------------------------------------------
function memesLikePlugin(ctx) {
  // memes-api 会 ctx.set 一个服务，供 session.memesApi 访问
  ctx.set('memesApi', { infos: {}, api: {} });

  /** 复刻 koishi-plugin-memes-api 的 ctx.$.getInfoFromID（src/utils/user-info.ts） */
  async function getInfoFromID(session, userId) {
    if (session.event.user?.id === userId && session.event.user?.avatar) {
      return {
        url: session.event.user.avatar,
        userInfo: { name: session.username || session.userId || '', gender: 'unknown' },
      };
    } else if (session.bot.getUser) {
      const user = await session.bot.getUser(userId, session.guildId);
      if (user && user.avatar) {
        return { url: user.avatar, userInfo: { name: user.nick || user.name || '', gender: 'unknown' } };
      }
    }
    throw new TypeError(`User ${userId} in platform ${session.platform} has no avatar`);
  }

  ctx.command('sbxmeme.avatar').action(async ({ session }) => {
    const out = [];
    // ① 发送者自己（memes-api 的 autoUseSenderAvatarWhenOnlyOne 走这条）
    try {
      const info = await getInfoFromID(session, session.userId);
      out.push('sender=' + info.url);
      out.push('name=' + JSON.stringify(info.userInfo.name));
    } catch (error) {
      out.push('sender FAILED: ' + error.message);
    }
    // ② @某人（imageInfos 里的 userId 不等于发送者）
    try {
      const info = await getInfoFromID(session, '12345');
      out.push('other=' + info.url);
    } catch (error) {
      out.push('other FAILED: ' + error.message);
    }
    return out.join(' | ');
  });

  // 复刻 memes-api 的「快捷方式」中间件：命中就打个标记，再 execute 生成子命令。
  // 注意它标记打在 session 自己身上（session.memesApi ??= {}），不是服务 ——
  // 后面 execute 复用同一个 session 对象，所以标记能传下去。
  ctx.middleware(async (session, next) => {
    const m = /^短横\s+(\S+)/.exec(String(session.content || ''));
    if (!m) return next();
    (session.memesApi ??= {}).shortcut = true;
    return session.execute('sbxmeme.generate ' + m[1]);
  }, true);

  ctx.command('sbxmeme.generate <key>').action(({ session }, key) => {
    // 复刻 memes-api 错误处理器里的读法：config.silentShortcut && session.memesApi.shortcut
    // （它没写可选链，session.memesApi 是 undefined 时直接 TypeError）
    let shortcut;
    try {
      shortcut = String(Boolean(true && session.memesApi.shortcut));
    } catch (error) {
      shortcut = 'THREW: ' + error.message;
    }
    return 'key=' + key
      + ' | memesApi=' + (session.memesApi ? 'truthy' : String(session.memesApi))
      + ' | shortcut=' + shortcut;
  });

  ctx.command('sbxmeme.diag').action(async ({ session }) => {
    const out = [];
    out.push('platform=' + session.platform);
    out.push('userId=' + session.userId);
    out.push('eventUser=' + JSON.stringify(session.event.user));
    out.push('authorNick=' + JSON.stringify(session.author && session.author.nickname));
    // memes-api 错误处理器里的写法：config.silentShortcut && session.memesApi.shortcut
    try {
      out.push('memesApi=' + (session.memesApi ? 'truthy' : String(session.memesApi)));
    } catch (error) {
      out.push('memesApi THREW: ' + error.message);
    }
    try {
      out.push('shortcut=' + String(Boolean(true && session.memesApi.shortcut)));
    } catch (error) {
      out.push('shortcut THREW: ' + error.message);
    }
    return out.join(' | ');
  });
}

// ---- 主流程 ---------------------------------------------------------------
(async () => {
  const ctx = new Context({ prefix: '' });
  ctx.plugin(load('@koishijs/plugin-commands'));
  ctx.plugin(load('@koishijs/plugin-server'), { port: SANDBOX_PORT, host: '127.0.0.1' });
  ctx.plugin(load('@koishijs/plugin-http'));
  ctx.plugin(memesLikePlugin);
  ctx.plugin(load('../lib/index.js'), {
    path: '/sandbox',
    waitMs: 2000,
    idleMs: 600,
  });

  await ctx.start();
  await new Promise((r) => setTimeout(r, 2000));

  const base = 'http://127.0.0.1:' + SANDBOX_PORT + '/sandbox';
  const CUSTOM = 'https://example.com/custom-avatar.png';

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
      name: '默认身份：发送者 + @某人 都能拿到头像',
      payload: { command: 'sbxmeme.avatar' },
      expect: (t) => t.includes('sender=' + DEFAULT_AVATAR)
        && t.includes('name=' + JSON.stringify(DEFAULT_NAME))
        && t.includes('other=' + DEFAULT_AVATAR),
    },
    {
      name: '自定义昵称跟着走',
      payload: { command: 'sbxmeme.avatar', userName: '阿米娅' },
      expect: (t) => t.includes('name="阿米娅"') && t.includes('sender=' + DEFAULT_AVATAR),
    },
    {
      name: '请求里指定头像（avatar 覆盖）',
      payload: { command: 'sbxmeme.avatar', avatar: CUSTOM },
      expect: (t) => t.includes('sender=' + CUSTOM) && t.includes('other=' + CUSTOM),
    },
    {
      name: '非法头像地址要忽略、退回默认',
      payload: { command: 'sbxmeme.avatar', avatar: 'javascript:alert(1)' },
      expect: (t) => t.includes('sender=' + DEFAULT_AVATAR),
    },
    {
      name: '快捷方式写法：标记能传到子命令里',
      payload: { command: '短横 hello' },
      expect: (t) => t.includes('key=hello') && t.includes('memesApi=truthy') && t.includes('shortcut=true'),
    },
    {
      name: '子命令写法：memesApi 读不到（复现上游 bug，见下方说明）',
      payload: { command: 'sbxmeme.generate hello' },
      expect: (t) => t.includes('memesApi=undefined') && t.includes('shortcut=THREW'),
    },
    {
      name: '诊断：session.memesApi 能否读到',
      payload: { command: 'sbxmeme.diag' },
      expect: () => true,
    },
  ];

  let pass = 0;
  console.log('=== 沙盒用户身份探针 ===');
  console.log('默认头像: ' + DEFAULT_AVATAR);

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
    console.log('    -> ' + res.text.slice(0, 300));
  }

  console.log('---');
  console.log('通过 ' + pass + '/' + cases.length);

  process.exit(pass === cases.length ? 0 : 1);
})().catch((error) => {
  console.error('FATAL', (error && error.stack) || error);
  process.exit(2);
});
