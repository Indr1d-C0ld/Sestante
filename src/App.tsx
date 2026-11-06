import { lazy, Suspense, useEffect, useState } from "react";
import { Atlas } from "./atlas/Atlas.tsx";
import { Studio } from "./atlas/Studio.tsx";
import { api } from "./core/api.ts";
import { newExpedition, type Expedition, type FieldSpec } from "./core/types.ts";

const FieldScreen = lazy(() => import("./field/FieldScreen.tsx").then((m) => ({ default: m.FieldScreen })));

type Screen =
  | { name: "atlas" }
  | { name: "studio"; spec: FieldSpec; canvas?: HTMLCanvasElement }
  | { name: "field"; expedition: Expedition; canvas?: HTMLCanvasElement; findings: { title: string; text: string }[]; study?: string };

export function App() {
  const [screen, setScreen] = useState<Screen>({ name: "atlas" });
  const [lastBox, setLastBox] = useState<FieldSpec["bbox"] | undefined>(undefined);

  useEffect(() => {
    // A deep link makes spedizioni shareable between tabs and lets the smoke test land directly on a field.
    const params = new URLSearchParams(location.search);
    const trip = params.get("spedizione");
    if (trip) void api.expedition(trip).then((expedition) => setScreen({ name: "field", expedition, findings: [], study: params.get("studio") ?? undefined }));
  }, []);

  // The map and the world both need WebGL2: without it, say so instead of leaving a blank page.
  if (!document.createElement("canvas").getContext("webgl2")) {
    return (
      <div className="loading">
        <h2>Serve WebGL2</h2>
        <p>Questo browser non offre WebGL2, quindi né la mappa né il mondo possono partire. Apri Sestante in Firefox o Chromium con l'accelerazione grafica attiva.</p>
      </div>
    );
  }

  if (screen.name === "atlas") {
    return (
      <Atlas
        initial={lastBox}
        onOpen={(spec, canvas) => {
          setLastBox(spec.bbox);
          setScreen({ name: "studio", spec, canvas });
        }}
        onResume={(id, study) => void api.expedition(id).then((expedition) => setScreen({ name: "field", expedition, findings: [], study }))}
      />
    );
  }
  if (screen.name === "studio") {
    return (
      <Studio
        spec={screen.spec}
        initialCanvas={screen.canvas}
        onBack={() => setScreen({ name: "atlas" })}
        // Coming back through the Studio must not start the investigation over.
        onDescend={(spec, canvas, findings) =>
          void api
            .expedition(spec.id)
            .catch(() => newExpedition(spec))
            .then((expedition) => setScreen({ name: "field", expedition, canvas, findings }))
        }
      />
    );
  }
  return (
    <Suspense fallback={<div className="loading"><h2>Preparo l'attrezzatura…</h2></div>}>
      <FieldScreen
        expedition={screen.expedition}
        canvas={screen.canvas}
        findings={screen.findings}
        study={screen.study}
        onExit={(spec) => {
          setLastBox(spec.bbox);
          setScreen({ name: "atlas" });
        }}
      />
    </Suspense>
  );
}
