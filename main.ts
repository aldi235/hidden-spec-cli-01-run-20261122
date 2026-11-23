// mend: one patch tool for every AI edit format.
//
//   node main.ts [--format=NAME] [--check] [--strict] [PATCH]
//
// Applies an AI-written edit to a tree of text files, exactly as SPEC.md
// (version 1) specifies: unified diffs (often with wrong line numbers),
// SEARCH/REPLACE blocks, V4A patches and JSON tool calls. Every file is
// changed or nothing is. Node 22, the standard library alone.
//
// In a trial the grader runs `node /bot/main.ts` with MAKEFUN_ENV_URL set,
// and this file hands over to runner.ts (the last lines below): keep that
// hand-over and runner.ts as they are.

import { mkdirSync, readFileSync, rmSync, statSync, writeFileSync, writeSync } from 'node:fs';
import { dirname } from 'node:path';

const FORMATS = ['auto', 'unified', 'search-replace', 'v4a', 'json'];

/** An exit-2 outcome: one `error: ...` line, nothing written. */
class Exit2 {
  readonly line: string;
  constructor(line: string) {
    this.line = line;
  }
}

/** One edit's failure: a code and the path the failure concerns. */
class Fail {
  readonly code: string;
  readonly path: string;
  constructor(code: string, path: string) {
    this.code = code;
    this.path = path;
  }
}

const blank = (s: string): boolean => s.trim() === '';

/** A patch's lines (SPEC.md section 3): split at `\n`, one trailing `\r` off each. */
function patchLines(text: string): string[] {
  if (text === '') return [];
  const lines = text.split('\n');
  if (text.endsWith('\n')) lines.pop();
  return lines.map((l) => (l.endsWith('\r') ? l.slice(0, -1) : l));
}

/** A path is safe when it is not empty, does not start with `/`, holds no `\`,
 *  and none of its `/`-separated segments is empty, `.` or `..` (section 3). */
function safe(p: string): boolean {
  return p !== '' && !p.startsWith('/') && !p.includes('\\') && p.split('/').every((s) => s !== '' && s !== '.' && s !== '..');
}

const cmpBytes = (a: string, b: string): number => Buffer.compare(Buffer.from(a, 'utf8'), Buffer.from(b, 'utf8'));

// ---------------------------------------------------------------- files

/** A file as lines: its own line break, its lines, and whether it ends with one. */
interface Doc {
  br: string;
  lines: string[];
  final: boolean;
}

function splitDoc(text: string): Doc {
  const nl = text.indexOf('\n');
  const br = nl > 0 && text[nl - 1] === '\r' ? '\r\n' : '\n';
  if (text === '') return { br, lines: [], final: false };
  const parts = text.split(br);
  const final = text.endsWith(br);
  if (final) parts.pop();
  return { br, lines: parts, final };
}

function joinDoc(d: Doc): string {
  if (d.lines.length === 0) return '';
  return d.lines.join(d.br) + (d.final ? d.br : '');
}

// ------------------------------------------------------- matching (sec 5)

/** A line as a tier sees it: 0 exact, 1 trailing spaces/tabs off, 2 both ends off. */
function lineKey(s: string, tier: number): string {
  if (tier === 0) return s;
  if (tier === 1) return s.replace(/[ \t]+$/, '');
  return s.replace(/^[ \t]+/, '').replace(/[ \t]+$/, '');
}

/** The first tier (in `tiers` order) at which `old` occurs in `file` at or after
 *  `from`, and every occurrence at that tier; null when it occurs at no tier.
 *  When `endOnly`, only occurrences ending at the file's last line count. */
