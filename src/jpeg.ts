import { Buffer } from 'buffer'
import ExifReader from 'exifreader'
import { SDMetadata, JPEGAppSegments, ParseResult } from './types'
import { parseA1111Parameters } from './a1111'
import { extractNovelAIMetadata } from './novelai'

/**
 * Parse JPEG metadata from buffer
 * Supports APP segments and EXIF data
 */
export function parseJPEGMetadata(buffer: Buffer): ParseResult<SDMetadata> {
  try {
    const metadata: SDMetadata = {}

    // 1. First, try manual APP segment parsing
    const appSegments = extractJpegAppSegments(buffer)

    for (const [appName, content] of Object.entries(appSegments)) {
      if (content.includes('Steps:') || content.includes('Sampler:') ||
          content.includes('CFG scale:') || content.includes('Seed:')) {
        metadata.parameters = content
        parseA1111Parameters(content, metadata)
        break
      }
    }

    // 2. If not found in APP segments, try EXIF
    if (!metadata.parameters) {
      try {
        const tags = ExifReader.load(buffer, { expanded: true })

        // Extended EXIF fields to search
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

        for (const fieldName of exifFields) {
          const field = (tags.exif as any)?.[fieldName]
          if (field) {
            const fieldValue = field.description || field.value
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

        // Check for NovelAI format in JPEG
        if (tags?.exif?.Software) {
          const software = tags.exif.Software.description || tags.exif.Software.value
          if (software === 'NovelAI') {
            const descField = tags.exif?.ImageDescription as any
            const description = descField?.description || descField?.value || undefined

            const commentField = tags.exif?.UserComment as any
            const comment = commentField?.description || commentField?.value || undefined

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
              if (descValue && descValue.includes('Steps:')) {
                metadata.parameters = descValue
                parseA1111Parameters(descValue, metadata)
                break
              }
            }
          }
        }

        // IPTC data
        if (tags.iptc && !metadata.parameters) {
          const iptcCaption = (tags.iptc as any)['Caption/Abstract']
          if (iptcCaption) {
            const captionValue = typeof iptcCaption === 'string' ? iptcCaption : (iptcCaption.value || iptcCaption.description)
            if (captionValue && captionValue.includes('Steps:')) {
              metadata.parameters = captionValue
              parseA1111Parameters(captionValue, metadata)
            }
          }
        }

      } catch (exifError) {
        // Continue even if EXIF parsing fails
      }
    }

    // 3. Binary search as last resort
    if (!metadata.parameters) {
      const foundText = binarySearchForMetadata(buffer)
      if (foundText) {
        metadata.parameters = foundText
        parseA1111Parameters(foundText, metadata)
      }
    }

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
function binarySearchForMetadata(buffer: Buffer): string | null {
  const minLength = 50

  // Search for patterns
  const patterns = [
    /Steps:\s*\d+.*?Sampler:\s*[^,\n]+/gi,
    /CFG\s*scale:\s*[\d.]+.*?Seed:\s*\d+/gi,
    /Negative\s*prompt:\s*[^\n]+/gi,
  ]

  // Try different encodings
  for (const encoding of ['utf8', 'latin1', 'ascii']) {
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

  // Search for specific byte patterns
  const binaryPatterns = [
    Buffer.from('Steps:'),
    Buffer.from('parameters'),
    Buffer.from('negative_prompt')
  ]

  for (const pattern of binaryPatterns) {
    const index = buffer.indexOf(pattern)
    if (index !== -1) {
      const startPos = Math.max(0, index - 200)
      const endPos = Math.min(buffer.length, index + 2000)
      const chunk = buffer.slice(startPos, endPos)

      for (const encoding of ['utf8', 'latin1', 'ascii']) {
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
  parseJPEGMetadata
}
