// What an ICP result means, and how to get one off a lab report and into the
// database without typing forty numbers on a touchscreen.
//
// The reference figures are natural-seawater values, which is the common
// ground every lab starts from — but ATI, Oceamo and Triton each publish
// slightly different targets and each reports a slightly different element
// set. So these are shown as a reference band, never as a pass/fail: the
// terminal's job is to show the trend and where it sits, not to overrule the
// lab that ran the sample.
//
// `unit` is what the value is stored in. Labs mix mg/L and µg/L freely, and a
// number is meaningless without knowing which — parsing normalises to the unit
// named here.

// kind: 'major'   — dosed, consumed, watched every test
//       'minor'   — present in seawater, worth tracking, rarely dosed
//       'trace'   — wanted in tiny amounts; too much is the problem
//       'watch'   — no biological role here; the reason to run ICP at all
export const ELEMENTS = {
  Ca: { name: 'Calcium', unit: 'mg/L', low: 400, high: 450, kind: 'major' },
  Mg: { name: 'Magnesium', unit: 'mg/L', low: 1250, high: 1400, kind: 'major' },
  K: { name: 'Potassium', unit: 'mg/L', low: 380, high: 420, kind: 'major' },
  Sr: { name: 'Strontium', unit: 'mg/L', low: 7, high: 10, kind: 'major' },
  B: { name: 'Boron', unit: 'mg/L', low: 4, high: 5, kind: 'major' },
  Br: { name: 'Bromine', unit: 'mg/L', low: 60, high: 70, kind: 'minor' },
  S: { name: 'Sulfur', unit: 'mg/L', low: 850, high: 950, kind: 'minor' },
  F: { name: 'Fluorine', unit: 'mg/L', low: 1.1, high: 1.4, kind: 'minor' },
  Li: { name: 'Lithium', unit: 'mg/L', low: 0.15, high: 0.2, kind: 'minor' },
  I: { name: 'Iodine', unit: 'µg/L', low: 30, high: 90, kind: 'minor' },
  Ba: { name: 'Barium', unit: 'µg/L', low: 5, high: 20, kind: 'minor' },
  Mo: { name: 'Molybdenum', unit: 'µg/L', low: 8, high: 14, kind: 'minor' },
  Si: { name: 'Silicon', unit: 'µg/L', low: 0, high: 300, kind: 'trace' },
  Fe: { name: 'Iron', unit: 'µg/L', low: 0, high: 5, kind: 'trace' },
  Mn: { name: 'Manganese', unit: 'µg/L', low: 0, high: 3, kind: 'trace' },
  Zn: { name: 'Zinc', unit: 'µg/L', low: 0, high: 5, kind: 'trace' },
  Ni: { name: 'Nickel', unit: 'µg/L', low: 0, high: 5, kind: 'trace' },
  Co: { name: 'Cobalt', unit: 'µg/L', low: 0, high: 1, kind: 'trace' },
  Cu: { name: 'Copper', unit: 'µg/L', low: 0, high: 2, kind: 'watch' },
  Al: { name: 'Aluminium', unit: 'µg/L', low: 0, high: 5, kind: 'watch' },
  Pb: { name: 'Lead', unit: 'µg/L', low: 0, high: 1, kind: 'watch' },
  Sn: { name: 'Tin', unit: 'µg/L', low: 0, high: 1, kind: 'watch' },
  As: { name: 'Arsenic', unit: 'µg/L', low: 0, high: 3, kind: 'watch' },
  Cd: { name: 'Cadmium', unit: 'µg/L', low: 0, high: 1, kind: 'watch' },
  Hg: { name: 'Mercury', unit: 'µg/L', low: 0, high: 1, kind: 'watch' },
  Cr: { name: 'Chromium', unit: 'µg/L', low: 0, high: 1, kind: 'watch' },
  V: { name: 'Vanadium', unit: 'µg/L', low: 0, high: 3, kind: 'watch' },
  Se: { name: 'Selenium', unit: 'µg/L', low: 0, high: 3, kind: 'watch' },
  Ag: { name: 'Silver', unit: 'µg/L', low: 0, high: 1, kind: 'watch' },
  Ti: { name: 'Titanium', unit: 'µg/L', low: 0, high: 1, kind: 'watch' },
  P: { name: 'Phosphorus', unit: 'µg/L', low: 0, high: 40, kind: 'trace' }
}

