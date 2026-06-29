import { createPortal } from 'react-dom';
import { useEffect } from 'react';
import { X } from 'lucide-react';

// ─── Modal ──────────────────────────────────────────────────────
export function Modal({ isOpen, onClose, title, children, footer, wide = false }) {
  useEffect(() => {
    if (!isOpen) return;
    const handler = (e) => { if (e.key === 'Escape') onClose(); };
    document.addEventListener('keydown', handler);
    return () => document.removeEventListener('keydown', handler);
  }, [isOpen, onClose]);

  if (!isOpen) return null;

  return createPortal(
    <div
      className="modal-overlay"
      onClick={(e) => { if (e.target === e.currentTarget) onClose(); }}
    >
      <div className={`modal-card${wide ? ' modal-card--wide' : ''}`}>
        <div className="modal__header">
          <h2>{title}</h2>
          <button className="icon-button" type="button" onClick={onClose} aria-label="Cerrar">
            <X size={16} />
          </button>
        </div>
        <div className="modal__body">{children}</div>
        {footer && <div className="modal__footer">{footer}</div>}
      </div>
    </div>,
    document.body
  );
}

// ─── Drawer ─────────────────────────────────────────────────────
export function Drawer({ isOpen, onClose, title, children, footer }) {
  useEffect(() => {
    if (!isOpen) return;
    const handler = (e) => { if (e.key === 'Escape') onClose(); };
    document.addEventListener('keydown', handler);
    return () => document.removeEventListener('keydown', handler);
  }, [isOpen, onClose]);

  if (!isOpen) return null;

  return createPortal(
    <>
      <div className="drawer-overlay" onClick={onClose} />
      <aside className="drawer">
        <div className="drawer__header">
          <h2>{title}</h2>
          <button className="icon-button" type="button" onClick={onClose} aria-label="Cerrar">
            <X size={16} />
          </button>
        </div>
        <div className="drawer__body">{children}</div>
        {footer && <div className="drawer__footer">{footer}</div>}
      </aside>
    </>,
    document.body
  );
}
