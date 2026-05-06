import React from "react";
import ReactDOM from "react-dom/client";
import type { BuildDetail, BuildSummary } from "./Api.ts";

/**
 * Minimal SPA for the builder service. Two views:
 *   - List of recent builds (polled every 3s).
 *   - Detail view for a single build (subscribed via SSE).
 *
 * API base URL precedence:
 *   1. `VITE_API_URL` baked in at build time (`.env` / shell).
 *   2. `localStorage["apiUrl"]` set via the in-app settings dialog.
 *   3. Prompt once and persist to localStorage.
 *
 * The API and SPA workers live at different origins by default, so
 * the API worker must allow CORS from the SPA's origin.
 */
const STORAGE_KEY = "apiUrl";

const resolveApiUrl = (): string => {
  const fromEnv = (import.meta as any).env?.VITE_API_URL;
  if (typeof fromEnv === "string" && fromEnv.length > 0) return fromEnv;
  const fromStorage = window.localStorage.getItem(STORAGE_KEY);
  if (fromStorage) return fromStorage;
  const entered = window.prompt(
    "Enter the builder API URL (the worker.url printed by `alchemy deploy`):",
    "https://",
  );
  const cleaned = (entered ?? "").trim().replace(/\/$/, "");
  if (cleaned) window.localStorage.setItem(STORAGE_KEY, cleaned);
  return cleaned;
};

const API_URL = resolveApiUrl();

const api = (path: string) => `${API_URL.replace(/\/$/, "")}${path}`;

type Route = { kind: "list" } | { kind: "detail"; id: string };

