import { startTransition, useDeferredValue, useEffect, useRef, useState } from "react";
import d2rLogo from "./assets/d2r-logo.webp";
import dashboardPreview from "./assets/dashboard-preview.png";
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

type BackendUser = {
  id: string;
  username: string;
  avatarUrl?: string | null;
};

type BackendAccount = {
  id: string;
  name: string;
  role: string;
};

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
const EQUIPPED_DROP_GUARD_HR = 0.05;
const BACKEND_URL_KEY = "d2-wealth-backend-url";
const ACCOUNT_ID_KEY = "d2-wealth-account-id";
const GATEWAY_RELEASE_URL = "https://github.com/bhavinamin/d2r-wealth/releases/latest/download/D2-Wealth-Gateway-Setup.msi";
const BACKEND_POLL_INTERVAL_MS = 3000;

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

const deriveGatewayUrl = () => {
  if (typeof window === "undefined") {
    return "http://127.0.0.1:3187";
  }

  const params = new URLSearchParams(window.location.search);
  const fromQuery = params.get("gateway");
  if (fromQuery) {
    return fromQuery;
  }

  return "http://127.0.0.1:3187";
};

const deriveBackendConfig = () => {
  if (typeof window === "undefined") {
    return { backendUrl: "", accountId: "" };
  }

  const params = new URLSearchParams(window.location.search);
  const defaultBackendUrl =
    window.location.hostname === "localhost" || window.location.hostname === "127.0.0.1"
      ? "http://127.0.0.1:3197"
      : window.location.origin;
  const backendUrl = params.get("backend") || window.localStorage.getItem(BACKEND_URL_KEY) || defaultBackendUrl;
  const accountId = params.get("account") || window.localStorage.getItem(ACCOUNT_ID_KEY) || "";
  return { backendUrl, accountId };
};

const derivePreviewDashboard = () => {
  if (typeof window === "undefined") {
    return false;
  }

  const params = new URLSearchParams(window.location.search);
  return params.get("preview") === "dashboard";
};

const derivePendingPairingId = () => {
  if (typeof window === "undefined") {
    return "";
  }

  const params = new URLSearchParams(window.location.search);
  return params.get("pair") || "";
};

const portraitForClass = (className: string) => classPortraits[className.toLowerCase()] ?? sorceressPortrait;
const warningKindLabel = (kind: "unresolved" | "ambiguous") => (kind === "ambiguous" ? "Low confidence" : "Unmatched");
const rulesetClass = (ruleset: "Classic" | "LoD" | "ROTW") => {
  if (ruleset === "ROTW") {
    return "ruleset-rotw";
  }
  if (ruleset === "LoD") {
    return "ruleset-lod";
  }
  return "ruleset-classic";
};

const inventoryHrFromReport = (report?: WealthReport | WealthSnapshot | null) => report?.inventoryHr ?? 0;
const characterStashHrFromReport = (report?: WealthReport | WealthSnapshot | null) => {
  if (!report) {
    return 0;
  }

  if (typeof report.characterStashHr === "number") {
    return report.characterStashHr;
  }

  return typeof report.inventoryHr === "number" ? 0 : report.stashHr ?? 0;
};

const characterStorageHrFromReport = (report?: WealthReport | WealthSnapshot | null) => {
  if (!report) {
    return 0;
  }

  if (typeof report.inventoryHr === "number" || typeof report.characterStashHr === "number") {
    return Number(((report.inventoryHr ?? 0) + (report.characterStashHr ?? 0)).toFixed(4));
  }

  return report.stashHr ?? 0;
};

const inventoryHrForCharacter = (character: WealthReport["characters"][number]) => character.inventoryHr ?? 0;
const characterStashHrForCharacter = (character: WealthReport["characters"][number]) => {
  if (typeof character.characterStashHr === "number") {
    return character.characterStashHr;
  }

  return typeof character.inventoryHr === "number" ? 0 : character.stashHr;
};

