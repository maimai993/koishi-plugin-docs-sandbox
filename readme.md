# koishi-plugin-docs-sandbox

> **【自用】** 这个插件是为我自己的 bot（[koi.tangbot.xyz](https://koi.tangbot.xyz)）和文档站
> [docs.tangbot.xyz](https://docs.tangbot.xyz) 写的，接口和默认值都按那边的需要来。
> 发到 npm 只是方便 `yarn add` 安装，不保证通用性，也基本不会为别的部署方式做适配。

把**运行中的 bot 指令**变成在线沙盒：文档站、控制台或任何前端都能直接试运行，
拿到的就是机器人真正发出来的内容。

作者：maimai2025 `<2237886846@qq.com>`

## 它怎么做到「真」

不重新加载插件、不 mock。直接借用当前 koishi 实例：

1. 挂一个隐藏的虚拟机器人（平台 `sandbox`），`sendMessage` 不发到任何真实平台，只把内容交给我们；
2. 收到请求时构造一个会话，`bot.dispatch(session)` 走完整中间件 —— 指令解析、插件 action、数据库全是真的；
3. 抓回机器人发出的一切，转成 JSON 返回。

请求之间**串行执行**：抓取依赖共享缓冲区，并发会串味。

## 接口

| 地址 | 说明 |
|------|------|
| `/sandbox` | 聊天式试运行界面（自带，无需构建） |
| `/sandbox/api/health` | 健康检查，返回可用指令数 |
| `/sandbox/api/commands` | 可用指令列表 |
| `/sandbox/api/run` | POST，body 见下（`?stream=1` 走 NDJSON 边跑边发） |
| `/sandbox/files/<id>/<文件名>` | 机器人发出来的媒体、沙盒临时媒体 |

控制台侧边栏也会多出一个「在线沙盒」页面（iframe 上面的界面）。

### `/api/run` 的 body

```jsonc
{
  "command": "像素化",
  "images": ["https://docs.tangbot.xyz/assets/xxx.png"],  // 图片：URL / data URL / base64://
  "audios": ["https://example.com/hello.wav"],            // 语音：同上（voices 是别名）
  "sessionId": "sbx...",                                  // 同一个 id 视为同一段对话
  "userId": "user",
  "userName": "沙盒用户",
  "avatar": "https://q1.qlogo.cn/g?b=qq&nk=123456&s=640",  // 可选，覆盖沙盒用户的头像
  "voiceType": "audio"                                    // 语音元素类型：audio / record
}
```

**附件可以由网络提供**：`images` / `audios` 里给 http(s) 地址，沙盒会自己下载再交给插件
（单个体积上限 `maxRemoteMediaBytes`，同一 URL 5 分钟内走缓存）。
这样前端不必把几 MB 的图片压成 base64 塞进请求体 —— 文档站的图片类示例就是靠这个才跑得起来的。
本地路径 / 不存在的地址 / 超时，都会返回一句明确的 `图片获取失败：…`，不会静静地没反应。

`command` 与附件可以只给其一（纯发图 / 纯发语音也行）。

### 沙盒用户的身份（头像）

沙盒没有真实用户，但不少插件会去**要头像**：memes-api 的表情包生成就是
「先看 `session.event.user.avatar`，再问 `bot.getUser()`，都拿不到就抛
`User xxx in platform sandbox has no avatar`」—— 以前沙盒的假用户只给了 `id` 和 `name`，
所以「表情包生成」整页示例一进去就炸。

现在沙盒会给假用户带上头像（`sandboxAvatar`，默认是文档里「麦麦」那张 QQ 头像），
并实现 `bot.getUser(userId)` —— `@某人` 时也回同一份身份，让这类插件能正常跑完。

- 想换成别的头像：改配置 `sandboxAvatar`，或单次请求带 `avatar`（只认 http(s)，其它值忽略）
- 昵称同样是可配的（`sandboxUser`）；它会被写进表情包里的文字，所以想和文档一致就一并改
- 机器人的头像用 `selfAvatar`（默认文档里「麦芽糖bot」那张）

## 安装

```bash
yarn add koishi-plugin-docs-sandbox@latest
# 或
npm i koishi-plugin-docs-sandbox
```

## 配置

| 项 | 默认 | 说明 |
|----|------|------|
| `enabled` | `true` | 是否启用 |
| `path` | `/sandbox` | 挂载路径 |
| `origins` | `['*']` | 允许跨域的来源，建议收窄成文档站域名。留空等同 `*` |
| `allowLocalhost` | `true` | 始终放行 `localhost` / `127.0.0.1` 来源 |
| `apiKey` | 空 | 留空公开；填了就要请求头带 `x-sandbox-key` |
| `rateLimit` | `60` | 每 IP 每分钟执行上限 |
| `waitMs` | `2600` | 一直没输出时最多等多久 |
| `streamWaitMs` | `45000` | 流式模式下等第一段输出的上限 |
| `maxWaitMs` | `30000` | 已有输出后继续等待的总上限 |
| `idleMs` | `700` | 输出静默多久就认为说完了 |
| `maxCommandLength` | `500` | 单条指令最大长度 |
| `publicUrl` | 空 | 对外地址（如 `https://koi.tangbot.xyz`）。留空按请求 Host 推断，用于把媒体链接拼成绝对地址 |
| `maxImages` | `3` | 一次最多附带几张图片 |
| `maxImageBytes` | `4000000` | 上传图片总大小上限（base64 字符数，约 3MB 原图） |
| `maxAudios` | `2` | 一次最多附带几段语音 |
| `maxRemoteMediaBytes` | `12582912` | 从网络拉取单个附件的体积上限（12MB） |
| `voiceElement` | `audio` | 语音附件用的元素类型；有些插件按 OneBot 习惯只认 `record` |
| `inlineImageBytes` | `262144` | 机器人返回的图片小于它就内联成 data URL，超过则走 `/files` 独立请求 |
| `mediaTtlMs` | `1800000` | 沙盒临时媒体保留时长（30 分钟） |
| `silkSampleRate` | `24000` | SILK 转码采样率 |
| `mediaFetchMs` | `20000` | 下载媒体链接的超时 |
| `consoleAuthority` | `1` | 控制台页面所需权限等级 |
| `sandboxUser` | `沙盒用户` | 沙盒会话里显示的昵称 |
| `sandboxAvatar` | 麦麦的 QQ 头像 | 沙盒用户的头像。要头像的插件（memes-api 等）靠它；留空则不提供 |
| `selfAvatar` | 麦芽糖bot 的头像 | 沙盒机器人的头像 |
| `blockedCommands` | 见下 | 禁止执行的指令 |
| `allowCommands` | `[]` | 白名单，留空表示除黑名单外全放行 |

### CORS 规则

`origins` 支持通配，`*` **只匹配一级**子域：

```yaml
origins:
  - https://docs.tangbot.xyz
  - https://*.tangbot.xyz      # 匹配 kkk.tangbot.xyz，不匹配 a.b.tangbot.xyz
```

规则末尾有 `$` 锚定，所以 `https://*.tangbot.xyz` 不会放行 `https://tangbot.xyz.evil.com`。
匹配到具体来源时会回显该来源并带上 `Access-Control-Allow-Credentials`；
被拒的来源只会在服务端日志里 warn 一次，不影响其它请求。

`allowLocalhost` 默认开启，所以本地 `pnpm docs:dev`（localhost 任意端口）
不需要额外配 `origins` 就能连上。

默认黑名单（能执行 shell / 改库 / 后台管理）：

```
spawn-modified  sudo  shutdown  exec  exit  restart  reload
database-operate  command-creater  command-creator-extender
qq-chat  screenshot  verifier  explorer  shell
```

## 和文档站配合

文档仓库的 `src/.vuepress/client/sandbox.ts` 默认连 `https://koi.tangbot.xyz`，
代码块里第一条可识别的指令会挂上「▶ 试运行」按钮。

要指向别的后端：

```html
<script>window.__SANDBOX_API__ = 'https://koi.tangbot.xyz'</script>
```

页面里的 `<chat-demo>` 组件（`src/.vuepress/components/ChatDemo.vue`）也走这个接口：
它会把示例图的**真实 URL**（站点内的 `assets` 地址）作为 `image` 发过来，由沙盒去取图，
所以图片类示例（像素化 / 手办化 / GIF…）在文档里也能直接跑。语音示例用 `audio` 属性。

## 自测

```bash
node scripts/probe-attachments.cjs
node scripts/probe-user-identity.cjs
```

**`probe-attachments.cjs`** 会起一个真实 koishi 实例 + 一个只会把收到的附件原样报回来的探针指令，
再用本地静态服务当「网络」，验证：网络图片 URL、网络语音 URL、两者同时、
老写法 data URL（兼容）、`voices` 别名、404、超时 —— 共 7 个用例。

**`probe-user-identity.cjs`** 复刻 memes-api 的取头像逻辑（`session.event.user.avatar` →
`bot.getUser()` → 抛错）与它的快捷方式中间件，验证：默认 / 自定义 / 请求内指定的头像、
非法地址回退、`@某人` 也拿得到头像、快捷方式写法能把标记传进子命令 —— 共 7 个用例。

> 顺手记录一个上游坑：memes-api 的错误处理器写的是 `config.silentShortcut && session.memesApi.shortcut`，
> 而 `session.memesApi` 只在**快捷方式**那条路里被赋值（`(session.memesApi ??= {}).shortcut = true`）。
> 所以用**子命令**写法（`meme generate xxx`）触发任何报错时，它会自己抛
> `Cannot read properties of undefined (reading 'shortcut')`，把真正的错误盖掉。
> 文档里的示例都是快捷方式写法，不受影响；要修的话是上游那一行少了个 `?.`。

## 安全

这个插件会**真的执行指令**，默认只放行黑名单之外的指令，并带限流。
要上公网请至少：收窄 `origins`、设置 `apiKey`、把 koishi 放在反代后面。

## 怎么装进 bot

```bash
cd /path/to/koishi
yarn add koishi-plugin-docs-sandbox
```

然后在 `koishi.yml` 里：

```yaml
plugins:
  docs-sandbox:
    path: /sandbox
    origins:
      - https://docs.tangbot.xyz
    publicUrl: https://koi.tangbot.xyz
    rateLimit: 60
```

开发时也可以直接把整个目录丢进 bot 的 `node_modules/`。

## License

GPL-3.0-only（和我的另一个插件 `koishi-plugin-kkk` 保持一致）