const parseHash = (): Route => {
  const m = window.location.hash.match(/^#\/builds\/(.+)$/);
  return m ? { kind: "detail", id: decodeURIComponent(m[1]) } : { kind: "list" };
};

function App() {
  const [route, setRoute] = React.useState<Route>(parseHash);

  React.useEffect(() => {
    const onHash = () => setRoute(parseHash());
    window.addEventListener("hashchange", onHash);
    return () => window.removeEventListener("hashchange", onHash);
  }, []);

  return (
    <div style={{ display: "flex", flexDirection: "column", height: "100%" }}>
      <Header />
      <div style={{ flex: 1, overflow: "auto", padding: 16 }}>
        {route.kind === "list" ? (
          <BuildsList />
        ) : (
          <BuildDetailView id={route.id} />
        )}
      </div>
    </div>
  );
}

function Header() {
  return (
    <header
      style={{
        padding: "12px 16px",
        borderBottom: "1px solid var(--border)",
        background: "var(--panel)",
        display: "flex",
        gap: 16,
        alignItems: "baseline",
      }}
    >
      <a
        href="#/"
        style={{
          color: "var(--text)",
          textDecoration: "none",
          fontWeight: 600,
        }}
      >
        alchemy builds
      </a>
      <span style={{ color: "var(--muted)", fontSize: 12 }}>{API_URL}</span>
      <button
        onClick={() => {
          window.localStorage.removeItem(STORAGE_KEY);
          window.location.reload();
        }}
        style={{
          marginLeft: "auto",
          background: "transparent",
          border: "1px solid var(--border)",
          color: "var(--muted)",
          padding: "2px 8px",
          borderRadius: 4,
          fontSize: 11,
          cursor: "pointer",
        }}
        title="Reset the stored API URL"
      >
        change url
      </button>
    </header>
  );
}

function BuildsList() {
  const [builds, setBuilds] = React.useState<BuildSummary[] | null>(null);
  const [error, setError] = React.useState<string | null>(null);

  React.useEffect(() => {
    let cancelled = false;
    const load = async () => {
      try {
        const res = await fetch(api("/api/builds"));
        if (!res.ok) throw new Error(`http ${res.status}`);
        const data = (await res.json()) as { builds: BuildSummary[] };
        if (!cancelled) {
          setBuilds(data.builds);
          setError(null);
        }
      } catch (e: any) {
        if (!cancelled) setError(String(e?.message ?? e));
      }
    };
    load();
    const t = setInterval(load, 3000);
    return () => {
      cancelled = true;
      clearInterval(t);
    };
  }, []);

  if (error) return <div style={{ color: "var(--err)" }}>error: {error}</div>;
  if (!builds) return <div style={{ color: "var(--muted)" }}>loading…</div>;
  if (builds.length === 0)
    return <div style={{ color: "var(--muted)" }}>no builds yet.</div>;

  return (
    <table style={{ width: "100%", borderCollapse: "collapse" }}>
      <thead>
        <tr style={{ textAlign: "left", color: "var(--muted)" }}>
          <th style={th}>status</th>
          <th style={th}>kind</th>
          <th style={th}>id</th>
          <th style={th}>ref</th>
          <th style={th}>started</th>
          <th style={th}>duration</th>
        </tr>
      </thead>
      <tbody>
        {builds.map((b) => (
          <tr key={b.id} style={{ borderTop: "1px solid var(--border)" }}>
            <td style={td}>
              <StatusBadge status={b.status} />
            </td>
            <td style={td}>{b.kind ?? "—"}</td>
            <td style={td}>
              <a
                href={`#/builds/${encodeURIComponent(b.id)}`}
                style={{ color: "var(--accent)" }}
              >
                {b.id}
              </a>
            </td>
            <td style={td}>{b.ref ?? "—"}</td>
            <td style={td}>{b.startedAt ? formatTime(b.startedAt) : "—"}</td>
            <td style={td}>{formatDuration(b.startedAt, b.completedAt)}</td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

function BuildDetailView({ id }: { id: string }) {
  const [detail, setDetail] = React.useState<BuildDetail | null>(null);
  const [error, setError] = React.useState<string | null>(null);

  // 1. Initial fetch so we have something to show before the SSE first event.
  React.useEffect(() => {
    let cancelled = false;
    fetch(api(`/api/builds/${encodeURIComponent(id)}`))
      .then(async (res) => {
        if (!res.ok) throw new Error(`http ${res.status}`);
        return (await res.json()) as BuildDetail;
      })
      .then((d) => {
        if (!cancelled) setDetail(d);
      })
      .catch((e) => {
        if (!cancelled) setError(String(e?.message ?? e));
      });
    return () => {
      cancelled = true;
    };
  }, [id]);

  // 2. Subscribe to live updates via SSE.
  React.useEffect(() => {
    const es = new EventSource(
      api(`/api/builds/${encodeURIComponent(id)}/events`),
    );
    es.onmessage = (ev) => {
      try {
        setDetail(JSON.parse(ev.data) as BuildDetail);
      } catch {
        /* ignore malformed payloads */
      }
    };
    es.onerror = () => {
      // Browser will auto-reconnect; just close on terminal so we stop.
      es.close();
    };
    return () => es.close();
  }, [id]);

  if (error) return <div style={{ color: "var(--err)" }}>error: {error}</div>;
  if (!detail) return <div style={{ color: "var(--muted)" }}>loading…</div>;

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
      <div style={{ display: "flex", gap: 12, alignItems: "center" }}>
        <StatusBadge status={detail.status} />
        <span style={{ fontWeight: 600 }}>{detail.id}</span>
        <span style={{ color: "var(--muted)" }}>
          {detail.kind ?? ""} · {detail.ref ?? ""}
        </span>
      </div>
      <dl
        style={{
          display: "grid",
          gridTemplateColumns: "max-content 1fr",
          columnGap: 16,
          rowGap: 4,
          margin: 0,
        }}
      >
        <Field label="repo" value={detail.repo} />
        <Field label="sha" value={detail.sha} />
        <Field
          label="started"
          value={detail.startedAt ? formatTime(detail.startedAt) : undefined}
        />
        <Field
          label="duration"
          value={formatDuration(detail.startedAt, detail.completedAt)}
        />
        <Field
          label="exit"
          value={detail.exitCode != null ? String(detail.exitCode) : undefined}
        />
        <Field label="pushed" value={detail.pushedSha ?? undefined} />
      </dl>
      <div>
        <div style={{ color: "var(--muted)", marginBottom: 4 }}>logs</div>
        <pre
          style={{
            background: "var(--panel)",
            border: "1px solid var(--border)",
            padding: 12,
            margin: 0,
            maxHeight: 480,
            overflow: "auto",
            whiteSpace: "pre-wrap",
            wordBreak: "break-word",
          }}
        >
          {detail.logTail ?? "(no logs yet)"}
        </pre>
      </div>
    </div>
  );
}

function Field({ label, value }: { label: string; value: string | undefined }) {
  return (
    <>
      <dt style={{ color: "var(--muted)" }}>{label}</dt>
      <dd style={{ margin: 0 }}>{value ?? "—"}</dd>
    </>
  );
}

function StatusBadge({ status }: { status: BuildDetail["status"] }) {
  const color =
    status === "success"
      ? "var(--ok)"
      : status === "failure"
        ? "var(--err)"
        : status === "running"
          ? "var(--running)"
          : "var(--muted)";
  return (
    <span
      style={{
        display: "inline-block",
        padding: "2px 8px",
        borderRadius: 4,
        fontSize: 11,
        textTransform: "uppercase",
        background: "var(--panel)",
        border: `1px solid ${color}`,
        color,
      }}
    >
      {status}
    </span>
  );
}

const th: React.CSSProperties = {
  fontWeight: 400,
  padding: "4px 8px",
  fontSize: 12,
};

const td: React.CSSProperties = {
  padding: "6px 8px",
  verticalAlign: "top",
};

const formatTime = (ts: number) => new Date(ts).toLocaleString();

const formatDuration = (start?: number, end?: number) => {
  if (!start) return "—";
  const ms = (end ?? Date.now()) - start;
  const s = Math.floor(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  return `${m}m ${s % 60}s`;
};

ReactDOM.createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
);
