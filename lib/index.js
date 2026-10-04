/**
 * docs-sandbox —— 把 bot 的真实指令变成在线沙盒 API。
 *
 * 它不重新加载插件：直接借用运行中的 koishi 实例，挂一个隐藏的虚拟机器人，
 * 收到请求时构造会话、走完整中间件、把机器人真实发出的内容抓回来。
 *
 * 文档站 / 控制台 / 任何前端都能通过 HTTP 调用，权限交给 koishi 管。
 */
const fs = require('node:fs')
const path = require('node:path')
const { Schema, Bot, h } = require('koishi')

const name = 'docs-sandbox'
const PLATFORM = 'sandbox'
const SELF_ID = 'sandbox'

/** 能执行 shell / 改数据库 / 后台管理的插件，默认不给跑 */
const DEFAULT_BLOCKED = [
  'spawn-modified', 'sudo', 'shutdown', 'exec', 'exit', 'restart', 'reload',
  'database-operate', 'command-creater', 'command-creator-extender',
  'qq-chat', 'screenshot', 'verifier', 'explorer', 'shell',
]

const Config = Schema.object({
  enabled: Schema.boolean().default(true).description('是否启用在线沙盒接口。'),
  path: Schema.string().default('/sandbox').description('挂载路径，例如 /sandbox。'),
  origins: Schema.array(String).default(['*'])
    .description('允许跨域调用的来源。支持 * 通配，例如 https://*.tangbot.xyz。留空等同 *。'),
  allowLocalhost: Schema.boolean().default(true)
    .description('始终放行 localhost / 127.0.0.1 来源，方便本地调试文档站。'),
  apiKey: Schema.string().role('secret').default('')
    .description('访问密钥。留空表示公开；填了就要求请求头带 x-sandbox-key。'),
  rateLimit: Schema.number().default(60).description('每 IP 每分钟最多执行多少次。'),
  waitMs: Schema.number().default(8000).description('一直没输出时最多等多久（毫秒）。AI 问答类指令要留足。'),
  streamWaitMs: Schema.number().default(45000).description('已注册指令等第一段输出的上限（毫秒）。流式界面本来就在转圈，可以耐心等。'),
  flowWaitMs: Schema.number().default(6000)
    .description('会话进行中、且发来的不是指令时（多轮流程的「完成」之类）等第一段输出的上限。'),
  plainWaitMs: Schema.number().default(2500)
    .description('冷会话里发来不是指令的内容时，最多等多久就判定「没反应」。打错字不该让人干等。'),
  maxWaitMs: Schema.number().default(120000).description('已有输出后继续等待的总上限（毫秒）。AI 图片生成可能要一分钟以上。'),
  idleMs: Schema.number().default(2500).description('输出静默多久就认为这条指令说完了（毫秒）。'),
  streamIdleMs: Schema.number().default(60000)
    .description('流式模式下输出静默多久才算说完。图片生成这类「先回一句请稍候、几十秒后才出图」的指令靠它。'),
  maxCommandLength: Schema.number().default(500).description('单条指令最大长度。'),
  publicUrl: Schema.string().default('')
    .description('对外访问地址，例如 https://koi.tangbot.xyz。留空则按请求的 Host 推断。用于把媒体链接拼成绝对地址。'),
  mediaTtlMs: Schema.number().default(1800000).description('沙盒临时媒体文件保留多久（毫秒），默认 30 分钟。'),
  silkSampleRate: Schema.number().default(24000).description('SILK 转码用的采样率。'),
  mediaFetchMs: Schema.number().default(20000).description('下载机器人给出的媒体链接的超时（毫秒）。'),
  maxImages: Schema.number().default(3).description('一次最多附带几张图片。'),
  maxImageBytes: Schema.number().default(4000000)
    .description('附带图片的总大小上限（按 base64 字符数算，约 3MB 原图）。前端会先压缩，这里是兜底。'),
  maxAudios: Schema.number().default(2).description('一次最多附带几段语音。'),
  maxRemoteMediaBytes: Schema.number().default(12582912)
    .description('从网络拉取单个附件（图片 / 语音）的体积上限（字节），默认 12MB。'),
  voiceElement: Schema.string().default('audio')
    .description('把语音附件塞进会话时用的元素类型。Koishi 原生是 audio；有些插件按 OneBot 习惯只认 record。'),
  inlineImageBytes: Schema.number().default(262144)
    .description('机器人返回的图片小于这个体积就直接内联成 data URL；超过就落到 /files 走独立请求，避免把 JSON 撑爆。'),
  showInConsole: Schema.boolean().default(true).description('在控制台侧边栏显示沙盒页面。'),
  consoleAuthority: Schema.number().default(1).description('控制台页面所需权限等级。'),
  blockedCommands: Schema.array(String).default(DEFAULT_BLOCKED)
    .description('禁止执行的指令（按首位词匹配，通常是插件名）。'),
  allowCommands: Schema.array(String).default([])
    .description('只允许这些指令。留空表示除 blockedCommands 外全部允许。'),
  sandboxUser: Schema.string().default('沙盒用户').description('沙盒会话里显示的昵称。'),
  sandboxAvatar: Schema.string().default('https://q1.qlogo.cn/g?b=qq&nk=2237886846&s=640')
    .description('沙盒用户的默认头像（默认用文档里「麦麦」的头像）。memes-api 这类「拿不到头像就不干活」的插件靠它跑通；留空则不提供。'),
  selfAvatar: Schema.string().default('https://q1.qlogo.cn/g?b=qq&nk=2854208746&s=640')
    .description('沙盒机器人的头像（默认用文档里「麦芽糖bot」的头像）。'),
})

