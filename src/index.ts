/**
 * Koishi plugin for reading Stable Diffusion image metadata
 * Patched version with OneBot file API support for Docker environments
 */

import { Schema, h } from 'koishi';
import { extractMetadata, formatMetadataResult } from './extractor';
import { fetchImage } from './fetcher';
import { makeImageSegmentKey } from './utils';
import { extendDatabase, findByCacheKey, findByPHash, saveCache, removeByCacheKey, cleanupExpired, SdCacheRecord } from './database';
import { promises as fs } from 'fs';
import path from 'path';

export const name = 'sdexif';

// Optional dependency on chatluna_storage
export const inject = {
    required: ['database'],
    optional: ['chatluna_storage']
};

export interface Config {
    enableDebugLog: boolean;
    privateOnly: boolean;
    useForward: boolean;
    embedImageInNormalMode: boolean;
    spyEnabled: boolean;
    spyGroups: string[];
    spyTargetChannel: string;
    groupAutoParseWhitelist: string[];
    privateAutoParseEnabled: boolean;
    maxFileSize: number;
    messageSplitThreshold: number;
    enableDedupe: boolean;
    globalDedupeEnabled: boolean;
    globalDedupeTimeout: number;
    imageSimilarityThreshold: number;
    retentionDays: number;
    groupFileRetryDelay: number;
    groupFileRetryCount: number;
    privateFileRetryDelay: number;
    privateFileRetryCount: number;
    enableCache: boolean;
    cacheMaxSize: number;
    preferFileCache: boolean;
}

export const Config = Schema.intersect([
    // 基础设置
    Schema.object({
        enableDebugLog: Schema.boolean()
            .default(false)
            .description('是否启用调试日志（用于排查图片接收问题）'),
        privateOnly: Schema.boolean()
            .default(false)
            .description('是否仅在私聊中启用')
    }).description('基础'),

    // 输出/合并转发
    Schema.object({
        useForward: Schema.boolean()
            .default(false)
            .description('是否使用合并转发格式发送消息'),
        embedImageInNormalMode: Schema.boolean()
            .default(false)
            .description('普通模式（非合并转发）下是否嵌入图片')
    }).description('输出与显示'),

    // 视奸监听
    Schema.object({
        spyEnabled: Schema.boolean()
            .default(false)
            .description('视奸开关：在指定群中监听图片并转发到目标频道'),
        spyGroups: Schema.array(Schema.string())
            .default([])
            .description('视奸监听的群聊 ID 列表，支持 `group:123456` 或 `123456`'),
        spyTargetChannel: Schema.string()
            .description('视奸转发目标频道 ID，例如 `private:123456` 或 `group:654321`')
    }).description('视奸'),

    // 自动解析（群白名单）
    Schema.object({
        groupAutoParseWhitelist: Schema.array(Schema.string())
            .default([])
            .description('群聊白名单：在这些群聊中自动解析图片（无需命令），为空则禁用'),
        privateAutoParseEnabled: Schema.boolean()
            .default(false)
            .description('私聊自动解析：在私聊中自动解析收到的图片/文件（无需命令）')
    }).description('自动解析'),

    // 解析与限制
    Schema.object({
        maxFileSize: Schema.number()
            .default(10 * 1024 * 1024)
            .description('允许解析的最大图片文件大小（字节）'),
        messageSplitThreshold: Schema.number()
            .default(2000)
            .description('长消息分割的字符阈值（单条消息最大长度）'),
        enableDedupe: Schema.boolean()
            .default(true)
            .description('是否对重复图片进行去重处理'),
        globalDedupeEnabled: Schema.boolean()
            .default(true)
            .description('是否启用跨消息去重（防止引用消息重复解析）'),
        globalDedupeTimeout: Schema.number()
            .default(600000)
            .description('全局去重缓存超时时间（毫秒，默认10分钟）'),
        imageSimilarityThreshold: Schema.number()
            .default(5)
            .description('图片 pHash 相似度阈值（百分比，5 表示 5% 汉明距离）'),
        retentionDays: Schema.number()
            .default(3)
            .description('缓存记录保留天数（默认 3 天，超时自动清理）'),
        groupFileRetryDelay: Schema.number()
            .default(2000)
            .description('群文件获取重试延迟（毫秒）- QQ群文件首次获取可能返回压缩图，需等待后重试'),
        groupFileRetryCount: Schema.number()
            .default(2)
            .description('群文件获取重试次数（默认2次）'),
        privateFileRetryDelay: Schema.number()
            .default(3000)
            .description('私聊文件获取重试延迟（毫秒）- 私聊文件可能需要等待服务器处理'),
        privateFileRetryCount: Schema.number()
            .default(3)
            .description('私聊文件获取重试次数（默认3次）')
    }).description('解析与限制'),

    // 缓存
    Schema.object({
        enableCache: Schema.boolean()
            .default(true)
            .description('是否启用缓存机制'),
        cacheMaxSize: Schema.number()
            .default(100 * 1024 * 1024)
            .description('缓存目录最大大小（字节）'),
        preferFileCache: Schema.boolean()
            .default(false)
            .description('是否优先使用文件缓存（实验性）')
    }).description('缓存')
]);

