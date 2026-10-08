import type { Score } from '../core';
import { importMidi } from './midi';
import { importMusicXml, readMusicXmlText } from './musicxml';
import { importAbc } from './abc';
import { importGuitarPro } from './guitarpro';
import { importProject, looksLikeProject } from './project';
import { addWarning, baseName, decodeUtf8, extOf } from './util';
import { unzipSync } from 'fflate';

export interface ImportOptions {
  onProgress?: (p: { stage: string; fraction: number }) => void;
  /** Clef assumed by OMR when none is recognised. */
  defaultClef?: 'treble' | 'bass';
  /** 'guitar' reads treble clefs an octave lower (guitar sounds an octave below written). */
  instrument?: 'guitar' | 'concert';
}

export { exportProject, importProject, PROJECT_VERSION } from './project';
export { importMidi, importMusicXml, importAbc, importGuitarPro };
export { decompressBcfz, readBcfs, parseGpif, parseGuitarPro345 } from './guitarpro';

export const SUPPORTED_EXTENSIONS = [
  'mid', 'midi', 'xml', 'musicxml', 'mxl', 'abc', 'gp3', 'gp4', 'gp5', 'gpx', 'gp',
  'json', 'pdf', 'png', 'jpg', 'jpeg', 'webp', 'mp3', 'wav', 'm4a', 'ogg', 'flac',
];

export type FileKind = 'midi' | 'musicxml' | 'abc' | 'guitarpro' | 'pdf' | 'image' | 'audio' | 'project' | 'unknown';

const EXT_KIND: Record<string, FileKind> = {
  mid: 'midi', midi: 'midi', kar: 'midi',
  xml: 'musicxml', musicxml: 'musicxml', mxl: 'musicxml',
  abc: 'abc',
  json: 'project',
  gp3: 'guitarpro', gp4: 'guitarpro', gp5: 'guitarpro', gpx: 'guitarpro', gp: 'guitarpro',
  pdf: 'pdf',
  png: 'image', jpg: 'image', jpeg: 'image', webp: 'image',
  mp3: 'audio', wav: 'audio', m4a: 'audio', ogg: 'audio', flac: 'audio',
};

const startsAscii = (b: Uint8Array, s: string, at = 0) => {
  for (let i = 0; i < s.length; i++) if (b[at + i] !== s.charCodeAt(i)) return false;
  return true;
};

/** Detect file kind from extension, falling back to magic bytes. */
export function detectKind(filename: string, head: Uint8Array): FileKind {
  const byExt = EXT_KIND[extOf(filename)];
  if (byExt) return byExt;
  if (looksLikeProject(decodeUtf8(head.subarray(0, 512)))) return 'project';
  if (startsAscii(head, 'MThd')) return 'midi';
  if (startsAscii(head, '%PDF')) return 'pdf';
  if (startsAscii(head, 'BCFZ') || startsAscii(head, 'BCFS')) return 'guitarpro';
  if (head.length > 1 && head[0] === 0x50 && head[1] === 0x4b) {
    try {
      const files = unzipSync(head);
      const names = Object.keys(files);
      if (names.some((n) => n === 'META-INF/container.xml')) return 'musicxml';
      if (names.some((n) => /\.gpif$/i.test(n))) return 'guitarpro';
    } catch { /* fall through */ }
    return 'unknown';
  }
  if (head.length > 4 && head[0] === 0x89 && startsAscii(head, 'PNG', 1)) return 'image';
  if (head[0] === 0xff && head[1] === 0xd8) return 'image';
  if (startsAscii(head, 'RIFF') && startsAscii(head, 'WEBP', 8)) return 'image';
  if (startsAscii(head, 'RIFF') && startsAscii(head, 'WAVE', 8)) return 'audio';
  if (startsAscii(head, 'ID3') || startsAscii(head, 'OggS') || startsAscii(head, 'fLaC')) return 'audio';
  if (head.length > 11 && startsAscii(head, 'ftyp', 4)) return 'audio';
  if (head[0] === 0xff && (head[1] & 0xe0) === 0xe0) return 'audio';
  if (head.length > 20 && head[0] === 0x13 && startsAscii(head, 'FICHIER GUITAR PRO', 1)) return 'guitarpro';
  const text = decodeUtf8(head.subarray(0, 2048)).trimStart();
  if (text.startsWith('<?xml') || text.includes('<score-partwise') || text.includes('<score-timewise')) return 'musicxml';
  if (/^(%abc|X:\s*\d)/m.test(text)) return 'abc';
  return 'unknown';
}

export async function importFile(file: File, opts: ImportOptions = {}): Promise<Score> {
  const progress = (stage: string, fraction: number) => opts.onProgress?.({ stage, fraction });
  const name = file.name || 'untitled';
  progress('Reading file', 0.02);
  const buf = await file.arrayBuffer();
  const bytes = new Uint8Array(buf);
  // zip files need the whole buffer for sniffing; for others the head is enough
  const kind = detectKind(name, extOf(name) in EXT_KIND ? bytes.subarray(0, 4) : bytes);
  let score: Score;
  switch (kind) {
    case 'project': {
      progress('Opening tab file', 0.3);
      const p = importProject(decodeUtf8(bytes));
      score = p.score;
      if (p.name && !score.meta.title) score.meta.title = p.name;
      progress('Done', 1);
      return score;
    }
    case 'midi':
      progress('Parsing MIDI', 0.3);
      score = importMidi(buf);
      score.meta.source = 'midi';
      break;
    case 'musicxml':
      progress('Parsing MusicXML', 0.3);
      score = importMusicXml(buf);
      score.meta.source = 'musicxml';
      break;
    case 'abc':
      progress('Parsing ABC', 0.3);
      score = importAbc(decodeUtf8(bytes));
      score.meta.source = 'abc';
      break;
    case 'guitarpro':
      progress('Parsing Guitar Pro', 0.3);
      score = importGuitarPro(buf, name);
      score.meta.source = 'guitarpro';
      break;
    case 'pdf': {
      progress('Loading OCR engine', 0.05);
      const omr = await import('../omr');
      progress('Rendering PDF pages', 0.1);
      const pages = await omr.renderPdfPages(buf);
      score = await omr.recognizeScore(pages, {
        onProgress: (p) => progress(p.stage, 0.15 + 0.85 * p.fraction),
        defaultClef: opts?.defaultClef,
        instrument: opts?.instrument,
      });
      score.meta.source = 'omr';
      break;
    }
    case 'image': {
      progress('Loading OCR engine', 0.05);
      const omr = await import('../omr');
      progress('Loading image', 0.1);
      const canvas = await omr.imageToCanvas(file);
      score = await omr.recognizeScore([canvas], {
        onProgress: (p) => progress(p.stage, 0.15 + 0.85 * p.fraction),
        defaultClef: opts?.defaultClef,
        instrument: opts?.instrument,
      });
      score.meta.source = 'omr';
      break;
    }
    case 'audio': {
      progress('Loading audio engine', 0.05);
      const audio = await import('../audio');
      score = await audio.transcribeAudio(buf, {
        onProgress: (p) => progress(p.stage, 0.1 + 0.9 * p.fraction),
      });
      score.meta.source = 'audio';
      break;
    }
    default:
      throw new Error(`Unsupported file type: ${name}`);
  }
  if (!score.meta.title) score.meta.title = baseName(name);
  if (!score.meta.warnings) score.meta.warnings = [];
  if (score.tracks.every((t) => t.notes.length === 0)) addWarning(score, 'No notes were found in this file.');
  progress('Done', 1);
  return score;
}

export { readMusicXmlText };