// Every way a lab might name an element, lowercased. Symbols come from the
// keys above; these are the spelled-out names and the common variants.
const ALIASES = {
  calcium: 'Ca',
  magnesium: 'Mg',
  potassium: 'K',
  strontium: 'Sr',
  boron: 'B',
  bromine: 'Br',
  bromide: 'Br',
  sulfur: 'S',
  sulphur: 'S',
  fluorine: 'F',
  fluoride: 'F',
  lithium: 'Li',
  iodine: 'I',
  iodide: 'I',
  barium: 'Ba',
  molybdenum: 'Mo',
  silicon: 'Si',
  silica: 'Si',
  silicate: 'Si',
  iron: 'Fe',
  manganese: 'Mn',
  zinc: 'Zn',
  nickel: 'Ni',
  cobalt: 'Co',
  copper: 'Cu',
  aluminium: 'Al',
  aluminum: 'Al',
  lead: 'Pb',
  tin: 'Sn',
  arsenic: 'As',
  cadmium: 'Cd',
  mercury: 'Hg',
  chromium: 'Cr',
  vanadium: 'V',
  selenium: 'Se',
  silver: 'Ag',
  titanium: 'Ti',
  phosphorus: 'P',
  phosphorous: 'P'
}

export function symbolFor(word) {
  const w = String(word ?? '').trim()
  if (!w) return null
  if (ELEMENTS[w]) return w                                  // exact symbol, case-sensitive
  const lower = w.toLowerCase()
  if (ALIASES[lower]) return ALIASES[lower]
  // A symbol typed in the wrong case ("CA", "mg") — only accept it when the
  // case-insensitive match is unambiguous.
  const hits = Object.keys(ELEMENTS).filter((s) => s.toLowerCase() === lower)
  return hits.length === 1 ? hits[0] : null
}

// mg/L and µg/L differ by a thousand, and a report that mixes them will happily
// record 420 µg/L of calcium if nobody looks. Normalise to the unit this
// element is stored in.
function normalise(symbol, value, unit) {
  const want = ELEMENTS[symbol]?.unit
  if (!want || !unit) return value
  const said = unit.toLowerCase().replace('μ', 'µ')
  const isMicro = said.startsWith('µg') || said.startsWith('ug')
  const isMilli = said.startsWith('mg')
  if (want === 'µg/L' && isMilli) return value * 1000
  if (want === 'mg/L' && isMicro) return value / 1000
  return value
}

// Lab reports get pasted in, one element per line, in whatever shape the lab
// prints them. Every one of these is a real line from a real report:
//
//   Calcium 412 mg/l
//   Ca: 412
//   Strontium (Sr)   8.4   mg/L
//   Iodine,58,ug/l
//   Cu <0.5 µg/l
//
// Anything a line cannot be made of is returned as a skip, with the line
// itself, so the person pasting can see what was ignored rather than
// discovering later that six elements silently vanished.
export function parsePaste(text) {
  const results = []
  const skipped = []
  const seen = new Set()

  for (const raw of String(text ?? '').split(/[\r\n]+/)) {
    const line = raw.trim()
    if (!line) continue

    // Split on the first run of separators that follows a word.
    const m = line.match(
      /^([A-Za-zµ() .]+?)\s*[:,\t]?\s*(?:\(([A-Za-z]{1,2})\)\s*)?[:,\t]?\s*(<|>)?\s*(-?\d+(?:[.,]\d+)?)\s*([A-Za-zµμ/%]*)/
    )
    if (!m) { skipped.push(line); continue }

    const [, wordPart, parenSymbol, comparator, numberText, unitText] = m
    const symbol = symbolFor(parenSymbol ?? '') ?? symbolFor(wordPart.replace(/[().]/g, '').trim())
    if (!symbol) { skipped.push(line); continue }
    if (seen.has(symbol)) { skipped.push(line); continue }

    const value = Number(String(numberText).replace(',', '.'))
    if (!Number.isFinite(value)) { skipped.push(line); continue }

    seen.add(symbol)
    results.push({
      element: symbol,
      // "<0.5" means the lab could not see it. Recording it as 0.5 would draw
      // a contaminant the tank does not have; recording 0 says what the report
      // actually means — below the detection limit.
      value: comparator === '<' ? 0 : normalise(symbol, value, unitText),
      unit: ELEMENTS[symbol].unit,
      belowLimit: comparator === '<' || undefined
    })
  }
  return { results, skipped }
}

// Where a value sits against its reference band: which side it is out on.
export function statusOf(element, value) {
  const ref = ELEMENTS[element]
  if (!ref) return 'unknown'
  if (value < ref.low) return 'low'
  if (value > ref.high) return 'high'
  return 'ok'
}

// How far out it is, for colouring - the same rule the tank uses. Inside
// the band is green; outside it by less than the band's own width is a
// concern (amber); further than that is critical (red). Elements whose band
// starts at zero (the traces and the watch list) have no width below, so
// the width above the ceiling stands in for it.
export function severityOf(element, value) {
  const ref = ELEMENTS[element]
  if (!ref || value == null) return 'unknown'
  if (value >= ref.low && value <= ref.high) return 'ok'
  const span = (ref.high - ref.low) || ref.high || 1
  const out = value < ref.low ? ref.low - value : value - ref.high
  return out > span ? 'crit' : 'warn'
}