interface Session {
    platform?: string;
    channelId?: string;
    userId?: string;
    content?: string;
    elements?: h[];
    quote?: {
        messageId?: string;
        id?: string;
        elements?: h[];
        message?: unknown[];
        content?: string;
    };
    event?: {
        message?: unknown[];
        file?: {
            name?: string;
            id?: string;
            size?: number;
            url?: string;
            path?: string;
            busid?: unknown;
        };
    };
    isDirect?: boolean;
    selfId?: string;
    bot?: {
        selfId?: string;
        user?: { name?: string };
        internal?: Record<string, unknown>;
        getFile?: (id: string) => Promise<Record<string, unknown> | null>;
        sendMessage?: (channel: string, content: string | h[]) => Promise<void>;
        getMessage?: (channelId: string, messageId: string) => Promise<{ elements?: h[]; message?: unknown[]; content?: string } | null>;
        getMessageOne?: (messageId: string) => Promise<{ elements?: h[]; message?: unknown[]; content?: string } | null>;
        sendFile?: (filename: string, content: Buffer) => Promise<string>;
    };
    send?: (content: string | h[]) => Promise<void>;
}

interface ImageSegment {
    type: string;
    attrs: Record<string, unknown>;
    data: Record<string, unknown>;
    _source: string;
    buffer?: Buffer;
}

let CACHE_DIR: string;
let cacheDirEnsured = false;

// pHash 计算函数（延迟加载 message-dedup 的 hash 模块）
let _calculateImageHash: ((buffer: Buffer) => Promise<string>) | null = null;
let _calculateHashDistance: ((h1: string, h2: string) => number) | null = null;

function loadHashFunctions(logger: { warn: (msg: string, ...args: unknown[]) => void }): boolean {
    if (_calculateImageHash && _calculateHashDistance) return true;
    try {
        const hashModule = require('koishi-plugin-message-dedup/lib/hash');
        _calculateImageHash = hashModule.calculateImageHash;
        _calculateHashDistance = hashModule.calculateHashDistance;
        return true;
    } catch {
        logger.warn('无法加载 message-dedup hash 模块，pHash 去重将降级为 cacheKey 匹配');
        return false;
    }
}

// Helper function to check if an image is globally duplicate
function isGloballyDuplicate(
    key: string | null,
    cachedKeys: Map<string, number> | null,
    timeout: number
): boolean {
    if (!key || !cachedKeys) return false;
    const cachedTs = cachedKeys.get(key);
    if (cachedTs === undefined) return false;
    return Date.now() - cachedTs < timeout;
}

// Type definitions for Koishi context
interface KoishiLogger {
    info: (msg: string, ...args: unknown[]) => void;
    warn: (msg: string, ...args: unknown[]) => void;
    error: (msg: string, ...args: unknown[]) => void;
    debug: (msg: string, ...args: unknown[]) => void;
}

interface KoishiCommandBuilder {
    alias: (name: string) => KoishiCommandBuilder;
    option: (name: string, desc: string) => KoishiCommandBuilder;
    shortcut: (name: string, opts: { fuzzy: boolean }) => KoishiCommandBuilder;
    action: (fn: (opts: { session: Session; options: { withImage?: boolean } }) => Promise<string | (string | h)[] | void>) => void;
}

interface KoishiContext {
    baseDir: string;
    logger: (name: string) => KoishiLogger;
    command: (name: string, desc: string) => KoishiCommandBuilder;
    middleware: (fn: (session: Session, next: () => void) => Promise<void>) => void;
    chatluna_storage?: {
        createTempFile?: (buffer: Buffer, filename: string) => Promise<{ url?: string }>;
    };
}