/** 隐藏的虚拟机器人：消息走完整中间件，但发出去的东西被我们截胡 */
class SandboxBot extends Bot {
  constructor(ctx, identity) {
    super(ctx, { platform: PLATFORM, selfId: SELF_ID }, PLATFORM)
    this.hidden = true
    this.status = 1
    this.platform = PLATFORM
    this.selfId = SELF_ID
    this.setIdentity(identity)
    this.user = { id: SELF_ID, name: '沙盒', avatar: (identity && identity.selfAvatar) || '' }
    this.activeIdentity = null
    this.capture = null
    this.activeChannel = ''
    this.activeUser = ''
    this.activeSession = null
  }

  setIdentity(identity) {
    const opt = identity || {}
    this.identity = {
      name: opt.userName || '沙盒用户',
      avatar: opt.userAvatar || '',
    }
  }

  /**
   * 真机上这一步由适配器向平台查资料。沙盒没有真实用户，就回配置里的默认身份。
   * memes-api 的取头像逻辑是「先看 session.event.user.avatar，再问 bot.getUser，
   * 都拿不到就抛 User xxx in platform sandbox has no avatar」——
   * 以前沙盒只给了 id 和 name，所有表情包指令一进去就炸。
   * @某人 时同样回这个身份：沙盒里本来就只有一个假人。
   */
  async getUser(userId) {
    const id = this.activeIdentity || this.identity || { name: '', avatar: '' }
    return { id: userId, name: id.name, nick: id.name, avatar: id.avatar }
  }

  /**
   * 每次请求用独立的频道 id。慢指令（AI 问答、截图）的回复可能晚于本次等待窗口才到，
   * 那时下一个请求已经开始了 —— 只认自己频道的内容，迟到的一律丢弃，
   * 否则会出现「上一条的回答串到下一条」。
   */
  async sendMessage(channelId, content) {
    if (this.capture && channelId === this.activeChannel) {
      try {
        let elements = h.normalize(content)
        // 真机上这一步由 adapter 的消息编码器做：把 <i18n> / <execute> 这类
        // 组件元素渲染成最终内容。我们绕过了编码器，得自己补上，
        // 否则页面上会直接看到 <i18n path="commands.status.messages.status.1"/>
        if (this.activeSession && typeof this.activeSession.transform === 'function') {
          elements = await this.activeSession.transform(elements)
        }
        this.capture.push(...elements)
      } catch (error) { /* 忽略 */ }
    }
    // 必须回一个消息 id。真机上适配器会返回真实 id，插件拿它做引用回复 / 撤回；
    // 返回空数组会被判成「消息没发出去」，kkk 这类插件会直接抛
    // UnconfirmedSendError: 发送失败：没有拿到消息 ID
    return [this.nextMessageId()]
  }

  nextMessageId() {
    this.messageSeq = (this.messageSeq || 0) + 1
    return 'sbx-msg-' + this.messageSeq
  }

  async deleteMessage(channelId, messageId) {
    // 插件常会撤回自己发的「正在处理…」；沙盒里没有真实消息，直接当成功
    return true
  }

  async sendPrivateMessage(userId, content) {
    if (this.capture && (userId === this.activeUser || userId === this.activeChannel)) {
      try { this.capture.push(...h.normalize(content)) } catch (error) { /* 忽略 */ }
    }
    return [this.nextMessageId()]
  }
}

function ensureBot(ctx, config) {
  const identity = {
    userName: (config && config.sandboxUser) || '沙盒用户',
    userAvatar: (config && config.sandboxAvatar) || '',
    selfAvatar: (config && config.selfAvatar) || '',
  }
  let bot = ctx.bots.find((item) => item && item.platform === PLATFORM && item.selfId === SELF_ID)
  if (!bot) {
    bot = new SandboxBot(ctx, identity)
    try { ctx.bots.push(bot) } catch (error) { ctx.logger.warn('注册虚拟机器人失败:', error) }
  } else if (typeof bot.setIdentity === 'function') {
    // 配置改了（头像 / 昵称）要跟着变，别一直用第一次构造出来的那份
    bot.setIdentity(identity)
    if (bot.user) bot.user.avatar = identity.selfAvatar
  }
  return bot
}

/** 图片地址统一成 <img src> 能直接用的形式 */
function toImageUrl(src) {
  if (!src) return ''
  if (Buffer.isBuffer(src) || src instanceof Uint8Array) {
    return 'data:image/png;base64,' + Buffer.from(src).toString('base64')
  }
  if (typeof src === 'object' && src.data) {
    return toImageUrl(src.data)
  }
  if (typeof src === 'string') {
    if (src.startsWith('base64://')) return 'data:image/png;base64,' + src.slice(9)
    return src
  }
  return ''
}

// ---- 媒体 ----------------------------------------------------------------
const SILK_MAGIC = '#!SILK'

/** SILK 的文件头是 \x02#!SILK_V3 之类，前若干字节里带这个标记 */
function looksLikeSilk(buf) {
  if (!buf || buf.length < 12) return false
  return buf.slice(0, 12).toString('latin1').includes(SILK_MAGIC)
}

/** 给裸 PCM 套一个 WAV 头，浏览器就能直接播 */
function pcmToWav(pcm, sampleRate) {
  const head = Buffer.alloc(44)
  head.write('RIFF', 0)
  head.writeUInt32LE(36 + pcm.length, 4)
  head.write('WAVE', 8)
  head.write('fmt ', 12)
  head.writeUInt32LE(16, 16)
  head.writeUInt16LE(1, 20)
  head.writeUInt16LE(1, 22)
  head.writeUInt32LE(sampleRate, 24)
  head.writeUInt32LE(sampleRate * 2, 28)
  head.writeUInt16LE(2, 32)
  head.writeUInt16LE(16, 34)
  head.write('data', 36)
  head.writeUInt32LE(pcm.length, 40)
  return Buffer.concat([head, pcm])
}

