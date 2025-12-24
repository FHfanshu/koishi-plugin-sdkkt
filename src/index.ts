import { Context, Schema, h, Session } from 'koishi'
import { extractMetadata, formatMetadataResult } from './extractor'
import { fetchImage } from './fetcher'
import { ImageSegment, makeImageSegmentKey, LRUCache } from './utils'
import { promises as fs } from 'fs'
import path from 'path'

export const name = 'sdexif'

export interface Config {
  useForward: boolean
  enableDebugLog: boolean
  privateOnly: boolean
  groupAutoParseWhitelist: string[]
  preferFileCache?: boolean
  spyEnabled?: boolean
  spyGroups?: string[]
  spyTargetChannel?: string
  maxFileSize?: number
  messageSplitThreshold?: number
  enableDedupe?: boolean
  enableCache?: boolean
  cacheMaxSize?: number
  embedImageInNormalMode?: boolean
  globalDedupeEnabled?: boolean
  globalDedupeCacheSize?: number
  globalDedupeTimeout?: number
  groupFileRetryDelay?: number
  groupFileRetryCount?: number
}

export const Config: Schema<Config> = Schema.intersect([
  // 基础设置
  Schema.object({
    enableDebugLog: Schema.boolean()
      .default(false)
      .description('是否启用调试日志（用于排查图片接收问题）'),
    privateOnly: Schema.boolean()
      .default(false)
      .description('是否仅在私聊中启用')
  }).description('基础'),

  // 输出/合并转发
  Schema.object({
    useForward: Schema.boolean()
      .default(false)
      .description('是否使用合并转发格式发送消息'),
    embedImageInNormalMode: Schema.boolean()
      .default(false)
      .description('普通模式（非合并转发）下是否嵌入图片')
  }).description('输出与显示'),

  // 视奸监听
  Schema.object({
    spyEnabled: Schema.boolean()
      .default(false)
      .description('视奸开关：在指定群中监听图片并转发到目标频道'),
    spyGroups: Schema.array(Schema.string())
      .default([])
      .description('视奸监听的群聊 ID 列表，支持 `group:123456` 或 `123456`'),
    spyTargetChannel: Schema.string()
      .description('视奸转发目标频道 ID，例如 `private:123456` 或 `group:654321`')
  }).description('视奸'),

  // 自动解析（群白名单）
  Schema.object({
    groupAutoParseWhitelist: Schema.array(Schema.string())
      .default([])
      .description('群聊白名单：在这些群聊中自动解析图片（无需命令），为空则禁用')
  }).description('自动解析'),

  // 解析与限制
  Schema.object({
    maxFileSize: Schema.number()
      .default(10 * 1024 * 1024)
      .description('允许解析的最大图片文件大小（字节）'),
    messageSplitThreshold: Schema.number()
      .default(2000)
      .description('长消息分割的字符阈值（单条消息最大长度）'),
    enableDedupe: Schema.boolean()
      .default(true)
      .description('是否对重复图片进行去重处理'),
    globalDedupeEnabled: Schema.boolean()
      .default(true)
      .description('是否启用跨消息去重（防止引用消息重复解析）'),
    globalDedupeCacheSize: Schema.number()
      .default(100)
      .description('全局去重缓存大小（记录最近处理的图片数量）'),
    globalDedupeTimeout: Schema.number()
      .default(300000)
      .description('全局去重缓存超时时间（毫秒，默认5分钟）'),
    groupFileRetryDelay: Schema.number()
      .default(2000)
      .description('群文件获取重试延迟（毫秒）- QQ群文件首次获取可能返回压缩图，需等待后重试'),
    groupFileRetryCount: Schema.number()
      .default(2)
      .description('群文件获取重试次数（默认2次）')
  }).description('解析与限制'),

  // 缓存
  Schema.object({
    enableCache: Schema.boolean()
      .default(true)
      .description('是否启用缓存机制'),
    cacheMaxSize: Schema.number()
      .default(100 * 1024 * 1024)
      .description('缓存目录最大大小（字节）'),
    preferFileCache: Schema.boolean()
      .default(false)
      .description('是否优先使用文件缓存（实验性）')
  }).description('缓存')
])

