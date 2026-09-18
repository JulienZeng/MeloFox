import { createDecipheriv } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';

interface Box {
  type: string;
  start: number;
  size: number;
  headerSize: number;
  contentStart: number;
  end: number;
}

interface StscEntry {
  firstChunk: number;
  samplesPerChunk: number;
}

interface TrackSamples {
  kind: 'audio' | 'video';
  chunkOffsets: number[];
  sampleSizes: number[];
  stsc: StscEntry[];
  nalLengthSize?: number;
  videoCodec?: 'avc' | 'hevc';
}

export async function decryptDouyinSampleAesMp4(inputPath: string, outputPath: string, keyHex: string): Promise<boolean> {
  const key = Buffer.from(keyHex, 'hex');
  if (key.length !== 16) {
    return false;
  }

  const data = Buffer.from(await readFile(inputPath));
  const topBoxes = parseBoxes(data, 0, data.length);
  if (!topBoxes.some(box => box.type === 'ftyp') || !topBoxes.some(box => box.type === 'mdat')) {
    return false;
  }

  const tracks = collectTracks(data, topBoxes);
  if (!tracks.length) {
    return false;
  }

  for (const track of tracks) {
    decryptTrackSamples(data, track, key);
  }

  await writeFile(outputPath, data);
  return true;
}

function collectTracks(data: Buffer, topBoxes: Box[]): TrackSamples[] {
  const moov = topBoxes.find(box => box.type === 'moov');
  if (!moov) {
    return [];
  }

  return parseBoxes(data, moov.contentStart, moov.end)
    .filter(box => box.type === 'trak')
    .map(trak => collectTrack(data, trak))
    .filter((track): track is TrackSamples => Boolean(track));
}

function collectTrack(data: Buffer, trak: Box): TrackSamples | undefined {
  const mdia = findChild(data, trak, 'mdia');
  const minf = mdia ? findChild(data, mdia, 'minf') : undefined;
  const stbl = minf ? findChild(data, minf, 'stbl') : undefined;
  const hdlr = mdia ? findChild(data, mdia, 'hdlr') : undefined;
  if (!mdia || !stbl || !hdlr) {
    return undefined;
  }

  const handler = readAscii(data, hdlr.contentStart + 8, hdlr.contentStart + 12);
  const kind = handler === 'vide' ? 'video' : handler === 'soun' ? 'audio' : undefined;
  if (!kind) {
    return undefined;
  }

  const stsz = findChild(data, stbl, 'stsz');
  const stsc = findChild(data, stbl, 'stsc');
  const stco = findChild(data, stbl, 'stco') ?? findChild(data, stbl, 'co64');
  const stsd = findChild(data, stbl, 'stsd');
  if (!stsz || !stsc || !stco || !stsd) {
    return undefined;
  }

  const sampleSizes = parseSampleSizes(data, stsz);
  const chunkOffsets = parseChunkOffsets(data, stco);
  const stscEntries = parseStsc(data, stsc);
  if (!sampleSizes.length || !chunkOffsets.length || !stscEntries.length) {
    return undefined;
  }

  return {
    kind,
    chunkOffsets,
    sampleSizes,
    stsc: stscEntries,
    ...(kind === 'video' ? parseVideoSampleEntry(data, stsd) : {})
  };
}

function decryptTrackSamples(data: Buffer, track: TrackSamples, key: Buffer): void {
  let sampleIndex = 0;
  for (let chunkIndex = 1; chunkIndex <= track.chunkOffsets.length; chunkIndex += 1) {
    const entry = stscEntryForChunk(track.stsc, chunkIndex);
    let offset = track.chunkOffsets[chunkIndex - 1];
    for (let sampleInChunk = 0; sampleInChunk < entry.samplesPerChunk && sampleIndex < track.sampleSizes.length; sampleInChunk += 1) {
      const size = track.sampleSizes[sampleIndex];
      if (offset >= 0 && size > 0 && offset + size <= data.length) {
        if (track.kind === 'video') {
          decryptVideoSample(data, offset, size, track.nalLengthSize ?? 4, track.videoCodec, key);
        } else {
          decryptAudioSample(data, offset, size, key);
        }
      }
      offset += size;
      sampleIndex += 1;
    }
  }
}