const totalHrForCharacter = (character: WealthReport["characters"][number]) =>
  character.totalHr ??
  Number((character.equippedHr + inventoryHrForCharacter(character) + characterStashHrForCharacter(character)).toFixed(3));

const createPreviewReport = (): WealthReport => {
  const importedAt = new Date().toISOString();
  return {
    importedAt,
    saveSetId: "preview-save-set",
    totalHr: 4.13,
    runeHr: 1.84,
    equippedHr: 2.38,
    inventoryHr: 0.25,
    characterStashHr: 0.36,
    stashHr: 0.61,
    sharedHr: 1.14,
    characters: [
      {
        name: "Atti",
        className: "Sorceress",
        level: 91,
        ruleset: "ROTW",
        equippedHr: 1.96,
        inventoryHr: 0.14,
        characterStashHr: 0.19,
        stashHr: 0.33,
        totalHr: 2.29,
      },
      {
        name: "Raze",
        className: "Paladin",
        level: 88,
        ruleset: "LoD",
        equippedHr: 0.42,
        inventoryHr: 0.11,
        characterStashHr: 0.17,
        stashHr: 0.28,
        totalHr: 0.7,
      },
    ],
    runeSummary: [
      { name: "Lo", count: 1, looseCount: 1, totalHr: 0.625, valueSource: { type: "rune-market", label: "Live Rune Market" } },
      { name: "Ist", count: 2, looseCount: 2, totalHr: 0.25, valueSource: { type: "rune-market", label: "Live Rune Market" } },
      { name: "Mal", count: 1, looseCount: 1, totalHr: 0.125, valueSource: { type: "rune-market", label: "Live Rune Market" } },
    ],
    topCharacterStash: [],
    topInventory: [],
    topSharedStash: [],
    allValuedItems: [
      {
        id: "preview-enigma",
        name: "Enigma",
        location: "equipped",
        owner: "Atti",
        source: "equipped",
        valueHr: 2.25,
        tradeValue: "Jah + Ber",
        matchedBy: "socketed",
        valueSource: { type: "derived", label: "Derived Socketed Value" },
      },
      {
        id: "preview-shako",
        name: "Harlequin Crest",
        location: "equipped",
        owner: "Atti",
        source: "equipped",
        valueHr: 0.375,
        tradeValue: "Vex",
        matchedBy: "exact",
        valueSource: {
          type: "workbook",
          label: "Workbook: UniqueSet Market",
          sheet: "UniqueSet Market",
          basis: "Vex",
        },
      },
    ],
    unmatchedItems: [],
    valuationWarnings: {
      totalCount: 0,
      unresolvedCount: 0,
      ambiguousCount: 0,
      items: [],
    },
    snapshot: {
      importedAt,
      totalHr: 4.13,
      runeHr: 1.84,
      equippedHr: 2.38,
      inventoryHr: 0.25,
      characterStashHr: 0.36,
      stashHr: 0.61,
      sharedHr: 1.14,
      characterCount: 2,
    },
  };
};

