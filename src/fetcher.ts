import { Context, Session } from 'koishi'
import axios from 'axios'
import { bufferFromBase64, decodeDataUri, tryReadLocalFileBuffer } from './utils'

export interface FetchImageResult {
  buffer: Buffer
  source: string
  sourceType: 'data-uri' | 'base64' | 'local' | 'bot-file' | 'url'
}

export interface FetchOptions {
  maxFileSize?: number
  groupFileRetryDelay?: number
  groupFileRetryCount?: number
  privateFileRetryDelay?: number
  privateFileRetryCount?: number
}

/**
 * Fetch image from various sources
 */
export async function fetchImage(
  ctx: Context,
  session: Session,
  segment: any,
  options?: FetchOptions | number
): Promise<FetchImageResult | null> {
  // Support legacy signature: fetchImage(ctx, session, segment, maxFileSize)
  const opts: FetchOptions = typeof options === 'number'
    ? { maxFileSize: options }
    : (options ?? {})
  const maxSize = opts.maxFileSize ?? (10 * 1024 * 1024) // Default 10MB
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
    // Note: Some adapters use hyphenated names like 'file-id' and 'file-size'
    const sizeAttr = attrs.size || attrs.fileSize || attrs.file_size || attrs['file-size']
    const nameAttr = attrs.name || attrs.file
    const fileIdAttr = attrs.file_id || attrs.fileId || attrs['file-id']

    if (nameAttr && (sizeAttr || fileIdAttr)) {
      // Convert to number (handles both string and number types)
      const sizeNum = typeof sizeAttr === 'string' ? parseInt(sizeAttr, 10) : (sizeAttr || 0)

      if (sizeNum <= maxSize) {
        const imageExts = ['.jpg', '.jpeg', '.png', '.webp', '.gif', '.bmp', '.tiff', '.heic', '.heif']
        const fileExt = require('path').extname(nameAttr).toLowerCase()

        if (imageExts.includes(fileExt)) {
          // Determine if this is a private or group file
          const isPrivate = session.isDirect

          if (isPrivate && fileIdAttr) {
            // Try private file first
            const privateBuffer = await fetchPrivateFile(ctx, session, attrs, opts)
            if (privateBuffer) {
              return {
                buffer: privateBuffer,
                source: `private-file:${nameAttr}`,
                sourceType: 'bot-file'
              }
            }
            // Don't fall through to fetchGroupFile for private chats
            // as it would fail with "invalid uint 32: NaN" error
          } else if (!isPrivate) {
            // Try group file (only for group chats)
            const fileBuffer = await fetchGroupFile(ctx, session, attrs, opts)
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
 * Fetch group file using OneBot API with retry support
 * QQ group files may return compressed preview on first request,
 * retry mechanism helps get the original file
 */
async function fetchGroupFile(
  ctx: Context,
  session: Session,
  attrs: Record<string, any>,
  opts?: FetchOptions
): Promise<Buffer | null> {
  const bot: any = session.bot
  if (!bot?.internal) return null

  const retryDelay = opts?.groupFileRetryDelay ?? 2000
  const retryCount = opts?.groupFileRetryCount ?? 2
  const internal: any = bot.internal
  const methods = [
    'getGroupFileUrl',
    'get_group_file_url'
  ]

  // Helper function to attempt file fetch
  const attemptFetch = async (): Promise<Buffer | null> => {
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
    return null
  }

  // First attempt
  let buffer = await attemptFetch()

  // Retry if first attempt succeeded but might be compressed preview
  // QQ returns compressed preview on first request, original on retry
  if (buffer && retryCount > 0 && retryDelay > 0) {
    for (let i = 0; i < retryCount; i++) {
      // Wait before retry
      await new Promise(resolve => setTimeout(resolve, retryDelay))

      const retryBuffer = await attemptFetch()
      if (retryBuffer) {
        // Use the retry result (more likely to be original)
        buffer = retryBuffer
        break
      }
    }
  }

  if (buffer) return buffer

  // Fallback: try to fetch using fileId if file attribute doesn't work
  if (attrs.fileId || attrs.file_id) {
    const fileId = attrs.fileId || attrs.file_id
    return await fetchFromBotAPI(ctx, session, fileId)
  }

  return null
}

/**
 * Fetch private file using OneBot API with retry support
 * Private files may not be immediately available after upload
 */
async function fetchPrivateFile(
  ctx: Context,
  session: Session,
  attrs: Record<string, any>,
  opts?: FetchOptions
): Promise<Buffer | null> {
  const bot: any = session.bot
  if (!bot?.internal) return null

  const retryDelay = opts?.privateFileRetryDelay ?? 3000
  const retryCount = opts?.privateFileRetryCount ?? 3
  const internal: any = bot.internal

  // Support both underscore and hyphenated attribute names
  const fileId = attrs.file_id || attrs.fileId || attrs['file-id']
  const fileName = attrs.file || attrs.name || attrs.fileName
  // Extract user_id from session for private file API
  const userId = session.userId

  if (!fileId) return null

  // Helper function to attempt file fetch using various methods
  const attemptFetch = async (): Promise<Buffer | null> => {
    // Method 1: Try get_image with fileId (works for images in private chat)
    // This is the most reliable method as seen in logs
    const getImageMethods = ['getImage', 'get_image']
    for (const method of getImageMethods) {
      const fn = internal[method]
      if (typeof fn === 'function') {
        try {
          // NapCat expects file parameter as a plain string, not an object
          const result = await fn.call(internal, fileId)
          if (result) {
            // Check for base64 data
            if (result.base64) {
              const buffer = bufferFromBase64(result.base64)
              if (buffer) return buffer
            }
            // Check for HTTP URL (not local path)
            if (result.url && /^https?:\/\//i.test(result.url)) {
              return await fetchFromURL(result.url)
            }
            // Check for local file path (might work if same machine)
            if (result.file) {
              const localBuffer = await tryReadLocalFileBuffer(result.file)
              if (localBuffer) return localBuffer
            }
          }
        } catch {
          continue
        }
      }
    }

    // Method 2: Try get_private_file_url with correct parameters
    // NapCat expects: user_id (number), file_id (string)
    const privateFileMethods = ['getPrivateFileUrl', 'get_private_file_url']
    for (const method of privateFileMethods) {
      const fn = internal[method]
      if (typeof fn === 'function') {
        try {
          // Call with positional arguments: user_id, file_id
          const result = await fn.call(internal, userId, fileId)
          if (result?.url && /^https?:\/\//i.test(result.url)) {
            return await fetchFromURL(result.url)
          }
        } catch {
          // Ignore errors and try next method
          continue
        }
      }
    }

    // Method 3: Try nc_get_file (NapCat specific)
    const ncFileMethods = ['ncGetFile', 'nc_get_file']
    for (const method of ncFileMethods) {
      const fn = internal[method]
      if (typeof fn === 'function') {
        try {
          const result = await fn.call(internal, fileId)
          if (result?.url && /^https?:\/\//i.test(result.url)) {
            return await fetchFromURL(result.url)
          }
          if (result?.base64) {
            const buffer = bufferFromBase64(result.base64)
            if (buffer) return buffer
          }
          if (result?.file) {
            const localBuffer = await tryReadLocalFileBuffer(result.file)
            if (localBuffer) return localBuffer
          }
        } catch {
          continue
        }
      }
    }

    // Method 4: Try download_file with URL string (not object)
    const downloadMethods = ['downloadFile', 'download_file']
    for (const method of downloadMethods) {
      const fn = internal[method]
      if (typeof fn === 'function') {
        // First try to get a URL from get_image, then download
        for (const imgMethod of getImageMethods) {
          const imgFn = internal[imgMethod]
          if (typeof imgFn === 'function') {
            try {
              // NapCat expects file parameter as a plain string
              const imgResult = await imgFn.call(internal, fileId)
              if (imgResult?.url && /^https?:\/\//i.test(imgResult.url)) {
                const result = await fn.call(internal, imgResult.url)
                if (result?.file) {
                  const localBuffer = await tryReadLocalFileBuffer(result.file)
                  if (localBuffer) return localBuffer
                }
                if (result?.base64) {
                  const buffer = bufferFromBase64(result.base64)
                  if (buffer) return buffer
                }
              }
            } catch {
              continue
            }
          }
        }
      }
    }

    return null
  }

  // First attempt
  let buffer = await attemptFetch()

  // Retry if first attempt failed (file might not be ready yet)
  if (!buffer && retryCount > 0 && retryDelay > 0) {
    for (let i = 0; i < retryCount; i++) {
      // Wait before retry
      await new Promise(resolve => setTimeout(resolve, retryDelay))

      buffer = await attemptFetch()
      if (buffer) {
        break
      }
    }
  }

  if (buffer) return buffer

  // Fallback: try to fetch using fileId via bot API
  return await fetchFromBotAPI(ctx, session, fileId)
}

export default {
  fetchImage,
  fetchFromURL
}
