import { Buffer } from 'buffer'
import { PNG } from 'pngjs'
import { gunzipSync, inflateSync } from 'zlib'
import { SDMetadata, PNGTextChunks, ParseResult } from './types'
import { parseA1111Parameters } from './a1111'
import { extractComfyUIMetadata } from './comfyui'
import { extractNovelAIMetadata } from './novelai'
import { extractStealthPngMetadata } from './stealth'

/**
 * Parse PNG metadata from buffer
 * Supports tEXt, iTXt, zTXt chunks and Stealth PNG
 */
export function parsePNGMetadata(buffer: Buffer): ParseResult<SDMetadata> {
  try {
    // Extract text chunks
    const textChunks = extractPngTextChunks(buffer)
    const metadata: SDMetadata = {}

    // A1111 standard format (parameters field)
    if (textChunks.parameters) {
      metadata.parameters = textChunks.parameters
      parseA1111Parameters(textChunks.parameters, metadata)
    }
    // ComfyUI format (JSON prompt)
    else if (textChunks.prompt) {
      try {
        const promptData = JSON.parse(textChunks.prompt)
        extractComfyUIMetadata(null, promptData, metadata)
      } catch {
        metadata.prompt = textChunks.prompt
      }
    }

    // NovelAI format detection
    if (textChunks.Software === 'NovelAI' || textChunks.software === 'NovelAI') {
      const description = textChunks.Description || textChunks.description
      const comment = textChunks.Comment || textChunks.comment
      if (comment) {
        extractNovelAIMetadata(comment, description || undefined, metadata)
      }
    }

    // Other common fields
    if (textChunks.Description && !metadata.prompt) {
      metadata.prompt = textChunks.Description
    }

    // Comment field (could be JSON or A1111 format)
    if (textChunks.Comment && !metadata.parameters) {
      try {
        const commentData = JSON.parse(textChunks.Comment)
        if (commentData.prompt || commentData.uc) {
          if (commentData.prompt) metadata.prompt = commentData.prompt
          if (commentData.uc) metadata.negativePrompt = commentData.uc
          if (commentData.steps) metadata.steps = String(commentData.steps)
          if (commentData.scale) metadata.cfgScale = String(commentData.scale)
          if (commentData.seed) metadata.seed = String(commentData.seed)
          if (commentData.sampler) metadata.sampler = commentData.sampler
        }
      } catch {
        if (textChunks.Comment.includes('Steps:')) {
          metadata.parameters = textChunks.Comment
          parseA1111Parameters(textChunks.Comment, metadata)
        }
      }
    }

    // ComfyUI workflow
    if (textChunks.workflow) {
      try {
        const workflow = JSON.parse(textChunks.workflow)
        extractComfyUIMetadata(workflow, null, metadata)
      } catch {
        // Ignore parse errors
      }
    }

    // If no metadata found, try Stealth PNG (LSB steganography)
    if (Object.keys(metadata).length === 0 || !metadata.parameters) {
      const stealthResult = parseStealthPNGMetadata(buffer)
      if (stealthResult.success && stealthResult.data) {
        Object.assign(metadata, stealthResult.data)
      }
    }

    return {
      success: true,
      data: metadata
    }
  } catch (error: any) {
    return {
      success: false,
      error: error.message
    }
  }
}

/**
 * Extract Stealth PNG metadata using LSB steganography
 */
function parseStealthPNGMetadata(buffer: Buffer): ParseResult<SDMetadata> {
  try {
    const png = PNG.sync.read(buffer)
    const stealthMetadata = extractStealthPngMetadata(png)

    if (stealthMetadata) {
      return {
        success: true,
        data: stealthMetadata
      }
    }

    return {
      success: false,
      error: 'No Stealth PNG metadata found'
    }
  } catch (error: any) {
    return {
      success: false,
      error: `Failed to parse Stealth PNG: ${error.message}`
    }
  }
}

/**
 * Extract PNG text chunks (tEXt, iTXt, zTXt)
 * Manual parsing since pngjs doesn't parse text chunks by default
 */
function extractPngTextChunks(buffer: Buffer): PNGTextChunks {
  const textChunks: PNGTextChunks = {}

  try {
    let offset = 8 // Skip PNG signature

    while (offset < buffer.length - 12) {
      // Read chunk length (big-endian)
      const length = buffer.readUInt32BE(offset)
      offset += 4

      // Read chunk type
      const type = buffer.toString('ascii', offset, offset + 4)
      offset += 4

      // Read chunk data
      const chunkData = buffer.slice(offset, offset + length)
      offset += length

      // Skip CRC
      offset += 4

      // Process text chunks
      if (type === 'tEXt') {
        parseTextChunk(chunkData, textChunks)
      } else if (type === 'iTXt') {
        parseInternationalTextChunk(chunkData, textChunks)
      } else if (type === 'zTXt') {
        parseCompressedTextChunk(chunkData, textChunks)
      } else if (type === 'IEND') {
        break
      }
    }
  } catch (error) {
    // Continue even if parsing fails partially
  }

  return textChunks
}

/**
 * Parse tEXt chunk (keyword\0text)
 */
function parseTextChunk(chunkData: Buffer, textChunks: PNGTextChunks): void {
  const nullIndex = chunkData.indexOf(0)
  if (nullIndex !== -1) {
    const keyword = chunkData.toString('latin1', 0, nullIndex)
    const text = chunkData.toString('utf8', nullIndex + 1)
    textChunks[keyword] = text
  }
}

/**
 * Parse iTXt chunk (keyword\0compressionFlag\0compressionMethod\0languageTag\0translatedKeyword\0text)
 */
function parseInternationalTextChunk(chunkData: Buffer, textChunks: PNGTextChunks): void {
  const nullIndex = chunkData.indexOf(0)
  if (nullIndex === -1) return

  const keyword = chunkData.toString('latin1', 0, nullIndex)
  const compressionFlag = chunkData[nullIndex + 1]
  const compressionMethod = chunkData[nullIndex + 2]

  let pos = nullIndex + 3

  // Find language tag end
  const langEnd = chunkData.indexOf(0, pos)
  if (langEnd === -1) return
  pos = langEnd + 1

  // Find translated keyword end
  const transEnd = chunkData.indexOf(0, pos)
  if (transEnd === -1) return
  pos = transEnd + 1

  // Read text
  let text: string
  if (compressionFlag === 1 && compressionMethod === 0) {
    // Decompress
    try {
      const compressed = chunkData.slice(pos)
      const decompressed = gunzipSync(compressed)
      text = decompressed.toString('utf8')
    } catch {
      text = chunkData.toString('utf8', pos)
    }
  } else {
    text = chunkData.toString('utf8', pos)
  }

  textChunks[keyword] = text
}

/**
 * Parse zTXt chunk (keyword\0compressionMethod\0compressedText)
 */
function parseCompressedTextChunk(chunkData: Buffer, textChunks: PNGTextChunks): void {
  const nullIndex = chunkData.indexOf(0)
  if (nullIndex === -1) return

  const keyword = chunkData.toString('latin1', 0, nullIndex)
  const compressionMethod = chunkData[nullIndex + 1]

  if (compressionMethod === 0) {
    // zlib compression
    try {
      const compressed = chunkData.slice(nullIndex + 2)
      const decompressed = inflateSync(compressed)
      const text = decompressed.toString('utf8')
      textChunks[keyword] = text
    } catch {
      // Ignore decompression errors
    }
  }
}

export default {
  parsePNGMetadata
}
