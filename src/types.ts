/**
 * Type definitions for SD metadata parsing
 * Based on stable-diffusion-inspector reference implementation
 */

/**
 * Bit reader for Stealth PNG LSB extraction
 */
export class BitReader {
    private data: Uint8Array;
    private index: number = 0;

    constructor(data: Uint8Array | number[]) {
        this.data = data instanceof Uint8Array ? data : new Uint8Array(data);
    }

    readBit(): number {
        if (this.index >= this.data.length) {
            throw new Error('BitReader: read beyond bounds');
        }
        return this.data[this.index++];
    }

    readNBits(n: number): number[] {
        const bits: number[] = [];
        for (let i = 0; i < n; i++) {
            bits.push(this.readBit());
        }
        return bits;
    }

    readByte(): number {
        let byte = 0;
        for (let i = 0; i < 8; i++) {
            byte |= this.readBit() << (7 - i);
        }
        return byte;
    }

    readNBytes(n: number): Uint8Array {
        const bytes = new Uint8Array(n);
        for (let i = 0; i < n; i++) {
            bytes[i] = this.readByte();
        }
        return bytes;
    }

    readInt32(): number {
        const bytes = this.readNBytes(4);
        const buffer = Buffer.from(bytes);
        return buffer.readInt32BE(0);
    }
}