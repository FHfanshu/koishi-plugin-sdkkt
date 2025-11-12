import { Buffer } from 'buffer'
import ExifReader from 'exifreader'
import { SDMetadata, JPEGAppSegments, ParseResult } from './types'
import { parseA1111Parameters } from './a1111'
import { extractNovelAIMetadata } from './novelai'

/**
 * Parse JPEG metadata from buffer
 * Supports APP segments and EXIF data
 */
export function parseJPEGMetadata(buffer: Buffer, logger?: any): ParseResult<SDMetadata> {
  try {
    const metadata: SDMetadata = {}
    let exifData: Record<string, any> | null = null

    // 1. First, try manual APP segment parsing
    const appSegments = extractJpegAppSegments(buffer)

    for (const [appName, content] of Object.entries(appSegments)) {
      if (content.includes('Steps:') || content.includes('Sampler:') ||
          content.includes('CFG scale:') || content.includes('Seed:')) {
        if (logger) logger.info(`[JPEG] Found metadata in APP segment ${appName}`)
        metadata.parameters = content
        parseA1111Parameters(content, metadata)
        break
      }
    }

    // 2. If not found in APP segments, try EXIF
    if (!metadata.parameters) {
      try {
        // Try to parse EXIF with expanded option to get all tags
        const tags = ExifReader.load(buffer, {
          expanded: true,
          includeUnknown: true  // Include tags ExifReader doesn't recognize
        })

        if (logger) logger.info('[JPEG] EXIF parsing attempted, checking for SD metadata fields')

        // Collect all EXIF data for fallback
        exifData = {}

        // Extended EXIF fields to search - check ALL possible fields
        const exifFields = [
          'UserComment',
          'ImageDescription',
          'ImageComment',
          'XPComment',
          'XPKeywords',
          'Artist',
          'Copyright',
          'Software',
          'DocumentName',
          'PageName',
          'HostComputer',
          'Make',
          'Model'
        ]

        // Also check if there's an EXIF object with custom fields
        const exif = tags.exif
        if (exif) {
          if (logger) logger.info(`[JPEG] EXIF object found with ${Object.keys(exif).length} fields, scanning for SD parameters`)

          // Iterate through all fields in the EXIF object
          for (const [fieldName, field] of Object.entries(exif as any)) {
            try {
              // Skip if already checked the standard fields
              if (exifFields.includes(fieldName)) continue

              const fieldAny = field as any
              const fieldValue = fieldAny?.description || fieldAny?.value || fieldAny?.text

              // Collect all fields for fallback
              exifData[fieldName] = fieldAny

              if (fieldValue && typeof fieldValue === 'string') {
                if (fieldValue.includes('Steps:') || fieldValue.includes('Sampler:') ||
                    fieldValue.includes('CFG scale:') || fieldValue.includes('Seed:')) {
                  const lines = fieldValue.split('\n').slice(0, 2).join('\n')
                  if (logger) {
                    logger.info(`[JPEG] Found SD metadata in EXIF field "${fieldName}"`)
                    logger.info(`[JPEG] Content preview (first 2 lines):\n${lines}`)
                  }
                  metadata.parameters = fieldValue
                  parseA1111Parameters(fieldValue, metadata)
                  break
                }
              }
            } catch {
              // Skip invalid fields
            }
          }
        }

        // Check standard fields if not found yet
        if (!metadata.parameters) {
          if (logger) logger.info('[JPEG] Checking standard EXIF fields for SD metadata')

          for (const fieldName of exifFields) {
            const field = (tags.exif as any)?.[fieldName]
            if (field) {
              // Collect field for fallback
              exifData[fieldName] = field

              const fieldValue = field.description || field.value
              if (fieldValue && typeof fieldValue === 'string') {
                if (fieldValue.includes('Steps:') || fieldValue.includes('Sampler:') ||
                    fieldValue.includes('CFG scale:') || fieldValue.includes('Seed:')) {
                  const lines = fieldValue.split('\n').slice(0, 2).join('\n')
                  if (logger) {
                    logger.info(`[JPEG] Found SD metadata in standard EXIF field "${fieldName}"`)
                    logger.info(`[JPEG] Content preview (first 2 lines):\n${lines}`)
                  }
                  metadata.parameters = fieldValue
                  parseA1111Parameters(fieldValue, metadata)
                  break
                }
              }
            }
          }
        }

        // Check for NovelAI format in JPEG
        if (!metadata.parameters && tags?.exif?.Software) {
          const software = tags.exif.Software.description || tags.exif.Software.value
          if (software === 'NovelAI') {
            const descField = tags.exif?.ImageDescription as any
            const description = descField?.description || descField?.value || undefined

            const commentField = tags.exif?.UserComment as any
            const comment = commentField?.description || commentField?.value || undefined

            if (comment) {
              extractNovelAIMetadata(comment, description, metadata)
              // Set parameters as a fallback display
              metadata.parameters = comment
            }
          }
        }

        // XMP data - check all fields
        if (tags.xmp && !metadata.parameters) {
          if (logger) logger.info('[JPEG] XMP data found, searching for SD metadata')

          // Collect XMP fields
          exifData['XMP'] = tags.xmp

          // Try to stringify XMP and search for parameters
          try {
            const xmpStr = JSON.stringify(tags.xmp)
            if (xmpStr.includes('Steps:') || xmpStr.includes('parameters')) {
              // Search for parameter-like content in XMP
              const patterns = [
                /Steps:\s*\d+.*?Sampler:\s*[^,\n]+/g,
                /\{"steps":\s*\d+/g
              ]
              for (const pattern of patterns) {
                const match = xmpStr.match(pattern)
                if (match && match.length > 0) {
                  // Try to extract JSON or plain text
                  let extracted = extractFromXMPLikeText(xmpStr)
                  if (extracted && extracted.includes('Steps:')) {
                    const lines = extracted.split('\n').slice(0, 2).join('\n')
                    if (logger) {
                      logger.info('[JPEG] Found SD metadata in XMP data')
                      logger.info(`[JPEG] Content preview (first 2 lines):\n${lines}`)
                    }
                    metadata.parameters = extracted
                    parseA1111Parameters(extracted, metadata)
                    break
                  }
                }
              }
            }
          } catch {
            // Fall back to field-based search
            const xmpFields = ['description', 'Description', 'dc:description', 'tiff:ImageDescription']
            for (const xmpField of xmpFields) {
              const xmpDesc = (tags.xmp as any)[xmpField]
              if (xmpDesc) {
                const descValue = typeof xmpDesc === 'string' ? xmpDesc : (xmpDesc.value || xmpDesc.description)
                if (descValue && descValue.includes('Steps:')) {
                  const lines = descValue.split('\n').slice(0, 2).join('\n')
                  if (logger) {
                    logger.info(`[JPEG] Found SD metadata in XMP field "${xmpField}"`)
                    logger.info(`[JPEG] Content preview (first 2 lines):\n${lines}`)
                  }
                  metadata.parameters = descValue
                  parseA1111Parameters(descValue, metadata)
                  break
                }
              }
            }
          }
        }

        // IPTC data
        if (tags.iptc && !metadata.parameters) {
          if (logger) logger.info('[JPEG] IPTC data found, checking Caption/Abstract')

          // Collect IPTC fields
          exifData['IPTC'] = tags.iptc

          const iptcCaption = (tags.iptc as any)['Caption/Abstract']
          if (iptcCaption) {
            const captionValue = typeof iptcCaption === 'string' ? iptcCaption : (iptcCaption.value || iptcCaption.description)
            if (captionValue && captionValue.includes('Steps:')) {
              const lines = captionValue.split('\n').slice(0, 2).join('\n')
              if (logger) {
                logger.info('[JPEG] Found SD metadata in IPTC Caption/Abstract')
                logger.info(`[JPEG] Content preview (first 2 lines):\n${lines}`)
              }
              metadata.parameters = captionValue
              parseA1111Parameters(captionValue, metadata)
            }
          }
        }

      } catch (exifError) {
        // Continue even if EXIF parsing fails
      }
    }

    // 3. Binary search as last resort - more aggressive search
    if (!metadata.parameters) {
      const foundText = binarySearchForMetadata(buffer, 'jpeg')
      if (foundText) {
        metadata.parameters = foundText
        parseA1111Parameters(foundText, metadata)
      }
    }

    // If no SD metadata found but we have EXIF data, use fallback
    if (Object.keys(metadata).length === 0 && exifData && Object.keys(exifData).length > 0) {
      if (logger) {
        logger.info(`[JPEG] No SD metadata found, but ${Object.keys(exifData).length} EXIF fields available - using fallback`)
      }
      metadata.exifFallback = exifData
      return {
        success: true,
        data: metadata
      }
    }

    // If still no metadata found
    if (Object.keys(metadata).length === 0) {
      return {
        success: false,
        error: 'No SD metadata found in JPEG'
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

/**
 * Extract JPEG APP segments
 */
function extractJpegAppSegments(buffer: Buffer): JPEGAppSegments {
  const appSegments: JPEGAppSegments = {}

  try {
    // Check JPEG header (FF D8 FF)
    if (buffer.length < 3 || buffer[0] !== 0xFF || buffer[1] !== 0xD8 || buffer[2] !== 0xFF) {
      return appSegments
    }

    let offset = 2

    while (offset < buffer.length - 4) {
      // Find next marker (FF xx)
      if (buffer[offset] !== 0xFF) {
        offset++
        continue
      }

      const marker = buffer[offset + 1]
      offset += 2

      // Skip padding (FF FF)
      if (marker === 0xFF) {
        continue
      }

      // Start of scan or end of image
      if (marker === 0xDA || marker === 0xD9) {
        break
      }

      // Read segment length (big-endian, includes length field)
      if (offset + 2 > buffer.length) break
      const segmentLength = buffer.readUInt16BE(offset)
      offset += 2

      // Ensure data is complete
      if (offset + segmentLength - 2 > buffer.length) break

      const segmentData = buffer.slice(offset, offset + segmentLength - 2)
      offset += segmentLength - 2

      // Process APP segments (0xE0-0xEF)
      if (marker >= 0xE0 && marker <= 0xEF) {
        const appName = `APP${marker - 0xE0}`
        const content = extractSegmentText(segmentData)

        if (content) {
          appSegments[appName] = content
        }
      }

      // Process COM (comment) segment (0xFE)
      if (marker === 0xFE) {
        const content = segmentData.toString('utf8').replace(/\0/g, '')
        if (content) {
          appSegments['COM'] = content
        }
      }
    }
  } catch {
    // Ignore parsing errors
  }

  return appSegments
}

/**
 * Extract text from segment data using multiple encodings
 */
function extractSegmentText(segmentData: Buffer): string {
  if (segmentData.length === 0) return ''

  // Try different encodings
  const encodings = ['utf8', 'ascii', 'latin1']

  for (const encoding of encodings) {
    try {
      const text = segmentData.toString(encoding as BufferEncoding)
      // Check if it contains SD parameters
      if (text.includes('Steps:') || text.includes('Sampler:') ||
          text.includes('CFG scale:') || text.includes('Seed:') ||
          text.includes('prompt')) {
        return text
      }
    } catch {
      continue
    }
  }

  // Check if it's EXIF data
  if (segmentData.length > 6 && segmentData.slice(0, 6).toString() === 'Exif\0\0') {
    const exifData = segmentData.slice(6)
    for (const encoding of ['utf8', 'ascii', 'latin1']) {
      try {
        const text = exifData.toString(encoding as BufferEncoding)
        if (text.includes('Steps:') || text.includes('Sampler:')) {
          return text
        }
      } catch {
        continue
      }
    }
  }

  return ''
}

/**
 * Search binary data for SD metadata patterns
 */
function binarySearchForMetadata(buffer: Buffer, format: 'jpeg' | 'webp' = 'jpeg'): string | null {
  const minLength = 50

  // Search for patterns
  const patterns = [
    /Steps:\s*\d+.*?Sampler:\s*[^,\n]+/gi,
    /CFG\s*scale:\s*[\d.]+.*?Seed:\s*\d+/gi,
    /Negative\s*prompt:\s*[^\n]+/gi,
  ]

  // Try different encodings
  const encodings = ['utf8', 'utf16le', 'latin1', 'ascii']
  for (const encoding of encodings) {
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
            candidate.includes('CFG scale:') ||
            candidate.includes('Seed:')
          )) {
            return candidate
          }
        }
      }
    } catch {
      continue
    }
  }

  // For JPEG, also check APP segments directly as raw text
  if (format === 'jpeg') {
    try {
      let offset = 2
      while (offset < buffer.length - 10) {
        if (buffer[offset] === 0xFF) {
          const marker = buffer[offset + 1]
          if (marker >= 0xE0 && marker <= 0xEF) { // APP segments
            const length = buffer.readUInt16BE(offset + 2)
            if (length > 2 && offset + 2 + length <= buffer.length) {
              const segmentData = buffer.slice(offset + 4, offset + 2 + length)
              for (const encoding of encodings) {
                try {
                  const text = segmentData.toString(encoding as BufferEncoding)
                  if (text.includes('Steps:') && text.length > minLength) {
                    return text
                  }
                } catch {
                  //
                }
              }
            }
            offset += 2 + length
            continue
          }
        }
        offset++
      }
    } catch {
      // Ignore APP segment errors in binary search
    }
  }

  // Search for specific byte patterns
  const binaryPatterns = [
    Buffer.from('Steps:'),
    Buffer.from('parameters'),
    Buffer.from('negative_prompt'),
    Buffer.from('prompt:'),
    Buffer.from('Steps'),
    Buffer.from('Sampler')
  ]

  for (const pattern of binaryPatterns) {
    let index = buffer.indexOf(pattern)
    while (index !== -1) {
      const startPos = Math.max(0, index - 200)
      const endPos = Math.min(buffer.length, index + 2000)
      const chunk = buffer.slice(startPos, endPos)

      for (const encoding of encodings) {
        try {
          const text = chunk.toString(encoding as BufferEncoding)
          if (text.includes('Steps:') && text.length > minLength) {
            // Try to extract a reasonable chunk around the match
            const stepsIdx = text.indexOf('Steps:')
            const before = Math.max(0, stepsIdx - 100)
            const after = Math.min(text.length, stepsIdx + 800)
            const extracted = text.slice(before, after)
            if (extracted.length > minLength) {
              return extracted
            }
          }
        } catch {
          continue
        }
      }

      // Continue searching from next position
      const nextIndex = buffer.indexOf(pattern, index + 1)
      if (nextIndex === index) break
      index = nextIndex
    }
  }

  return null
}

export default {
  parseJPEGMetadata
}