const createPreviewHistory = (): WealthSnapshot[] => {
  const now = Date.now();
  return [
    {
      importedAt: new Date(now - 1000 * 60 * 60 * 24 * 5).toISOString(),
      totalHr: 2.18,
      runeHr: 0.92,
      equippedHr: 0.84,
      inventoryHr: 0.08,
      characterStashHr: 0.14,
      stashHr: 0.22,
      sharedHr: 1.12,
      characterCount: 2,
    },
    {
      importedAt: new Date(now - 1000 * 60 * 60 * 24 * 3).toISOString(),
      totalHr: 2.94,
      runeHr: 1.13,
      equippedHr: 1.12,
      inventoryHr: 0.12,
      characterStashHr: 0.19,
      stashHr: 0.31,
      sharedHr: 1.51,
      characterCount: 2,
    },
    {
      importedAt: new Date(now - 1000 * 60 * 60 * 24 * 1).toISOString(),
      totalHr: 3.62,
      runeHr: 1.41,
      equippedHr: 1.52,
      inventoryHr: 0.14,
      characterStashHr: 0.19,
      stashHr: 0.33,
      sharedHr: 1.77,
      characterCount: 2,
    },
    {
      importedAt: new Date(now).toISOString(),
      totalHr: 4.13,
      runeHr: 1.84,
      equippedHr: 2.38,
      inventoryHr: 0.25,
      characterStashHr: 0.36,
      stashHr: 0.61,
      sharedHr: 1.14,
      characterCount: 2,
    },
  ];
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

function ValuationWarningsPanel(props: { report: WealthReport | null }) {
  const warnings = props.report?.valuationWarnings;
  const visibleWarnings = warnings?.items.slice(0, 8) ?? [];

  return (
    <section className="panel warning-panel">
      <div className="panel-header">
        <h3>Valuation Warnings</h3>
        <span>{warnings?.totalCount ?? 0} excluded items</span>
      </div>
      {!warnings?.totalCount ? (
        <p className="empty-state">All parsed items matched a trusted valuation path.</p>
      ) : (
        <>
          <p className="warning-summary">
            {warnings.totalCount} items are excluded from HR totals: {warnings.unresolvedCount} unmatched and {warnings.ambiguousCount} low-confidence.
          </p>
          <div className="table">
            {visibleWarnings.map((warning) => (
              <div key={`${warning.owner}-${warning.source}-${warning.name}`} className="table-row">
                <div>
                  <strong>{warning.name}</strong>
                  <span>
                    {warning.owner} • {warning.source ?? warning.location}
                  </span>
                </div>
                <div className="warning-meta">
                  <span className={`warning-pill ${warning.kind}`}>{warningKindLabel(warning.kind)}</span>
                  <span>{warning.valueSource.detail ?? warning.valueSource.label}</span>
                </div>
              </div>
            ))}
          </div>
          {warnings.totalCount > visibleWarnings.length ? (
            <p className="warning-summary">Showing {visibleWarnings.length} of {warnings.totalCount} excluded items.</p>
          ) : null}
        </>
      )}
    </section>
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

function GettingStarted(props: {
  appReady: boolean;
  authReady: boolean;
  pairingPending: boolean;
  pairingBusy: boolean;
  onOpenGatewayApp: () => void;
}) {
  return (
    <section className="landing-shell">
      <section className="landing-hero">
        <img className="landing-logo" src={d2rLogo} alt="Diablo II Resurrected" />
        <h3 className="landing-section-title">Offline Account Tracking For Diablo II: Resurrected</h3>
        <p className="landing-copy">
          Built for offline characters using the{" "}
          <a href="https://www.nexusmods.com/diablo2resurrected/mods/964?tab=posts" target="_blank" rel="noreferrer">
            Single Player Trading Market
          </a>
          . Item trade values follow the mod, while rune-based net worth is normalized against live market data.
        </p>
        <ul className="landing-features">
          <li>Account overview</li>
          <li>Character roster</li>
          <li>Highest-value stash and inventory tables</li>
          <li>Rune inventory and wealth tracking</li>
        </ul>
        <div className="landing-preview-frame">
          <img className="landing-preview-image" src={dashboardPreview} alt="Authenticated D2 Wealth dashboard preview" />
        </div>
      </section>

      <section className="landing-guide">
        <article className={`landing-step ${props.appReady ? "is-complete" : ""}`}>
          <span className="landing-step-number">{props.appReady ? "✓" : "1"}</span>
          <div>
            <h3>Install the Gateway, Set Your Save Path, and Sign In</h3>
            <p>The Windows gateway handles Discord sign-in, pairs this PC to your account, and syncs in the background.</p>
            <div className="landing-step-actions">
              <a className="token-button token-button-secondary" href={GATEWAY_RELEASE_URL} target="_blank" rel="noreferrer">
                Download Windows Gateway
              </a>
              <button type="button" className="discord-button" onClick={props.onOpenGatewayApp}>
                <svg className="discord-glyph" viewBox="0 0 127.14 96.36" aria-hidden="true">
                  <path
                    fill="currentColor"
                    d="M107.7 8.07A105.15 105.15 0 0 0 81.47 0a72.06 72.06 0 0 0-3.36 6.83 97.68 97.68 0 0 0-29.11 0A72.37 72.37 0 0 0 45.64 0 105.89 105.89 0 0 0 19.39 8.09C2.79 32.65-1.71 56.6.54 80.21h.02a105.73 105.73 0 0 0 32.17 16.15 77.7 77.7 0 0 0 6.89-11.11 68.42 68.42 0 0 1-10.84-5.18c.91-.66 1.8-1.35 2.66-2.08 20.87 9.53 43.46 9.53 64.08 0 .87.73 1.76 1.42 2.66 2.08a68.68 68.68 0 0 1-10.86 5.19 77 77 0 0 0 6.89 11.1 105.25 105.25 0 0 0 32.19-16.14h.02c2.64-27.38-4.5-51.11-18.72-72.15ZM42.45 65.69C36.18 65.69 31 59.96 31 52.91s5.06-12.78 11.45-12.78c6.45 0 11.57 5.78 11.46 12.78 0 7.05-5.06 12.78-11.46 12.78Zm42.24 0c-6.27 0-11.45-5.73-11.45-12.78S78.3 40.13 84.69 40.13c6.45 0 11.57 5.78 11.45 12.78 0 7.05-5.05 12.78-11.45 12.78Z"
                  />
                </svg>
                <span>Open Gateway App</span>
              </button>
            </div>
            <div className="landing-step-help">
              <strong>Status</strong>
              <ul className="landing-step-list">
                <li>{props.authReady ? "Discord session is active." : "Waiting for the gateway to start Discord sign-in."}</li>
                <li>
                  {props.appReady
                    ? "Gateway is paired and syncing."
                    : props.pairingPending
                      ? props.pairingBusy
                        ? "Authorizing gateway pairing..."
                        : "Waiting for pairing approval to finish."
                      : "Open the gateway app to begin pairing."}
                </li>
                <li>Inside the app, set the save folder to <code>Saved Games\Diablo II Resurrected</code>.</li>
              </ul>
            </div>
          </div>
        </article>
      </section>
    </section>
  );
}

export default function App() {
  const backendConfig = deriveBackendConfig();
  const previewDashboard = derivePreviewDashboard();
  const effectiveBackendUrl = backendConfig.backendUrl;
  const backendMode = true;
  const [report, setReport] = useState<WealthReport | null>(null);
  const [history, setHistory] = useState<WealthSnapshot[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [page, setPage] = useState<"overview" | "loot">("overview");
  const [backendStatus, setBackendStatus] = useState<string>(backendMode ? "Connecting..." : "Idle");
  const [authRequired, setAuthRequired] = useState(false);
  const [user, setUser] = useState<BackendUser | null>(null);
  const [accounts, setAccounts] = useState<BackendAccount[]>([]);
  const [selectedAccountId, setSelectedAccountId] = useState(backendConfig.accountId);
  const [gatewayReady, setGatewayReady] = useState(false);
  const [pairingId, setPairingId] = useState(derivePendingPairingId());
  const [pairingBusy, setPairingBusy] = useState(false);
  const autoConnectStartedRef = useRef(false);
  const backendPollTimerRef = useRef<number | null>(null);
  const reportRef = useRef<WealthReport | null>(null);
  const selectedAccountRef = useRef(selectedAccountId);
  const deferredHistory = useDeferredValue(history);

  useEffect(() => {
    setHistory(loadHistory());
  }, []);

  useEffect(() => {
    reportRef.current = report;
  }, [report]);

  useEffect(() => {
    selectedAccountRef.current = selectedAccountId;
    if (selectedAccountId) {
      window.localStorage.setItem(ACCOUNT_ID_KEY, selectedAccountId);
    }
  }, [selectedAccountId]);

  useEffect(() => {
    return () => {
      if (backendPollTimerRef.current) {
        window.clearTimeout(backendPollTimerRef.current);
      }
    };
  }, []);

  const applyReport = (nextReport: WealthReport) => {
    const nextHistory = pushHistory(nextReport.snapshot);
    startTransition(() => {
      setReport(nextReport);
      setHistory(nextHistory);
    });
  };

  const fetchBackendAccount = async (baseUrl: string, accountId: string) => {
    const normalizedBaseUrl = baseUrl.replace(/\/+$/, "");
    window.localStorage.setItem(BACKEND_URL_KEY, normalizedBaseUrl);
    window.localStorage.setItem(ACCOUNT_ID_KEY, accountId);

    const [latestResponse, historyResponse, clientsResponse] = await Promise.all([
      fetch(`${normalizedBaseUrl}/api/accounts/${encodeURIComponent(accountId)}/latest`, { credentials: "include" }),
      fetch(`${normalizedBaseUrl}/api/accounts/${encodeURIComponent(accountId)}/history`, { credentials: "include" }),
      fetch(`${normalizedBaseUrl}/api/accounts/${encodeURIComponent(accountId)}/clients`, { credentials: "include" }),
    ]);

    if (!latestResponse.ok) {
      if (latestResponse.status === 401 || latestResponse.status === 403) {
        throw new Error("AUTH_REQUIRED");
      }
      throw new Error(`Backend latest request failed with ${latestResponse.status}.`);
    }

    if (!historyResponse.ok) {
      if (historyResponse.status === 401 || historyResponse.status === 403) {
        throw new Error("AUTH_REQUIRED");
      }
      throw new Error(`Backend history request failed with ${historyResponse.status}.`);
    }

    if (!clientsResponse.ok) {
      if (clientsResponse.status === 401 || clientsResponse.status === 403) {
        throw new Error("AUTH_REQUIRED");
      }
      throw new Error(`Backend clients request failed with ${clientsResponse.status}.`);
    }

    const latestPayload = (await latestResponse.json()) as { report: WealthReport | null };
    const historyPayload = (await historyResponse.json()) as { history: WealthSnapshot[] };
    const clientsPayload = (await clientsResponse.json()) as { clients: Array<{ clientId: string; receivedAt: string }> };

    startTransition(() => {
      setReport(latestPayload.report);
      setHistory(historyPayload.history ?? []);
      setGatewayReady((clientsPayload.clients ?? []).length > 0);
    });
  };

  const fetchBackendMe = async (baseUrl: string) => {
    const normalizedBaseUrl = baseUrl.replace(/\/+$/, "");
    window.localStorage.setItem(BACKEND_URL_KEY, normalizedBaseUrl);

    const response = await fetch(`${normalizedBaseUrl}/api/me`, { credentials: "include" });
    if (!response.ok) {
      if (response.status === 401 || response.status === 403) {
        throw new Error("AUTH_REQUIRED");
      }
      throw new Error(`Backend me request failed with ${response.status}.`);
    }

    return (await response.json()) as { user: BackendUser; accounts: BackendAccount[] };
  };

  const resetSignedOutState = (accountId = selectedAccountRef.current) => {
    setUser(null);
    setAccounts([]);
    setSelectedAccountId("");
    setReport(null);
    setHistory([]);
    setAuthRequired(true);
    setGatewayReady(false);
  };

  const approveGatewayPairing = async (baseUrl: string, nextPairingId: string) => {
    const normalizedBaseUrl = baseUrl.replace(/\/+$/, "");
    const response = await fetch(`${normalizedBaseUrl}/api/gateway/pairing-sessions/${encodeURIComponent(nextPairingId)}/approve`, {
      method: "POST",
      credentials: "include",
    });
    if (!response.ok) {
      if (response.status === 401 || response.status === 403) {
        throw new Error("AUTH_REQUIRED");
      }
      throw new Error(`Gateway pairing approve failed with ${response.status}.`);
    }

    return response.json();
  };

  const isSuspiciousDrop = (previous: WealthReport | null, next: WealthReport) => {
    if (!previous) {
      return false;
    }

    if (previous.snapshot.characterCount !== next.snapshot.characterCount) {
      return false;
    }

    return next.totalHr < previous.totalHr * 0.7;
  };

  const malformedItemCount = (reportToCheck: WealthReport) =>
    reportToCheck.allValuedItems.filter((item) => item.name.includes("undefined") || item.name === "Unknown Item").length;

  const isDegradedAutoReport = (previous: WealthReport | null, next: WealthReport) => {
    if (!previous) {
      return false;
    }

    const previousMalformed = malformedItemCount(previous);
    const nextMalformed = malformedItemCount(next);
    const previousEquippedItems = previous.allValuedItems.filter((item) => item.location === "equipped");
    const nextEquippedItems = next.allValuedItems.filter((item) => item.location === "equipped");
    const equippedDrop = next.equippedHr < previous.equippedHr - EQUIPPED_DROP_GUARD_HR;
    const sharedStable = Math.abs(next.sharedHr - previous.sharedHr) < 0.05;
    const runeStable = Math.abs(next.runeHr - previous.runeHr) < 0.05;
    const characterStashCollapsed =
      next.topCharacterStash.length < previous.topCharacterStash.length &&
      characterStashHrFromReport(next) < characterStashHrFromReport(previous);
    const equippedRosterShrank = nextEquippedItems.length < previousEquippedItems.length;

    return (
      (nextMalformed > previousMalformed + 5 || equippedRosterShrank) &&
      equippedDrop &&
      sharedStable &&
      runeStable &&
      characterStashCollapsed
    );
  };

  const recentHistoryBaseline = () => {
    const recent = history.slice(-20);
    if (!recent.length) {
      return null;
    }

    return recent.reduce((best, snapshot) => ({
      ...best,
      totalHr: Math.max(best.totalHr, snapshot.totalHr),
      equippedHr: Math.max(best.equippedHr, snapshot.equippedHr),
      inventoryHr: Math.max(inventoryHrFromReport(best), inventoryHrFromReport(snapshot)),
      characterStashHr: Math.max(characterStashHrFromReport(best), characterStashHrFromReport(snapshot)),
      runeHr: Math.max(best.runeHr, snapshot.runeHr),
      sharedHr: Math.max(best.sharedHr, snapshot.sharedHr),
      stashHr: Math.max(characterStorageHrFromReport(best), characterStorageHrFromReport(snapshot)),
      characterCount: Math.max(best.characterCount, snapshot.characterCount),
    }));
  };

  const stabilizeAgainstHistory = (next: WealthReport) => {
    const baseline = recentHistoryBaseline();
    if (!baseline) {
      return next;
    }

    const runeStable = Math.abs(next.runeHr - baseline.runeHr) < 0.05;
    const sharedStable = Math.abs(next.sharedHr - baseline.sharedHr) < 0.05;
    const equippedDrop = baseline.equippedHr - next.equippedHr;

    if (!(runeStable && sharedStable && equippedDrop > EQUIPPED_DROP_GUARD_HR)) {
      return next;
    }

    const adjustedEquippedHr = baseline.equippedHr;
    const adjustedTotalHr = Number((next.totalHr - next.equippedHr + adjustedEquippedHr).toFixed(4));
    const adjustedCharacters =
      next.characters.length === 1
        ? next.characters.map((character) => ({
            ...character,
            equippedHr: Number(adjustedEquippedHr.toFixed(3)),
          }))
        : next.characters;

    return {
      ...next,
      totalHr: adjustedTotalHr,
      equippedHr: adjustedEquippedHr,
      characters: adjustedCharacters,
      snapshot: {
        ...next.snapshot,
        totalHr: adjustedTotalHr,
        equippedHr: adjustedEquippedHr,
      },
    };
  };

  const openGatewayApp = () => {
    const backend = encodeURIComponent(effectiveBackendUrl.replace(/\/+$/, ""));
    window.location.href = `d2wealth://pair?backend=${backend}`;
  };

  const completeGatewayPairing = async () => {
    if (!user || !pairingId) {
      return;
    }

    setPairingBusy(true);
    try {
      await approveGatewayPairing(effectiveBackendUrl, pairingId);
      const url = new URL(window.location.href);
      url.searchParams.delete("pair");
      window.history.replaceState({}, "", url.toString());
      setPairingId("");
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Failed to approve gateway pairing.");
    } finally {
      setPairingBusy(false);
    }
  };

  const logout = async () => {
    await fetch(`${effectiveBackendUrl.replace(/\/+$/, "")}/api/logout`, {
      method: "POST",
      credentials: "include",
    });
    resetSignedOutState(selectedAccountId);
  };

  useEffect(() => {
    if (!previewDashboard) {
      return;
    }

    setGatewayReady(true);
    setUser({ id: "preview-user", username: "Preview Account" });
    setAccounts([{ id: "preview-account", name: "Preview Account", role: "owner" }]);
    setSelectedAccountId("preview-account");
    setReport(createPreviewReport());
    setHistory(createPreviewHistory());
  }, [previewDashboard]);

  useEffect(() => {
    if (autoConnectStartedRef.current) {
      return;
    }

    autoConnectStartedRef.current = true;
    if (previewDashboard) {
      return;
    }

    if (backendMode) {
      const pollBackend = async () => {
        try {
          const mePayload = await fetchBackendMe(effectiveBackendUrl);
          setUser(mePayload.user);
          setAccounts(mePayload.accounts);
          setAuthRequired(false);

          const nextAccountId = mePayload.accounts[0]?.id || "";
          if (selectedAccountRef.current !== nextAccountId) {
            setSelectedAccountId(nextAccountId);
          }

          if (!nextAccountId) {
            setBackendStatus("Disconnected");
            setReport(null);
            setHistory([]);
            return;
          }

          setBackendStatus("Syncing...");
          await fetchBackendAccount(effectiveBackendUrl, nextAccountId);
          setBackendStatus("Connected");
        } catch (caught) {
          if (caught instanceof Error && caught.message === "AUTH_REQUIRED") {
            setBackendStatus("Disconnected");
            resetSignedOutState();
            setError(null);
          } else {
            setBackendStatus("Error");
            setError(caught instanceof Error ? caught.message : "Backend account load failed.");
          }
        } finally {
          backendPollTimerRef.current = window.setTimeout(() => {
            void pollBackend();
          }, BACKEND_POLL_INTERVAL_MS);
        }
      };

      void pollBackend();
      return;
    }

  }, [backendMode, previewDashboard, effectiveBackendUrl]);

  useEffect(() => {
    if (!backendMode || !user || !selectedAccountId) {
      return;
    }

    let cancelled = false;
    setBackendStatus("Syncing...");
    void fetchBackendAccount(effectiveBackendUrl, selectedAccountId)
      .then(() => {
        if (!cancelled) {
          setBackendStatus("Connected");
        }
      })
      .catch((caught) => {
        if (!cancelled) {
          if (caught instanceof Error && caught.message === "AUTH_REQUIRED") {
            setBackendStatus("Disconnected");
            resetSignedOutState(selectedAccountId);
            setError(null);
            return;
          }

          setBackendStatus("Error");
          setError(caught instanceof Error ? caught.message : "Backend account load failed.");
        }
      });

    return () => {
      cancelled = true;
    };
  }, [backendMode, user, selectedAccountId, previewDashboard, effectiveBackendUrl]);

  useEffect(() => {
    if (!user || !pairingId || pairingBusy) {
      return;
    }

    void completeGatewayPairing();
  }, [user, pairingId]);

  const authReady = !!user && !authRequired;
  const appReady = authReady && gatewayReady;
  const showDashboard = previewDashboard ? !!report : backendMode && !!user && !!selectedAccountId && !authRequired && gatewayReady;

  return (
    <main className={`app-shell ${showDashboard ? "" : "app-shell-landing"}`}>
      {showDashboard ? (
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
              <section className="gateway-card control-panel">
                <div className="panel-header compact-header">
                  <h3>Account</h3>
                  <span className="gateway-status status-connected">{user?.username}</span>
                </div>
                <div className="account-controls">
                  <span>{accounts[0]?.name ?? "Discord Account"}</span>
                  <button type="button" onClick={logout}>
                    Log Out
                  </button>
                </div>
              </section>

              <section className="gateway-card control-panel">
                <div className="panel-header compact-header">
                  <h3>Synced Backend</h3>
                  <span className={`gateway-status ${backendStatus === "Connected" ? "status-connected" : backendStatus === "Syncing..." ? "status-syncing" : backendStatus === "Error" ? "status-error" : "status-idle"}`}>
                    {backendStatus}
                  </span>
                </div>
                <small>
                  Account data is served through the authenticated backend. The local gateway only syncs in the tray and is never directly connected from the browser.
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
      ) : null}

      {error ? <div className="banner error">{error}</div> : null}
      {!showDashboard ? (
        <GettingStarted
          appReady={appReady}
          authReady={authReady}
          pairingPending={Boolean(pairingId)}
          pairingBusy={pairingBusy}
          onOpenGatewayApp={openGatewayApp}
        />
      ) : null}

      {showDashboard && page === "overview" ? (
        <section className="deck-frame overview-frame">
          <section className="stats-strip">
            <StatCard label="Account Net Worth" value={formatHr(report?.totalHr ?? 0)} tone="accent" />
            <StatCard label="Equipped Gear" value={formatHr(report?.equippedHr ?? 0)} />
            <StatCard label="Inventory" value={formatHr(inventoryHrFromReport(report))} />
            <StatCard label="Personal Stash" value={formatHr(characterStashHrFromReport(report))} />
            <StatCard label="Shared Stashes" value={formatHr(report?.sharedHr ?? 0)} />
          </section>
          <p className="stats-note">
            Total HR = equipped gear + inventory + personal stash + shared stash. Unmatched and low-confidence items stay excluded below.
          </p>

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
                          <b>{formatHr(totalHrForCharacter(character))}</b>
                          <span className="roster-total-label">total</span>
                          <div className="roster-breakdown">
                            <span>Eq {formatHr(character.equippedHr)}</span>
                            <span>Inv {formatHr(inventoryHrForCharacter(character))}</span>
                            <span>Stash {formatHr(characterStashHrForCharacter(character))}</span>
                          </div>
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

          <ValuationWarningsPanel report={report} />

          <section className="panel footnote-panel">
            <div className="panel-header">
              <h3>Notes</h3>
            </div>
            <p className="footnote">
              Rune calibration loaded in this build: Gul {formatHr(market.runeValues.Gul ?? 0)} • Ist {formatHr(market.runeValues.Ist ?? 0)} • Ber{" "}
              {formatHr(market.runeValues.Ber ?? 0)}. Market generated {marketGeneratedAt}.
            </p>
            <p className="footnote">
              Gear and stash pricing comes from `data/market.xlsx`, translated through the active rune table above. Inventory and personal stash
              come from the character save. Shared or external stash pages come from imported stash files.
            </p>
          </section>
        </section>
      ) : showDashboard ? (
        <section className="deck-frame loot-frame">
          <section className="loot-stage">
            <div className="panel-header loot-header">
              <h3>Loot Ledger</h3>
              <span>Highest value items and all rune trade power</span>
            </div>

            <section className="loot-grid">
              <TopItemsTable title="Highest Value Character Stash Items" items={report?.topCharacterStash ?? []} />
              <TopItemsTable title="Highest Value Inventory Items" items={report?.topInventory ?? []} />
              <TopItemsTable title="Highest Value Shared Stash Items" items={report?.topSharedStash ?? []} showSource={false} showQuantity />
              <section className="panel rune-panel">
                <div className="panel-header">
                  <h3>Rune Inventory</h3>
                  <span>{formatHr(report?.runeHr ?? 0)} in loose rune value</span>
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
      ) : null}
    </main>
  );
}
