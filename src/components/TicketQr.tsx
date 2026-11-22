"use client";

import { useEffect, useState } from "react";

/**
 * QR del código del boleto generado con la librería `qrcode` → data URL.
 * Si la librería falla al cargar, se muestra el código en texto en lugar
 * de romper la página.
 */
export default function TicketQr({ code, size = 160 }: { code: string; size?: number }) {
  const [dataUrl, setDataUrl] = useState<string | null>(null);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    let cancelled = false;
    import("qrcode")
      .then((mod) => mod.toDataURL(code, { width: size, margin: 1 }))
      .then((url) => {
        if (!cancelled) setDataUrl(url);
      })
      .catch(() => {
        if (!cancelled) setFailed(true);
      });
    return () => {
      cancelled = true;
    };
  }, [code, size]);

  if (dataUrl) {
    // eslint-disable-next-line @next/next/no-img-element
    return <img src={dataUrl} alt={`Código QR del boleto ${code}`} width={size} height={size} className="rounded-lg border border-stone-200 bg-white" />;
  }
  return (
    <div
      className="flex items-center justify-center rounded-lg border border-dashed border-stone-300 bg-stone-50 px-3 text-center font-mono text-sm font-bold text-stone-700"
      style={{ width: size, height: size }}
      title={failed ? "La librería qrcode aún no está instalada" : "Generando QR…"}
    >
      {failed ? code : "Generando QR…"}
    </div>
  );
}
