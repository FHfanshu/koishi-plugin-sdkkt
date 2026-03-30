/**
 * Image fetcher module
 * Handles fetching images from various sources including OneBot API
 *
 * PATCHED VERSION: Adds support for fetching images via OneBot get_file API
 * when Koishi runs in Docker but the image path is on the host machine.
 */

import axios from 'axios';
import { bufferFromBase64, tryReadLocalFileBuffer } from './utils';
import * as path from 'path';

interface LoggerLike {
    info: (msg: string, ...args: unknown[]) => void;
    warn: (msg: string, ...args: unknown[]) => void;
}

interface ChatlunaStorage {
    createTempFile?: (buffer: Buffer, filename: string) => Promise<{ url?: string }>;
}

interface FetchOptions {
    maxFileSize?: number;
    groupFileRetryDelay?: number;
    groupFileRetryCount?: number;
    privateFileRetryDelay?: number;
    privateFileRetryCount?: number;
    logger?: LoggerLike;
    debug?: boolean;
    chatlunaStorage?: ChatlunaStorage;
}

interface FetchResult {
    buffer: Buffer;
    source: string;
    sourceType: string;
}

interface Session {
    bot?: {
        internal?: Record<string, unknown>;
        getFile?: (id: string) => Promise<Record<string, unknown> | null>;
    };
    isDirect?: boolean;
    channelId?: string;
    platform?: string;
}

interface Segment {
    type: string;
    attrs?: Record<string, unknown>;
    data?: Record<string, unknown>;
    _source?: string;
}

/**
 * Try to fetch file via OneBot get_file API using fileId
 * This is useful when local path is not accessible (e.g., Docker container)
 *
 * PATCH: Added to support fetching images when Koishi runs in Docker
 * but the file path points to the host machine's filesystem.
 */
