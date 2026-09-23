// What people actually dose, and what the bottles are called.
//
// The method a household runs decides the buttons on the dosing screen. Naming
// them "Alkalinity" and "Calcium" is right for a two-part and wrong for
// everyone else: a Triton tank has four numbered parts, a Red Sea tank has A, B
// and C, and a Moonshiner is correcting individual trace elements off an ICP
// test. Getting the labels right is most of what makes the screen feel like it
// belongs to this tank.
//
// Amounts are starting points for the keypad, not prescriptions — the terminal
// records what was dosed, it does not decide it.

export const DOSING_METHODS = {
  'brs-2part': {
    name: 'Two-part (BRS or similar)',
    title: 'Two-part',
    tagline: '(BRS or similar)',
    note: 'Soda ash and calcium chloride, magnesium as needed. Where most tanks start.',
    supplements: [
      { name: 'Alkalinity', amountMl: 10 },
      { name: 'Calcium', amountMl: 10 },
      { name: 'Magnesium', amountMl: 10 }
    ]
  },
  'red-sea': {
    name: 'Red Sea Reef Foundation',
    title: 'Red Sea',
    tagline: 'reef foundation A, B and C',
    note: 'A for calcium, B for alkalinity, C for magnesium.',
    supplements: [
      { name: 'Foundation A · Calcium', amountMl: 10 },
      { name: 'Foundation B · Alkalinity', amountMl: 10 },
      { name: 'Foundation C · Magnesium', amountMl: 10 }
    ]
  },
  'triton-core7': {
    name: 'Triton Core7',
    title: 'Triton Core7',
    tagline: 'four base-element parts',
    note: 'Four base-element parts dosed in equal measure, with ICP testing behind it.',
    supplements: [
      { name: 'Core7 Part 1', amountMl: 10 },
      { name: 'Core7 Part 2', amountMl: 10 },
      { name: 'Core7 Part 3a', amountMl: 10 },
      { name: 'Core7 Part 3b', amountMl: 10 }
    ]
  },
  'balling': {
    name: 'Balling Light',
    title: 'Balling Light',
    tagline: 'calcium, carbonate, trace salt',
    note: 'Calcium, carbonate and a sodium-free trace salt, in three parts.',
    supplements: [
      { name: 'Balling 1 · Calcium', amountMl: 10 },
      { name: 'Balling 2 · Carbonate', amountMl: 10 },
      { name: 'Balling 3 · Trace salt', amountMl: 10 }
    ]
  },
  kalkwasser: {
    name: 'Kalkwasser',
    title: 'Kalkwasser',
    tagline: 'limewater through the top-off',
    note: 'Limewater through the top-off, often with a two-part alongside it to catch up.',
    supplements: [
      { name: 'Kalkwasser', amountMl: 500 },
      { name: 'Alkalinity', amountMl: 10 },
      { name: 'Calcium', amountMl: 10 }
    ]
  },
  'all-for-reef': {
    name: 'Tropic Marin All-For-Reef',
    title: 'All-For-Reef',
    tagline: 'Tropic Marin, one bottle',
    note: 'One bottle covering calcium, alkalinity, magnesium and trace together.',
    supplements: [{ name: 'All-For-Reef', amountMl: 10 }]
  },
  'esv-bionic': {
    name: 'ESV B-Ionic',
    title: 'ESV B-Ionic',
    tagline: 'two parts, each carrying trace',
    note: 'Two parts, each carrying its own trace elements.',
    supplements: [
      { name: 'B-Ionic 1 · Alkalinity', amountMl: 10 },
      { name: 'B-Ionic 2 · Calcium', amountMl: 10 }
    ]
  },
  moonshiners: {
    name: 'Reef Moonshiners',
    title: 'Moonshiners',
    tagline: 'four elements daily, the rest off an ICP',
    note: 'Four elements daily, everything else corrected individually off an ICP test.',
    // The daily four, which is what the method actually asks you to dose by
    // hand or by pump every day. These get the dials.
    supplements: [
      { name: 'Manganese', amountMl: 1 },
      { name: 'Iron', amountMl: 1 },
      { name: 'Chromium', amountMl: 1 },
      { name: 'Cobalt', amountMl: 1 },
      { name: 'Alkalinity', amountMl: 10 },
      { name: 'Calcium', amountMl: 10 }
    ],
    // The rest of the starter kit: dosed as corrections when an ICP comes back,
    // not on a schedule. Behind a picker rather than on the screen, or the
    // screen becomes twenty dials nobody presses.
    more: [
      { name: 'Potassium', amountMl: 5 },
      { name: 'Boron', amountMl: 2 },
      { name: 'Bromine', amountMl: 2 },
      { name: 'Barium', amountMl: 1 },
      { name: 'Fluoride', amountMl: 1 },
      { name: 'Strontium', amountMl: 2 },
      { name: 'Rubidium', amountMl: 1 },
      { name: 'Nickel', amountMl: 1 },
      { name: 'Molybdenum', amountMl: 1 },
      { name: 'Zinc', amountMl: 1 },
      { name: 'Vanadium', amountMl: 1 },
      { name: 'Selenium', amountMl: 1 },
      { name: 'Magnesium', amountMl: 10 },
      { name: 'Vitamin Carb-X', amountMl: 2 },
      { name: 'Liqui-Mud', amountMl: 2 }
    ]
  },
  custom: {
    name: 'Something else',
    title: 'Something else',
    tagline: 'no preset bottles',
    note: 'No preset bottles — the buttons become whatever you log.',
    supplements: []
  }
}

export const DEFAULT_METHOD = 'brs-2part'

// Every bottle a method knows about: the ones on the screen and the ones
// behind the picker.
export function allSupplements(id) {
  const m = DOSING_METHODS[id] ?? DOSING_METHODS[DEFAULT_METHOD]
  return [...(m.supplements ?? []), ...(m.more ?? [])]
}

export function methodFor(config) {
  const id = config.dosing?.method
  return DOSING_METHODS[id] ? id : DEFAULT_METHOD
}