let CACHE_DIR: string
let cacheDirEnsured = false

// Global deduplication cache
interface ProcessedImageEntry {
  timestamp: number
  channelId: string
  userId?: string
}
let globalProcessedImages: LRUCache<string, ProcessedImageEntry> | null = null

export function apply(ctx: Context, config: Config) {
  const logger = ctx.logger('sdexif')
  
  // Initialize cache directory path using ctx.baseDir for stability
  CACHE_DIR = path.join(ctx.baseDir, 'data', 'sdexif')

  // Initialize global deduplication cache
  if (config.globalDedupeEnabled !== false && !globalProcessedImages) {
    const cacheSize = config.globalDedupeCacheSize ?? 100
    globalProcessedImages = new LRUCache<string, ProcessedImageEntry>(cacheSize)
    logger.info(`全局去重缓存已初始化，大小: ${cacheSize}, 超时: ${config.globalDedupeTimeout ?? 300000}ms`)
  }

  // Initialize and manage cache system
  async function ensureCacheDirectory() {
    if (config.enableCache === false) return
    if (cacheDirEnsured) return

    try {
      await fs.mkdir(CACHE_DIR, { recursive: true })
      cacheDirEnsured = true

      // Check cache size if cacheMaxSize is configured
      if (config.cacheMaxSize && config.cacheMaxSize > 0) {
        await cleanupCacheIfNeeded()
      }
    } catch (e) {
      logger.warn('无法创建缓存目录:', e)
    }
  }

  async function cleanupCacheIfNeeded() {
    if (config.enableCache === false) return
    if (!config.cacheMaxSize || config.cacheMaxSize <= 0) return

    try {
      const files = await fs.readdir(CACHE_DIR)
      let totalSize = 0
      const fileStats: { path: string; size: number; mtime: Date }[] = []

      for (const file of files) {
        const filePath = path.join(CACHE_DIR, file)
        try {
          const stat = await fs.stat(filePath)
          if (stat.isFile()) {
            totalSize += stat.size
            fileStats.push({
              path: filePath,
              size: stat.size,
              mtime: stat.mtime
            })
          }
        } catch {
          // Skip files that can't be accessed
        }
      }

      // If total size exceeds limit, delete oldest files
      if (totalSize > config.cacheMaxSize) {
        logger.info(`缓存大小 ${(totalSize / 1024 / 1024).toFixed(2)}MB 超过限制 ${(config.cacheMaxSize / 1024 / 1024).toFixed(2)}MB，开始清理`)

        // Sort by modification time (oldest first)
        fileStats.sort((a, b) => a.mtime.getTime() - b.mtime.getTime())

        let deletedSize = 0
        const targetSize = config.cacheMaxSize * 0.8 // Keep 80% of max size

        for (const file of fileStats) {
          if (totalSize - deletedSize <= targetSize) break

          try {
            await fs.unlink(file.path)
            deletedSize += file.size
            logger.debug(`删除缓存文件: ${path.basename(file.path)} (${(file.size / 1024 / 1024).toFixed(2)}MB)`)
          } catch {
            // Skip files that can't be deleted
          }
        }

        logger.info(`清理完成，删除 ${(deletedSize / 1024 / 1024).toFixed(2)}MB`)
      }
    } catch (e) {
      logger.warn('缓存清理失败:', e)
    }
  }

  // Helper function to check if channel ID is in list
  function isChannelInList(channelId: string | undefined, list: string[]): boolean {
    const chId = String(channelId || '')
    const normalized = chId.replace(/^(?:private|group|guild|channel):/i, '')
    return list.includes(chId) || list.includes(normalized) || list.includes(`group:${normalized}`)
  }

  // Helper function to send auto-parsed results
  async function sendAutoParseResult(
    session: Session,
    resp: string | h[] | (string | h)[] | void,
    targetChannel?: string
  ): Promise<boolean> {
    if (!resp) return false
    if (typeof resp === 'string') {
      if (resp === '未能从图片中读取到 Stable Diffusion 信息') return false
      if (targetChannel) {
        await session.bot?.sendMessage(targetChannel, resp)
      } else {
        await session.send(resp)
      }
      return true
    }
    if (Array.isArray(resp)) {
      if (targetChannel) {
        await session.bot?.sendMessage(targetChannel, resp)
      } else {
        await session.send(resp)
      }
      return true
    }
    return false
  }

  ctx.command('sdexif', '读取图片中的 Stable Diffusion 信息')
    .alias('读图')
    .option('withImage', '-i 在发送结果时包含图片')
    .shortcut('sdexif', { fuzzy: true })
    .shortcut('读图', { fuzzy: true })
    .action(async ({ session, options }) => {
      if (!session) return '无法获取会话信息'

      if (config.privateOnly && !session.isDirect) {
        return
      }

      if (config.enableDebugLog) {
        logger.info('收到 sdexif 命令:', {
          platform: session.platform,
          channelId: session.channelId,
          userId: session.userId,
          content: session.content,
          elementsCount: session.elements?.length || 0
        })
      }

      await ensureCacheDirectory()

      const segments = await collectImageSegments(session, config.enableDebugLog, logger, config)

      if (segments.length === 0) {
        return '请在发送命令的同时附带图片，或引用回复包含图片的消息'
      }

      if (config.enableDebugLog) {
        logger.info(`检测到 ${segments.length} 个图片元素，开始处理`)
      }

      // In normal mode, check if command option -i is used, or if config is set to embed images
      const shouldEmbed = !!options?.withImage || (!config.useForward && config.embedImageInNormalMode)
      const response = await processImages(ctx, session, segments, config, logger, false, shouldEmbed)
      return response
    })

  // Spy middleware: forward images from monitored groups to target channel
  ctx.middleware(async (session, next) => {
    try {
      if (!config.spyEnabled) return next()
      if (!session || session.isDirect) return next()

      const groups = Array.isArray(config.spyGroups) ? config.spyGroups : []
      if (groups.length === 0) return next()

      if (!isChannelInList(session.channelId, groups)) return next()

      const target = (config.spyTargetChannel || '').trim()
      if (!target) return next()
      
      // Enhanced loop protection: check both raw and normalized IDs
      const chId = String(session.channelId || '')
      const normalized = chId.replace(/^(?:private|group|guild|channel):/i, '')
      const normalizedTarget = target.replace(/^(?:private|group|guild|channel):/i, '')
      if (target === chId || normalizedTarget === chId || normalizedTarget === normalized) return next()

      await ensureCacheDirectory()
      const segments = await collectImageSegments(session, config.enableDebugLog, logger, config)
      if (segments.length === 0) return next()

      const forcedConfig = { ...config, useForward: true } as Config
      const resp = await processImages(ctx, session, segments, forcedConfig, logger, true, true)
      
      await sendAutoParseResult(session, resp, target)
      return
    } catch (e: any) {
      if (config.enableDebugLog) {
        logger.warn('视奸转发处理中发生错误', e)
      }
      return next()
    }
  })

  // Group whitelist middleware: auto-parse images in whitelisted groups
  ctx.middleware(async (session, next) => {
    try {
      if (config.privateOnly) return next()
      if (!session || session.isDirect) return next()

      const whitelist = config.groupAutoParseWhitelist || []
      if (!Array.isArray(whitelist) || whitelist.length === 0) return next()

      if (!isChannelInList(session.channelId, whitelist)) return next()

      // Skip if message contains command keywords
      const contentLower = (session.content || '').toLowerCase()
      if (contentLower.includes('sdexif') || contentLower.includes('读图')) {
        return next()
      }

      await ensureCacheDirectory()
      const segments = await collectImageSegments(session, config.enableDebugLog, logger, config)
      if (segments.length === 0) return next()

      const resp = await processImages(ctx, session, segments, config, logger, true, true)
      await sendAutoParseResult(session, resp)
      return
    } catch (e: any) {
      if (config.enableDebugLog) {
        logger.warn('群白名单自动解析处理失败', e)
      }
      return next()
    }
  })
}

