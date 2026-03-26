import { startTransition, useDeferredValue, useEffect, useRef, useState } from "react";
import d2rLogo from "./assets/d2r-logo.webp";
import amazonPortrait from "./assets/classes/amazon.webp";
import assassinPortrait from "./assets/classes/assassin.webp";
import barbarianPortrait from "./assets/classes/barbarian.webp";
import druidPortrait from "./assets/classes/druid.webp";
import necromancerPortrait from "./assets/classes/necromancer.webp";
import paladinPortrait from "./assets/classes/paladin.webp";
import sorceressPortrait from "./assets/classes/sorceress.webp";
import { loadHistory, pushHistory } from "./lib/history.js";
import { market } from "./lib/market.js";
import type { ValuedItem, WealthReport, WealthSnapshot } from "./lib/types.js";

const formatHr = (value: number) => `${value.toFixed(value >= 1 ? 2 : 3)} HR`;
const formatTime = (value: string) =>
  new Intl.DateTimeFormat(undefined, {
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  }).format(new Date(value));
const marketGeneratedAt = new Intl.DateTimeFormat(undefined, {
  month: "short",
  day: "numeric",
  hour: "numeric",
  minute: "2-digit",
}).format(new Date(market.generatedAt));

const runeTradeScale = Object.entries(market.runeValues)
  .map(([name, valueHr]) => ({ name, valueHr }))
  .sort((left, right) => left.valueHr - right.valueHr);
const descendingRuneTradeScale = [...runeTradeScale].sort((left, right) => right.valueHr - left.valueHr);
const lemThreshold = market.runeValues.Lem ?? 0.03;
const istThreshold = market.runeValues.Ist ?? 0.125;
const smallestRuneValue = runeTradeScale.find((rune) => rune.valueHr > 0)?.valueHr ?? 0.003125;
const hrTickSize = smallestRuneValue;

const classPortraits: Record<string, string> = {
  amazon: amazonPortrait,
  assassin: assassinPortrait,
  barbarian: barbarianPortrait,
  druid: druidPortrait,
  necromancer: necromancerPortrait,
  paladin: paladinPortrait,
  sorceress: sorceressPortrait,
};

const toTradeValue = (valueHr: number) => {
  if (valueHr <= 0) {
    return null;
  }

  let nearest = runeTradeScale[0];
  let bestDistance = Math.abs(valueHr - nearest.valueHr);

  for (const rune of runeTradeScale) {
    const distance = Math.abs(valueHr - rune.valueHr);
    if (distance < bestDistance) {
      nearest = rune;
      bestDistance = distance;
    }
  }

  return nearest.name;
};

const tradeTierClass = (valueHr: number) => {
  if (valueHr >= istThreshold) {
    return "trade-high";
  }
  if (valueHr >= lemThreshold) {
    return "trade-mid";
  }
  return "trade-low";
};

const toRuneTicks = (valueHr: number) => Math.round(valueHr / hrTickSize);

const toTradeBreakdown = (valueHr: number) => {
  if (valueHr <= 0) {
    return [];
  }

  let remainingTicks = toRuneTicks(valueHr);
  const tags: Array<{ name: string; count: number; valueHr: number }> = [];

  for (const rune of descendingRuneTradeScale) {
    const runeTicks = toRuneTicks(rune.valueHr);
    if (runeTicks <= 0 || remainingTicks < runeTicks) {
      continue;
    }

    const count = Math.floor(remainingTicks / runeTicks);
    if (count <= 0) {
      continue;
    }

    tags.push({ name: rune.name, count, valueHr: rune.valueHr });
    remainingTicks -= count * runeTicks;
  }

  return tags;
};

const gatewayStatusClass = (status: string) => {
  if (status === "Connected") {
    return "status-connected";
  }
  if (status === "Syncing...") {
    return "status-syncing";
  }
  if (status === "Error") {
    return "status-error";
  }
  return "status-idle";
};

const portraitForClass = (className: string) => classPortraits[className.toLowerCase()] ?? sorceressPortrait;
const gatewayActionLabel = (status: string) => (status === "Connected" ? "Refresh" : "Connect");
const gatewayActionIcon = (status: string) => (status === "Connected" ? "↻" : null);
const shouldShowManualImport = (status: string) => status !== "Connected";
const rulesetClass = (ruleset: "Classic" | "LoD" | "ROTW") => {
  if (ruleset === "ROTW") {
    return "ruleset-rotw";
  }
  if (ruleset === "LoD") {
    return "ruleset-lod";
  }
  return "ruleset-classic";
};

