// Minimal RFC 6455 server side (text frames, ping/pong, close). Zero dependencies.
import { createHash } from 'node:crypto';

const GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11';
export const acceptKey = (key) => createHash('sha1').update(key + GUID).digest('base64');

export function encodeFrame(opcode, payload) {
  const body = Buffer.isBuffer(payload) ? payload : Buffer.from(payload);
  const n = body.length;
  const head = n < 126 ? Buffer.from([0x80 | opcode, n])
    : n < 65536 ? Buffer.from([0x80 | opcode, 126, n >> 8, n & 255])
    : (() => { const b = Buffer.alloc(10); b[0] = 0x80 | opcode; b[1] = 127; b.writeBigUInt64BE(BigInt(n), 2); return b; })();
  return Buffer.concat([head, body]);
}

// Incremental decoder. push(chunk) returns [{opcode, payload}] for each complete frame.
// Client frames must be masked (RFC 6455 5.1); an unmasked or oversized frame throws.
export class FrameDecoder {
  constructor(maxPayload = 1 << 20) { this.buf = Buffer.alloc(0); this.max = maxPayload; this.frag = null; }
  push(chunk) {
    this.buf = Buffer.concat([this.buf, chunk]);
    const out = [];
    for (;;) {
      const b = this.buf;
      if (b.length < 2) break;
      const fin = !!(b[0] & 0x80), opcode = b[0] & 0x0f, masked = !!(b[1] & 0x80);
      let len = b[1] & 0x7f, off = 2;
      if (len === 126) { if (b.length < 4) break; len = b.readUInt16BE(2); off = 4; }
      else if (len === 127) { if (b.length < 10) break; len = Number(b.readBigUInt64BE(2)); off = 10; }
      if (!masked) throw new Error('unmasked client frame');
      if (len > this.max) throw new Error('frame too large');
      if (b.length < off + 4 + len) break;
      const mask = b.subarray(off, off + 4);
      const data = Buffer.from(b.subarray(off + 4, off + 4 + len));
      for (let i = 0; i < data.length; i++) data[i] ^= mask[i & 3];
      this.buf = b.subarray(off + 4 + len);
      if (opcode === 0x0 || opcode === 0x1 || opcode === 0x2) {
        // continuation handling: opcode 0 appends to the pending data frame
        if (opcode !== 0x0) this.frag = { opcode, parts: [] };
        if (!this.frag) throw new Error('stray continuation');
        this.frag.parts.push(data);
        if (fin) { out.push({ opcode: this.frag.opcode, payload: Buffer.concat(this.frag.parts) }); this.frag = null; }
      } else out.push({ opcode, payload: data });
    }
    return out;
  }
}

// Completes the upgrade on `socket`; returns {send(text), close(code), onMessage, onClose} wrapper.
export function accept(req, socket, { onMessage, onClose, pingMs = 25000 } = {}) {
  const key = req.headers['sec-websocket-key'];
  if (!key || (req.headers.upgrade || '').toLowerCase() !== 'websocket') { socket.destroy(); return null; }
  socket.write(['HTTP/1.1 101 Switching Protocols', 'Upgrade: websocket', 'Connection: Upgrade',
    `Sec-WebSocket-Accept: ${acceptKey(key)}`, '', ''].join('\r\n'));
  const dec = new FrameDecoder();
  let closed = false;
  const finish = () => { if (closed) return; closed = true; clearInterval(timer); onClose && onClose(); };
  const conn = {
    send: (text) => { if (!closed) socket.write(encodeFrame(0x1, text)); },
    close: (code = 1000) => { if (!closed) { const c = Buffer.alloc(2); c.writeUInt16BE(code); socket.write(encodeFrame(0x8, c)); } socket.end(); finish(); },
  };
  const timer = setInterval(() => { if (!closed) socket.write(encodeFrame(0x9, '')); }, pingMs);
  timer.unref();
  socket.on('data', (chunk) => {
    let frames;
    try { frames = dec.push(chunk); } catch { return conn.close(1002); }
    for (const f of frames) {
      if (f.opcode === 0x1) onMessage && onMessage(f.payload.toString('utf8'), conn);
      else if (f.opcode === 0x9) socket.write(encodeFrame(0xA, f.payload));
      else if (f.opcode === 0x8) { conn.close(1000); }
    }
  });
  socket.on('close', finish);
  socket.on('error', finish);
  return conn;
}