/**
 * Split long messages into chunks, preserving prompt header
 */
function splitLongMessages(messages: string[], maxLength: number): string[] {
  const splitMessages: string[] = []

  for (const message of messages) {
    if (message.length <= maxLength) {
      splitMessages.push(message)
    } else {
      // Split long message into chunks
      // First extract and preserve prompt at the beginning
      let content = message
      let promptHeader = ''
      const promptLine = content.split('\n').find(line => line.startsWith('正向提示词:') || line.startsWith('Prompt:'))

      if (promptLine && promptLine.length < maxLength) {
        promptHeader = promptLine + '\n\n'
        content = content.replace(promptLine, '').trim()
      }

      // Split remaining content
      const chunks: string[] = []

      let remaining = content
      while (remaining.length > 0) {
        if (remaining.length <= maxLength) {
          chunks.push(remaining)
          break
        }

        // Find last newline before maxLength to split nicely
        let splitIndex = maxLength
        const lastNewline = remaining.lastIndexOf('\n', maxLength)
        if (lastNewline > maxLength * 0.5) {  // If newline is not too early
          splitIndex = lastNewline
        }

        chunks.push(remaining.substring(0, splitIndex))
        remaining = remaining.substring(splitIndex).trim()
      }

      // If we have a prompt header, prepend it to the first chunk (or create one)
      if (promptHeader) {
        if (chunks.length > 0) {
          chunks[0] = promptHeader + chunks[0]
        } else {
          chunks.push(promptHeader)
        }
      }

      // Drop empty chunks to avoid blank forward messages
      splitMessages.push(...chunks.filter(c => c && c.trim().length > 0))
    }
  }

  return splitMessages
}