function StatCard(props: { label: string; value: string; tone?: "default" | "accent" }) {
  return (
    <article className={`stat-card ${props.tone === "accent" ? "accent" : ""}`}>
      <span>{props.label}</span>
      <strong>{props.value}</strong>
    </article>
  );
}

function TopItemsTable(props: { title: string; items: ValuedItem[]; showSource?: boolean; showQuantity?: boolean }) {
  return (
    <section className="panel">
      <div className="panel-header">
        <h3>{props.title}</h3>
      </div>
      <div className="table">
        {props.items.length === 0 ? (
          <p className="empty-state">No valued items found in this bucket yet.</p>
        ) : (
          props.items.map((item) => (
            <div key={item.id} className="table-row">
              <div>
                <strong>
                  {item.name}
                  {props.showQuantity ? ` x${item.quantity ?? 1}` : ""}
                </strong>
                {props.showSource !== false ? (
                  <span>
                    {item.owner} • {item.source}
                  </span>
                ) : null}
              </div>
              <div className="value-stack">
                <span className={`trade-tag ${tradeTierClass(item.valueHr)}`}>{item.tradeValue ?? toTradeValue(item.valueHr)}</span>
                <b>{formatHr(item.valueHr)}</b>
              </div>
            </div>
          ))
        )}
      </div>
    </section>
  );
}

function TradeBreakdown(props: { valueHr: number }) {
  const tags = toTradeBreakdown(props.valueHr);
  if (!tags.length) {
    return null;
  }

  return (
    <div className="trade-tag-row">
      {tags.map((tag) => (
        <span key={`${tag.name}-${tag.count}`} className={`trade-tag ${tradeTierClass(tag.valueHr)}`}>
          {tag.name} x{tag.count}
        </span>
      ))}
    </div>
  );
}

function HistoryChart(props: { data: WealthSnapshot[] }) {
  if (props.data.length === 0) {
    return <p className="empty-state">No snapshots yet. Import a save set to start the timeline.</p>;
  }

  const width = 800;
  const height = 320;
  const padding = 28;
  const chartWidth = width - padding * 2;
  const chartHeight = height - padding * 2;
  const maxValue = Math.max(...props.data.map((entry) => entry.totalHr), 1);

  const points = props.data.map((entry, index) => {
    const x = padding + (index / Math.max(props.data.length - 1, 1)) * chartWidth;
    const y = padding + (1 - entry.totalHr / maxValue) * chartHeight;
    return { x, y, label: entry.importedAt, value: entry.totalHr };
  });

  const linePath = points.map((point, index) => `${index === 0 ? "M" : "L"} ${point.x} ${point.y}`).join(" ");
  const areaPath = `${linePath} L ${points[points.length - 1].x} ${height - padding} L ${points[0].x} ${height - padding} Z`;

  return (
    <svg viewBox={`0 0 ${width} ${height}`} className="history-chart" role="img" aria-label="Wealth history chart">
      <defs>
        <linearGradient id="wealthArea" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" stopColor="#f7a93b" stopOpacity="0.55" />
          <stop offset="100%" stopColor="#f7a93b" stopOpacity="0.02" />
        </linearGradient>
      </defs>
      {[0.25, 0.5, 0.75].map((ratio) => {
        const y = padding + ratio * chartHeight;
        return <line key={ratio} x1={padding} y1={y} x2={width - padding} y2={y} className="chart-grid" />;
      })}
      <path d={areaPath} fill="url(#wealthArea)" />
      <path d={linePath} className="chart-line" />
      {points.map((point) => (
        <g key={point.label}>
          <circle cx={point.x} cy={point.y} r="4.5" className="chart-dot" />
          <title>{`${formatTime(point.label)} • ${formatHr(point.value)}`}</title>
        </g>
      ))}
      <text x={padding} y={height - 8} className="chart-axis-label">
        {formatTime(props.data[0].importedAt)}
      </text>
      <text x={width - padding} y={height - 8} textAnchor="end" className="chart-axis-label">
        {formatTime(props.data[props.data.length - 1].importedAt)}
      </text>
      <text x={padding} y={16} className="chart-axis-label">
        Peak {formatHr(maxValue)}
      </text>
    </svg>
  );
}

