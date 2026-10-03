import { lazy, Suspense, useCallback, useEffect, useState } from "react";
import type { CabinetApi } from "./api";
import { Journal, Overview } from "./screens";

const Charts = lazy(() => import("./charts").then((mod) => ({ default: mod.Charts })));
import type { AttributeWrite, Plant } from "@contract";
import { applyWrite } from "@contract";

type Tab = "home" | "charts" | "log";

export function App({ api }: { api: CabinetApi }) {
  const [tab, setTab] = useState<Tab>("home");
  const [plant, setPlant] = useState<Plant | null>(null);
  const [error, setError] = useState("");
  const [toast, setToast] = useState("");

  useEffect(() => {
    let alive = true;
    api.load().then(
      (loaded) => {
        if (alive) setPlant(loaded);
      },
      (reason: unknown) => {
        if (alive) setError(reason instanceof Error ? reason.message : "Нет данных котельной");
      },
    );
    const unsubscribe = api.subscribe((next) => {
      if (alive) setPlant(next);
    });
    return () => {
      alive = false;
      unsubscribe();
    };
  }, [api]);

  const write = useCallback(
    async (attribute: AttributeWrite) => {
      if (!plant) return;
      const previous = plant;
      setPlant(applyWrite(plant, attribute));
      try {
        await api.write(attribute);
      } catch (reason) {
        setPlant(previous);
        setToast(reason instanceof Error ? reason.message : "Уставка не записалась");
        window.setTimeout(() => setToast(""), 4000);
      }
    },
    [api, plant],
  );

  return (
    <div className="app">
      {error && !plant ? (
        <section className="gate">
          <h1>Кабинет котельной</h1>
          <p>{error}</p>
          <button type="button" onClick={() => window.location.reload()}>
            Повторить
          </button>
        </section>
      ) : !plant ? (
        <section className="gate">
          <p>Загружаю котельную…</p>
        </section>
      ) : (
        <>
          {tab === "home" && <Overview plant={plant} username={api.username} onWrite={write} />}
          {tab === "charts" && (
            <Suspense fallback={<section className="gate"><p>Загружаю графики…</p></section>}>
              <Charts api={api} plant={plant} />
            </Suspense>
          )}
          {tab === "log" && <Journal plant={plant} />}
          <nav className="tabs">
            <button type="button" className={tab === "home" ? "active" : ""} onClick={() => setTab("home")}>
              Обзор
            </button>
            <button type="button" className={tab === "charts" ? "active" : ""} onClick={() => setTab("charts")}>
              Графики
            </button>
            <button type="button" className={tab === "log" ? "active" : ""} onClick={() => setTab("log")}>
              Журнал
            </button>
          </nav>
        </>
      )}
      {toast && <div className="toast">{toast}</div>}
    </div>
  );
}
