import { Buffer } from 'buffer'
import ExifReader from 'exifreader'
import { SDMetadata, ParseResult } from './types'
import { parseA1111Parameters } from './a1111'
import { extractNovelAIMetadata } from './novelai'

/**
 * Parse WebP metadata from buffer
 * Supports EXIF, XMP chunks and binary search
 */
export function parseWebPMetadata(buffer: Buffer): ParseResult<SDMetadata> {
  try {
    const metadata: SDMetadata = {}

    // 1. Try EXIF/XMP parsing using ExifReader
    try {
      const tags = ExifReader.load(buffer, { expanded: true })

      // Look for SD parameters in EXIF fields
      const exifFields = [
        'UserComment',
        'ImageDescription',
        'ImageComment',
        'XPComment',
        'Software'
      ]

      for (const fieldName of exifFields) {
        const field = (tags.exif as any)?.[fieldName]
        if (field) {
          const fieldValue: string | undefined = field?.description || field?.value || field?.text
          if (fieldValue && typeof fieldValue === 'string') {
            if (fieldValue.includes('Steps:') || fieldValue.includes('Sampler:') ||
                fieldValue.includes('CFG scale:') || fieldValue.includes('Seed:')) {
              metadata.parameters = fieldValue
              parseA1111Parameters(fieldValue, metadata)
              break
            }
          }
        }
      }

      // Check for NovelAI format
      if (tags?.exif?.Software) {
        const software = tags.exif.Software.description || tags.exif.Software.value
        if (software === 'NovelAI') {
          const descField: any = tags.exif?.ImageDescription
          const description: string | undefined = descField?.description || descField?.value || undefined

          const commentField: any = tags.exif?.UserComment
          const comment: string | undefined = commentField?.description || commentField?.value || undefined

          if (comment) {
            extractNovelAIMetadata(comment, description, metadata)
          }
        }
      }

      // XMP data
      if (tags.xmp && !metadata.parameters) {
        const xmpFields = ['description', 'Description', 'dc:description', 'tiff:ImageDescription']
        for (const xmpField of xmpFields) {
          const xmpDesc = (tags.xmp as any)[xmpField]
          if (xmpDesc) {
            const descValue = typeof xmpDesc === 'string' ? xmpDesc : (xmpDesc.value || xmpDesc.description)
            if (descValue && typeof descValue === 'string' && descValue.includes('Steps:')) {
              metadata.parameters = descValue
              parseA1111Parameters(descValue, metadata)
              break
            }
          }
        }
      }

    } catch (exifError) {
      // Continue if EXIF parsing fails
    }

    // 2. Manual WebP chunk parsing if EXIF didn't find metadata
    if (!metadata.parameters) {
      const chunkResult = parseWebPChunks(buffer)
      if (chunkResult.success && chunkResult.data) {
        Object.assign(metadata, chunkResult.data)
      }
    }

    // 3. Binary search as last resort
    if (!metadata.parameters) {
      const foundText = binarySearchForWebPMetadata(buffer)
      if (foundText) {
        metadata.parameters = foundText
        parseA1111Parameters(foundText, metadata)
      }
    }

    if (Object.keys(metadata).length === 0) {
      return {
        success: false,
        error: 'No SD metadata found in WebP'
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
 * Parse WebP chunks manually
 */
function parseWebPChunks(buffer: Buffer): ParseResult<SDMetadata> {
  try {
    const metadata: SDMetadata = {}

    // Verify WebP header
    if (buffer.length < 12 ||
        buffer.slice(0, 4).toString() !== 'RIFF' ||
        buffer.slice(8, 12).toString() !== 'WEBP') {
      return {
        success: false,
        error: 'Invalid WebP file'
      }
    }

    let offset = 12

    while (offset < buffer.length - 8) {
      // Read chunk FourCC
      const chunkFourCC = buffer.slice(offset, offset + 4).toString()
      offset += 4

      // Read chunk size (little-endian)
      if (offset + 4 > buffer.length) break
      const chunkSize = buffer.readUInt32LE(offset)
      offset += 4

      // Ensure chunk data is complete
      if (offset + chunkSize > buffer.length) break

      const chunkData = buffer.slice(offset, offset + chunkSize)
      offset += chunkSize

      // Skip padding (chunk size must be even)
      if (chunkSize % 2 === 1) {
        offset++
      }

      // Process EXIF and XMP chunks
      if (chunkFourCC === 'EXIF' || chunkFourCC === 'XMP ') {
        const textContent = extractWebPChunkText(chunkData)

        if (textContent) {
          if (textContent.includes('Steps:') || textContent.includes('Sampler:') ||
              textContent.includes('CFG scale:') || textContent.includes('Seed:')) {
            metadata.parameters = textContent
            parseA1111Parameters(textContent, metadata)
            return {
              success: true,
              data: metadata
            }
          }
        }
      }
    }

    if (metadata.parameters) {
      return {
        success: true,
        data: metadata
      }
    }

    return {
      success: false,
      error: 'No metadata found in WebP chunks'
    }

  } catch (error: any) {
    return {
      success: false,
      error: error.message
    }
  }
}

/**
 * Extract text from WebP chunk with multiple encodings
 */
function extractWebPChunkText(chunkData: Buffer): string {
  const encodings = ['utf8', 'utf16le', 'ascii', 'latin1']

  for (const encoding of encodings) {
    try {
      let text = chunkData.toString(encoding as BufferEncoding)

      // Remove null bytes and control characters for some encodings
      if (encoding === 'utf16le') {
        text = text.replace(/\0/g, '')
      }

      if (text.includes('Steps:') || text.includes('Sampler:') ||
          text.includes('CFG scale:') || text.includes('Seed:')) {
        return text
      }
    } catch {
      continue
    }
  }

  return ''
}

/**
 * Binary search for SD metadata in WebP
 */
function binarySearchForWebPMetadata(buffer: Buffer): string | null {
  const minLength = 50

  // Search patterns
  const patterns = [
    /Steps:\s*\d+.*?Sampler:\s*[^,\n]+/gi,
    /CFG\s*scale:\s*[\d.]+.*?Seed:\s*\d+/gi,
  ]

  // Try different encodings
  for (const encoding of ['utf8', 'utf16le', 'latin1', 'ascii']) {
    try {
      const text = buffer.toString(encoding as BufferEncoding)

      for (const pattern of patterns) {
        const matches = text.match(pattern)
        if (matches && matches.length > 0) {
          const matchIndex = text.indexOf(matches[0])
          const startPos = Math.max(0, matchIndex - 100)
          const endPos = Math.min(text.length, matchIndex + 1000)
          const candidate = text.slice(startPos, endPos)

          if (candidate.includes('Steps:') && (
            candidate.includes('Sampler:') ||
            candidate.includes('CFG scale:')
          )) {
            return candidate
          }
        }
      }
    } catch {
      continue
    }
  }

  // Search for byte patterns
  const binaryPatterns = [
    Buffer.from('Steps:'),
    Buffer.from('parameters')
  ]

  for (const pattern of binaryPatterns) {
    const index = buffer.indexOf(pattern)
    if (index !== -1) {
      const startPos = Math.max(0, index - 200)
      const endPos = Math.min(buffer.length, index + 2000)
      const chunk = buffer.slice(startPos, endPos)

      for (const encoding of ['utf8', 'utf16le', 'latin1', 'ascii']) {
        try {
          const text = chunk.toString(encoding as BufferEncoding)
          if (text.includes('Steps:') && text.length > minLength) {
            return text
          }
        } catch {
          continue
        }
      }
    }
  }

  return null
}

export default {
  parseWebPMetadata
}
