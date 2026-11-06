import { useEffect, useState } from "react";
import type { Engine } from "../world/engine.ts";
import { PRESETS, type Settings } from "../world/settings.ts";
import { WEATHER_PRESETS, type WeatherValues } from "../world/sim.ts";
import { sunEvents } from "../core/solar.ts";

type Tab = "tempo" | "meteo" | "grafica" | "mondo" | "esploratore" | "audio";

function Slider({ label, note, value, min, max, step, format, onChange }: { label: string; note?: string; value: number; min: number; max: number; step: number; format?: (v: number) => string; onChange: (v: number) => void }) {
  return (
    <label className="setting">
      <span>
        {label}
        {note && <span className="note">{note}</span>}
      </span>
      <span>
        <input type="range" min={min} max={max} step={step} value={value} onChange={(e) => onChange(Number(e.target.value))} />
        <span className="val" style={{ display: "block" }}>
          {format ? format(value) : value}
        </span>
      </span>
    </label>
  );
}

function Check({ label, note, value, onChange }: { label: string; note?: string; value: boolean; onChange: (v: boolean) => void }) {
  return (
    <label className="setting">
      <span>
        {label}
        {note && <span className="note">{note}</span>}
      </span>
      <input type="checkbox" checked={value} style={{ justifySelf: "end" }} onChange={(e) => onChange(e.target.checked)} />
    </label>
  );
}

