import { Context, Schema, h, Session, Next } from 'koishi'
import { PNG } from 'pngjs'
import axios from 'axios'
import ExifReader from 'exifreader'
import { promises as fs } from 'fs'
import path from 'path'
import { gunzipSync, inflateSync } from 'zlib'

export const name = 'sdexif'

export interface Config {
  useForward: boolean
  enableDebugLog: boolean
  privateOnly: boolean
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
    .description('是否仅在私聊中启用')
})

interface SDMetadata {
  prompt?: string
  negativePrompt?: string
  steps?: string
  sampler?: string
  cfgScale?: string
  seed?: string
  size?: string
  model?: string
  parameters?: string
}

interface ImageSegment {
  type: string
  attrs?: Record<string, any>
  data?: Record<string, any>
  _source?: string
  [key: string]: any
}

interface FetchImageResult {
  buffer: Buffer
  source: string
  sourceType: 'data-uri' | 'base64' | 'local' | 'bot-file'
}

export function apply(ctx: Context, config: Config) {
  const logger = ctx.logger('sdexif')

  ctx.command('sdexif', '读取图片中的 Stable Diffusion 信息')
    .alias('读图')
    .action(async ({ session }) => {
      if (!session) return '无法获取会话信息'

      // 检查是否仅在私聊中启用
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

      const segments = collectImageSegments(session)

      if (segments.length === 0) {
        return '请在发送命令的同时附带图片，或引用回复包含图片的消息'
      }

      if (config.enableDebugLog) {
        logger.info(`检测到 ${segments.length} 个图片元素，开始处理`)
      }

      const response = await processImageSegments(ctx, session, segments, config, logger)
      return response
    })
}

