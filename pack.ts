// Packfile codec and pkt-line framing for forge-prime.
// Reading uses plain inflateSync (fast path); writing deflates each object
// once at level 1 and caches the packed bytes on the object itself.
import { createHash } from 'node:crypto';
import { inflateSync, deflateSync } from 'node:zlib';
import { KIND_NUM, NUM_KIND, oidOf } from './core.ts';

function expandDelta(base, delta) {
  let pos = 0;
  const readVar = () => {
    let v = 0, shift = 0, byte;
    do { byte = delta[pos++]; v += (byte & 0x7f) * 2 ** shift; shift += 7; } while (byte & 0x80);
    return v;
  };
  if (readVar() !== base.length) throw new Error('delta base size mismatch');
  const want = readVar();
  const out = Buffer.allocUnsafe(want);
  let at = 0;
  while (pos < delta.length) {
    const op = delta[pos++];
    if (op & 0x80) {
      let off = 0, size = 0;
      if (op & 0x01) off = delta[pos++];
      if (op & 0x02) off |= delta[pos++] << 8;
      if (op & 0x04) off |= delta[pos++] << 16;
      if (op & 0x08) off += delta[pos++] * 0x1000000;
      if (op & 0x10) size = delta[pos++];
      if (op & 0x20) size |= delta[pos++] << 8;
      if (op & 0x40) size |= delta[pos++] << 16;
      if (size === 0) size = 0x10000;
      base.copy(out, at, off, off + size);
      at += size;
    } else if (op) {
      delta.copy(out, at, pos, pos + op);
      pos += op; at += op;
    } else throw new Error('delta opcode 0');
  }
  if (at !== want) throw new Error('delta result size mismatch');
  return out;
}

export function parsePack(buf, lookup) {
  if (buf.length < 32 || buf.latin1Slice(0, 4) !== 'PACK') throw new Error('not a packfile');
  const version = buf.readUInt32BE(4);
  if (version !== 2 && version !== 3) throw new Error('unsupported pack version ' + version);
  const count = buf.readUInt32BE(8);
  const digest = createHash('sha1').update(buf.subarray(0, buf.length - 20)).digest();
  if (!digest.equals(buf.subarray(buf.length - 20))) throw new Error('pack checksum mismatch');
  const end = buf.length - 20;
  const byOffset = new Map(), byOid = new Map(), done = [], waiting = [];
  let pos = 12;
  for (let i = 0; i < count; i++) {
    const start = pos;
    let byte = buf[pos++];
    const typeNum = (byte >> 4) & 7;
    while (byte & 0x80) byte = buf[pos++];
    let baseOffset = -1, baseOid = null;
    if (typeNum === 6) {
      byte = buf[pos++];
      let off = byte & 0x7f;
      while (byte & 0x80) { byte = buf[pos++]; off = (off + 1) * 128 + (byte & 0x7f); }
      baseOffset = start - off;
    } else if (typeNum === 7) {
      baseOid = buf.hexSlice(pos, pos + 20);
      pos += 20;
    } else if (typeNum < 1 || typeNum > 4) throw new Error('bad pack object type ' + typeNum);
    // The receive path needs the consumed byte count, so it pays for the
    // info variant here; the fetch hot path never inflates at all.
    const probe = inflateSync(buf.subarray(pos, end), { info: true });
    const data = probe.buffer;
    pos += probe.engine.bytesWritten;
    if (typeNum <= 4) {
      const kind = NUM_KIND[typeNum];
      const entry = { kind, data, oid: oidOf(kind, data) };
      byOffset.set(start, entry); byOid.set(entry.oid, entry); done.push(entry);
    } else waiting.push({ start, baseOffset, baseOid, delta: data });
  }
  let todo = waiting;
  while (todo.length) {
    const rest = [];
    for (const d of todo) {
      let base = d.baseOffset >= 0 ? byOffset.get(d.baseOffset) : byOid.get(d.baseOid);
      if (!base && d.baseOid && lookup) base = lookup(d.baseOid);
      if (!base) { rest.push(d); continue; }
      const data = expandDelta(base.data, d.delta);
      const entry = { kind: base.kind, data, oid: oidOf(base.kind, data) };
      byOffset.set(d.start, entry); byOid.set(entry.oid, entry); done.push(entry);
    }
    if (rest.length === todo.length) throw new Error('unresolvable delta base');
    todo = rest;
  }
  return done;
}

export function packedBytes(obj) {
  if (obj.packed) return obj.packed;
  const size = obj.data.length;
  const head = [];
  let byte = (KIND_NUM[obj.kind] << 4) | (size & 0x0f);
  let rest = Math.floor(size / 16);
  while (rest > 0) { head.push(byte | 0x80); byte = rest & 0x7f; rest = Math.floor(rest / 128); }
  head.push(byte);
  obj.packed = Buffer.concat([Buffer.from(head), deflateSync(obj.data, { level: 1 })]);
  return obj.packed;
}
export function buildPack(objs) {
  const header = Buffer.alloc(12);
  header.write('PACK', 0, 'latin1');
  header.writeUInt32BE(2, 4);
  header.writeUInt32BE(objs.length, 8);
  const hash = createHash('sha1');
  hash.update(header);
  const parts = [header];
  for (const o of objs) { const z = packedBytes(o); hash.update(z); parts.push(z); }
  parts.push(hash.digest());
  return Buffer.concat(parts);
}

const HEXD = '0123456789abcdef';
export const FLUSH_PKT = Buffer.from('0000');
export const DELIM_PKT = Buffer.from('0001');
export function pktLine(payload) {
  const body = typeof payload === 'string' ? Buffer.from(payload, 'utf8') : payload;
  const n = body.length + 4;
  const out = Buffer.allocUnsafe(n);
  out[0] = HEXD.charCodeAt((n >> 12) & 15);
  out[1] = HEXD.charCodeAt((n >> 8) & 15);
  out[2] = HEXD.charCodeAt((n >> 4) & 15);
  out[3] = HEXD.charCodeAt(n & 15);
  body.copy(out, 4);
  return out;
}
export function bandFrame(band, data, parts) {
  const MAX = 65515;
  for (let at = 0; at < data.length; at += MAX) {
    const chunk = data.subarray(at, Math.min(data.length, at + MAX));
    const n = chunk.length + 5;
    const head = Buffer.allocUnsafe(5);
    head[0] = HEXD.charCodeAt((n >> 12) & 15);
    head[1] = HEXD.charCodeAt((n >> 8) & 15);
    head[2] = HEXD.charCodeAt((n >> 4) & 15);
    head[3] = HEXD.charCodeAt(n & 15);
    head[4] = band;
    parts.push(head, chunk);
  }
}
export function readPktLines(buf, pos) {
  const items = [];
  for (;;) {
    if (pos + 4 > buf.length) throw new Error('truncated pkt-line');
    const raw = buf.latin1Slice(pos, pos + 4);
    const len = parseInt(raw, 16);
    if (!/^[0-9a-fA-F]{4}$/.test(raw)) throw new Error('bad pkt-line length');
    if (len === 0) return { items, next: pos + 4 };
    if (len === 1) { items.push('delim'); pos += 4; continue; }
    if (len < 4 || pos + len > buf.length) throw new Error('bad pkt-line length');
    items.push(buf.utf8Slice(pos + 4, pos + len));
    pos += len;
  }
}
