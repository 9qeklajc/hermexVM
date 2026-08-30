import type { ReactNode } from "react";
import { useNav } from "../lib/store";

/** hermexVM app mark. */
export function HermesMark({ size = 40 }: { size?: number }) {
  return (
    <img
      className="hermes-mark"
      src="./app-icon.png"
      width={size}
      height={size}
      alt=""
      aria-hidden="true"
    />
  );
}

const AVATAR_HUES = [36, 262, 199, 145, 330, 20, 90, 220];

function hashCode(value: string): number {
  let hash = 0;
  for (let i = 0; i < value.length; i++)
    hash = (hash * 31 + value.charCodeAt(i)) | 0;
  return Math.abs(hash);
}

/** Deterministic gradient avatar with the agent's initial — Telegram style. */
export function Avatar({ name, size = 46 }: { name: string; size?: number }) {
  const hue = AVATAR_HUES[hashCode(name) % AVATAR_HUES.length] ?? 36;
  const initial = (name.trim()[0] ?? "?").toUpperCase();
  return (
    <div
      className="avatar"
      style={{
        width: size,
        height: size,
        fontSize: size * 0.42,
        background: `linear-gradient(135deg, hsl(${hue} 72% 58%), hsl(${hue} 65% 40%))`,
      }}
    >
      {initial}
    </div>
  );
}

/** Pulsing green dot: "this agent/conversation is working right now". */
export function WorkingDot() {
  return <span className="working-dot" aria-label="working" />;
}

export function Spinner() {
  return (
    <div className="spinner-wrap">
      <div className="spinner" />
    </div>
  );
}

export function TopBar({
  title,
  subtitle,
  back,
  leading,
  trailing,
}: {
  title: string;
  subtitle?: ReactNode;
  back?: boolean;
  leading?: ReactNode;
  trailing?: ReactNode;
}) {
  const nav = useNav();
  return (
    <header className="topbar">
      {back ? (
        <button
          type="button"
          className="icon-button"
          onClick={nav.pop}
          aria-label="Back"
        >
          <svg
            width="22"
            height="22"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="2.2"
            strokeLinecap="round"
            strokeLinejoin="round"
          >
            <path d="m15 18-6-6 6-6" />
          </svg>
        </button>
      ) : null}
      {leading}
      <div className="topbar-titles">
        <h1>{title}</h1>
        {subtitle ? <div className="topbar-subtitle">{subtitle}</div> : null}
      </div>
      <div className="topbar-trailing">{trailing}</div>
    </header>
  );
}

export function EmptyState({ title, hint }: { title: string; hint?: string }) {
  return (
    <div className="empty-state">
      <HermesMark size={44} />
      <p className="empty-title">{title}</p>
      {hint ? <p className="empty-hint">{hint}</p> : null}
    </div>
  );
}
