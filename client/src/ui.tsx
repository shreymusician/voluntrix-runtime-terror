import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type FormEvent, type KeyboardEvent, type ReactNode } from 'react';
import { Icon } from './components';
import { api, type Meta } from './api';

// ------------------------------------------------------------------ toasts

interface Toast {
  id: number;
  kind: 'success' | 'error';
  text: string;
}
type Notify = (kind: Toast['kind'], text: string) => void;

interface Confirmation {
  title: string;
  message: string;
  confirmLabel: string;
  danger?: boolean;
  /** When set, the dialog asks for a short reason and passes it back. */
  reasonLabel?: string;
}
type Confirm = (options: Confirmation) => Promise<{ ok: boolean; reason: string }>;

const FeedbackContext = createContext<{ notify: Notify; confirm: Confirm } | null>(null);

/** App-wide success/failure notifications and confirmation dialogs. */
export function FeedbackProvider({ children }: { children: ReactNode }) {
  const [toasts, setToasts] = useState<Toast[]>([]);
  const [pending, setPending] = useState<(Confirmation & { resolve: (r: { ok: boolean; reason: string }) => void }) | null>(null);
  const [reason, setReason] = useState('');
  const dialog = useRef<HTMLDialogElement>(null);
  const nextId = useRef(1);

  const notify = useCallback<Notify>((kind, text) => {
    const id = nextId.current++;
    setToasts((list) => [...list, { id, kind, text }]);
    window.setTimeout(() => setToasts((list) => list.filter((t) => t.id !== id)), kind === 'error' ? 7000 : 4000);
  }, []);

  const confirm = useCallback<Confirm>((options) => new Promise((resolve) => {
    setReason('');
    setPending({ ...options, resolve });
  }), []);

  useEffect(() => {
    if (pending && !dialog.current?.open) dialog.current?.showModal();
  }, [pending]);

  const settle = (ok: boolean) => {
    pending?.resolve({ ok, reason: reason.trim() });
    dialog.current?.close();
    setPending(null);
  };

  const value = useMemo(() => ({ notify, confirm }), [notify, confirm]);
  return (
    <FeedbackContext.Provider value={value}>
      {children}
      <div className="toasts" aria-live="polite">
        {toasts.map((t) => {
          const iconByKind = {
            success: 'activity',
            error: 'shield',
          } as const;

          return (
            <div key={t.id} className={`toast toast-${t.kind}`} role={t.kind === 'error' ? 'alert' : 'status'}>
              <span className="toast-icon" aria-hidden="true"><Icon name={iconByKind[t.kind]} /></span>
              <span className="toast-text">{t.text}</span>
            </div>
          );
        })}
      </div>
      <dialog ref={dialog} className="dialog" onCancel={(e) => { e.preventDefault(); settle(false); }}>
        {pending && (
          <form method="dialog" onSubmit={(e) => { e.preventDefault(); settle(true); }}>
            <h2>{pending.title}</h2>
            <p>{pending.message}</p>
            {pending.reasonLabel && (
              <div className="field">
                <label htmlFor="confirm-reason">{pending.reasonLabel}</label>
                <input id="confirm-reason" value={reason} maxLength={500} onChange={(e) => setReason(e.target.value)} />
              </div>
            )}
            <div className="dialog-actions">
              <button type="button" className="btn btn-secondary" onClick={() => settle(false)}>
                Cancel
              </button>
              <button className={pending.danger ? 'btn btn-danger-solid' : 'btn btn-primary'}>{pending.confirmLabel}</button>
            </div>
          </form>
        )}
      </dialog>
    </FeedbackContext.Provider>
  );
}

export function useFeedback() {
  const ctx = useContext(FeedbackContext);
  if (!ctx) throw new Error('useFeedback must be used inside FeedbackProvider');
  return ctx;
}

// -------------------------------------------------------------------- modal

export function Modal({ title, onClose, children, wide }: { title: string; onClose: () => void; children: ReactNode; wide?: boolean }) {
  const ref = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    ref.current?.showModal();
  }, []);
  return (
    <dialog ref={ref} className={`dialog${wide ? ' dialog-wide' : ''}`} onClose={onClose} onCancel={onClose}>
      <div className="dialog-head">
        <h2>{title}</h2>
        <button type="button" className="btn btn-ghost btn-sm" onClick={onClose} aria-label="Close">
          Close
        </button>
      </div>
      {children}
    </dialog>
  );
}

// --------------------------------------------------------------------- meta

let metaPromise: Promise<Meta> | null = null;

/** Option lists and limits from the server, fetched once per page load. */
export function useMeta() {
  const [meta, setMeta] = useState<Meta | null>(null);
  useEffect(() => {
    metaPromise ??= api<Meta>('/meta').catch((err) => {
      metaPromise = null;
      throw err;
    });
    let live = true;
    metaPromise.then((m) => live && setMeta(m)).catch(() => undefined);
    return () => {
      live = false;
    };
  }, []);
  return meta;
}

// ------------------------------------------------------------- skill picker

const keyOf = (name: string) => name.trim().replace(/\s+/g, ' ').toLowerCase();

