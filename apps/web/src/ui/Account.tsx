/** Server accounts: sign-in / first-run setup, your account, and user management for administrators. */
import { useEffect, useState } from "react";
import { type ServerConfig, type ServerUser, ApiError, apiJson } from "../state/platform";
import { toast, useApp } from "../state/store";
import { Modal } from "./Dialogs";
import { Icon } from "./icons";

/** Update who is signed in, and re-read the server's settings (sign-up closes after the first account). */
async function setUser(user: ServerUser | null) {
  const p = useApp.getState().platform;
  if (p.kind !== "server") return;
  let config = p.config;
  try {
    config = await apiJson<ServerConfig>("/config");
  } catch {
    config = { ...config, needsSetup: false, signup: false };
  }
  useApp.setState({ platform: { ...p, user, config } });
}

const msg = (e: unknown) => (e instanceof Error ? e.message : String(e));

/** Full-screen sign-in (or "create the first account") for servers that require it. */
export function SignIn() {
  const platform = useApp((s) => s.platform);
  const cfg = platform.kind === "server" ? platform.config : null;
  const [register, setRegister] = useState(!!cfg?.needsSetup);
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [displayName, setDisplayName] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  if (!cfg) return null;

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const user = await apiJson<ServerUser>(register ? "/auth/register" : "/auth/login", {
        method: "POST",
        json: register ? { username, password, displayName } : { username, password },
      });
      await setUser(user);
      useApp.setState({ panel: "welcome" });
      toast("ok", `Welcome, ${user.displayName}`);
    } catch (err) {
      setError(msg(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="signin" role="dialog" aria-label="Sign in to Whittle">
      <div className="signin__card">
        <div className="signin__brand">
          <svg width="34" height="34" viewBox="0 0 64 64" aria-hidden="true">
            <path d="M14 46 L30 14 L50 40 Z" fill="none" stroke="currentColor" strokeWidth="4.5" strokeLinejoin="round" />
            <path d="M10 52 H54" stroke="var(--accent)" strokeWidth="5" strokeLinecap="round" />
          </svg>
          <div>
            <h1>whittle</h1>
            <p className="muted">{cfg.needsSetup ? "Create the administrator account to finish setting up this server." : "Sign in to open your designs."}</p>
          </div>
        </div>
        {cfg.local && (
          <form className="signin__form" onSubmit={submit} onKeyDown={(e) => e.stopPropagation()}>
            <label className="field">
              <span className="field__label">Username</span>
              <input className="textfield" autoFocus autoComplete="username" value={username} onChange={(e) => setUsername(e.target.value)} required />
            </label>
            {register && (
              <label className="field">
                <span className="field__label">Your name</span>
                <input className="textfield" autoComplete="name" value={displayName} onChange={(e) => setDisplayName(e.target.value)} placeholder="Optional" />
              </label>
            )}
            <label className="field">
              <span className="field__label">Password</span>
              <input
                className="textfield"
                type="password"
                autoComplete={register ? "new-password" : "current-password"}
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                minLength={register ? 8 : undefined}
                required
              />
            </label>
            {error && (
              <p className="note note--error" role="alert">
                <Icon name="error" size={16} /> {error}
              </p>
            )}
            <button className="btn btn--accent btn--wide" type="submit" disabled={busy}>
              {busy ? "One moment…" : register ? "Create account" : "Sign in"}
            </button>
            {cfg.signup && !cfg.needsSetup && (
              <button type="button" className="link" onClick={() => (setRegister(!register), setError(null))}>
                {register ? "I already have an account" : "Create an account"}
              </button>
            )}
          </form>
        )}
        {cfg.oidc && (
          <>
            {cfg.local && <div className="signin__or">or</div>}
            <a className="btn btn--wide" href={`./api/auth/oidc/start?return=${encodeURIComponent(window.location.pathname)}`}>
              <Icon name="key" size={16} /> Sign in with {cfg.oidc}
            </a>
          </>
        )}
        <p className="muted small signin__foot">Whittle {cfg.version}</p>
      </div>
    </div>
  );
}

/** Your account: name, password, sign out. */
export function AccountDialog() {
  const platform = useApp((s) => s.platform);
  const [current, setCurrent] = useState("");
  const [next, setNext] = useState("");
  const [busy, setBusy] = useState(false);
  if (platform.kind !== "server" || !platform.user) return null;
  const u = platform.user;
  const noLogin = platform.config.auth === "none";

  const change = async (e: React.FormEvent) => {
    e.preventDefault();
    setBusy(true);
    try {
      await apiJson("/auth/password", { method: "POST", json: { current, newPassword: next } });
      setCurrent("");
      setNext("");
      toast("ok", "Password changed. Other devices were signed out.");
    } catch (err) {
      toast("error", msg(err));
    } finally {
      setBusy(false);
    }
  };

  const signOut = async () => {
    try {
      await apiJson("/auth/logout", { method: "POST" });
    } catch {
      /* signed out anyway */
    }
    useApp.setState({ panel: null });
    await setUser(null);
  };

  return (
    <Modal title="Account">
      <div className="modal__body">
        <dl className="stats">
          <dt>Name</dt>
          <dd>{u.displayName}</dd>
          <dt>Username</dt>
          <dd className="mono">{u.username}</dd>
          {u.email && (
            <>
              <dt>Email</dt>
              <dd>{u.email}</dd>
            </>
          )}
          <dt>Role</dt>
          <dd>{u.isAdmin ? "Administrator" : "Member"}</dd>
        </dl>
        {noLogin && <p className="muted small">This server runs without sign-in: everyone who can reach it shares one workspace.</p>}
        {!noLogin && u.hasPassword && (
          <form className="stack" onSubmit={change} onKeyDown={(e) => e.stopPropagation()}>
            <h3 className="eyebrow">Change password</h3>
            <input className="textfield" type="password" placeholder="Current password" autoComplete="current-password" value={current} onChange={(e) => setCurrent(e.target.value)} required />
            <input className="textfield" type="password" placeholder="New password (8+ characters)" autoComplete="new-password" minLength={8} value={next} onChange={(e) => setNext(e.target.value)} required />
            <button className="btn btn--small" type="submit" disabled={busy}>
              Change password
            </button>
          </form>
        )}
        {u.sso && <p className="muted small">You sign in with single sign-on; your password is managed there.</p>}
        <div className="btnrow">
          {u.isAdmin && !noLogin && (
            <button className="btn" onClick={() => useApp.setState({ panel: "users" })}>
              <Icon name="users" size={16} /> Manage users
            </button>
          )}
          {!noLogin && (
            <button className="btn btn--ghost" onClick={() => void signOut()}>
              <Icon name="logout" size={16} /> Sign out
            </button>
          )}
        </div>
      </div>
    </Modal>
  );
}

/** Administrators: add, disable, promote, reset and remove accounts. */
export function UsersDialog() {
  const platform = useApp((s) => s.platform);
  const me = platform.kind === "server" ? platform.user : null;
  const [users, setUsers] = useState<ServerUser[] | null>(null);
  const [draft, setDraft] = useState({ username: "", password: "", displayName: "", isAdmin: false });

  const load = () =>
    apiJson<ServerUser[]>("/admin/users")
      .then(setUsers)
      .catch((e) => toast("error", msg(e)));
  useEffect(() => void load(), []);

  const patch = async (u: ServerUser, body: Record<string, unknown>, done: string) => {
    try {
      await apiJson(`/admin/users/${encodeURIComponent(u.id)}`, { method: "PATCH", json: body });
      toast("ok", done);
      void load();
    } catch (e) {
      toast("error", msg(e));
    }
  };

  const add = async (e: React.FormEvent) => {
    e.preventDefault();
    try {
      await apiJson("/admin/users", { method: "POST", json: draft });
      setDraft({ username: "", password: "", displayName: "", isAdmin: false });
      toast("ok", `Added ${draft.username}`);
      void load();
    } catch (err) {
      toast("error", msg(err));
    }
  };

  const remove = async (u: ServerUser) => {
    if (!window.confirm(`Delete ${u.username} and all of their designs? This can't be undone.`)) return;
    try {
      await apiJson(`/admin/users/${encodeURIComponent(u.id)}`, { method: "DELETE" });
      toast("ok", `Deleted ${u.username}`);
      void load();
    } catch (e) {
      toast("error", e instanceof ApiError ? e.message : msg(e));
    }
  };

  const reset = (u: ServerUser) => {
    const p = window.prompt(`New password for ${u.username} (8+ characters). They'll be signed out everywhere.`);
    if (p) void patch(u, { password: p }, `Password reset for ${u.username}`);
  };

  return (
    <Modal title="Users" wide>
      <div className="modal__body">
        <div className="userlist" role="table">
          {(users ?? []).map((u) => (
            <div key={u.id} className={`userrow ${u.disabled ? "is-disabled" : ""}`} role="row">
              <span className="userrow__who">
                <b>{u.displayName}</b>
                <small className="mono muted">
                  {u.username}
                  {u.sso ? " · SSO" : ""}
                  {u.disabled ? " · disabled" : ""}
                </small>
              </span>
              <label className="checkrow">
                <input type="checkbox" checked={u.isAdmin} disabled={u.id === me?.id} onChange={(e) => void patch(u, { isAdmin: e.target.checked }, "Role updated")} />
                Admin
              </label>
              <button className="btn btn--small btn--ghost" disabled={u.id === me?.id} onClick={() => void patch(u, { disabled: !u.disabled }, u.disabled ? "Account enabled" : "Account disabled")}>
                {u.disabled ? "Enable" : "Disable"}
              </button>
              {u.hasPassword && (
                <button className="btn btn--small btn--ghost" onClick={() => reset(u)}>
                  Reset password
                </button>
              )}
              <button className="iconbtn" aria-label={`Delete ${u.username}`} disabled={u.id === me?.id} onClick={() => void remove(u)}>
                <Icon name="trash" size={16} />
              </button>
            </div>
          ))}
          {users === null && <p className="muted">Loading…</p>}
        </div>
        {platform.kind === "server" && platform.config.local && (
          <form className="userform" onSubmit={add} onKeyDown={(e) => e.stopPropagation()}>
            <h3 className="eyebrow">Add a user</h3>
            <input className="textfield" placeholder="Username" value={draft.username} onChange={(e) => setDraft({ ...draft, username: e.target.value })} required />
            <input className="textfield" placeholder="Name (optional)" value={draft.displayName} onChange={(e) => setDraft({ ...draft, displayName: e.target.value })} />
            <input className="textfield" type="password" placeholder="Password (8+ characters)" minLength={8} value={draft.password} onChange={(e) => setDraft({ ...draft, password: e.target.value })} required autoComplete="new-password" />
            <label className="checkrow">
              <input type="checkbox" checked={draft.isAdmin} onChange={(e) => setDraft({ ...draft, isAdmin: e.target.checked })} /> Administrator
            </label>
            <button className="btn btn--accent btn--small" type="submit">
              Add user
            </button>
          </form>
        )}
      </div>
    </Modal>
  );
}

/** Title-bar button: who's signed in (server only). */
export function AccountButton() {
  const platform = useApp((s) => s.platform);
  if (platform.kind !== "server" || !platform.user) return null;
  const u = platform.user;
  const initials = u.displayName
    .split(/\s+/)
    .map((w) => w[0])
    .join("")
    .slice(0, 2)
    .toUpperCase();
  return (
    <button className="avatar" onClick={() => useApp.setState({ panel: "account" })} title={`${u.displayName} · account`} aria-label="Account">
      {initials || "?"}
    </button>
  );
}
