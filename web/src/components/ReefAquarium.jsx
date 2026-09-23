import React from 'react'

// Photoreal animated reef background for the Reef Tank view: a real reef
// photograph plus cut-out fish sprites swimming across it, pure CSS
// (no JS animation loop, no network calls). Lite by default — see the
// measurements at the top of aquarium.css; the full scene is for capture. Stylesheet is linked globally
// in index.html (web/public/reef/aquarium.css); assets live alongside it.
// Scoped via aquarium.css to fill its positioned parent (see the .reef
// override there) rather than the whole viewport.
const A = '/reef/assets'

export default function ReefAquarium({ lite = true }) {
  return (
    <div className={`reef ${lite ? 'is-lite' : ''}`} aria-hidden="true">
      <div className="reef__plate" />

      <div className="reef__rays">
        <span className="ray" /><span className="ray" /><span className="ray" />
        <span className="ray" /><span className="ray" />
      </div>

      <div className="reef__school">
        <div className="fish">                     <div className="fish__bob"><img src={`${A}/clown.png`} alt="" /></div></div>
        <div className="fish fish--rtl fish--far"> <div className="fish__bob"><img src={`${A}/chromis.png`} alt="" /></div></div>
        <div className="fish">                     <div className="fish__bob"><img src={`${A}/bluetang.png`} alt="" /></div></div>
        <div className="fish fish--rtl fish--far"> <div className="fish__bob"><img src={`${A}/gramma.png`} alt="" /></div></div>
        <div className="fish fish--mid">           <div className="fish__bob"><img src={`${A}/yellowtang.png`} alt="" /></div></div>
        <div className="fish fish--rtl">           <div className="fish__bob"><img src={`${A}/powderblue.png`} alt="" /></div></div>
        <div className="fish fish--far">           <div className="fish__bob"><img src={`${A}/chromis.png`} alt="" /></div></div>
        <div className="fish fish--rtl fish--mid"> <div className="fish__bob"><img src={`${A}/copperband.png`} alt="" /></div></div>
        <div className="fish fish--far">           <div className="fish__bob"><img src={`${A}/gramma.png`} alt="" /></div></div>
        <div className="fish fish--rtl">           <div className="fish__bob"><img src={`${A}/flame.png`} alt="" /></div></div>
        <div className="fish fish--mid">           <div className="fish__bob"><img src={`${A}/clown.png`} alt="" /></div></div>
        <div className="fish fish--rtl fish--far"> <div className="fish__bob"><img src={`${A}/chromis.png`} alt="" /></div></div>
      </div>

      <div className="reef__front" />

      <div className="reef__bubbles">
        {Array.from({ length: 18 }, (_, i) => <span key={i} className="bubble" />)}
      </div>

      <div className="reef__grade" />
    </div>
  )
}