async function fetchViaOneBotFileAPI(
    bot: Session['bot'],
    fileId: string,
    opts?: FetchOptions
): Promise<Buffer | null> {
    if (!bot?.internal) return null;

    const internal = bot.internal;
    const logger = opts?.logger;
    const debug = opts?.debug;

    // Try _request method (raw OneBot API call)
    if (typeof internal._request === 'function') {
        const _request = internal._request as (action: string, params: Record<string, unknown>) => Promise<unknown>;

        // Method 1: Try get_file with base64 request
        try {
            const rawResult = await _request('get_file', { file_id: fileId });
            const result = (rawResult as { data?: unknown })?.data || rawResult;

            if (debug && logger) {
                logger.info('OneBot get_file result:', {
                    hasResult: !!result,
                    hasBase64: !!(result as Record<string, unknown>)?.base64,
                    hasUrl: !!(result as Record<string, unknown>)?.url,
                    hasFile: !!(result as Record<string, unknown>)?.file,
                    keys: result ? Object.keys(result as Record<string, unknown>) : [],
                    url: (result as Record<string, unknown>)?.url
                });
            }

            if (result) {
                const resultObj = result as Record<string, unknown>;

                if (resultObj.base64) {
                    if (debug && logger) logger.info('Got base64 from get_file');
                    return bufferFromBase64(resultObj.base64 as string);
                }
                if (resultObj.url && typeof resultObj.url === 'string' && /^https?:\/\//i.test(resultObj.url)) {
                    if (debug && logger) logger.info('Got URL from get_file:', resultObj.url);
                    return await fetchFromURL(resultObj.url, logger, debug);
                }
            }
        } catch (e) {
            if (debug && logger) {
                logger.warn('OneBot get_file failed:', (e as Error)?.message || e);
            }
        }

        // Method 2: Try download_file API with base64 return
        // LLOneBot may support returning base64 directly
        try {
            if (debug && logger) {
                logger.info('Trying download_file API with base64 request');
            }

            const rawResult = await _request('download_file', {
                file_id: fileId,
                base64: true  // Request base64 output
            });
            const result = (rawResult as { data?: unknown })?.data || rawResult;

            if (debug && logger) {
                logger.info('OneBot download_file (base64) result:', {
                    hasResult: !!result,
                    hasBase64: !!(result as Record<string, unknown>)?.base64,
                    keys: result ? Object.keys(result as Record<string, unknown>) : []
                });
            }

            if (result) {
                const resultObj = result as Record<string, unknown>;
                if (resultObj.base64) {
                    if (debug && logger) logger.info('Got base64 from download_file');
                    return bufferFromBase64(resultObj.base64 as string);
                }
            }
        } catch (e) {
            if (debug && logger) {
                logger.warn('OneBot download_file (base64) failed:', (e as Error)?.message || e);
            }
        }

        // Method 3: Try download_file to chatluna storage temp path
        if (opts?.chatlunaStorage?.createTempFile) {
            try {
                if (debug && logger) {
                    logger.info('Trying download_file to chatluna storage path');
                }

                // Download to a temp path that chatluna storage can access
                const tempFileName = `sdexif_${Date.now()}_${Math.random().toString(36).slice(2)}.png`;
                const tempPath = `/koishi/data/chatluna/temp/${tempFileName}`;

                const rawResult = await _request('download_file', {
                    file_id: fileId,
                    file_path: tempPath
                });
                const result = (rawResult as { data?: unknown })?.data || rawResult;

                if (debug && logger) {
                    logger.info('OneBot download_file result:', {
                        hasResult: !!result,
                        result
                    });
                }

                // Try to read the downloaded file
                if (result) {
                    const resultObj = result as Record<string, unknown>;
                    const downloadedPath = resultObj.file_path || tempPath;

                    const localBuffer = await tryReadLocalFileBuffer(downloadedPath);
                    if (localBuffer) {
                        if (debug && logger) logger.info('Successfully read downloaded file, size:', localBuffer.length);
                        return localBuffer;
                    }
                }
            } catch (e) {
                if (debug && logger) {
                    logger.warn('OneBot download_file failed:', (e as Error)?.message || e);
                }
            }
        }

        // Method 4: Try get_image API (may return different data)
        try {
            const rawResult = await _request('get_image', { file: fileId });
            const result = (rawResult as { data?: unknown })?.data || rawResult;

            if (debug && logger) {
                logger.info('OneBot get_image result:', {
                    hasResult: !!result,
                    hasBase64: !!(result as Record<string, unknown>)?.base64,
                    hasUrl: !!(result as Record<string, unknown>)?.url,
                    hasFile: !!(result as Record<string, unknown>)?.file,
                    keys: result ? Object.keys(result as Record<string, unknown>) : [],
                    url: (result as Record<string, unknown>)?.url
                });
            }

            if (result) {
                const resultObj = result as Record<string, unknown>;

                if (resultObj.base64) {
                    if (debug && logger) logger.info('Got base64 from get_image');
                    return bufferFromBase64(resultObj.base64 as string);
                }
                if (resultObj.url && typeof resultObj.url === 'string' && /^https?:\/\//i.test(resultObj.url)) {
                    if (debug && logger) logger.info('Got URL from get_image:', resultObj.url);
                    return await fetchFromURL(resultObj.url, logger, debug);
                }
            }
        } catch (e) {
            if (debug && logger) {
                logger.warn('OneBot get_image failed:', (e as Error)?.message || e);
            }
        }

        // Method 5: Try get_file with file parameter instead of file_id
        try {
            const rawResult = await _request('get_file', { file: fileId });
            const result = (rawResult as { data?: unknown })?.data || rawResult;

            if (debug && logger) {
                logger.info('OneBot get_file (file param) result:', {
                    hasResult: !!result,
                    hasBase64: !!(result as Record<string, unknown>)?.base64,
                    hasUrl: !!(result as Record<string, unknown>)?.url,
                    url: (result as Record<string, unknown>)?.url
                });
            }

            if (result) {
                const resultObj = result as Record<string, unknown>;

                if (resultObj.base64) {
                    return bufferFromBase64(resultObj.base64 as string);
                }
                if (resultObj.url && typeof resultObj.url === 'string' && /^https?:\/\//i.test(resultObj.url)) {
                    return await fetchFromURL(resultObj.url, logger, debug);
                }
            }
        } catch (e) {
            if (debug && logger) {
                logger.warn('OneBot get_file (file param) failed:', (e as Error)?.message || e);
            }
        }
    }

    // Method 6: Try internal.getImage method
    if (typeof internal.getImage === 'function') {
        try {
            const result = await (internal.getImage as (id: string) => Promise<unknown>)(fileId);
            if (debug && logger) {
                logger.info('internal.getImage result:', {
                    hasResult: !!result,
                    hasBase64: !!(result as Record<string, unknown>)?.base64,
                    hasUrl: !!(result as Record<string, unknown>)?.url,
                    keys: result ? Object.keys(result as Record<string, unknown>) : []
                });
            }
            if (result) {
                const resultObj = result as Record<string, unknown>;
                if (resultObj.base64) return bufferFromBase64(resultObj.base64 as string);
                if (resultObj.url && typeof resultObj.url === 'string' && /^https?:\/\//i.test(resultObj.url)) {
                    return await fetchFromURL(resultObj.url, logger, debug);
                }
            }
        } catch (e) {
            if (debug && logger) {
                logger.warn('internal.getImage failed:', (e as Error)?.message || e);
            }
        }
    }

    // Method 7: Try internal.get_image method
    if (typeof internal.get_image === 'function') {
        try {
            const result = await (internal.get_image as (id: string) => Promise<unknown>)(fileId);
            if (debug && logger) {
                logger.info('internal.get_image result:', {
                    hasResult: !!result,
                    hasBase64: !!(result as Record<string, unknown>)?.base64,
                    hasUrl: !!(result as Record<string, unknown>)?.url
                });
            }
            if (result) {
                const resultObj = result as Record<string, unknown>;
                if (resultObj.base64) return bufferFromBase64(resultObj.base64 as string);
                if (resultObj.url && typeof resultObj.url === 'string' && /^https?:\/\//i.test(resultObj.url)) {
                    return await fetchFromURL(resultObj.url, logger, debug);
                }
            }
        } catch (e) {
            if (debug && logger) {
                logger.warn('internal.get_image failed:', (e as Error)?.message || e);
            }
        }
    }

    return null;
}

