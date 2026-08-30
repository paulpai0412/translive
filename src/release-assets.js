const PNG_SIGNATURE = Buffer.from([
  0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a,
]);

function pngDimension(png, offset) {
  const value = png.readUInt32BE(offset);
  if (value < 1 || value > 256) {
    throw new Error("PNG icon dimensions must be between 1 and 256 pixels");
  }
  return value;
}

export function createIcoFromPng(png) {
  if (!Buffer.isBuffer(png) || png.length < 24) {
    throw new Error("PNG icon data is invalid");
  }
  if (!png.subarray(0, 8).equals(PNG_SIGNATURE)) {
    throw new Error("PNG icon signature is invalid");
  }
  if (png.toString("ascii", 12, 16) !== "IHDR") {
    throw new Error("PNG icon header is invalid");
  }
  const width = pngDimension(png, 16);
  const height = pngDimension(png, 20);
  const ico = Buffer.alloc(22 + png.length);
  ico.writeUInt16LE(0, 0);
  ico.writeUInt16LE(1, 2);
  ico.writeUInt16LE(1, 4);
  ico[6] = width === 256 ? 0 : width;
  ico[7] = height === 256 ? 0 : height;
  ico[8] = 0;
  ico[9] = 0;
  ico.writeUInt16LE(1, 10);
  ico.writeUInt16LE(32, 12);
  ico.writeUInt32LE(png.length, 14);
  ico.writeUInt32LE(22, 18);
  png.copy(ico, 22);
  return ico;
}
