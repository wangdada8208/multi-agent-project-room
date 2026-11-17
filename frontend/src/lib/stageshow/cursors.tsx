// macOS system cursors. Hotspots are listed in HOTSPOT in stage.tsx.
// The hands draw a little larger than the arrow, as they do on macOS.

export function MacPointer() {
  return (
    <svg height="24" width="24" viewBox="0 0 32 32" fill="none">
      <g transform="translate(10 7)">
        <path d="m6.148 18.473 1.863-1.003 1.615-.839-2.568-4.816h4.332l-11.379-11.408v16.015l3.316-3.221z" fill="#fff" />
        <path d="m6.431 17 1.765-.941-2.775-5.202h3.604l-8.025-8.043v11.188l2.53-2.442z" fill="#000" />
      </g>
    </svg>
  )
}

export function MacIbeam() {
  return (
    <svg width="10" height="16" viewBox="0 0 10 16" fill="none" overflow="visible">
      {/* A thin edge in the opposite tone, as macOS draws it, so it reads on any surface */}
      <path d="M3 1H7M3 15H7M5 1V15" style={{ stroke: 'var(--ss-cursor-edge, #fff)' }} strokeWidth="2.6" strokeLinecap="round" />
      <path d="M3 1H7M3 15H7M5 1V15" style={{ stroke: 'var(--ss-cursor-line, #000)' }} strokeWidth="1" strokeLinecap="round" />
    </svg>
  )
}

export function MacCrosshair() {
  return (
    <svg width="17" height="17" viewBox="0 0 17 17" fill="none" overflow="visible">
      <path d="M8.5 0V17M0 8.5H17" style={{ stroke: 'var(--ss-cursor-edge, #fff)' }} strokeWidth="2.6" />
      <path d="M8.5 0V17M0 8.5H17" style={{ stroke: 'var(--ss-cursor-line, #000)' }} strokeWidth="1" />
    </svg>
  )
}

// The pointing hand, for links and buttons: a white glove, index finger up,
// the other three fingers folded, thumb along the left. Hotspot at the fingertip.
export function MacPointingHand() {
  return (
    <svg width="26" height="26" viewBox="0 0 32 32" fill="none">
      <path
        d="M10.6 6a1.7 1.7 0 0 1 3.4 0v6.6a1.3 1.3 0 0 1 2.6 0v.7a1.3 1.3 0 0 1 2.6 0v.7a1.3 1.3 0 0 1 2.6 0V19c0 3.1-2 5.6-5 5.6h-2.6c-2 0-3.3-.9-4.4-2.4l-3.1-4.1c-.6-.9-.4-2 .5-2.5.8-.4 1.7-.2 2.3.5l1.1 1.4V6Z"
        fill="#fff"
        stroke="#000"
        strokeWidth="1.1"
        strokeLinejoin="round"
      />
      <path d="M14 12.6v3.6M16.6 13.3v3M19.2 14v2.6" stroke="#000" strokeWidth="1" strokeLinecap="round" />
    </svg>
  )
}

// The open hand: over something that can be dragged, before it's pressed.
export function MacOpenHand() {
  return (
    <svg width="26" height="26" viewBox="0 0 32 32" fill="none">
      <g transform="translate(7 6)">
        <path d="m4.5557 8.5742c-.098-.375-.196-.847-.406-1.552-.167-.557-.342-.859-.47-1.233-.155-.455-.303-.721-.496-1.181-.139-.329-.364-1.048-.457-1.44-.119-.509.033-.924.244-1.206.253-.339.962-.49 1.357-.351.371.13.744.512.916.788.288.46.357.632.717 1.542.393.992.564 1.918.611 2.231l.085.452c-.001-.04-.043-1.122-.044-1.162-.035-1.029-.06-1.823-.038-2.939.002-.126.064-.587.084-.715.078-.5.305-.8.673-.979.412-.201.926-.215 1.401-.017.423.173.626.55.687 1.022.014.109.094.987.093 1.107-.013 1.025.006 1.641.015 2.174.004.231.003 1.625.017 1.469.061-.656.094-3.189.344-3.942.144-.433.405-.746.794-.929.431-.203 1.113-.07 1.404.243.285.305.446.692.482 1.153.032.405-.019.897-.02 1.245 0 .867-.021 1.324-.037 2.121-.001.038-.015.298.023.182.094-.28.188-.542.266-.745.049-.125.241-.614.359-.859.114-.234.211-.369.415-.688.2-.313.415-.448.668-.561.54-.235 1.109.112 1.301.591.086.215.009.713-.028 1.105-.061.647-.254 1.306-.352 1.648-.128.447-.274 1.235-.34 1.601-.072.394-.234 1.382-.359 1.82-.086.301-.371.978-.652 1.384 0 0-1.074 1.25-1.192 1.812-.117.563-.078.567-.101.965-.024.399.121.923.121.923s-.802.104-1.234.034c-.391-.062-.875-.841-1-1.078-.172-.328-.539-.265-.682-.023-.225.383-.709 1.07-1.051 1.113-.668.084-2.054.03-3.139.02 0 0 .185-1.011-.227-1.358-.305-.26-.83-.784-1.144-1.06l-.832-.921c-.284-.36-.629-1.093-1.243-1.985-.348-.504-1.027-1.085-1.284-1.579-.223-.425-.331-.954-.19-1.325.225-.594.675-.897 1.362-.832.519.05.848.206 1.238.537.225.19.573.534.75.748.163.195.203.276.377.509.23.307.302.459.214.121" fill="#fff" />
        <g stroke="#000" strokeLinecap="round" strokeWidth=".75">
          <path d="m4.5557 8.5742c-.098-.375-.196-.847-.406-1.552-.167-.557-.342-.859-.47-1.233-.155-.455-.303-.721-.496-1.181-.139-.329-.364-1.048-.457-1.44-.119-.509.033-.924.244-1.206.253-.339.962-.49 1.357-.351.371.13.744.512.916.788.288.46.357.632.717 1.542.393.992.564 1.918.611 2.231l.085.452c-.001-.04-.043-1.122-.044-1.162-.035-1.029-.06-1.823-.038-2.939.002-.126.064-.587.084-.715.078-.5.305-.8.673-.979.412-.201.926-.215 1.401-.017.423.173.626.55.687 1.022.014.109.094.987.093 1.107-.013 1.025.006 1.641.015 2.174.004.231.003 1.625.017 1.469.061-.656.094-3.189.344-3.942.144-.433.405-.746.794-.929.431-.203 1.113-.07 1.404.243.285.305.446.692.482 1.153.032.405-.019.897-.02 1.245 0 .867-.021 1.324-.037 2.121-.001.038-.015.298.023.182.094-.28.188-.542.266-.745.049-.125.241-.614.359-.859.114-.234.211-.369.415-.688.2-.313.415-.448.668-.561.54-.235 1.109.112 1.301.591.086.215.009.713-.028 1.105-.061.647-.254 1.306-.352 1.648-.128.447-.274 1.235-.34 1.601-.072.394-.234 1.382-.359 1.82-.086.301-.371.978-.652 1.384 0 0-1.074 1.25-1.192 1.812-.117.563-.078.567-.101.965-.024.399.121.923.121.923s-.802.104-1.234.034c-.391-.062-.875-.841-1-1.078-.172-.328-.539-.265-.682-.023-.225.383-.709 1.07-1.051 1.113-.668.084-2.054.03-3.139.02 0 0 .185-1.011-.227-1.358-.305-.26-.83-.784-1.144-1.06l-.832-.921c-.284-.36-.629-1.093-1.243-1.985-.348-.504-1.027-1.085-1.284-1.579-.223-.425-.331-.954-.19-1.325.225-.594.675-.897 1.362-.832.519.05.848.206 1.238.537.225.19.573.534.75.748.163.195.203.276.377.509.23.307.302.459.214.121" strokeLinejoin="round" />
          <path d="m11.566 12.734v-3.459" />
          <path d="m9.551 12.746-.016-3.473" />
          <path d="m7.555 9.305.021 3.426" />
        </g>
      </g>
    </svg>
  )
}

