const PAPER = "#eae2cf";
const INK = "#1b1f1b";
const RUST = "#cf7c3f";

/** The instruments' faces: drawn, not screenshotted, and each needle is the live number. */
export function CompassDial({ heading, declination }: { heading: number; declination: number }) {
  const r = 78;
  const ticks = Array.from({ length: 72 }, (_, i) => i * 5);
  return (
    <svg className="dial" width={176} height={176} viewBox="-88 -88 176 176" role="img" aria-label={`Bussola: ${heading.toFixed(0)} gradi`}>
      <circle r={86} fill="#2a2f29" stroke="#55604f" strokeWidth={2} />
      <circle r={r + 2} fill={PAPER} />
      <g transform={`rotate(${-heading})`}>
        {ticks.map((a) => (
          <line key={a} y1={-r} y2={a % 30 === 0 ? -r + 11 : -r + 5} transform={`rotate(${a})`} stroke={INK} strokeWidth={a % 30 === 0 ? 1.6 : 0.7} />
        ))}
        {[
          ["N", 0],
          ["E", 90],
          ["S", 180],
          ["O", 270],
        ].map(([label, a]) => (
          <text key={label} transform={`rotate(${a}) translate(0 ${-r + 26})`} textAnchor="middle" fontFamily="Fraunces, serif" fontSize={17} fill={label === "N" ? "#a33d1d" : INK}>
            {label}
          </text>
        ))}
        <line y1={-r + 2} y2={-r + 32} transform={`rotate(${declination})`} stroke={RUST} strokeDasharray="2 2" strokeWidth={1.4} />
      </g>
      <path d="M0 -44 L7 0 L0 44 L-7 0Z" fill="#7d8a7b" />
      <path d="M0 -44 L7 0 L-7 0Z" fill="#a33d1d" />
      <circle r={3.4} fill={INK} />
      <path d="M-5 -86 L0 -77 L5 -86Z" fill={RUST} />
    </svg>
  );
}

export function WatchDial({ hours, minutes, seconds, sunAz, chrono }: { hours: number; minutes: number; seconds: number; sunAz: number; chrono: number }) {
  const hand = (angle: number, length: number, width: number, color: string) => <line y2={-length} transform={`rotate(${angle})`} stroke={color} strokeWidth={width} strokeLinecap="round" />;
  return (
    <svg className="dial" width={176} height={176} viewBox="-88 -88 176 176" role="img" aria-label="Orologio da polso">
      <rect x={-24} y={-100} width={48} height={200} rx={6} fill="#3e3425" />
      <circle r={84} fill="#2a2f29" stroke="#8c8574" strokeWidth={2.4} />
      <circle r={74} fill="#14181a" />
      {Array.from({ length: 60 }, (_, i) => (
        <line key={i} y1={-72} y2={i % 5 === 0 ? -62 : -68} transform={`rotate(${i * 6})`} stroke={PAPER} strokeWidth={i % 5 === 0 ? 2 : 0.8} />
      ))}
      {[12, 3, 6, 9].map((n) => (
        <text key={n} transform={`rotate(${n * 30}) translate(0 -46) rotate(${-n * 30})`} textAnchor="middle" dominantBaseline="middle" fill={PAPER} fontFamily="Fraunces, serif" fontSize={15}>
          {n}
        </text>
      ))}
      <g transform="translate(0 30)">
        <circle r={14} fill="none" stroke="#6e6a5b" />
        <line y2={-12} transform={`rotate(${(chrono / 60000) * 360})`} stroke={RUST} strokeWidth={1.2} />
      </g>
      <path d="M0 -74 L5 -66 L-5 -66Z" fill="#e5c25a" transform={`rotate(${sunAz})`} />
      {hand(((hours % 12) + minutes / 60) * 30, 36, 4, PAPER)}
      {hand((minutes + seconds / 60) * 6, 56, 2.6, PAPER)}
      {hand(seconds * 6, 62, 1, RUST)}
      <circle r={3} fill={RUST} />
    </svg>
  );
}

export function GaugeDial({ value, min, max, unit, label, marker, step }: { value: number; min: number; max: number; unit: string; label: string; marker?: number; step: number }) {
  const span = 270;
  const angle = (v: number) => -135 + ((Math.min(max, Math.max(min, v)) - min) / (max - min)) * span;
  const ticks: number[] = [];
  for (let v = Math.ceil(min / step) * step; v <= max; v += step) ticks.push(v);
  return (
    <svg className="dial" width={176} height={176} viewBox="-88 -88 176 176" role="img" aria-label={`${label}: ${value.toFixed(1)} ${unit}`}>
      <circle r={86} fill="#2a2f29" stroke="#8c8574" strokeWidth={2} />
      <circle r={76} fill={PAPER} />
      {ticks.map((v) => (
        <g key={v} transform={`rotate(${angle(v)})`}>
          <line y1={-74} y2={-64} stroke={INK} strokeWidth={1.4} />
          <text y={-52} textAnchor="middle" fontSize={9.5} fontFamily="IBM Plex Mono, monospace" fill={INK} transform={`rotate(${-angle(v)} 0 -52)`}>
            {v}
          </text>
        </g>
      ))}
      <text y={32} textAnchor="middle" fontFamily="Fraunces, serif" fontSize={11} fill="#6d6249">
        {label}
      </text>
      <text y={46} textAnchor="middle" fontFamily="IBM Plex Mono, monospace" fontSize={10} fill="#6d6249">
        {unit}
      </text>
      {marker != null && <line y1={-76} y2={-60} transform={`rotate(${angle(marker)})`} stroke={RUST} strokeWidth={2.6} />}
      <path d="M-2.4 10 L0 -62 L2.4 10Z" fill="#a33d1d" transform={`rotate(${angle(value)})`} />
      <circle r={4} fill={INK} />
    </svg>
  );
}

