/**
 * Stealth PNG decoder
 * Extracts metadata hidden in PNG alpha channel using LSB steganography
 * Based on the stealth_pngcomp format
 */

import { Buffer } from 'buffer'
import { PNG } from 'pngjs'
import { gunzipSync } from 'zlib'
import { SDMetadata, BitReader } from './types'

/**
 * Extract Stealth PNG metadata from PNG object
 */
export function extractStealthPngMetadata(png: PNG): SDMetadata | null {
  try {
    const { width, height, data: pngData } = png

    if (!pngData || pngData.length === 0) {
      return null
    }

    // Check if enough data for magic number
    const minBitsRequired = 15 * 8 // magic: "stealth_pngcomp" = 15 chars
    const totalAlphaBits = width * height
    if (totalAlphaBits < minBitsRequired) {
      return null
    }

    // Extract all alpha channel LSBs
    const lowestBits: number[] = new Array(totalAlphaBits)
    let bitIdx = 0

    for (let y = 0; y < height; y++) {
      const rowOffset = y * width * 4
      for (let x = 0; x < width; x++) {
        const alpha = pngData[rowOffset + (x * 4) + 3]
        lowestBits[bitIdx++] = alpha & 1 // Extract LSB
      }
    }

    // Read magic number
    const magic = 'stealth_pngcomp'
    const reader = new BitReader(lowestBits)
    const magicBytes = reader.readNBytes(magic.length)

    // Convert to string
    const magicString = String.fromCharCode(...magicBytes)

    if (magicString !== magic) {
      return null
    }

    // Read data length (32-bit integer)
    const dataLength = reader.readInt32()

    // Validate data length
    if (dataLength <= 0 || dataLength > totalAlphaBits - (magic.length * 8) - 32) {
      return null
    }

    // Read compressed data
    const gzipDataBytes = reader.readNBytes(dataLength / 8)
    const gzipBuffer = Buffer.from(gzipDataBytes)

    // Decompress
    const decompressed = gunzipSync(gzipBuffer)
    const jsonString = decompressed.toString('utf-8')

    // Parse JSON
    const jsonData = JSON.parse(jsonString)

    // Convert to SDMetadata format
    const metadata: SDMetadata = {}

    if (jsonData.prompt) metadata.prompt = jsonData.prompt
    if (jsonData.negative_prompt) metadata.negativePrompt = jsonData.negative_prompt
    if (jsonData.steps) metadata.steps = String(jsonData.steps)
    if (jsonData.sampler) metadata.sampler = jsonData.sampler
    if (jsonData.cfg_scale) metadata.cfgScale = String(jsonData.cfg_scale)
    if (jsonData.seed) metadata.seed = String(jsonData.seed)
    if (jsonData.size) metadata.size = jsonData.size
    if (jsonData.model) metadata.model = jsonData.model
    if (jsonData.parameters) metadata.parameters = jsonData.parameters

    return metadata

  } catch (error) {
    return null
  }
}

/**
 * Check if a PNG contains Stealth metadata
 */
export function hasStealthMetadata(png: PNG): boolean {
  try {
    const metadata = extractStealthPngMetadata(png)
    return metadata !== null
  } catch {
    return false
  }
}

/**
 * Get Stealth metadata size (in bits)
 */
export function getStealthMetadataSize(png: PNG): number | null {
  try {
    const { width, height, data: pngData } = png

    if (!pngData || pngData.length === 0) {
      return null
    }

    const lowestBits: number[] = []

    for (let y = 0; y < height; y++) {
      const rowOffset = y * width * 4
      for (let x = 0; x < width; x++) {
        const alpha = pngData[rowOffset + (x * 4) + 3]
        lowestBits.push(alpha & 1)
      }
    }

    const reader = new BitReader(lowestBits)
    const magicBytes = reader.readNBytes(15) // "stealth_pngcomp"
    const magicString = String.fromCharCode(...magicBytes)

    if (magicString !== 'stealth_pngcomp') {
      return null
    }

    return reader.readInt32() // Data length in bits

  } catch {
    return null
  }
}

export default {
  extractStealthPngMetadata,
  hasStealthMetadata,
  getStealthMetadataSize
}