// The closed hand, while a drag is held.
// NOTE: upstream kit's original SVG path exceeded the file reader's line
// limit during the kit copy, so this fist is a simplified silhouette drawn
// for this repo (white glove, curled fingers). Replace with the upstream
// path from skills/stageshow/kit/cursors.tsx when convenient — it only
// shows while a drag is held.
export function MacGrab() {
  return (
    <svg width="30" height="30" viewBox="0 0 32 32" fill="none">
      <g transform="translate(7 5)">
        <path
          d="M4 8.5a2 2 0 0 1 4 0V8a2 2 0 0 1 4 0 2 2 0 0 1 4 .2 2 2 0 0 1 3.8 1.2l-.4 6.2c-.3 3.3-2.6 6.4-6.6 6.4H10c-2.4 0-3.9-1.1-5-3L1.9 14.4c-.6-.9-.3-2.1.7-2.5.8-.3 1.7 0 2.2.7L6 14.4V9.5a2 2 0 0 1-2-1Z"
          fill="#fff"
          stroke="#000"
          strokeWidth="1.1"
          strokeLinejoin="round"
        />
        <path d="M8 8.5v5M12 8v4.5M16 8.2v4.3" stroke="#000" strokeWidth="1" strokeLinecap="round" />
      </g>
    </svg>
  )
}

export function MacWait() {
  return (
    <svg width="16" height="16" viewBox="0 0 20 20" fill="none" xmlns="http://www.w3.org/2000/svg">
      <circle cx="10" cy="10" r="8" stroke="rgba(0,0,0,0.15)" strokeWidth="2" />
      <path d="M10 2A8 8 0 0 1 18 10" stroke="black" strokeWidth="2" strokeLinecap="round" />
    </svg>
  )
}

// The resize cursors, measured from macOS's own: two rounded black
// triangles, a 6pt gap between them, each with a 1pt white edge. The pair
// points north-south, and turns for east-west and the two diagonals. Drawn
// at the pointer's scale (a 28pt box at 21px), hotspot at the center.
const RESIZE_TIP = 'M0-8.4 2.55-3.65H-2.55ZM0 8.4 2.55 3.65H-2.55Z'
function MacResize({ turn }: { turn: number }) {
  return (
    <svg width="21" height="21" viewBox="-14 -14 28 28" overflow="visible">
      <g transform={`rotate(${turn})`} strokeLinejoin="round">
        <path d={RESIZE_TIP} style={{ fill: 'var(--ss-cursor-edge, #fff)', stroke: 'var(--ss-cursor-edge, #fff)' }} strokeWidth="3.2" />
        <path d={RESIZE_TIP} style={{ fill: 'var(--ss-cursor-line, #000)', stroke: 'var(--ss-cursor-line, #000)' }} strokeWidth="1.2" />
      </g>
    </svg>
  )
}
export const MacResizeNS = () => <MacResize turn={0} />
export const MacResizeEW = () => <MacResize turn={90} />
export const MacResizeNWSE = () => <MacResize turn={-45} />
export const MacResizeNESW = () => <MacResize turn={45} />
