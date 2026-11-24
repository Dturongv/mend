// mend: one patch tool for every AI edit format (SPEC.md version 1)
// Standard library only (Node 22), zero external dependencies.

import { mkdirSync, readFileSync, rmSync, statSync, writeFileSync, writeSync } from 'node:fs';
import { dirname } from 'node:path';

const FORMATS = ['auto', 'unified', 'search-replace', 'v4a', 'json'];

class Exit2 {
  readonly line: string;
  constructor(line: string) {
    this.line = line;
  }
}

class Fail {
  readonly code: string;
  readonly path: string;
  constructor(code: string, path: string) {
    this.code = code;
    this.path = path;
  }
}

const blank = (s: string): boolean => s.trim() === '';

function patchLines(text: string): string[] {
  if (text === '') return [];
  const lines = text.split('\n');
  if (text.endsWith('\n')) lines.pop();
  return lines.map((l) => (l.endsWith('\r') ? l.slice(0, -1) : l));
}

function safe(p: string): boolean {
  return p !== '' && !p.startsWith('/') && !p.includes('\\') && p.split('/').every((s) => s !== '' && s !== '.' && s !== '..');
}

interface FileState {
  lines: string[];
  crlf: boolean;
  finalBreak: boolean;
}

function parseFileText(text: string): FileState {
  if (text === '') {
    return { lines: [], crlf: false, finalBreak: false };
  }
  const nl = text.indexOf('\n');
  const crlf = nl > 0 && text[nl - 1] === '\r';
  const br = crlf ? '\r\n' : '\n';
  const lines = text.split(br);
  const finalBreak = text.endsWith(br);
  if (finalBreak) {
    lines.pop();
  }
  return { lines, crlf, finalBreak };
}

function formatFileText(state: FileState): string {
  if (state.lines.length === 0) {
    return '';
  }
  const br = state.crlf ? '\r\n' : '\n';
  return state.lines.join(br) + (state.finalBreak ? br : '');
}

function leadingIndent(s: string): string {
  const m = s.match(/^[ \t]+/);
  return m ? m[0] : '';
}

function stripTrailing(s: string): string {
  return s.replace(/[ \t]+$/, '');
}

function stripBoth(s: string): string {
  return s.replace(/^[ \t]+|[ \t]+$/g, '');
}

function matchTier(
  fileLines: string[],
  O: string[],
  strict: boolean,
  startAt = 0
): { tier: number; occurrences: number[] } | null {
  if (O.length === 0) return null;
  const tiers = strict ? [0] : [0, 1, 2];
  for (const tier of tiers) {
    const occs: number[] = [];
    for (let i = startAt; i <= fileLines.length - O.length; i++) {
      let match = true;
      for (let k = 0; k < O.length; k++) {
        const fl = fileLines[i + k]!;
        const ol = O[k]!;
        if (tier === 0) {
          if (fl !== ol) {
            match = false;
            break;
          }
        } else if (tier === 1) {
          if (stripTrailing(fl) !== stripTrailing(ol)) {
            match = false;
            break;
          }
        } else {
          if (stripBoth(fl) !== stripBoth(ol)) {
            match = false;
            break;
          }
        }
      }
      if (match) occs.push(i);
    }
    if (occs.length > 0) {
      return { tier, occurrences: occs };
    }
  }
  return null;
}

/** The tree as the edits leave it: changed paths in `now` (null: deleted), the rest read from disk. */
class Tree {
  private readonly orig = new Map<string, string | null>();
  readonly now = new Map<string, string | null>();
  readonly moves: Array<{ oldPath: string; newPath: string }> = [];

  original(p: string): string | null {
    if (!this.orig.has(p)) {
      let v: string | null = null;
      try {
        if (statSync(p).isFile()) v = readFileSync(p, 'utf8');
      } catch {
        v = null;
      }
      this.orig.set(p, v);
    }
    return this.orig.get(p)!;
  }

  get(p: string): string | null {
    return this.now.has(p) ? this.now.get(p)! : this.original(p);
  }
}

type Edit = (tree: Tree) => void;

function detect(lines: string[]): string | null {
  const first = lines.findIndex((l) => !blank(l));
  if (first < 0) return null;
  if (lines[first]!.trim() === '*** Begin Patch') return 'v4a';
  const c = lines[first]!.trimStart()[0];
  if (c === '[' || c === '{') return 'json';
  if (lines.some((l) => l.trimEnd() === '<<<<<<< SEARCH')) return 'search-replace';
  if (lines.some((l, i) => l.startsWith('diff --git ') || (l.startsWith('--- ') && (lines[i + 1] ?? '').startsWith('+++ ')))) return 'unified';
  return null;
}

// ==========================================
// 1. JSON EDITS (SPEC.md Section 9)
// ==========================================