export function CompassTape({ heading }: { heading: number }) {
  const pxPerDeg = 3.6;
  const marks = [];
  for (let d = -90; d <= 90; d += 15) {
    const a = ((Math.round(heading / 15) * 15 + d) % 360 + 360) % 360;
    const offset = ((a - heading + 540) % 360) - 180;
    const name = { 0: "N", 45: "NE", 90: "E", 135: "SE", 180: "S", 225: "SO", 270: "O", 315: "NO" }[a];
    marks.push(
      <div key={d} className={`tick ${name ? "major" : ""}`} style={{ left: offset * pxPerDeg }}>
        <i />
        {name ?? a}
      </div>,
    );
  }
  return (
    <div className="hud-compass" aria-hidden>
      <div className="tape">{marks}</div>
    </div>
  );
}

export function Reticle({ kind, zoom }: { kind: "binocolo" | "monocolo" | "fotocamera" | "sestante"; zoom: number }) {
  // A mil at this magnification, in viewport-height units.
  const fovDeg = (2 * Math.atan(Math.tan((68 * Math.PI) / 360) / Math.max(1, zoom)) * 180) / Math.PI;
  const milPct = (0.0573 / fovDeg) * 100;
  const ticks = [-10, -8, -6, -4, -2, 2, 4, 6, 8, 10];
  if (kind === "fotocamera") {
    return (
      <svg className="overlay-reticle" width="100%" height="100%" viewBox="0 0 100 100" preserveAspectRatio="none" aria-hidden>
        {[33.3, 66.6].map((v) => (
          <g key={v}>
            <line x1={v} x2={v} y1={0} y2={100} stroke="rgba(255,255,255,.26)" strokeWidth={0.08} />
            <line y1={v} y2={v} x1={0} x2={100} stroke="rgba(255,255,255,.26)" strokeWidth={0.08} />
          </g>
        ))}
        <rect x={6} y={8} width={88} height={84} fill="none" stroke="rgba(255,255,255,.5)" strokeWidth={0.12} />
      </svg>
    );
  }
  if (kind === "sestante") {
    return (
      <svg className="overlay-reticle" width="100%" height="100%" aria-hidden>
        <line x1="0" x2="100%" y1="50%" y2="50%" stroke="rgba(255,200,120,.8)" strokeWidth={1} />
        <circle cx="50%" cy="50%" r="28" fill="none" stroke="rgba(255,200,120,.8)" />
      </svg>
    );
  }
  const w = window.innerWidth;
  const h = window.innerHeight;
  const r = h * 0.46;
  const cx = w / 2;
  const cy = h / 2;
  const mil = (milPct / 100) * h;
  return (
    <svg className="overlay-reticle" width={w} height={h} viewBox={`0 0 ${w} ${h}`} aria-hidden>
      <defs>
        <mask id="scope-mask">
          <rect width={w} height={h} fill="white" />
          {kind === "binocolo" ? (
            <>
              <circle cx={cx - r * 0.5} cy={cy} r={r} fill="black" />
              <circle cx={cx + r * 0.5} cy={cy} r={r} fill="black" />
            </>
          ) : (
            <circle cx={cx} cy={cy} r={r} fill="black" />
          )}
        </mask>
      </defs>
      <rect width={w} height={h} fill="#050605" mask="url(#scope-mask)" />
      <line x1={cx} x2={cx} y1={cy - r * 0.34} y2={cy + r * 0.34} stroke="rgba(10,12,10,.85)" />
      <line x1={cx - r * 0.34} x2={cx + r * 0.34} y1={cy} y2={cy} stroke="rgba(10,12,10,.85)" />
      {ticks.map((m) => (
        <line key={m} x1={cx + m * mil} x2={cx + m * mil} y1={cy - 6} y2={cy + 6} stroke="rgba(10,12,10,.85)" />
      ))}
      {ticks.map((m) => (
        <line key={`v${m}`} y1={cy + m * mil} y2={cy + m * mil} x1={cx - 6} x2={cx + 6} stroke="rgba(10,12,10,.85)" />
      ))}
      <text x={cx + 12} y={cy - 12} fontFamily="IBM Plex Mono, monospace" fontSize="11" fill="rgba(10,12,10,.9)">
        {zoom.toFixed(1)}× · tacche ogni 2 mil
      </text>
    </svg>
  );
}
