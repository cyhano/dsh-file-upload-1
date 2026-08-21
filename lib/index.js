/**
 * dsh-file-upload — Host 半
 *
 * 提供 POST /api/file-upload/save：接收浏览器传来的 base64 文件内容，
 * 解码保存到当前会话项目目录 uploads/，返回绝对路径。
 *
 * 客户端把路径文本插入输入框，模型或外挂视觉工具（dsh-vision 的
 * view_image 等）按绝对路径读取文件——不绑定任何具体视觉插件。
 *
 * 纯 Node 实现（node:fs），跨平台：macOS / Linux / Windows 均可用，
 * 不依赖系统 base64 命令；路径由 node:path join 生成，跟随平台分隔符。
 */
import { mkdir, writeFile } from 'node:fs/promises'
import { randomUUID } from 'node:crypto'
import { join, sep, resolve } from 'node:path'
import { installSettingsSection, settingsNamespace } from '@deepseek-ai/dsh-settings'
import Schema from '@deepseek-ai/schemastery'

export const name = 'dsh-file-upload'
export const inject = ['webServer', 'sessions']

/** 设置命名空间 */
const NS = settingsNamespace('dsh-file-upload')

/** 可配置项 schema：上传目录 + 前缀文本 */
const SettingsSchema = Schema.object({
  // 上传落盘根目录；留空则回退 /tmp
  uploadDir: Schema.string().default(''),
  // 插入输入框时的前缀文本；留空表示不带前缀
  prefix: Schema.string().default('[上传文件]'),
})

/** 原始文件内容上限（前端 25MB 留安全余量，见 client.js MAX_FILE_BYTES） */
const MAX_RAW_BYTES = 30 * 1024 * 1024
/** base64 编码后上限（≈ 原始 × 4/3），由此推导避免两端数值漂移 */
const MAX_BASE64_BYTES = Math.ceil((MAX_RAW_BYTES * 4) / 3)
/** 请求体上限（base64 上限 + sessionId/name 字段开销） */
const MAX_BODY_BYTES = MAX_BASE64_BYTES + 256 * 1024
/** 并发上传上限：防恶意/异常场景 N 个大请求打爆内存 */
const MAX_CONCURRENT = 3

/** 文件夹上传：整体 base64 总量上限（约 60MB）与请求体上限（70MB） */
const MAX_FOLDER_BASE64_BYTES = 60 * 1024 * 1024
const MAX_FOLDER_BODY_BYTES = 70 * 1024 * 1024

/** 上传落盘根目录：优先 DSH_UPLOAD_DIR 环境变量，其次设置项 uploadDir，否则 /tmp */
function defaultUploadRoot() {
  return process.env.DSH_UPLOAD_DIR || join(sep, 'tmp')
}

/** 解析配置里的 uploadDir：空串/未配置回退 defaultUploadRoot() */
function resolveUploadDir(cfg) {
  const dir = cfg && typeof cfg.uploadDir === 'string' && cfg.uploadDir.trim() !== ''
    ? cfg.uploadDir.trim()
    : ''
  return dir !== '' ? resolve(dir) : defaultUploadRoot()
}

/** 解析配置里的 prefix：空串表示不带前缀 */
function resolvePrefix(cfg) {
  return cfg && typeof cfg.prefix === 'string' ? cfg.prefix : ''
}

// 同源校验（P1 修复，照 perm-guard 先例）：Origin 存在时必须为本机页面，
// 缺失时（curl 等）校验 Host 头是本机——防跨站页面 CSRF 式写入。
function isSameOrigin(req) {
  const origin = req.headers.origin || ''
  if (origin !== '') return /^https?:\/\/(127\.0\.0\.1|localhost)(:\d+)?$/.test(origin)
  const host = req.headers.host || ''
  return /^(127\.0\.0\.1|localhost)(:\d+)?$/.test(host)
}

