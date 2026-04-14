'use client';

import { useRef } from 'react';

interface Props {
  value: number; // 0–1
  onChange: (v: number) => void;
  size?: number;
}

export default function VolumeKnob({ value, onChange, size = 38 }: Props) {
  const dragRef = useRef<{ startY: number; startValue: number } | null>(null);

  const cx = size / 2;
  const cy = size / 2;
  const R = size / 2 - 5;

  // Sweep: 135° (7:30) → 405°/45° (4:30), 270° total
  // Math angles (0=right, positive=counterclockwise in math but clockwise in SVG y-down)
  const startDeg = 135;
  const sweepDeg = 270;
  // Clamp to avoid degenerate arc when value === 1 (start === end point)
  const displayValue = Math.min(0.9999, Math.max(0, value));
  const currentDeg = startDeg + displayValue * sweepDeg;

  function polar(deg: number, r: number): [number, number] {
    const rad = (deg * Math.PI) / 180;
    return [cx + r * Math.cos(rad), cy + r * Math.sin(rad)];
  }

  const [fsx, fsy] = polar(startDeg, R);
  const [fex, fey] = polar(startDeg + sweepDeg, R); // full track end = 405° = 45°
  const [sx, sy] = polar(startDeg, R);
  const [ex, ey] = polar(currentDeg, R);
  const largeArc = displayValue * sweepDeg > 180 ? 1 : 0;

  // Indicator dot position
  const [ix, iy] = polar(currentDeg, R - 4);

  const onPointerDown = (e: React.PointerEvent<SVGSVGElement>) => {
    dragRef.current = { startY: e.clientY, startValue: value };
    e.currentTarget.setPointerCapture(e.pointerId);
    e.preventDefault();
  };

  const onPointerMove = (e: React.PointerEvent<SVGSVGElement>) => {
    if (!dragRef.current) return;
    const delta = (dragRef.current.startY - e.clientY) / 80;
    onChange(Math.max(0, Math.min(1, dragRef.current.startValue + delta)));
  };

  const onPointerUp = () => { dragRef.current = null; };

  return (
    <svg
      width={size} height={size}
      className="cursor-ns-resize select-none flex-shrink-0"
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={onPointerUp}
      onPointerLeave={onPointerUp}
    >
      <title>{`Volume: ${Math.round(value * 100)}%`}</title>
      {/* Full range background track */}
      <path
        d={`M ${fsx} ${fsy} A ${R} ${R} 0 1 1 ${fex} ${fey}`}
        fill="none" stroke="#e9e9e9" strokeWidth={2.5} strokeLinecap="round"
      />
      {/* Active arc */}
      {displayValue > 0.002 && (
        <path
          d={`M ${sx} ${sy} A ${R} ${R} 0 ${largeArc} 1 ${ex} ${ey}`}
          fill="none" stroke="#f37321" strokeWidth={2.5} strokeLinecap="round"
        />
      )}
      {/* Knob body */}
      <circle cx={cx} cy={cy} r={R - 5} fill="#f6f6f6" stroke="#bdbdbd" strokeWidth={1} />
      {/* Indicator dot */}
      <circle cx={ix} cy={iy} r={2} fill="#f37321" />
    </svg>
  );
}