function jsonEdit(v: unknown): Edit | null {
  if (v === null || typeof v !== 'object' || Array.isArray(v)) return null;
  const o = v as Record<string, unknown>;
  const p = o.path;
  if (typeof p !== 'string') return null;

  const exists = (tree: Tree): string => {
    if (!safe(p)) throw new Fail('unsafe', p);
    const t = tree.get(p);
    if (t === null) throw new Fail('missing', p);
    return t;
  };

  if (o.command === 'create' && typeof o.file_text === 'string') {
    const text = o.file_text;
    return (tree) => {
      if (!safe(p)) throw new Fail('unsafe', p);
      if (tree.get(p) !== null) throw new Fail('exists', p);
      tree.now.set(p, text);
    };
  }

  if (o.command === 'str_replace' && typeof o.old_str === 'string' && o.old_str !== '' && (o.new_str === undefined || typeof o.new_str === 'string')) {
    const oldStr = o.old_str;
    const newStr = (o.new_str as string | undefined) ?? '';
    return (tree) => {
      const before = exists(tree);
      const nl = before.indexOf('\n');
      const crlf = nl > 0 && before[nl - 1] === '\r';
      const lf = (s: string): string => (crlf ? s.replaceAll('\r\n', '\n') : s);
      const t = lf(before);
      const old = lf(oldStr);
      let count = 0;
      for (let k = t.indexOf(old); k >= 0; k = t.indexOf(old, k + 1)) count += 1;
      if (count === 0) throw new Fail('no-match', p);
      if (count > 1) throw new Fail('ambiguous', p);
      const at = t.indexOf(old);
      const out = t.slice(0, at) + lf(newStr) + t.slice(at + old.length);
      tree.now.set(p, crlf ? out.replaceAll('\n', '\r\n') : out);
    };
  }

  if (o.command === 'insert' && typeof o.insert_line === 'number' && Number.isInteger(o.insert_line) && typeof o.new_str === 'string') {
    const line = o.insert_line;
    const add = patchLines(o.new_str);
    return (tree) => {
      const before = exists(tree);
      const parsed = parseFileText(before);
      if (line < 0 || line > parsed.lines.length) throw new Fail('no-match', p);
      parsed.lines.splice(line, 0, ...add);
      tree.now.set(p, formatFileText(parsed));
    };
  }

  return null;
}

function jsonEdits(text: string, lines: string[]): Edit[] {
  const first = lines.findIndex((l) => !blank(l));
  if (first < 0) throw new Exit2('error: parse 1');
  const edits: Edit[] = [];
  if (lines[first]!.trimStart().startsWith('[')) {
    let v: unknown;
    try {
      v = JSON.parse(text);
    } catch {
      throw new Exit2(`error: parse ${first + 1}`);
    }
    if (!Array.isArray(v)) throw new Exit2(`error: parse ${first + 1}`);
    for (const x of v) {
      const e = jsonEdit(x);
      if (e === null) throw new Exit2(`error: parse ${first + 1}`);
      edits.push(e);
    }
    return edits;
  }
  lines.forEach((l, i) => {
    if (blank(l)) return;
    let e: Edit | null = null;
    try {
      e = jsonEdit(JSON.parse(l));
    } catch {
      e = null;
    }
    if (e === null) throw new Exit2(`error: parse ${i + 1}`);
    edits.push(e);
  });
  return edits;
}

// ==========================================
// 2. SEARCH/REPLACE BLOCKS (SPEC.md Section 7)
// ==========================================

interface SearchReplaceBlock {
  path: string;
  oldLines: string[];
  newLines: string[];
  searchLine: number;
}