/** 能从元素属性里同步拿到的字节；http 链接拿不到（返回 null） */
function sourceBuffer(src) {
  if (!src) return null
  if (Buffer.isBuffer(src)) return src
  if (src instanceof Uint8Array) return Buffer.from(src)
  if (typeof src === 'object' && src.data) return sourceBuffer(src.data)
  if (typeof src === 'string') {
    if (src.startsWith('base64://')) return Buffer.from(src.slice(9), 'base64')
    const m = /^data:([^;,]+)?(;base64)?,([\s\S]*)$/.exec(src)
    if (m) return m[2] ? Buffer.from(m[3], 'base64') : Buffer.from(decodeURIComponent(m[3]), 'utf8')
  }
  return null
}

function sourceUrl(src) {
  return typeof src === 'string' && /^(https?:)?\/\//.test(src) ? src : ''
}

/** 从属性里猜个文件名 */
function mediaName(attrs, fallback) {
  const raw = attrs.name || attrs.title || attrs.filename
  if (raw) return String(raw)

  const src = String(attrs.src || attrs.url || attrs.file || '')
  // base64:// 和 data: 不是路径，别拿它当文件名（会得到一长串 base64）
  if (src && !/^(base64:|data:)/i.test(src)) {
    const path = src.replace(/^file:\/\/+/, '').split('?')[0].split('#')[0]
    const last = decodeURIComponent(path.split(/[\\/]/).filter(Boolean).pop() || '')
    if (last && last.length <= 120) return last
  }
  return fallback
}

/**
 * 把机器人发出去的元素转成前端能渲染的 JSON。
 * convertMedia 由 apply 注入，负责把音频/文件落到可访问的地址上（可能要做 SILK 解码）。
 */
async function serialize(elements, convertMedia) {
  const out = []
  for (const el of elements || []) {
    if (!el || !el.type) continue
    const attrs = el.attrs || {}
    // satori 里图片元素的 type 是 'img'，不是 'image'；两者都要认
    const type = el.type === 'img' ? 'image' : el.type
    switch (type) {
      case 'text':
        if (attrs.content) out.push({ type: 'text', text: String(attrs.content) })
        break
      case 'br':
        out.push({ type: 'text', text: '\n' })
        break
      case 'at':
        out.push({ type: 'text', text: '@' + (attrs.id || '') })
        break
      case 'markdown':
      case 'markdowns':
        // 插件直接塞的 markdown 元素（例如 mcqa 的 AI 回答），原样交给前端渲染
        if (attrs.content) out.push({ type: 'markdown', text: String(attrs.content) })
        break
      case 'image': {
        let handled = null
        if (convertMedia) {
          try { handled = await convertMedia(attrs, 'image') } catch (error) { handled = null }
        }
        if (!handled) {
          const url = toImageUrl(attrs.src || attrs.url || attrs.file)
          handled = url ? { type: 'image', url } : null
        }
        out.push(handled || { type: 'text', text: '[图片]' })
        break
      }
      case 'audio':
      case 'record':
      case 'video':
      case 'file': {
        const kind = type === 'record' ? 'audio' : type
        let handled = null
        if (convertMedia) {
          try { handled = await convertMedia(attrs, kind) } catch (error) { handled = null }
        }
        out.push(handled || { type: 'text', text: '[' + kind + ']' })
        break
      }
      case 'quote':
        break
      // 适配器会用 <p> 包段落（status 这类多平台状态就是这么发的）。
      // 直接 toString() 会吐出一堆 HTML 标签，必须递归展开。
      case 'p':
      case 'message':
      case 'root':
        if (el.children && el.children.length) out.push(...await serialize(el.children, convertMedia))
        out.push({ type: 'text', text: '\n' })
        break
      default: {
        let text = ''
        try { text = el.toString() } catch (error) { text = '' }
        if (text && text !== '[object Object]') out.push({ type: 'text', text })
      }
    }
  }
  return mergeText(out)
}

/**
 * 把相邻的文本片段拼成一条消息。
 * 适配器发一条消息常常是 [文本, <p>文本</p>, <i18n/>, <p>…] 这样一串元素，
 * 不合并的话前端会把每个片段渲染成独立气泡。
 */
function mergeText(items) {
  const out = []
  for (const item of items) {
    const last = out[out.length - 1]
    if (item.type === 'text' && last && last.type === 'text') last.text += item.text
    else out.push(Object.assign({}, item))
  }
  for (const item of out) {
    if (item.type === 'text') item.text = item.text.replace(/\n{3,}/g, '\n\n').trim()
  }
  return out.filter((item) => item.type !== 'text' || item.text)
}

