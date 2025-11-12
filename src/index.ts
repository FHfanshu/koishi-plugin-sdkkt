import { Context, Schema, h, Session } from 'koishi'
import { extractMetadata, formatMetadataResult } from './extractor'
import { fetchImage } from './fetcher'
import { ImageSegment, makeImageSegmentKey } from './utils'
import { promises as fs } from 'fs'
import path from 'path'

export const name = 'sdexif'

export interface Config {
  useForward: boolean
  enableDebugLog: boolean
  privateOnly: boolean
  groupAutoParseWhitelist: string[]
  preferFileCache?: boolean
}

export const Config: Schema<Config> = Schema.object({
  useForward: Schema.boolean()
    .default(false)
    .description('是否使用合并转发格式发送消息'),
  enableDebugLog: Schema.boolean()
    .default(false)
    .description('是否启用调试日志（用于排查图片接收问题）'),
  privateOnly: Schema.boolean()
    .default(false)
    .description('是否仅在私聊中启用'),
  groupAutoParseWhitelist: Schema.array(Schema.string())
    .default([])
    .description('群聊白名单：在这些群聊中自动解析图片（无需命令），为空则禁用')
})

const CACHE_DIR = path.join(process.cwd(), 'data', 'edexif')
let cacheDirEnsured = false

export function apply(ctx: Context, config: Config) {
  const logger = ctx.logger('sdexif')

  ctx.command('sdexif', '读取图片中的 Stable Diffusion 信息')
    .alias('读图')
    .shortcut('sdexif', { fuzzy: true })
    .shortcut('读图', { fuzzy: true })
    .action(async ({ session }) => {
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

      const segments = await collectImageSegments(session, config.enableDebugLog, logger)

      if (segments.length === 0) {
        return '请在发送命令的同时附带图片，或引用回复包含图片的消息'
      }

      if (config.enableDebugLog) {
        logger.info(`检测到 ${segments.length} 个图片元素，开始处理`)
      }

      const response = await processImages(ctx, session, segments, config, logger)
      return response
    })

  ctx.middleware(async (session, next) => {
    try {
      if (config.privateOnly) return next()
      if (!session || session.isDirect) return next()

      const whitelist = config.groupAutoParseWhitelist || []
      if (!Array.isArray(whitelist) || whitelist.length === 0) return next()

      const chId = String(session.channelId || '')
      const normalized = chId.replace(/^(?:private|group|guild|channel):/i, '')
      const inWhitelist = whitelist.includes(chId) || whitelist.includes(normalized)
      if (!inWhitelist) return next()

      const contentLower = (session.content || '').toLowerCase()
      if (contentLower.includes('sdexif') || contentLower.includes('读图')) {
        return next()
      }

      const segments = await collectImageSegments(session, config.enableDebugLog, logger)
      if (segments.length === 0) return next()

      const resp = await processImages(ctx, session, segments, config, logger)
      if (typeof resp === 'string') {
        if (resp === '未能从图片中读取到 Stable Diffusion 信息') return
        await session.send(resp)
        return
      } else if (Array.isArray(resp)) {
        await session.send(resp)
        return
      }
      return
    } catch (e: any) {
      if (config.enableDebugLog) {
        logger.warn('群白名单自动解析处理失败', e)
      }
      return next()
    }
  })
}

async function processImages(
  ctx: Context,
  session: Session,
  imageSegments: ImageSegment[],
  config: Config,
  logger: any
): Promise<string | h[] | void> {
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

  const segments = dedupeSegments(imageSegments)
  if (config.enableDebugLog && segments.length !== imageSegments.length) {
    logger.info(`去重后图片元素数: ${segments.length}`)
  }

  const results: any[] = []

  for (let i = 0; i < segments.length; i++) {
    const segment = segments[i]

    if (config.enableDebugLog) {
      logger.info(`处理第 ${i + 1} 个图片:`, {
        type: segment.type,
        source: segment._source
      })
    }

    try {
      const fetchResult = await fetchImage(ctx, session, segment)

      if (fetchResult) {
        if (config.enableDebugLog) {
          logger.info('成功获取图片数据:', {
            source: fetchResult.source,
            sourceType: fetchResult.sourceType,
            size: fetchResult.buffer.length
          })
        }

        const metadata = await extractMetadata(fetchResult.buffer)

        if (metadata.success && metadata.data) {
          if (config.enableDebugLog) {
            logger.info('成功提取元数据:', metadata.data)
          }
          results.push(metadata.data)
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

  const messages = results.map((metadata, i) => {
    const result = formatMetadataResult(metadata)
    return segments.length > 1 ? `图片 ${i + 1}:\n---\n${result}` : result
  })

  return formatOutput(session, messages, config.useForward)
}

async function collectImageSegments(
  session: Session,
  debug = false,
  logger?: any
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
    if (key && seenKeys.has(key)) {
      if (debug && logger) logger.info('去重：忽略重复图片元素', { origin, key })
      return
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
    const { h } = require('koishi')
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

  await handleGroupFileEvent(session, traverse)
  await fetchQuotedMessage(session, traverse)

  return segments
}

async function handleGroupFileEvent(session: Session, traverse: Function): Promise<void> {
  const fileEvent = session.event as any
  if (!fileEvent?.file) return

  const file = fileEvent.file
  const maxSize = 10 * 1024 * 1024

  if (file.size > maxSize) return

  const imageExts = ['.jpg', '.jpeg', '.png', '.webp', '.gif', '.bmp', '.tiff', '.heic', '.heif']
  const fileExt = require('path').extname(file.name || '').toLowerCase()

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
          const { h } = require('koishi')
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

function dedupeSegments(segments: ImageSegment[]): ImageSegment[] {
  const seen = new Set<string>()
  const unique: ImageSegment[] = []

  for (const seg of segments) {
    const key = makeImageSegmentKey(seg)
    if (key && seen.has(key)) continue
    if (key) seen.add(key)
    unique.push(seg)
  }

  return unique
}

function formatOutput(session: Session, messages: string[], useForward: boolean): string | h[] {
  if (!useForward) {
    return messages.join('\n\n===\n\n')
  }

  const selfId = session.bot?.selfId || session.selfId || 'bot'
  const displayName = session.bot?.user?.name || 'Bot'

  const nodes = messages.map(msg =>
    h('message', {}, [
      h('author', { id: selfId, name: displayName }),
      h('content', {}, msg)
    ])
  )

  return [h('message', { forward: true }, nodes)]
}