function decryptVideoSample(
  data: Buffer,
  offset: number,
  size: number,
  nalLengthSize: number,
  codec: 'avc' | 'hevc' | undefined,
  key: Buffer
): void {
  const end = offset + size;
  let cursor = offset;
  while (cursor + nalLengthSize <= end) {
    const nalSize = readUInt(data, cursor, nalLengthSize);
    const nalStart = cursor + nalLengthSize;
    const nalEnd = nalStart + nalSize;
    if (nalSize <= 0 || nalEnd > end) {
      return;
    }

    if (shouldDecryptVideoNal(data, nalStart, nalSize, codec)) {
      decryptVideoNal(data, nalStart, nalSize, key);
    }
    cursor = nalEnd;
  }
}

function shouldDecryptVideoNal(data: Buffer, offset: number, size: number, codec: 'avc' | 'hevc' | undefined): boolean {
  if (size < 48) {
    return false;
  }

  if (codec === 'avc') {
    const nalType = data[offset] & 0x1f;
    return nalType === 1 || nalType === 5;
  }

  if (codec === 'hevc') {
    const nalType = (data[offset] >> 1) & 0x3f;
    return (
      (nalType >= 0 && nalType <= 9) ||
      (nalType >= 16 && nalType <= 21)
    );
  }

  return true;
}

function decryptVideoNal(data: Buffer, offset: number, size: number, key: Buffer): void {
  if (size < 48) {
    return;
  }

  const encryptedStart = offset + 32;
  const encryptedLength = size - 32;
  let remainder = encryptedLength % 16;
  if (remainder === 0) {
    remainder = 16;
  }
  const decryptLength = encryptedLength - remainder;
  let iv = Buffer.alloc(16);

  for (let relative = 0; relative < decryptLength; relative += 160) {
    const blockOffset = encryptedStart + relative;
    if (blockOffset + 16 > encryptedStart + decryptLength) {
      break;
    }

    const encryptedBlock = Buffer.from(data.subarray(blockOffset, blockOffset + 16));
    const decrypted = aesCbcDecrypt(encryptedBlock, key, iv);
    decrypted.copy(data, blockOffset);
    iv = encryptedBlock;
  }
}

function decryptAudioSample(data: Buffer, offset: number, size: number, key: Buffer): void {
  if (size < 32) {
    return;
  }

  const encryptedStart = offset + 16;
  const encryptedLength = size - 16;
  const decryptLength = encryptedLength - (encryptedLength % 16);
  if (decryptLength <= 0) {
    return;
  }

  const decrypted = aesCbcDecrypt(data.subarray(encryptedStart, encryptedStart + decryptLength), key, Buffer.alloc(16));
  decrypted.copy(data, encryptedStart);
}

function aesCbcDecrypt(input: Uint8Array, key: Buffer, iv: Buffer): Buffer {
  const decipher = createDecipheriv('aes-128-cbc', key, iv);
  decipher.setAutoPadding(false);
  return Buffer.concat([decipher.update(input), decipher.final()]);
}

function stscEntryForChunk(entries: StscEntry[], chunkIndex: number): StscEntry {
  let current = entries[0];
  for (const entry of entries) {
    if (entry.firstChunk > chunkIndex) {
      break;
    }
    current = entry;
  }
  return current;
}

function parseBoxes(data: Buffer, start: number, end: number): Box[] {
  const boxes: Box[] = [];
  let cursor = start;
  while (cursor + 8 <= end) {
    const size32 = data.readUInt32BE(cursor);
    const type = readAscii(data, cursor + 4, cursor + 8);
    let size = size32;
    let headerSize = 8;
    if (size32 === 1) {
      if (cursor + 16 > end) {
        break;
      }
      size = Number(data.readBigUInt64BE(cursor + 8));
      headerSize = 16;
    } else if (size32 === 0) {
      size = end - cursor;
    }

    if (!size || cursor + size > end) {
      break;
    }

    boxes.push({
      type,
      start: cursor,
      size,
      headerSize,
      contentStart: cursor + headerSize,
      end: cursor + size
    });
    cursor += size;
  }

  return boxes;
}