/**
 * Fetch image via OneBot get_image API
 * Uses the image filename (e.g., "ComfyUI_temp_xxx.png")
 */
async function fetchImageViaOneBot(
    bot: Session['bot'],
    fileName: string,
    opts?: FetchOptions
): Promise<Buffer | null> {
    if (!bot?.internal) return null;

    const internal = bot.internal;
    const logger = opts?.logger;
    const debug = opts?.debug;

    // Try _request method
    if (typeof internal._request === 'function') {
        const _request = internal._request as (action: string, params: Record<string, unknown>) => Promise<unknown>;

        try {
            const rawResult = await _request('get_image', { file: fileName });
            const result = (rawResult as { data?: unknown })?.data || rawResult;

            if (debug && logger) {
                logger.info('OneBot get_image result:', {
                    hasResult: !!result,
                    hasBase64: !!(result as Record<string, unknown>)?.base64,
                    hasUrl: !!(result as Record<string, unknown>)?.url,
                    url: (result as Record<string, unknown>)?.url,
                    file: (result as Record<string, unknown>)?.file,
                    keys: result ? Object.keys(result as Record<string, unknown>) : []
                });
            }

            if (result) {
                const resultObj = result as Record<string, unknown>;

                // Check for base64
                if (resultObj.base64) {
                    if (debug && logger) logger.info('Got base64 from get_image');
                    return bufferFromBase64(resultObj.base64 as string);
                }

                // Check for URL (could be http:// or file:///)
                if (resultObj.url && typeof resultObj.url === 'string') {
                    const url = resultObj.url;
                    if (debug && logger) logger.info('Got URL from get_image:', url);

                    // HTTP URL
                    if (/^https?:\/\//i.test(url)) {
                        return await fetchFromURL(url, logger, debug);
                    }

                    // file:/// URL - try to read local file
                    if (url.startsWith('file:///')) {
                        const localPath = url.replace(/^file:\/\/\//i, '/');
                        if (debug && logger) logger.info('Trying to read from file:// URL:', localPath);
                        const localBuffer = await tryReadLocalFileBuffer(localPath);
                        if (localBuffer) return localBuffer;
                    }
                }

                // Check for file path
                if (resultObj.file && typeof resultObj.file === 'string') {
                    const filePath = resultObj.file;
                    if (debug && logger) logger.info('Got file path from get_image:', filePath);

                    // Try to read local file
                    const localBuffer = await tryReadLocalFileBuffer(filePath);
                    if (localBuffer) return localBuffer;
                }
            }
        } catch (e) {
            if (debug && logger) {
                logger.warn('OneBot get_image failed:', (e as Error)?.message || e);
            }
        }
    }

    // Try internal.get_image method
    if (typeof internal.get_image === 'function') {
        try {
            const result = await (internal.get_image as (file: string) => Promise<unknown>)(fileName);
            if (debug && logger) {
                logger.info('internal.get_image result:', {
                    hasResult: !!result,
                    hasUrl: !!(result as Record<string, unknown>)?.url,
                    url: (result as Record<string, unknown>)?.url
                });
            }
            if (result) {
                const resultObj = result as Record<string, unknown>;
                if (resultObj.base64) return bufferFromBase64(resultObj.base64 as string);
                if (resultObj.url && typeof resultObj.url === 'string') {
                    if (/^https?:\/\//i.test(resultObj.url)) {
                        return await fetchFromURL(resultObj.url, logger, debug);
                    }
                    if (resultObj.url.startsWith('file:///')) {
                        const localPath = resultObj.url.replace(/^file:\/\/\//i, '/');
                        const localBuffer = await tryReadLocalFileBuffer(localPath);
                        if (localBuffer) return localBuffer;
                    }
                }
            }
        } catch (e) {
            if (debug && logger) {
                logger.warn('internal.get_image failed:', (e as Error)?.message || e);
            }
        }
    }

    return null;
}

/**
 * Fetch group file via OneBot get_group_file_url API
 * Uses fileId (starts with "/") and groupId
 */
async function fetchGroupFileViaOneBot(
    bot: Session['bot'],
    fileId: string,
    groupId: string,
    opts?: FetchOptions
): Promise<Buffer | null> {
    if (!bot?.internal) return null;
    if (!groupId) return null;

    const internal = bot.internal;
    const logger = opts?.logger;
    const debug = opts?.debug;

    // Extract group ID from channel ID (remove "group:" prefix if present)
    const cleanGroupId = groupId.replace(/^group:/i, '');

    // Try _request method
    if (typeof internal._request === 'function') {
        const _request = internal._request as (action: string, params: Record<string, unknown>) => Promise<unknown>;

        try {
            const rawResult = await _request('get_group_file_url', {
                file_id: fileId,
                group_id: parseInt(cleanGroupId, 10)
            });
            const result = (rawResult as { data?: unknown })?.data || rawResult;

            if (debug && logger) {
                logger.info('OneBot get_group_file_url result:', {
                    hasResult: !!result,
                    hasUrl: !!(result as Record<string, unknown>)?.url,
                    url: (result as Record<string, unknown>)?.url
                });
            }

            if (result) {
                const resultObj = result as Record<string, unknown>;

                if (resultObj.url && typeof resultObj.url === 'string') {
                    const url = resultObj.url;

                    // HTTP URL
                    if (/^https?:\/\//i.test(url)) {
                        if (debug && logger) logger.info('Got HTTP URL from get_group_file_url:', url);
                        return await fetchFromURL(url, logger, debug);
                    }

                    // file:/// URL
                    if (url.startsWith('file:///')) {
                        const localPath = url.replace(/^file:\/\/\//i, '/');
                        if (debug && logger) logger.info('Got file:// URL from get_group_file_url:', localPath);
                        const localBuffer = await tryReadLocalFileBuffer(localPath);
                        if (localBuffer) return localBuffer;
                    }
                }
            }
        } catch (e) {
            if (debug && logger) {
                logger.warn('OneBot get_group_file_url failed:', (e as Error)?.message || e);
            }
        }
    }

    // Try internal methods
    const methods = ['getGroupFileUrl', 'get_group_file_url'];
    for (const method of methods) {
        const fn = internal[method];
        if (typeof fn === 'function') {
            try {
                const result = await (fn as (groupId: number, fileId: string) => Promise<{ url?: string }>)(
                    parseInt(cleanGroupId, 10),
                    fileId
                );
                if (debug && logger) {
                    logger.info(`internal.${method} result:`, { hasUrl: !!result?.url, url: result?.url });
                }
                if (result?.url) {
                    if (/^https?:\/\//i.test(result.url)) {
                        return await fetchFromURL(result.url, logger, debug);
                    }
                    if (result.url.startsWith('file:///')) {
                        const localPath = result.url.replace(/^file:\/\/\//i, '/');
                        const localBuffer = await tryReadLocalFileBuffer(localPath);
                        if (localBuffer) return localBuffer;
                    }
                }
            } catch (e) {
                if (debug && logger) {
                    logger.warn(`internal.${method} failed:`, (e as Error)?.message || e);
                }
            }
        }
    }

    return null;
}

/**
 * Fetch image from various sources
 */
/**
 * Internal fetch logic — called by fetchImage.
 * For file-type images, fetchImage wraps this with double-download.
 */
async function doFetchImage(
    session: Session,
    segment: Segment,
    opts: FetchOptions
): Promise<FetchResult | null> {
    const maxSize = opts.maxFileSize ?? (10 * 1024 * 1024);
    const logger = opts.logger;
    const debug = !!opts.debug;

    try {
        // Extract attributes
        const attrs = segment.attrs || segment.data || {};
        const seen = new Set<string>();

        // Try base64 fields
        const base64Fields = ['base64', 'image_base64', 'data', 'raw', 'content'];
        for (const field of base64Fields) {
            const value = attrs[field];
            if (typeof value === 'string') {
                const key = `base64:${field}`;
                if (!seen.has(key)) {
                    seen.add(key);
                    const buffer = bufferFromBase64(value);
                    if (buffer) {
                        return {
                            buffer,
                            source: `attrs.${field}`,
                            sourceType: 'base64'
                        };
                    }
                }
            }
        }

        // Try data URI
        const urlCandidates = [attrs.url, attrs.src];
        for (const candidate of urlCandidates) {
            if (typeof candidate === 'string') {
                const key = `data-uri:${candidate}`;
                if (!seen.has(key)) {
                    seen.add(key);
                    // Check if it's a data URI
                    if (candidate.startsWith('data:')) {
                        const commaIndex = candidate.indexOf(',');
                        if (commaIndex !== -1) {
                            const meta = candidate.slice(0, commaIndex);
                            const data = candidate.slice(commaIndex + 1).trim();
                            if (meta.includes(';base64')) {
                                const buffer = bufferFromBase64(data);
                                if (buffer) {
                                    return {
                                        buffer,
                                        source: candidate,
                                        sourceType: 'data-uri'
                                    };
                                }
                            }
                        }
                    }
                }
            }
        }

        // =====================================================================
        // PATCH: Try OneBot file API first if fileId exists (before trying local path)
        // This is important when Koishi runs in Docker but the file is on host
        // =====================================================================

        // Try get_image with file attribute (filename like "ComfyUI_temp_xxx.png")
        const imageFileName = attrs.file || attrs.filename || attrs.name;
        if (imageFileName && typeof imageFileName === 'string') {
            const key = `onebot-image:${imageFileName}`;
            if (!seen.has(key)) {
                seen.add(key);
                if (debug && logger) {
                    logger.info('Attempting get_image with filename:', imageFileName);
                }
                const imageBuffer = await fetchImageViaOneBot(session.bot, imageFileName, opts);
                if (imageBuffer) {
                    if (debug && logger) {
                        logger.info('Successfully fetched image via get_image API', { size: imageBuffer.length });
                    }
                    return {
                        buffer: imageBuffer,
                        source: `onebot-image:${imageFileName}`,
                        sourceType: 'bot-file'
                    };
                }
            }
        }

        // Try get_group_file_url for group files (fileId starts with "/")
        const oneBotFileId = attrs.fileId || attrs.file_id || (attrs as Record<string, unknown>)['file-id'];
        if (oneBotFileId && typeof oneBotFileId === 'string' && !session.isDirect) {
            const key = `onebot-group-file:${oneBotFileId}`;
            if (!seen.has(key)) {
                seen.add(key);
                if (debug && logger) {
                    logger.info('Attempting get_group_file_url:', { fileId: oneBotFileId, channelId: session.channelId });
                }
                const fileBuffer = await fetchGroupFileViaOneBot(session.bot, oneBotFileId, session.channelId || '', opts);
                if (fileBuffer) {
                    if (debug && logger) {
                        logger.info('Successfully fetched file via get_group_file_url API', { size: fileBuffer.length });
                    }
                    return {
                        buffer: fileBuffer,
                        source: `onebot-group-file:${oneBotFileId}`,
                        sourceType: 'bot-file'
                    };
                }
            }
        }

        // Try get_file with fileId (fallback)
        if (oneBotFileId && typeof oneBotFileId === 'string') {
            const key = `onebot-file:${oneBotFileId}`;
            if (!seen.has(key)) {
                seen.add(key);
                if (debug && logger) {
                    logger.info('Attempting to fetch via OneBot get_file API:', { fileId: oneBotFileId });
                }
                const oneBotBuffer = await fetchViaOneBotFileAPI(session.bot, oneBotFileId, opts);
                if (oneBotBuffer) {
                    if (debug && logger) {
                        logger.info('Successfully fetched image via OneBot get_file API', { size: oneBotBuffer.length });
                    }
                    return {
                        buffer: oneBotBuffer,
                        source: `onebot-file:${oneBotFileId}`,
                        sourceType: 'bot-file'
                    };
                }
            }
        }
        // =====================================================================
        // END PATCH
        // =====================================================================

        // Try local file paths
        const localCandidates = [attrs.path, attrs.localPath];
        for (const candidate of localCandidates) {
            if (typeof candidate === 'string') {
                const key = `local:${candidate}`;
                if (!seen.has(key)) {
                    seen.add(key);
                    const localBuffer = await tryReadLocalFileBuffer(candidate);
                    if (localBuffer) {
                        return {
                            buffer: localBuffer,
                            source: candidate,
                            sourceType: 'local'
                        };
                    }
                }
            }
        }

        // Try bot file API
        const botCandidates = [attrs.file, attrs.image, attrs.fileId, attrs.file_id, attrs.id];
        for (const candidate of botCandidates) {
            if (typeof candidate === 'string') {
                const key = `bot:${candidate}`;
                if (!seen.has(key)) {
                    seen.add(key);
                    const botBuffer = await fetchFromBotAPI(session, candidate);
                    if (botBuffer) {
                        return {
                            buffer: botBuffer,
                            source: candidate,
                            sourceType: 'bot-file'
                        };
                    }
                }
            }
        }

        // Direct private-file fetch for OneBot/NapCat when only file_id is present
        const directFileId = attrs.file_id || attrs.fileId || (attrs as Record<string, unknown>)['file-id'];
        if (session.isDirect && directFileId && (segment.type === 'image' || segment.type === 'img' || segment.type === 'file' || segment.type === 'attachment')) {
            const privateBuffer = await fetchPrivateFile(session, attrs, opts);
            if (privateBuffer) {
                return {
                    buffer: privateBuffer,
                    source: `private-file:${directFileId}`,
                    sourceType: 'bot-file'
                };
            }
        }

        // Try group files (special case)
        // Check for both 'size' (number) and 'fileSize' (string) attributes
        // Note: Some adapters use hyphenated names like 'file-id' and 'file-size'
        const sizeAttr = attrs.size || attrs.fileSize || attrs.file_size || (attrs as Record<string, unknown>)['file-size'];
        const nameAttr = attrs.name || attrs.file;
        const fileIdAttr = attrs.file_id || attrs.fileId || (attrs as Record<string, unknown>)['file-id'];
        if (nameAttr && (sizeAttr || fileIdAttr)) {
            // Convert to number (handles both string and number types)
            const sizeNum = typeof sizeAttr === 'string' ? parseInt(sizeAttr, 10) : (sizeAttr as number || 0);
            if (sizeNum <= maxSize) {
                const imageExts = ['.jpg', '.jpeg', '.png', '.webp', '.gif', '.bmp', '.tiff', '.heic', '.heif'];
                const fileExt = path.extname(nameAttr as string).toLowerCase();
                if (imageExts.includes(fileExt)) {
                    // Determine if this is a private or group file
                    const isPrivate = session.isDirect;
                    if (isPrivate && fileIdAttr) {
                        // Try private file first
                        const privateBuffer = await fetchPrivateFile(session, attrs, opts);
                        if (privateBuffer) {
                            return {
                                buffer: privateBuffer,
                                source: `private-file:${nameAttr}`,
                                sourceType: 'bot-file'
                            };
                        }
                        // Don't fall through to fetchGroupFile for private chats
                        // as it would fail with "invalid uint 32: NaN" error
                    } else if (!isPrivate) {
                        // Try group file (only for group chats)
                        const fileBuffer = await fetchGroupFile(session, attrs, opts);
                        if (fileBuffer) {
                            return {
                                buffer: fileBuffer,
                                source: `group-file:${attrs.file}`,
                                sourceType: 'bot-file'
                            };
                        }
                    }
                }
            }
        }

        // Try direct URL download
        const directUrl = attrs.src || attrs.url;
        if (typeof directUrl === 'string' && /^https?:\/\//i.test(directUrl)) {
            const key = `url:${directUrl}`;
            if (!seen.has(key)) {
                seen.add(key);
                const urlBuffer = await fetchFromURL(directUrl, logger, debug);
                if (urlBuffer) {
                    return {
                        buffer: urlBuffer,
                        source: directUrl,
                        sourceType: 'url'
                    };
                }
            }
        }

        if (debug && logger) {
            logger.warn('图片下载失败：未找到可用来源', {
                type: segment.type,
                attrs: Object.keys(attrs),
                source: segment._source
            });
        }
        return null;
    } catch (error) {
        if (debug && logger) {
            logger.warn(`图片下载异常: ${(error as Error)?.message || error}`);
        }
        return null;
    }
}

export async function fetchImage(
    ctx: unknown,
    session: Session,
    segment: Segment,
    options?: number | FetchOptions
): Promise<FetchResult | null> {
    // Support legacy signature: fetchImage(ctx, session, segment, maxFileSize)
    const opts = typeof options === 'number'
        ? { maxFileSize: options }
        : (options ?? {});

    const logger = opts.logger;
    const debug = !!opts.debug;
    const isFileType = segment.type === 'file' || segment.type === 'attachment';

    // 文件类型图片：QQ 客户端第一次下载会抹掉 metadata，需下载两次取第二次
    if (isFileType) {
        if (debug && logger) {
            logger.info('[文件类型图片] 开始双次下载（首次下载 QQ 会抹掉 metadata）');
        }

        const first = await doFetchImage(session, segment, opts);

        if (first) {
            if (debug && logger) {
                logger.info('[文件类型图片] 首次下载完成，等待后进行第二次下载', {
                    firstSize: first.buffer.length
                });
            }

            const delay = opts.privateFileRetryDelay ?? 3000;
            await new Promise(resolve => setTimeout(resolve, delay));

            const second = await doFetchImage(session, segment, opts);
            if (second) {
                if (debug && logger) {
                    logger.info('[文件类型图片] 双次下载完成，使用第二次结果', {
                        firstSize: first.buffer.length,
                        secondSize: second.buffer.length,
                        sizeChanged: first.buffer.length !== second.buffer.length
                    });
                }
                return second;
            }

            // 第二次失败，回退用第一次
            if (debug && logger) {
                logger.warn('[文件类型图片] 第二次下载失败，回退使用首次结果');
            }
            return first;
        }

        // 首次也失败，继续走常规逻辑
        if (debug && logger) {
            logger.warn('[文件类型图片] 首次下载失败，走常规下载流程');
        }
    }

    return doFetchImage(session, segment, opts);
}

/**
 * Fetch from bot API (getFile, etc.)
 */
async function fetchFromBotAPI(
    session: Session,
    identifier: string
): Promise<Buffer | null> {
    const bot = session.bot;
    if (!bot) return null;

    // Try getFile
    if (typeof bot.getFile === 'function') {
        try {
            const result = await bot.getFile(identifier);
            if (result) {
                if (typeof result.base64 === 'string') {
                    const buffer = bufferFromBase64(result.base64);
                    if (buffer) return buffer;
                }
                if (typeof result.url === 'string') {
                    return await fetchFromURL(result.url);
                }
                if (typeof result.path === 'string') {
                    const localBuffer = await tryReadLocalFileBuffer(result.path);
                    if (localBuffer) return localBuffer;
                }
            }
        } catch {
            // Ignore errors
        }
    }

    // Try internal methods (OneBot, etc.)
    return await fetchFromInternalAPI(bot, identifier);
}

/**
 * Fetch from bot internal API
 */
async function fetchFromInternalAPI(bot: NonNullable<Session['bot']>, identifier: string): Promise<Buffer | null> {
    if (!bot.internal) return null;

    const internal = bot.internal;
    const methods = [
        'getImage',
        'get_image',
        'getFile',
        'get_file'
    ];

    for (const method of methods) {
        const fn = internal[method];
        if (typeof fn === 'function') {
            try {
                const result = await (fn as (id: string) => Promise<unknown>)(identifier);
                return await extractBufferFromResult(result);
            } catch {
                continue;
            }
        }
    }
    return null;
}

/**
 * Extract buffer from API result
 */
async function extractBufferFromResult(result: unknown): Promise<Buffer | null> {
    if (!result) return null;

    // Direct buffer
    if (Buffer.isBuffer(result)) {
        return result;
    }

    // Base64 string
    if (typeof result === 'string') {
        const buffer = bufferFromBase64(result);
        if (buffer) return buffer;

        // URL string
        if (/^https?:\/\//i.test(result)) {
            return await fetchFromURL(result);
        }

        // Local path
        const localBuffer = await tryReadLocalFileBuffer(result);
        if (localBuffer) return localBuffer;
    }

    // Object with various fields (including OneBot wrapper: { data: ... })
    if (typeof result === 'object') {
        const resultObj = result as Record<string, unknown>;
        const dataObj = (result && typeof resultObj.data === 'object') ? resultObj.data as Record<string, unknown> : null;

        const candidates = [
            resultObj.base64,
            resultObj.url,
            resultObj.path,
            (resultObj.file as Record<string, unknown>)?.url,
            (resultObj.image as Record<string, unknown>)?.url,
            dataObj?.base64,
            dataObj?.url,
            dataObj?.path,
            (dataObj?.file as Record<string, unknown>)?.url,
            (dataObj?.image as Record<string, unknown>)?.url
        ];

        for (const candidate of candidates) {
            if (typeof candidate === 'string') {
                const buffer = bufferFromBase64(candidate);
                if (buffer) return buffer;

                if (/^https?:\/\//i.test(candidate)) {
                    const urlBuffer = await fetchFromURL(candidate);
                    if (urlBuffer) return urlBuffer;
                }

                const localBuffer = await tryReadLocalFileBuffer(candidate);
                if (localBuffer) return localBuffer;
            }
        }
    }
    return null;
}

/**
 * Fetch from URL
 */
async function fetchFromURL(
    url: string,
    logger?: { info: (msg: string, ...args: unknown[]) => void; warn: (msg: string, ...args: unknown[]) => void },
    debug?: boolean
): Promise<Buffer | null> {
    try {
        const isQQDownload = /qqdownloadftnv5|ftn\.qq\.com/i.test(url);

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
        });

        const buffer = Buffer.from(response.data);
        const contentType = String(response.headers?.['content-type'] || '').toLowerCase();

        if (debug && logger) {
            logger.info('图片下载响应:', {
                url,
                status: response.status,
                contentType,
                size: buffer.length
            });
        }

        if (buffer.length < 512 && (contentType.includes('text/html') || contentType.includes('application/json'))) {
            if (debug && logger) {
                logger.warn('图片下载返回疑似错误页/短响应', { url, contentType, size: buffer.length });
            }
            return null;
        }

        return buffer;
    } catch (error) {
        if (debug && logger) {
            logger.warn('图片下载请求失败', { url, error: (error as Error)?.message || error });
        }
        return null;
    }
}

/**
 * Fetch group file using OneBot API with retry support
 * QQ group files may return compressed preview on first request,
 * retry mechanism helps get the original file
 */
async function fetchGroupFile(
    session: Session,
    attrs: Record<string, unknown>,
    opts?: FetchOptions
): Promise<Buffer | null> {
    const bot = session.bot;
    if (!bot?.internal) return null;

    const retryDelay = opts?.groupFileRetryDelay ?? 2000;
    const retryCount = opts?.groupFileRetryCount ?? 2;
    const internal = bot.internal;

    const methods = [
        'getGroupFileUrl',
        'get_group_file_url'
    ];

    // Helper function to attempt file fetch
    const attemptFetch = async (): Promise<Buffer | null> => {
        for (const method of methods) {
            const fn = internal[method];
            if (typeof fn === 'function') {
                try {
                    const result = await (fn as (channelId: string, file: string, busid: unknown) => Promise<{ url?: string }>)(
                        session.channelId || '',
                        attrs.file as string,
                        attrs.busid
                    );
                    if (result?.url) {
                        return await fetchFromURL(result.url);
                    }
                } catch {
                    continue;
                }
            }
        }
        return null;
    };

    // First attempt
    let buffer = await attemptFetch();

    // Retry if first attempt succeeded but might be compressed preview
    // QQ returns compressed preview on first request, original on retry
    if (buffer && retryCount > 0 && retryDelay > 0) {
        for (let i = 0; i < retryCount; i++) {
            // Wait before retry
            await new Promise(resolve => setTimeout(resolve, retryDelay));
            const retryBuffer = await attemptFetch();
            if (retryBuffer) {
                // Use the retry result (more likely to be original)
                buffer = retryBuffer;
                break;
            }
        }
    }

    if (buffer) return buffer;

    // Fallback: try to fetch using fileId if file attribute doesn't work
    if (attrs.fileId || attrs.file_id) {
        const fileId = attrs.fileId || attrs.file_id;
        return await fetchFromBotAPI(session, fileId as string);
    }

    return null;
}

/**
 * Fetch private file using OneBot API with retry support
 * Private files may not be immediately available after upload
 */
async function fetchPrivateFile(
    session: Session,
    attrs: Record<string, unknown>,
    opts?: FetchOptions
): Promise<Buffer | null> {
    const bot = session.bot;
    if (!bot?.internal) return null;

    const retryDelay = opts?.privateFileRetryDelay ?? 3000;
    const retryCount = opts?.privateFileRetryCount ?? 3;
    const internal = bot.internal;

    // Support both underscore and hyphenated attribute names
    const fileId = attrs.file_id || attrs.fileId || (attrs as Record<string, unknown>)['file-id'];
    if (!fileId) return null;

    // Helper function to attempt file fetch using various methods
    const attemptFetch = async (): Promise<Buffer | null> => {
        // Method 0: If attrs already provides a usable URL, try it first
        const directUrl = attrs.url || attrs.src;
        if (typeof directUrl === 'string' && /^https?:\/\//i.test(directUrl)) {
            const directBuffer = await fetchFromURL(directUrl, opts?.logger, opts?.debug);
            if (directBuffer) return directBuffer;
        }

        // Method 1: Try using internal._request for direct OneBot API calls
        if (typeof internal._request === 'function') {
            // Try get_file first - returns base64 for remote deployments
            try {
                const rawResult = await (internal._request as (action: string, params: Record<string, unknown>) => Promise<unknown>)('get_file', { file_id: fileId });
                // Extract data from OneBot response wrapper
                const result = (rawResult as { data?: unknown })?.data || rawResult;

                if (opts?.debug && opts?.logger) {
                    opts.logger.info('get_file via _request result:', {
                        hasResult: !!result,
                        hasBase64: !!(result as Record<string, unknown>)?.base64,
                        hasUrl: !!(result as Record<string, unknown>)?.url,
                        hasFile: !!(result as Record<string, unknown>)?.file,
                        keys: result ? Object.keys(result as Record<string, unknown>) : []
                    });
                }

                if (result) {
                    const resultObj = result as Record<string, unknown>;

                    // Check for base64 data first
                    if (resultObj.base64) {
                        const buffer = bufferFromBase64(resultObj.base64 as string);
                        if (buffer) {
                            if (opts?.debug && opts?.logger) {
                                opts.logger.info('get_file returned base64 data', { size: buffer.length });
                            }
                            return buffer;
                        }
                    }

                    // Check for HTTP URL
                    if (resultObj.url && typeof resultObj.url === 'string' && /^https?:\/\//i.test(resultObj.url)) {
                        const buffer = await fetchFromURL(resultObj.url, opts?.logger, opts?.debug);
                        if (buffer) return buffer;
                    }

                    // Check for local path
                    if (resultObj.file) {
                        const localBuffer = await tryReadLocalFileBuffer(resultObj.file);
                        if (localBuffer) return localBuffer;
                    }
                }
            } catch (e) {
                if (opts?.debug && opts?.logger) {
                    opts.logger.warn('get_file via _request failed:', e);
                }
            }

            // Try get_private_file_url - returns HTTP download URL
            try {
                const rawResult = await (internal._request as (action: string, params: Record<string, unknown>) => Promise<unknown>)('get_private_file_url', { file_id: fileId });
                const result = (rawResult as { data?: unknown })?.data || rawResult;

                if (opts?.debug && opts?.logger) {
                    opts.logger.info('get_private_file_url via _request result:', {
                        url: (result as Record<string, unknown>)?.url,
                        status: (rawResult as { status?: unknown })?.status,
                        retcode: (rawResult as { retcode?: unknown })?.retcode
                    });
                }

                const url = (result as Record<string, unknown>)?.url;
                if (url && typeof url === 'string' && /^https?:\/\//i.test(url)) {
                    const buffer = await fetchFromURL(url, opts?.logger, opts?.debug);
                    if (buffer) return buffer;
                }
            } catch (e) {
                if (opts?.debug && opts?.logger) {
                    opts.logger.warn('get_private_file_url via _request failed:', e);
                }
            }
        }

        // Method 2: Try getFile directly
        if (typeof internal.getFile === 'function') {
            try {
                const result = await (internal.getFile as (id: string) => Promise<Record<string, unknown>>)(
                    fileId as string
                );

                if (opts?.debug && opts?.logger) {
                    opts.logger.info('getFile(fileId) result:', {
                        hasResult: !!result,
                        keys: result ? Object.keys(result) : []
                    });
                }

                if (result?.base64) {
                    const buffer = bufferFromBase64(result.base64 as string);
                    if (buffer) return buffer;
                }

                if (result?.url && typeof result.url === 'string' && /^https?:\/\//i.test(result.url)) {
                    const buffer = await fetchFromURL(result.url, opts?.logger, opts?.debug);
                    if (buffer) return buffer;
                }

                if (result?.file) {
                    const localBuffer = await tryReadLocalFileBuffer(result.file);
                    if (localBuffer) return localBuffer;
                }
            } catch (e) {
                if (opts?.debug && opts?.logger) {
                    opts.logger.warn('getFile(fileId) failed:', e);
                }
            }
        }

        return null;
    };

    // First attempt
    let buffer = await attemptFetch();

    // Retry if first attempt failed (file might not be ready yet)
    if (!buffer && retryCount > 0 && retryDelay > 0) {
        for (let i = 0; i < retryCount; i++) {
            // Wait before retry
            await new Promise(resolve => setTimeout(resolve, retryDelay));
            buffer = await attemptFetch();
            if (buffer) {
                break;
            }
        }
    }

    if (buffer) return buffer;

    // Fallback: try to fetch using fileId via bot API
    return await fetchFromBotAPI(session, fileId as string);
}

export default {
    fetchImage,
    fetchFromURL
};