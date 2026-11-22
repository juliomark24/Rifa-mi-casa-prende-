"use client";

import { useState } from "react";

/** Copia el link de referido al portapapeles. */
export default function CopyLinkButton({ link }: { link: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <span className="inline-flex items-center gap-2">
      <code className="break-all rounded-lg bg-stone-100 px-3 py-2 text-sm font-semibold text-stone-800">{link}</code>
      <button
        type="button"
        onClick={async () => {
          try {
            await navigator.clipboard.writeText(link);
            setCopied(true);
            setTimeout(() => setCopied(false), 2000);
          } catch {
            // Portapapeles no disponible; el link queda visible para copiarlo a mano.
          }
        }}
        className="shrink-0 rounded-lg bg-orange-600 px-3 py-2 text-xs font-bold text-white hover:bg-orange-700"
      >
        {copied ? "¡Copiado!" : "Copiar"}
      </button>
    </span>
  );
}
