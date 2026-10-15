/**
 * Server accounts: sign-in, first-run setup, password reset, your account,
 * and the administration console (people, settings, email, activity).
 */
import { useEffect, useMemo, useState } from "react";
import { type ServerConfig, type ServerUser, apiJson } from "../state/platform";
import { confirmDialog, promptDialog } from "../state/dialogs";
import { toast, useApp } from "../state/store";
import { NumberField, Popover, Select, Switch, Tabs, TextField } from "./controls";
import { Modal, ago } from "./Dialogs";
import { Icon, type IconName } from "./icons";

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
const bytes = (n: number) => (n >= 1 << 30 ? `${(n / (1 << 30)).toFixed(1)} GB` : n >= 1 << 20 ? `${(n / (1 << 20)).toFixed(1)} MB` : `${Math.max(0, Math.round(n / 1024))} KB`);
const initials = (name: string) =>
  name
    .split(/\s+/)
    .map((w) => w[0])
    .join("")
    .slice(0, 2)
    .toUpperCase() || "?";

function Brand({ line }: { line: string }) {
  return (
    <div className="signin__brand">
      <svg width="34" height="34" viewBox="0 0 64 64" aria-hidden="true">
        <path d="M14 46 L30 14 L50 40 Z" fill="none" stroke="currentColor" strokeWidth="4.5" strokeLinejoin="round" />
        <path d="M10 52 H54" stroke="var(--accent)" strokeWidth="5" strokeLinecap="round" />
      </svg>
      <div>
        <h1>whittle</h1>
        <p className="muted">{line}</p>
      </div>
    </div>
  );
}

/* ───────────────────────────── Sign in ───────────────────────────── */

type SignInView = "signin" | "register" | "forgot" | "sent" | "reset";

