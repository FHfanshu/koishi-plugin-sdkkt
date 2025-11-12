import { SDMetadata } from './types'

/**
 * A1111 Parameter format parser
 * Format: "prompt\nNegative prompt: xxx\nSteps: xx, Sampler: xxx, ..."
 */

export interface A1111Parameters {
  prompt: string
  negativePrompt?: string
  steps?: string
  sampler?: string
  cfgScale?: string
  seed?: string
  size?: string
  model?: string
  modelHash?: string
  clipSkip?: string
  denoisingStrength?: string
  batchSize?: string
  batchCount?: string
}

/**
 * Parse A1111 format parameters string
 */
export function parseA1111Parameters(parameters: string, metadata: SDMetadata): void {
  if (!parameters || typeof parameters !== 'string') return

  const lines = parameters.split('\n')
  if (lines.length === 0) return

  // Extract prompt (lines before "Negative prompt:" or "Steps:")
  const promptLines: string[] = []
  let paramsStartIndex = 0

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].trim()
    if (line.startsWith('Negative prompt:') || line.startsWith('Steps:')) {
      paramsStartIndex = i
      break
    }
    if (line) promptLines.push(line)
  }

  metadata.prompt = promptLines.join('\n').trim()

  // Parse parameters
  for (let i = paramsStartIndex; i < lines.length; i++) {
    const line = lines[i].trim()
    if (!line) continue

    if (line.startsWith('Negative prompt:')) {
      metadata.negativePrompt = line.substring('Negative prompt:'.length).trim()
    } else {
      parseParameterLine(line, metadata)
    }
  }
}

/**
 * Parse a parameter line (e.g., "Steps: 20, Sampler: Euler a, CFG scale: 7, ...")
 */
function parseParameterLine(line: string, metadata: SDMetadata): void {
  const params = line.split(',').map(p => p.trim()).filter(p => p.length > 0)

  for (const param of params) {
    // Handle key:value pairs
    const colonIndex = param.indexOf(':')
    if (colonIndex === -1) continue

    const key = param.substring(0, colonIndex).trim()
    const value = param.substring(colonIndex + 1).trim()

    if (!key || !value) continue

    const lowerKey = key.toLowerCase()

    // Common parameters
    if (lowerKey.includes('steps')) {
      metadata.steps = value
    } else if (lowerKey.includes('sampler')) {
      metadata.sampler = value
    } else if (lowerKey.includes('cfg') && lowerKey.includes('scale')) {
      metadata.cfgScale = value
    } else if (lowerKey.includes('seed')) {
      metadata.seed = value
    } else if (lowerKey.includes('size')) {
      metadata.size = value
    } else if (lowerKey.includes('model') && !lowerKey.includes('hash')) {
      metadata.model = value
    }
  }
}

/**
 * Serialize metadata back to A1111 format
 */
export function serializeA1111Parameters(metadata: Partial<A1111Parameters>): string {
  const parts: string[] = []

  if (metadata.prompt) {
    parts.push(metadata.prompt)
  }

  if (metadata.negativePrompt) {
    parts.push(`\nNegative prompt: ${metadata.negativePrompt}`)
  }

  const params: string[] = []
  if (metadata.steps) params.push(`Steps: ${metadata.steps}`)
  if (metadata.sampler) params.push(`Sampler: ${metadata.sampler}`)
  if (metadata.cfgScale) params.push(`CFG scale: ${metadata.cfgScale}`)
  if (metadata.seed) params.push(`Seed: ${metadata.seed}`)
  if (metadata.size) params.push(`Size: ${metadata.size}`)
  if (metadata.model) params.push(`Model: ${metadata.model}`)
  if (metadata.modelHash) params.push(`Model hash: ${metadata.modelHash}`)
  if (metadata.clipSkip) params.push(`Clip skip: ${metadata.clipSkip}`)
  if (metadata.denoisingStrength) params.push(`Denoising strength: ${metadata.denoisingStrength}`)

  if (params.length > 0) {
    parts.push(`\n${params.join(', ')}`)
  }

  return parts.join('')
}

/**
 * Check if a string looks like A1111 parameters
 */
export function isA1111Format(text: string): boolean {
  if (!text || typeof text !== 'string') return false

  // Must contain Steps: and at least one other parameter
  const hasSteps = /Steps:\s*\d+/i.test(text)
  const hasOtherParam = /(Sampler|CFG scale|Seed|Size|Model):/i.test(text)

  return hasSteps || hasOtherParam
}

/**
 * Extract specific parameter value
 */
export function extractParameter(parameters: string, key: string): string | undefined {
  const lowerKey = key.toLowerCase()
  const lines = parameters.split('\n')

  for (const line of lines) {
    if (line.toLowerCase().includes(lowerKey)) {
      const parts = line.split(',')
      for (const part of parts) {
        if (part.toLowerCase().includes(lowerKey)) {
          const colonIndex = part.indexOf(':')
          if (colonIndex !== -1) {
            return part.substring(colonIndex + 1).trim()
          }
        }
      }
    }
  }

  return undefined
}

/**
 * Parse dimensions from size string (e.g., "512x768" or "512 x 768")
 */
export function parseDimensions(size: string): { width: number; height: number } | null {
  if (!size) return null

  const match = size.match(/(\d+)\s*[xX]\s*(\d+)/)
  if (!match) return null

  return {
    width: parseInt(match[1], 10),
    height: parseInt(match[2], 10)
  }
}

export default {
  parseA1111Parameters,
  serializeA1111Parameters,
  isA1111Format,
  extractParameter,
  parseDimensions
}