function apply(ctx, config) {
  if (!config.enabled) return

  const base = ('/' + String(config.path || '/sandbox').replace(/^\/+|\/+$/g, '')).replace(/\/+$/, '') || '/sandbox'
  const htmlFile = path.join(__dirname, '../assets/index.html')
  const bot = ensureBot(ctx, config)

  // ---- 媒体仓库 ----------------------------------------------------------
  // 机器人发出来的音频/文件不方便塞进 JSON（SILK 浏览器也放不了），
  // 统一落到磁盘，再通过 /files/<id>/<name> 提供，顺便给下载留个正经名字。
  const mediaDir = path.join(ctx.baseDir || process.cwd(), 'data', 'docs-sandbox', 'media')
  const mediaIndex = new Map()
  try { fs.mkdirSync(mediaDir, { recursive: true }) } catch (error) { /* 忽略 */ }

  const MIME_BY_EXT = {
    '.wav': 'audio/wav', '.mp3': 'audio/mpeg', '.ogg': 'audio/ogg', '.m4a': 'audio/mp4',
    '.silk': 'audio/silk', '.amr': 'audio/amr', '.flac': 'audio/flac',
    '.mp4': 'video/mp4', '.webm': 'video/webm', '.gif': 'image/gif',
    '.pdf': 'application/pdf', '.zip': 'application/zip', '.txt': 'text/plain; charset=utf-8',
    '.json': 'application/json', '.apk': 'application/vnd.android.package-archive',
  }

  function mimeFor(name, fallback) {
    const ext = path.extname(String(name || '')).toLowerCase()
    return MIME_BY_EXT[ext] || fallback || 'application/octet-stream'
  }

  function saveMedia(buffer, name, mime) {
    const id = Date.now().toString(36) + Math.random().toString(36).slice(2, 8)
    const safe = String(name || 'file').replace(/[\\/:*?"<>|]/g, '_').slice(-120) || 'file'
    const ext = path.extname(safe)
    const file = path.join(mediaDir, id + ext)
    fs.writeFileSync(file, buffer)
    mediaIndex.set(id, { file, name: safe, type: mime, at: Date.now() })
    return {
      id,
      name: safe,
      size: buffer.length,
      url: base + '/files/' + id + '/' + encodeURIComponent(safe),
    }
  }

  // 过期清理，别把磁盘堆满
  ctx.setInterval(() => {
    const now = Date.now()
    for (const [id, item] of mediaIndex) {
      if (now - item.at < config.mediaTtlMs) continue
      try { fs.unlinkSync(item.file) } catch (error) { /* 忽略 */ }
      mediaIndex.delete(id)
    }
  }, 60000)

  /** 把音视频/文件落到可访问地址上；SILK 顺手转成浏览器能播的 WAV */
  async function convertMedia(attrs, kind) {
    const src = attrs.src || attrs.url || attrs.file
    const direct = sourceUrl(src)
    let buffer = sourceBuffer(src)
    const DEFAULTS = { audio: '语音.silk', video: '视频.mp4', image: '图片.png', file: '文件.bin' }
    const rawName = mediaName(attrs, DEFAULTS[kind] || '文件.bin')

    // 图片最常见，单独一条路径：
    // 小图内联成 data URL（省一次请求），大图落盘（否则一个截图就能把响应撑到几 MB）
    if (kind === 'image') {
      if (!buffer && direct) {
        // 明文 http 的图在 https 文档站上会被浏览器当混合内容拦掉，拉下来落到本地更稳
        if (/^http:\/\//i.test(direct) && httpService()) {
          try { buffer = await httpBuffer(direct) } catch (error) { buffer = null }
        }
        if (!buffer) return { type: 'image', url: direct }
      }
      if (!buffer) return null
      const mime = mimeFor(rawName, attrs.type || 'image/png')
      if (buffer.length <= config.inlineImageBytes) {
        return { type: 'image', url: 'data:' + mime + ';base64,' + buffer.toString('base64') }
      }
      const saved = saveMedia(buffer, rawName, mime)
      return { type: 'image', url: saved.url, name: saved.name, size: saved.size }
    }

    if (kind === 'audio') {
      if (!buffer && direct) {
        // 远端语音：SILK 浏览器放不了，先拉下来转 WAV；其它格式（mp3/ogg…）直接给链接，省一次下载
        const remoteSilk = /\.silk(\?|#|$)/i.test(direct)
          || String(attrs.type || '').toLowerCase().includes('silk')
        if (remoteSilk && httpService()) {
          try { buffer = await httpBuffer(direct) } catch (error) { buffer = null }
        }
        if (!buffer) return { type: 'audio', url: direct, name: rawName }
      }
      if (!buffer) return null

      const wantSilk = String(attrs.type || '').toLowerCase().includes('silk')
        || /\.silk$/i.test(rawName)
        || looksLikeSilk(buffer)

      let data = buffer
      let name = rawName
      let note = ''
      if (wantSilk) {
        const silk = ctx.silk || ctx.get('silk')
        if (silk) {
          try {
            const decoded = await silk.decode(buffer, config.silkSampleRate)
            const pcm = Buffer.from(decoded.data || decoded)
            data = pcmToWav(pcm, config.silkSampleRate)
            name = rawName.replace(/\.[^.]+$/, '') + '.wav'
            note = 'SILK 已转码为 WAV'
          } catch (error) {
            note = 'SILK 解码失败：' + ((error && error.message) || error)
          }
        } else {
          note = 'bot 未加载 silk 服务，SILK 无法转码播放'
        }
      }
      const saved = saveMedia(data, name, mimeFor(name, attrs.type))
      return { type: 'audio', url: saved.url, name: saved.name, size: saved.size, note }
    }

    if (kind === 'video') {
      if (!buffer) return direct ? { type: 'video', url: direct, name: rawName } : null
      const saved = saveMedia(buffer, rawName, mimeFor(rawName, attrs.type || 'video/mp4'))
      return { type: 'video', url: saved.url, name: saved.name, size: saved.size }
    }

    // file：尽量落到本地，这样前端能显示真实文件名和大小，也方便下载
    if (buffer) {
      const saved = saveMedia(buffer, rawName, mimeFor(rawName, attrs.type))
      return { type: 'file', url: saved.url, name: saved.name, size: saved.size }
    }
    if (direct) {
      try {
        const http = ctx.http || ctx.get('http')
        if (http) {
          const res = await http.get(direct, { responseType: 'arraybuffer', timeout: config.mediaFetchMs })
          const saved = saveMedia(Buffer.from(res), rawName, mimeFor(rawName, attrs.type))
          return { type: 'file', url: saved.url, name: saved.name, size: saved.size }
        }
      } catch (error) { /* 拉不下来就直接给原链接 */ }
      return { type: 'file', url: direct, name: rawName }
    }
    return null
  }

  // ---- 网络附件 ----------------------------------------------------------
  // 前端（文档站）可以只给一个 URL，由沙盒自己去把图片 / 语音拉下来。
  // 这样示例图不必压成 base64 塞进请求体（几 MB 的 base64 会把请求撑爆、直接超时），
  // 图片类指令才有机会在线跑起来。
  const remoteCache = new Map()
  const REMOTE_CACHE_TTL = 5 * 60 * 1000

  function httpService() { return ctx.http || ctx.get('http') }

  async function httpBuffer(url) {
    const http = httpService()
    if (!http) throw new Error('bot 未加载 http 服务')
    const res = await http.get(url, { responseType: 'arraybuffer', timeout: config.mediaFetchMs })
    return Buffer.from(res)
  }

  /** 是沙盒自己的 /files/<id> 就直接读盘，不用再绕一圈网络 */
  function localMediaBuffer(url) {
    let pathname = ''
    try { pathname = new URL(url, 'http://local').pathname } catch (error) { return null }
    const marker = base + '/files/'
    const at = pathname.indexOf(marker)
    if (at < 0) return null
    const id = pathname.slice(at + marker.length).split('/')[0]
    const item = mediaIndex.get(id)
    if (!item) return null
    try { return fs.readFileSync(item.file) } catch (error) { return null }
  }

  async function fetchRemoteBuffer(url) {
    const hit = remoteCache.get(url)
    if (hit && Date.now() - hit.at < REMOTE_CACHE_TTL) return hit.buf

    const local = localMediaBuffer(url)
    if (local) return local

    const buf = await httpBuffer(url)
    if (!buf.length) throw new Error('拿到的是空内容')
    if (buf.length > config.maxRemoteMediaBytes) {
      throw new Error('体积约 ' + Math.round(buf.length / 1048576) + ' MB，超过上限')
    }
    remoteCache.set(url, { buf, at: Date.now() })
    return buf
  }

  /** 把各种来源（data URL / base64:// / 网络 URL）统一成插件直接能吃的 base64:// */
  async function resolveAttachment(src) {
    const s = String(src || '').trim()
    if (!s) return ''
    const inline = sourceBuffer(s)
    if (inline) return 'base64://' + inline.toString('base64')
    if (/^\/\//.test(s)) return 'base64://' + (await fetchRemoteBuffer('https:' + s)).toString('base64')
    if (/^https?:\/\//i.test(s)) return 'base64://' + (await fetchRemoteBuffer(s)).toString('base64')
    return s
  }

  function shortSource(src) {
    const s = String(src || '')
    return s.length > 80 ? s.slice(0, 77) + '…' : s
  }

  /** 解析请求里的图片 / 语音附件；失败直接抛，让调用方给出清楚的一句话 */
  async function resolveAttachments(options) {
    const opt = options || {}
    const pick = (value, max) => (Array.isArray(value) ? value : [])
      .filter((item) => typeof item === 'string' && item.trim())
      .slice(0, max)
    const groups = [
      { key: 'images', label: '图片', list: pick(opt.images, config.maxImages) },
      { key: 'audios', label: '语音', list: pick(opt.audios || opt.voices, config.maxAudios) },
    ]
    const resolved = { images: [], audios: [] }
    for (const group of groups) {
      for (const src of group.list) {
        try {
          const out = await resolveAttachment(src)
          if (out) resolved[group.key].push(out)
        } catch (error) {
          throw new Error(group.label + '获取失败：' + ((error && error.message) || error)
            + '（' + shortSource(src) + '）')
        }
      }
    }
    return resolved
  }

  // ---- 指令表 ------------------------------------------------------------
  function allCommands() {
    const list = []
    const commander = ctx.$commander || ctx.get('commander')
    if (commander && commander._commandList) {
      for (const cmd of commander._commandList) {
        if (cmd && cmd.name && cmd.name !== 'command') list.push(cmd.name)
      }
    }
    return list
  }

  function blockedRoot(root) {
    return config.blockedCommands.some((item) => item.toLowerCase() === root.toLowerCase())
  }

  function availableCommands() {
    const allow = config.allowCommands
    return allCommands().filter((item) => {
      const root = item.split(/\s|\./)[0]
      if (blockedRoot(root)) return false
      if (allow.length && !allow.includes(root) && !allow.includes(item)) return false
      return true
    }).sort()
  }

  function knownRoot(root) {
    if (!root) return false
    for (const item of allCommands()) {
      const head = item.split(/[\s.]/)[0]
      if (head === root || item === root) return true
    }
    return false
  }

  // 会话活跃度：用来区分「多轮流程里的一步」和「纯打字打错了」。
  // 冷会话收到非指令内容就快速收工，别让人干等。
  const lastSeen = new Map()
  const FLOW_WINDOW = 5 * 60 * 1000

  function isWarm(sessionId) {
    if (!sessionId) return false
    const at = lastSeen.get(sessionId)
    return !!at && Date.now() - at < FLOW_WINDOW
  }

  // ---- 限流 --------------------------------------------------------------
  const hits = new Map()
  function limited(ip) {
    const now = Date.now()
    const arr = (hits.get(ip) || []).filter((t) => now - t < 60000)
    if (arr.length >= config.rateLimit) { hits.set(ip, arr); return true }
    arr.push(now)
    hits.set(ip, arr)
    return false
  }
  ctx.setInterval(() => {
    const now = Date.now()
    for (const [sid, at] of lastSeen) {
      if (now - at > FLOW_WINDOW) { lastSeen.delete(sid); queues.delete(sid) }
    }
    for (const [ip, arr] of hits) {
      const keep = arr.filter((t) => now - t < 60000)
      if (keep.length) hits.set(ip, keep)
      else hits.delete(ip)
    }
  }, 120000)

  // ---- CORS --------------------------------------------------------------
  const LOCAL_RE = /^https?:\/\/(localhost|127\.0\.0\.1|\[::1\])(:\d+)?$/
  const warnedOrigins = new Set()

  function escapeRe(text) {
    return text.replace(/[.*+?^$()|[\]{}\\]/g, '\\$&')
  }

  function allowList() {
    return (config.origins && config.origins.length) ? config.origins : ['*']
  }

  function originAllowed(origin) {
    if (!origin) return false
    const allow = allowList()
    if (allow.includes('*')) return true
    if (config.allowLocalhost !== false && LOCAL_RE.test(origin)) return true
    for (const rule of allow) {
      if (!rule) continue
      if (rule === origin) return true
      if (rule.indexOf('*') >= 0) {
        // * 只匹配一级，避免 https://*.a.com 意外放行 a.b.a.com（结尾有 $ 锚定，x.a.com.evil.com 依然被拒）
        const pattern = '^' + rule.split('*').map(escapeRe).join('[^./]*') + '$'
        try { if (new RegExp(pattern).test(origin)) return true } catch (error) { /* 规则写错就跳过 */ }
      }
    }
    return false
  }

  function applyCors(koaCtx) {
    const origin = koaCtx.get('origin')
    koaCtx.vary('Origin')
    const allow = allowList()

    if (allow.includes('*')) {
      koaCtx.set('Access-Control-Allow-Origin', '*')
    } else if (origin && originAllowed(origin)) {
      koaCtx.set('Access-Control-Allow-Origin', origin)
      koaCtx.set('Access-Control-Allow-Credentials', 'true')
    } else if (origin && !warnedOrigins.has(origin)) {
      warnedOrigins.add(origin)
      ctx.logger.warn('跨域来源被拒绝: ' + origin + '（origins=' + JSON.stringify(allow) + '，放行 localhost=' + (config.allowLocalhost !== false) + '）')
    }

    koaCtx.set('Access-Control-Allow-Headers', 'content-type,x-sandbox-key')
    koaCtx.set('Access-Control-Allow-Methods', 'GET,POST,OPTIONS')
    koaCtx.set('Access-Control-Max-Age', '86400')
  }

  function authorized(koaCtx) {
    if (!config.apiKey) return true
    const given = koaCtx.get('x-sandbox-key') || ''
    if (given.length !== config.apiKey.length) return false
    let diff = 0
    for (let i = 0; i < given.length; i++) diff |= given.charCodeAt(i) ^ config.apiKey.charCodeAt(i)
    return diff === 0
  }

  // ---- 串行执行 ----------------------------------------------------------
  // 抓取缓冲区在同一个机器人实例上，所以「同一段会话」必须排队，避免回复串味。
  // 但不同会话之间可以并发 —— 否则一个跑了 40 秒的图片生成会把所有人堵在后面。
  const queues = new Map()
  // 同会话来了新请求时，让上一条的「等待后续输出」立刻收工。
  // 注意：只有「排队中的新请求」才置位，当前正在跑的那条不能被自己打断。
  const pendingNew = new Set()
  function exclusive(key, task) {
    const prev = queues.get(key) || Promise.resolve()
    const run = prev.then(task, task)
    queues.set(key, run.then(() => undefined, () => undefined))
    return run
  }

  /**
   * 不再死等一个固定时长：
   *  - 还没有任何输出 -> 最多等 waitMs
   *  - 已经有输出 -> 只要连续 idleMs 没新内容就收工，总时长不超过 maxWaitMs
   * 截图 / 渲染类指令要好几秒，固定窗口会把它们整条漏掉。
   */
  async function settle(buffer, onNew, firstBudget, idleMs, sessionKey) {
    const step = 100
    const start = Date.now()
    const budget = firstBudget || config.waitMs
    const idle = idleMs || config.idleMs
    let sent = 0
    let lastChange = start
    for (;;) {
      await new Promise((resolve) => setTimeout(resolve, step))
      const now = Date.now()
      if (buffer.length > sent) {
        const fresh = buffer.slice(sent)
        sent = buffer.length
        lastChange = now
        if (onNew) {
          try { await onNew(fresh) } catch (error) { /* 下游断开就忽略 */ }
        }
      }
      const elapsed = now - start
      // 用户已经发了下一条 —— 别再傻等这条的「后续」了
      if (sessionKey && pendingNew.has(sessionKey)) return
      if (elapsed >= config.maxWaitMs) return
      if (sent > 0 && now - lastChange >= idle) return
      if (sent === 0 && elapsed >= budget) return
    }
  }

  let runSeq = 0

  function normalizeAt(items, userName, mediaOrigin) {
    for (const item of items) {
      if (item.type === 'text' && item.text) item.text = item.text.replace(/@\d{5,}/g, '@' + userName)
      // 媒体是相对路径的话，前端会拿文档站的域名去找 —— 必须补成沙盒自己的绝对地址
      if (item.url && item.url.startsWith('/') && mediaOrigin) item.url = mediaOrigin + item.url
    }
    return items
  }

  /**
   * 沙盒用户的头像：请求里带了 http(s) 地址就用它，
   * 否则用配置里的默认值（默认是文档里「麦麦」那张 QQ 头像）。
   */
  function userAvatarOf(options) {
    const raw = options && typeof options.avatar === 'string' ? options.avatar.trim() : ''
    if (/^https?:\/\//i.test(raw)) return raw
    return String(config.sandboxAvatar || '').trim()
  }

  function runCommand(command, options, onNew, firstBudget, idleMs) {
    const sessionKey = String((options && options.sessionId) || '') || 'anon'
    return exclusive(sessionKey, async () => {
      // 轮到自己跑了，把「有新请求」的标记摘掉，免得被它打断自己
      pendingNew.delete(sessionKey)
      // 会话 id 由前端持久化：同一个「对话」复用同一个频道，
      // 插件按频道保存的多轮状态（例如拼图先收图再合成）才能延续。
      // 前端没给就退化成一次性频道。
      const sid = String((options && options.sessionId) || '').replace(/[^A-Za-z0-9_-]/g, '').slice(0, 40)
      const channelId = sid ? ('sbx:' + sid) : ('sbx-' + (++runSeq) + '-' + Date.now().toString(36))
      const userId = (options && options.userId) || 'user'
      const userName = (options && options.userName) || config.sandboxUser
      const userAvatar = userAvatarOf(options)
      const mediaOrigin = (options && options.mediaOrigin) || ''

      // 附件在这里统一落地：data URL / base64:// 原样解出，网络 URL 由沙盒代拉。
      // 放到 dispatch 之前，失败了就直接抛出，让前端看到一句「图片获取失败：…」。
      const attachments = await resolveAttachments(options)
      const voiceType = String((options && options.voiceType) || config.voiceElement || 'audio') === 'record'
        ? 'record' : 'audio'

      const session = bot.session({
        type: 'message',
        channel: { id: channelId, type: 0 },
        guild: { id: channelId },
        // avatar / nick 都带上：memes-api 直接读 session.event.user.avatar，
        // 缺了它会抛「User user in platform sandbox has no avatar」。
        user: { id: userId, name: userName, nick: userName, avatar: userAvatar },
        // session.author 会把 member 合进 user，顺手给群名片类字段兜个底
        member: { name: userName, nick: userName },
        message: { id: bot.nextMessageId() },
        timestamp: Date.now(),
      })
      // 顺序：文字 → 图片 → 语音。
      // 文字放最前面是因为指令解析只看文字部分；插件通常用
      // h.select(session.elements, 'img') / h.select(..., 'audio') 取附件。
      const elements = []
      if (command) elements.push(...h.parse(command))
      for (const src of attachments.images) elements.push(h('img', { src: src }))
      for (const src of attachments.audios) elements.push(h(voiceType, { src: src }))
      if (elements.length) session.elements = elements
      else session.content = command

      const buffer = []
      bot.capture = buffer
      bot.activeChannel = channelId
      bot.activeUser = userId
      bot.activeSession = session
      // bot.getUser() 也要按本次请求的身份回（@某人 走的就是它）
      bot.activeIdentity = { name: userName, avatar: userAvatar }
      try {
        bot.dispatch(session)
        await settle(
          buffer,
          onNew ? async (fresh) => onNew(normalizeAt(await serialize(fresh, convertMedia), userName, mediaOrigin)) : null,
          firstBudget, idleMs, sessionKey,
        )
      } finally {
        // 关掉抓取，并清掉归属 —— 之后迟到的回复会被直接丢弃
        bot.capture = null
        bot.activeChannel = ''
        bot.activeUser = ''
        bot.activeSession = null
        bot.activeIdentity = null
      }

      return normalizeAt(await serialize(buffer, convertMedia), userName, mediaOrigin)
    })
  }

  // ---- 路由 --------------------------------------------------------------
  const json = (koaCtx, code, body) => {
    applyCors(koaCtx)
    koaCtx.status = code
    koaCtx.type = 'application/json; charset=utf-8'
    koaCtx.body = JSON.stringify(body)
  }

  ctx.server.options(base + '(.*)', (koaCtx) => {
    applyCors(koaCtx)
    koaCtx.status = 204
    koaCtx.body = ''
  })

  ctx.server.get(base + '/api/health', (koaCtx) => {
    json(koaCtx, 200, { ok: true, service: name, path: base, commands: availableCommands().length })
  })

  ctx.server.get(base + '/api/commands', (koaCtx) => {
    json(koaCtx, 200, { commands: availableCommands() })
  })

  // 新建会话：只要换一个 sessionId（前端生成）即可；这里顺带告知约定
  ctx.server.get(base + '/api/session', (koaCtx) => {
    json(koaCtx, 200, {
      hint: '把返回的 sessionId 随每次 /api/run 一起提交，同一个 id 视为同一段对话',
      sessionId: 'sbx' + Date.now().toString(36) + Math.random().toString(36).slice(2, 8),
    })
  })

  ctx.server.post(base + '/api/run', async (koaCtx) => {
    if (!authorized(koaCtx)) return json(koaCtx, 401, { error: '密钥不正确' })
    const ip = koaCtx.ip || 'unknown'
    if (limited(ip)) return json(koaCtx, 429, { error: '请求过于频繁，请稍后再试' })

    const payload = koaCtx.request.body || {}
    const command = String(payload.command || '').trim().slice(0, config.maxCommandLength)
    const images = Array.isArray(payload.images)
      ? payload.images.filter((item) => typeof item === 'string' && item).slice(0, config.maxImages)
      : []
    // 语音：audios / voices 都认（前端习惯叫法不一样）
    const audios = Array.isArray(payload.audios)
      ? payload.audios.filter((item) => typeof item === 'string' && item).slice(0, config.maxAudios)
      : (Array.isArray(payload.voices)
        ? payload.voices.filter((item) => typeof item === 'string' && item).slice(0, config.maxAudios)
        : [])

    if (!command && !images.length && !audios.length) {
      return json(koaCtx, 400, { error: 'command 不能为空' })
    }

    // 只拦黑名单，不拦「未注册的指令」——
    // 多轮流程大量依赖普通文本（拼图发完图要发「完成」、菜单回数字等），
    // 那些不是指令，而是插件用消息监听器接的，一刀切会把它们全挡掉。
    const root = command ? command.split(/\s/)[0].split('.')[0] : ''
    if (root && blockedRoot(root)) {
      return json(koaCtx, 200, { supported: false, outputs: [], error: '该指令已被沙盒禁用' })
    }

    const mediaOrigin = config.publicUrl
      || koaCtx.origin
      || ((koaCtx.protocol || 'http') + '://' + (koaCtx.host || 'localhost'))
    const runOptions = Object.assign({}, payload, { images, audios, mediaOrigin })
    const imageBytes = images.reduce((sum, item) => sum + item.length, 0)
    if (imageBytes > config.maxImageBytes) {
      return json(koaCtx, 413, { error: '图片太大了（约 ' + Math.round(imageBytes / 1048576) + ' MB），请压缩后再试' })
    }

    // 等多久，取决于这次发来的东西有多「可能真的有反应」
    const sid = String(payload.sessionId || '').replace(/[^A-Za-z0-9_-]/g, '').slice(0, 40)
    const warm = isWarm(sid)
    const known = !command || knownRoot(root)
    let firstBudget
    if (!command) {
      firstBudget = config.streamWaitMs          // 纯发图片：一定有插件在处理
    } else if (known) {
      firstBudget = config.streamWaitMs          // 注册指令：可能很慢（AI 问答、截图）
    } else if (warm) {
      firstBudget = config.flowWaitMs            // 会话进行中：多半是多轮流程的一步
    } else {
      firstBudget = config.plainWaitMs           // 冷会话 + 非指令：基本就是打错字了
    }
    if (sid) {
      lastSeen.set(sid, Date.now())
      // 标记「这个会话有新请求在排队」，让上一条的等待立刻收工；
      // 轮到新请求自己跑的时候会摘掉这个标记
      pendingNew.add(sid)
    }

    // ?stream=1 -> 用 NDJSON 边收边发，慢指令（AI 问答 / 截图）不会再被等待窗口截断
    const wantStream = String(koaCtx.query.stream || '') === '1'
    if (wantStream) {
      koaCtx.respond = false
      const res = koaCtx.res
      const headers = {
        'content-type': 'application/x-ndjson; charset=utf-8',
        'cache-control': 'no-store',
        'x-accel-buffering': 'no',
      }
      const allow = allowList()
      const origin = koaCtx.get('origin')
      if (allow.includes('*')) headers['access-control-allow-origin'] = '*'
      else if (origin && originAllowed(origin)) {
        headers['access-control-allow-origin'] = origin
        headers['access-control-allow-credentials'] = 'true'
      }
      headers.vary = 'Origin'
      res.writeHead(200, headers)

      let closed = false
      res.on('close', () => { closed = true })
      const write = (obj) => { if (!closed) { try { res.write(JSON.stringify(obj) + '\n') } catch (error) { closed = true } } }

      try {
        await runCommand(command, runOptions, (fresh) => write({ type: 'chunk', outputs: fresh }), firstBudget, config.streamIdleMs)
        // 把「这是不是一条真指令」告诉前端，好让「没反应」的提示说得准确
        write({ type: 'done', known, warm })
      } catch (error) {
        write({ type: 'error', error: '执行出错：' + (error && error.message) })
        write({ type: 'done' })
      }
      if (!closed) res.end()
      return
    }

    try {
      const outputs = await runCommand(command, runOptions, null, firstBudget, config.idleMs)
      json(koaCtx, 200, { supported: true, outputs })
    } catch (error) {
      json(koaCtx, 200, { supported: true, outputs: [{ type: 'text', text: '执行出错：' + (error && error.message) }] })
    }
  })

  ctx.server.get(base, (koaCtx) => {
    applyCors(koaCtx)
    koaCtx.type = 'html'
    koaCtx.body = fs.createReadStream(htmlFile)
  })

  // 机器人发出来的媒体：/files/<id>/<文件名>
  ctx.server.get(base + '/files/(.*)', (koaCtx) => {
    applyCors(koaCtx)
    const rest = String((koaCtx.params && koaCtx.params[0]) || '')
    const id = rest.split('/')[0]
    const item = mediaIndex.get(id)
    if (!item || !fs.existsSync(item.file)) {
      koaCtx.status = 404
      koaCtx.body = 'not found'
      return
    }
    koaCtx.type = item.type || mimeFor(item.name)
    koaCtx.set('content-disposition', 'inline; filename*=UTF-8\'\'' + encodeURIComponent(item.name))
    koaCtx.body = fs.createReadStream(item.file)
  })

  // 静态资源（vendored 的 marked 等）。注册在最后，API 路由优先命中。
  const assetsDir = path.join(__dirname, '../assets')
  ctx.server.get(base + '/(.*)', (koaCtx) => {
    const name = String((koaCtx.params && koaCtx.params[0]) || '')
    if (!name || name.indexOf('..') >= 0) { koaCtx.status = 404; return }
    const file = path.resolve(assetsDir, name)
    if (!file.startsWith(assetsDir) || !fs.existsSync(file) || !fs.statSync(file).isFile()) {
      koaCtx.status = 404
      return
    }
    applyCors(koaCtx)
    koaCtx.type = path.extname(file)
    koaCtx.body = fs.createReadStream(file)
  })

  // ---- 控制台页面 --------------------------------------------------------
  const console = ctx.get('console')
  if (console && config.showInConsole && console.addEntry) {
    try {
      console.addEntry({
        dev: path.join(__dirname, '../dist'),
        prod: path.join(__dirname, '../dist'),
      })
    } catch (error) {
      ctx.logger.warn('注册控制台页面失败:', error)
    }
  }
  ctx.inject(['console'], (c) => {
    if (!config.showInConsole) return
    c.console.addListener('docs-sandbox/status', () => ({
      path: base,
      commands: availableCommands().length,
    }), { authority: config.consoleAuthority })
  })

  ctx.logger.info('在线沙盒已挂载: ' + base + '（可用指令 ' + availableCommands().length + ' 条）')
}

module.exports = {
  name,
  Config,
  apply,
  // silk / ffmpeg 声明成可选：没有也不报错，只是音频不做转码
  inject: { required: ['server'], optional: ['console', 'database', 'http', 'silk', 'ffmpeg'] },
}
