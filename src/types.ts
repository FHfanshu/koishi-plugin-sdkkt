/**
 * Type definitions for SD metadata parsing
 * Based on stable-diffusion-inspector reference implementation
 */

export interface SDMetadata {
  prompt?: string
  negativePrompt?: string
  steps?: string
  sampler?: string
  cfgScale?: string
  seed?: string
  size?: string
  model?: string
  parameters?: string

  // NovelAI specific fields
  naiBasePrompt?: string
  naiCharPrompts?: string[]
  naiNegBasePrompt?: string
  naiNegCharPrompts?: string[]
  naiVibe?: boolean
  naiCharRefs?: string[]

  // Fallback EXIF data when no SD metadata is found
  exifFallback?: Record<string, any>
}

export interface ImageSegment {
  type: string
  attrs?: Record<string, any>
  data?: Record<string, any>
  _source?: string
  [key: string]: any
}

export interface FetchImageResult {
  buffer: Buffer
  source: string
  sourceType: 'data-uri' | 'base64' | 'local' | 'bot-file'
}

export interface PNGTextChunks {
  [key: string]: string
}

export interface JPEGAppSegments {
  [key: string]: string
}

export interface ComfyUINode {
  id?: number
  type: string
  widgets_values?: any[]
  inputs?: Array<{
    name?: string
    type?: string
    link?: number
  }>
  outputs?: any[]
}

export interface ComfyUIWorkflow {
  nodes?: ComfyUINode[]
  links?: Array<number[]>  // [linkId, sourceNodeId, sourceSlot, targetNodeId, targetSlot, type]
  prompt?: any
  [key: string]: any
}

export interface NovelAIComment {
  uc?: string
  steps?: number
  scale?: number
  seed?: number
  sampler?: string
  uncond_per_vibe?: boolean
  v4_prompt?: {
    caption: {
      base_caption?: string
      char_captions?: any[]
    }
  }
  v4_negative_prompt?: {
    caption: {
      base_caption?: string
      char_captions?: any[]
    }
  }
  director_reference_descriptions?: any[]
  director_reference_strengths?: number[]
  director_reference_secondary_strengths?: number[]
}

export interface StealthPNGHeader {
  magic: string
  dataLength: number
  compressedData: Buffer
}

/**
 * Bit reader for Stealth PNG LSB extraction
 */
export class BitReader {
  private data: Uint8Array
  private index: number

  constructor(data: number[] | Uint8Array) {
    this.data = data instanceof Uint8Array ? data : new Uint8Array(data)
    this.index = 0
  }

  readBit(): number {
    if (this.index >= this.data.length) {
      throw new Error('BitReader: read beyond bounds')
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

  readNBytes(n: number): Uint8Array {
    const bytes = new Uint8Array(n)
    for (let i = 0; i < n; i++) {
      bytes[i] = this.readByte()
    }
    return bytes
  }

  readInt32(): number {
    const bytes = this.readNBytes(4)
    const buffer = Buffer.from(bytes)
    return buffer.readInt32BE(0)
  }
}

/**
 * Image format types
 */
export type ImageFormat = 'png' | 'webp' | 'jpeg' | null

/**
 * Parse result with error information
 */
export interface ParseResult<T> {
  success: boolean
  data?: T
  error?: string
}