function findMatch(
  file: string[],
  old: string[],
  tiers: number[],
  from: number,
  endOnly: boolean,
): { tier: number; positions: number[] } | null {
  if (old.length > file.length - from) return null;
  for (const t of tiers) {
    const fkeys = file.map((l) => lineKey(l, t));
    const okeys = old.map((l) => lineKey(l, t));
    const positions: number[] = [];
    for (let i = from; i + old.length <= file.length; i++) {
      if (endOnly && i + old.length !== file.length) continue;
      let ok = true;
      for (let k = 0; k < old.length; k++) {
        if (fkeys[i + k] !== okeys[k]) {
          ok = false;
          break;
        }
      }
      if (ok) positions.push(i);
    }
    if (positions.length > 0) return { tier: t, positions };
  }
  return null;
}

const leadingWs = (s: string): string => {
  const m = /^[ \t]*/.exec(s);
  return m === null ? '' : m[0];
};

/** One body line of a hunk or chunk: context, removed, or added. `bs` marks a
 *  `\` line directly after it (unified diffs only). */
interface Op {
  kind: 'ctx' | 'del' | 'add';
  text: string;
  bs: boolean;
}

/** The lines that replace the k matched lines at `pos`: a context line is the
 *  file's own matched line, never the patch's; at tier 2 every other line of N
 *  is re-indented from O's first line's indent to the file's (section 5). */
function buildReplacement(ops: Op[], file: string[], pos: number, tier: number): string[] {
  let p = '';
  let f = '';
  if (tier === 2) {
    const firstOld = ops.find((o) => o.kind !== 'add');
    if (firstOld !== undefined) {
      p = leadingWs(firstOld.text);
      f = leadingWs(file[pos] ?? '');
    }
  }
  const out: string[] = [];
  let j = pos;
  for (const op of ops) {
    if (op.kind === 'ctx') {
      out.push(file[j]!);
      j += 1;
    } else if (op.kind === 'del') {
      j += 1;
    } else if (tier === 2 && op.text !== '' && op.text.trim() !== '' && op.text.startsWith(p)) {
      out.push(f + op.text.slice(p.length));
    } else {
      out.push(op.text);
    }
  }
  return out;
}

// ----------------------------------------------------------------- tree

/** The tree as the edits leave it: changed paths in `now` (null: deleted),
 *  the rest read from disk; `moves` records each successful move edit. */