function readBody(req, res, maxBytes) {
  return new Promise((resolveBody, reject) => {
    const chunks = []
    let total = 0
    let aborted = false
    req.on('data', (chunk) => {
      total += chunk.length
      if (total > maxBytes) {
        aborted = true
        // 先回 413 再销毁连接（销毁后响应未必送达，但语义正确；客户端有兜底）
        try {
          res.writeHead(413, { 'content-type': 'application/json' })
          res.end(JSON.stringify({ ok: false, error: '请求体过大' }))
        } catch (e) { /* 连接已异常 */ }
        req.destroy()
        reject(new Error(`request body too large (>${maxBytes} bytes)`))
        return
      }
      chunks.push(chunk)
    })
    req.on('end', () => {
      if (aborted) return
      try {
        const text = Buffer.concat(chunks).toString('utf8')
        resolveBody(text === '' ? {} : JSON.parse(text))
      } catch (error) {
        reject(error)
      }
    })
    req.on('error', reject)
  })
}

function writeJson(res, status, body) {
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
  })
  res.end(JSON.stringify(body))
}

/**
 * 文件名净化：去掉路径成分与跨平台危险字符，保留中文/字母数字/._- 空格。
 * 兼容 Windows：排除 \ / : * ? " < > | 与尾部 . 空格；
 * 保留名（CON/PRN/AUX/NUL/COM1-9/LPT1-9）由时间戳前缀天然规避。
 */
function sanitizeName(name) {
  const base = String(name || '').split(/[\\/]/).pop() || ''
  const cleaned = base
    .replace(/[^\w\u4e00-\u9fa5.\- ]/gu, '_')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/[. ]+$/, '')
  if (cleaned === '' || cleaned === '.' || cleaned === '..') return 'file'
  return cleaned.slice(0, 120)
}