function findChild(data: Buffer, parent: Box, type: string): Box | undefined {
  return parseBoxes(data, parent.contentStart, parent.end).find(box => box.type === type);
}

function parseSampleSizes(data: Buffer, stsz: Box): number[] {
  const sampleSize = data.readUInt32BE(stsz.contentStart + 4);
  const sampleCount = data.readUInt32BE(stsz.contentStart + 8);
  if (sampleSize > 0) {
    return Array.from({ length: sampleCount }, () => sampleSize);
  }

  const sizes: number[] = [];
  let cursor = stsz.contentStart + 12;
  for (let index = 0; index < sampleCount && cursor + 4 <= stsz.end; index += 1) {
    sizes.push(data.readUInt32BE(cursor));
    cursor += 4;
  }
  return sizes;
}

function parseStsc(data: Buffer, stsc: Box): StscEntry[] {
  const entryCount = data.readUInt32BE(stsc.contentStart + 4);
  const entries: StscEntry[] = [];
  let cursor = stsc.contentStart + 8;
  for (let index = 0; index < entryCount && cursor + 12 <= stsc.end; index += 1) {
    entries.push({
      firstChunk: data.readUInt32BE(cursor),
      samplesPerChunk: data.readUInt32BE(cursor + 4)
    });
    cursor += 12;
  }
  return entries;
}

function parseChunkOffsets(data: Buffer, stco: Box): number[] {
  const entryCount = data.readUInt32BE(stco.contentStart + 4);
  const offsets: number[] = [];
  let cursor = stco.contentStart + 8;
  const bytesPerOffset = stco.type === 'co64' ? 8 : 4;
  for (let index = 0; index < entryCount && cursor + bytesPerOffset <= stco.end; index += 1) {
    offsets.push(bytesPerOffset === 8 ? Number(data.readBigUInt64BE(cursor)) : data.readUInt32BE(cursor));
    cursor += bytesPerOffset;
  }
  return offsets;
}

function parseVideoSampleEntry(data: Buffer, stsd: Box): { nalLengthSize?: number; videoCodec?: 'avc' | 'hevc' } {
  const entryCount = data.readUInt32BE(stsd.contentStart + 4);
  let cursor = stsd.contentStart + 8;
  for (let index = 0; index < entryCount && cursor + 8 <= stsd.end; index += 1) {
    const size = data.readUInt32BE(cursor);
    const type = readAscii(data, cursor + 4, cursor + 8);
    const entryEnd = cursor + size;
    if (entryEnd > stsd.end || size < 8) {
      return {};
    }

    if (type === 'avc1') {
      const avcC = parseBoxes(data, cursor + 86, entryEnd).find(box => box.type === 'avcC');
      return {
        nalLengthSize: avcC && avcC.contentStart + 5 <= avcC.end ? (data[avcC.contentStart + 4] & 3) + 1 : 4,
        videoCodec: 'avc'
      };
    }
    if (type === 'hvc1' || type === 'hev1') {
      const hvcC = parseBoxes(data, cursor + 86, entryEnd).find(box => box.type === 'hvcC');
      return {
        nalLengthSize: hvcC && hvcC.contentStart + 22 <= hvcC.end ? (data[hvcC.contentStart + 21] & 3) + 1 : 4,
        videoCodec: 'hevc'
      };
    }

    cursor = entryEnd;
  }

  return {};
}

function readUInt(data: Buffer, offset: number, byteLength: number): number {
  if (byteLength === 1) {
    return data.readUInt8(offset);
  }
  if (byteLength === 2) {
    return data.readUInt16BE(offset);
  }
  if (byteLength === 3) {
    return data.readUIntBE(offset, 3);
  }
  return data.readUInt32BE(offset);
}

function readAscii(data: Buffer, start: number, end: number): string {
  return data.toString('ascii', start, end);
}
