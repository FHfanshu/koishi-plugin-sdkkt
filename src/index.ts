import { Context, Schema, h, Session, Next } from 'koishi'
import { PNG } from 'pngjs'
import axios from 'axios'

export const name = 'sdexif'

export interface Config {
  useForward: boolean
}

export const Config: Schema<Config> = Schema.object({
  useForward: Schema.boolean()
    .default(false)
    .description('是否使用合并转发格式发送消息')
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
  ctx.command('sdexif', '读取图片中的 Stable Diffusion 信息')
    .alias('读图')
    .action(async ({ session }) => {
      if (!session) return '无法获取会话信息'
      
      return '请发送要读取的图片'
    })

  ctx.middleware(async (session: Session, next: Next) => {
    // 检查消息中是否包含图片
    const imageElements = (session.elements || []).filter((el: h) => el.type === 'img' || el.type === 'image')
    
    if (imageElements.length === 0) {
      return next()
    }

    // 检查消息是否包含 sdexif 指令
    const text = session.content || ''
    if (!text.includes('sdexif') && !text.includes('读图')) {
      return next()
    }

    // 处理每个图片
    const results: SDMetadata[] = []
    
    for (const imgEl of imageElements) {
      const url = imgEl.attrs?.src || imgEl.attrs?.url
      
      if (!url) continue

      try {
        const metadata = await extractSDMetadata(url)
        if (metadata) {
          results.push(metadata)
        }
      } catch (error: any) {
        ctx.logger('sdexif').warn(`解析图片失败: ${error?.message || error}`)
      }
    }

    if (results.length === 0) {
      return '未能从图片中读取到 Stable Diffusion 信息'
    }

    // 格式化输出
    return formatOutput(session, results, config.useForward)
  })
}

async function extractSDMetadata(url: string): Promise<SDMetadata | null> {
  try {
    // 下载图片
    const response = await axios.get(url, {
      responseType: 'arraybuffer',
      timeout: 30000,
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36'
      }
    })

    const buffer = Buffer.from(response.data)

    // 检查是否为 PNG 图片
    if (!isPNG(buffer)) {
      return null
    }

    // 解析 PNG
    const png = PNG.sync.read(buffer)
    const metadata: SDMetadata = {}

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

    // 检查是否有任何元数据
    if (Object.keys(metadata).length === 0) {
      return null
    }

    return metadata
  } catch (error) {
    throw error
  }
}

function isPNG(buffer: Buffer): boolean {
  return buffer.length >= 8 && 
         buffer[0] === 0x89 && 
         buffer[1] === 0x50 && 
         buffer[2] === 0x4E && 
         buffer[3] === 0x47
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