export function apply(ctx: KoishiContext, config: Config): void {
    const logger = ctx.logger('sdexif');

    // Initialize cache directory path using ctx.baseDir for stability
    CACHE_DIR = path.join(ctx.baseDir, 'data', 'sdexif');

    // Initialize database table for image cache
    extendDatabase(ctx as any);

    // Load pHash functions from message-dedup (optional, falls back to cacheKey-only)
    loadHashFunctions(logger);

    // Periodic cleanup of expired cache records
    const retentionMs = (config.retentionDays ?? 3) * 24 * 60 * 60 * 1000;
    (ctx as any).setInterval(() => {
        cleanupExpired(ctx as any, retentionMs).catch((e: unknown) => {
            logger.warn('清理过期缓存记录失败:', e);
        });
    }, 60 * 60 * 1000); // 每小时清理一次

    // Initialize and manage cache system
    async function ensureCacheDirectory(): Promise<void> {
        if (config.enableCache === false) return;
        if (cacheDirEnsured) return;

        try {
            await fs.mkdir(CACHE_DIR, { recursive: true });
            cacheDirEnsured = true;

            // Check cache size if cacheMaxSize is configured
            if (config.cacheMaxSize && config.cacheMaxSize > 0) {
                await cleanupCacheIfNeeded();
            }
        } catch (e) {
            logger.warn('无法创建缓存目录:', e);
        }
    }

    async function cleanupCacheIfNeeded(): Promise<void> {
        if (config.enableCache === false) return;
        if (!config.cacheMaxSize || config.cacheMaxSize <= 0) return;

        try {
            const files = await fs.readdir(CACHE_DIR);
            const fileStats = await collectFileStats(files);
            const totalSize = fileStats.reduce((sum, f) => sum + f.size, 0);

            if (totalSize <= config.cacheMaxSize) return;

            await cleanupFiles(fileStats, totalSize);
        } catch (e) {
            logger.warn('缓存清理失败:', e);
        }
    }

    async function collectFileStats(files: string[]): Promise<{ path: string; size: number; mtime: Date }[]> {
        const stats: { path: string; size: number; mtime: Date }[] = [];

        for (const file of files) {
            const stat = await safeStat(path.join(CACHE_DIR, file));
            if (stat && stat.isFile()) {
                stats.push({ path: path.join(CACHE_DIR, file), size: stat.size, mtime: stat.mtime });
            }
        }

        return stats;
    }

    async function safeStat(filePath: string): Promise<{ isFile: () => boolean; size: number; mtime: Date } | null> {
        try {
            return await fs.stat(filePath);
        } catch {
            return null;
        }
    }

    async function cleanupFiles(
        fileStats: { path: string; size: number; mtime: Date }[],
        totalSize: number
    ): Promise<void> {
        logger.info(`缓存大小 ${(totalSize / 1024 / 1024).toFixed(2)}MB 超过限制 ${(config.cacheMaxSize! / 1024 / 1024).toFixed(2)}MB，开始清理`);

        fileStats.sort((a, b) => a.mtime.getTime() - b.mtime.getTime());

        const targetSize = config.cacheMaxSize! * 0.8;
        let deletedSize = 0;

        for (const file of fileStats) {
            if (totalSize - deletedSize <= targetSize) break;
            const size = await safeDelete(file.path);
            if (size > 0) {
                deletedSize += file.size;
                logger.debug(`删除缓存文件: ${path.basename(file.path)} (${(file.size / 1024 / 1024).toFixed(2)}MB)`);
            }
        }

        logger.info(`清理完成，删除 ${(deletedSize / 1024 / 1024).toFixed(2)}MB`);
    }

    async function safeDelete(filePath: string): Promise<number> {
        try {
            const stat = await fs.stat(filePath);
            await fs.unlink(filePath);
            return stat.size;
        } catch {
            return 0;
        }
    }

    // Helper function to check if channel ID is in list
    function isChannelInList(channelId: string, list: string[]): boolean {
        const chId = String(channelId || '');
        const normalized = chId.replace(/^(?:private|group|guild|channel):/i, '');
        return list.includes(chId) || list.includes(normalized) || list.includes(`group:${normalized}`);
    }

    // Helper function to send auto-parsed results
    async function sendAutoParseResult(session: Session, resp: string | (string | h)[] | void, targetChannel?: string): Promise<boolean> {
        if (!resp) return false;

        if (typeof resp === 'string') {
            if (resp === '未能从图片中读取到 Stable Diffusion 信息') return false;

            if (targetChannel) {
                await session.bot?.sendMessage?.(targetChannel, resp);
            } else {
                await session.send?.(resp);
            }
            return true;
        }

        if (Array.isArray(resp)) {
            if (targetChannel) {
                await session.bot?.sendMessage?.(targetChannel, resp as h[]);
            } else {
                await session.send?.(resp as h[]);
            }
            return true;
        }

        return false;
    }

    ctx.command('sdexif', '读取图片中的 Stable Diffusion 信息')
        .alias('读图')
        .option('withImage', '-i 在发送结果时包含图片')
        .shortcut('sdexif', { fuzzy: true })
        .shortcut('读图', { fuzzy: true })
        .action(async ({ session, options }) => {
            if (!session) return '无法获取会话信息';
            if (config.privateOnly && !session.isDirect) {
                return;
            }

            if (config.enableDebugLog) {
                logger.info('收到 sdexif 命令:', {
                    platform: session.platform,
                    channelId: session.channelId,
                    userId: session.userId,
                    content: session.content,
                    elementsCount: session.elements?.length || 0,
                    hasQuote: !!session.quote,
                    quoteMessageId: session.quote?.messageId || session.quote?.id,
                    quoteElementsCount: session.quote?.elements?.length || 0,
                    quoteMessage: session.quote?.message ? 'exists' : 'none',
                    quoteContent: session.quote?.content ? 'exists' : 'none'
                });
            }

            await ensureCacheDirectory();

            const segments = await collectImageSegments(session, config.enableDebugLog, logger, config, true, ctx);
            if (segments.length === 0) {
                return '请在发送命令的同时附带图片，或引用回复包含图片的消息';
            }

            if (config.enableDebugLog) {
                logger.info(`检测到 ${segments.length} 个图片元素，开始处理`);
            }

            // In normal mode, check if command option -i is used, or if config is set to embed images
            const shouldEmbed = !!options?.withImage || (!config.useForward && config.embedImageInNormalMode);
            const response = await processImages(ctx, session, segments, config, logger, false, shouldEmbed, true);

            return response;
        });

    // Spy middleware: forward images from monitored groups to target channel
    ctx.middleware(async (session, next) => {
        try {
            if (!config.spyEnabled) return next();
            if (!session || session.isDirect) return next();

            const groups = Array.isArray(config.spyGroups) ? config.spyGroups : [];
            if (groups.length === 0) return next();
            if (!isChannelInList(session.channelId || '', groups)) return next();

            const target = (config.spyTargetChannel || '').trim();
            if (!target) return next();

            // Enhanced loop protection: check both raw and normalized IDs
            const chId = String(session.channelId || '');
            const normalized = chId.replace(/^(?:private|group|guild|channel):/i, '');
            const normalizedTarget = target.replace(/^(?:private|group|guild|channel):/i, '');

            if (target === chId || normalizedTarget === chId || normalizedTarget === normalized) return next();

            await ensureCacheDirectory();

            const segments = await collectImageSegments(session, config.enableDebugLog, logger, config, false, ctx);
            if (segments.length === 0) return next();

            const forcedConfig = { ...config, useForward: true };
            const resp = await processImages(ctx, session, segments, forcedConfig, logger, true, true);
            try {
                await sendAutoParseResult(session, resp, target);
            } catch (sendErr) {
                if (config.enableDebugLog) {
                    logger.warn('视奸转发发送失败', sendErr);
                }
                // Clear global cache to allow group whitelist to process
                if (config.globalDedupeEnabled !== false && session.elements) {
                    for (const el of session.elements) {
                        const key = makeImageSegmentKey({ attrs: el.attrs, data: el.data });
                        if (key) {
                            await removeByCacheKey(ctx as any, key);
                            if (config.enableDebugLog) {
                                logger.info('视奸转发发送失败，清除全局缓存:', { key });
                            }
                        }
                    }
                }
            }
            return;
        } catch (e) {
            if (config.enableDebugLog) {
                logger.warn('视奸转发处理中发生错误', e);
            }
            // Clear global cache for images from this session to allow group whitelist to process
            if (config.globalDedupeEnabled !== false && session.elements) {
                for (const el of session.elements) {
                    const key = makeImageSegmentKey({ attrs: el.attrs, data: el.data });
                    if (key) {
                        await removeByCacheKey(ctx as any, key);
                        if (config.enableDebugLog) {
                            logger.info('视奸转发失败，清除全局缓存:', { key });
                        }
                    }
                }
            }
            return next();
        }
    });

    // Group whitelist middleware: auto-parse images in whitelisted groups
    ctx.middleware(async (session, next) => {
        try {
            if (config.privateOnly) return next();
            if (!session || session.isDirect) return next();

            const whitelist = config.groupAutoParseWhitelist || [];
            if (!Array.isArray(whitelist) || whitelist.length === 0) return next();
            if (!isChannelInList(session.channelId || '', whitelist)) return next();

            // Skip if message contains command keywords
            const contentLower = (session.content || '').toLowerCase();
            if (contentLower.includes('sdexif') || contentLower.includes('读图')) {
                return next();
            }

            await ensureCacheDirectory();

            const segments = await collectImageSegments(session, config.enableDebugLog, logger, config, false, ctx, true);
            if (segments.length === 0) return next();

            const resp = await processImages(ctx, session, segments, config, logger, true, true);
            await sendAutoParseResult(session, resp);

            return;
        } catch (e) {
            if (config.enableDebugLog) {
                logger.warn('群白名单自动解析处理失败', e);
            }
            return next();
        }
    });

    // Private chat auto-parse middleware: auto-parse images/files in private chat
    ctx.middleware(async (session, next) => {
        try {
            if (!config.privateAutoParseEnabled) return next();
            if (!session || !session.isDirect) return next();

            // Skip if message contains command keywords
            const contentLower = (session.content || '').toLowerCase();
            if (contentLower.includes('sdexif') || contentLower.includes('读图')) {
                return next();
            }

            await ensureCacheDirectory();

            const segments = await collectImageSegments(session, config.enableDebugLog, logger, config, false, ctx, true);
            if (segments.length === 0) return next();

            if (config.enableDebugLog) {
                logger.info('私聊自动解析：检测到图片', {
                    count: segments.length,
                    sources: segments.map(s => s._source)
                });
            }

            const resp = await processImages(ctx, session, segments, config, logger, true, true);
            await sendAutoParseResult(session, resp);

            return;
        } catch (e) {
            if (config.enableDebugLog) {
                logger.warn('私聊自动解析处理失败', e);
            }
            return next();
        }
    });
}

