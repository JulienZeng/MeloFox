/** Identify the stored audio container without trusting a signed URL or CDN MIME. */
export function audioFormat(bytes: Buffer): { contentType: string; extension: string } {
  if (bytes.length >= 12 && bytes.toString('ascii', 0, 4) === 'RIFF' && bytes.toString('ascii', 8, 12) === 'WAVE')
    return { contentType: 'audio/wav', extension: '.wav' };
  if (bytes.subarray(0, 9).equals(Buffer.from('#!AMR-WB\n'))) return { contentType: 'audio/amr-wb', extension: '.amr' };
  if (bytes.subarray(0, 6).equals(Buffer.from('#!AMR\n'))) return { contentType: 'audio/amr', extension: '.amr' };
  if (bytes.toString('ascii', 0, 4) === 'OggS') return { contentType: 'audio/ogg', extension: '.ogg' };
  if (bytes.toString('ascii', 0, 4) === 'fLaC') return { contentType: 'audio/flac', extension: '.flac' };
  if (bytes.length >= 12 && bytes.toString('ascii', 4, 8) === 'ftyp') return { contentType: 'audio/mp4', extension: '.m4a' };
  if (bytes.length >= 2 && bytes[0] === 0xff && (bytes[1] & 0xf6) === 0xf0)
    return { contentType: 'audio/aac', extension: '.aac' };
  if (bytes.toString('ascii', 0, 3) === 'ID3' ||
      (bytes.length >= 2 && bytes[0] === 0xff && (bytes[1] & 0xe0) === 0xe0 && (bytes[1] & 0x06) !== 0))
    return { contentType: 'audio/mpeg', extension: '.mp3' };
  throw new Error('Voice resource has no supported audio container');
}
