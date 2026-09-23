// The coral journal: what is in the tank, and what it looked like on the way.
//
// Every other record here is a number. This one is the reason people keep the
// tank at all, and it is the thing no parameter chart can show — a colony that
// doubled in a year and one that has not moved in a year produce identical
// alkalinity graphs.
//
// Photos arrive from a phone, because that is what is in your hand at the
// glass. They go through the same intake as the family slideshow: same
// conversion, same size cap, same wording when an iPhone hands over something
// the terminal cannot read.

import fs from 'node:fs'
import path from 'node:path'
import crypto from 'node:crypto'

import { PHOTO_EXTENSIONS, CONVERTED_EXTENSIONS, processPhoto } from '../photoIntake.js'

function text(v, max = 120) {
  const s = String(v ?? '').trim()
  return s ? s.slice(0, max) : null
}

function num(v) {
  const n = Number(v)
  return Number.isFinite(n) ? n : null
}

export default async function coralRoutes(app, { config, db }) {
  const coralDir = path.join(path.dirname(config.db), 'corals')
  fs.mkdirSync(coralDir, { recursive: true })

  const photosOf = db.prepare('SELECT id, ts, file, note FROM coral_photos WHERE coral_id = ? ORDER BY ts')

  // A coral is worth showing with its first and its latest photo side by side —
  // that pair is the whole feature, so the list carries both rather than making
  // the display fetch every coral's history to draw a grid.
  const summarise = (coral) => {
    const photos = photosOf.all(coral.id)
    return {
      ...coral,
      photoCount: photos.length,
      first: photos[0] ?? null,
      latest: photos[photos.length - 1] ?? null,
      // Days between the two, which is the only honest measure of growth this
      // can offer: the terminal cannot size a colony from a photograph.
      spanDays: photos.length > 1
        ? Math.round((photos[photos.length - 1].ts - photos[0].ts) / 86400000)
        : 0
    }
  }

  app.get('/api/corals', async (req) => {
    const rows = db
      .prepare(`SELECT * FROM corals ${req.query.all ? '' : 'WHERE archived_at IS NULL'} ORDER BY name COLLATE NOCASE`)
      .all()
    return { corals: rows.map(summarise) }
  })

  app.get('/api/corals/:id', async (req, reply) => {
    const coral = db.prepare('SELECT * FROM corals WHERE id = ?').get(Number(req.params.id))
    if (!coral) return reply.code(404).send({ error: 'No such coral.' })
    return { coral: { ...coral, photos: photosOf.all(coral.id) } }
  })

  app.post('/api/corals', async (req, reply) => {
    const name = text(req.body?.name, 60)
    if (!name) return reply.code(400).send({ error: 'A name is needed.' })
    const info = db
      .prepare('INSERT INTO corals (name, species, source, added_at, note) VALUES (?, ?, ?, ?, ?)')
      .run(name, text(req.body?.species, 80), text(req.body?.source, 80),
        num(req.body?.addedAt) ?? Date.now(), text(req.body?.note, 400))
    return { ok: true, id: info.lastInsertRowid, name }
  })

  app.patch('/api/corals/:id', async (req, reply) => {
    const id = Number(req.params.id)
    const coral = db.prepare('SELECT * FROM corals WHERE id = ?').get(id)
    if (!coral) return reply.code(404).send({ error: 'No such coral.' })

    const next = {
      name: req.body?.name !== undefined ? text(req.body.name, 60) ?? coral.name : coral.name,
      species: req.body?.species !== undefined ? text(req.body.species, 80) : coral.species,
      source: req.body?.source !== undefined ? text(req.body.source, 80) : coral.source,
      note: req.body?.note !== undefined ? text(req.body.note, 400) : coral.note,
      added_at: req.body?.addedAt !== undefined ? num(req.body.addedAt) : coral.added_at,
      // Archiving is a toggle rather than a delete, and un-archiving has to be
      // possible: "it recovered" happens.
      archived_at: req.body?.archived === undefined
        ? coral.archived_at
        : (req.body.archived ? (coral.archived_at ?? Date.now()) : null)
    }
    db.prepare(
      'UPDATE corals SET name = ?, species = ?, source = ?, note = ?, added_at = ?, archived_at = ? WHERE id = ?'
    ).run(next.name, next.species, next.source, next.note, next.added_at, next.archived_at, id)
    return { ok: true }
  })

  // Deleting takes the photos with it — both the rows, by cascade, and the
  // files, which nothing else would ever clean up.
  app.delete('/api/corals/:id', async (req) => {
    const id = Number(req.params.id)
    for (const photo of photosOf.all(id)) {
      try { fs.unlinkSync(path.join(coralDir, photo.file)) } catch { /* already gone */ }
    }
    db.prepare('DELETE FROM corals WHERE id = ?').run(id)
    return { ok: true }
  })

  // ── photos ───────────────────────────────────────────────────────────────

  app.post('/api/corals/:id/photos', async (req, reply) => {
    const id = Number(req.params.id)
    const coral = db.prepare('SELECT * FROM corals WHERE id = ?').get(id)
    if (!coral) return reply.code(404).send({ error: 'No such coral.' })

    const added = []
    const skipped = []
    // req.files() yields only the file parts, and any other field in the same
    // form is silently dropped — which is how a photo dated last spring came
    // in stamped today. Walk every part, keep the fields, and hold the files
    // until the whole form has been read: a `ts` sent after the photo has to
    // still apply to it.
    const fields = {}
    const pending = []
    for await (const part of req.parts()) {
      if (part.type === 'field') {
        fields[part.fieldname] = part.value
        continue
      }
      const filename = part.filename ?? 'photo'
      const ext = path.extname(filename).toLowerCase()
      if (!PHOTO_EXTENSIONS.has(ext) && !CONVERTED_EXTENSIONS.has(ext)) {
        part.file.resume()
        skipped.push({ name: filename, reason: 'not a photo' })
        continue
      }

      let raw
      try {
        raw = await part.toBuffer()
      } catch (err) {
        skipped.push({
          name: filename,
          reason: /too large|limit/i.test(String(err.message)) ? 'bigger than 25 MB' : 'could not be read'
        })
        continue
      }

      let processed
      try {
        processed = await processPhoto(raw, ext)
      } catch (err) {
        skipped.push({ name: filename, reason: err.message })
        continue
      }

      pending.push(processed)
    }

    const ts = num(fields.ts) ?? Date.now()
    for (const processed of pending) {
      // Named by the date it records, so the directory is readable on its own,
      // and salted so two photos of one coral on one day cannot collide.
      const stamp = new Date(ts).toISOString().slice(0, 10)
      const file = `coral-${id}-${stamp}-${crypto.randomBytes(3).toString('hex')}${processed.ext}`
      await fs.promises.writeFile(path.join(coralDir, file), processed.buffer)
      const info = db
        .prepare('INSERT INTO coral_photos (coral_id, ts, file, note) VALUES (?, ?, ?, ?)')
        .run(id, ts, file, null)
      added.push({ id: info.lastInsertRowid, ts, file })
    }

    if (!added.length) {
      return reply.code(400).send({ error: skipped[0]?.reason ?? 'No photo arrived.', skipped })
    }
    return { ok: true, added, skipped, coral: coral.name }
  })

  app.delete('/api/corals/:id/photos/:photoId', async (req, reply) => {
    const photo = db
      .prepare('SELECT * FROM coral_photos WHERE id = ? AND coral_id = ?')
      .get(Number(req.params.photoId), Number(req.params.id))
    if (!photo) return reply.code(404).send({ error: 'No such photo.' })
    try { fs.unlinkSync(path.join(coralDir, photo.file)) } catch { /* already gone */ }
    db.prepare('DELETE FROM coral_photos WHERE id = ?').run(photo.id)
    return { ok: true }
  })
}