function searchReplaceEdits(lines: string[], strict: boolean): Edit[] {
  const blocks: SearchReplaceBlock[] = [];
  let previousBlockPath: string | null = null;
  let lastBlockEndIndex = -1;
  let i = 0;

  while (i < lines.length) {
    if (lines[i]!.trimEnd() === '<<<<<<< SEARCH') {
      const searchLineNum = i + 1;
      // Find path before search line
      let path: string | null = null;
      for (let pIdx = i - 1; pIdx > lastBlockEndIndex; pIdx--) {
        const candidate = lines[pIdx]!;
        if (!blank(candidate) && !candidate.trim().startsWith('```')) {
          path = candidate.trim();
          break;
        }
      }
      if (path === null) {
        if (previousBlockPath !== null) {
          path = previousBlockPath;
        } else {
          throw new Exit2(`error: parse ${searchLineNum}`);
        }
      }

      // Find =======
      let eqIdx = -1;
      for (let j = i + 1; j < lines.length; j++) {
        if (lines[j]!.trimEnd() === '=======') {
          eqIdx = j;
          break;
        }
      }
      if (eqIdx === -1) {
        throw new Exit2(`error: parse ${searchLineNum}`);
      }

      // Find >>>>>>> REPLACE
      let repIdx = -1;
      for (let j = eqIdx + 1; j < lines.length; j++) {
        if (lines[j]!.trimEnd() === '>>>>>>> REPLACE') {
          repIdx = j;
          break;
        }
      }
      if (repIdx === -1) {
        throw new Exit2(`error: parse ${searchLineNum}`);
      }

      const oldLines = lines.slice(i + 1, eqIdx);
      const newLines = lines.slice(eqIdx + 1, repIdx);

      blocks.push({
        path,
        oldLines,
        newLines,
        searchLine: searchLineNum,
      });

      previousBlockPath = path;
      lastBlockEndIndex = repIdx;
      i = repIdx + 1;
    } else {
      i++;
    }
  }

  if (blocks.length === 0) {
    throw new Exit2('error: parse 1');
  }

  return blocks.map((b) => (tree: Tree) => {
    if (!safe(b.path)) throw new Fail('unsafe', b.path);

    if (b.oldLines.length === 0) {
      // Creation
      if (tree.get(b.path) !== null) throw new Fail('exists', b.path);
      const content = b.newLines.length === 0 ? '' : b.newLines.join('\n') + '\n';
      tree.now.set(b.path, content);
      return;
    }

    // Change
    const current = tree.get(b.path);
    if (current === null) throw new Fail('missing', b.path);

    const parsed = parseFileText(current);
    const m = matchTier(parsed.lines, b.oldLines, strict);
    if (m === null) throw new Fail('no-match', b.path);
    if (m.occurrences.length > 1) throw new Fail('ambiguous', b.path);

    const matchIdx = m.occurrences[0]!;
    let newN: string[];
    if (m.tier === 2) {
      const F = leadingIndent(parsed.lines[matchIdx]!);
      const P = leadingIndent(b.oldLines[0]!);
      newN = b.newLines.map((l) => (stripBoth(l) !== '' && l.startsWith(P) ? F + l.slice(P.length) : l));
    } else {
      newN = [...b.newLines];
    }

    parsed.lines.splice(matchIdx, b.oldLines.length, ...newN);
    tree.now.set(b.path, formatFileText(parsed));
  });
}

// ==========================================
// 3. V4A PATCHES (SPEC.md Section 8)
// ==========================================

interface V4AChunk {
  anchor: string | null;
  body: Array<{ type: 'context' | 'old' | 'new'; text: string }>;
  isEndOfFile: boolean;
}

interface V4ASection {
  kind: 'add' | 'delete' | 'update';
  path: string;
  moveTo: string | null;
  addLines?: string[];
  chunks?: V4AChunk[];
}

function allBlankUntilNext(lines: string[], start: number, end: number): boolean {
  for (let k = start; k < end; k++) {
    const l = lines[k]!;
    if (l.startsWith('*** Add File: ') || l.startsWith('*** Delete File: ') || l.startsWith('*** Update File: ') || l.trim() === '*** End Patch') {
      return true;
    }
    if (!blank(l)) return false;
  }
  return true;
}