export default function App() {
  const [report, setReport] = useState<WealthReport | null>(null);
  const [history, setHistory] = useState<WealthSnapshot[]>([]);
  const [isBusy, setIsBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [page, setPage] = useState<"overview" | "loot">("overview");
  const [gatewayUrl, setGatewayUrl] = useState("http://127.0.0.1:3187");
  const [gatewayStatus, setGatewayStatus] = useState<string>("Disconnected");
  const gatewayEventsRef = useRef<EventSource | null>(null);
  const deferredHistory = useDeferredValue(history);

  useEffect(() => {
    setHistory(loadHistory());
  }, []);

  useEffect(() => {
    return () => {
      gatewayEventsRef.current?.close();
    };
  }, []);

  const applyReport = (nextReport: WealthReport) => {
    const nextHistory = pushHistory(nextReport.snapshot);
    startTransition(() => {
      setReport(nextReport);
      setHistory(nextHistory);
    });
  };

  const importFiles = async (files: FileList | File[]) => {
    const { parseAccountFiles } = await import("./lib/d2.js");
    const nextReport = await parseAccountFiles(files);
    applyReport(nextReport);
  };

  const fetchGatewaySnapshot = async (baseUrl: string) => {
    const manifestResponse = await fetch(`${baseUrl}/manifest`);
    if (!manifestResponse.ok) {
      throw new Error(`Gateway manifest request failed with ${manifestResponse.status}.`);
    }

    await manifestResponse.json();
    const reportResponse = await fetch(`${baseUrl}/report`);
    if (!reportResponse.ok) {
      throw new Error(`Gateway report request failed with ${reportResponse.status}.`);
    }

    const nextReport = (await reportResponse.json()) as WealthReport;
    applyReport(nextReport);
  };

  const onImport = async (event: React.ChangeEvent<HTMLInputElement>) => {
    const files = event.target.files;
    if (!files?.length) {
      return;
    }

    setIsBusy(true);
    setError(null);

    try {
      await importFiles(files);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Import failed.");
    } finally {
      setIsBusy(false);
      event.target.value = "";
    }
  };

  const connectGateway = async () => {
    setIsBusy(true);
    setError(null);
    setGatewayStatus("Connecting...");

    try {
      const baseUrl = gatewayUrl.replace(/\/+$/, "");
      await fetchGatewaySnapshot(baseUrl);
      setGatewayStatus("Connected");

      gatewayEventsRef.current?.close();
      const eventSource = new EventSource(`${baseUrl}/events`);
      gatewayEventsRef.current = eventSource;
      eventSource.addEventListener("ready", (event) => {
        void JSON.parse((event as MessageEvent).data);
      });
      eventSource.addEventListener("files-changed", async (event) => {
        setGatewayStatus("Syncing...");
        try {
          void JSON.parse((event as MessageEvent).data);
          await fetchGatewaySnapshot(baseUrl);
          setGatewayStatus("Connected");
        } catch (caught) {
          setGatewayStatus("Error");
          setError(caught instanceof Error ? caught.message : "Gateway refresh failed.");
        }
      });
      eventSource.onerror = () => {
        setGatewayStatus("Disconnected");
        eventSource.close();
        gatewayEventsRef.current = null;
      };
    } catch (caught) {
      setGatewayStatus("Error");
      setError(caught instanceof Error ? caught.message : "Gateway connection failed.");
    } finally {
      setIsBusy(false);
    }
  };

  return (
    <main className="app-shell">
      <section className="deck-frame command-frame">
        <section className="topbar">
          <div className="brand-block panel">
            <img className="masthead-logo" src={d2rLogo} alt="Diablo II Resurrected" />
            <div className="brand-copy">
              <p className="eyebrow">Offline wealth tracker for live local saves</p>
              <p className="masthead-text">
                Track your account value, watch progression over time, and keep the loot worth trading front and center.
              </p>
            </div>
          </div>

          <div className="control-stack">
            {shouldShowManualImport(gatewayStatus) ? (
              <label className="dropzone compact control-panel">
                <input type="file" multiple accept=".d2s,.d2i,.sss,.cst" onChange={onImport} />
                <span>{isBusy ? "Parsing saves..." : "Choose save + stash files"}</span>
                <small>Manual import for offline characters and stash files.</small>
              </label>
            ) : null}

            <section className="gateway-card control-panel">
              <div className="panel-header compact-header">
                <h3>Local Gateway</h3>
                <span className={`gateway-status ${gatewayStatusClass(gatewayStatus)}`}>{gatewayStatus}</span>
              </div>
              <div className="gateway-controls">
                <input value={gatewayUrl} onChange={(event) => setGatewayUrl(event.target.value)} placeholder="http://127.0.0.1:3187" />
                <button
                  type="button"
                  onClick={connectGateway}
                  disabled={isBusy}
                  className={gatewayStatus === "Connected" ? "gateway-icon-button" : ""}
                  aria-label={gatewayActionLabel(gatewayStatus)}
                  title={gatewayActionLabel(gatewayStatus)}
                >
                  {gatewayActionIcon(gatewayStatus) ?? gatewayActionLabel(gatewayStatus)}
                </button>
              </div>
              <small>
                Run <code>npm run gateway</code> on the machine that owns the D2R save folder.
              </small>
            </section>
          </div>
        </section>

        <div className="view-switcher">
          <button type="button" className={page === "overview" ? "is-active" : ""} onClick={() => setPage("overview")}>
            Overview
          </button>
          <button type="button" className={page === "loot" ? "is-active" : ""} onClick={() => setPage("loot")}>
            Loot Ledger
          </button>
        </div>
      </section>

      {error ? <div className="banner error">{error}</div> : null}

      {page === "overview" ? (
        <section className="deck-frame overview-frame">
          <section className="stats-strip">
            <StatCard label="Account Net Worth" value={formatHr(report?.totalHr ?? 0)} tone="accent" />
            <StatCard label="Loose Rune Value" value={formatHr(report?.runeHr ?? 0)} />
            <StatCard label="Equipped Gear" value={formatHr(report?.equippedHr ?? 0)} />
            <StatCard label="Character Storage" value={formatHr(report?.stashHr ?? 0)} />
            <StatCard label="Shared Stashes" value={formatHr(report?.sharedHr ?? 0)} />
          </section>

          <section className="dashboard-grid">
            <div className="main-column">
              <section className={`panel chart-panel ${deferredHistory.length ? "" : "chart-panel-empty"}`}>
                <div className="panel-header">
                  <h3>Wealth Over Time</h3>
                  <span>{deferredHistory.length} snapshots</span>
                </div>
                <div className="chart-wrap">
                  <HistoryChart data={deferredHistory} />
                </div>
              </section>
            </div>

            <aside className="sidebar-column">
              <section className="panel roster-panel">
                <div className="panel-header">
                  <h3>Characters</h3>
                </div>
                {report?.characters.length ? (
                  <div className="roster">
                    {report.characters.map((character) => (
                      <article key={character.name} className="roster-card portrait-card">
                        <img className="roster-portrait" src={portraitForClass(character.className)} alt={character.className} />
                        <div className="roster-copy">
                          <strong>{character.name}</strong>
                          <span>
                            {character.className} • level {character.level}
                          </span>
                          <span className={`ruleset-tag ${rulesetClass(character.ruleset)}`}>{character.ruleset}</span>
                        </div>
                        <div className="roster-values">
                          <b>{formatHr(character.equippedHr)}</b>
                        </div>
                      </article>
                    ))}
                  </div>
                ) : (
                  <p className="empty-state">Import some saves to populate the roster.</p>
                )}
              </section>
            </aside>
          </section>

          <section className="panel footnote-panel">
            <div className="panel-header">
              <h3>Notes</h3>
            </div>
            <p className="footnote">
              Rune calibration loaded in this build: Gul {formatHr(market.runeValues.Gul ?? 0)} • Ist {formatHr(market.runeValues.Ist ?? 0)} • Ber{" "}
              {formatHr(market.runeValues.Ber ?? 0)}. Market generated {marketGeneratedAt}.
            </p>
            <p className="footnote">
              Gear and stash pricing comes from `data/market.xlsx`, translated through the active rune table above. Personal stash is
              read from the character save. Shared or external stash pages come from imported stash files.
            </p>
          </section>
        </section>
      ) : (
        <section className="deck-frame loot-frame">
          <section className="loot-stage">
            <div className="panel-header loot-header">
              <h3>Loot Ledger</h3>
              <span>Highest value items and all rune trade power</span>
            </div>

            <section className="loot-grid">
              <TopItemsTable title="Highest Value Character Stash Items" items={report?.topCharacterStash ?? []} />
              <TopItemsTable title="Highest Value Shared Stash Items" items={report?.topSharedStash ?? []} showSource={false} showQuantity />
              <section className="panel rune-panel">
                <div className="panel-header">
                  <h3>Rune Inventory</h3>
                  <span>{report?.runeSummary.length ?? 0} rune types</span>
                </div>
                <div className="rune-grid rune-grid-compact">
                  {(report?.runeSummary ?? []).map((rune) => (
                    <article key={rune.name} className="rune-card">
                      <strong>{rune.name}</strong>
                      <span>{rune.count} owned</span>
                      <TradeBreakdown valueHr={rune.totalHr} />
                      <b>{formatHr(rune.totalHr)}</b>
                    </article>
                  ))}
                  {!report?.runeSummary.length ? <p className="empty-state">No runes parsed yet.</p> : null}
                </div>
              </section>
            </section>
          </section>
        </section>
      )}
    </main>
  );
}
