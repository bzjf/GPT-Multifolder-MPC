import { open } from "node:fs/promises";

export type BoundedReadResult = {
  buffer: Buffer;
  truncated: boolean;
};

export type FileWindowReadResult = {
  buffer: Buffer;
  requested_byte_start: number;
  byte_start: number;
  byte_end: number;
  file_size_bytes: number;
  has_more: boolean;
};

export async function readFilePrefix(absolutePath: string, maxBytes: number): Promise<BoundedReadResult> {
  const handle = await open(absolutePath, "r");
  try {
    const buffer = Buffer.alloc(maxBytes + 1);
    const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
    return {
      buffer: buffer.subarray(0, Math.min(bytesRead, maxBytes)),
      truncated: bytesRead > maxBytes
    };
  } finally {
    await handle.close();
  }
}

export async function readFileWindow(
  absolutePath: string,
  byteOffset: number,
  maxBytes: number
): Promise<FileWindowReadResult> {
  const handle = await open(absolutePath, "r");
  try {
    const stat = await handle.stat();
    const requestedStart = Math.min(Math.max(0, byteOffset), stat.size);
    const probeLength = Math.min(maxBytes + 4, stat.size - requestedStart);
    const probe = Buffer.alloc(Math.max(0, probeLength));
    const { bytesRead } = probeLength > 0
      ? await handle.read(probe, 0, probeLength, requestedStart)
      : { bytesRead: 0 };
    const available = probe.subarray(0, bytesRead);

    let leadingContinuationBytes = 0;
    while (
      leadingContinuationBytes < Math.min(3, available.length)
      && isUtf8ContinuationByte(available[leadingContinuationBytes])
    ) {
      leadingContinuationBytes += 1;
    }

    const byteStart = requestedStart + leadingContinuationBytes;
    const aligned = available.subarray(leadingContinuationBytes);
    let returnedLength = Math.min(maxBytes, aligned.length);

    while (
      returnedLength > 0
      && returnedLength < aligned.length
      && isUtf8ContinuationByte(aligned[returnedLength])
    ) {
      returnedLength -= 1;
    }

    const buffer = aligned.subarray(0, returnedLength);
    const byteEnd = byteStart + buffer.length;
    return {
      buffer,
      requested_byte_start: requestedStart,
      byte_start: byteStart,
      byte_end: byteEnd,
      file_size_bytes: stat.size,
      has_more: byteEnd < stat.size
    };
  } finally {
    await handle.close();
  }
}

function isUtf8ContinuationByte(value: number | undefined): boolean {
  return value !== undefined && (value & 0xc0) === 0x80;
}