function v4aEdits(lines: string[], strict: boolean): Edit[] {
  const firstNonBlank = lines.findIndex((l) => !blank(l));
  if (firstNonBlank < 0) throw new Exit2('error: parse 1');
  if (lines[firstNonBlank]!.trim() !== '*** Begin Patch') {
    throw new Exit2(`error: parse ${firstNonBlank + 1}`);
  }

  let lastNonBlank = -1;
  for (let i = lines.length - 1; i >= 0; i--) {
    if (!blank(lines[i]!)) {
      lastNonBlank = i;
      break;
    }
  }
  if (lastNonBlank < 0 || lines[lastNonBlank]!.trim() !== '*** End Patch') {
    throw new Exit2(`error: parse ${lines.length + 1}`);
  }

  const sections: V4ASection[] = [];
  let i = firstNonBlank + 1;

  while (i < lastNonBlank) {
    if (blank(lines[i]!)) {
      i++;
      continue;
    }

    const line = lines[i]!;
    if (line.startsWith('*** Add File: ')) {
      const path = line.slice(14).trim();
      i++;
      const addLines: string[] = [];
      while (i < lastNonBlank) {
        const cur = lines[i]!;
        if (cur.startsWith('*** Add File: ') || cur.startsWith('*** Delete File: ') || cur.startsWith('*** Update File: ') || cur.trim() === '*** End Patch') {
          break;
        }
        if (blank(cur)) {
          if (allBlankUntilNext(lines, i, lastNonBlank)) {
            break;
          }
          addLines.push('');
          i++;
        } else if (cur.startsWith('+')) {
          addLines.push(cur.slice(1));
          i++;
        } else {
          throw new Exit2(`error: parse ${i + 1}`);
        }
      }
      sections.push({ kind: 'add', path, moveTo: null, addLines });
    } else if (line.startsWith('*** Delete File: ')) {
      const path = line.slice(17).trim();
      i++;
      while (i < lastNonBlank) {
        const cur = lines[i]!;
        if (cur.startsWith('*** Add File: ') || cur.startsWith('*** Delete File: ') || cur.startsWith('*** Update File: ') || cur.trim() === '*** End Patch') {
          break;
        }
        if (!blank(cur)) {
          throw new Exit2(`error: parse ${i + 1}`);
        }
        i++;
      }
      sections.push({ kind: 'delete', path, moveTo: null });
    } else if (line.startsWith('*** Update File: ')) {
      const updateLineNum = i + 1;
      const path = line.slice(17).trim();
      i++;

      let moveTo: string | null = null;
      if (i < lastNonBlank && lines[i]!.startsWith('*** Move to: ')) {
        moveTo = lines[i]!.slice(13).trim();
        i++;
      }

      const chunks: V4AChunk[] = [];
      while (i < lastNonBlank) {
        if (blank(lines[i]!)) {
          if (allBlankUntilNext(lines, i, lastNonBlank)) {
            break;
          }
        }
        const cur = lines[i]!;
        if (cur.startsWith('*** Add File: ') || cur.startsWith('*** Delete File: ') || cur.startsWith('*** Update File: ') || cur.trim() === '*** End Patch') {
          break;
        }

        let anchor: string | null = null;
        if (cur.startsWith('@@')) {
          const a = cur.slice(2).trim();
          anchor = a === '' ? null : a;
          i++;
        } else if (chunks.length === 0) {
          // First chunk may start at body line
          anchor = null;
        } else {
          throw new Exit2(`error: parse ${i + 1}`);
        }

        const body: Array<{ type: 'context' | 'old' | 'new'; text: string }> = [];
        let isEndOfFile = false;

        while (i < lastNonBlank) {
          const bLine = lines[i]!;
          if (bLine === '*** End of File') {
            isEndOfFile = true;
            i++;
            break;
          }
          if (bLine.startsWith('@@')) {
            break;
          }
          if (bLine.startsWith('*** Add File: ') || bLine.startsWith('*** Delete File: ') || bLine.startsWith('*** Update File: ') || bLine.trim() === '*** End Patch') {
            break;
          }
          if (blank(bLine)) {
            if (allBlankUntilNext(lines, i, lastNonBlank)) {
              break;
            }
            body.push({ type: 'context', text: '' });
            i++;
          } else if (bLine.startsWith(' ')) {
            body.push({ type: 'context', text: bLine.slice(1) });
            i++;
          } else if (bLine.startsWith('-')) {
            body.push({ type: 'old', text: bLine.slice(1) });
            i++;
          } else if (bLine.startsWith('+')) {
            body.push({ type: 'new', text: bLine.slice(1) });
            i++;
          } else {
            throw new Exit2(`error: parse ${i + 1}`);
          }
        }

        chunks.push({ anchor, body, isEndOfFile });
      }

      if (chunks.length === 0 && moveTo === null) {
        throw new Exit2(`error: parse ${updateLineNum}`);
      }

      sections.push({ kind: 'update', path, moveTo, chunks });
    } else {
      throw new Exit2(`error: parse ${i + 1}`);
    }
  }

  if (sections.length === 0) {
    throw new Exit2('error: parse 1');
  }

  return sections.map((sec) => (tree: Tree) => {
    if (sec.kind === 'add') {
      if (!safe(sec.path)) throw new Fail('unsafe', sec.path);
      if (tree.get(sec.path) !== null) throw new Fail('exists', sec.path);
      const content = sec.addLines!.length === 0 ? '' : sec.addLines!.join('\n') + '\n';
      tree.now.set(sec.path, content);
      return;
    }

    if (sec.kind === 'delete') {
      if (!safe(sec.path)) throw new Fail('unsafe', sec.path);
      if (tree.get(sec.path) === null) throw new Fail('missing', sec.path);
      tree.now.set(sec.path, null);
      return;
    }

    // Update
    if (!safe(sec.path)) throw new Fail('unsafe', sec.path);
    if (sec.moveTo !== null && !safe(sec.moveTo)) throw new Fail('unsafe', sec.moveTo);
    const current = tree.get(sec.path);
    if (current === null) throw new Fail('missing', sec.path);
    if (sec.moveTo !== null && tree.get(sec.moveTo) !== null) throw new Fail('exists', sec.moveTo);

    const parsed = parseFileText(current);
    const fileLines = [...parsed.lines];
    let cursor = 0;

    for (const chunk of sec.chunks!) {
      if (chunk.anchor !== null) {
        // Find anchor line starting from cursor
        const anchorMatch = matchTier(fileLines, [chunk.anchor], strict, cursor);
        if (anchorMatch === null) throw new Fail('no-match', sec.path);
        const anchorIdx = anchorMatch.occurrences[0]!;
        cursor = anchorIdx + 1;
      }

      interface OItem {
        text: string;
        isContext: boolean;
      }
      interface NItem {
        text: string;
        isContext: boolean;
        oOffset: number;
      }

      const O: OItem[] = [];
      const N: NItem[] = [];

      for (const item of chunk.body) {
        if (item.type === 'context') {
          const oOffset = O.length;
          O.push({ text: item.text, isContext: true });
          N.push({ text: item.text, isContext: true, oOffset });
        } else if (item.type === 'old') {
          O.push({ text: item.text, isContext: false });
        } else {
          N.push({ text: item.text, isContext: false, oOffset: -1 });
        }
      }

      if (O.length > 0) {
        const oTexts = O.map((x) => x.text);
        const tiers = strict ? [0] : [0, 1, 2];
        let foundTier: number | null = null;
        let foundOcc: number | null = null;

        for (const tier of tiers) {
          for (let k = cursor; k <= fileLines.length - O.length; k++) {
            let match = true;
            for (let j = 0; j < O.length; j++) {
              const fl = fileLines[k + j]!;
              const ol = oTexts[j]!;
              if (tier === 0) {
                if (fl !== ol) {
                  match = false;
                  break;
                }
              } else if (tier === 1) {
                if (stripTrailing(fl) !== stripTrailing(ol)) {
                  match = false;
                  break;
                }
              } else {
                if (stripBoth(fl) !== stripBoth(ol)) {
                  match = false;
                  break;
                }
              }
            }
            if (match) {
              if (chunk.isEndOfFile && k + O.length !== fileLines.length) {
                // Must end at file's last line
                continue;
              }
              foundTier = tier;
              foundOcc = k;
              break;
            }
          }
          if (foundOcc !== null) break;
        }

        if (foundOcc === null) {
          throw new Fail('no-match', sec.path);
        }

        const occ = foundOcc;
        let newN: string[];
        if (foundTier === 2) {
          const F = leadingIndent(fileLines[occ]!);
          const P = leadingIndent(O[0]!.text);
          newN = N.map((item) =>
            item.isContext ? fileLines[occ + item.oOffset]! : stripBoth(item.text) !== '' && item.text.startsWith(P) ? F + item.text.slice(P.length) : item.text
          );
        } else {
          newN = N.map((item) => (item.isContext ? fileLines[occ + item.oOffset]! : item.text));
        }

        fileLines.splice(occ, O.length, ...newN);
        cursor = occ + newN.length;
      } else {
        // O is empty
        const insertList = N.map((x) => x.text);
        if (chunk.isEndOfFile) {
          fileLines.splice(fileLines.length, 0, ...insertList);
          cursor = fileLines.length;
        } else {
          fileLines.splice(cursor, 0, ...insertList);
          cursor += insertList.length;
        }
      }
    }

    const resultText = formatFileText({ lines: fileLines, crlf: parsed.crlf, finalBreak: parsed.finalBreak });
    if (sec.moveTo !== null) {
      tree.now.set(sec.path, null);
      tree.now.set(sec.moveTo, resultText);
      tree.moves.push({ oldPath: sec.path, newPath: sec.moveTo });
    } else {
      tree.now.set(sec.path, resultText);
    }
  });
}