async function processImageSegments(ctx: Context, session: Session, imageSegments: ImageSegment[], config: Config, logger: any): Promise<string | h[] | void> {
  if (config.enableDebugLog) {
    logger.info('消息元素分析:', {
      totalElements: session.elements?.length || 0,
      imageElements: imageSegments.length,
      elementTypes: (session.elements || []).map((el: any) => el.type),
      imageElementDetails: imageSegments.map(el => ({
        type: el.type,
        attrs: el.attrs,
        data: el.data,
        source: el._source
      }))
    })
  }

  const results: SDMetadata[] = []

  for (let i = 0; i < imageSegments.length; i++) {
    const segment = imageSegments[i]
    const attrs = mergeSegmentAttributes(segment)

    if (config.enableDebugLog) {
      logger.info(`处理第 ${i + 1} 个图片:`, {
        type: segment.type,
        attrs,
        source: segment._source
      })
    }

    try {
      const fetchResult = await fetchImageBuffer(ctx, session, segment, config.enableDebugLog, logger)
      let metadata: SDMetadata | null = null

      if (fetchResult) {
        if (config.enableDebugLog) {
          logger.info('成功获取图片数据', {
            source: fetchResult.source,
            sourceType: fetchResult.sourceType,
            size: fetchResult.buffer.length
          })
        }
        metadata = await extractSDMetadata(fetchResult.buffer, config.enableDebugLog, logger)
      } else {
        const directUrl = typeof attrs.src === 'string' ? attrs.src : typeof attrs.url === 'string' ? attrs.url : ''

        if (!directUrl) {
          if (config.enableDebugLog) {
            logger.warn(`第 ${i + 1} 个图片未找到可用的 URL 或数据`)
          }
          continue
        }

        if (config.enableDebugLog) {
          logger.info(`尝试使用直接 URL 下载图片: ${directUrl}`)
        }

        metadata = await extractSDMetadata(directUrl, config.enableDebugLog, logger)
      }

      if (metadata) {
        if (config.enableDebugLog) {
          logger.info('成功提取元数据:', metadata)
        }
        results.push(metadata)
      } else if (config.enableDebugLog) {
        logger.info('图片中未找到 SD 元数据')
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

  const messages = buildMetadataMessages(results)

  if (config.useForward) {
    if (session.platform === 'onebot') {
      const sent = await trySendOneBotForward(session, messages, config.enableDebugLog, logger)
      if (sent) {
        return
      }

      if (config.enableDebugLog) {
        logger.warn('OneBot 合并转发发送失败，将使用默认格式发送')
      }
    }

    return formatOutput(session, messages, true)
  }

  return formatOutput(session, messages, false)
}

function collectImageSegments(session: Session): ImageSegment[] {
  const segments: ImageSegment[] = []
  const append = (raw: any, origin: string) => {
    if (!raw) return
    const type = raw.type || 'image'
    if (type !== 'image' && type !== 'img') return

    const attrs = raw.attrs && typeof raw.attrs === 'object' ? { ...raw.attrs } : undefined
    const data = raw.data && typeof raw.data === 'object' ? { ...raw.data } : undefined

    segments.push({
      ...(raw as Record<string, any>),
      type,
      attrs,
      data,
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

  const elements = session.elements || []
  elements.forEach((el: any, index: number) => traverse(el, `session.elements[${index}]`))

  const quotedElements = session.quote?.elements || []
  quotedElements.forEach((el: any, index: number) => traverse(el, `session.quote.elements[${index}]`))

  const quotedMessage = Array.isArray((session.quote as any)?.message) ? (session.quote as any).message : []
  quotedMessage.forEach((el: any, index: number) => traverse(el, `session.quote.message[${index}]`))

  const quoteContent = (session.quote as any)?.content
  if (typeof quoteContent === 'string') {
    const parsed = h.parse(quoteContent) as any
    const arr = Array.isArray(parsed) ? parsed : [parsed]
    arr.forEach((el: any, index: number) => traverse(el, `session.quote.content[${index}]`))
  }

  const eventMessage = Array.isArray((session.event as any)?.message) ? (session.event as any).message : []
  eventMessage.forEach((seg: any, index: number) => {
    if (!seg) return
    const attrs = seg.attrs ?? seg.data
    traverse(
      {
        ...seg,
        attrs,
        data: seg.data
      },
      `session.event.message[${index}]`
    )
  })

  return segments
}

function mergeSegmentAttributes(segment: ImageSegment): Record<string, any> {
  const merged: Record<string, any> = {}
  if (segment.attrs && typeof segment.attrs === 'object') {
    Object.assign(merged, segment.attrs)
  }
  if (segment.data && typeof segment.data === 'object') {
    for (const [key, value] of Object.entries(segment.data)) {
      if (merged[key] === undefined) {
        merged[key] = value
      }
    }
  }
  return merged
}

async function fetchImageBuffer(ctx: Context, session: Session, segment: ImageSegment, debug: boolean, logger?: any): Promise<FetchImageResult | null> {
  const attrs = mergeSegmentAttributes(segment)
  const seen = new Set<string>()
  const makeKey = (category: string, value: string) => `${category}:${value}`

  const logDebug = (message: string, payload?: Record<string, any>) => {
    if (debug && logger) {
      logger.info(message, payload)
    }
  }

  const base64Fields = ['base64', 'image_base64', 'data', 'raw', 'content']
  for (const field of base64Fields) {
    const value = attrs[field]
    if (typeof value !== 'string') continue
    const buffer = bufferFromBase64(value)
    if (buffer) {
      logDebug(`通过字段 ${field} 获取到 Base64 图片数据`, { length: buffer.length })
      return { buffer, source: `attrs.${field}`, sourceType: 'base64' }
    }
  }

  const urlCandidates = [attrs.url, attrs.src]
  for (const candidate of urlCandidates) {
    if (typeof candidate !== 'string') continue
    const key = makeKey('data-uri', candidate)
    if (seen.has(key)) continue
    seen.add(key)
    const dataBuffer = decodeDataUri(candidate)
    if (dataBuffer) {
      logDebug('通过 data URI 获取到图片数据', { source: 'data-uri', length: dataBuffer.length })
      return { buffer: dataBuffer, source: candidate, sourceType: 'data-uri' }
    }
  }

  const localCandidates = [attrs.path, attrs.localPath]
  for (const candidate of localCandidates) {
    if (typeof candidate !== 'string') continue
    const key = makeKey('local', candidate)
    if (seen.has(key)) continue
    seen.add(key)
    const localBuffer = await tryReadLocalFileBuffer(candidate)
    if (localBuffer) {
      logDebug('通过本地路径获取到图片数据', { path: candidate, length: localBuffer.length })
      return { buffer: localBuffer, source: candidate, sourceType: 'local' }
    }
  }

  const botCandidates = [attrs.file, attrs.image, attrs.fileId, attrs.file_id, attrs.id, attrs.path]
  for (const candidate of botCandidates) {
    if (typeof candidate !== 'string') continue
    const key = makeKey('bot', candidate)
    if (seen.has(key)) continue
    seen.add(key)
    const botBuffer = await fetchBufferFromBot(ctx, session, candidate, debug, logger)
    if (botBuffer) {
      logDebug('通过 bot.getFile 获取到图片数据', { identifier: candidate, length: botBuffer.length })
      return { buffer: botBuffer, source: candidate, sourceType: 'bot-file' }
    }
  }

  return null
}

async function fetchBufferFromBot(ctx: Context, session: Session, identifier: string, debug: boolean, logger?: any): Promise<Buffer | null> {
  if (!identifier) return null
  const bot: any = session.bot
  if (!bot || typeof bot.getFile !== 'function') return null
  try {
    if (debug && logger) {
      logger.info(`尝试通过 bot.getFile 获取文件: ${identifier}`)
    }
    const result = await bot.getFile(identifier)
    if (!result) return null
    if (typeof result.base64 === 'string') {
      const buffer = bufferFromBase64(result.base64)
      if (buffer) return buffer
    }
    if (typeof result.url === 'string') {
      const response = await axios.get(result.url, { responseType: 'arraybuffer' })
      return Buffer.from(response.data)
    }
  } catch (error: any) {
    if (debug && logger) {
      logger.warn(`通过 bot.getFile 获取文件失败: ${error?.message || error}`, { identifier })
    }
  }
  return null
}

async function tryReadLocalFileBuffer(target: string): Promise<Buffer | null> {
  const normalized = normalizeLocalPath(target)
  if (!normalized) return null
  try {
    const filePath = path.isAbsolute(normalized) ? normalized : path.join(process.cwd(), normalized)
    return await fs.readFile(filePath)
  } catch {
    return null
  }
}

function normalizeLocalPath(target: string): string | null {
  if (typeof target !== 'string') return null
  const trimmed = target.trim()
  if (!trimmed) return null
  if (trimmed.startsWith('file://')) {
    return path.normalize(trimmed.replace(/^file:\/\//i, ''))
  }
  if (path.isAbsolute(trimmed)) return path.normalize(trimmed)
  if (/^[a-zA-Z]:\\/.test(trimmed)) return path.normalize(trimmed)
  if (trimmed.startsWith('./') || trimmed.startsWith('../')) return path.normalize(trimmed)
  if (trimmed.startsWith('/') || trimmed.startsWith('\\')) return path.normalize(trimmed)
  return null
}

function decodeDataUri(value: string): Buffer | null {
  if (typeof value !== 'string') return null
  if (!value.startsWith('data:')) return null
  const commaIndex = value.indexOf(',')
  if (commaIndex === -1) return null
  const meta = value.slice(0, commaIndex)
  const data = value.slice(commaIndex + 1).trim()
  if (!data) return null
  if (meta.includes(';base64')) {
    return bufferFromBase64(data)
  }
  try {
    return Buffer.from(decodeURIComponent(data), 'utf8')
  } catch {
    return null
  }
}

function bufferFromBase64(value: string): Buffer | null {
  if (typeof value !== 'string') return null
  const sanitized = value.replace(/\s+/g, '')
  if (!sanitized) return null
  if (sanitized.length % 4 === 1) return null
  if (!/^[-0-9a-zA-Z+/=_]+$/.test(sanitized)) {
    return null
  }
  try {
    return Buffer.from(sanitized, 'base64')
  } catch {
    return null
  }
}

async function extractSDMetadata(source: string | Buffer | ArrayBuffer, debug: boolean = false, logger?: any): Promise<SDMetadata | null> {
  try {
    let buffer: Buffer

    if (Buffer.isBuffer(source)) {
      buffer = source
    } else if (source instanceof ArrayBuffer) {
      buffer = Buffer.from(new Uint8Array(source))
    } else if (typeof source === 'string') {
      const trimmed = source.trim()
      if (!trimmed) return null

      const dataUriBuffer = decodeDataUri(trimmed)
      if (dataUriBuffer) {
        if (debug && logger) {
          logger.info('从 data URI 解码图片数据', { length: dataUriBuffer.length })
        }
        buffer = dataUriBuffer
      } else if (/^https?:\/\//i.test(trimmed)) {
        if (debug && logger) {
          logger.info(`发起 HTTP 请求: ${trimmed}`)
        }

        const response = await axios.get(trimmed, {
          responseType: 'arraybuffer',
          timeout: 30000,
          headers: {
            'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36'
          }
        })

        if (debug && logger) {
          logger.info('图片下载成功:', {
            status: response.status,
            contentType: response.headers['content-type'],
            contentLength: response.headers['content-length'],
            dataSize: response.data.byteLength || response.data.length
          })
        }

        buffer = Buffer.from(response.data)
      } else {
        const base64Buffer = bufferFromBase64(trimmed)
        if (base64Buffer) {
          if (debug && logger) {
            logger.info('从 Base64 字符串解码图片数据', { length: base64Buffer.length })
          }
          buffer = base64Buffer
        } else {
          if (debug && logger) {
            logger.warn('未识别的图片来源字符串，无法解析')
          }
          return null
        }
      }
    } else {
      return null
    }

    const format = detectImageFormat(buffer)

    if (debug && logger) {
      logger.info(`检测到图片格式: ${format}`)
    }

    if (!format) {
      if (debug && logger) {
        logger.info('不支持的图片格式')
      }
      return null
    }

    const metadata: SDMetadata = {}

    if (format === 'png') {
      // 1. 首先尝试从 PNG chunks 手动提取文本元数据
      const textChunks = extractPngTextChunks(buffer, debug, logger)
      
      if (debug && logger) {
        logger.info('PNG text chunks:', Object.keys(textChunks))
      }

      // A1111 标准格式
      if (textChunks.parameters) {
        if (debug && logger) {
          logger.info('找到 parameters 字段')
        }
        metadata.parameters = textChunks.parameters
        parseA1111Parameters(textChunks.parameters, metadata)
      } else if (textChunks.prompt) {
        // ComfyUI 可能将 prompt 作为 JSON 存储
        try {
          const promptData = JSON.parse(textChunks.prompt)
          if (debug && logger) {
            logger.info('检测到 ComfyUI 格式（JSON prompt）')
          }
          extractComfyUIMetadata(null, promptData, metadata)
        } catch {
          // 不是 JSON，作为普通 prompt 处理
          metadata.prompt = textChunks.prompt
        }
      }

      // NovelAI 格式检测
      if (textChunks.Software === 'NovelAI' || textChunks.software === 'NovelAI') {
        if (debug && logger) {
          logger.info('检测到 NovelAI 格式图片')
        }
        try {
          const description = textChunks.Description || textChunks.description
          const comment = textChunks.Comment || textChunks.comment
          
          if (comment) {
            const commentData = JSON.parse(comment)
            if (description) metadata.prompt = description
            if (commentData.uc) metadata.negativePrompt = commentData.uc
            if (commentData.steps) metadata.steps = String(commentData.steps)
            if (commentData.scale) metadata.cfgScale = String(commentData.scale)
            if (commentData.seed) metadata.seed = String(commentData.seed)
            if (commentData.sampler) metadata.sampler = commentData.sampler
            
            if (debug && logger) {
              logger.info('成功解析 NovelAI 元数据')
            }
          }
        } catch (error: any) {
          if (debug && logger) {
            logger.warn('NovelAI 格式解析失败:', error.message)
          }
        }
      }

      // 其他常见字段
      if (textChunks.Description && !metadata.prompt) {
        metadata.prompt = textChunks.Description
      }
      if (textChunks.Comment && !metadata.parameters) {
        try {
          const comment = JSON.parse(textChunks.Comment)
          if (comment.prompt) metadata.prompt = comment.prompt
          if (comment.uc) metadata.negativePrompt = comment.uc
          if (comment.steps) metadata.steps = String(comment.steps)
          if (comment.scale) metadata.cfgScale = String(comment.scale)
          if (comment.seed) metadata.seed = String(comment.seed)
          if (comment.sampler) metadata.sampler = comment.sampler
        } catch {
          // 如果不是 JSON，可能是纯文本参数
          if (textChunks.Comment.includes('Steps:')) {
            metadata.parameters = textChunks.Comment
            parseA1111Parameters(textChunks.Comment, metadata)
          }
        }
      }

      // ComfyUI 格式
      if (textChunks.workflow) {
        try {
          const workflow = JSON.parse(textChunks.workflow)
          if (debug && logger) {
            logger.info('检测到 ComfyUI 格式（workflow）')
          }
          extractComfyUIMetadata(workflow, null, metadata)
        } catch (error: any) {
          if (debug && logger) {
            logger.warn('ComfyUI 格式解析失败:', error.message)
          }
        }
      }

      // 2. 如果仍未找到元数据，尝试提取 Stealth PNG 元数据（LSB 隐写术）
      if (Object.keys(metadata).length === 0 || !metadata.parameters) {
        if (debug && logger) {
          logger.info('尝试提取 Stealth PNG 元数据（LSB 隐写术）')
        }
        try {
          const png = PNG.sync.read(buffer)
          const stealthMetadata = extractStealthPngMetadata(png, debug, logger)
          if (stealthMetadata) {
            if (debug && logger) {
              logger.info('成功提取 Stealth PNG 元数据')
            }
            // 合并 stealth 元数据
            Object.assign(metadata, stealthMetadata)
          }
        } catch (error: any) {
          if (debug && logger) {
            logger.warn('Stealth PNG 元数据提取失败:', error.message)
          }
        }
      }
    } else if (format === 'webp' || format === 'jpeg') {
      try {
        const tags = ExifReader.load(buffer, { expanded: true })

        if (debug && logger) {
          logger.info('ExifReader 解析结果:', {
            hasExif: !!tags.exif,
            hasXmp: !!tags.xmp,
            hasIptc: !!tags.iptc,
            hasIcc: !!tags.icc,
            hasFile: !!tags.file
          })
        }

        // 尝试多个可能包含元数据的字段
        const exifFields = [
          'UserComment',
          'ImageDescription',
          'ImageComment',
          'XPComment',
          'XPKeywords',
          'Artist',
          'Copyright',
          'Software'
        ]

        for (const fieldName of exifFields) {
          if (metadata.parameters) break // 如果已经找到，跳出循环

          const field = (tags.exif as any)?.[fieldName]
          if (field) {
            const fieldTag = field as any
            const fieldValue = fieldTag.description || fieldTag.value
            if (fieldValue && typeof fieldValue === 'string') {
              if (debug && logger) {
                logger.info(`找到 ${fieldName}:`, fieldValue.substring(0, 100))
              }
              
              // 检查是否包含 SD 参数特征
              if (fieldValue.includes('Steps:') || fieldValue.includes('Sampler:') || 
                  fieldValue.includes('CFG scale:') || fieldValue.includes('Seed:')) {
                metadata.parameters = fieldValue
                parseA1111Parameters(fieldValue, metadata)
                if (debug && logger) {
                  logger.info(`从 ${fieldName} 成功解析 SD 参数`)
                }
                break
              }
            }
          }
        }

        // NovelAI 格式检测（JPEG/WebP）
        if (tags.exif?.Software) {
          const softwareTag = tags.exif.Software as any
          const software = softwareTag.description || softwareTag.value
          if (software === 'NovelAI') {
            if (debug && logger) {
              logger.info('检测到 NovelAI 格式图片（JPEG/WebP）')
            }
            try {
              // NovelAI 在 JPEG 中使用 ImageDescription 和 UserComment
              const descField = tags.exif?.ImageDescription as any
              const description = descField?.description || descField?.value
              
              const commentField = tags.exif?.UserComment as any
              const comment = commentField?.description || commentField?.value
              
              if (comment) {
                const commentData = JSON.parse(comment)
                if (description) metadata.prompt = description
                if (commentData.uc) metadata.negativePrompt = commentData.uc
                if (commentData.steps) metadata.steps = String(commentData.steps)
                if (commentData.scale) metadata.cfgScale = String(commentData.scale)
                if (commentData.seed) metadata.seed = String(commentData.seed)
                if (commentData.sampler) metadata.sampler = commentData.sampler
                
                if (debug && logger) {
                  logger.info('成功解析 NovelAI JPEG/WebP 元数据')
                }
              }
            } catch (error: any) {
              if (debug && logger) {
                logger.warn('NovelAI JPEG/WebP 格式解析失败:', error.message)
              }
            }
          }
        }

        // XMP 数据解析
        if (tags.xmp && !metadata.parameters) {
          if (debug && logger) {
            logger.info('找到 XMP 数据，尝试解析')
          }
          try {
            const xmpData = JSON.stringify(tags.xmp)
            if (debug && logger) {
              logger.info('XMP 数据内容:', xmpData.substring(0, 200))
            }
            
            if (xmpData.includes('parameters') || xmpData.includes('prompt')) {
              // 尝试多个可能的 XMP 字段
              const xmpFields = ['description', 'Description', 'dc:description', 'tiff:ImageDescription']
              for (const xmpField of xmpFields) {
                const xmpDesc = (tags.xmp as any)[xmpField]
                if (xmpDesc) {
                  const descValue = typeof xmpDesc === 'string' ? xmpDesc : (xmpDesc.value || xmpDesc.description)
                  if (descValue && typeof descValue === 'string') {
                    if (debug && logger) {
                      logger.info(`从 XMP.${xmpField} 找到元数据`)
                    }
                    metadata.parameters = descValue
                    parseA1111Parameters(descValue, metadata)
                    break
                  }
                }
              }
            }
          } catch (error: any) {
            if (debug && logger) {
              logger.warn('XMP 解析失败:', error.message)
            }
          }
        }

        // IPTC 数据解析
        if (tags.iptc && !metadata.parameters) {
          if (debug && logger) {
            logger.info('找到 IPTC 数据，尝试解析')
          }
          try {
            const iptcCaption = (tags.iptc as any)['Caption/Abstract']
            if (iptcCaption) {
              const captionValue = typeof iptcCaption === 'string' ? iptcCaption : (iptcCaption.value || iptcCaption.description)
              if (captionValue && typeof captionValue === 'string') {
                if (debug && logger) {
                  logger.info('从 IPTC Caption 找到元数据')
                }
                metadata.parameters = captionValue
                parseA1111Parameters(captionValue, metadata)
              }
            }
          } catch (error: any) {
            if (debug && logger) {
              logger.warn('IPTC 解析失败:', error.message)
            }
          }
        }
      } catch (exifError: any) {
        if (debug && logger) {
          logger.warn('ExifReader 解析失败:', exifError.message)
          logger.warn('错误堆栈:', exifError.stack)
        }
      }
    }

    if (Object.keys(metadata).length === 0) {
      if (debug && logger) {
        logger.info('未找到任何 SD 元数据')
      }
      return null
    }

    if (debug && logger) {
      logger.info('成功提取元数据:', {
        hasPrompt: !!metadata.prompt,
        hasNegativePrompt: !!metadata.negativePrompt,
        hasParameters: !!metadata.parameters,
        hasSteps: !!metadata.steps,
        hasSampler: !!metadata.sampler
      })
    }

    return metadata
  } catch (error: any) {
    if (debug && logger) {
      logger.error('元数据提取过程发生错误:', error.message)
      logger.error('错误堆栈:', error.stack)
    }
    throw error
  }
}

/**
 * 手动解析 PNG 文件中的文本块（tEXt、iTXt、zTXt）
 * pngjs 库默认不解析这些块，需要手动提取
 */
function extractPngTextChunks(buffer: Buffer, debug: boolean = false, logger?: any): Record<string, string> {
  const textChunks: Record<string, string> = {}
  
  try {
    // PNG 文件结构：8字节签名 + 多个 chunk
    // 每个 chunk 格式：4字节长度 + 4字节类型 + 数据 + 4字节CRC
    let offset = 8 // 跳过 PNG 签名
    
    while (offset < buffer.length - 12) {
      // 读取 chunk 长度（大端序）
      const length = buffer.readUInt32BE(offset)
      offset += 4
      
      // 读取 chunk 类型（4个ASCII字符）
      const type = buffer.toString('ascii', offset, offset + 4)
      offset += 4
      
      // 读取 chunk 数据
      const chunkData = buffer.slice(offset, offset + length)
      offset += length
      
      // 跳过 CRC
      offset += 4
      
      // 处理不同类型的文本块
      if (type === 'tEXt') {
        // tEXt: 关键字\0文本（都是Latin-1编码）
        const nullIndex = chunkData.indexOf(0)
        if (nullIndex !== -1) {
          const keyword = chunkData.toString('latin1', 0, nullIndex)
          const text = chunkData.toString('utf8', nullIndex + 1)
          textChunks[keyword] = text
          
          if (debug && logger) {
            logger.info(`找到 tEXt chunk: ${keyword} (${text.length} bytes)`)
          }
        }
      } else if (type === 'iTXt') {
        // iTXt: 关键字\0压缩标志\0压缩方法\0语言标签\0翻译关键字\0文本
        const nullIndex = chunkData.indexOf(0)
        if (nullIndex !== -1) {
          const keyword = chunkData.toString('latin1', 0, nullIndex)
          const compressionFlag = chunkData[nullIndex + 1]
          const compressionMethod = chunkData[nullIndex + 2]
          
          // 查找语言标签后的 null
          let pos = nullIndex + 3
          const langEnd = chunkData.indexOf(0, pos)
          if (langEnd !== -1) {
            // 查找翻译关键字后的 null
            pos = langEnd + 1
            const transEnd = chunkData.indexOf(0, pos)
            if (transEnd !== -1) {
              pos = transEnd + 1
              let text: string
              
              if (compressionFlag === 1 && compressionMethod === 0) {
                // 压缩文本，需要解压
                try {
                  const compressed = chunkData.slice(pos)
                  const decompressed = gunzipSync(compressed)
                  text = decompressed.toString('utf8')
                } catch {
                  text = chunkData.toString('utf8', pos)
                }
              } else {
                // 未压缩文本
                text = chunkData.toString('utf8', pos)
              }
              
              textChunks[keyword] = text
              
              if (debug && logger) {
                logger.info(`找到 iTXt chunk: ${keyword} (${text.length} bytes, compressed: ${compressionFlag === 1})`)
              }
            }
          }
        }
      } else if (type === 'zTXt') {
        // zTXt: 关键字\0压缩方法\0压缩文本
        const nullIndex = chunkData.indexOf(0)
        if (nullIndex !== -1) {
          const keyword = chunkData.toString('latin1', 0, nullIndex)
          const compressionMethod = chunkData[nullIndex + 1]
          
          if (compressionMethod === 0) {
            // zlib 压缩
            try {
              const compressed = chunkData.slice(nullIndex + 2)
              const decompressed = inflateSync(compressed)
              const text = decompressed.toString('utf8')
              textChunks[keyword] = text
              
              if (debug && logger) {
                logger.info(`找到 zTXt chunk: ${keyword} (${text.length} bytes)`)
              }
            } catch (error: any) {
              if (debug && logger) {
                logger.warn(`解压 zTXt chunk 失败: ${keyword}`, error.message)
              }
            }
          }
        }
      } else if (type === 'IEND') {
        // 到达文件末尾
        break
      }
    }
  } catch (error: any) {
    if (debug && logger) {
      logger.warn('解析 PNG chunks 失败:', error.message)
    }
  }
  
  return textChunks
}

/**
 * 从 PNG alpha 通道提取通过 LSB 隐写术嵌入的元数据
 * 这是 Stealth PNG 格式，将元数据隐藏在 alpha 通道的最低有效位中
 */
function extractStealthPngMetadata(png: PNG, debug: boolean = false, logger?: any): SDMetadata | null {
  try {
    const { width, height, data: pngData } = png
    
    if (!pngData || pngData.length === 0) {
      return null
    }

    // 提取所有 alpha 通道的 LSB
    const lowestBits: number[] = []
    for (let y = 0; y < height; y++) {
      for (let x = 0; x < width; x++) {
        const idx = (y * width + x) * 4
        const alpha = pngData[idx + 3]
        lowestBits.push(alpha & 1) // 提取最低位
      }
    }

    // 读取 magic number
    const magic = 'stealth_pngcomp'
    const reader = new BitReader(lowestBits)
    const magicBytes = reader.readNBytes(magic.length)
    const magicString = String.fromCharCode(...magicBytes)

    if (magicString !== magic) {
      if (debug && logger) {
        logger.info('未检测到 Stealth PNG magic number')
      }
      return null
    }

    if (debug && logger) {
      logger.info('检测到 Stealth PNG magic number')
    }

    // 读取数据长度（32位整数）
    const dataLength = reader.readInt32()
    if (debug && logger) {
      logger.info(`Stealth PNG 数据长度: ${dataLength} bits (${dataLength / 8} bytes)`)
    }

    if (dataLength <= 0 || dataLength > lowestBits.length * 8) {
      if (debug && logger) {
        logger.warn('Stealth PNG 数据长度无效')
      }
      return null
    }

    // 读取 gzip 压缩的数据
    const gzipData = reader.readNBytes(dataLength / 8)
    const gzipBuffer = Buffer.from(gzipData)
    
    // 解压缩
    const decompressed = gunzipSync(gzipBuffer)
    const jsonString = decompressed.toString('utf-8')
    
    if (debug && logger) {
      logger.info('Stealth PNG 解压后的 JSON:', jsonString.substring(0, 200))
    }

    // 解析 JSON
    const jsonData = JSON.parse(jsonString) as any
    
    // 转换为 SDMetadata 格式
    const metadata: SDMetadata = {}
    
    if (jsonData.prompt) metadata.prompt = jsonData.prompt
    if (jsonData.negative_prompt) metadata.negativePrompt = jsonData.negative_prompt
    if (jsonData.steps) metadata.steps = String(jsonData.steps)
    if (jsonData.sampler) metadata.sampler = jsonData.sampler
    if (jsonData.cfg_scale) metadata.cfgScale = String(jsonData.cfg_scale)
    if (jsonData.seed) metadata.seed = String(jsonData.seed)
    if (jsonData.size) metadata.size = jsonData.size
    if (jsonData.model) metadata.model = jsonData.model
    
    // 如果有完整的参数字符串，也保存
    if (jsonData.parameters) {
      metadata.parameters = jsonData.parameters
    }

    return metadata
  } catch (error: any) {
    if (debug && logger) {
      logger.warn('Stealth PNG 元数据提取失败:', error.message)
    }
    return null
  }
}

/**
 * 用于从位数组中读取数据的辅助类
 */
class BitReader {
  private data: number[]
  private index: number

  constructor(data: number[]) {
    this.data = data
    this.index = 0
  }

  readBit(): number {
    if (this.index >= this.data.length) {
      throw new Error('BitReader: 读取超出范围')
    }
    return this.data[this.index++]
  }

  readNBits(n: number): number[] {
    const bits: number[] = []
    for (let i = 0; i < n; i++) {
      bits.push(this.readBit())
    }
    return bits
  }

  readByte(): number {
    let byte = 0
    for (let i = 0; i < 8; i++) {
      byte |= this.readBit() << (7 - i)
    }
    return byte
  }

  readNBytes(n: number): number[] {
    const bytes: number[] = []
    for (let i = 0; i < n; i++) {
      bytes.push(this.readByte())
    }
    return bytes
  }

  readInt32(): number {
    const bytes = this.readNBytes(4)
    const buffer = Buffer.from(bytes)
    return buffer.readInt32BE(0)
  }
}

function detectImageFormat(buffer: Buffer): 'png' | 'webp' | 'jpeg' | null {
  if (buffer.length < 12) return null

  // PNG: 89 50 4E 47
  if (buffer[0] === 0x89 && buffer[1] === 0x50 && buffer[2] === 0x4E && buffer[3] === 0x47) {
    return 'png'
  }

  // JPEG: FF D8 FF
  if (buffer[0] === 0xFF && buffer[1] === 0xD8 && buffer[2] === 0xFF) {
    return 'jpeg'
  }

  // WebP: RIFF ... WEBP
  if (buffer[0] === 0x52 && buffer[1] === 0x49 && buffer[2] === 0x46 && buffer[3] === 0x46 &&
      buffer[8] === 0x57 && buffer[9] === 0x45 && buffer[10] === 0x42 && buffer[11] === 0x50) {
    return 'webp'
  }

  return null
}

function parseA1111Parameters(parameters: string, metadata: SDMetadata) {
  // A1111 格式: "prompt\nNegative prompt: xxx\nSteps: xx, Sampler: xxx, ..."
  const lines = parameters.split('\n')
  
  if (lines.length > 0) {
    // 第一行通常是 prompt
    let promptLines: string[] = []
    let paramsStartIndex = 0
    
    for (let i = 0; i < lines.length; i++) {
      if (lines[i].startsWith('Negative prompt:') || 
          lines[i].startsWith('Steps:')) {
        paramsStartIndex = i
        break
      }
      promptLines.push(lines[i])
    }
    
    metadata.prompt = promptLines.join('\n').trim()
    
    // 解析其他参数
    for (let i = paramsStartIndex; i < lines.length; i++) {
      const line = lines[i]
      
      if (line.startsWith('Negative prompt:')) {
        metadata.negativePrompt = line.replace('Negative prompt:', '').trim()
      } else {
        // 解析参数行: "Steps: 20, Sampler: Euler a, CFG scale: 7, ..."
        const params = line.split(',').map(p => p.trim())
        
        for (const param of params) {
          const [key, ...valueParts] = param.split(':')
          const value = valueParts.join(':').trim()
          
          if (!key || !value) continue
          
          const lowerKey = key.toLowerCase()
          if (lowerKey.includes('steps')) metadata.steps = value
          else if (lowerKey.includes('sampler')) metadata.sampler = value
          else if (lowerKey.includes('cfg scale')) metadata.cfgScale = value
          else if (lowerKey.includes('seed')) metadata.seed = value
          else if (lowerKey.includes('size')) metadata.size = value
          else if (lowerKey.includes('model')) metadata.model = value
        }
      }
    }
  }
}

function extractComfyUIMetadata(workflow: any, prompt: any, metadata: SDMetadata) {
  // ComfyUI 格式较复杂，尝试提取关键信息
  if (!workflow && !prompt) return

  const data = workflow || prompt

  // 尝试查找常见节点
  if (data.nodes) {
    for (const node of data.nodes) {
      if (node.type === 'CLIPTextEncode') {
        if (node.widgets_values && node.widgets_values[0]) {
          if (!metadata.prompt) {
            metadata.prompt = node.widgets_values[0]
          } else {
            // 可能是 negative prompt
            metadata.negativePrompt = node.widgets_values[0]
          }
        }
      } else if (node.type === 'KSampler') {
        if (node.widgets_values) {
          metadata.seed = String(node.widgets_values[0] || '')
          metadata.steps = String(node.widgets_values[1] || '')
          metadata.cfgScale = String(node.widgets_values[2] || '')
          metadata.sampler = node.widgets_values[3] || ''
        }
      }
    }
  }
}

function buildMetadataMessages(results: SDMetadata[]): string[] {
  const messages: string[] = []

  for (let i = 0; i < results.length; i++) {
    const metadata = results[i]
    const parts: string[] = []

    if (results.length > 1) {
      parts.push(`图片 ${i + 1}:`)
      parts.push('---')
    }

    if (metadata.prompt) {
      parts.push(`正向提示词:\n${metadata.prompt}`)
    }

    if (metadata.negativePrompt) {
      parts.push(`\n负向提示词:\n${metadata.negativePrompt}`)
    }

    const params: string[] = []
    if (metadata.steps) params.push(`Steps: ${metadata.steps}`)
    if (metadata.sampler) params.push(`Sampler: ${metadata.sampler}`)
    if (metadata.cfgScale) params.push(`CFG Scale: ${metadata.cfgScale}`)
    if (metadata.seed) params.push(`Seed: ${metadata.seed}`)
    if (metadata.size) params.push(`Size: ${metadata.size}`)
    if (metadata.model) params.push(`Model: ${metadata.model}`)

    if (params.length > 0) {
      parts.push(`\n参数:\n${params.join('\n')}`)
    }

    if (metadata.parameters) {
      parts.push(`\n完整参数:\n${metadata.parameters}`)
    }

    messages.push(parts.join('\n'))
  }

  return messages
}

function formatOutput(session: Session, messages: string[], useForward: boolean): string | h[] {
  if (!useForward) {
    return messages.join('\n\n===\n\n')
  }

  return buildForwardNodes(session, messages)
}

function buildForwardNodes(session: Session, messages: string[]): h[] {
  const selfId = session.bot?.selfId || session.selfId || 'bot'
  const displayName = session.bot?.user?.name || 'Bot'

  return messages.map(msg =>
    h('message', { forward: true }, [
      h('author', { id: selfId, name: displayName }),
      h('content', {}, msg)
    ])
  )
}

async function trySendOneBotForward(session: Session, messages: string[], debug: boolean, logger?: any): Promise<boolean> {
  if (!messages.length) return false

  const bot: any = session.bot
  const internal = bot?.internal
  if (!internal) return false

  const selfId = session.selfId || bot?.selfId
  const displayName = session.bot?.user?.name || bot?.nickname || 'Bot'

  const forwardNodes = messages.map(msg => ({
    type: 'node',
    data: {
      name: displayName,
      uin: selfId,
      content: msg
    }
  }))

  try {
    if (session.guildId || session.channelId) {
      const targetId = session.channelId || session.guildId
      if (!targetId) return false
      await internal.sendGroupForwardMsg(targetId, forwardNodes)
    } else if (session.userId) {
      await internal.sendFriendForwardMsg(session.userId, forwardNodes)
    } else {
      return false
    }

    if (debug && logger) {
      logger.info('通过 OneBot 合并转发发送成功')
    }

    return true
  } catch (error: any) {
    if (debug && logger) {
      logger.warn('通过 OneBot 合并转发发送失败:', error?.message || error)
    }
    return false
  }
}
