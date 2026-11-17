'use client';
import { useEffect, useRef, type ReactNode, type ComponentPropsWithRef, type HTMLAttributes, type InputHTMLAttributes, type SelectHTMLAttributes } from 'react';
import { useTranslation } from 'react-i18next';
import './standard.css';
export function Page({ children }: { children?: ReactNode }) {
  return <div className="ui-page ui-standard">{children}</div>;
}
export function PageHeader({ title, description, action, children }: { title: string; description?: string; action?: ReactNode; children?: ReactNode }) {
  return <header className="ui-header">
    <div>
      <h1>{title}</h1>
      {description && <p>{description}</p>}
      {children}
    </div>
    {action}
  </header>;
}
export function Card({ title, action, children, editing = false, className = '', ...props }: HTMLAttributes<HTMLElement> & { title?: string; action?: ReactNode; children?: ReactNode; editing?: boolean }) {
  return <section {...props} className={`ui-card ui-stack${editing ? ' is-editing' : ''} ${className}`}>{title && <div className="ui-card-heading"><h2>{title}</h2>{action}</div>}{children}</section>;
}
export function Hero({ children }: { children?: ReactNode }) {
  return <section className="ui-hero">{children}</section>;
}
export function Button({ variant = 'weak', className = '', ...props }: ComponentPropsWithRef<'button'> & { variant?: 'primary' | 'secondary' | 'weak' | 'text' }) {
  return <button {...props} className={`ui-button ui-${variant} ${className}`} />;
}
export function Tag({ tone = 'neutral', children }: { tone?: 'primary' | 'warning' | 'neutral'; children?: ReactNode }) {
  return <span className={`ui-tag ${tone}`}>{children}</span>;
}
export function DataList({ items }: { items: { label: string; value: ReactNode }[] }) {
  return <dl className="ui-data">{items.map(i => <div key={i.label}>
    <dt>{i.label}</dt>
    <dd>{i.value}</dd>
  </div>)}</dl>;
}
export function FilledData({ items, missingLabel }: { items: { label: string; value: ReactNode; filled: boolean }[]; missingLabel: (count: number) => string }) {
  const missing = items.filter(item => !item.filled).length;
  return <><DataList items={items.filter(item => item.filled)} /><MissingCount count={missing} label={missingLabel} /></>;
}
export function Input({ label, ...props }: InputHTMLAttributes<HTMLInputElement> & { label: string }) {
  return <label className="ui-field">
    <span>{label}</span>
    <input {...props} className={`ui-input ${props.className ?? ''}`} />
  </label>;
}
export function Select({ label, children, ...props }: SelectHTMLAttributes<HTMLSelectElement> & { label: string }) {
  return <label className="ui-field">
    <span>{label}</span>
    <select {...props} className="ui-input">{children}</select>
  </label>;
}
export function Search(props: InputHTMLAttributes<HTMLInputElement> & { label: string }) {
  return <Input {...props} type="search" className="ui-search" />;
}
export function Chips({ items, value, onChange, label }: { items: { value: string; label: string }[]; value: string; onChange: (value: string) => void; label: string }) {
  return <div className="ui-filters" aria-label={label}>
    {items.map(i => <button type="button" className="ui-chip" aria-pressed={value === i.value} key={i.value} onClick={() => onChange(i.value)}>{i.label}</button>)}
  </div>;
}
export function Tabs({ items, value, onChange, label }: { items: { value: string; label: string }[]; value: string; onChange: (value: string) => void; label: string }) {
  return <div className="ui-filters ui-tabs" role="tablist" aria-label={label}>
    {items.map(i => <button type="button" role="tab" aria-selected={i.value === value} key={i.value} className="ui-chip" onClick={() => onChange(i.value)}>{i.label}</button>)}
  </div>;
}
export function Table({ headings, children }: { headings: string[]; children?: ReactNode }) {
  return <div className="ui-table-scroll" tabIndex={0}>
    <table className="ui-table">
      <thead>
        <tr>{headings.map(h => <th key={h} scope="col">{h}</th>)}</tr>
      </thead>
      <tbody>{children}</tbody>
    </table>
  </div>;
}
export function Pagination({ page, pageSize, total, onChange }: { page: number; pageSize: number; total: number; onChange: (page: number) => void }) {
  const { t } = useTranslation();
  return <footer className="ui-pagination">
    <span>{t('ui.pagination', { from: total ? (page - 1) * pageSize + 1 : 0, to: Math.min(page * pageSize, total), total })}</span>
    <div className="ui-actions">
      <Button disabled={page <= 1} onClick={() => onChange(page - 1)}>{t('ui.previous')}</Button>
      <Button disabled={page * pageSize >= total} onClick={() => onChange(page + 1)}>{t('ui.next')}</Button>
    </div>
  </footer>;
}
export function Notice({ children, warning = false }: { children?: ReactNode; warning?: boolean }) {
  return <div className={`ui-notice${warning ? ' warning' : ''}`} role={warning ? 'alert' : 'status'}>{children}</div>;
}
export function Empty({ title, detail, action }: { title: string; detail?: string; action?: ReactNode }) {
  return <div className="ui-empty">
    <h2>{title}</h2>
    {detail && <p>{detail}</p>}
    {action}
  </div>;
}
export function Progress({ steps }: { steps: { label: string; state: 'complete' | 'current' | 'future' }[] }) {
  const { t } = useTranslation();
  return <div className="ui-progress">{steps.map(s => <div className={s.state} key={s.label}>
    <i aria-hidden="true" />
    <span>{s.label} · {t(`ui.${s.state}`)}</span>
  </div>)}</div>;
}
export function Confirm({ title, children, onCancel, onConfirm, confirmLabel, confirmDisabled = false, cancelDisabled = false }: { title: string; children?: ReactNode; onCancel: () => void; onConfirm: () => void; confirmLabel?: string; confirmDisabled?: boolean; cancelDisabled?: boolean }) {
  const { t } = useTranslation();
  const ref = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    ref.current?.showModal();
  }, []);
  return <dialog ref={ref} className="ui-dialog ui-standard" aria-label={title} onCancel={event => { event.preventDefault(); if (!cancelDisabled) onCancel(); }}>
    <h2>{title}</h2>
    <div className="ui-stack">
      {children}
      <div className="ui-actions">
        <Button type="button" disabled={cancelDisabled} onClick={onCancel}>{t('ui.cancel')}</Button>
        <Button type="button" variant="primary" disabled={confirmDisabled} onClick={onConfirm}>{confirmLabel ?? t('ui.confirm')}</Button>
      </div>
    </div>
  </dialog>;
}
export function TranslatedText({ translationKey }: { translationKey: string }) {
  const { t } = useTranslation();
  return <>{t(translationKey)}</>;
}