/**
 * Split long messages into chunks, preserving prompt header
 */
function splitLongMessages(messages: string[], maxLength: number): string[] {
    const splitMessages: string[] = [];

    for (const message of messages) {
        if (message.length <= maxLength) {
            splitMessages.push(message);
        } else {
            // Split long message into chunks
            // First extract and preserve prompt at the beginning
            let content = message;
            let promptHeader = '';
            const promptLine = content.split('\n').find(line => line.startsWith('正向提示词:') || line.startsWith('Prompt:'));

            if (promptLine && promptLine.length < maxLength) {
                promptHeader = promptLine + '\n\n';
                content = content.replace(promptLine, '').trim();
            }

            // Split remaining content
            const chunks: string[] = [];
            let remaining = content;

            while (remaining.length > 0) {
                if (remaining.length <= maxLength) {
                    chunks.push(remaining);
                    break;
                }

                // Find last newline before maxLength to split nicely
                let splitIndex = maxLength;
                const lastNewline = remaining.lastIndexOf('\n', maxLength);
                if (lastNewline > maxLength * 0.5) { // If newline is not too early
                    splitIndex = lastNewline;
                }

                chunks.push(remaining.substring(0, splitIndex));
                remaining = remaining.substring(splitIndex).trim();
            }

            // If we have a prompt header, prepend it to the first chunk (or create one)
            if (promptHeader) {
                if (chunks.length > 0) {
                    chunks[0] = promptHeader + chunks[0];
                } else {
                    chunks.push(promptHeader);
                }
            }

            // Drop empty chunks to avoid blank forward messages
            splitMessages.push(...chunks.filter(c => c && c.trim().length > 0));
        }
    }

    return splitMessages;
}