class Tree {
  private readonly orig = new Map<string, string | null>();
  readonly now = new Map<string, string | null>();
  readonly moves: Array<[string, string]> = [];

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

// ----------------------------------------------------- detection (sec 4)

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

// ------------------------------------------------- unified diffs (sec 6)

const DIFF_GIT = /^diff --git a\/(.+) b\/(.+)$/;
const HUNK_HEAD = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/;

interface Hunk {
  a: number;
  ops: Op[];
}

interface Section {
  oldPath: string | null;
  newPath: string | null;
  newFile: boolean;
  deletedFile: boolean;
  hunks: Hunk[];
}

/** A `--- ` / `+++ ` path: the text after the four characters, up to the first
 *  tab, surrounding spaces removed; `/dev/null` means no file; a leading
 *  `a/` or `b/` is removed. */
function headerPath(raw: string): string | null {
  const t = raw.split('\t')[0]!.replace(/^ +/, '').replace(/ +$/, '');
  if (t === '/dev/null') return null;
  if (t.startsWith('a/') || t.startsWith('b/')) return t.slice(2);
  return t;
}

/** Parse one section's header and hunks, starting at `start` (just after its
 *  `diff --git` line, or just after its `--- ` / `+++ ` pair). */
function parseSection(
  lines: string[],
  start: number,
  gitX: string | null,
  gitY: string | null,
  preOld?: string | null,
  preNew?: string | null,
): { sec: Section; next: number } {
  let pairOld = preOld;
  let pairNew = preNew;
  let pairSeen = preOld !== undefined;
  let renOld: string | undefined;
  let renNew: string | undefined;
  let newFile = false;
  let deletedFile = false;
  const hunks: Hunk[] = [];
  let i = start;
  // Header: until the first hunk, the next section, or the end of the patch.
  while (i < lines.length) {
    const l = lines[i]!;
    if (l.startsWith('@@')) break;
    if (l.startsWith('diff --git ')) break;
    if (l.startsWith('--- ')) {
      if ((lines[i + 1] ?? '').startsWith('+++ ')) {
        // A pair before the first hunk is part of this section's header (it is
        // how a `diff --git` section names its paths), never a new section;
        // the first pair names them.
        if (!pairSeen) {
          pairOld = headerPath(l.slice(4));
          pairNew = headerPath(lines[i + 1]!.slice(4));
          pairSeen = true;
        }
        i += 2;
        continue;
      }
      throw new Exit2(`error: parse ${i + 2}`);
    }
    if (l.startsWith('rename from ') && renOld === undefined) renOld = l.slice('rename from '.length);
    else if (l.startsWith('rename to ') && renNew === undefined) renNew = l.slice('rename to '.length);
    else if (l.startsWith('new file mode')) newFile = true;
    else if (l.startsWith('deleted file mode')) deletedFile = true;
    i += 1;
  }
  // Hunks: until the next section or the end of the patch; other lines ignored.
  while (i < lines.length) {
    const l = lines[i]!;
    if (l.startsWith('diff --git ')) break;
    if (l.startsWith('--- ') && (lines[i + 1] ?? '').startsWith('+++ ')) break;
    if (l.startsWith('@@')) {
      const hm = HUNK_HEAD.exec(l);
      if (hm === null) throw new Exit2(`error: parse ${i + 1}`);
      const a = Number(hm[1]);
      i += 1;
      const body: string[] = [];
      while (i < lines.length) {
        const b = lines[i]!;
        if (b.startsWith('diff --git ')) break;
        if (b.startsWith('--- ') && (lines[i + 1] ?? '').startsWith('+++ ')) break;
        if (b === '' || b.startsWith(' ') || b.startsWith('-') || b.startsWith('+') || b.startsWith('\\')) {
          body.push(b);
          i += 1;
          continue;
        }
        break;
      }
      while (body.length > 0 && body[body.length - 1] === '') body.pop();
      const ops: Op[] = [];
      for (const b of body) {
        if (b.startsWith('\\')) {
          if (ops.length > 0) ops[ops.length - 1]!.bs = true;
          continue;
        }
        if (b.startsWith(' ')) ops.push({ kind: 'ctx', text: b.slice(1), bs: false });
        else if (b.startsWith('-')) ops.push({ kind: 'del', text: b.slice(1), bs: false });
        else if (b.startsWith('+')) ops.push({ kind: 'add', text: b.slice(1), bs: false });
        else ops.push({ kind: 'ctx', text: '', bs: false });
      }
      hunks.push({ a, ops });
      continue;
    }
    i += 1;
  }
  const oldPath = pairSeen ? pairOld! : renOld !== undefined ? renOld : gitX;
  const newPath = pairSeen ? pairNew! : renNew !== undefined ? renNew : gitY;
  return { sec: { oldPath, newPath, newFile, deletedFile, hunks }, next: i };
}

function parseUnified(lines: string[], strict: boolean): Edit[] {
  const sections: Section[] = [];
  let i = 0;
  while (i < lines.length) {
    const l = lines[i]!;
    if (l.startsWith('diff --git ')) {
      const m = DIFF_GIT.exec(l);
      if (m === null) throw new Exit2(`error: parse ${i + 1}`);
      const r = parseSection(lines, i + 1, m[1]!, m[2]!);
      sections.push(r.sec);
      i = r.next;
    } else if (l.startsWith('--- ') && (lines[i + 1] ?? '').startsWith('+++ ')) {
      const r = parseSection(lines, i + 2, null, null, headerPath(l.slice(4)), headerPath(lines[i + 1]!.slice(4)));
      sections.push(r.sec);
      i = r.next;
    } else if (l.startsWith('@@')) {
      throw new Exit2(`error: parse ${i + 1}`);
    } else {
      i += 1;
    }
  }
  return sections.map((sec) => unifiedEdit(sec, strict));
}

/** Apply a section's hunks in order to a file's lines. `d` tracks the line
 *  drift the hunks applied so far caused; each hunk takes the occurrence
 *  nearest to A - 1 + d, the earlier of two equally near. */
function applyHunks(doc: Doc, hunks: Hunk[], path: string, strict: boolean): void {
  const tiers = strict ? [0] : [0, 1, 2];
  let d = 0;
  for (const h of hunks) {
    const oLines = h.ops.filter((o) => o.kind !== 'add').map((o) => o.text);
    const nLines = h.ops.filter((o) => o.kind !== 'del').map((o) => o.text);
    let bsAfterLast = false;
    for (let k = h.ops.length - 1; k >= 0; k--) {
      if (h.ops[k]!.kind !== 'del') {
        bsAfterLast = h.ops[k]!.bs;
        break;
      }
    }
    if (oLines.length === 0) {
      const pos = Math.min(Math.max(h.a + d, 0), doc.lines.length);
      const atEnd = pos === doc.lines.length;
      doc.lines.splice(pos, 0, ...nLines);
      if (atEnd) doc.final = !bsAfterLast;
    } else {
      const found = findMatch(doc.lines, oLines, tiers, 0, false);
      if (found === null) throw new Fail('no-match', path);
      const target = h.a - 1 + d;
      let best = found.positions[0]!;
      let bestDist = Math.abs(best - target);
      for (const p of found.positions) {
        const dist = Math.abs(p - target);
        if (dist < bestDist) {
          best = p;
          bestDist = dist;
        }
      }
      const atEnd = best + oLines.length === doc.lines.length;
      const rep = buildReplacement(h.ops, doc.lines, best, found.tier);
      doc.lines.splice(best, oLines.length, ...rep);
      if (atEnd) doc.final = !bsAfterLast;
    }
    d += nLines.length - oLines.length;
  }
}

function unifiedEdit(sec: Section, strict: boolean): Edit {
  const isCreation = sec.oldPath === null || sec.newFile;
  const isDeletion = !isCreation && (sec.newPath === null || sec.deletedFile);
  return (tree) => {
    if (isCreation) {
      const p = sec.newPath ?? '';
      if (!safe(p)) throw new Fail('unsafe', p);
      if (tree.get(p) !== null) throw new Fail('exists', p);
      const plus: string[] = [];
      let lastBs = false;
      for (const h of sec.hunks) {
        for (const op of h.ops) {
          if (op.kind === 'add') {
            plus.push(op.text);
            lastBs = op.bs;
          }
        }
      }
      tree.now.set(p, plus.length === 0 ? '' : plus.join('\n') + (lastBs ? '' : '\n'));
      return;
    }
    if (isDeletion) {
      const p = sec.oldPath ?? '';
      if (!safe(p)) throw new Fail('unsafe', p);
      if (tree.get(p) === null) throw new Fail('missing', p);
      tree.now.set(p, null);
      return;
    }
    const oldP = sec.oldPath ?? '';
    const newP = sec.newPath ?? '';
    if (!safe(oldP)) throw new Fail('unsafe', oldP);
    if (!safe(newP)) throw new Fail('unsafe', newP);
    const before = tree.get(oldP);
    if (before === null) throw new Fail('missing', oldP);
    const isMove = oldP !== newP;
    if (isMove && tree.get(newP) !== null) throw new Fail('exists', newP);
    const doc = splitDoc(before);
    applyHunks(doc, sec.hunks, oldP, strict);
    const out = joinDoc(doc);
    if (isMove) {
      tree.now.set(oldP, null);
      tree.now.set(newP, out);
      tree.moves.push([oldP, newP]);
    } else {
      tree.now.set(oldP, out);
    }
  };
}

// ------------------------------------------- SEARCH/REPLACE blocks (sec 7)

function parseSearchReplace(lines: string[], strict: boolean): Edit[] {
  const edits: Edit[] = [];
  let i = 0;
  let prevEnd = 0;
  let prevPath: string | null = null;
  while (i < lines.length) {
    if (lines[i]!.trimEnd() !== '<<<<<<< SEARCH') {
      i += 1;
      continue;
    }
    const searchLine = i;
    let path: string | null = null;
    for (let j = i - 1; j >= prevEnd; j--) {
      const l = lines[j]!;
      if (blank(l)) continue;
      if (l.trim().startsWith('```')) continue;
      path = l.trim();
      break;
    }
    if (path === null) {
      if (prevPath === null) throw new Exit2(`error: parse ${searchLine + 1}`);
      path = prevPath;
    }
    let eq = -1;
    for (let k = searchLine + 1; k < lines.length; k++) {
      if (lines[k]!.trimEnd() === '=======') {
        eq = k;
        break;
      }
    }
    if (eq < 0) throw new Exit2(`error: parse ${searchLine + 1}`);
    let rep = -1;
    for (let k = eq + 1; k < lines.length; k++) {
      if (lines[k]!.trimEnd() === '>>>>>>> REPLACE') {
        rep = k;
        break;
      }
    }
    if (rep < 0) throw new Exit2(`error: parse ${searchLine + 1}`);
    const oldLines = lines.slice(searchLine + 1, eq);
    const newLines = lines.slice(eq + 1, rep);
    edits.push(searchReplaceEdit(path, oldLines, newLines, strict));
    prevPath = path;
    prevEnd = rep + 1;
    i = rep + 1;
  }
  return edits;
}

function searchReplaceEdit(path: string, oldLines: string[], newLines: string[], strict: boolean): Edit {
  return (tree) => {
    if (!safe(path)) throw new Fail('unsafe', path);
    if (oldLines.length === 0) {
      if (tree.get(path) !== null) throw new Fail('exists', path);
      tree.now.set(path, newLines.length === 0 ? '' : newLines.join('\n') + '\n');
      return;
    }
    const before = tree.get(path);
    if (before === null) throw new Fail('missing', path);
    const doc = splitDoc(before);
    const tiers = strict ? [0] : [0, 1, 2];
    const found = findMatch(doc.lines, oldLines, tiers, 0, false);
    if (found === null) throw new Fail('no-match', path);
    if (found.positions.length > 1) throw new Fail('ambiguous', path);
    const pos = found.positions[0]!;
    const ops: Op[] = [
      ...oldLines.map((t): Op => ({ kind: 'del', text: t, bs: false })),
      ...newLines.map((t): Op => ({ kind: 'add', text: t, bs: false })),
    ];
    const rep = buildReplacement(ops, doc.lines, pos, found.tier);
    doc.lines.splice(pos, oldLines.length, ...rep);
    tree.now.set(path, joinDoc(doc));
  };
}

// ---------------------------------------------------------- V4A (sec 8)

interface Chunk {
  anchor: string | null;
  ops: Op[];
  eof: boolean;
}

const V4A_HEADERS = ['*** Add File: ', '*** Delete File: ', '*** Update File: '] as const;
const trimSpaces = (s: string): string => s.replace(/^ +/, '').replace(/ +$/, '');

function parseV4a(lines: string[], strict: boolean): Edit[] {
  const first = lines.findIndex((l) => !blank(l));
  if (first < 0) throw new Exit2('error: parse 1');
  if (lines[first]!.trim() !== '*** Begin Patch') throw new Exit2(`error: parse ${first + 1}`);
  let last = -1;
  for (let k = lines.length - 1; k >= 0; k--) {
    if (!blank(lines[k]!)) {
      last = k;
      break;
    }
  }
  if (lines[last]!.trim() !== '*** End Patch') throw new Exit2(`error: parse ${lines.length + 1}`);
  const headerKind = (l: string): number => {
    for (let k = 0; k < V4A_HEADERS.length; k++) {
      if (l.startsWith(V4A_HEADERS[k]!)) return k;
    }
    return -1;
  };
  const edits: Edit[] = [];
  let i = first + 1;
  while (i < last) {
    const line = lines[i]!;
    if (blank(line)) {
      i += 1;
      continue;
    }
    const kind = headerKind(line);
    if (kind < 0) throw new Exit2(`error: parse ${i + 1}`);
    const headerLine = i + 1;
    const path = trimSpaces(line.slice(V4A_HEADERS[kind]!.length));
    let j = i + 1;
    while (j < last && headerKind(lines[j]!) < 0) j += 1;
    const raw = lines.slice(i + 1, j);
    let end = raw.length;
    while (end > 0 && blank(raw[end - 1]!)) end -= 1;
    const secLines = raw.slice(0, end);
    if (kind === 0) {
      const fileLines: string[] = [];
      for (let k = 0; k < secLines.length; k++) {
        const l = secLines[k]!;
        if (l.startsWith('+')) fileLines.push(l.slice(1));
        else if (l === '') fileLines.push('');
        else throw new Exit2(`error: parse ${i + 2 + k}`);
      }
      edits.push((tree) => {
        if (!safe(path)) throw new Fail('unsafe', path);
        if (tree.get(path) !== null) throw new Fail('exists', path);
        tree.now.set(path, fileLines.length === 0 ? '' : fileLines.join('\n') + '\n');
      });
    } else if (kind === 1) {
      if (secLines.length > 0) throw new Exit2(`error: parse ${i + 2}`);
      edits.push((tree) => {
        if (!safe(path)) throw new Fail('unsafe', path);
        if (tree.get(path) === null) throw new Fail('missing', path);
        tree.now.set(path, null);
      });
    } else {
      let moveTo: string | null = null;
      let rest = secLines;
      let restBase = i + 2;
      if (rest.length > 0 && rest[0]!.startsWith('*** Move to: ')) {
        moveTo = trimSpaces(rest[0]!.slice('*** Move to: '.length));
        rest = rest.slice(1);
        restBase += 1;
      }
      const chunks: Chunk[] = [];
      let cur: Chunk | null = null;
      for (let k = 0; k < rest.length; k++) {
        const l = rest[k]!;
        const ln = restBase + k;
        if (l === '*** End of File') {
          if (cur === null) throw new Exit2(`error: parse ${ln}`);
          cur.eof = true;
          chunks.push(cur);
          cur = null;
        } else if (l.startsWith('@@')) {
          if (cur !== null) chunks.push(cur);
          const anchorText = trimSpaces(l.slice(2));
          cur = { anchor: anchorText === '' ? null : anchorText, ops: [], eof: false };
        } else if (l.startsWith(' ') || l.startsWith('-') || l.startsWith('+') || l === '') {
          if (cur === null) cur = { anchor: null, ops: [], eof: false };
          if (l.startsWith(' ')) cur.ops.push({ kind: 'ctx', text: l.slice(1), bs: false });
          else if (l.startsWith('-')) cur.ops.push({ kind: 'del', text: l.slice(1), bs: false });
          else if (l.startsWith('+')) cur.ops.push({ kind: 'add', text: l.slice(1), bs: false });
          else cur.ops.push({ kind: 'ctx', text: '', bs: false });
        } else {
          throw new Exit2(`error: parse ${ln}`);
        }
      }
      if (cur !== null) chunks.push(cur);
      if (chunks.length === 0 && moveTo === null) throw new Exit2(`error: parse ${headerLine}`);
      edits.push(v4aUpdateEdit(path, moveTo, chunks, strict));
    }
    i = j;
  }
  return edits;
}

function v4aUpdateEdit(path: string, moveTo: string | null, chunks: Chunk[], strict: boolean): Edit {
  return (tree) => {
    if (!safe(path)) throw new Fail('unsafe', path);
    if (moveTo !== null && !safe(moveTo)) throw new Fail('unsafe', moveTo);
    const before = tree.get(path);
    if (before === null) throw new Fail('missing', path);
    if (moveTo !== null && tree.get(moveTo) !== null) throw new Fail('exists', moveTo);
    const doc = splitDoc(before);
    const tiers = strict ? [0] : [0, 1, 2];
    let cursor = 0;
    for (const ch of chunks) {
      if (ch.anchor !== null) {
        let foundAt = -1;
        for (const t of tiers) {
          const ak = lineKey(ch.anchor, t);
          for (let k = cursor; k < doc.lines.length; k++) {
            if (lineKey(doc.lines[k]!, t) === ak) {
              foundAt = k;
              break;
            }
          }
          if (foundAt >= 0) break;
        }
        if (foundAt < 0) throw new Fail('no-match', path);
        cursor = foundAt + 1;
      }
      const oLines = ch.ops.filter((o) => o.kind !== 'add').map((o) => o.text);
      const nLines = ch.ops.filter((o) => o.kind !== 'del').map((o) => o.text);
      if (oLines.length === 0) {
        const pos = ch.eof ? doc.lines.length : cursor;
        doc.lines.splice(pos, 0, ...nLines);
        cursor = pos + nLines.length;
      } else {
        const found = findMatch(doc.lines, oLines, tiers, cursor, ch.eof);
        if (found === null) throw new Fail('no-match', path);
        const pos = found.positions[0]!;
        const rep = buildReplacement(ch.ops, doc.lines, pos, found.tier);
        doc.lines.splice(pos, oLines.length, ...rep);
        cursor = pos + rep.length;
      }
    }
    const out = joinDoc(doc);
    if (moveTo !== null) {
      tree.now.set(path, null);
      tree.now.set(moveTo, out);
      tree.moves.push([path, moveTo]);
    } else {
      tree.now.set(path, out);
    }
  };
}

// ---------------------------------------------------------- JSON (sec 9)

/** One JSON edit object, or null when it is not one. */
function jsonEdit(v: unknown): Edit | null {
  if (v === null || typeof v !== 'object' || Array.isArray(v)) return null;
  const o = v as Record<string, unknown>;
  if (typeof o.path !== 'string') return null;
  const p = o.path;
  if (o.command === 'create' && typeof o.file_text === 'string') {
    const text = o.file_text;
    return (tree) => {
      if (!safe(p)) throw new Fail('unsafe', p);
      if (tree.get(p) !== null) throw new Fail('exists', p);
      tree.now.set(p, text);
    };
  }
  if (
    o.command === 'str_replace' &&
    typeof o.old_str === 'string' &&
    o.old_str !== '' &&
    (o.new_str === undefined || typeof o.new_str === 'string')
  ) {
    const oldStr = o.old_str;
    const newStr = (o.new_str as string | undefined) ?? '';
    return (tree) => {
      if (!safe(p)) throw new Fail('unsafe', p);
      const before = tree.get(p);
      if (before === null) throw new Fail('missing', p);
      const nl = before.indexOf('\n');
      const crlf = nl > 0 && before[nl - 1] === '\r';
      const lf = (s: string): string => (crlf ? s.replaceAll('\r\n', '\n') : s);
      const t = lf(before);
      const old = lf(oldStr);
      let count = 0;
      let at = -1;
      for (let k = t.indexOf(old); k >= 0; k = t.indexOf(old, k + 1)) {
        if (at < 0) at = k;
        count += 1;
      }
      if (count === 0) throw new Fail('no-match', p);
      if (count > 1) throw new Fail('ambiguous', p);
      const out = t.slice(0, at) + lf(newStr) + t.slice(at + old.length);
      tree.now.set(p, crlf ? out.replaceAll('\n', '\r\n') : out);
    };
  }
  if (
    o.command === 'insert' &&
    typeof o.insert_line === 'number' &&
    Number.isInteger(o.insert_line) &&
    typeof o.new_str === 'string'
  ) {
    const line = o.insert_line;
    const add = patchLines(o.new_str);
    return (tree) => {
      if (!safe(p)) throw new Fail('unsafe', p);
      const before = tree.get(p);
      if (before === null) throw new Fail('missing', p);
      const doc = splitDoc(before);
      if (line < 0 || line > doc.lines.length) throw new Fail('no-match', p);
      doc.lines.splice(line, 0, ...add);
      tree.now.set(p, joinDoc(doc));
    };
  }
  return null;
}

function parseJson(text: string, lines: string[]): Edit[] {
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
  lines.forEach((l, idx) => {
    if (blank(l)) return;
    let e: Edit | null = null;
    try {
      e = jsonEdit(JSON.parse(l));
    } catch {
      e = null;
    }
    if (e === null) throw new Exit2(`error: parse ${idx + 1}`);
    edits.push(e);
  });
  return edits;
}

// -------------------------------------------------- invocation (secs 1-3, 10)

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
        const v = a.slice('--format='.length);
        if (!FORMATS.includes(v)) return { code: 2, out: ['error: usage'] };
        format = v;
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
    if (kind === 'json') edits = parseJson(text, lines);
    else if (kind === 'unified') edits = parseUnified(lines, strict);
    else if (kind === 'search-replace') edits = parseSearchReplace(lines, strict);
    else edits = parseV4a(lines, strict);
    if (edits.length === 0) throw new Exit2('error: parse 1');
  } catch (e) {
    if (e instanceof Exit2) return { code: 2, out: [e.line] };
    throw e;
  }
  const tree = new Tree();
  const fails: Fail[] = [];
  for (const edit of edits) {
    const beforeNow = new Map(tree.now);
    const beforeMoves = tree.moves.length;
    try {
      edit(tree);
    } catch (e) {
      if (!(e instanceof Fail)) throw e;
      tree.now.clear();
      for (const [k, v] of beforeNow) tree.now.set(k, v);
      tree.moves.length = beforeMoves;
      fails.push(e);
    }
  }
  if (fails.length > 0) {
    return {
      code: 1,
      out: [...fails.map((f) => `error: ${f.code} ${f.path}`), `failed: ${fails.length} of ${edits.length} edits`],
    };
  }
  // A move that succeeded, whose old path existed before and does not after and
  // whose new path did not exist before and does after, is one `R` line in
  // place of that pair's `D` and `A` lines, sorting by the new path.
  const suppressed = new Set<string>();
  const rows: Array<{ key: string; line: string }> = [];
  for (const [oldP, newP] of tree.moves) {
    const oldBefore = tree.original(oldP);
    const oldAfter = tree.now.has(oldP) ? tree.now.get(oldP)! : tree.original(oldP);
    const newBefore = tree.original(newP);
    const newAfter = tree.now.has(newP) ? tree.now.get(newP)! : tree.original(newP);
    if (oldBefore !== null && oldAfter === null && newBefore === null && newAfter !== null) {
      rows.push({ key: newP, line: `R ${oldP} -> ${newP}` });
      suppressed.add(oldP);
      suppressed.add(newP);
    }
  }
  for (const p of tree.now.keys()) {
    if (suppressed.has(p)) continue;
    const was = tree.original(p);
    const now = tree.now.get(p)!;
    if (was === now) continue;
    rows.push({ key: p, line: `${was === null ? 'A' : now === null ? 'D' : 'M'} ${p}` });
  }
  rows.sort((a, b) => cmpBytes(a.key, b.key));
  if (!check) {
    const paths = [...tree.now.keys()].sort(cmpBytes);
    for (const p of paths) {
      const was = tree.original(p);
      const now = tree.now.get(p)!;
      if (was === now) continue;
      if (now === null) {
        rmSync(p, { force: true });
      } else {
        mkdirSync(dirname(p), { recursive: true });
        writeFileSync(p, now);
      }
    }
  }
  return { code: 0, out: [...rows.map((r) => r.line), `ok: ${rows.length} ${rows.length === 1 ? 'file' : 'files'}`] };
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