/** Bare controls for existing labelled forms; retain their names, refs and native validation. */
export function FieldInput({ className = '', type, ...props }: ComponentPropsWithRef<'input'>) {
  const choice = type === 'checkbox' || type === 'radio';
  return <input {...props} type={type} className={`${choice ? 'ui-choice' : 'ui-input ui-control'} ${className}`} />;
}
export function FieldSelect({ className = '', ...props }: ComponentPropsWithRef<'select'>) {
  return <select {...props} className={`ui-input ui-control ${className}`} />;
}
export function TextArea({ className = '', ...props }: ComponentPropsWithRef<'textarea'>) {
  return <textarea {...props} className={`ui-input ui-control ui-textarea ${className}`} />;
}

/** Navigation links do not grant access; destination routes retain their authorization. */
export function RouteTabs({ label, items }: { label: string; items: readonly { href: string; label: string; current?: boolean }[] }) {
  return <nav className="ui-route-tabs" aria-label={label}><div className="ui-route-tab-list">
    {items.map(item => <a key={item.href} href={item.href} className={`ui-route-tab${item.current ? ' selected' : ''}`} aria-current={item.current ? 'page' : undefined}>{item.label}</a>)}
  </div></nav>;
}

export function MissingCount({ count, label }: { count: number; label: (count: number) => string }) {
  return count > 0 ? <p className="ui-muted">{label(count)}</p> : null;
}
export function SystemData({ children }: { children?: ReactNode }) {
  const { t } = useTranslation();
  return <details className="ui-history"><summary>{t('caseUi.systemData')}</summary><div className="ui-stack">{children}</div></details>;
}