// ==========================================
// 4. UNIFIED DIFFS (SPEC.md Section 6)
// ==========================================

interface UnifiedHunk {
  A: number;
  C: number;
  rawBody: Array<{ type: 'context' | 'old' | 'new' | 'backslash'; text: string }>;
}

interface UnifiedSection {
  diffGitOld?: string;
  diffGitNew?: string;
  dashPath?: string;
  plusPath?: string;
  renameFrom?: string;
  renameTo?: string;
  newFileMode?: boolean;
  deletedFileMode?: boolean;
  hunks: UnifiedHunk[];
}

function parseDiffPath(line: string): string {
  let p = line.slice(4);
  const tab = p.indexOf('\t');
  if (tab >= 0) p = p.slice(0, tab);
  p = p.trim();
  if (p === '/dev/null') return '/dev/null';
  if (p.startsWith('a/')) p = p.slice(2);
  else if (p.startsWith('b/')) p = p.slice(2);
  return p;
}

function unifiedEdits(lines: string[], strict: boolean): Edit[] {
  const sections: UnifiedSection[] = [];
  let curSec: UnifiedSection | null = null;
  let inHeader = false;
  let i = 0;

  while (i < lines.length) {
    const l = lines[i]!;

    if (l.startsWith('diff --git ')) {
      // Must be diff --git a/<X> b/<Y>
      const m = l.match(/^diff --git\s+a\/(.+?)\s+b\/(.+)$/);
      if (!m) {
        throw new Exit2(`error: parse ${i + 1}`);
      }
      curSec = {
        diffGitOld: m[1],
        diffGitNew: m[2],
        hunks: [],
      };
      sections.push(curSec);
      inHeader = true;
      i++;
      continue;
    }

    if (l.startsWith('--- ')) {
      if (!inHeader) {
        // Starts a new section if followed by +++
        if (i + 1 < lines.length && lines[i + 1]!.startsWith('+++ ')) {
          curSec = {
            dashPath: parseDiffPath(l),
            plusPath: parseDiffPath(lines[i + 1]!),
            hunks: [],
          };
          sections.push(curSec);
          inHeader = true;
          i += 2;
          continue;
        } else {
          // Outside section header, prose/ignored
          i++;
          continue;
        }
      } else {
        // Inside section header, MUST be followed by +++
        if (i + 1 >= lines.length || !lines[i + 1]!.startsWith('+++ ')) {
          throw new Exit2(`error: parse ${i + 2}`);
        }
        curSec!.dashPath = parseDiffPath(l);
        curSec!.plusPath = parseDiffPath(lines[i + 1]!);
        i += 2;
        continue;
      }
    }

    if (inHeader) {
      if (l.startsWith('rename from ')) {
        let p = l.slice(12).trim();
        if (p.startsWith('a/')) p = p.slice(2);
        curSec!.renameFrom = p;
        i++;
        continue;
      }
      if (l.startsWith('rename to ')) {
        let p = l.slice(10).trim();
        if (p.startsWith('b/')) p = p.slice(2);
        curSec!.renameTo = p;
        i++;
        continue;
      }
      if (l.startsWith('new file mode')) {
        curSec!.newFileMode = true;
        i++;
        continue;
      }
      if (l.startsWith('deleted file mode')) {
        curSec!.deletedFileMode = true;
        i++;
        continue;
      }
    }

    if (l.startsWith('@@')) {
      if (curSec === null) {
        throw new Exit2(`error: parse ${i + 1}`);
      }
      const m = l.match(/^@@\s+-(\d+)(?:,\d+)?\s+\+(\d+)(?:,\d+)?\s+@@(.*)$/);
      if (!m) {
        throw new Exit2(`error: parse ${i + 1}`);
      }
      inHeader = false;
      const A = parseInt(m[1]!, 10);
      const C = parseInt(m[2]!, 10);
      i++;

      const rawBody: Array<{ type: 'context' | 'old' | 'new' | 'backslash'; text: string }> = [];
      while (i < lines.length) {
        const bLine = lines[i]!;
        if (bLine.startsWith('diff --git ')) break;
        if (bLine.startsWith('--- ') && i + 1 < lines.length && lines[i + 1]!.startsWith('+++ ')) break;
        if (bLine.startsWith('@@')) break;
        if (bLine.startsWith(' ')) {
          rawBody.push({ type: 'context', text: bLine.slice(1) });
          i++;
        } else if (bLine.startsWith('-')) {
          rawBody.push({ type: 'old', text: bLine.slice(1) });
          i++;
        } else if (bLine.startsWith('+')) {
          rawBody.push({ type: 'new', text: bLine.slice(1) });
          i++;
        } else if (bLine.startsWith('\\')) {
          rawBody.push({ type: 'backslash', text: bLine.slice(1) });
          i++;
        } else if (bLine === '') {
          rawBody.push({ type: 'context', text: '' });
          i++;
        } else {
          break;
        }
      }

      // Empty lines at the end of a body are not part of it
      while (rawBody.length > 0 && rawBody[rawBody.length - 1]!.type === 'context' && rawBody[rawBody.length - 1]!.text === '') {
        rawBody.pop();
      }

      curSec.hunks.push({ A, C, rawBody });
      continue;
    }

    // Any other line
    i++;
  }

  if (sections.length === 0) {
    throw new Exit2('error: parse 1');
  }

  return sections.map((sec) => (tree: Tree) => {
    let oldPath: string | undefined = sec.dashPath;
    let newPath: string | undefined = sec.plusPath;

    if (oldPath === undefined && newPath === undefined) {
      if (sec.renameFrom !== undefined && sec.renameTo !== undefined) {
        oldPath = sec.renameFrom;
        newPath = sec.renameTo;
      } else if (sec.diffGitOld !== undefined && sec.diffGitNew !== undefined) {
        oldPath = sec.diffGitOld;
        newPath = sec.diffGitNew;
      }
    }

    if (sec.newFileMode) oldPath = '/dev/null';
    if (sec.deletedFileMode) newPath = '/dev/null';

    // 1. Creation
    if (oldPath === '/dev/null') {
      if (!newPath || !safe(newPath)) throw new Fail('unsafe', newPath ?? '');
      if (tree.get(newPath) !== null) throw new Fail('exists', newPath);

      const plusLines: string[] = [];
      let lastPlusHasBackslash = false;

      for (const hunk of sec.hunks) {
        for (let idx = 0; idx < hunk.rawBody.length; idx++) {
          const item = hunk.rawBody[idx]!;
          if (item.type === 'new') {
            plusLines.push(item.text);
            const next = hunk.rawBody[idx + 1];
            lastPlusHasBackslash = next !== undefined && next.type === 'backslash';
          }
        }
      }

      if (plusLines.length === 0) {
        tree.now.set(newPath, '');
      } else {
        tree.now.set(newPath, plusLines.join('\n') + (lastPlusHasBackslash ? '' : '\n'));
      }
      return;
    }

    // 2. Deletion
    if (newPath === '/dev/null') {
      if (!oldPath || !safe(oldPath)) throw new Fail('unsafe', oldPath ?? '');
      if (tree.get(oldPath) === null) throw new Fail('missing', oldPath);
      tree.now.set(oldPath, null);
      return;
    }

    // Move or Change
    const isMove = oldPath !== undefined && newPath !== undefined && oldPath !== newPath;
    const targetOld = oldPath!;
    const targetNew = newPath ?? oldPath!;

    if (!safe(targetOld)) throw new Fail('unsafe', targetOld);
    if (!safe(targetNew)) throw new Fail('unsafe', targetNew);

    const current = tree.get(targetOld);
    if (current === null) throw new Fail('missing', targetOld);
    if (isMove && tree.get(targetNew) !== null) throw new Fail('exists', targetNew);

    const parsed = parseFileText(current);
    const fileLines = [...parsed.lines];
    let finalBreak = parsed.finalBreak;
    let d = 0;

    for (const hunk of sec.hunks) {
      interface OItem {
        text: string;
        isContext: boolean;
      }
      interface NItem {
        text: string;
        isContext: boolean;
        oOffset: number;
      }

      const O: OItem[] = [];
      const N: NItem[] = [];
      let lastNewOrContextHasBackslash = false;

      for (let idx = 0; idx < hunk.rawBody.length; idx++) {
        const item = hunk.rawBody[idx]!;
        if (item.type === 'context') {
          const oOffset = O.length;
          O.push({ text: item.text, isContext: true });
          N.push({ text: item.text, isContext: true, oOffset });
          const next = hunk.rawBody[idx + 1];
          lastNewOrContextHasBackslash = next !== undefined && next.type === 'backslash';
        } else if (item.type === 'old') {
          O.push({ text: item.text, isContext: false });
        } else if (item.type === 'new') {
          N.push({ text: item.text, isContext: false, oOffset: -1 });
          const next = hunk.rawBody[idx + 1];
          lastNewOrContextHasBackslash = next !== undefined && next.type === 'backslash';
        }
      }

      if (O.length > 0) {
        const oTexts = O.map((x) => x.text);
        const m = matchTier(fileLines, oTexts, strict);
        if (m === null) throw new Fail('no-match', targetOld);

        const target = hunk.A - 1 + d;
        let bestOcc = m.occurrences[0]!;
        let bestDist = Math.abs(bestOcc - target);
        for (const occ of m.occurrences) {
          const dist = Math.abs(occ - target);
          if (dist < bestDist) {
            bestDist = dist;
            bestOcc = occ;
          }
        }

        if (bestOcc + O.length === fileLines.length) {
          finalBreak = !lastNewOrContextHasBackslash;
        }

        let newN: string[];
        if (m.tier === 2) {
          const F = leadingIndent(fileLines[bestOcc]!);
          const P = leadingIndent(O[0]!.text);
          newN = N.map((item) =>
            item.isContext ? fileLines[bestOcc + item.oOffset]! : stripBoth(item.text) !== '' && item.text.startsWith(P) ? F + item.text.slice(P.length) : item.text
          );
        } else {
          newN = N.map((item) => (item.isContext ? fileLines[bestOcc + item.oOffset]! : item.text));
        }

        fileLines.splice(bestOcc, O.length, ...newN);
        d += N.length - O.length;
      } else {
        // O is empty
        const insertAt = Math.max(0, Math.min(fileLines.length, hunk.A + d));
        if (insertAt === fileLines.length) {
          finalBreak = !lastNewOrContextHasBackslash;
        }
        fileLines.splice(insertAt, 0, ...N.map((x) => x.text));
        d += N.length;
      }
    }

    const resultText = formatFileText({ lines: fileLines, crlf: parsed.crlf, finalBreak });
    if (isMove) {
      tree.now.set(targetOld, null);
      tree.now.set(targetNew, resultText);
      tree.moves.push({ oldPath: targetOld, newPath: targetNew });
    } else {
      tree.now.set(targetOld, resultText);
    }
  });
}

