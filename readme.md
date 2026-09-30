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
| `/sandbox/api/run` | POST，body 为 `{ command, userId?, userName?, channelId? }` |

控制台侧边栏也会多出一个「在线沙盒」页面（iframe 上面的界面）。

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
| `inlineImageBytes` | `262144` | 机器人返回的图片小于它就内联成 data URL，超过则走 `/files` 独立请求 |
| `mediaTtlMs` | `1800000` | 沙盒临时媒体保留时长（30 分钟） |
| `silkSampleRate` | `24000` | SILK 转码采样率 |
| `mediaFetchMs` | `20000` | 下载媒体链接的超时 |
| `consoleAuthority` | `1` | 控制台页面所需权限等级 |
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
