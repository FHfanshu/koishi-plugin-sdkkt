import { Buffer } from 'buffer'
import ExifReader from 'exifreader'
import { SDMetadata, ParseResult } from './types'
import { parseA1111Parameters } from './a1111'
import { extractNovelAIMetadata } from './novelai'

/**
 * Parse WebP metadata from buffer
 * Supports EXIF, XMP chunks and binary search
 */
export function parseWebPMetadata(buffer: Buffer, logger?: any): ParseResult<SDMetadata> {
  try {
    const metadata: SDMetadata = {}
    let exifData: Record<string, any> | null = null

    // 1. Try EXIF/XMP parsing using ExifReader - enhanced search
    try {
      const tags = ExifReader.load(buffer, {
        expanded: true,
        includeUnknown: true  // Include unknown tags
      })

      if (logger) logger.info('[WebP] EXIF parsing attempted, checking for SD metadata fields')

      // Collect all EXIF data for fallback
      exifData = {}

      // Look for SD parameters in EXIF fields - check all fields
      const exifFields = [
        'UserComment',
        'ImageDescription',
        'ImageComment',
        'XPComment',
        'Software'
      ]

      // Check all EXIF fields, not just standard ones
      const exif = tags.exif
      if (exif && !metadata.parameters) {
        if (logger) logger.info(`[WebP] EXIF object found with ${Object.keys(exif).length} fields, scanning for SD parameters`)

        for (const [fieldName, field] of Object.entries(exif as any)) {
          try {
            // Skip invalid fields
            if (!field || typeof field !== 'object') continue

            const fieldAny = field as any
            const fieldValue: string | undefined = fieldAny?.description || fieldAny?.value || fieldAny?.text

            // Collect all fields for fallback
            exifData[fieldName] = fieldAny

            if (fieldValue && typeof fieldValue === 'string') {
              if (fieldValue.includes('Steps:') || fieldValue.includes('Sampler:') ||
                  fieldValue.includes('CFG scale:') || fieldValue.includes('Seed:')) {
                const lines = fieldValue.split('\n').slice(0, 2).join('\n')
                if (logger) {
                  logger.info(`[WebP] Found SD metadata in EXIF field "${fieldName}"`)
                  logger.info(`[WebP] Content preview (first 2 lines):\n${lines}`)
                }
                metadata.parameters = fieldValue
                parseA1111Parameters(fieldValue, metadata)
                break
              }
            }
          } catch {
            // Skip problematic fields
          }
        }
      }

      // Try standard fields if not found yet
      if (!metadata.parameters && exif) {
        if (logger) logger.info('[WebP] Checking standard EXIF fields for SD metadata')

        for (const fieldName of exifFields) {
          const field = (exif as any)?.[fieldName]
          if (field) {
            // Collect field for fallback
            exifData[fieldName] = field

            const fieldValue: string | undefined = field?.description || field?.value || field?.text
            if (fieldValue && typeof fieldValue === 'string') {
              if (fieldValue.includes('Steps:') || fieldValue.includes('Sampler:') ||
                  fieldValue.includes('CFG scale:') || fieldValue.includes('Seed:')) {
                const lines = fieldValue.split('\n').slice(0, 2).join('\n')
                if (logger) {
                  logger.info(`[WebP] Found SD metadata in standard EXIF field "${fieldName}"`)
                  logger.info(`[WebP] Content preview (first 2 lines):\n${lines}`)
                }
                metadata.parameters = fieldValue
                parseA1111Parameters(fieldValue, metadata)
                break
              }
            }
          }
        }
      }

      // Check for NovelAI format
      if (!metadata.parameters && tags?.exif?.Software) {
        const software = tags.exif.Software.description || tags.exif.Software.value
        if (software === 'NovelAI') {
          const descField: any = tags.exif?.ImageDescription
          const description: string | undefined = descField?.description || descField?.value || undefined

          const commentField: any = tags.exif?.UserComment
          const comment: string | undefined = commentField?.description || commentField?.value || undefined

          if (comment) {
            extractNovelAIMetadata(comment, description, metadata)
            metadata.parameters = comment
          }
        }
      }

      // XMP data - enhanced search
      if (tags.xmp && !metadata.parameters) {
        if (logger) logger.info('[WebP] XMP data found, searching for SD metadata')

        // Collect XMP fields
        exifData['XMP'] = tags.xmp

        try {
          // Try to stringify and search through XMP
          const xmpStr = JSON.stringify(tags.xmp)
          if (xmpStr.includes('Steps:') || xmpStr.includes('parameters')) {
            const extracted = extractFromXMPLikeText(xmpStr)
            if (extracted && extracted.includes('Steps:')) {
              const lines = extracted.split('\n').slice(0, 2).join('\n')
              if (logger) {
                logger.info('[WebP] Found SD metadata in XMP data')
                logger.info(`[WebP] Content preview (first 2 lines):\n${lines}`)
              }
              metadata.parameters = extracted
              parseA1111Parameters(extracted, metadata)
            }
          }

          // Also try field-based search
          if (!metadata.parameters) {
            const xmpFields = ['description', 'Description', 'dc:description', 'tiff:ImageDescription']
            for (const xmpField of xmpFields) {
              const xmpDesc = (tags.xmp as any)[xmpField]
              if (xmpDesc) {
                const descValue = typeof xmpDesc === 'string' ? xmpDesc : (xmpDesc.value || xmpDesc.description)
                if (descValue && typeof descValue === 'string' && descValue.includes('Steps:')) {
                  const lines = descValue.split('\n').slice(0, 2).join('\n')
                  if (logger) {
                    logger.info(`[WebP] Found SD metadata in XMP field "${xmpField}"`)
                    logger.info(`[WebP] Content preview (first 2 lines):\n${lines}`)
                  }
                  metadata.parameters = descValue
                  parseA1111Parameters(descValue, metadata)
                  break
                }
              }
            }
          }
        } catch {
          // Continue if XMP parsing fails
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

    // 3. Binary search as last resort - use more aggressive search
    if (!metadata.parameters) {
      // Use the enhanced binary search from jpeg.ts
      const { binarySearchForMetadata } = require('./jpeg')
      const foundText = binarySearchForMetadata(buffer, 'webp')
      if (foundText) {
        metadata.parameters = foundText
        parseA1111Parameters(foundText, metadata)
      }
    }

    // If no SD metadata found but we have EXIF data, use fallback
    if (Object.keys(metadata).length === 0 && exifData && Object.keys(exifData).length > 0) {
      if (logger) {
        logger.info(`[WebP] No SD metadata found, but ${Object.keys(exifData).length} EXIF fields available - using fallback`)
      }
      metadata.exifFallback = exifData
      return {
        success: true,
        data: metadata
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
 * Extract from XMP-like text
 */
function extractFromXMPLikeText(xmpStr: string): string | null {
  try {
    // Look for JSON objects that might contain parameters
    const jsonMatches = xmpStr.match(/\{[^}]*steps[^}]*\}/gi)
    if (jsonMatches) {
      for (const match of jsonMatches) {
        try {
          const parsed = JSON.parse(match)
          if (parsed.parameters || (parsed.steps && parsed.sampler)) {
            return parsed.parameters || `Steps: ${parsed.steps}, Sampler: ${parsed.sampler}`
          }
        } catch {
          continue
        }
      }
    }

    // Look for plain text parameters
    const paramMatch = xmpStr.match(/[^}{]*Steps:\s*\d+[^}{]*Sampler:[^}{]*/g)
    if (paramMatch && paramMatch.length > 0) {
      return paramMatch[0]
    }
  } catch {
    //
  }
  return null
}

export default {
  parseWebPMetadata
}
