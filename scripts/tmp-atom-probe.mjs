// Usage: node scripts/tmp-atom-probe.mjs <token> <videoId> ...
const [token, ...ids] = process.argv.slice(2);

function atoms(buf, label) {
  const out = [];
  let off = 0;
  while (off + 8 <= buf.length && out.length < 6) {
    let size = buf.readUInt32BE(off);
    const type = buf.toString('latin1', off + 4, off + 4 + 4);
    if (size === 1) {
      // 64-bit size
      const hi = buf.readUInt32BE(off + 8);
      const lo = buf.readUInt32BE(off + 12);
      size = hi * 2 ** 32 + lo;
      out.push(`${type}@${off}(64b,${size})`);
      break; // 64-bit sizes only appear for huge mdat; stop after
    }
    if (size < 8 || size > 4 * 1024 ** 3) {
      out.push(`${type}@${off}(bad-size-${size})`);
      break;
    }
    out.push(`${type}@${off}(${size})`);
    off += size;
  }
  console.log(`  ${label}: ${out.join(' ')}`);
}

for (const id of ids) {
  const base = `http://localhost:3000/api/media/${id}`;
  const h = await fetch(base, { method: 'HEAD', headers: { cookie: `session_token=${token}` } });
  const size = Number(h.headers.get('content-length'));
  const ct = h.headers.get('content-type');
  const path = h.headers.get('x-media-path');
  console.log(`video ${id}: ct=${ct} size=${size} path=${path}`);

  const head = Buffer.from(await (await fetch(`${base}/0-4095`, { headers: { cookie: `session_token=${token}`, range: 'bytes=0-4095' } })).arrayBuffer());
  console.log(`  head ${head.length}B:`);
  atoms(head, 'top');

  const tailLen = Math.min(512 * 1024, size);
  const tail = Buffer.from(await (await fetch(`${base}/${size - tailLen}-${size - 1}`, { headers: { cookie: `session_token=${token}`, range: `bytes=${size - tailLen}-${size - 1}` } })).arrayBuffer());
  const moovIdx = tail.indexOf('moov');
  const hasMoov = moovIdx >= 0;
  console.log(`  tail ${tail.length}B: moov-in-tail=${hasMoov ? `YES at tail+${moovIdx}` : 'no'}`);
  if (hasMoov) {
    // parse from moov backwards: find its 32-bit size field
    const moovSize = tail.readUInt32BE(moovIdx - 4);
    console.log(`  moov size=${moovSize} => moov starts at file offset ~${size - tailLen + moovIdx - 4} of ${size} (${(((size - tailLen + moovIdx - 4) / size) * 100).toFixed(1)}%)`);
  }
  const mdatIdx = head.indexOf('mdat');
  console.log(`  mdat-in-head=${mdatIdx >= 0 ? `YES at head+${mdatIdx}` : 'no'}`);
}
