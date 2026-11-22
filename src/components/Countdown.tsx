"use client";

import { useEffect, useState } from "react";

function parts(diffMs: number) {
  const total = Math.max(0, Math.floor(diffMs / 1000));
  return {
    days: Math.floor(total / 86400),
    hours: Math.floor((total % 86400) / 3600),
    minutes: Math.floor((total % 3600) / 60),
    seconds: total % 60,
  };
}

/** Cuenta regresiva en vivo hasta la fecha del sorteo. */
export default function Countdown({ target, compact = false }: { target: string; compact?: boolean }) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(id);
  }, []);

  const diff = new Date(target).getTime() - now;
  if (Number.isNaN(new Date(target).getTime())) return null;
  if (diff <= 0) return <span className="font-semibold text-rose-700">¡Sorteo en curso o finalizado!</span>;

  const { days, hours, minutes, seconds } = parts(diff);
  const pad = (n: number) => String(n).padStart(2, "0");
  const units: Array<[string, string]> = [
    [`${days}`, "días"],
    [pad(hours), "horas"],
    [pad(minutes), "min"],
    [pad(seconds), "seg"],
  ];

  return (
    <span className={`inline-flex items-center gap-2 ${compact ? "text-sm" : "text-base"}`} aria-live="off">
      {units.map(([value, label]) => (
        <span key={label} className="inline-flex flex-col items-center rounded-lg bg-stone-900 px-2 py-1 text-white">
          <span className="font-mono font-bold leading-none">{value}</span>
          <span className="text-[10px] uppercase tracking-wide text-stone-300">{label}</span>
        </span>
      ))}
    </span>
  );
}
