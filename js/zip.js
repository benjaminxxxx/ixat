// Abre el .zip que exporta WhatsApp y saca el chat (.txt), sin descomprimir nada más.
// Lee solo los trozos necesarios, así un zip con fotos o contactos no llena la memoria del celular.

const END = 0x06054b50, CENTRAL = 0x02014b50, LOCAL = 0x04034b50;
const bytes = async (file, from, to) => new DataView(await file.slice(from, to).arrayBuffer());
const NOT_CHAT = 'No encontré el chat dentro del .zip. ¿Es el archivo exportado de WhatsApp?';

async function inflate(blob) {
  const stream = blob.stream().pipeThrough(new DecompressionStream('deflate-raw'));
  return new Response(stream).arrayBuffer();
}

async function entries(file) {
  const tailStart = Math.max(0, file.size - 65557);
  const tail = await bytes(file, tailStart, file.size);
  let e = tail.byteLength - 22;
  while (e >= 0 && tail.getUint32(e, true) !== END) e--;
  if (e < 0) throw new Error(NOT_CHAT);
  const count = tail.getUint16(e + 10, true), size = tail.getUint32(e + 12, true), start = tail.getUint32(e + 16, true);
  if (count === 0xffff || size === 0xffffffff || start === 0xffffffff) throw new Error('Este .zip es demasiado grande. Exporta el chat "sin archivos".');
  const cd = await bytes(file, start, start + size);
  const names = new TextDecoder();
  const list = [];
  for (let p = 0, i = 0; i < count && p + 46 <= cd.byteLength; i++) {
    if (cd.getUint32(p, true) !== CENTRAL) throw new Error(NOT_CHAT);
    const nameLen = cd.getUint16(p + 28, true), extra = cd.getUint16(p + 30, true), note = cd.getUint16(p + 32, true);
    list.push({
      name: names.decode(new Uint8Array(cd.buffer, cd.byteOffset + p + 46, nameLen)),
      flags: cd.getUint16(p + 8, true), method: cd.getUint16(p + 10, true),
      packed: cd.getUint32(p + 20, true), size: cd.getUint32(p + 24, true), offset: cd.getUint32(p + 42, true),
    });
    p += 46 + nameLen + extra + note;
  }
  return list;
}

// Devuelve { name, text } tanto si eligieron el .txt como el .zip.
export async function readChatFile(file) {
  const sig = await bytes(file, 0, 4);
  if (sig.byteLength < 4 || sig.getUint32(0, true) !== LOCAL) return { name: file.name, text: await file.text() };
  const chat = (await entries(file))
    .filter(x => /\.txt$/i.test(x.name) && !/(^|\/)(__MACOSX|\.)/.test(x.name))
    .sort((a, b) => b.size - a.size)[0];
  if (!chat) throw new Error(NOT_CHAT);
  if (chat.flags & 1) throw new Error('El .zip tiene contraseña.');
  if (chat.method !== 0 && chat.method !== 8) throw new Error('No puedo abrir este tipo de .zip.');
  const head = await bytes(file, chat.offset, chat.offset + 30);
  if (head.getUint32(0, true) !== LOCAL) throw new Error(NOT_CHAT);
  const from = chat.offset + 30 + head.getUint16(26, true) + head.getUint16(28, true);
  const data = file.slice(from, from + chat.packed);
  const raw = chat.method === 8 ? await inflate(data) : await data.arrayBuffer();
  // El nombre del zip dice qué grupo es, aunque adentro se llame "_chat.txt".
  return { name: file.name.replace(/\.zip$/i, '.txt'), text: new TextDecoder().decode(raw) };
}
