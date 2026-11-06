import { useMemo, useState } from "react";

export type ChartSeries = { label: string; color: string; values: (number | null)[]; asDots?: boolean };

export const CHART_COLORS = { one: "#3987e5", two: "#d95926" };

function niceTicks(min: number, max: number, count = 4) {
  const span = max - min || 1;
  const raw = span / count;
  const mag = 10 ** Math.floor(Math.log10(raw));
  const step = [1, 2, 2.5, 5, 10].map((m) => m * mag).find((m) => m >= raw) ?? raw;
  const out: number[] = [];
  for (let v = Math.ceil(min / step) * step; v <= max + step * 0.001; v += step) out.push(Number(v.toFixed(10)));
  return out;
}

/** One y axis, thin lines, a crosshair that snaps to the nearest reading, and the numbers underneath in a table. */
export function LineChart({
  title,
  x,
  xLabel,
  series,
  unit,
  dots = false,
  height = 170,
  yDigits = 1,
}: {
  title: string;
  x: number[];
  xLabel: (value: number) => string;
  series: ChartSeries[];
  unit: string;
  dots?: boolean;
  height?: number;
  yDigits?: number;
}) {
  const [hover, setHover] = useState<number | null>(null);
  const W = 560;
  const margin = { left: 46, right: 12, top: 8, bottom: 22 };
  const geometry = useMemo(() => {
    const all = series.flatMap((row) => row.values).filter((v): v is number => v != null && Number.isFinite(v));
    const lo = all.length ? Math.min(...all) : 0;
    const hi = all.length ? Math.max(...all) : 1;
    const pad = (hi - lo || Math.abs(hi) || 1) * 0.08;
    const yMin = lo - pad;
    const yMax = hi + pad;
    const x0 = x.length ? Math.min(...x) : 0;
    const x1 = x.length ? Math.max(...x) : 1;
    const toX = (v: number) => margin.left + ((v - x0) / (x1 - x0 || 1)) * (W - margin.left - margin.right);
    const toY = (v: number) => margin.top + (1 - (v - yMin) / (yMax - yMin || 1)) * (height - margin.top - margin.bottom);
    return { yMin, yMax, x0, x1, toX, toY, yTicks: niceTicks(yMin, yMax), xTicks: niceTicks(x0, x1, 5) };
  }, [series, x, height]);
  const { toX, toY } = geometry;
  const paths = series.map((row) => {
    let d = "";
    let open = false;
    row.values.forEach((value, index) => {
      if (value == null || !Number.isFinite(value)) {
        open = false;
        return;
      }
      d += `${open ? "L" : "M"}${toX(x[index]!).toFixed(1)} ${toY(value).toFixed(1)}`;
      open = true;
    });
    return d;
  });
  const onMove = (event: React.PointerEvent<SVGSVGElement>) => {
    const box = event.currentTarget.getBoundingClientRect();
    const px = ((event.clientX - box.left) / box.width) * W;
    let best = 0;
    let gap = Infinity;
    x.forEach((value, index) => {
      const d = Math.abs(toX(value) - px);
      if (d < gap) {
        gap = d;
        best = index;
      }
    });
    setHover(best);
  };
  if (!x.length) return <p className="hint">{title}: nessun dato.</p>;
  const step = Math.max(1, Math.ceil(x.length / 120));
  const span = Math.abs(geometry.yMax - geometry.yMin);
  const tickDigits = span < 3 ? 2 : span < 30 ? 1 : 0;
  return (
    <figure className="chart">
      <figcaption>
        <b>{title}</b>
        {series.length > 1 && (
          <span className="legend">
            {series.map((row) => (
              <span key={row.label}>
                <i style={{ background: row.color }} /> {row.label}
              </span>
            ))}
          </span>
        )}
      </figcaption>
      <div className="chart-plot">
        <svg viewBox={`0 0 ${W} ${height}`} role="img" aria-label={title} onPointerMove={onMove} onPointerLeave={() => setHover(null)}>
          {geometry.yTicks.map((tick) => (
            <g key={tick}>
              <line x1={margin.left} x2={W - margin.right} y1={toY(tick)} y2={toY(tick)} className="grid" />
              <text x={margin.left - 6} y={toY(tick) + 3.5} textAnchor="end">
                {tick.toFixed(tickDigits)}
              </text>
            </g>
          ))}
          {geometry.xTicks.map((tick) => (
            <text key={tick} x={toX(tick)} y={height - 6} textAnchor="middle">
              {xLabel(tick)}
            </text>
          ))}
          {series.map((row, index) =>
            dots || row.asDots ? (
              row.values.map((value, k) => (value == null ? null : <circle key={`${row.label}${k}`} cx={toX(x[k]!)} cy={toY(value)} r={4} fill={row.color} stroke="var(--ink-2)" strokeWidth={2} />))
            ) : (
              <path key={row.label} d={paths[index]} fill="none" stroke={row.color} strokeWidth={2} strokeLinejoin="round" strokeLinecap="round" />
            ),
          )}
          {hover != null && (
            <g>
              <line x1={toX(x[hover]!)} x2={toX(x[hover]!)} y1={margin.top} y2={height - margin.bottom} className="cross" />
              {series.map((row) => (row.values[hover] != null ? <circle key={row.label} cx={toX(x[hover]!)} cy={toY(row.values[hover]!)} r={4} fill={row.color} stroke="var(--ink-2)" strokeWidth={2} /> : null))}
            </g>
          )}
        </svg>
        {hover != null && (
          <div className="chart-tip" style={{ left: `${Math.min(68, (toX(x[hover]!) / W) * 100)}%` }}>
            <b>{xLabel(x[hover]!)}</b>
            {series.map((row) => (
              <span key={row.label}>
                <i style={{ background: row.color }} />
                {row.values[hover] == null ? "—" : `${row.values[hover]!.toFixed(yDigits)} ${unit}`}
                {series.length > 1 ? ` · ${row.label}` : ""}
              </span>
            ))}
          </div>
        )}
      </div>
      <details className="small">
        <summary>Tabella</summary>
        <table className="data">
          <thead>
            <tr>
              <th>Punto</th>
              {series.map((row) => (
                <th key={row.label}>
                  {row.label} ({unit})
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {x.map((value, index) =>
              index % step ? null : (
                <tr key={index}>
                  <td>{xLabel(value)}</td>
                  {series.map((row) => (
                    <td key={row.label}>{row.values[index] == null ? "—" : row.values[index]!.toFixed(yDigits)}</td>
                  ))}
                </tr>
              ),
            )}
          </tbody>
        </table>
      </details>
    </figure>
  );
}

/** The same chart on a canvas, so a section or a series can be pinned in the register as a picture. */
export function chartPicture(title: string, x: number[], series: ChartSeries[], unit: string, xText: (v: number) => string) {
  const canvas = document.createElement("canvas");
  canvas.width = 1200;
  canvas.height = 520;
  const ctx = canvas.getContext("2d")!;
  ctx.fillStyle = "#222822";
  ctx.fillRect(0, 0, 1200, 520);
  const all = series.flatMap((row) => row.values).filter((v): v is number => v != null && Number.isFinite(v));
  const lo = Math.min(...all);
  const hi = Math.max(...all);
  const pad = (hi - lo || 1) * 0.08;
  const x0 = Math.min(...x);
  const x1 = Math.max(...x);
  const toX = (v: number) => 90 + ((v - x0) / (x1 - x0 || 1)) * 1080;
  const toY = (v: number) => 60 + (1 - (v - lo + pad) / (hi - lo + 2 * pad || 1)) * 410;
  ctx.font = "600 24px sans-serif";
  ctx.fillStyle = "#eae2cf";
  ctx.fillText(title, 24, 36);
  ctx.font = "18px sans-serif";
  ctx.fillStyle = "#a8b0a2";
  for (const tick of niceTicks(lo - pad, hi + pad)) {
    ctx.strokeStyle = "#3e4a40";
    ctx.beginPath();
    ctx.moveTo(90, toY(tick));
    ctx.lineTo(1170, toY(tick));
    ctx.stroke();
    ctx.textAlign = "right";
    ctx.fillText(`${Number(tick.toFixed(2))}`, 82, toY(tick) + 6);
  }
  ctx.textAlign = "center";
  for (const tick of niceTicks(x0, x1, 6)) ctx.fillText(xText(tick), toX(tick), 505);
  ctx.textAlign = "left";
  ctx.fillText(unit, 24, 60);
  series.forEach((row, index) => {
    ctx.strokeStyle = row.color;
    ctx.lineWidth = 3;
    ctx.beginPath();
    let open = false;
    row.values.forEach((value, k) => {
      if (value == null || !Number.isFinite(value)) {
        open = false;
        return;
      }
      if (open) ctx.lineTo(toX(x[k]!), toY(value));
      else ctx.moveTo(toX(x[k]!), toY(value));
      open = true;
    });
    ctx.stroke();
    if (series.length > 1) {
      ctx.fillStyle = row.color;
      ctx.fillRect(760 + index * 210, 22, 18, 6);
      ctx.fillStyle = "#eae2cf";
      ctx.fillText(row.label, 784 + index * 210, 33);
    }
  });
  return canvas;
}