// ==========================================
// 5. RUN CLI (SPEC.md Section 1, 2, 10)
// ==========================================

function run(args: string[]): { code: number; out: string[] } {
  let format: string | null = null;
  let check = false;
  let strict = false;
  const pos: string[] = [];
  let ended = false;

  for (const a of args) {
    if (!ended && a === '--') {
      ended = true;
    } else if (!ended && a.startsWith('-') && a !== '-') {
      if (a.startsWith('--format=')) {
        if (format !== null) return { code: 2, out: ['error: usage'] };
        const val = a.slice(9);
        if (!FORMATS.includes(val)) return { code: 2, out: ['error: usage'] };
        format = val;
      } else if (a === '--check') {
        if (check) return { code: 2, out: ['error: usage'] };
        check = true;
      } else if (a === '--strict') {
        if (strict) return { code: 2, out: ['error: usage'] };
        strict = true;
      } else {
        return { code: 2, out: ['error: usage'] };
      }
    } else {
      pos.push(a);
    }
  }

  if (pos.length > 1) return { code: 2, out: ['error: usage'] };
  const file = pos.length === 0 || pos[0] === '-' ? null : pos[0]!;

  let text = '';
  try {
    text = readFileSync(file ?? 0, 'utf8');
  } catch {
    if (file !== null) return { code: 2, out: ['error: no-patch'] };
  }

  const lines = patchLines(text);
  const kind = format === null || format === 'auto' ? detect(lines) : format;
  if (kind === null) return { code: 2, out: ['error: format'] };

  let edits: Edit[];
  try {
    if (kind === 'json') {
      edits = jsonEdits(text, lines);
    } else if (kind === 'search-replace') {
      edits = searchReplaceEdits(lines, strict);
    } else if (kind === 'v4a') {
      edits = v4aEdits(lines, strict);
    } else if (kind === 'unified') {
      edits = unifiedEdits(lines, strict);
    } else {
      return { code: 2, out: ['error: format'] };
    }
  } catch (e) {
    if (e instanceof Exit2) return { code: 2, out: [e.line] };
    throw e;
  }

  const tree = new Tree();
  const fails: Fail[] = [];

  for (const edit of edits) {
    const beforeNow = new Map(tree.now);
    const beforeMovesLen = tree.moves.length;
    try {
      edit(tree);
    } catch (e) {
      if (!(e instanceof Fail)) throw e;
      tree.now.clear();
      for (const [k, v] of beforeNow) tree.now.set(k, v);
      tree.moves.length = beforeMovesLen;
      fails.push(e);
    }
  }

  if (fails.length > 0) {
    return {
      code: 1,
      out: [...fails.map((f) => `error: ${f.code} ${f.path}`), `failed: ${fails.length} of ${edits.length} edits`],
    };
  }

  interface Row {
    key: string;
    line: string;
    write?: () => void;
  }

  const rows: Row[] = [];
  const handledMoves = new Set<string>();

  for (const m of tree.moves) {
    if (
      tree.original(m.oldPath) !== null &&
      tree.now.get(m.oldPath) === null &&
      tree.original(m.newPath) === null &&
      tree.now.get(m.newPath) !== null
    ) {
      handledMoves.add(m.oldPath);
      handledMoves.add(m.newPath);
      const newContent = tree.now.get(m.newPath)!;
      rows.push({
        key: m.newPath,
        line: `R ${m.oldPath} -> ${m.newPath}`,
        write: () => {
          rmSync(m.oldPath, { force: true });
          mkdirSync(dirname(m.newPath), { recursive: true });
          writeFileSync(m.newPath, newContent);
        },
      });
    }
  }

  for (const p of tree.now.keys()) {
    if (handledMoves.has(p)) continue;
    const was = tree.original(p);
    const now = tree.now.get(p)!;
    if (was === now) continue;

    const op = was === null ? 'A' : now === null ? 'D' : 'M';
    rows.push({
      key: p,
      line: `${op} ${p}`,
      write: () => {
        if (now === null) {
          rmSync(p, { force: true });
        } else {
          mkdirSync(dirname(p), { recursive: true });
          writeFileSync(p, now);
        }
      },
    });
  }

  rows.sort((a, b) => Buffer.compare(Buffer.from(a.key, 'utf8'), Buffer.from(b.key, 'utf8')));

  if (!check) {
    for (const r of rows) {
      r.write?.();
    }
  }

  const outLines = rows.map((r) => r.line);
  outLines.push(`ok: ${rows.length} ${rows.length === 1 ? 'file' : 'files'}`);

  return { code: 0, out: outLines };
}

const trialEnv = process.env.MAKEFUN_ENV_URL;
if (trialEnv !== undefined && trialEnv !== '') {
  // A trial: the kit's runner reads the checks from the env and runs this file on each one, without this variable.
  const { runTrial } = await import('./runner.ts');
  await runTrial(trialEnv);
} else {
  const r = run(process.argv.slice(2));
  writeSync(1, r.out.map((l) => `${l}\n`).join(''));
  process.exitCode = r.code;
}