/** Full-screen sign-in (or "create the first account") for servers that require it. */
export function SignIn() {
  const platform = useApp((s) => s.platform);
  const cfg = platform.kind === "server" ? platform.config : null;
  const resetToken = useMemo(() => new URLSearchParams(window.location.search).get("reset"), []);
  const [view, setView] = useState<SignInView>(resetToken ? "reset" : cfg?.needsSetup ? "register" : "signin");
  const [username, setUsername] = useState("");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [displayName, setDisplayName] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  if (!cfg) return null;

  const done = async (user: ServerUser) => {
    if (resetToken) window.history.replaceState(null, "", window.location.pathname);
    await setUser(user);
    useApp.setState({ panel: "welcome" });
    toast("ok", `Welcome, ${user.displayName}`);
  };

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      if (view === "register") await done(await apiJson<ServerUser>("/auth/register", { method: "POST", json: { username, password, displayName, email } }));
      else if (view === "signin") await done(await apiJson<ServerUser>("/auth/login", { method: "POST", json: { username, password } }));
      else if (view === "forgot") {
        await apiJson("/auth/forgot", { method: "POST", json: { login: username } });
        setView("sent");
      } else if (view === "reset") await done(await apiJson<ServerUser>("/auth/reset", { method: "POST", json: { token: resetToken, newPassword: password } }));
    } catch (err) {
      setError(msg(err));
    } finally {
      setBusy(false);
    }
  };

  const title =
    view === "register" && cfg.needsSetup
      ? "Create the administrator account to finish setting up this server."
      : view === "register"
        ? "Create your account."
        : view === "forgot"
          ? "We'll email you a link to choose a new password."
          : view === "sent"
            ? "Check your email."
            : view === "reset"
              ? "Choose a new password."
              : "Sign in to open your designs.";

  return (
    <div className="signin" role="dialog" aria-label="Sign in to Whittle">
      <div className="signin__card">
        <Brand line={title} />
        {view === "sent" ? (
          <div className="stack">
            <p>If an account matches, a link to reset the password is on its way. It works for an hour.</p>
            <button className="btn btn--wide" onClick={() => setView("signin")}>
              Back to sign in
            </button>
          </div>
        ) : (
          (cfg.local || view === "reset") && (
            <form className="signin__form" onSubmit={submit} onKeyDown={(e) => e.stopPropagation()}>
              {view !== "reset" && (
                <TextField
                  label={view === "forgot" ? "Username or email" : view === "signin" ? "Username or email" : "Username"}
                  icon="users"
                  autoFocus
                  autoComplete="username"
                  value={username}
                  onChange={setUsername}
                  required
                />
              )}
              {view === "register" && (
                <>
                  <TextField label="Email" icon="mail" type="email" autoComplete="email" value={email} onChange={setEmail} required={cfg.requireEmail} hint="For password resets and notices" />
                  <TextField label="Your name" autoComplete="name" value={displayName} onChange={setDisplayName} placeholder="Optional" />
                </>
              )}
              {view !== "forgot" && (
                <TextField
                  label={view === "reset" ? "New password" : "Password"}
                  icon="key"
                  type="password"
                  autoFocus={view === "reset"}
                  autoComplete={view === "signin" ? "current-password" : "new-password"}
                  value={password}
                  onChange={setPassword}
                  minLength={view === "signin" ? undefined : 8}
                  hint={view === "signin" ? undefined : "8 characters or more"}
                  required
                />
              )}
              {error && (
                <p className="note note--error" role="alert">
                  <Icon name="error" size={16} /> {error}
                </p>
              )}
              <button className="btn btn--accent btn--wide" type="submit" disabled={busy}>
                {busy ? "One moment…" : { register: "Create account", signin: "Sign in", forgot: "Email me a link", reset: "Set password and sign in", sent: "" }[view]}
              </button>
              <div className="signin__links">
                {view === "signin" && cfg.passwordReset && (
                  <button type="button" className="link" onClick={() => (setView("forgot"), setError(null))}>
                    Forgot your password?
                  </button>
                )}
                {view === "forgot" && (
                  <button type="button" className="link" onClick={() => (setView("signin"), setError(null))}>
                    Back to sign in
                  </button>
                )}
                {cfg.signup && !cfg.needsSetup && (view === "signin" || view === "register") && (
                  <button type="button" className="link" onClick={() => (setView(view === "register" ? "signin" : "register"), setError(null))}>
                    {view === "register" ? "I already have an account" : "Create an account"}
                  </button>
                )}
              </div>
            </form>
          )
        )}
        {cfg.oidc && view === "signin" && (
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

/* ───────────────────────────── Your account ───────────────────────────── */

export function AccountDialog() {
  const platform = useApp((s) => s.platform);
  const u = platform.kind === "server" ? platform.user : null;
  const [name, setName] = useState(u?.displayName ?? "");
  const [email, setEmail] = useState(u?.email ?? "");
  const [current, setCurrent] = useState("");
  const [next, setNext] = useState("");
  const [busy, setBusy] = useState(false);
  if (platform.kind !== "server" || !u) return null;
  const cfg = platform.config;
  const noLogin = cfg.auth === "none";

  const saveProfile = async (e: React.FormEvent) => {
    e.preventDefault();
    setBusy(true);
    try {
      const user = await apiJson<ServerUser>("/auth/me", { method: "PATCH", json: { displayName: name, email } });
      await setUser(user);
      toast("ok", "Profile saved");
    } catch (err) {
      toast("error", msg(err));
    } finally {
      setBusy(false);
    }
  };

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
      <div className="modal__body account">
        <div className="account__who">
          <span className="avatar avatar--big">{initials(u.displayName)}</span>
          <div>
            <b>{u.displayName}</b>
            <small className="muted mono">{u.username}</small>
            <span className="badges">
              {u.isAdmin && <span className="badge badge--accent">Administrator</span>}
              {u.sso && <span className="badge">Single sign-on</span>}
            </span>
          </div>
        </div>
        {noLogin ? (
          <p className="muted small">This server runs without sign-in: everyone who can reach it shares one workspace.</p>
        ) : (
          <>
            <form className="stack" onSubmit={saveProfile} onKeyDown={(e) => e.stopPropagation()}>
              <h3 className="eyebrow">Profile</h3>
              <TextField label="Name" value={name} onChange={setName} autoComplete="name" required />
              <TextField label="Email" type="email" icon="mail" value={email} onChange={setEmail} autoComplete="email" required={cfg.requireEmail} />
              <button className="btn btn--small" type="submit" disabled={busy || (name === u.displayName && email === (u.email ?? ""))}>
                Save profile
              </button>
            </form>
            {cfg.oidc && (
              <div className="stack">
                <h3 className="eyebrow">Single sign-on</h3>
                {u.sso ? (
                  <p className="muted small">Linked: you can sign in with {cfg.oidc}.</p>
                ) : (
                  <>
                    <p className="muted small">Link your {cfg.oidc} account to sign in with it from now on. Your designs stay where they are.</p>
                    <a className="btn btn--small" href={`./api/auth/oidc/start?link=1&return=${encodeURIComponent(window.location.pathname)}`}>
                      <Icon name="link" size={15} /> Link {cfg.oidc}
                    </a>
                  </>
                )}
              </div>
            )}
            {(u.hasPassword || cfg.local) && (
              <form className="stack" onSubmit={change} onKeyDown={(e) => e.stopPropagation()}>
                <h3 className="eyebrow">{u.hasPassword ? "Change password" : "Set a password"}</h3>
                {u.hasPassword && <TextField label="Current password" type="password" autoComplete="current-password" value={current} onChange={setCurrent} required />}
                <TextField label="New password" type="password" autoComplete="new-password" minLength={8} value={next} onChange={setNext} hint="8 characters or more" required />
                <button className="btn btn--small" type="submit" disabled={busy}>
                  {u.hasPassword ? "Change password" : "Set password"}
                </button>
              </form>
            )}
          </>
        )}
        <div className="btnrow">
          {u.isAdmin && !noLogin && (
            <button className="btn" onClick={() => useApp.setState({ panel: "users" })}>
              <Icon name="shield" size={16} /> Administration
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

/* ───────────────────────────── Administration ───────────────────────────── */

interface AdminUser extends ServerUser {
  designs: number;
  storage: number;
  sessions: number;
}

type AdminTab = "overview" | "people" | "settings" | "activity";

export function UsersDialog() {
  const [tab, setTab] = useState<AdminTab>("people");
  return (
    <Modal title="Administration" wide>
      <div className="settings admin">
        <Tabs<AdminTab>
          vertical
          value={tab}
          onChange={setTab}
          tabs={[
            { value: "overview", label: "Overview", icon: "server" },
            { value: "people", label: "People", icon: "users" },
            { value: "settings", label: "Sign-in & email", icon: "settings" },
            { value: "activity", label: "Activity", icon: "activity" },
          ]}
        />
        <div className="settings__pane" role="tabpanel">
          {tab === "overview" && <Overview />}
          {tab === "people" && <People />}
          {tab === "settings" && <ServerSettingsPane />}
          {tab === "activity" && <Activity />}
        </div>
      </div>
    </Modal>
  );
}

interface OverviewData {
  version: string;
  uptimeSecs: number;
  database: string;
  users: number;
  admins: number;
  disabled: number;
  ssoUsers: number;
  activeSessions: number;
  designs: number;
  versions: number;
  storage: number;
  auth: string[];
  email: boolean;
  dataDir: string;
}

function Overview() {
  const [o, setO] = useState<OverviewData | null>(null);
  useEffect(() => void apiJson<OverviewData>("/admin/overview").then(setO).catch((e) => toast("error", msg(e))), []);
  if (!o) return <p className="muted">Loading…</p>;
  const up = o.uptimeSecs > 86400 ? `${Math.floor(o.uptimeSecs / 86400)} days` : o.uptimeSecs > 3600 ? `${Math.floor(o.uptimeSecs / 3600)} hours` : `${Math.max(1, Math.floor(o.uptimeSecs / 60))} min`;
  const tiles: [string, string, IconName][] = [
    ["People", `${o.users}`, "users"],
    ["Signed in now", `${o.activeSessions}`, "key"],
    ["Designs", `${o.designs}`, "cube"],
    ["Storage", bytes(o.storage), "server"],
  ];
  return (
    <div className="settings__section">
      <div className="tiles">
        {tiles.map(([k, v, icon]) => (
          <div key={k} className="tile">
            <Icon name={icon} size={16} />
            <b className="mono">{v}</b>
            <small>{k}</small>
          </div>
        ))}
      </div>
      <dl className="stats">
        <dt>Version</dt>
        <dd>Whittle {o.version}</dd>
        <dt>Running for</dt>
        <dd>{up}</dd>
        <dt>Database</dt>
        <dd>{o.database}</dd>
        <dt>Sign-in</dt>
        <dd>{o.auth.map((a) => ({ none: "None (open)", local: "Passwords", oidc: "Single sign-on" })[a] ?? a).join(" + ")}</dd>
        <dt>Email</dt>
        <dd>{o.email ? "Set up" : "Not set up"}</dd>
        <dt>Accounts</dt>
        <dd>
          {o.admins} administrator{o.admins === 1 ? "" : "s"} · {o.ssoUsers} with single sign-on · {o.disabled} disabled
        </dd>
        <dt>Versions kept</dt>
        <dd>{o.versions}</dd>
        <dt>Data folder</dt>
        <dd className="mono small">{o.dataDir}</dd>
      </dl>
      <p className="muted small">
        Back up with <code>whittle-server backup FILE.zip</code>. Move to PostgreSQL with <code>whittle-server migrate-db postgres://…</code>. Check the installation with{" "}
        <code>whittle-server doctor</code>.
      </p>
    </div>
  );
}

/* ── People ─────────────────────────────────────────────── */

type Sheet = { kind: "merge" | "delete" | "edit"; user: AdminUser } | { kind: "add" } | null;

function UserMenu({ u, all, me, cfg, reload, onSheet }: { u: AdminUser; all: AdminUser[]; me?: ServerUser | null; cfg: ServerConfig; reload: () => void; onSheet: (s: Sheet) => void }) {
  const [open, setOpen] = useState(false);
  const [anchor, setAnchor] = useState<HTMLButtonElement | null>(null);
  const self = u.id === me?.id;
  const run = async (fn: () => Promise<unknown>, done: string) => {
    setOpen(false);
    try {
      await fn();
      toast("ok", done);
      reload();
    } catch (e) {
      toast("error", msg(e));
    }
  };
  const path = `/admin/users/${encodeURIComponent(u.id)}`;
  const others = all.filter((x) => x.id !== u.id);
  const items: { label: string; icon: IconName; hide?: boolean; danger?: boolean; run: () => void }[] = [
    {
      label: "Set a password…",
      icon: "key",
      run: () =>
        void promptDialog({ title: `New password for ${u.username}`, message: "They'll be signed out everywhere.", label: "Password", type: "password", confirmLabel: "Set password", validate: (v) => (v.length >= 8 ? null : "Use at least 8 characters") }).then(
          (p) => void (p && run(() => apiJson(path, { method: "PATCH", json: { password: p } }), `Password set for ${u.username}`)),
        ),
    },
    { label: "Email a reset link", icon: "mail", hide: !cfg.passwordReset || !u.email, run: () => void run(() => apiJson(`${path}/send-reset`, { method: "POST" }), `Reset link sent to ${u.email}`) },
    {
      label: u.ssoLink ? "Cancel single sign-on link" : "Link single sign-on by email",
      icon: "link",
      hide: !cfg.oidc || u.sso,
      run: () => void run(() => apiJson(path, { method: "PATCH", json: { ssoLink: !u.ssoLink } }), u.ssoLink ? "Link cancelled" : `${u.username} will be linked the next time they sign in with ${cfg.oidc}`),
    },
    {
      label: "Unlink single sign-on",
      icon: "unlink",
      hide: !u.sso,
      run: () =>
        void confirmDialog({ title: `Unlink single sign-on from ${u.username}?`, message: u.hasPassword ? "They can still sign in with their password." : "They have no password, so they won't be able to sign in until you set one or link again.", confirmLabel: "Unlink", danger: !u.hasPassword }).then(
          (ok) => void (ok && run(() => apiJson(`${path}/unlink-sso`, { method: "POST" }), "Single sign-on unlinked")),
        ),
    },
    { label: "Merge into another account…", icon: "merge", hide: others.length === 0, run: () => (setOpen(false), onSheet({ kind: "merge", user: u })) },
    { label: "Sign out everywhere", icon: "logout", hide: self || u.sessions === 0, run: () => void run(() => apiJson(`${path}/signout`, { method: "POST" }), `${u.username} was signed out`) },
    { label: u.disabled ? "Enable account" : "Disable account", icon: u.disabled ? "check" : "suppress", hide: self, run: () => void run(() => apiJson(path, { method: "PATCH", json: { disabled: !u.disabled } }), u.disabled ? "Account enabled" : "Account disabled") },
    { label: "Delete…", icon: "trash", danger: true, hide: self, run: () => (setOpen(false), onSheet({ kind: "delete", user: u })) },
  ];
  return (
    <>
      <button ref={setAnchor} className="iconbtn iconbtn--small" aria-label={`Actions for ${u.username}`} aria-haspopup="menu" onClick={() => setOpen(!open)}>
        <Icon name="more" size={16} />
      </button>
      <Popover anchor={anchor} open={open} onClose={() => setOpen(false)} placement="bottom-end" className="menu menu--pop">
        <div role="menu">
          {items
            .filter((i) => !i.hide)
            .map((i) => (
              <button key={i.label} role="menuitem" className={i.danger ? "danger" : ""} onClick={i.run}>
                <Icon name={i.icon} size={15} /> {i.label}
              </button>
            ))}
        </div>
      </Popover>
    </>
  );
}

function People() {
  const platform = useApp((s) => s.platform);
  const me = platform.kind === "server" ? platform.user : null;
  const cfg = platform.kind === "server" ? platform.config : null;
  const [users, setUsers] = useState<AdminUser[] | null>(null);
  const [q, setQ] = useState("");
  const [filter, setFilter] = useState<"all" | "admins" | "sso" | "disabled">("all");
  const [sheet, setSheet] = useState<Sheet>(null);
  const load = () =>
    apiJson<AdminUser[]>("/admin/users")
      .then(setUsers)
      .catch((e) => toast("error", msg(e)));
  useEffect(() => void load(), []);
  const back = () => (setSheet(null), void load());
  if (!cfg) return null;
  const shown = (users ?? []).filter((u) => {
    const t = q.trim().toLowerCase();
    const hit = !t || [u.username, u.displayName, u.email ?? ""].some((x) => x.toLowerCase().includes(t));
    const f = filter === "all" || (filter === "admins" && u.isAdmin) || (filter === "sso" && u.sso) || (filter === "disabled" && u.disabled);
    return hit && f;
  });
  if (sheet && sheet.kind !== "add" && users) return <UserSheet sheet={sheet} users={users} cfg={cfg} onDone={back} />;
  if (sheet?.kind === "add") return <AddUser cfg={cfg} onDone={back} />;
  return (
    <div className="settings__section">
      <div className="people__bar">
        <TextField value={q} onChange={setQ} placeholder="Search people" icon="search" />
        <Select
          ariaLabel="Show"
          value={filter}
          onChange={setFilter}
          options={[
            { value: "all", label: "Everyone" },
            { value: "admins", label: "Administrators" },
            { value: "sso", label: "Single sign-on" },
            { value: "disabled", label: "Disabled" },
          ]}
        />
        <button className="btn btn--accent btn--small" onClick={() => setSheet({ kind: "add" })}>
          <Icon name="plus" size={15} /> Add person
        </button>
      </div>
      {users === null && <p className="muted">Loading…</p>}
      <div className="userlist" role="table" aria-label="People">
        {shown.map((u) => (
          <div key={u.id} className={`userrow ${u.disabled ? "is-disabled" : ""}`} role="row">
            <span className="avatar">{initials(u.displayName)}</span>
            <button className="userrow__who" onClick={() => setSheet({ kind: "edit", user: u })} title="Edit">
              <b>
                {u.displayName}
                {u.id === me?.id && <span className="muted"> (you)</span>}
              </b>
              <small className="muted">
                <span className="mono">{u.username}</span>
                {u.email ? ` · ${u.email}` : " · no email"}
              </small>
              <span className="badges">
                {u.isAdmin && <span className="badge badge--accent">Admin</span>}
                {u.sso && <span className="badge">SSO</span>}
                {u.ssoLink && <span className="badge">SSO link pending</span>}
                {!u.hasPassword && !u.sso && <span className="badge badge--warn">No sign-in yet</span>}
                {u.disabled && <span className="badge badge--danger">Disabled</span>}
              </span>
            </button>
            <span className="userrow__stats muted small">
              <span>
                {u.designs} design{u.designs === 1 ? "" : "s"} · {bytes(u.storage)}
              </span>
              <span>{u.lastLoginAt ? `Signed in ${ago(u.lastLoginAt)}` : "Never signed in"}</span>
            </span>
            <UserMenu u={u} all={users ?? []} me={me} cfg={cfg} reload={() => void load()} onSheet={setSheet} />
          </div>
        ))}
        {users && shown.length === 0 && <p className="muted">No one matches.</p>}
      </div>
    </div>
  );
}

function SheetHead({ title, onBack }: { title: string; onBack: () => void }) {
  return (
    <div className="sheet__head">
      <button className="iconbtn iconbtn--small" onClick={onBack} aria-label="Back to people">
        <Icon name="arrowLeft" size={16} />
      </button>
      <h3>{title}</h3>
    </div>
  );
}

function AddUser({ cfg, onDone }: { cfg: ServerConfig; onDone: () => void }) {
  const [d, setD] = useState({ username: "", displayName: "", email: "", password: "", isAdmin: false, invite: cfg.passwordReset });
  const [busy, setBusy] = useState(false);
  const needsPassword = cfg.local && !d.invite && !cfg.oidc;
  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setBusy(true);
    try {
      await apiJson("/admin/users", { method: "POST", json: { ...d, password: d.invite ? "" : d.password } });
      toast("ok", d.invite ? `Invitation sent to ${d.email}` : `Added ${d.username}`);
      onDone();
    } catch (err) {
      toast("error", msg(err));
    } finally {
      setBusy(false);
    }
  };
  return (
    <form className="settings__section sheet" onSubmit={submit} onKeyDown={(e) => e.stopPropagation()}>
      <SheetHead title="Add a person" onBack={onDone} />
      <div className="settings__grid">
        <TextField label="Username" value={d.username} onChange={(v) => setD({ ...d, username: v })} autoFocus required />
        <TextField label="Name" value={d.displayName} onChange={(v) => setD({ ...d, displayName: v })} placeholder="Optional" />
      </div>
      <TextField
        label="Email"
        type="email"
        icon="mail"
        value={d.email}
        onChange={(v) => setD({ ...d, email: v })}
        required={cfg.requireEmail || d.invite || !d.password}
        hint={cfg.oidc ? `They can sign in with ${cfg.oidc} using this email` : undefined}
      />
      {cfg.local && cfg.passwordReset && <Switch label="Email an invitation" hint="They choose their own password from a link" checked={d.invite} onChange={(v) => setD({ ...d, invite: v })} />}
      {cfg.local && !d.invite && (
        <TextField
          label="Password"
          type="password"
          value={d.password}
          onChange={(v) => setD({ ...d, password: v })}
          minLength={8}
          autoComplete="new-password"
          required={needsPassword}
          hint={cfg.oidc ? "Leave empty for single sign-on only" : "8 characters or more"}
        />
      )}
      <Switch label="Administrator" hint="Can manage people and server settings" checked={d.isAdmin} onChange={(v) => setD({ ...d, isAdmin: v })} />
      <div className="btnrow">
        <button className="btn btn--accent" type="submit" disabled={busy}>
          {d.invite ? "Send invitation" : "Add person"}
        </button>
        <button className="btn btn--ghost" type="button" onClick={onDone}>
          Cancel
        </button>
      </div>
    </form>
  );
}

function UserSheet({ sheet, users, cfg, onDone }: { sheet: { kind: "merge" | "delete" | "edit"; user: AdminUser }; users: AdminUser[]; cfg: ServerConfig; onDone: () => void }) {
  const u = sheet.user;
  const others = users.filter((x) => x.id !== u.id);
  const [d, setD] = useState({ username: u.username, displayName: u.displayName, email: u.email ?? "", isAdmin: u.isAdmin });
  const [other, setOther] = useState("");
  const [busy, setBusy] = useState(false);
  const path = `/admin/users/${encodeURIComponent(u.id)}`;
  const act = async (fn: () => Promise<unknown>, done: string) => {
    setBusy(true);
    try {
      await fn();
      toast("ok", done);
      onDone();
    } catch (e) {
      toast("error", msg(e));
    } finally {
      setBusy(false);
    }
  };
  const people = others.map((x) => ({ value: x.id, label: x.displayName, hint: `${x.username}${x.sso ? " · SSO" : ""}${x.email ? " · " + x.email : ""}` }));

  if (sheet.kind === "edit") {
    const changed = { ...(d.username !== u.username && { username: d.username }), ...(d.displayName !== u.displayName && { displayName: d.displayName }), ...(d.email !== (u.email ?? "") && { email: d.email }), ...(d.isAdmin !== u.isAdmin && { isAdmin: d.isAdmin }) };
    return (
      <form
        className="settings__section sheet"
        onKeyDown={(e) => e.stopPropagation()}
        onSubmit={(e) => {
          e.preventDefault();
          void act(() => apiJson(path, { method: "PATCH", json: changed }), "Saved");
        }}
      >
        <SheetHead title={`Edit ${u.displayName}`} onBack={onDone} />
        <div className="settings__grid">
          <TextField label="Username" value={d.username} onChange={(v) => setD({ ...d, username: v })} required />
          <TextField label="Name" value={d.displayName} onChange={(v) => setD({ ...d, displayName: v })} required />
        </div>
        <TextField label="Email" type="email" icon="mail" value={d.email} onChange={(v) => setD({ ...d, email: v })} required={cfg.requireEmail} />
        <Switch label="Administrator" checked={d.isAdmin} onChange={(v) => setD({ ...d, isAdmin: v })} />
        <dl className="stats">
          <dt>Sign-in</dt>
          <dd>{[u.hasPassword && "Password", u.sso && "Single sign-on"].filter(Boolean).join(" + ") || "None yet"}</dd>
          <dt>Created</dt>
          <dd>{new Date(u.createdAt).toLocaleDateString()}</dd>
          <dt>Last sign-in</dt>
          <dd>{u.lastLoginAt ? new Date(u.lastLoginAt).toLocaleString() : "Never"}</dd>
          <dt>Designs</dt>
          <dd>
            {u.designs} ({bytes(u.storage)})
          </dd>
        </dl>
        <div className="btnrow">
          <button className="btn btn--accent" type="submit" disabled={busy || Object.keys(changed).length === 0}>
            Save
          </button>
          <button className="btn btn--ghost" type="button" onClick={onDone}>
            Cancel
          </button>
        </div>
      </form>
    );
  }

  if (sheet.kind === "merge") {
    const into = others.find((x) => x.id === other);
    return (
      <div className="settings__section sheet">
        <SheetHead title={`Merge ${u.displayName}`} onBack={onDone} />
        <p className="muted small">
          Use this when one person ended up with two accounts, for example a single sign-on account created on first sign-in next to the account they already had.
        </p>
        <Select label="Keep this account" value={other} placeholder="Choose the account to keep…" options={people} onChange={setOther} />
        {into && (
          <div className="note">
            <Icon name="info" size={16} />
            <div>
              <p>
                <b>{into.displayName}</b> takes over {u.designs} design{u.designs === 1 ? "" : "s"}
                {u.sso && !into.sso ? `, the ${cfg.oidc ?? "single sign-on"} link` : ""}
                {u.hasPassword && !into.hasPassword ? ", the password" : ""}
                {u.email && !into.email ? `, the email ${u.email}` : ""}
                {u.isAdmin && !into.isAdmin ? " and administrator rights" : ""}. The account <b>{u.username}</b> is then removed.
              </p>
            </div>
          </div>
        )}
        <div className="btnrow">
          <button
            className="btn btn--accent"
            disabled={!into || busy}
            onClick={() => void act(() => apiJson(`${path}/merge`, { method: "POST", json: { into: other } }), `Merged ${u.username} into ${into?.username}`)}
          >
            <Icon name="merge" size={15} /> Merge accounts
          </button>
          <button className="btn btn--ghost" onClick={onDone}>
            Cancel
          </button>
        </div>
      </div>
    );
  }

  // Delete
  return (
    <div className="settings__section sheet">
      <SheetHead title={`Delete ${u.displayName}`} onBack={onDone} />
      <p>
        The account <b>{u.username}</b> will be removed. It has {u.designs} design{u.designs === 1 ? "" : "s"} ({bytes(u.storage)}).
      </p>
      {u.designs > 0 && (
        <Select
          label="Their designs"
          value={other || "__delete"}
          onChange={(v) => setOther(v === "__delete" ? "" : v)}
          options={[{ value: "__delete", label: "Delete them", hint: "Every version is removed" }, ...people.map((p) => ({ ...p, label: `Give them to ${p.label}` }))]}
        />
      )}
      <div className="btnrow">
        <button
          className="btn btn--danger-solid"
          disabled={busy}
          onClick={() => void act(() => apiJson(`${path}${other ? `?transferTo=${encodeURIComponent(other)}` : ""}`, { method: "DELETE" }), `Deleted ${u.username}`)}
        >
          <Icon name="trash" size={15} /> Delete account
        </button>
        <button className="btn btn--ghost" onClick={onDone}>
          Cancel
        </button>
      </div>
    </div>
  );
}

/* ── Settings ─────────────────────────────────────────────── */

type Security = "none" | "starttls-optional" | "starttls" | "tls";

interface SettingsData {
  signup: boolean;
  oidcAutoCreate: boolean;
  oidcLinkByEmail: boolean;
  requireEmail: boolean;
  notifications: { welcome: boolean; security: boolean; adminOnSignup: boolean };
  smtp: { host: string; port: number; security: Security; username: string; hasPassword: boolean; fromAddress: string; fromName: string; acceptInvalidCerts: boolean; configured: boolean };
  envSignup: boolean;
  oidc: string | null;
  local: boolean;
}

const SECURITY: { value: Security; label: string; hint: string; port: number }[] = [
  { value: "starttls", label: "STARTTLS (required)", hint: "Encrypted. Usually port 587", port: 587 },
  { value: "tls", label: "TLS / SSL", hint: "Encrypted from the start. Usually port 465", port: 465 },
  { value: "starttls-optional", label: "STARTTLS if offered", hint: "Encrypts when the server supports it, else sends unencrypted", port: 587 },
  { value: "none", label: "None (unencrypted)", hint: "Plain SMTP: only for trusted networks and local relays. Usually port 25", port: 25 },
];

function ServerSettingsPane() {
  const [s, setS] = useState<SettingsData | null>(null);
  const [password, setPassword] = useState<string | null>(null);
  const [testTo, setTestTo] = useState("");
  const [busy, setBusy] = useState(false);
  const me = useApp((st) => (st.platform.kind === "server" ? st.platform.user : null));
  useEffect(() => {
    void apiJson<SettingsData>("/admin/settings")
      .then(setS)
      .catch((e) => toast("error", msg(e)));
    setTestTo(me?.email ?? "");
  }, [me?.email]);
  if (!s) return <p className="muted">Loading…</p>;
  const smtpBody = () => ({ ...s.smtp, ...(password !== null ? { password } : {}) });
  const save = async (patch: Partial<SettingsData> | { smtp: unknown }, done = "Settings saved") => {
    setBusy(true);
    try {
      setS(await apiJson<SettingsData>("/admin/settings", { method: "PUT", json: patch }));
      setPassword(null);
      toast("ok", done);
      const p = useApp.getState().platform;
      if (p.kind === "server") useApp.setState({ platform: { ...p, config: await apiJson<ServerConfig>("/config") } });
    } catch (e) {
      toast("error", msg(e));
    } finally {
      setBusy(false);
    }
  };
  const smtp = (patch: Partial<SettingsData["smtp"]>) => setS({ ...s, smtp: { ...s.smtp, ...patch } });
  return (
    <div className="settings__section">
      <h3 className="eyebrow">Accounts</h3>
      {s.local && <Switch label="Anyone can sign up" hint={`People create their own accounts. Server default: ${s.envSignup ? "on" : "off"}`} checked={s.signup} onChange={(v) => void save({ signup: v })} />}
      <Switch label="Require an email address" hint="For password resets, invitations and notices" checked={s.requireEmail} onChange={(v) => void save({ requireEmail: v })} />
      {s.oidc && (
        <>
          <h3 className="eyebrow">Single sign-on ({s.oidc})</h3>
          <Switch label="Create accounts on first sign-in" hint="Off: only people an administrator added can sign in" checked={s.oidcAutoCreate} onChange={(v) => void save({ oidcAutoCreate: v })} />
          <Switch
            label="Link to existing accounts by verified email"
            hint="Someone signing in with single sign-on joins the account with the same email (when the provider has verified it). Only turn on if you trust the provider's email verification."
            checked={s.oidcLinkByEmail}
            onChange={(v) => void save({ oidcLinkByEmail: v })}
          />
        </>
      )}

      <h3 className="eyebrow">Email (SMTP)</h3>
      <form
        className="stack"
        onKeyDown={(e) => e.stopPropagation()}
        onSubmit={(e) => {
          e.preventDefault();
          void save({ smtp: smtpBody() }, "Email settings saved");
        }}
      >
        <div className="settings__grid settings__grid--smtp">
          <TextField label="Server" value={s.smtp.host} onChange={(v) => smtp({ host: v })} placeholder="smtp.example.com" />
          <div className="field field--stack">
            <span className="field__label">Port</span>
            <NumberField value={s.smtp.port || 587} min={1} max={65535} onChange={(v) => smtp({ port: v })} ariaLabel="Port" />
          </div>
        </div>
        <Select<Security>
          label="Security"
          value={s.smtp.security}
          options={SECURITY.map(({ value, label, hint }) => ({ value, label, hint }))}
          onChange={(v) => smtp({ security: v, port: SECURITY.find((x) => x.value === v)!.port })}
        />
        {s.smtp.security === "none" && (
          <p className="note note--warning">
            <Icon name="warning" size={16} /> Messages and any SMTP password travel unencrypted. Use this only on a trusted network or with a local relay.
          </p>
        )}
        <div className="settings__grid">
          <TextField label="Username" value={s.smtp.username} onChange={(v) => smtp({ username: v })} placeholder="Leave empty if not needed" autoComplete="off" />
          <TextField
            label="Password"
            type="password"
            value={password ?? ""}
            onChange={setPassword}
            placeholder={s.smtp.hasPassword ? "Saved (type to replace)" : "Leave empty if not needed"}
            autoComplete="new-password"
          />
        </div>
        <div className="settings__grid">
          <TextField label="From address" type="email" value={s.smtp.fromAddress} onChange={(v) => smtp({ fromAddress: v })} placeholder="cad@example.com" />
          <TextField label="From name" value={s.smtp.fromName} onChange={(v) => smtp({ fromName: v })} placeholder="Whittle" />
        </div>
        {s.smtp.security !== "none" && (
          <Switch label="Accept self-signed certificates" hint="For internal mail servers without a public certificate" checked={s.smtp.acceptInvalidCerts} onChange={(v) => smtp({ acceptInvalidCerts: v })} />
        )}
        <div className="btnrow">
          <button className="btn btn--accent btn--small" type="submit" disabled={busy}>
            Save email settings
          </button>
        </div>
        <div className="testmail">
          <TextField label="Send a test to" type="email" value={testTo} onChange={setTestTo} />
          <button
            type="button"
            className="btn btn--small"
            disabled={busy || !testTo || !s.smtp.host}
            onClick={async () => {
              setBusy(true);
              try {
                await apiJson("/admin/settings/test-email", { method: "POST", json: { to: testTo, smtp: smtpBody() } });
                toast("ok", `Test email sent to ${testTo}`);
              } catch (e) {
                toast("error", msg(e));
              } finally {
                setBusy(false);
              }
            }}
          >
            <Icon name="send" size={14} /> Send test
          </button>
        </div>
      </form>

      <h3 className="eyebrow">Notifications</h3>
      {!s.smtp.configured && <p className="muted small">Set up email above to send these.</p>}
      <Switch label="Welcome new people" hint="When an administrator adds someone" checked={s.notifications.welcome} onChange={(v) => void save({ notifications: { ...s.notifications, welcome: v } })} />
      <Switch label="Security notices" hint="Password changed or reset, account disabled" checked={s.notifications.security} onChange={(v) => void save({ notifications: { ...s.notifications, security: v } })} />
      <Switch label="Tell administrators about sign-ups" checked={s.notifications.adminOnSignup} onChange={(v) => void save({ notifications: { ...s.notifications, adminOnSignup: v } })} />
    </div>
  );
}

/* ── Activity ─────────────────────────────────────────────── */

interface AuditEntry {
  at: number;
  actor: string | null;
  action: string;
  target: string | null;
  detail: string | null;
}

const ACTIONS: Record<string, string> = {
  "setup.admin": "set up the server",
  "account.signup": "signed up",
  "account.sso_signup": "signed up with single sign-on",
  "account.password": "changed their password",
  "account.email": "changed their email",
  "account.reset_requested": "asked for a password reset",
  "account.reset": "reset their password",
  "login.locked": "sign-in locked after failed attempts",
  "user.create": "added",
  "user.update": "changed",
  "user.delete": "deleted",
  "user.merge": "merged accounts",
  "user.sso_link": "linked single sign-on",
  "user.sso_unlink": "unlinked single sign-on for",
  "user.signout": "signed out",
  "user.reset_sent": "sent a reset link to",
  "settings.update": "changed server settings",
  "email.failed": "email failed to",
};

function Activity() {
  const [log, setLog] = useState<AuditEntry[] | null>(null);
  useEffect(() => void apiJson<AuditEntry[]>("/admin/audit?limit=300").then(setLog).catch((e) => toast("error", msg(e))), []);
  if (!log) return <p className="muted">Loading…</p>;
  if (log.length === 0) return <p className="muted">Nothing has happened yet.</p>;
  return (
    <ol className="activity">
      {log.map((e, i) => (
        <li key={i}>
          <span className={`activity__dot ${e.action.startsWith("email.") || e.action === "login.locked" ? "is-warn" : ""}`} />
          <div>
            <p>
              <b>{e.actor ?? e.target ?? "Someone"}</b> {ACTIONS[e.action] ?? e.action} {e.target && e.target !== (e.actor ?? e.target) && <b>{e.target}</b>}
            </p>
            <small className="muted">
              {ago(e.at)}
              {e.detail ? ` · ${e.detail}` : ""}
            </small>
          </div>
        </li>
      ))}
    </ol>
  );
}

/** Title-bar button: who's signed in (server only). */
export function AccountButton() {
  const platform = useApp((s) => s.platform);
  if (platform.kind !== "server" || !platform.user) return null;
  const u = platform.user;
  return (
    <button className="avatar" onClick={() => useApp.setState({ panel: "account" })} title={`${u.displayName} · account`} aria-label="Account">
      {initials(u.displayName)}
    </button>
  );
}
