import { Context, Session } from 'koishi'
import axios from 'axios'
import { bufferFromBase64, decodeDataUri, tryReadLocalFileBuffer } from './utils'

export interface FetchImageResult {
  buffer: Buffer
  source: string
  sourceType: 'data-uri' | 'base64' | 'local' | 'bot-file' | 'url'
}

/**
 * Fetch image from various sources
 */
export async function fetchImage(
  ctx: Context,
  session: Session,
  segment: any
): Promise<FetchImageResult | null> {
  try {
    // Extract attributes
    const attrs = segment.attrs || segment.data || {}
    const seen = new Set<string>()

    // Try base64 fields
    const base64Fields = ['base64', 'image_base64', 'data', 'raw', 'content']
    for (const field of base64Fields) {
      const value = attrs[field]
      if (typeof value === 'string') {
        const key = `base64:${field}`
        if (!seen.has(key)) {
          seen.add(key)
          const buffer = bufferFromBase64(value)
          if (buffer) {
            return {
              buffer,
              source: `attrs.${field}`,
              sourceType: 'base64'
            }
          }
        }
      }
    }

    // Try data URI
    const urlCandidates = [attrs.url, attrs.src]
    for (const candidate of urlCandidates) {
      if (typeof candidate === 'string') {
        const key = `data-uri:${candidate}`
        if (!seen.has(key)) {
          seen.add(key)
          const dataBuffer = decodeDataUri(candidate)
          if (dataBuffer) {
            return {
              buffer: dataBuffer,
              source: candidate,
              sourceType: 'data-uri'
            }
          }
        }
      }
    }

    // Try local file paths
    const localCandidates = [attrs.path, attrs.localPath]
    for (const candidate of localCandidates) {
      if (typeof candidate === 'string') {
        const key = `local:${candidate}`
        if (!seen.has(key)) {
          seen.add(key)
          const localBuffer = await tryReadLocalFileBuffer(candidate)
          if (localBuffer) {
            return {
              buffer: localBuffer,
              source: candidate,
              sourceType: 'local'
            }
          }
        }
      }
    }

    // Try bot file API
    const botCandidates = [attrs.file, attrs.image, attrs.fileId, attrs.file_id, attrs.id]
    for (const candidate of botCandidates) {
      if (typeof candidate === 'string') {
        const key = `bot:${candidate}`
        if (!seen.has(key)) {
          seen.add(key)
          const botBuffer = await fetchFromBotAPI(ctx, session, candidate)
          if (botBuffer) {
            return {
              buffer: botBuffer,
              source: candidate,
              sourceType: 'bot-file'
            }
          }
        }
      }
    }

    // Try group files (special case)
    // Check for both 'size' (number) and 'fileSize' (string) attributes
    const sizeAttr = attrs.size || attrs.fileSize
    const nameAttr = attrs.name || attrs.file

    if (nameAttr && sizeAttr) {
      // Convert to number (handles both string and number types)
      const sizeNum = typeof sizeAttr === 'string' ? parseInt(sizeAttr, 10) : sizeAttr

      if (!isNaN(sizeNum) && sizeNum <= 10 * 1024 * 1024) {
        const imageExts = ['.jpg', '.jpeg', '.png', '.webp', '.gif', '.bmp', '.tiff', '.heic', '.heif']
        const fileExt = require('path').extname(nameAttr).toLowerCase()

        if (imageExts.includes(fileExt)) {
          const fileBuffer = await fetchGroupFile(ctx, session, attrs)
          if (fileBuffer) {
            return {
              buffer: fileBuffer,
              source: `group-file:${attrs.file}`,
              sourceType: 'bot-file'
            }
          }
        }
      }
    }

    // Try direct URL download
    const directUrl = attrs.src || attrs.url
    if (typeof directUrl === 'string' && /^https?:\/\//i.test(directUrl)) {
      const key = `url:${directUrl}`
      if (!seen.has(key)) {
        seen.add(key)
        const urlBuffer = await fetchFromURL(directUrl)
        if (urlBuffer) {
          return {
            buffer: urlBuffer,
            source: directUrl,
            sourceType: 'url'
          }
        }
      }
    }

    return null
  } catch (error) {
    return null
  }
}