async function processImages(
  ctx: Context,
  session: Session,
  imageSegments: ImageSegment[],
  config: Config,
  logger: any,
  isSilentMode = false,
  withImage = false
): Promise<string | h[] | (string | h)[] | void> {
  if (config.enableDebugLog) {
    logger.info('消息元素分析:', {
      totalElements: session.elements?.length || 0,
      imageElements: imageSegments.length,
      elementTypes: (session.elements || []).map((el: any) => el.type),
      imageElementDetails: imageSegments.map(el => ({
        type: el.type,
        attrs: el.attrs,
        source: el._source
      }))
    })
  }

  // Note: Deduplication is already done in collectImageSegments
  // This avoids redundant deduplication
  const segments = imageSegments

  const results: any[] = []
  const usedSegments: ImageSegment[] = []

  for (let i = 0; i < segments.length; i++) {
    const segment = segments[i]

    if (config.enableDebugLog) {
      logger.info(`处理第 ${i + 1} 个图片:`, {
        type: segment.type,
        source: segment._source
      })
    }

    try {
      const fetchResult = await fetchImage(ctx, session, segment, {
        maxFileSize: config.maxFileSize,
        groupFileRetryDelay: config.groupFileRetryDelay,
        groupFileRetryCount: config.groupFileRetryCount
      })

      if (fetchResult) {
        if (config.enableDebugLog) {
          logger.info('成功获取图片数据:', {
            source: fetchResult.source,
            sourceType: fetchResult.sourceType,
            size: fetchResult.buffer.length
          })
        }

        const metadata = await extractMetadata(fetchResult.buffer, config.enableDebugLog ? logger : undefined)

        if (metadata.success && metadata.data && Object.keys(metadata.data).length > 0) {
          if (config.enableDebugLog) {
            logger.info('成功提取元数据:', metadata.data)
          }
          results.push(metadata.data)
          usedSegments.push(segment)
          
          // Add to global deduplication cache
          if (config.globalDedupeEnabled !== false && globalProcessedImages) {
            const key = makeImageSegmentKey({ attrs: segment.attrs, data: segment.data })
            if (key) {
              globalProcessedImages.set(key, {
                timestamp: Date.now(),
                channelId: session.channelId || '',
                userId: session.userId
              })
              if (config.enableDebugLog) {
                logger.info('已添加到全局去重缓存:', { key, channelId: session.channelId })
              }
            }
          }
        }
      }
    } catch (error: any) {
      logger.warn(`解析图片失败: ${error?.message || error}`)
      if (config.enableDebugLog) {
        logger.error('详细错误信息:', error)
      }
    }
  }

  if (results.length === 0) {
    return '未能从图片中读取到 Stable Diffusion 信息'
  }

  // 在静默模式下，如果只找到 EXIF 回退数据（没有其他 SD metadata），则不发送任何消息
  if (isSilentMode && results.every(r => r.exifFallback && !r.prompt && !r.naiBasePrompt && !r.parameters)) {
    return
  }

  const messages = results.map((metadata, i) => {
    const result = formatMetadataResult(metadata)
    return (usedSegments.length > 1 ? `图片 ${i + 1}:\n---\n${result}` : result)
  })

  // For long ComfyUI workflow outputs, split into multiple messages
  const maxLength = config.messageSplitThreshold || 2000
  const splitMessages = splitLongMessages(messages, maxLength)

  return formatOutput(session, splitMessages, usedSegments.length > 0 ? usedSegments : segments, config, withImage)
}