async function processSingleImage(
    ctx: KoishiContext,
    session: Session,
    segment: ImageSegment,
    config: Config,
    skipGlobalDedupe: boolean,
    logger: { info: (msg: string, ...args: unknown[]) => void; warn: (msg: string, ...args: unknown[]) => void }
): Promise<{ metadata: Record<string, unknown>; buffer: Buffer } | null> {
    const fetchResult = await fetchImage(ctx, session, segment as unknown as { type: string; attrs?: Record<string, unknown>; data?: Record<string, unknown>; _source?: string }, {
        maxFileSize: config.maxFileSize,
        groupFileRetryDelay: config.groupFileRetryDelay,
        groupFileRetryCount: config.groupFileRetryCount,
        privateFileRetryDelay: config.privateFileRetryDelay,
        privateFileRetryCount: config.privateFileRetryCount,
        logger,
        debug: config.enableDebugLog,
        chatlunaStorage: ctx.chatluna_storage
    });

    if (!fetchResult) return null;

    if (config.enableDebugLog) {
        logger.info('成功获取图片数据:', {
            source: fetchResult.source,
            sourceType: fetchResult.sourceType,
            size: fetchResult.buffer.length
        });
    }

    const metadata = extractMetadata(fetchResult.buffer, config.enableDebugLog ? logger : undefined);

    if (!metadata.success || !metadata.data || Object.keys(metadata.data).length === 0) {
        return null;
    }

    if (config.enableDebugLog) {
        logger.info('成功提取元数据:', metadata.data);
    }

    await saveToGlobalCache(ctx, session, segment, fetchResult.buffer, skipGlobalDedupe, config, logger);

    return { metadata: metadata.data as Record<string, unknown>, buffer: fetchResult.buffer };
}

async function saveToGlobalCache(
    ctx: KoishiContext,
    session: Session,
    segment: ImageSegment,
    buffer: Buffer,
    skipGlobalDedupe: boolean,
    config: Config,
    logger: { info: (msg: string, ...args: unknown[]) => void }
): Promise<void> {
    if (skipGlobalDedupe || config.globalDedupeEnabled === false) return;

    const key = makeImageSegmentKey({ attrs: segment.attrs, data: segment.data });
    if (!key) return;

    let pHash = '';
    if (_calculateImageHash) {
        try {
            pHash = await _calculateImageHash(buffer);
        } catch {
            // pHash 计算失败，不影响正常解析
        }
    }

    await saveCache(ctx as any, {
        cacheKey: key,
        pHash,
        timestamp: Date.now(),
        channelId: session.channelId || '',
        userId: session.userId || ''
    });

    if (config.enableDebugLog) {
        logger.info('已添加到全局去重缓存:', { key, pHash: pHash || '(无)', channelId: session.channelId });
    }
}

async function processImages(
    ctx: KoishiContext,
    session: Session,
    imageSegments: ImageSegment[],
    config: Config,
    logger: { info: (msg: string, ...args: unknown[]) => void; warn: (msg: string, ...args: unknown[]) => void; error: (msg: string, ...args: unknown[]) => void },
    isSilentMode: boolean = false,
    withImage: boolean = false,
    skipGlobalDedupe: boolean = false
): Promise<string | (string | h)[] | void> {
    if (config.enableDebugLog) {
        logger.info('消息元素分析:', {
            totalElements: session.elements?.length || 0,
            imageElements: imageSegments.length,
            elementTypes: (session.elements || []).map((el) => el.type),
            imageElementDetails: imageSegments.map(el => ({
                type: el.type,
                attrs: el.attrs,
                source: el._source
            }))
        });
    }

    // Note: Deduplication is already done in collectImageSegments
    // This avoids redundant deduplication
    const segments = imageSegments;
    const results: Record<string, unknown>[] = [];
    const usedSegments: ImageSegment[] = [];

    for (let i = 0; i < segments.length; i++) {
        const segment = segments[i];

        if (config.enableDebugLog) {
            logger.info(`处理第 ${i + 1} 个图片:`, { type: segment.type, source: segment._source });
        }

        try {
            const result = await processSingleImage(ctx, session, segment, config, skipGlobalDedupe, logger);
            if (result) {
                results.push(result.metadata);
                usedSegments.push({ ...segment, buffer: result.buffer });
            }
        } catch (error) {
            logger.warn(`解析图片失败: ${(error as Error)?.message || error}`);
            if (config.enableDebugLog) {
                logger.error('详细错误信息:', error);
            }
        }
    }

    if (results.length === 0) {
        return '未能从图片中读取到 Stable Diffusion 信息';
    }

    // 在静默模式下，如果只找到 EXIF 回退数据（没有其他 SD metadata），则不发送任何消息
    if (isSilentMode && results.every(r => r.exifFallback && !r.prompt && !r.naiBasePrompt && !r.parameters)) {
        return;
    }

    const messages = results.map((metadata, i) => {
        const result = formatMetadataResult(metadata as import('./a1111').SDMetadata);
        return (usedSegments.length > 1 ? `图片 ${i + 1}:\n---\n${result}` : result);
    });

    // For long ComfyUI workflow outputs, split into multiple messages
    const maxLength = config.messageSplitThreshold || 2000;
    const splitMessages = splitLongMessages(messages, maxLength);

    return formatOutput(session, splitMessages, usedSegments.length > 0 ? usedSegments : segments, config, withImage);
}