/**
 * Fetch from bot API (getFile, etc.)
 */
async function fetchFromBotAPI(
  ctx: Context,
  session: Session,
  identifier: string
): Promise<Buffer | null> {
  const bot: any = session.bot
  if (!bot) return null

  // Try getFile
  if (typeof bot.getFile === 'function') {
    try {
      const result = await bot.getFile(identifier)
      if (result) {
        if (typeof result.base64 === 'string') {
          const buffer = bufferFromBase64(result.base64)
          if (buffer) return buffer
        }
        if (typeof result.url === 'string') {
          return await fetchFromURL(result.url)
        }
        if (typeof result.path === 'string') {
          const localBuffer = await tryReadLocalFileBuffer(result.path)
          if (localBuffer) return localBuffer
        }
      }
    } catch {
      // Ignore errors
    }
  }

  // Try internal methods (OneBot, etc.)
  return await fetchFromInternalAPI(bot, identifier)
}

/**
 * Fetch from bot internal API
 */
async function fetchFromInternalAPI(bot: any, identifier: string): Promise<Buffer | null> {
  if (!bot.internal) return null

  const internal: any = bot.internal
  const methods = [
    'getImage',
    'get_image',
    'getFile',
    'get_file'
  ]

  for (const method of methods) {
    const fn = internal[method]
    if (typeof fn === 'function') {
      try {
        const result = await fn.call(internal, identifier)
        return await extractBufferFromResult(result)
      } catch {
        continue
      }
    }
  }

  return null
}

/**
 * Extract buffer from API result
 */
async function extractBufferFromResult(result: any): Promise<Buffer | null> {
  if (!result) return null

  // Direct buffer
  if (Buffer.isBuffer(result)) {
    return result
  }

  // Base64 string
  if (typeof result === 'string') {
    const buffer = bufferFromBase64(result)
    if (buffer) return buffer

    // URL string
    if (/^https?:\/\//i.test(result)) {
      return await fetchFromURL(result)
    }

    // Local path
    const localBuffer = await tryReadLocalFileBuffer(result)
    if (localBuffer) return localBuffer
  }

  // Object with various fields
  if (typeof result === 'object') {
    // Try different fields
    const candidates = [
      result.base64,
      result.url,
      result.path,
      result.file?.url,
      result.image?.url,
      result.data?.url
    ]

    for (const candidate of candidates) {
      if (typeof candidate === 'string') {
        const buffer = bufferFromBase64(candidate)
        if (buffer) return buffer

        if (/^https?:\/\//i.test(candidate)) {
          const urlBuffer = await fetchFromURL(candidate)
          if (urlBuffer) return urlBuffer
        }

        const localBuffer = await tryReadLocalFileBuffer(candidate)
        if (localBuffer) return localBuffer
      }
    }
  }

  return null
}

/**
 * Fetch from URL
 */
async function fetchFromURL(url: string): Promise<Buffer | null> {
  try {
    const response = await axios.get(url, {
      responseType: 'arraybuffer',
      timeout: 30000,
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36'
      },
      maxContentLength: 50 * 1024 * 1024 // 50MB limit
    })

    return Buffer.from(response.data)
  } catch {
    return null
  }
}

/**
 * Fetch group file using OneBot API
 */
async function fetchGroupFile(
  ctx: Context,
  session: Session,
  attrs: Record<string, any>
): Promise<Buffer | null> {
  const bot: any = session.bot
  if (!bot?.internal) return null

  const internal: any = bot.internal
  const methods = [
    'getGroupFileUrl',
    'get_group_file_url'
  ]

  for (const method of methods) {
    const fn = internal[method]
    if (typeof fn === 'function') {
      try {
        const result = await fn.call(
          internal,
          session.channelId,
          attrs.file,
          attrs.busid
        )

        if (result?.url) {
          return await fetchFromURL(result.url)
        }
      } catch {
        continue
      }
    }
  }

  // Fallback: try to fetch using fileId if file attribute doesn't work
  if (attrs.fileId || attrs.file_id) {
    const fileId = attrs.fileId || attrs.file_id
    return await fetchFromBotAPI(ctx, session, fileId)
  }

  return null
}

export default {
  fetchImage,
  fetchFromURL
}
