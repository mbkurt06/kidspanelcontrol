import type { UseMode } from "../lib/types";
import { Info } from "./Info";

/** Görevden kazanılan sürenin kullanımı (3 mod) */
export function UseModePicker({ mode, within, onMode, onWithin }: { mode: UseMode; within: string; onMode: (m: UseMode) => void; onWithin: (v: string) => void }) {
  const OPTS: Array<[UseMode, string, string]> = [
    ["usage", "Kullandıkça düşsün", "Telefon hemen açılır, süre kullandıkça düşer. Açık saatler bitince (programdaki son açık saat) kalan kasaya gider."],
    ["clock", "Saat gibi aksın", "Telefon hemen bu kadar dakikalığına açılır, kullanmasa da süre akar. Kullanmadığı dakikalar kasaya gider."],
    ["within", "Belirli süre içinde", "Kullandıkça düşer ama seçilen süre içinde kullanmalı. Süre dolunca ya da açık saatler bitince kalan kasaya gider."],
  ];
  return (
    <div className="field">
      <span>Kazanılan süre nasıl kullanılsın <Info>Görevden kazanılan süre açık saatlerin dışına taşmaz (açık saatler: günlük programda Kilitli olmayan bölümler). Bu süre sürerken zorunlu görev kısıtlaması ve kısıtlı saatler kalkar.</Info></span>
      <div className="chips">
        {OPTS.map(([k, l]) => <button key={k} type="button" className={`chip-btn ${mode === k ? "on" : ""}`} onClick={() => onMode(k)}>{l}</button>)}
      </div>
      {mode === "within" && (
        <select value={within} onChange={(e) => onWithin(e.target.value)} aria-label="Kullanma süresi">
          <option value="60">1 saat içinde</option>
          <option value="120">2 saat içinde</option>
          <option value="180">3 saat içinde</option>
        </select>
      )}
      <span className="muted tiny">{OPTS.find((o) => o[0] === mode)?.[2]}</span>
    </div>
  );
}
