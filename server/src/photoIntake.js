// Photo intake, shared by every route that accepts an image: the family
// slideshow and the coral journal both need the same conversion, the same
// size cap and — most of all — the same messages when a phone hands over
// something the terminal cannot read.

export const PHOTO_EXTENSIONS = new Set(['.jpg', '.jpeg', '.png', '.webp', '.gif'])
// iPhones hand these over whenever the picker doesn't transcode for us. Nothing
// on the kiosk can display them, so they're converted on the way in.
export const CONVERTED_EXTENSIONS = new Set(['.heic', '.heif'])
// Long edge kept for the slideshow. A 12 MP phone photo is ~4000px and eight
// times the size of anything the panel can show; the SD card notices.
const MAX_PHOTO_EDGE = 2560
const PHOTO_JPEG_QUALITY = 82

// sharp is an optional dependency: it ships prebuilt binaries for the Pi, but
// a unit where the native install failed should still accept ordinary JPEGs
// rather than refusing every upload.
let sharpModule
function loadSharp() {
  if (!sharpModule) sharpModule = import('sharp').then((m) => m.default).catch(() => null)
  return sharpModule
}

// Returns the bytes to store and the extension to store them under, or throws
// with a message written for whoever is holding the phone.
export async function processPhoto(buffer, ext) {
  // Animated GIFs are left alone — re-encoding one loses the animation.
  if (ext === '.gif') return { buffer, ext }
  const needsConversion = CONVERTED_EXTENSIONS.has(ext)

  const sharp = await loadSharp()
  if (!sharp) {
    if (needsConversion) {
      throw new Error('this terminal can\'t convert iPhone (HEIC) photos — on the phone, Settings → Camera → Formats → Most Compatible, or send them as JPEG')
    }
    return { buffer, ext }
  }

  let image = sharp(buffer, { failOn: 'none' })
  let meta
  try {
    meta = await image.metadata()
  } catch {
    throw new Error(needsConversion
      ? 'this photo is in a format the terminal can\'t read — try sharing it as a JPEG'
      : 'that image looks damaged')
  }

  const longEdge = Math.max(meta.width ?? 0, meta.height ?? 0)
  const oversized = longEdge > MAX_PHOTO_EDGE
  if (!needsConversion && !oversized) return { buffer, ext }

  // rotate() with no argument applies the EXIF orientation and drops the tag,
  // which matters once the pixels are re-encoded.
  image = image.rotate()
  if (oversized) image = image.resize({ width: MAX_PHOTO_EDGE, height: MAX_PHOTO_EDGE, fit: 'inside', withoutEnlargement: true })

  // Converted photos become JPEG; everything else keeps its own format so a
  // transparent PNG stays transparent.
  const outExt = needsConversion ? '.jpg' : ext
  if (outExt === '.png') image = image.png()
  else if (outExt === '.webp') image = image.webp()
  else image = image.jpeg({ quality: PHOTO_JPEG_QUALITY, mozjpeg: true })

  try {
    return { buffer: await image.toBuffer(), ext: outExt }
  } catch {
    // HEIC decoding depends on how libvips was built (the prebuilt binaries
    // carry no HEVC decoder), so this is the likely landing spot for an
    // iPhone original on a stock install.
    throw new Error(needsConversion
      ? 'this terminal can\'t convert iPhone (HEIC) photos — on the phone, Settings → Camera → Formats → Most Compatible, or send them as JPEG'
      : 'that image couldn\'t be processed')
  }
}
