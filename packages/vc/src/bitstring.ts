/**
 * W3C Bitstring Status List encoding. The bitstring is GZIP-compressed and
 * multibase base64url-no-pad encoded ("u" prefix). Bit order per spec: the
 * left-most (most significant) bit of the first byte is index 0. Minimum
 * list size is 131,072 entries (16KB) for herd privacy.
 */
import { gzipSync, gunzipSync } from "node:zlib";

export const MIN_BITSTRING_LENGTH = 131_072;

export class Bitstring {
  private readonly bytes: Uint8Array;
  readonly length: number;

  constructor(length: number = MIN_BITSTRING_LENGTH, bytes?: Uint8Array) {
    this.length = Math.max(length, MIN_BITSTRING_LENGTH);
    const byteLength = Math.ceil(this.length / 8);
    if (bytes) {
      if (bytes.length !== byteLength) {
        throw new Error("Bitstring byte length does not match bit length");
      }
      this.bytes = bytes;
    } else {
      this.bytes = new Uint8Array(byteLength);
    }
  }

  get(index: number): boolean {
    this.checkIndex(index);
    const byte = this.bytes[Math.floor(index / 8)]!;
    return ((byte >> (7 - (index % 8))) & 1) === 1;
  }

  set(index: number, value: boolean): void {
    this.checkIndex(index);
    const byteIndex = Math.floor(index / 8);
    const mask = 1 << (7 - (index % 8));
    if (value) this.bytes[byteIndex]! |= mask;
    else this.bytes[byteIndex]! &= ~mask;
  }

  /** multibase base64url-no-pad of the GZIP-compressed bitstring. */
  encode(): string {
    return `u${Buffer.from(gzipSync(this.bytes)).toString("base64url")}`;
  }

  static decode(encodedList: string): Bitstring {
    if (!encodedList.startsWith("u")) {
      throw new Error("encodedList must be multibase base64url (\"u\" prefix)");
    }
    const bytes = new Uint8Array(
      gunzipSync(Buffer.from(encodedList.slice(1), "base64url")),
    );
    return new Bitstring(bytes.length * 8, bytes);
  }

  private checkIndex(index: number): void {
    if (!Number.isInteger(index) || index < 0 || index >= this.length) {
      throw new Error(`Bitstring index out of range: ${index}`);
    }
  }
}
