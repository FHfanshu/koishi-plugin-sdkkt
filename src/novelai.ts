import { SDMetadata } from './types'

/**
 * NovelAI metadata parser
 * Handles NovelAI-specific metadata format stored in JSON
 */

export interface NovelAICommentData {
  uc?: string
  steps?: number
  scale?: number
  seed?: number
  sampler?: string
  uncond_per_vibe?: boolean
  strength?: number
  noise?: number
  v4_prompt?: {
    caption: {
      base_caption?: string
      char_captions?: Array<{
        char_caption: string
        [key: string]: any
      }>
    }
    [key: string]: any
  }
  v4_negative_prompt?: {
    caption: {
      base_caption?: string
      char_captions?: Array<{
        char_caption: string
        [key: string]: any
      }>
    }
    [key: string]: any
  }
  director_reference_descriptions?: Array<{
    caption?: {
      base_caption?: string
      char_captions?: any[]
    }
    [key: string]: any
  }>
  director_reference_strengths?: number[]
  director_reference_secondary_strengths?: number[]
}

/**
 * Extract NovelAI metadata from comment JSON
 */
export function extractNovelAIMetadata(
  comment: string,
  description?: string,
  metadata?: SDMetadata
): SDMetadata {
  const result: SDMetadata = metadata || {}

  try {
    // Parse comment JSON
    let commentData: NovelAICommentData
    try {
      commentData = JSON.parse(comment)
    } catch {
      // If not JSON, try parsing as URL-encoded JSON (some versions encode it)
      try {
        commentData = JSON.parse(decodeURIComponent(comment))
      } catch {
        throw new Error('Invalid JSON format')
      }
    }

    // Set description as prompt if no prompt exists
    if (!result.prompt && description) {
      result.prompt = description
    }

    // Extract basic parameters
    if (commentData.uc && !result.negativePrompt) {
      result.negativePrompt = commentData.uc
    }

    if (commentData.steps !== undefined) {
      result.steps = String(commentData.steps)
    }

    if (commentData.scale !== undefined) {
      result.cfgScale = String(commentData.scale)
    }

    if (commentData.seed !== undefined) {
      result.seed = String(commentData.seed)
    }

    if (commentData.sampler) {
      result.sampler = commentData.sampler
    }

    if (typeof commentData.uncond_per_vibe === 'boolean') {
      result.naiVibe = commentData.uncond_per_vibe
    }

    // Extract V4 prompt structure (newer NovelAI format)
    if (commentData.v4_prompt?.caption) {
      const baseCaption = commentData.v4_prompt.caption.base_caption
      if (baseCaption) {
        result.naiBasePrompt = baseCaption
      }

      const charCaptions = commentData.v4_prompt.caption.char_captions
      if (charCaptions && Array.isArray(charCaptions)) {
        const chars = charCaptions
          .map(c => c?.char_caption)
          .filter((c): c is string => typeof c === 'string' && c.length > 0)

        if (chars.length > 0) {
          result.naiCharPrompts = chars
        }
      }
    }

    // Extract V4 negative prompt structure
    if (commentData.v4_negative_prompt?.caption) {
      const baseCaption = commentData.v4_negative_prompt.caption.base_caption
      if (baseCaption) {
        result.naiNegBasePrompt = baseCaption
      }

      const charCaptions = commentData.v4_negative_prompt.caption.char_captions
      if (charCaptions && Array.isArray(charCaptions)) {
        const chars = charCaptions
          .map(c => c?.char_caption)
          .filter((c): c is string => typeof c === 'string' && c.length > 0)

        if (chars.length > 0) {
          result.naiNegCharPrompts = chars
        }
      }
    }

    // Extract director reference information (image-to-image references)
    const directorRefs = extractDirectorReferences(commentData)
    if (directorRefs.length > 0) {
      result.naiCharRefs = directorRefs
    }

    return result

  } catch (error: any) {
    // If parsing fails, try to extract as plain text A1111 format
    if (comment.includes('Steps:')) {
      const { parseA1111Parameters } = require('./a1111')
      parseA1111Parameters(comment, result)
    }

    return result
  }
}

/**
 * Extract director reference information
 */
function extractDirectorReferences(commentData: NovelAICommentData): string[] {
  const refs: string[] = []

  // New format: structured data
  const descs = commentData.director_reference_descriptions || []
  const strengths = commentData.director_reference_strengths || []
  const secondaries = commentData.director_reference_secondary_strengths || []

  if (descs.length > 0 || strengths.length > 0) {
    const n = Math.max(descs.length, strengths.length, secondaries.length)

    for (let i = 0; i < n; i++) {
      const desc = descs[i]
      const s1 = strengths[i]
      const s2 = secondaries[i]

      let ref = ''
      if (desc) {
        if (typeof desc === 'string') {
          ref += desc
        } else if (desc.caption) {
          if (desc.caption.base_caption) {
            ref += desc.caption.base_caption
          }
        }
      }

      if (s1 !== undefined) {
        ref += (ref ? ' ' : '') + String(s1)
      }
      if (s2 !== undefined) {
        ref += '/' + String(s2)
      }

      if (ref) refs.push(ref)
    }
  }

  return refs
}

/**
 * Check if a string looks like NovelAI metadata
 */
export function isNovelAIFormat(text: string): boolean {
  if (!text || typeof text !== 'string') return false

  try {
    const data = JSON.parse(text)
    return (
      (data.uc !== undefined && typeof data.uc === 'string') ||
      (data.steps !== undefined) ||
      (data.v4_prompt !== undefined) ||
      (data.director_reference_descriptions !== undefined)
    )
  } catch {
    return false
  }
}

/**
 * Serialize NovelAI metadata back to JSON
 */
export function serializeNovelAIMetadata(metadata: SDMetadata): string {
  const data: NovelAICommentData = {
    uc: metadata.negativePrompt || '',
  }

  if (metadata.steps) data.steps = parseInt(metadata.steps, 10)
  if (metadata.cfgScale) data.scale = parseFloat(metadata.cfgScale)
  if (metadata.seed) data.seed = parseInt(metadata.seed, 10)
  if (metadata.sampler) data.sampler = metadata.sampler

  if (metadata.naiVibe !== undefined) {
    data.uncond_per_vibe = metadata.naiVibe
  }

  // V4 prompt structure
  if (metadata.naiBasePrompt || metadata.naiCharPrompts) {
    data.v4_prompt = {
      caption: {
        base_caption: metadata.naiBasePrompt || '',
        char_captions: (metadata.naiCharPrompts || []).map(char => ({
          char_caption: char
        }))
      }
    }
  }

  // V4 negative prompt structure
  if (metadata.naiNegBasePrompt || metadata.naiNegCharPrompts) {
    data.v4_negative_prompt = {
      caption: {
        base_caption: metadata.naiNegBasePrompt || '',
        char_captions: (metadata.naiNegCharPrompts || []).map(char => ({
          char_caption: char
        }))
      }
    }
  }

  return JSON.stringify(data, null, 2)
}

export default {
  extractNovelAIMetadata,
  isNovelAIFormat,
  serializeNovelAIMetadata
}
