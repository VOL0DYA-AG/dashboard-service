import { useState } from "react";
import {
  ATTR,
  LIMITS,
  MODE_LABEL,
  MODES,
  STATUS_LABEL,
  clampSetpoint,
  formatTemp,
  type AttributeWrite,
  type Mode,
  type Plant,
} from "@contract";

export function Overview({
  plant,
  username,
  onWrite,
}: {
  plant: Plant;
  username: string;
  onWrite: (write: AttributeWrite) => Promise<void>;
}) {
  const [sheet, setSheet] = useState<{ id: string; name: string; mode: Mode } | null>(null);

  return (
    <main className="screen">
      <header className="top">
        <div>
          <p className="eyebrow">Личный кабинет</p>
          <h1>{plant.name}</h1>
        </div>
        <div className={plant.online ? "pill ok" : "pill bad"}>{plant.online ? "на связи" : "нет связи"}</div>
      </header>
      <p className="who">{username}</p>
      {plant.alarmActive && <div className="alarm">{plant.alarmText || "Авария"}</div>}
      <section className="outdoor">
        <span>Улица</span>
        <strong>{formatTemp(plant.outdoorTemperature)}</strong>
      </section>
      <article className="card">
        <div className="card-head">
          <h2>{plant.boiler.name}</h2>
          <span className={`status ${plant.boiler.status}`}>{STATUS_LABEL[plant.boiler.status]}</span>
        </div>
        <div className="metrics">
          <Metric label="Подача" value={formatTemp(plant.boiler.supplyTemperature)} />
          <Metric label="Обратка" value={formatTemp(plant.boiler.returnTemperature)} />
          <Metric label="Горелка" value={plant.boiler.flame ? "горит" : "погашена"} />
        </div>
        <div className="row">
          <span>Котёл</span>
          <button
            type="button"
            className={plant.boiler.enabled ? "switch on" : "switch"}
            onClick={() => onWrite({ id: plant.boiler.id, name: ATTR.enabled, value: !plant.boiler.enabled })}
          >
            {plant.boiler.enabled ? "Включён" : "Выключен"}
          </button>
        </div>
        <Setpoint
          label="Предел подачи"
          value={plant.boiler.maxSupplySetpoint}
          limit={LIMITS.maxSupply}
          onChange={(value) => onWrite({ id: plant.boiler.id, name: ATTR.maxSupply, value })}
        />
      </article>
      {plant.circuits.map((circuit) => (
        <LoopCard
          key={circuit.id}
          title={circuit.name}
          factLabel="Помещение"
          fact={circuit.roomTemperature}
          extraLabel="Подача"
          extra={circuit.flowTemperature}
          setpoint={circuit.setpoint}
          limit={LIMITS.circuit}
          mode={circuit.mode}
          pumpOn={circuit.pumpOn}
          onSetpoint={(value) => onWrite({ id: circuit.id, name: ATTR.setpoint, value })}
          onMode={() => setSheet({ id: circuit.id, name: circuit.name, mode: circuit.mode })}
        />
      ))}
      {plant.dhw && (
        <LoopCard
          title={plant.dhw.name}
          factLabel="Температура"
          fact={plant.dhw.temperature}
          setpoint={plant.dhw.setpoint}
          limit={LIMITS.dhw}
          mode={plant.dhw.mode}
          pumpOn={plant.dhw.pumpOn}
          onSetpoint={(value) => onWrite({ id: plant.dhw!.id, name: ATTR.setpoint, value })}
          onMode={() => setSheet({ id: plant.dhw!.id, name: plant.dhw!.name, mode: plant.dhw!.mode })}
        />
      )}
      {sheet && (
        <ModeSheet
          name={sheet.name}
          mode={sheet.mode}
          onClose={() => setSheet(null)}
          onPick={(mode) => {
            void onWrite({ id: sheet.id, name: ATTR.mode, value: mode });
            setSheet(null);
          }}
        />
      )}
    </main>
  );
}

