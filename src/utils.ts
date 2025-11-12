/**
 * Utility functions for SD metadata parsing
 * Common utilities used across different format parsers
 */

import { promises as fs } from 'fs'
import path from 'path'

/**
 * Decode data URI to buffer
 */
export function decodeDataUri(value: string): Buffer | null {
  if (typeof value !== 'string') return null
  if (!value.startsWith('data:')) return null
  const commaIndex = value.indexOf(',')
  if (commaIndex === -1) return null
  const meta = value.slice(0, commaIndex)
  const data = value.slice(commaIndex + 1).trim()
  if (!data) return null
  if (meta.includes(';base64')) {
    return bufferFromBase64(data)
  }
  try {
    return Buffer.from(decodeURIComponent(data), 'utf8')
  } catch {
    return null
  }
}

/**
 * Convert base64 string to buffer
 */
export function bufferFromBase64(value: string): Buffer | null {
  if (typeof value !== 'string') return null
  const sanitized = value.replace(/\s+/g, '')
  if (!sanitized) return null
  if (sanitized.length % 4 === 1) return null
  if (!/^[0-9a-zA-Z+/=_-]+$/.test(sanitized)) {
    return null
  }
  try {
    return Buffer.from(sanitized, 'base64')
  } catch {
    return null
  }
}

/**
 * Detect image format from buffer
 */
export function detectImageFormat(buffer: Buffer): 'png' | 'webp' | 'jpeg' | null {
  if (buffer.length < 12) return null

  // PNG: 89 50 4E 47
  if (buffer[0] === 0x89 && buffer[1] === 0x50 && buffer[2] === 0x4E && buffer[3] === 0x47) {
    return 'png'
  }

  // JPEG: FF D8 FF
  if (buffer[0] === 0xFF && buffer[1] === 0xD8 && buffer[2] === 0xFF) {
    return 'jpeg'
  }

  // WebP: RIFF ... WEBP
  if (buffer[0] === 0x52 && buffer[1] === 0x49 && buffer[2] === 0x46 && buffer[3] === 0x46 &&
      buffer[8] === 0x57 && buffer[9] === 0x45 && buffer[10] === 0x42 && buffer[11] === 0x50) {
    return 'webp'
  }

  return null
}

/**
 * Normalize local file path
 */
export function normalizeLocalPath(target: string): string | null {
  if (typeof target !== 'string') return null
  const trimmed = target.trim()
  if (!trimmed) return null
  if (trimmed.startsWith('file://')) {
    return path.normalize(trimmed.replace(/^file:\/\//i, ''))
  }
  if (path.isAbsolute(trimmed)) return path.normalize(trimmed)
  if (/^[a-zA-Z]:[\\/]/.test(trimmed)) return path.normalize(trimmed)
  if (trimmed.startsWith('./') || trimmed.startsWith('../')) return path.normalize(trimmed)
  if (trimmed.startsWith('/') || trimmed.startsWith('\\')) return path.normalize(trimmed)
  return null
}

/**
 * Try to read local file as buffer
 */
export async function tryReadLocalFileBuffer(target: string): Promise<Buffer | null> {
  const normalized = normalizeLocalPath(target)
  if (!normalized) return null
  try {
    const filePath = path.isAbsolute(normalized) ? normalized : path.join(process.cwd(), normalized)
    return await fs.readFile(filePath)
  } catch {
    return null
  }
}

/**
 * Guess file extension from various attributes
 */
export function guessFileExtension(attrs: Record<string, any>, sourceHint?: string): string {
  const candidates = [
    attrs?.file,
    attrs?.filename,
    attrs?.name,
    attrs?.image,
    attrs?.path,
    attrs?.localPath,
    attrs?.src,
    attrs?.url,
    sourceHint
  ]
  for (const candidate of candidates) {
    if (typeof candidate !== 'string') continue
    const sanitized = candidate.split('?')[0].split('#')[0]
    const ext = path.extname(sanitized)
    if (ext) return ext
  }
  return '.img'
}

/**
 * Check if a value is a valid URL
 */
export function isValidUrl(value: string): boolean {
  try {
    // Check for http/https URLs
    if (/^https?:\/\//i.test(value)) {
      return true
    }
    return false
  } catch {
    return false
  }
}

/**
 * Normalize URL for deduplication (sort query params)
 */
export function normalizeUrl(url?: string): string {
  if (!url || typeof url !== 'string') return ''
  try {
    const urlObj = new URL(url)
    // Sort query parameters for deduplication
    const params = [...urlObj.searchParams.entries()]
      .filter(([_, v]) => v !== undefined && v !== null)
      .sort((a, b) => a[0].localeCompare(b[0]))
    urlObj.search = params.map(([k, v]) => `${k}=${v}`).join('&')
    return urlObj.toString()
  } catch {
    return url
  }
}

/**
 * Create a unique key for an image segment
 */
export function makeImageSegmentKey(segment: { attrs?: Record<string, any>, data?: Record<string, any> }): string {
  const a = segment.attrs || {}
  const d = segment.data || {}

  // Try id fields first
  const id = a.file || a.image || a.fileId || a.file_id || a.id || d.file || d.image || d.fileId || d.file_id || d.id
  if (id) return String(id)

  // Try URL
  const url = normalizeUrl(a.src || a.url || d.src || d.url)
  if (url) return url

  // Try file info
  const file = a.file || d.file
  const size = a.fileSize || a.size || d.fileSize || d.size
  if (file || size) return `file:${file || ''}#${size || ''}`

  return ''
}

/**
 * Simple LRU cache implementation
 */
export class LRUCache<K, V> {
  private cache = new Map<K, V>()
  private readonly maxSize: number

  constructor(maxSize: number = 100) {
    this.maxSize = maxSize
  }

  get(key: K): V | undefined {
    const item = this.cache.get(key)
    if (item) {
      // Refresh key
      this.cache.delete(key)
      this.cache.set(key, item)
    }
    return item
  }

  set(key: K, value: V): void {
    if (this.cache.has(key)) {
      this.cache.delete(key)
    } else if (this.cache.size >= this.maxSize) {
      // Remove oldest item
      const firstKey = this.cache.keys().next().value
      if (firstKey !== undefined) {
        this.cache.delete(firstKey)
      }
    }
    this.cache.set(key, value)
  }

  has(key: K): boolean {
    return this.cache.has(key)
  }

  clear(): void {
    this.cache.clear()
  }

  get size(): number {
    return this.cache.size
  }
}

/**
 * Validation helpers
 */
export class Validation {
  static isString(value: any): value is string {
    return typeof value === 'string'
  }

  static isNumber(value: any): value is number {
    return typeof value === 'number' && !isNaN(value)
  }

  static isObject(value: any): value is Record<string, any> {
    return value !== null && typeof value === 'object' && !Array.isArray(value)
  }

  static isBuffer(value: any): value is Buffer {
    return Buffer.isBuffer(value)
  }

  static isNonEmptyString(value: any): value is string {
    return typeof value === 'string' && value.trim().length > 0
  }
}

/**
 * Parse metadata value safely
 */
export function parseMetadataValue<T>(value: any, parser: (v: any) => T | null): T | undefined {
  if (value === undefined || value === null) return undefined
  const result = parser(value)
  return result === null ? undefined : result
}

/**
 * Get nested object value safely
 */
export function getNestedValue(obj: any, path: string): any {
  const keys = path.split('.')
  let current = obj
  for (const key of keys) {
    if (current && typeof current === 'object' && key in current) {
      current = current[key]
    } else {
      return undefined
    }
  }
  return current
}

// Re-export types
export type { ImageSegment } from './types'
