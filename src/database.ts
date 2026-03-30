import { Context } from 'koishi';

declare module 'koishi' {
    interface Tables {
        sdkkt_image_cache: SdCacheRecord;
    }
}

export interface SdCacheRecord {
    id?: number;
    cacheKey: string;
    pHash: string;
    timestamp: number;
    channelId: string;
    userId: string;
}

export function extendDatabase(ctx: Context): void {
    ctx.model.extend('sdkkt_image_cache', {
        id: 'unsigned',
        cacheKey: 'string',
        pHash: 'string',
        timestamp: 'integer',
        channelId: 'string',
        userId: 'string'
    }, {
        primary: 'id',
        autoInc: true
    });
}

/**
 * 按 cacheKey 精确查找缓存记录（在超时窗口内）
 */
export async function findByCacheKey(
    ctx: Context,
    cacheKey: string,
    timeoutMs: number
): Promise<SdCacheRecord | null> {
    const cutoff = Date.now() - timeoutMs;
    const records = await ctx.database.get('sdkkt_image_cache', {
        cacheKey,
        timestamp: { $gt: cutoff }
    });
    return records[0] || null;
}

/**
 * 按 pHash 汉明距离查找匹配记录（在超时窗口内）
 * 返回匹配的记录，或 null
 * 需要调用方传入 compareHashes 函数以避免循环依赖
 */
export async function findByPHash(
    ctx: Context,
    pHash: string,
    channelId: string,
    timeoutMs: number,
    threshold: number,
    compareFn: (h1: string, h2: string) => number
): Promise<SdCacheRecord | null> {
    if (!pHash) return null;

    const cutoff = Date.now() - timeoutMs;
    const records = await ctx.database.get('sdkkt_image_cache', {
        channelId,
        timestamp: { $gt: cutoff }
    });

    for (const record of records) {
        if (!record.pHash) continue;
        try {
            const distance = compareFn(pHash, record.pHash);
            if (distance <= threshold) {
                return record;
            }
        } catch {
            // 哈希格式不匹配，跳过
            continue;
        }
    }

    return null;
}

/**
 * 写入缓存记录
 */
export async function saveCache(ctx: Context, record: SdCacheRecord): Promise<void> {
    await ctx.database.create('sdkkt_image_cache', record);
}

/**
 * 删除指定 cacheKey 的记录
 */
export async function removeByCacheKey(ctx: Context, cacheKey: string): Promise<void> {
    await ctx.database.remove('sdkkt_image_cache', { cacheKey });
}

/**
 * 清理过期记录
 */
export async function cleanupExpired(ctx: Context, retentionMs: number): Promise<void> {
    const cutoff = Date.now() - retentionMs;
    await ctx.database.remove('sdkkt_image_cache', {
        timestamp: { $lt: cutoff }
    });
}