interface SkillPickerProps {
  value: string[];
  onChange: (skills: string[]) => void;
  suggestions: string[];
  max: number;
  maxLength: number;
  error?: string;
  label: string;
  /** Shown under the label, e.g. what the skills are used for. */
  hint?: string;
  idPrefix: string;
}

/**
 * Chip-based multi-select with custom entries. Used for a student's skills
 * and for an activity's required and nice-to-have skills. The server applies
 * the same rules again; this only gives immediate feedback.
 */
export function SkillPicker({ value, onChange, suggestions, max, maxLength, error, label, hint, idPrefix }: SkillPickerProps) {
  const [custom, setCustom] = useState('');
  const [localError, setLocalError] = useState<string | null>(null);
  const selected = new Set(value.map(keyOf));
  const customSkills = value.filter((s) => !suggestions.some((x) => keyOf(x) === keyOf(s)));

  const toggle = (skill: string) => {
    setLocalError(null);
    if (selected.has(keyOf(skill))) onChange(value.filter((s) => keyOf(s) !== keyOf(skill)));
    else if (value.length >= max) setLocalError(`You can select at most ${max} skills`);
    else onChange([...value, skill]);
  };

  const addCustom = () => {
    const name = custom.trim().replace(/\s+/g, ' ');
    if (!name) return setLocalError('Type a skill name first');
    if (name.length > maxLength) return setLocalError(`Skill names can be at most ${maxLength} characters`);
    if (selected.has(keyOf(name))) return setLocalError(`"${name}" is already selected`);
    if (value.length >= max) return setLocalError(`You can select at most ${max} skills`);
    // Typing a suggested skill in another capitalisation selects the suggestion.
    onChange([...value, suggestions.find((s) => keyOf(s) === keyOf(name)) ?? name]);
    setCustom('');
    setLocalError(null);
  };

  const onKey = (e: KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      addCustom();
    }
  };

  const shown = localError ?? error;
  return (
    <fieldset className={`field skill-picker${shown ? ' field-invalid' : ''}`}>
      <legend>
        {label} <span className="muted">({value.length} of {max} selected)</span>
      </legend>
      {hint && <p className="field-hint">{hint}</p>}
      <div className="chips">
        {suggestions.map((skill) => (
          <button key={skill} type="button" className={`chip${selected.has(keyOf(skill)) ? ' chip-on' : ''}`} aria-pressed={selected.has(keyOf(skill))} onClick={() => toggle(skill)}>
            {skill}
          </button>
        ))}
        {customSkills.map((skill) => (
          <button key={skill} type="button" className="chip chip-on chip-custom" aria-pressed="true" onClick={() => toggle(skill)} title="Remove">
            {skill} <span aria-hidden="true">×</span>
          </button>
        ))}
      </div>
      <div className="inline-add">
        <input
          id={`${idPrefix}-custom`}
          aria-label="Add another skill"
          placeholder="Add another skill, e.g. Video Editing"
          value={custom}
          maxLength={maxLength + 10}
          onChange={(e) => {
            setCustom(e.target.value);
            setLocalError(null);
          }}
          onKeyDown={onKey}
        />
        <button type="button" className="btn btn-secondary" onClick={addCustom}>
          Add
        </button>
      </div>
      {shown && <p className="field-error" role="alert">{shown}</p>}
    </fieldset>
  );
}

export function Chips({ items, empty = 'None' }: { items: string[]; empty?: string }) {
  if (!items.length) return <span className="muted">{empty}</span>;
  return (
    <span className="chips chips-static">
      {items.map((item) => (
        <span key={item} className="chip chip-static">
          {item}
        </span>
      ))}
    </span>
  );
}

export function PageHeader({ title, subtitle, children, eyebrow }: { title: string; subtitle?: string; children?: ReactNode; eyebrow?: string }) {
  return (
    <header className="page-head">
      <div className="page-head-copy">
        {eyebrow && <span className="page-eyebrow">{eyebrow}</span>}
        <h1>{title}</h1>
        {subtitle && <p className="muted">{subtitle}</p>}
      </div>
      {children && <div className="page-actions">{children}</div>}
    </header>
  );
}

export function StatTile({ label, value, note, tone }: { label: string; value: ReactNode; note?: string; tone?: 'warn' | 'bad' }) {
  return (
    <div className={`stat${tone ? ` stat-${tone}` : ''}`}>
      <dt>{label}</dt>
      <dd>{value}</dd>
      {note && <small>{note}</small>}
    </div>
  );
}

/** Wraps an async submit handler with a busy flag. */
export function useBusy() {
  const [busy, setBusy] = useState(false);
  const run = useCallback(async (task: () => Promise<void>) => {
    setBusy(true);
    try {
      await task();
    } finally {
      setBusy(false);
    }
  }, []);
  return { busy, run };
}

export const preventSubmit = (e: FormEvent) => e.preventDefault();

const pad = (n: number) => String(n).padStart(2, '0');
/** YYYY-MM-DD for today in the viewer's own timezone. */
export const todayLocal = () => {
  const d = new Date();
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
};

export function formatDay(date: string) {
  return new Date(`${date}T00:00:00`).toLocaleDateString(undefined, { weekday: 'short', day: 'numeric', month: 'short', year: 'numeric' });
}
