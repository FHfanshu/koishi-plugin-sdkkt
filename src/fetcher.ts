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
  logger?: any
  debug?: boolean
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
  const logger = opts.logger
  const debug = !!opts.debug
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

    // Direct private-file fetch for OneBot/NapCat when only file_id is present
    const directFileId = attrs.file_id || attrs.fileId || attrs['file-id']
    if (session.isDirect && directFileId && (segment.type === 'image' || segment.type === 'img' || segment.type === 'file' || segment.type === 'attachment')) {
      const privateBuffer = await fetchPrivateFile(ctx, session, attrs, opts)
      if (privateBuffer) {
        return {
          buffer: privateBuffer,
          source: `private-file:${directFileId}`,
          sourceType: 'bot-file'
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
        const urlBuffer = await fetchFromURL(directUrl, logger, debug)
        if (urlBuffer) {
          return {
            buffer: urlBuffer,
            source: directUrl,
            sourceType: 'url'
          }
        }
      }
    }

    if (debug && logger) {
      logger.warn('图片下载失败：未找到可用来源', {
        type: segment.type,
        attrs: Object.keys(attrs),
        source: segment._source
      })
    }
    return null
  } catch (error: any) {
    if (debug && logger) {
      logger.warn(`图片下载异常: ${error?.message || error}`)
    }
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

  // Object with various fields (including OneBot wrapper: { data: ... })
  if (typeof result === 'object') {
    const dataObj = (result && typeof result.data === 'object') ? result.data : null
    const candidates = [
      result.base64,
      result.url,
      result.path,
      result.file?.url,
      result.image?.url,
      dataObj?.base64,
      dataObj?.url,
      dataObj?.path,
      dataObj?.file?.url,
      dataObj?.image?.url
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
async function fetchFromURL(url: string, logger?: any, debug?: boolean): Promise<Buffer | null> {
  try {
    const isQQDownload = /qqdownloadftnv5|ftn\.qq\.com/i.test(url)
    const response = await axios.get(url, {
      responseType: 'arraybuffer',
      timeout: 30000,
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
        ...(isQQDownload ? { Referer: 'https://im.qq.com/', Accept: '*/*' } : {})
      },
      maxContentLength: 50 * 1024 * 1024,
      maxRedirects: 5,
      validateStatus: (status) => status >= 200 && status < 400
    })

    const buffer = Buffer.from(response.data)
    const contentType = String(response.headers?.['content-type'] || '').toLowerCase()
    if (debug && logger) {
      logger.info('图片下载响应:', {
        url,
        status: response.status,
        contentType,
        size: buffer.length
      })
    }
    if (buffer.length < 512 && (contentType.includes('text/html') || contentType.includes('application/json'))) {
      if (debug && logger) {
        logger.warn('图片下载返回疑似错误页/短响应', { url, contentType, size: buffer.length })
      }
      return null
    }
    return buffer
  } catch (error: any) {
    if (debug && logger) {
      logger.warn('图片下载请求失败', { url, error: error?.message || error })
    }
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

  if (!fileId) return null

  // Helper function to attempt file fetch using various methods
  const attemptFetch = async (): Promise<Buffer | null> => {
    // Method 0: If attrs already provides a usable URL, try it first
    const directUrl = attrs.url || attrs.src
    if (typeof directUrl === 'string' && /^https?:\/\//i.test(directUrl)) {
      const directBuffer = await fetchFromURL(directUrl)
      if (directBuffer) return directBuffer
    }

    // Debug: List available internal methods
    if (opts?.debug && opts?.logger) {
      const methods = Object.keys(internal).filter(k => typeof internal[k] === 'function')
      opts.logger.info('Available internal methods:', methods.slice(0, 30))
    }

    // Method 1: Try using internal._request for direct OneBot API calls
    // This bypasses koishi-adapter-onebot's parameter mapping which causes issues
    // The _request method is the raw WebSocket/HTTP sender
    // Note: _request returns the full OneBot response: { status, retcode, data: {...} }
    if (typeof internal._request === 'function') {
      // Try get_file first - returns base64 for remote deployments
      try {
        const rawResult = await internal._request('get_file', { file_id: fileId })
        // Extract data from OneBot response wrapper
        const result = rawResult?.data || rawResult
        if (opts?.debug && opts?.logger) {
          opts.logger.info('get_file via _request result:', {
            hasResult: !!result,
            hasBase64: !!(result?.base64),
            hasUrl: !!(result?.url),
            hasFile: !!(result?.file),
            keys: result ? Object.keys(result) : []
          })
        }
        if (result) {
          // Check for base64 data first
          if (result.base64) {
            const buffer = bufferFromBase64(result.base64)
            if (buffer) {
              if (opts?.debug && opts?.logger) {
                opts.logger.info('get_file returned base64 data', { size: buffer.length })
              }
              return buffer
            }
          }
          // Check for HTTP URL
          if (result.url && /^https?:\/\//i.test(result.url)) {
            const buffer = await fetchFromURL(result.url, opts?.logger, opts?.debug)
            if (buffer) return buffer
          }
          // Check for local path
          if (result.file) {
            const localBuffer = await tryReadLocalFileBuffer(result.file)
            if (localBuffer) return localBuffer
          }
        }
      } catch (e) {
        if (opts?.debug && opts?.logger) {
          opts.logger.warn('get_file via _request failed:', e)
        }
      }

      // Try get_private_file_url - returns HTTP download URL
      try {
        const rawResult = await internal._request('get_private_file_url', { file_id: fileId })
        // Extract data from OneBot response wrapper
        const result = rawResult?.data || rawResult
        if (opts?.debug && opts?.logger) {
          opts.logger.info('get_private_file_url via _request result:', {
            url: result?.url,
            status: rawResult?.status,
            retcode: rawResult?.retcode
          })
        }
        const url = result?.url
        if (url && /^https?:\/\//i.test(url)) {
          const buffer = await fetchFromURL(url, opts?.logger, opts?.debug)
          if (buffer) return buffer
        }
      } catch (e) {
        if (opts?.debug && opts?.logger) {
          opts.logger.warn('get_private_file_url via _request failed:', e)
        }
      }
    }

    // Method 1.5: Try calling internal methods directly with correct signature
    // For get_file, the signature might be: get_file(file_id: string) or get_file(file: string)
    if (typeof internal.getFile === 'function') {
      try {
        // Try file_id directly as first parameter
        const result = await internal.getFile(fileId)
        if (opts?.debug && opts?.logger) {
          opts.logger.info('getFile(fileId) result:', {
            hasResult: !!result,
            keys: result ? Object.keys(result) : []
          })
        }
        if (result?.base64) {
          const buffer = bufferFromBase64(result.base64)
          if (buffer) return buffer
        }
        if (result?.url && /^https?:\/\//i.test(result.url)) {
          const buffer = await fetchFromURL(result.url, opts?.logger, opts?.debug)
          if (buffer) return buffer
        }
        if (result?.file) {
          const localBuffer = await tryReadLocalFileBuffer(result.file)
          if (localBuffer) return localBuffer
        }
      } catch (e) {
        if (opts?.debug && opts?.logger) {
          opts.logger.warn('getFile(fileId) failed:', e)
        }
      }
    }

    // Method 2: Try $action for direct OneBot API call (most reliable for NapCat)
    // This bypasses koishi-adapter-onebot's parameter mapping which causes issues
    if (typeof internal.$action === 'function' || typeof internal._action === 'function' || typeof internal.action === 'function') {
      const actionFn = internal.$action || internal._action || internal.action

      // Try get_file first - returns base64 for remote deployments
      try {
        const result = await actionFn.call(internal, 'get_file', { file_id: fileId })
        if (opts?.debug && opts?.logger) {
          opts.logger.info('get_file via $action result:', {
            hasBase64: !!(result?.base64 || result?.data?.base64),
            hasUrl: !!(result?.url || result?.data?.url),
            hasFile: !!(result?.file || result?.data?.file)
          })
        }

        // Check for base64 data first (most reliable for remote setups)
        if (result?.base64 || result?.data?.base64) {
          const b64 = result.base64 || result.data?.base64
          const buffer = bufferFromBase64(b64)
          if (buffer) {
            if (opts?.debug && opts?.logger) {
              opts.logger.info('get_file returned base64 data', { size: buffer.length })
            }
            return buffer
          }
        }

        // Check for HTTP URL
        const httpUrl = result?.url || result?.data?.url
        if (httpUrl && /^https?:\/\//i.test(httpUrl)) {
          const buffer = await fetchFromURL(httpUrl, opts?.logger, opts?.debug)
          if (buffer) return buffer
        }

        // Check for local file path
        const filePath = result?.file || result?.data?.file
        if (filePath) {
          const localBuffer = await tryReadLocalFileBuffer(filePath)
          if (localBuffer) return localBuffer
        }
      } catch (e) {
        if (opts?.debug && opts?.logger) {
          opts.logger.warn('get_file via $action failed:', e)
        }
      }

      // Try get_private_file_url - returns HTTP download URL
      try {
        const result = await actionFn.call(internal, 'get_private_file_url', { file_id: fileId })
        if (opts?.debug && opts?.logger) {
          opts.logger.info('get_private_file_url via $action result:', result)
        }
        const url = result?.url || result?.data?.url
        if (url && /^https?:\/\//i.test(url)) {
          const buffer = await fetchFromURL(url, opts?.logger, opts?.debug)
          if (buffer) return buffer
        }
      } catch (e) {
        if (opts?.debug && opts?.logger) {
          opts.logger.warn('get_private_file_url via $action failed:', e)
        }
      }
    }

    // Method 2: Try get_file with various parameter formats
    // koishi-adapter-onebot may map parameters differently
    const getFileMethods = ['getFile', 'get_file']
    for (const method of getFileMethods) {
      const fn = internal[method]
      if (typeof fn === 'function') {
        try {
          // Try with plain string first (some adapters expect this)
          let result = await fn.call(internal, fileId)

          // Check for base64 data first (most reliable for remote setups)
          if (result?.base64 || result?.data?.base64) {
            const b64 = result.base64 || result.data?.base64
            const buffer = bufferFromBase64(b64)
            if (buffer) {
              if (opts?.debug && opts?.logger) {
                opts.logger.info('get_file returned base64 data', { size: buffer.length })
              }
              return buffer
            }
          }

          // Check for HTTP URL
          const httpUrl = result?.url || result?.data?.url
          if (httpUrl && /^https?:\/\//i.test(httpUrl)) {
            const buffer = await fetchFromURL(httpUrl, opts?.logger, opts?.debug)
            if (buffer) return buffer
          }

          // Check for local file path (only works if same machine)
          const filePath = result?.file || result?.data?.file
          if (filePath) {
            const localBuffer = await tryReadLocalFileBuffer(filePath)
            if (localBuffer) return localBuffer
          }
        } catch {
          continue
        }
      }
    }

    // Method 3: Try get_private_file_url with plain string parameter
    // koishi-adapter-onebot maps object to wrong parameters, try string instead
    const privateFileMethods = ['getPrivateFileUrl', 'get_private_file_url']
    for (const method of privateFileMethods) {
      const fn = internal[method]
      if (typeof fn === 'function') {
        try {
          // Try with plain string (file_id as positional parameter)
          let result = await fn.call(internal, fileId)
          // Extract URL from nested data structure
          let url = result?.url || result?.data?.url
          if (url && /^https?:\/\//i.test(url)) {
            const buffer = await fetchFromURL(url, opts?.logger, opts?.debug)
            if (buffer) return buffer
          }
        } catch {
          // Ignore errors and try next method
          continue
        }
      }
    }

    // Method 4: Try get_image with fileId (fallback for same-machine setups)
    // Note: NapCat returns local path in 'file' and 'url' fields, NOT HTTP URL
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
            // Check for HTTP URL (not local path - NapCat returns local paths here)
            const urlCandidate = result.url || result.data?.url
            if (urlCandidate && /^https?:\/\//i.test(urlCandidate)) {
              const buffer = await fetchFromURL(urlCandidate, opts?.logger, opts?.debug)
              if (buffer) return buffer
            }
            // Check for local file path (only works if same machine as NapCat)
            const filePath = result.file || result.data?.file
            if (filePath) {
              const localBuffer = await tryReadLocalFileBuffer(filePath)
              if (localBuffer) return localBuffer
            }
          }
        } catch {
          continue
        }
      }
    }

    // Method 5: Try nc_get_file (NapCat specific)
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

    // Method 6: Try download_file with URL string (not object)
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