async function collectImageSegments(
  session: Session,
  debug = false,
  logger?: any,
  config?: Config
): Promise<ImageSegment[]> {
  const segments: ImageSegment[] = []
  const seenKeys = new Set<string>()

  const append = (raw: any, origin: string) => {
    if (!raw) return

    let isImage = raw.type === 'image' || raw.type === 'img'

    if (!isImage && (raw.type === 'file' || raw.type === 'attachment')) {
      const a = raw.attrs || {}
      const d = raw.data || {}
      const mime: string | undefined = a.mime || a.mimetype || a.contentType || d.mime || d.mimetype || d.contentType
      const name: string | undefined = a.name || a.filename || a.file || d.name || d.filename || d.file
      const url: string | undefined = a.url || a.src || d.url || d.src

      const checkExt = (s?: string) => typeof s === 'string' && /\.(png|jpe?g|webp|gif|bmp|tiff|heic|heif)(?:[?#].*)?$/i.test(s)

      if (typeof mime === 'string' && mime.toLowerCase().startsWith('image/')) {
        isImage = true
      } else if (checkExt(name) || checkExt(url)) {
        isImage = true
      }
    }

    if (!isImage) return

    const key = makeImageSegmentKey({ attrs: raw.attrs, data: raw.data })
    
    // Local dedupe: within current message
    if (key && seenKeys.has(key)) {
      if (debug && logger) logger.info('去重：忽略重复图片元素（局部）', { origin, key })
      return
    }
    
    // Global dedupe: across messages (e.g., quoted images)
    if (key && config?.globalDedupeEnabled !== false && globalProcessedImages) {
      const cached = globalProcessedImages.get(key)
      if (cached) {
        const timeout = config?.globalDedupeTimeout ?? 300000
        const elapsed = Date.now() - cached.timestamp
        if (elapsed < timeout) {
          if (debug && logger) {
            logger.info('去重：忽略重复图片元素（全局）', {
              origin,
              key,
              elapsedMs: elapsed,
              previousChannel: cached.channelId,
              currentChannel: session.channelId
            })
          }
          return
        }
        // Expired, will be overwritten
      }
    }
    
    if (key) seenKeys.add(key)

    segments.push({
      ...raw,
      type: 'image',
      attrs: raw.attrs,
      data: raw.data,
      _source: origin
    })
  }

  const traverse = (raw: any, origin: string) => {
    if (!raw) return
    if (Array.isArray(raw)) {
      raw.forEach((child, idx) => traverse(child, `${origin}[${idx}]`))
      return
    }
    if (raw && Array.isArray(raw.children)) {
      raw.children.forEach((child: any, idx: number) => traverse(child, `${origin}.children[${idx}]`))
    }
    append(raw, origin)
  }

  session.elements?.forEach((el: any, index: number) => traverse(el, `session.elements[${index}]`))
  session.quote?.elements?.forEach((el: any, index: number) => traverse(el, `session.quote.elements[${index}]`))

  const quotedMessage = Array.isArray((session.quote as any)?.message) ? (session.quote as any).message : []
  quotedMessage.forEach((el: any, index: number) => traverse(el, `session.quote.message[${index}]`))

  const quoteContent = (session.quote as any)?.content
  if (typeof quoteContent === 'string') {
    const parsed = h.parse(quoteContent)
    const arr = Array.isArray(parsed) ? parsed : [parsed]
    arr.forEach((el: any, index: number) => traverse(el, `session.quote.content[${index}]`))
  }

  const eventMessage = Array.isArray((session.event as any)?.message) ? (session.event as any).message : []
  eventMessage.forEach((seg: any, index: number) => {
    if (!seg) return
    const attrs = seg.attrs || seg.data
    traverse({ ...seg, attrs, data: seg.data }, `session.event.message[${index}]`)
  })

  await handleGroupFileEvent(session, traverse, config?.maxFileSize)
  await fetchQuotedMessage(session, traverse)

  return segments
}

async function handleGroupFileEvent(session: Session, traverse: Function, maxFileSize?: number): Promise<void> {
  const fileEvent = session.event as any
  if (!fileEvent?.file) return

  const file = fileEvent.file
  const maxSize = maxFileSize ?? (10 * 1024 * 1024)

  if (file.size > maxSize) return

  const imageExts = ['.jpg', '.jpeg', '.png', '.webp', '.gif', '.bmp', '.tiff', '.heic', '.heif']
  const fileExt = path.extname(file.name || '').toLowerCase()

  if (!imageExts.includes(fileExt)) return

  const imageSegment = {
    type: 'image',
    attrs: {
      file: file.id || file.name,
      name: file.name,
      size: file.size,
      url: file.url || file.path,
      busid: file.busid
    },
    data: {
      file: file.id || file.name,
      name: file.name,
      size: file.size,
      url: file.url || file.path,
      busid: file.busid
    },
    _source: 'group_file_event'
  }

  traverse(imageSegment, 'group_file_event')
}

async function fetchQuotedMessage(session: Session, traverse: Function): Promise<void> {
  const quoteId = (session.quote as any)?.messageId || (session.quote as any)?.id
  if (!quoteId) return

  const bot: any = session.bot
  if (!bot) return

  if (typeof bot.getMessage === 'function') {
    try {
      let quoted: any = null
      try {
        quoted = await bot.getMessage(session.channelId, quoteId)
      } catch {
        quoted = await bot.getMessage(quoteId)
      }

      if (quoted) {
        const elems = Array.isArray(quoted.elements) ? quoted.elements : (Array.isArray(quoted.message) ? quoted.message : [])
        elems.forEach((el: any, index: number) => traverse(el, `bot.getMessage[${index}]`))

        if (typeof quoted.content === 'string') {
          const parsed = h.parse(quoted.content)
          const arr = Array.isArray(parsed) ? parsed : [parsed]
          arr.forEach((el: any, index: number) => traverse(el, `bot.getMessage.content[${index}]`))
        }
      }
    } catch {
    }
  }

  if ((session.platform === 'onebot') && bot.internal) {
    try {
      const internal: any = bot.internal
      const methods = ['getMsg', 'get_msg']

      for (const method of methods) {
        const fn = internal[method]
        if (typeof fn === 'function') {
          try {
            const ret = await fn.call(internal, quoteId)
            const msg = ret?.message || ret?.data?.message

            if (Array.isArray(msg)) {
              msg.forEach((seg: any, index: number) => {
                if (seg?.type === 'image' || seg?.type === 'img') {
                  const d = seg.data || {}
                  const attrs = {
                    url: d.url || d.file_url,
                    file: d.file || d.filename,
                    fileId: d.file || d.file_id || d.id,
                    src: d.url || d.file || d.filename
                  }
                  traverse({ type: 'image', attrs, data: attrs }, `onebot.internal[${index}]`)
                }
              })
              return
            }
          } catch {
            continue
          }
        }
      }
    } catch {
    }
  }
}

/**
 * Format output for normal mode (non-forward)
 */
function formatNormalModeOutput(
  session: Session,
  messages: string[],
  imageSegments: ImageSegment[],
  config: Config
): string | (string | h)[] {
  if (!config.embedImageInNormalMode || imageSegments.length === 0) {
    return messages.join('\n\n===\n\n')
  }

  // Normal mode with embedded images
  const botAny = session.bot as any
  const platform = session.platform || ''
  const supportsFile = botAny?.sendFile !== undefined || platform === 'onebot'

  const results: (string | h)[] = []

  messages.forEach((msg, index) => {
    const imageSeg = imageSegments[index]
    const hasImage = imageSeg !== undefined && imageSeg.attrs?.url !== undefined

    // Add image if available and supported
    if (hasImage && supportsFile) {
      const imageUrl = imageSeg.attrs?.url
      // Add separator between images if not the first one
      if (results.length > 0) {
        results.push('\n\n===\n\n')
      }
      results.push(h.image(imageUrl))
      results.push('\n\n')
    }

    // Add the message content
    results.push(msg)
  })

  return results
}

/**
 * Format output for forward mode (merged forward messages)
 */
function formatForwardModeOutput(
  session: Session,
  messages: string[],
  imageSegments: ImageSegment[],
  config: Config,
  withImage: boolean
): h[] {
  const selfId = session.bot?.selfId || session.selfId || 'bot'
  const displayName = session.bot?.user?.name || 'Bot'

  const nodes = messages.map((msg, index) => {
    const imageSeg = imageSegments[index]
    const hasImage = !!(imageSeg && (imageSeg.attrs?.url || imageSeg.attrs?.src || imageSeg.data?.url || imageSeg.data?.src))

    // If we have an image URL and withImage is enabled
    if (hasImage && withImage) {
      const imageUrl = imageSeg.attrs?.url || imageSeg.attrs?.src || imageSeg.data?.url || imageSeg.data?.src
      return h('message', {}, [
        h('author', { id: selfId, name: displayName }),
        h('content', {}, [
          h.image(imageUrl),
          msg
        ])
      ])
    } else {
      // Fallback to text-only node
      return h('message', {}, [
        h('author', { id: selfId, name: displayName }),
        h('content', {}, msg)
      ])
    }
  })

  return [h('message', { forward: true }, nodes)]
}

/**
 * Format output based on configuration
 */
function formatOutput(
  session: Session,
  messages: string[],
  imageSegments: ImageSegment[],
  config: Config,
  withImage = false
): string | h[] | (string | h)[] {
  if (!config.useForward) {
    return formatNormalModeOutput(session, messages, imageSegments, config)
  }
  return formatForwardModeOutput(session, messages, imageSegments, config, withImage)
}
