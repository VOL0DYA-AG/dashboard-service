import { useEffect, useRef, useState } from "react";
import * as echarts from "echarts/core";
import { LineChart } from "echarts/charts";
import { GridComponent, TooltipComponent, LegendComponent, DataZoomComponent } from "echarts/components";
import { CanvasRenderer } from "echarts/renderers";
import type { CabinetApi } from "./api";
import { historySeries, type Plant } from "@contract";

echarts.use([LineChart, GridComponent, TooltipComponent, LegendComponent, DataZoomComponent, CanvasRenderer]);

const RANGES = [
  { id: "6h", label: "6 часов", ms: 6 * 3_600_000 },
  { id: "24h", label: "Сутки", ms: 24 * 3_600_000 },
  { id: "7d", label: "7 дней", ms: 7 * 24 * 3_600_000 },
] as const;

export function Charts({ api, plant }: { api: CabinetApi; plant: Plant }) {
  const host = useRef<HTMLDivElement>(null);
  const chart = useRef<echarts.ECharts | null>(null);
  const [range, setRange] = useState<(typeof RANGES)[number]["id"]>("6h");
  const [note, setNote] = useState("");
  const [tick, setTick] = useState(0);
  const plantRef = useRef(plant);
  plantRef.current = plant;

  useEffect(() => {
    if (!host.current) return;
    chart.current = echarts.init(host.current);
    const onResize = () => chart.current?.resize();
    window.addEventListener("resize", onResize);
    return () => {
      window.removeEventListener("resize", onResize);
      chart.current?.dispose();
    };
  }, []);

  useEffect(() => {
    const id = window.setInterval(() => setTick((value) => value + 1), 15000);
    return () => window.clearInterval(id);
  }, []);

  useEffect(() => {
    const plantNow = plantRef.current;
    const selected = RANGES.find((item) => item.id === range) ?? RANGES[0];
    const to = Date.now();
    const from = to - selected.ms;
    let alive = true;
    api.history(plantNow, from, to).then(
      (series) => {
        if (!alive || !chart.current) return;
        const defined = historySeries(plantNow);
        const hasPoints = defined.some((item) => (series[item.id] || []).length > 1);
        setNote(hasPoints ? "" : "История копится с момента запуска. Через несколько минут линии станут плотнее.");
        chart.current.setOption(
          {
            animation: false,
            grid: { left: 42, right: 12, top: 28, bottom: 64 },
            tooltip: { trigger: "axis" },
            legend: { bottom: 28, type: "scroll", textStyle: { fontSize: 12 } },
            dataZoom: [{ type: "inside" }, { type: "slider", height: 18, bottom: 4 }],
            xAxis: { type: "time", axisLabel: { hideOverlap: true, fontSize: 11 } },
            yAxis: { type: "value", scale: true, axisLabel: { fontSize: 11, formatter: "{value}°" } },
            series: defined.map((item) => ({
              name: item.label,
              type: "line",
              showSymbol: false,
              smooth: true,
              color: item.color,
              data: (series[item.id] || []).map((point) => [point.t, point.v]),
            })),
          },
          true,
        );
      },
      () => {
        if (alive) setNote("График не загрузился. Проверьте, что у температур включён storeDataPoints.");
      },
    );
    return () => {
      alive = false;
    };
  }, [api, range, tick]);

  return (
    <main className="screen">
      <header className="top">
        <div>
          <p className="eyebrow">История</p>
          <h1>Графики</h1>
        </div>
      </header>
      <div className="ranges">
        {RANGES.map((item) => (
          <button type="button" key={item.id} className={item.id === range ? "active" : ""} onClick={() => setRange(item.id)}>
            {item.label}
          </button>
        ))}
      </div>
      <div className="chart" ref={host} />
      {note && <p className="note">{note}</p>}
    </main>
  );
}