export function SettingsPanel({ engine, settings, onChange, onClose, onShotDay, shotInfo }: { engine: Engine; settings: Settings; onChange: (s: Settings) => void; onClose: () => void; onShotDay: () => void; shotInfo: string | null }) {
  const [tab, setTab] = useState<Tab>("tempo");
  const [, tick] = useState(0);
  useEffect(() => {
    const timer = window.setInterval(() => tick((n) => n + 1), 500);
    return () => window.clearInterval(timer);
  }, []);
  const set = <K extends keyof Settings>(key: K, value: Settings[K]) => onChange({ ...settings, [key]: value, ...(["renderScale", "shadowSize", "cascades", "shadowFar", "ao", "bloom", "clouds", "treeDensity", "treeNear", "grass", "drawFar"].includes(key as string) ? { preset: "Personale" } : {}) });
  const clock = engine.clock;
  const weather = engine.weather;

  const toLocalInput = () => {
    const offset = clock.offsetMinutes();
    return new Date(clock.t + offset * 60000).toISOString().slice(0, 16);
  };
  const fromLocalInput = (value: string) => {
    const naive = Date.parse(`${value}:00Z`);
    if (!Number.isFinite(naive)) return;
    clock.setCustom(naive - clock.offsetMinutes(new Date(naive)) * 60000, clock.mode === "live" ? 1 : clock.rate);
    tick((n) => n + 1);
  };
  const setW = <K extends keyof WeatherValues>(key: K, value: WeatherValues[K]) => {
    weather.mode = "manual";
    weather.target = { ...weather.target, [key]: value };
    tick((n) => n + 1);
  };
  const events = sunEvents(clock.date, engine.data.projection.lat0, engine.data.projection.lon0);
  const hourOf = (d: Date | null) => (d ? clock.civil({ hour: "2-digit", minute: "2-digit" }, d) : "—");

  const stepHours = (hours: number) => {
    clock.setCustom(clock.t + hours * 3600000, clock.mode === "live" ? 1 : clock.rate);
    tick((n) => n + 1);
  };

  return (
    <div className="panel wide" onClick={(e) => e.stopPropagation()}>
      <header className="panel-head">
        <h2 className="grow">Impostazioni</h2>
        <button className="btn tiny" onClick={onClose}>
          Chiudi (O)
        </button>
      </header>
      <div className="panel-body" style={{ padding: 0 }}>
        <div className="settings">
          <nav>
            {(
              [
                ["tempo", "Tempo"],
                ["meteo", "Meteo"],
                ["grafica", "Motore grafico"],
                ["mondo", "Ricostruzione"],
                ["esploratore", "Esploratore"],
                ["audio", "Suono"],
              ] as [Tab, string][]
            ).map(([id, label]) => (
              <button key={id} className={tab === id ? "on" : ""} onClick={() => setTab(id)}>
                {label}
              </button>
            ))}
          </nav>
          <section>
            {tab === "tempo" && (
              <>
                <p>
                  <b className="mono">{clock.civil({ dateStyle: "full", timeStyle: "medium" } as Intl.DateTimeFormatOptions)}</b>
                  <br />
                  <span className="muted small">
                    {clock.timezone} · {clock.mode === "live" ? "tempo reale 1:1" : clock.paused ? "fermo" : `×${clock.rate}`} · alba {hourOf(events.rise)}, tramonto {hourOf(events.set)}
                  </span>
                </p>
                <div className="row wrap">
                  <button className={`btn ${clock.mode === "live" ? "on" : ""}`} onClick={() => { clock.backToLive(); tick((n) => n + 1); }}>
                    Adesso, 1:1
                  </button>
                  <button className="btn" onClick={() => { clock.setCustom(clock.t, clock.rate); clock.paused = !clock.paused; tick((n) => n + 1); }}>
                    {clock.paused ? "Riprendi" : "Ferma"}
                  </button>
                  {[1, 60, 600, 3600, 21600].map((rate) => (
                    <button key={rate} className={`btn ${clock.mode === "custom" && !clock.paused && clock.rate === rate ? "on" : ""}`} onClick={() => { clock.setCustom(clock.t, rate); clock.paused = false; tick((n) => n + 1); }}>
                      ×{rate}
                    </button>
                  ))}
                </div>
                <label className="setting">
                  <span>Data e ora del luogo</span>
                  <input type="datetime-local" value={toLocalInput()} onChange={(e) => fromLocalInput(e.target.value)} />
                </label>
                <Slider
                  label="Ora del giorno"
                  value={Number(clock.civil({ hour: "numeric", hourCycle: "h23" } as Intl.DateTimeFormatOptions)) + Number(clock.civil({ minute: "numeric" })) / 60}
                  min={0}
                  max={23.98}
                  step={0.05}
                  format={(v) => `${Math.floor(v)}:${String(Math.floor((v % 1) * 60)).padStart(2, "0")}`}
                  onChange={(v) => {
                    const current = Number(clock.civil({ hour: "numeric", hourCycle: "h23" } as Intl.DateTimeFormatOptions)) + Number(clock.civil({ minute: "numeric" })) / 60;
                    clock.setCustom(clock.t + (v - current) * 3600000, clock.mode === "live" ? 1 : clock.rate);
                    clock.paused = true;
                    tick((n) => n + 1);
                  }}
                />
                <div className="row wrap">
                  <button className="btn tiny" onClick={() => stepHours(-24)}>−1 giorno</button>
                  <button className="btn tiny" onClick={() => stepHours(24)}>+1 giorno</button>
                  <button className="btn tiny" onClick={() => stepHours(-24 * 30)}>−30 giorni</button>
                  <button className="btn tiny" onClick={() => stepHours(24 * 30)}>+30 giorni</button>
                  <button className="btn tiny" onClick={() => events.rise && (clock.setCustom(events.rise.valueOf() - 1800000, 60), tick((n) => n + 1))}>Alba</button>
                  <button className="btn tiny" onClick={() => events.transit && (clock.setCustom(events.transit.valueOf(), clock.mode === "live" ? 1 : clock.rate), tick((n) => n + 1))}>Mezzogiorno vero</button>
                  <button className="btn tiny" onClick={() => events.set && (clock.setCustom(events.set.valueOf() - 1800000, 60), tick((n) => n + 1))}>Tramonto</button>
                </div>
                <div>
                  <button className="btn" onClick={onShotDay}>
                    Giorno e ora dello scatto
                  </button>
                  <p className="hint">{shotInfo ?? "Porta sole e meteo al momento in cui la lastra fu ripresa: le ombre del 3D devono cadere sulle ombre della foto. È il controllo più onesto della ricostruzione."}</p>
                </div>
              </>
            )}
            {tab === "meteo" && (
              <>
                <div className="row wrap">
                  <button className={`btn ${weather.mode === "live" ? "on" : ""}`} onClick={() => { weather.mode = "live"; tick((n) => n + 1); }}>
                    Stazione reale
                  </button>
                  <button className={`btn ${weather.mode === "manual" ? "on" : ""}`} onClick={() => { weather.mode = "manual"; tick((n) => n + 1); }}>
                    A mano
                  </button>
                  <span className="muted small">{engine.data.weather ? "Open-Meteo, aggiornato ogni 10 minuti" : "stazione non raggiunta"}</span>
                </div>
                <div className="row wrap">
                  {Object.entries(WEATHER_PRESETS).map(([name, values]) => (
                    <button key={name} className="btn tiny" onClick={() => { weather.mode = "manual"; weather.target = { ...weather.target, ...values }; tick((n) => n + 1); }}>
                      {name}
                    </button>
                  ))}
                </div>
                <Slider label="Copertura nuvolosa" value={weather.target.cloud * 100} min={0} max={100} step={1} format={(v) => `${v.toFixed(0)} %`} onChange={(v) => setW("cloud", v / 100)} />
                <Slider label="Pioggia" value={weather.target.rain} min={0} max={30} step={0.1} format={(v) => `${v.toFixed(1)} mm/h`} onChange={(v) => setW("rain", v)} />
                <Slider label="Neve" value={weather.target.snow} min={0} max={6} step={0.1} format={(v) => `${v.toFixed(1)} cm/h`} onChange={(v) => setW("snow", v)} />
                <Slider label="Visibilità" note="Nebbia sotto 1 km" value={Math.log10(weather.target.visibility)} min={1.7} max={4.7} step={0.01} format={(v) => { const m = 10 ** v; return m > 1000 ? `${(m / 1000).toFixed(1)} km` : `${m.toFixed(0)} m`; }} onChange={(v) => setW("visibility", 10 ** v)} />
                <Slider label="Vento a 10 m" value={weather.target.wind} min={0} max={32} step={0.1} format={(v) => `${v.toFixed(1)} m/s`} onChange={(v) => setW("wind", v)} />
                <Slider label="Direzione del vento" value={weather.target.windDir} min={0} max={359} step={1} format={(v) => `da ${v.toFixed(0)}°`} onChange={(v) => setW("windDir", v)} />
                <Slider label="Temperatura" value={weather.target.temp} min={-30} max={50} step={0.5} format={(v) => `${v.toFixed(1)} °C`} onChange={(v) => setW("temp", v)} />
                <Slider label="Umidità" value={weather.target.humidity} min={5} max={100} step={1} format={(v) => `${v.toFixed(0)} %`} onChange={(v) => setW("humidity", v)} />
                <Slider label="Pressione al mare" value={weather.target.pressureMsl} min={960} max={1050} step={0.5} format={(v) => `${v.toFixed(1)} hPa`} onChange={(v) => setW("pressureMsl", v)} />
                <Check label="Temporale con fulmini" value={weather.target.thunder > 0.5} onChange={(v) => setW("thunder", v ? 1 : 0)} />
              </>
            )}
            {tab === "grafica" && (
              <>
                <div className="row wrap">
                  {Object.keys(PRESETS).map((name) => (
                    <button key={name} className={`btn ${settings.preset === name ? "on" : ""}`} onClick={() => onChange({ ...settings, ...PRESETS[name]!, preset: name })}>
                      {name}
                    </button>
                  ))}
                </div>
                <Slider label="Scala di rendering" value={settings.renderScale} min={0.5} max={2} step={0.05} format={(v) => `${(v * 100).toFixed(0)} %`} onChange={(v) => set("renderScale", v)} />
                <Check label="Risoluzione dinamica" note="Scende da sola per tenere il ritmo" value={settings.dynamicRes} onChange={(v) => set("dynamicRes", v)} />
                <Slider label="Obiettivo fotogrammi" value={settings.targetFps} min={20} max={120} step={5} format={(v) => `${v} fps`} onChange={(v) => set("targetFps", v)} />
                <Slider label="Mappa d'ombra" value={settings.shadowSize} min={1024} max={4096} step={512} format={(v) => `${v} px`} onChange={(v) => set("shadowSize", v)} />
                <Slider label="Distanza delle ombre" value={settings.shadowFar} min={150} max={2000} step={50} format={(v) => `${v} m`} onChange={(v) => set("shadowFar", v)} />
                <Slider label="Occlusione ambientale" value={settings.ao} min={0} max={1.5} step={0.05} onChange={(v) => set("ao", v)} />
                <Slider label="Bagliore" value={settings.bloom} min={0} max={1.5} step={0.05} onChange={(v) => set("bloom", v)} />
                <label className="setting">
                  <span>Nuvole</span>
                  <select value={settings.clouds} onChange={(e) => set("clouds", Number(e.target.value))}>
                    <option value={0}>Velo semplice</option>
                    <option value={1}>Volumetriche</option>
                    <option value={2}>Volumetriche fini</option>
                  </select>
                </label>
                <Slider label="Prospettiva aerea" value={settings.aerial} min={0} max={2} step={0.05} onChange={(v) => set("aerial", v)} />
                <Slider label="Orizzonte" value={settings.drawFar} min={2000} max={40000} step={500} format={(v) => `${(v / 1000).toFixed(1)} km`} onChange={(v) => set("drawFar", v)} />
                <label className="setting">
                  <span>Resa tonale</span>
                  <select value={settings.tonemap} onChange={(e) => set("tonemap", e.target.value as Settings["tonemap"])}>
                    <option value="agx">AgX (pellicola)</option>
                    <option value="aces">ACES (cinema)</option>
                    <option value="neutral">Neutra (fedele)</option>
                  </select>
                </label>
                <Slider label="Esposizione" value={settings.exposure} min={0.3} max={3} step={0.05} onChange={(v) => set("exposure", v)} />
                <Check label="Adattamento dell'occhio" note="Compensa giorno e notte" value={settings.autoExposure} onChange={(v) => set("autoExposure", v)} />
                <Slider label="Saturazione" value={settings.saturation} min={0} max={1.8} step={0.01} onChange={(v) => set("saturation", v)} />
                <Slider label="Vignettatura" value={settings.vignette} min={0} max={0.8} step={0.01} onChange={(v) => set("vignette", v)} />
                <Slider label="Grana" value={settings.grain} min={0} max={0.1} step={0.002} onChange={(v) => set("grain", v)} />
                <Slider label="Lunga posa" note="Esposizioni sommate per ogni foto a lunga posa" value={settings.longExposure} min={8} max={128} step={8} format={(v) => `${v}`} onChange={(v) => set("longExposure", v)} />
                <Slider label="Studio della luce" note="Campioni per pixel: più sono, meno rumore e più attesa" value={settings.traceSamples} min={16} max={512} step={16} format={(v) => `${v}`} onChange={(v) => set("traceSamples", v)} />
                <Slider label="Campo visivo" value={settings.fov} min={40} max={110} step={1} format={(v) => `${v}°`} onChange={(v) => set("fov", v)} />
                <Check label="Prestazioni a schermo" value={settings.showPerf} onChange={(v) => set("showPerf", v)} />
              </>
            )}
            {tab === "mondo" && (
              <>
                <Check label="Edifici mappati" note="Da OpenStreetMap, con altezze lette dalle ombre dove mancano" value={settings.showBuildings} onChange={(v) => set("showBuildings", v)} />
                <Check label="Corpi dedotti dalla ripresa" note="Dove un tetto e un'ombra ci sono ma la mappa tace" value={settings.showMasses} onChange={(v) => set("showMasses", v)} />
                <Check label="Alberi" value={settings.showTrees} onChange={(v) => set("showTrees", v)} />
                <Slider label="Densità alberi" value={settings.treeDensity} min={0.1} max={1} step={0.05} format={(v) => `${(v * 100).toFixed(0)} %`} onChange={(v) => set("treeDensity", v)} />
                <Slider label="Raggio chiome fini" value={settings.treeNear} min={20} max={300} step={10} format={(v) => `${v} m`} onChange={(v) => set("treeNear", v)} />
                <Slider label="Erba" value={settings.grass} min={0} max={1} step={0.05} format={(v) => `${(v * 100).toFixed(0)} %`} onChange={(v) => set("grass", v)} />
                <Check label="Arredi" note="Lampioni, panchine, monumenti, pali" value={settings.showProps} onChange={(v) => set("showProps", v)} />
                <Check label="Muri e recinzioni" value={settings.showFences} onChange={(v) => set("showFences", v)} />
                <Check label="Acque" value={settings.showWater} onChange={(v) => set("showWater", v)} />
                <Check label="Terra attorno alla ripresa" note="Mosaico a bassa risoluzione fino all'orizzonte" value={settings.farField} onChange={(v) => set("farField", v)} />
                <Check label="Togli le ombre dalla foto" note="Corregge le ombre incise nella lastra, per lasciare spazio a quelle vere" value={settings.deshadow} onChange={(v) => set("deshadow", v)} />
                <Slider label="Dettaglio ravvicinato del suolo" value={settings.detail} min={0} max={1} step={0.05} onChange={(v) => set("detail", v)} />
                <Check label="Griglia di 100 m sul suolo" value={settings.gridOverlay} onChange={(v) => set("gridOverlay", v)} />
                <label className="setting">
                  <span>
                    Fonte del rilievo
                    <span className="note">Vale dalla prossima discesa. NASADEM è il rilievo del 2000 rielaborato, Copernicus è più recente. Tutte misurano anche tetti e chiome.</span>
                  </span>
                  <select value={settings.demSource} onChange={(e) => set("demSource", e.target.value as Settings["demSource"])}>
                    <option value="terrarium">Terrarium (SRTM e altri)</option>
                    <option value="copernicus">Copernicus GLO-30</option>
                    <option value="nasadem">NASADEM (richiede il token Earthdata)</option>
                    <option value="lidar">LiDAR nazionale, dove esiste</option>
                  </select>
                </label>
              </>
            )}
            {tab === "esploratore" && (
              <>
                <Slider label="Passo" value={settings.walkSpeed} min={0.6} max={3} step={0.05} format={(v) => `${v.toFixed(2)} m/s`} onChange={(v) => set("walkSpeed", v)} />
                <Slider label="Corsa" value={settings.runSpeed} min={2} max={15} step={0.1} format={(v) => `${v.toFixed(1)} m/s`} onChange={(v) => set("runSpeed", v)} />
                <div className="section-title">Il tuo alter-ego</div>
                <p className="hint">Il corpo con cui vedi il mondo, in misure vere: dà gli occhi alla giusta quota e la falcata giusta. Con il tasto X lo guardi da fuori; con lo strumento Alter-ego ne lasci una copia accanto a ciò che vuoi confrontare.</p>
                <Slider
                  label="Altezza"
                  value={settings.altEgoHeight}
                  min={0.5}
                  max={2.5}
                  step={0.01}
                  format={(v) => `${v.toFixed(2)} m`}
                  onChange={(v) => onChange({ ...settings, altEgoHeight: v, eye: v * 0.934, stride: v * 0.43 })}
                />
                <Slider label="Larghezza delle spalle" value={settings.altEgoShoulders} min={0.25} max={0.7} step={0.005} format={(v) => `${(v * 100).toFixed(0)} cm`} onChange={(v) => set("altEgoShoulders", v)} />
                <Slider label="Corporatura" note="1 è una corporatura media" value={settings.altEgoBuild} min={0.7} max={1.6} step={0.01} format={(v) => v.toFixed(2)} onChange={(v) => set("altEgoBuild", v)} />
                <div className="row wrap">
                  <label className="field">
                    Maglia
                    <input type="color" value={settings.altEgoShirt} onChange={(e) => set("altEgoShirt", e.target.value)} />
                  </label>
                  <label className="field">
                    Pantaloni
                    <input type="color" value={settings.altEgoTrousers} onChange={(e) => set("altEgoTrousers", e.target.value)} />
                  </label>
                  <label className="field">
                    Pelle
                    <input type="color" value={settings.altEgoSkin} onChange={(e) => set("altEgoSkin", e.target.value)} />
                  </label>
                </div>
                <Check label="Guardati da fuori" note="Tasto X. Le misure partono comunque dai tuoi occhi" value={settings.thirdPerson} onChange={(v) => set("thirdPerson", v)} />
                <div className="section-title">Movimento</div>
                <Slider label="Altezza degli occhi" value={settings.eye} min={0.4} max={2.4} step={0.01} format={(v) => `${v.toFixed(2)} m`} onChange={(v) => set("eye", v)} />
                <Slider label="Falcata" note="Il contapassi usa questo valore" value={settings.stride} min={0.2} max={1.1} step={0.01} format={(v) => `${v.toFixed(2)} m`} onChange={(v) => set("stride", v)} />
                <Slider label="Oscillazione del passo" value={settings.bob} min={0} max={1.5} step={0.05} onChange={(v) => set("bob", v)} />
                <Slider label="Sensibilità" value={settings.sensitivity} min={0.2} max={3} step={0.05} onChange={(v) => set("sensitivity", v)} />
                <Check label="Inverti asse verticale" value={settings.invertY} onChange={(v) => set("invertY", v)} />
                <Check label="Registro automatico" note="Una tappa ogni tanti metri, con passi, quota e meteo" value={settings.autoLog} onChange={(v) => set("autoLog", v)} />
                <Slider label="Lunghezza della tappa" value={settings.stageMeters} min={50} max={1000} step={10} format={(v) => `${v} m`} onChange={(v) => set("stageMeters", v)} />
              </>
            )}
            {tab === "audio" && (
              <>
                <Slider label="Volume" value={settings.volume} min={0} max={1} step={0.02} onChange={(v) => set("volume", v)} />
                <Slider label="Ambiente" note="Vento, pioggia, uccelli e grilli secondo le condizioni reali" value={settings.ambience} min={0} max={1} step={0.02} onChange={(v) => set("ambience", v)} />
              </>
            )}
          </section>
        </div>
      </div>
    </div>
  );
}