export function apply(ctx) {
  const webServer = ctx.webServer
  const sessions = ctx.sessions
  if (webServer === undefined || sessions === undefined) return

  // 可配置项：安装设置命名空间（dsh < 0.1.0-rc.7 无 settings 服务时自动降级，
  // 仅靠环境变量 + schema 默认值运行）。
  const entry = { uploadDir: '', prefix: '[上传文件]' }
  let source = () => entry
  installSettingsSection(ctx, NS, SettingsSchema, entry, {
    setSource: (current) => { source = current },
    onChange: () => {},
  })
  const readConfig = () => source()
  const uploadRoot = () => resolveUploadDir(readConfig())

  let inFlight = 0

  ctx.effect(() => webServer.register({
    kind: 'exact',
    path: '/api/file-upload/save',
    handler: async (req, res) => {
      if (!isSameOrigin(req)) {
        return writeJson(res, 403, { ok: false, error: 'forbidden: cross-origin request' })
      }
      if (inFlight >= MAX_CONCURRENT) {
        return writeJson(res, 429, { ok: false, error: '上传太频繁，请稍候再试' })
      }
      inFlight += 1
      try {
        const body = await readBody(req, res, MAX_BODY_BYTES)
        const sessionId = typeof body.sessionId === 'string' ? body.sessionId : ''
        const name = typeof body.name === 'string' ? body.name : ''
        const base64 = typeof body.base64 === 'string' ? body.base64 : ''
        if (sessionId === '' || name === '') {
          return writeJson(res, 400, { ok: false, error: '参数不完整' })
        }
        if (base64 === '') {
          return writeJson(res, 400, { ok: false, error: '文件内容为空，无法上传' })
        }
        if (base64.length > MAX_BASE64_BYTES) {
          return writeJson(res, 400, { ok: false, error: '文件过大（超过 30MB）' })
        }
        if (!/^[A-Za-z0-9+/]+={0,2}$/.test(base64)) {
          return writeJson(res, 400, { ok: false, error: '文件内容无效' })
        }

        const session = sessions.get(sessionId)
        if (session === undefined) {
          return writeJson(res, 400, { ok: false, error: '会话不存在，请刷新后重试' })
        }
        const cwd = session.header?.cwd
        if (typeof cwd !== 'string' || cwd === '') {
          return writeJson(res, 400, { ok: false, error: '当前会话没有工作目录' })
        }

        // 纯 Node 落盘：mkdir -p + 解码写文件（跨平台，无 shell/命令依赖）；
        // 随机串前缀防同毫秒同名并发覆盖
        const fileName = `${Date.now()}-${randomUUID().slice(0, 8)}-${sanitizeName(name)}`
        const dir = uploadRoot()
        await mkdir(dir, { recursive: true })
        const bytes = Buffer.from(base64, 'base64')
        await writeFile(join(dir, fileName), bytes)

        return writeJson(res, 200, {
          ok: true,
          path: join(dir, fileName),
          name: fileName,
          prefix: resolvePrefix(readConfig()),
        })
      } catch (error) {
        // 细节只进日志，响应脱敏（不泄漏服务端路径等细节）
        console.error('[dsh-file-upload] save failed:', error)
        return writeJson(res, 500, {
          ok: false,
          error: '保存失败：磁盘写入错误',
        })
      } finally {
        inFlight -= 1
      }
    },
  }), 'dsh-file-upload.route')

  // 文件夹上传：接收 { sessionId, folderName, files: [{ path, base64 }] }，
  // 在 uploadRoot()/<时间戳-文件夹名>/ 下按原相对路径重建目录树。
  // 只返回文件夹路径一行，不展开内部文件（客户端决定列什么）。
  ctx.effect(() => webServer.register({
    kind: 'exact',
    path: '/api/file-upload/save-folder',
    handler: async (req, res) => {
      if (!isSameOrigin(req)) {
        return writeJson(res, 403, { ok: false, error: 'forbidden: cross-origin request' })
      }
      try {
        const body = await readBody(req, res, MAX_FOLDER_BODY_BYTES)
        const sessionId = typeof body.sessionId === 'string' ? body.sessionId : ''
        const folderName = typeof body.folderName === 'string' ? body.folderName : ''
        const files = Array.isArray(body.files) ? body.files : []
        if (sessionId === '' || folderName === '' || files.length === 0) {
          return writeJson(res, 400, { ok: false, error: '参数不完整' })
        }

        let totalBase64 = 0
        for (const f of files) {
          const rel = typeof f.path === 'string' ? f.path : ''
          const b64 = typeof f.base64 === 'string' ? f.base64 : ''
          if (rel === '' || b64 === '') {
            return writeJson(res, 400, { ok: false, error: '文件列表参数不完整' })
          }
          if (!/^[A-Za-z0-9+/]+={0,2}$/.test(b64)) {
            return writeJson(res, 400, { ok: false, error: '文件内容无效："' + rel + '"' })
          }
          totalBase64 += b64.length
          if (totalBase64 > MAX_FOLDER_BASE64_BYTES) {
            return writeJson(res, 400, { ok: false, error: '文件夹总大小超过 60MB' })
          }
        }

        const session = sessions.get(sessionId)
        if (session === undefined) {
          return writeJson(res, 400, { ok: false, error: '会话不存在，请刷新后重试' })
        }

        // 文件夹根：/tmp/<时间戳-安全化文件夹名>/
        const safeFolder = sanitizeName(folderName)
        const root = join(uploadRoot(), `${Date.now()}-${safeFolder}`)
        await mkdir(root, { recursive: true })

        for (const f of files) {
          // 相对路径逐段净化，防止 ../ 逃逸出根目录
          const segs = String(f.path).split(/[\\/]/).map(sanitizeName)
          const dest = join(root, ...segs)
          await mkdir(join(dest, '..'), { recursive: true })
          const bytes = Buffer.from(f.base64, 'base64')
          await writeFile(dest, bytes)
        }

        return writeJson(res, 200, { ok: true, path: root, name: safeFolder, prefix: resolvePrefix(readConfig()) })
      } catch (error) {
        console.error('[dsh-file-upload] save-folder failed:', error)
        return writeJson(res, 500, { ok: false, error: '文件夹保存失败：磁盘写入错误' })
      }
    },
  }), 'dsh-file-upload.folder-route')
}
