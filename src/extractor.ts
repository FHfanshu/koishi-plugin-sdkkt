/**
 * Main metadata extractor
 * Combines all format-specific parsers
 */

import { Buffer } from 'buffer';
import { detectImageFormat } from './utils';
import { parsePNGMetadata } from './png';
import { parseJPEGMetadata } from './jpeg';
import { parseWebPMetadata } from './webp';
import { SDMetadata } from './a1111';

export interface MetadataResult {
    success: boolean;
    data?: SDMetadata;
    error?: string;
}

interface Logger {
    info: (msg: string, ...args: unknown[]) => void;
}

/**
 * Extract SD metadata from buffer
 */
export function extractMetadata(buffer: Buffer, logger?: Logger): MetadataResult {
    try {
        if (!buffer || buffer.length === 0) {
            return { success: false, error: 'Empty buffer' };
        }

        const format = detectImageFormat(buffer);
        if (!format) {
            return { success: false, error: 'Unsupported image format' };
        }

        let result: MetadataResult;

        switch (format) {
            case 'png':
                result = parsePNGMetadata(buffer, logger);
                break;
            case 'jpeg':
                result = parseJPEGMetadata(buffer, logger);
                break;
            case 'webp':
                result = parseWebPMetadata(buffer, logger);
                break;
            default:
                result = { success: false, error: `Unsupported format: ${format}` };
        }

        return result;
    } catch (error) {
        return {
            success: false,
            error: (error as Error).message
        };
    }
}

/**
 * Extract SD metadata from multiple sources
 */
export async function extractMetadataFromSource(source: Buffer | ArrayBuffer | string): Promise<MetadataResult> {
    try {
        let buffer: Buffer;

        if (Buffer.isBuffer(source)) {
            buffer = source;
        } else if (source instanceof ArrayBuffer) {
            buffer = Buffer.from(new Uint8Array(source));
        } else if (typeof source === 'string') {
            // String sources are not supported directly here
            // (should be fetched first via fetcher module)
            return {
                success: false,
                error: 'String source not supported, fetch first'
            };
        } else {
            return {
                success: false,
                error: 'Invalid source type'
            };
        }

        return extractMetadata(buffer);
    } catch (error) {
        return {
            success: false,
            error: (error as Error).message
        };
    }
}

/**
 * Test if metadata exists without parsing everything
 */
export function hasMetadata(buffer: Buffer): boolean {
    const format = detectImageFormat(buffer);
    if (!format) return false;

    // For PNG, check for text chunks or Stealth PNG
    if (format === 'png') {
        // This is a simplified check - could be enhanced
        return true;
    }

    // For JPEG/WebP, assume EXIF might contain data
    return true;
}

/**
 * Format metadata result to readable format
 */
export function formatMetadataResult(metadata: SDMetadata): string {
    const parts: string[] = [];

    // NovelAI format
    if (metadata.naiBasePrompt || (metadata.naiCharPrompts && metadata.naiCharPrompts.length)) {
        if (metadata.naiBasePrompt) {
            parts.push(`Base Prompt:\n${metadata.naiBasePrompt}`);
        }
        if (metadata.naiCharPrompts && metadata.naiCharPrompts.length) {
            parts.push(`Character Prompt:\n${metadata.naiCharPrompts.join('\n')}`);
        }
    } else if (metadata.prompt) {
        parts.push(`正向提示词:\n${metadata.prompt}`);
    }

    if (metadata.naiNegBasePrompt || (metadata.naiNegCharPrompts && metadata.naiNegCharPrompts.length)) {
        if (metadata.naiNegBasePrompt) {
            parts.push(`\nNegative Base Prompt:\n${metadata.naiNegBasePrompt}`);
        }
        if (metadata.naiNegCharPrompts && metadata.naiNegCharPrompts.length) {
            parts.push(`\nNegative Character Prompt:\n${metadata.naiNegCharPrompts.join('\n')}`);
        }
    } else if (metadata.negativePrompt) {
        parts.push(`\n负向提示词:\n${metadata.negativePrompt}`);
    }

    const params: string[] = [];
    if (metadata.steps) params.push(`Steps: ${metadata.steps}`);
    if (metadata.sampler) params.push(`Sampler: ${metadata.sampler}`);
    if (metadata.cfgScale) params.push(`CFG Scale: ${metadata.cfgScale}`);
    if (metadata.seed) params.push(`Seed: ${metadata.seed}`);
    if (metadata.size) params.push(`Size: ${metadata.size}`);
    if (metadata.model) params.push(`Model: ${metadata.model}`);

    if (params.length > 0) {
        parts.push(`\n参数:\n${params.join('\n')}`);
    }

    if (typeof metadata.naiVibe === 'boolean') {
        parts.push(`\nVibe: ${metadata.naiVibe ? '开启' : '关闭'}`);
    }

    if (metadata.naiCharRefs && metadata.naiCharRefs.length) {
        parts.push(`\nCharacter References:\n${metadata.naiCharRefs.join('\n')}`);
    }

    if (metadata.parameters && !parts.some(p => p.includes(metadata.parameters!))) {
        parts.push(`\n完整参数:\n${metadata.parameters}`);
    }

    // EXIF fallback - show when no SD metadata is found
    if (metadata.exifFallback && Object.keys(metadata.exifFallback).length > 0) {
        parts.push(`\nEXIF 信息:
该图片不包含标准的 Stable Diffusion 元数据，但包含以下 EXIF 字段：`);

        const fallbackParts: string[] = [];

        // Process EXIF fields
        for (const [fieldName, fieldData] of Object.entries(metadata.exifFallback)) {
            if (fieldName === 'XMP') {
                fallbackParts.push(`\nXMP 数据:
${JSON.stringify(fieldData, null, 2)}`);
            } else if (fieldName === 'IPTC') {
                fallbackParts.push(`\nIPTC 数据:
${JSON.stringify(fieldData, null, 2)}`);
            } else {
                // Regular EXIF field
                const field = fieldData as { description?: string; value?: unknown; text?: string };
                const value = field?.description || field?.value || field?.text || JSON.stringify(field);
                if (value && value !== 'undefined') {
                    fallbackParts.push(`  ${fieldName}: ${value}`);
                }
            }
        }

        if (fallbackParts.length > 0) {
            parts.push(fallbackParts.join('\n'));
        } else {
            parts.push(JSON.stringify(metadata.exifFallback, null, 2));
        }
    }

    return parts.join('\n');
}

export default {
    extractMetadata,
    extractMetadataFromSource,
    hasMetadata,
    formatMetadataResult
};