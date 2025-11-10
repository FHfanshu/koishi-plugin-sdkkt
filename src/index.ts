import { Context, Schema, h, Session, Next } from 'koishi'
import { PNG } from 'pngjs'
import axios from 'axios'
import ExifReader from 'exifreader'

export const name = 'sdexif'

export interface Config {
  useForward: boolean
  enableDebugLog: boolean
}

export const Config: Schema<Config> = Schema.object({
  useForward: Schema.boolean()
    .default(false)
    .description('是否使用合并转发格式发送消息'),
  enableDebugLog: Schema.boolean()
    .default(false)
    .description('是否启用调试日志（用于排查图片接收问题）')
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

export function apply(ctx: Context, config: Config) {
  const logger = ctx.logger('sdexif')
  
  ctx.command('sdexif', '读取图片中的 Stable Diffusion 信息')
    .alias('读图')
    .action(async ({ session }) => {
      if (!session) return '无法获取会话信息'
      
      return '请发送要读取的图片'
    })

  ctx.middleware(async (session: Session, next: Next) => {
    // 调试日志：记录收到的消息
    if (config.enableDebugLog) {
      logger.info('收到消息:', {
        platform: session.platform,
        channelId: session.channelId,
        userId: session.userId,
        content: session.content,
        elementsCount: session.elements?.length || 0
      })
    }
    
    // 检查消息中是否包含图片
    const imageElements = (session.elements || []).filter((el: h) => el.type === 'img' || el.type === 'image')
    
    // 调试日志：记录元素详情
    if (config.enableDebugLog) {
      logger.info('消息元素分析:', {
        totalElements: session.elements?.length || 0,
        imageElements: imageElements.length,
        elementTypes: (session.elements || []).map(el => el.type),
        imageElementDetails: imageElements.map(el => ({
          type: el.type,
          attrs: el.attrs
        }))
      })
    }
    
    if (imageElements.length === 0) {
      if (config.enableDebugLog) {
        logger.info('未检测到图片元素，跳过处理')
      }
      return next()
    }

    // 检查消息是否包含 sdexif 指令
    const text = session.content || ''
    if (!text.includes('sdexif') && !text.includes('读图')) {
      if (config.enableDebugLog) {
        logger.info('消息不包含 sdexif 或读图指令，跳过处理')
      }
      return next()
    }
    
    if (config.enableDebugLog) {
      logger.info(`检测到 ${imageElements.length} 个图片元素，开始处理`)
    }

    // 处理每个图片
    const results: SDMetadata[] = []
    
    for (let i = 0; i < imageElements.length; i++) {
      const imgEl = imageElements[i]
      const url = imgEl.attrs?.src || imgEl.attrs?.url
      
      if (config.enableDebugLog) {
        logger.info(`处理第 ${i + 1} 个图片:`, {
          type: imgEl.type,
          url: url,
          allAttrs: imgEl.attrs
        })
      }
      
      if (!url) {
        if (config.enableDebugLog) {
          logger.warn(`第 ${i + 1} 个图片未找到 URL`)
        }
        continue
      }

      try {
        if (config.enableDebugLog) {
          logger.info(`开始下载图片: ${url}`)
        }
        const metadata = await extractSDMetadata(url, config.enableDebugLog, logger)
        if (metadata) {
          if (config.enableDebugLog) {
            logger.info(`成功提取元数据:`, metadata)
          }
          results.push(metadata)
        } else {
          if (config.enableDebugLog) {
            logger.info(`图片中未找到 SD 元数据`)
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

    // 格式化输出
    return formatOutput(session, results, config.useForward)
  })
}

async function extractSDMetadata(url: string, debug: boolean = false, logger?: any): Promise<SDMetadata | null> {
  try {
    // 下载图片
    if (debug && logger) {
      logger.info(`发起 HTTP 请求: ${url}`)
    }
    
    const response = await axios.get(url, {
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

    const buffer = Buffer.from(response.data)

    // 检测图片格式
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

    // 根据格式解析元数据
    if (format === 'png') {
      // 解析 PNG
      const png = PNG.sync.read(buffer)
      
      // 读取 text chunks
      if ((png as any).text) {
        const textChunks = (png as any).text

      // 检查常见的 SD 元数据字段
      if (textChunks.parameters) {
        // A1111 格式
        metadata.parameters = textChunks.parameters
        parseA1111Parameters(textChunks.parameters, metadata)
      } else if (textChunks.prompt) {
        // 其他格式
        metadata.prompt = textChunks.prompt
      }

      // NovelAI 格式
      if (textChunks.Description) {
        metadata.prompt = textChunks.Description
      }
      if (textChunks.Comment) {
        try {
          const comment = JSON.parse(textChunks.Comment)
          if (comment.prompt) metadata.prompt = comment.prompt
          if (comment.uc) metadata.negativePrompt = comment.uc
          if (comment.steps) metadata.steps = String(comment.steps)
          if (comment.scale) metadata.cfgScale = String(comment.scale)
          if (comment.seed) metadata.seed = String(comment.seed)
          if (comment.sampler) metadata.sampler = comment.sampler
        } catch (e) {
          // 不是 JSON 格式
        }
      }

      // ComfyUI 格式
      if (textChunks.workflow || textChunks.prompt) {
        try {
          const workflow = textChunks.workflow ? JSON.parse(textChunks.workflow) : null
          const prompt = textChunks.prompt ? JSON.parse(textChunks.prompt) : null
          
          if (workflow || prompt) {
            extractComfyUIMetadata(workflow, prompt, metadata)
          }
        } catch (e) {
          // 解析失败
        }
      }
    }
    } else if (format === 'webp' || format === 'jpeg') {
      // 使用 ExifReader 解析 WebP 和 JPEG
      try {
        const tags = ExifReader.load(buffer, { expanded: true })
        
        if (debug && logger) {
          logger.info('ExifReader 解析结果:', {
            hasExif: !!tags.exif,
            hasXmp: !!tags.xmp,
            hasIptc: !!tags.iptc,
            hasIcc: !!tags.icc
          })
        }

        // 尝试从 EXIF UserComment 中提取 SD 参数
        if (tags.exif?.UserComment) {
          const userCommentTag = tags.exif.UserComment as any
          const userComment = userCommentTag.description || userCommentTag.value
          if (userComment && typeof userComment === 'string') {
            if (debug && logger) {
              logger.info('找到 UserComment:', userComment)
            }
            metadata.parameters = userComment
            parseA1111Parameters(userComment, metadata)
          }
        }

        // 尝试从 ImageDescription 提取
        if (tags.exif?.ImageDescription) {
          const descTag = tags.exif.ImageDescription as any
          const description = descTag.description || descTag.value
          if (description && typeof description === 'string') {
            if (debug && logger) {
              logger.info('找到 ImageDescription:', description)
            }
            if (!metadata.parameters) {
              metadata.parameters = description
              parseA1111Parameters(description, metadata)
            }
          }
        }

        // 尝试从 XMP 中提取（某些工具会将参数存储在 XMP 中）
        if (tags.xmp) {
          if (debug && logger) {
            logger.info('找到 XMP 数据')
          }
          // XMP 数据通常包含在 description 或其他字段中
          const xmpData = JSON.stringify(tags.xmp)
          if (xmpData.includes('parameters') || xmpData.includes('prompt')) {
            // 尝试提取相关信息
            try {
              const xmpDesc = (tags.xmp as any).description
              if (xmpDesc) {
                const descValue = typeof xmpDesc === 'string' ? xmpDesc : (xmpDesc.value || xmpDesc.description)
                if (descValue && typeof descValue === 'string') {
                  metadata.parameters = descValue
                  parseA1111Parameters(descValue, metadata)
                }
              }
            } catch (e) {
              // 忽略解析错误
            }
          }
        }
      } catch (exifError: any) {
        if (debug && logger) {
          logger.warn('ExifReader 解析失败:', exifError.message)
        }
      }
    }

    // 检查是否有任何元数据
    if (Object.keys(metadata).length === 0) {
      if (debug && logger) {
        logger.info('未找到任何 SD 元数据')
      }
      return null
    }

    return metadata
  } catch (error) {
    throw error
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

function formatOutput(session: Session, results: SDMetadata[], useForward: boolean): string | h[] {
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

  if (!useForward) {
    return messages.join('\n\n===\n\n')
  }

  // 使用合并转发
  const forwardNodes = messages.map(msg => 
    h('message', { forward: true }, [
      h('author', { id: session.bot.selfId, name: session.bot.user?.name || 'Bot' }),
      h('content', {}, msg)
    ])
  )

  return forwardNodes
}