async function collectImageSegments(
    session: Session,
    debug: boolean = false,
    logger: { info: (msg: string, ...args: unknown[]) => void },
    config: Config,
    skipGlobalDedupe: boolean = false,
    ctx?: KoishiContext,
    fileTypeOnly: boolean = false
): Promise<ImageSegment[]> {
    const segments: ImageSegment[] = [];
    const seenKeys = new Set<string>();

    // 从数据库加载当前频道的近期缓存记录（一次性批量查询，避免逐条异步查库）
    let cachedKeys: Map<string, number> | null = null;
    if (!skipGlobalDedupe && config?.globalDedupeEnabled !== false) {
        try {
            const timeout = config?.globalDedupeTimeout ?? 600000;
            const cutoff = Date.now() - timeout;
            const channelId = session.channelId || '';
            const records = await (ctx as any).database.get('sdkkt_image_cache', {
                channelId,
                timestamp: { $gt: cutoff }
            });
            if (records.length > 0) {
                cachedKeys = new Map();
                for (const r of records) {
                    cachedKeys.set(r.cacheKey, r.timestamp);
                }
            }
        } catch {
            // DB 查询失败不影响正常流程，仅跳过去重
        }
    }

    if (debug) {
        logger.info('collectImageSegments 开始:', {
            hasQuote: !!session.quote,
            quoteElementsCount: session.quote?.elements?.length || 0,
            quoteMessage: session.quote?.message ? 'exists' : 'none',
            quoteContent: session.quote?.content ? 'exists' : 'none',
            globalDedupeEnabled: config?.globalDedupeEnabled !== false,
            cachedRecordsLoaded: cachedKeys?.size || 0
        });
    }

    const append = (raw: { type?: string; attrs?: Record<string, unknown>; data?: Record<string, unknown> } | null, origin: string) => {
        if (!raw) return;

        let isImage = raw.type === 'image' || raw.type === 'img';

        if (!isImage && (raw.type === 'file' || raw.type === 'attachment')) {
            const a = raw.attrs || {};
            const d = raw.data || {};
            const mime = a.mime || a.mimetype || a.contentType || d.mime || d.mimetype || d.contentType;
            const name = a.name || a.filename || a.file || d.name || d.filename || d.file;
            const url = a.url || a.src || d.url || d.src;

            const checkExt = (s: unknown): boolean => typeof s === 'string' && /\.(png|jpe?g|webp|gif|bmp|tiff|heic|heif)(?:[?#].*)?$/i.test(s);
            if (typeof mime === 'string' && mime.toLowerCase().startsWith('image/')) {
                isImage = true;
            } else if (checkExt(name) || checkExt(url)) {
                isImage = true;
            }
        }

        if (!isImage) return;

        // 自动解析模式：仅处理文件类型图片（file/attachment），普通 image 元素需通过指令触发
        const isFileType = raw.type === 'file' || raw.type === 'attachment';
        if (fileTypeOnly && !isFileType) {
            if (debug && logger) {
                logger.info('自动解析：跳过非文件类型图片', { type: raw.type, origin });
            }
            return;
        }

        if (debug && logger) {
            const a = raw.attrs || {};
            const d = raw.data || {};
            const isFileType = raw.type === 'file' || raw.type === 'attachment';
            logger.info(`[图片类型区分] type=${raw.type} isFileType=${isFileType} origin=${origin}`, {
                rawType: raw.type,
                isFileType,
                attrsKeys: Object.keys(a),
                dataKeys: Object.keys(d),
                attrs: {
                    file: a.file, name: a.name, filename: a.filename,
                    url: a.url, src: a.src,
                    mime: a.mime, mimetype: a.mimetype, contentType: a.contentType,
                    size: a.size, id: a.id, fileId: a.fileId, busid: a.busid
                },
                data: {
                    file: d.file, name: d.name, filename: d.filename,
                    url: d.url, src: d.src,
                    mime: d.mime, mimetype: d.mimetype, contentType: d.contentType,
                    size: d.size, id: d.id, fileId: d.fileId, busid: d.busid
                }
            });
        }

        const key = makeImageSegmentKey({ attrs: raw.attrs, data: raw.data });

        // Local dedupe: within current message
        if (key && seenKeys.has(key)) {
            if (debug && logger) logger.info('去重：忽略重复图片元素（局部）', { origin, key });
            return;
        }

        // Global dedupe: across messages (e.g., quoted images)
        if (isGloballyDuplicate(key, cachedKeys, config?.globalDedupeTimeout ?? 600000)) {
            if (debug && logger) {
                const elapsed = Date.now() - (cachedKeys?.get(key!) ?? 0);
                logger.info('去重：忽略重复图片元素（全局）', {
                    origin,
                    key,
                    elapsedMs: elapsed,
                    currentChannel: session.channelId
                });
            }
            return;
        }

        if (key) seenKeys.add(key);

        segments.push({
            ...raw,
            type: 'image',
            attrs: raw.attrs || {},
            data: raw.data || {},
            _source: origin
        } as ImageSegment);
    };

    const traverse = (raw: unknown, origin: string) => {
        if (!raw) return;

        if (Array.isArray(raw)) {
            raw.forEach((child, idx) => traverse(child, `${origin}[${idx}]`));
            return;
        }

        if (raw && typeof raw === 'object') {
            if (Array.isArray((raw as { children?: unknown[] }).children)) {
                (raw as { children: unknown[] }).children.forEach((child, idx) => traverse(child, `${origin}.children[${idx}]`));
            }
        }

        append(raw as { type?: string; attrs?: Record<string, unknown>; data?: Record<string, unknown> }, origin);
    };

    session.elements?.forEach((el, index) => traverse(el, `session.elements[${index}]`));
    session.quote?.elements?.forEach((el, index) => traverse(el, `session.quote.elements[${index}]`));

    const quotedMessage = Array.isArray(session.quote?.message) ? session.quote.message : [];
    quotedMessage.forEach((el, index) => traverse(el, `session.quote.message[${index}]`));

    const quoteContent = session.quote?.content;
    if (typeof quoteContent === 'string') {
        const parsed = h.parse(quoteContent);
        const arr = Array.isArray(parsed) ? parsed : [parsed];
        arr.forEach((el, index) => traverse(el, `session.quote.content[${index}]`));
    }

    const eventMessage = Array.isArray(session.event?.message) ? session.event.message : [];
    eventMessage.forEach((seg, index) => {
        if (!seg) return;
        const attrs = (seg as { attrs?: Record<string, unknown>; data?: Record<string, unknown> }).attrs || (seg as { attrs?: Record<string, unknown>; data?: Record<string, unknown> }).data;
        traverse({ ...seg, attrs, data: (seg as { data?: Record<string, unknown> }).data }, `session.event.message[${index}]`);
    });

    await handleGroupFileEvent(session, traverse, config?.maxFileSize);
    await fetchQuotedMessage(session, traverse);

    return segments;
}

async function handleGroupFileEvent(
    session: Session,
    traverse: (raw: unknown, origin: string) => void,
    maxFileSize?: number
): Promise<void> {
    const fileEvent = session.event;
    if (!fileEvent?.file) return;

    const file = fileEvent.file;
    const maxSize = maxFileSize ?? (10 * 1024 * 1024);

    if (file.size && file.size > maxSize) return;

    const imageExts = ['.jpg', '.jpeg', '.png', '.webp', '.gif', '.bmp', '.tiff', '.heic', '.heif'];
    const fileExt = path.extname(file.name || '').toLowerCase();
    if (!imageExts.includes(fileExt)) return;

    const imageSegment = {
        type: 'image',
        attrs: {
            file: file.id || file.name,
            name: file.name,
            size: file.size,
            url: file.url || file.path,
            busid: file.busid
        },
        data: {
            file: file.id || file.name,
            name: file.name,
            size: file.size,
            url: file.url || file.path,
            busid: file.busid
        },
        _source: 'group_file_event'
    };

    traverse(imageSegment, 'group_file_event');
}

async function fetchQuotedMessage(
    session: Session,
    traverse: (raw: unknown, origin: string) => void
): Promise<void> {
    const quoteId = session.quote?.messageId || session.quote?.id;
    if (!quoteId) return;

    const bot = session.bot;
    if (!bot) return;

    await tryFetchFromBotGetMessage(bot, session, quoteId, traverse);
    await tryFetchFromOneBotInternal(bot, session, quoteId, traverse);
}

async function tryFetchFromBotGetMessage(
    bot: any,
    session: Session,
    quoteId: string,
    traverse: (raw: unknown, origin: string) => void
): Promise<void> {
    if (typeof bot.getMessage !== 'function') return;

    try {
        let quoted: { elements?: h[]; message?: unknown[]; content?: string } | null = null;

        try {
            quoted = await bot.getMessage(session.channelId || '', quoteId);
        } catch {
            if (bot.getMessageOne) {
                quoted = await bot.getMessageOne(quoteId);
            }
        }

        if (!quoted) return;

        const elems = Array.isArray(quoted.elements) ? quoted.elements : (Array.isArray(quoted.message) ? quoted.message : []);
        elems.forEach((el, index) => traverse(el, `bot.getMessage[${index}]`));

        if (typeof quoted.content === 'string') {
            const parsed = h.parse(quoted.content);
            const arr = Array.isArray(parsed) ? parsed : [parsed];
            arr.forEach((el, index) => traverse(el, `bot.getMessage.content[${index}]`));
        }
    } catch {
        // Ignore errors
    }
}

async function tryFetchFromOneBotInternal(
    bot: any,
    session: Session,
    quoteId: string,
    traverse: (raw: unknown, origin: string) => void
): Promise<void> {
    if (session.platform !== 'onebot' || !bot.internal) return;

    const internal = bot.internal;
    const methods = ['getMsg', 'get_msg'];

    for (const method of methods) {
        const fn = internal[method];
        if (typeof fn !== 'function') continue;

        try {
            const ret = await (fn as (id: string) => Promise<{ message?: unknown[]; data?: { message?: unknown[] } }>)(quoteId);
            const msg = ret?.message || ret?.data?.message;

            if (!Array.isArray(msg)) continue;

            processOneBotMessageSegments(msg, traverse);
            return;
        } catch {
            continue;
        }
    }
}

function processOneBotMessageSegments(
    msg: unknown[],
    traverse: (raw: unknown, origin: string) => void
): void {
    msg.forEach((seg, index) => {
        const segObj = seg as { type?: string; data?: Record<string, unknown> };

        if (segObj?.type === 'image' || segObj?.type === 'img') {
            processOneBotImageSegment(segObj, index, traverse);
        } else if (segObj?.type === 'file') {
            processOneBotFileSegment(segObj, index, traverse);
        }
    });
}

function processOneBotImageSegment(
    segObj: { type?: string; data?: Record<string, unknown> },
    index: number,
    traverse: (raw: unknown, origin: string) => void
): void {
    const d = segObj.data || {};
    const attrs = {
        url: d.url || d.file_url,
        file: d.file || d.filename,
        fileId: d.file || d.file_id || d.id,
        src: d.url || d.file || d.filename
    };
    traverse({ type: 'image', attrs, data: attrs }, `onebot.internal[${index}]`);
}

function processOneBotFileSegment(
    segObj: { type?: string; data?: Record<string, unknown> },
    index: number,
    traverse: (raw: unknown, origin: string) => void
): void {
    const d = segObj.data || {};
    const name = (d.name || d.file || '') as string;
    const fileExt = path.extname(name).toLowerCase();
    const imageExts = ['.jpg', '.jpeg', '.png', '.webp', '.gif', '.bmp', '.tiff', '.heic', '.heif'];

    if (!imageExts.includes(fileExt)) return;

    const attrs = {
        url: d.url || d.file_url,
        file: d.file || d.file_id || d.id,
        fileId: d.file || d.file_id || d.id,
        name: d.name,
        size: d.size || d.file_size,
        busid: d.busid,
        src: d.url || d.file
    };
    traverse({ type: 'file', attrs, data: attrs }, `onebot.internal.file[${index}]`);
}

/**
 * Format output for normal mode (non-forward)
 */
function formatNormalModeOutput(
    session: Session,
    messages: string[],
    imageSegments: ImageSegment[],
    config: Config
): string | (string | h)[] {
    if (!config.embedImageInNormalMode || imageSegments.length === 0) {
        return messages.join('\n\n===\n\n');
    }

    // Normal mode with embedded images
    const botAny = session.bot;
    const platform = session.platform || '';
    const supportsFile = botAny?.sendFile !== undefined || platform === 'onebot';
    const results: (string | h)[] = [];

    messages.forEach((msg, index) => {
        const imageSeg = imageSegments[index];
        const hasImage = imageSeg !== undefined && imageSeg.attrs?.url !== undefined;

        // Add image if available and supported
        if (hasImage && supportsFile) {
            const imageUrl = imageSeg.attrs?.url;
            // Add separator between images if not the first one
            if (results.length > 0) {
                results.push('\n\n===\n\n');
            }
            results.push(h.image(imageUrl as string));
            results.push('\n\n');
        }
        // Add the message content
        results.push(msg);
    });

    return results;
}

/**
 * Format output for forward mode (merged forward messages)
 */
function formatForwardModeOutput(
    session: Session,
    messages: string[],
    imageSegments: ImageSegment[],
    config: Config,
    withImage: boolean
): h[] {
    const selfId = session.bot?.selfId || session.selfId || 'bot';
    const displayName = session.bot?.user?.name || 'Bot';

    const nodes = messages.map((msg, index) => {
        const imageSeg = imageSegments[index];
        const hasImage = !!(imageSeg && (imageSeg.attrs?.url || imageSeg.attrs?.src || imageSeg.data?.url || imageSeg.data?.src));

        // If we have an image and withImage is enabled
        if (hasImage && withImage) {
            const imageContent = buildImageContent(imageSeg);
            return h('message', {}, [
                h('author', { id: selfId, name: displayName }),
                h('content', {}, [
                    imageContent,
                    msg
                ])
            ]);
        } else {
            // Fallback to text-only node
            return h('message', {}, [
                h('author', { id: selfId, name: displayName }),
                h('content', {}, msg)
            ]);
        }
    });

    return [h('message', { forward: true }, nodes)];
}

/**
 * Build image content element from segment, preferring buffer data
 */
function buildImageContent(imageSeg: ImageSegment): h {
    // Prefer buffer data if available (for OneBot compatibility)
    if (imageSeg.buffer && imageSeg.buffer.length > 0) {
        const base64 = imageSeg.buffer.toString('base64');
        const mime = detectImageMime(imageSeg.buffer) || 'image/png';
        return h.image(`data:${mime};base64,${base64}`);
    }

    // Fall back to URL
    const imageUrl = imageSeg.attrs?.url || imageSeg.attrs?.src || imageSeg.data?.url || imageSeg.data?.src;
    return h.image(imageUrl as string);
}

/**
 * Detect image MIME type from buffer magic bytes
 */
function detectImageMime(buffer: Buffer): string | null {
    if (buffer.length < 8) return null;

    // PNG: 89 50 4E 47 0D 0A 1A 0A
    if (buffer[0] === 0x89 && buffer[1] === 0x50 && buffer[2] === 0x4E && buffer[3] === 0x47) {
        return 'image/png';
    }

    // JPEG: FF D8 FF
    if (buffer[0] === 0xFF && buffer[1] === 0xD8 && buffer[2] === 0xFF) {
        return 'image/jpeg';
    }

    // WebP: RIFF....WEBP
    if (buffer[0] === 0x52 && buffer[1] === 0x49 && buffer[2] === 0x46 && buffer[3] === 0x46 &&
        buffer[8] === 0x57 && buffer[9] === 0x45 && buffer[10] === 0x42 && buffer[11] === 0x50) {
        return 'image/webp';
    }

    // GIF: GIF87a or GIF89a
    if (buffer[0] === 0x47 && buffer[1] === 0x49 && buffer[2] === 0x46) {
        return 'image/gif';
    }

    return null;
}

/**
 * Format output based on configuration
 */
function formatOutput(
    session: Session,
    messages: string[],
    imageSegments: ImageSegment[],
    config: Config,
    withImage: boolean = false
): string | (string | h)[] {
    if (!config.useForward) {
        return formatNormalModeOutput(session, messages, imageSegments, config);
    }
    return formatForwardModeOutput(session, messages, imageSegments, config, withImage);
}