function LoopCard({
  title,
  factLabel,
  fact,
  extraLabel,
  extra,
  setpoint,
  limit,
  mode,
  pumpOn,
  onSetpoint,
  onMode,
}: {
  title: string;
  factLabel: string;
  fact: number;
  extraLabel?: string;
  extra?: number;
  setpoint: number;
  limit: { min: number; max: number; step: number };
  mode: Mode;
  pumpOn: boolean;
  onSetpoint: (value: number) => void;
  onMode: () => void;
}) {
  return (
    <article className="card">
      <div className="card-head">
        <h2>{title}</h2>
        <span className={pumpOn ? "status heating" : "status off"}>{pumpOn ? "насос работает" : "насос стоит"}</span>
      </div>
      <div className="metrics">
        <Metric label={factLabel} value={formatTemp(fact)} large />
        {extraLabel !== undefined && extra !== undefined && <Metric label={extraLabel} value={formatTemp(extra)} />}
      </div>
      <Setpoint label="Уставка" value={setpoint} limit={limit} onChange={onSetpoint} />
      <button type="button" className="mode" onClick={onMode}>
        Режим: {MODE_LABEL[mode]}
      </button>
    </article>
  );
}

function Metric({ label, value, large = false }: { label: string; value: string; large?: boolean }) {
  return (
    <div className={large ? "metric large" : "metric"}>
      <span>{label}</span>
      <strong>{value}</strong>
    </div>
  );
}

function Setpoint({
  label,
  value,
  limit,
  onChange,
}: {
  label: string;
  value: number;
  limit: { min: number; max: number; step: number };
  onChange: (value: number) => void;
}) {
  return (
    <div className="setpoint">
      <span>{label}</span>
      <div>
        <button type="button" aria-label="Меньше" onClick={() => onChange(clampSetpoint(kindOf(limit), value - limit.step))}>
          −
        </button>
        <strong>{formatTemp(value)}</strong>
        <button type="button" aria-label="Больше" onClick={() => onChange(clampSetpoint(kindOf(limit), value + limit.step))}>
          +
        </button>
      </div>
    </div>
  );
}

function kindOf(limit: { min: number; max: number; step: number }): "circuit" | "dhw" | "maxSupply" {
  if (limit === LIMITS.dhw) return "dhw";
  if (limit === LIMITS.maxSupply) return "maxSupply";
  return "circuit";
}

function ModeSheet({
  name,
  mode,
  onPick,
  onClose,
}: {
  name: string;
  mode: Mode;
  onPick: (mode: Mode) => void;
  onClose: () => void;
}) {
  return (
    <div className="sheet-back" onClick={onClose} role="presentation">
      <div className="sheet" onClick={(event) => event.stopPropagation()} role="dialog" aria-label={`Режим ${name}`}>
        <h2>{name}</h2>
        {MODES.map((item) => (
          <button type="button" key={item} className={item === mode ? "active" : ""} onClick={() => onPick(item)}>
            {MODE_LABEL[item]}
          </button>
        ))}
      </div>
    </div>
  );
}

export function Journal({ plant }: { plant: Plant }) {
  const rows = [...plant.journal].sort((a, b) => b.t - a.t);
  return (
    <main className="screen">
      <header className="top">
        <div>
          <p className="eyebrow">События</p>
          <h1>Журнал</h1>
        </div>
      </header>
      {plant.alarmActive && <div className="alarm">{plant.alarmText}</div>}
      {rows.length === 0 ? (
        <p className="note">Пока пусто. Смена уставки, режима и аварии появятся здесь.</p>
      ) : (
        <ul className="log">
          {rows.map((row) => (
            <li key={`${row.t}-${row.text}`} className={row.level}>
              <time>{new Date(row.t).toLocaleString("ru-RU", { day: "2-digit", month: "2-digit", hour: "2-digit", minute: "2-digit" })}</time>
              <span>{row.text}</span>
            </li>
          ))}
        </ul>
      )}
    </main>
  );
}
