import { createPortal } from 'react-dom';
import { useEffect, useId, useRef } from 'react';
import { X } from 'lucide-react';

// Portals render outside the normal React tree. A per-document stack lets
// nested dialogs handle Escape/Tab only at the active surface.
const dialogStack = [];
const FOCUSABLE = [
  'a[href]', 'button:not([disabled])', 'input:not([disabled])',
  'select:not([disabled])', 'textarea:not([disabled])',
  '[tabindex]:not([tabindex="-1"])'
].join(', ');

export function getDialogFocusable(root) {
  if (!root) return [];
  return Array.from(root.querySelectorAll(FOCUSABLE)).filter(node =>
    node.getAttribute('aria-hidden') !== 'true' &&
    node.getAttribute('tabindex') !== '-1' &&
    node.getClientRects().length > 0);
}

function useDialogFocus(isOpen, onClose) {
  const dialogRef = useRef(null);
  const onCloseRef = useRef(onClose);
  onCloseRef.current = onClose;

  useEffect(() => {
    if (!isOpen) return undefined;
    const id = Symbol('sedeagro-dialog');
    const previouslyFocused = document.activeElement;
    dialogStack.push(id);
    const root = dialogRef.current;
    root?.focus();

    const onKeyDown = (event) => {
      if (dialogStack[dialogStack.length - 1] !== id) return;
      if (event.key === 'Escape') {
        event.preventDefault();
        event.stopPropagation();
        onCloseRef.current?.();
      } else if (event.key === 'Tab') {
        const focusable = getDialogFocusable(root);
        if (!focusable.length) {
          event.preventDefault();
          root?.focus();
          return;
        }
        const first = focusable[0];
        const last = focusable[focusable.length - 1];
        const active = document.activeElement;
        if (!root?.contains(active)) {
          event.preventDefault();
          (event.shiftKey ? last : first).focus();
        } else if (event.shiftKey && (active === first || active === root)) {
          event.preventDefault();
          last.focus();
        } else if (!event.shiftKey && active === last) {
          event.preventDefault();
          first.focus();
        }
      }
    };
    document.addEventListener('keydown', onKeyDown);
    return () => {
      document.removeEventListener('keydown', onKeyDown);
      const index = dialogStack.indexOf(id);
      if (index !== -1) dialogStack.splice(index, 1);
      // The opener may have disappeared after a successful creation or a
      // changed entitlement. Never focus a detached or unauthorized element.
      if (previouslyFocused?.isConnected && dialogStack.length === 0) {
        previouslyFocused.focus();
      }
    };
  }, [isOpen]);

  return dialogRef;
}

export function Modal({ isOpen, onClose, title, children, footer, wide = false }) {
  const titleId = useId();
  const dialogRef = useDialogFocus(isOpen, onClose);
  if (!isOpen) return null;

  return createPortal(
    <div className="modal-overlay" onClick={(event) => {
      if (event.target === event.currentTarget) onClose?.();
    }}>
      <div ref={dialogRef} className={`modal-card${wide ? ' modal-card--wide' : ''}`}
        role="dialog" aria-modal="true" aria-labelledby={titleId} tabIndex={-1}>
        <div className="modal__header">
          <h2 id={titleId}>{title}</h2>
          <button className="icon-button" type="button" onClick={onClose} aria-label={`Cerrar ${title}`}>
            <X size={16} aria-hidden="true" />
          </button>
        </div>
        <div className="modal__body">{children}</div>
        {footer && <div className="modal__footer">{footer}</div>}
      </div>
    </div>,
    document.body
  );
}

export function Drawer({ isOpen, onClose, title, children, footer }) {
  const titleId = useId();
  const dialogRef = useDialogFocus(isOpen, onClose);
  if (!isOpen) return null;

  return createPortal(
    <>
      <div className="drawer-overlay" onClick={onClose} aria-hidden="true" />
      <aside ref={dialogRef} className="drawer" role="dialog" aria-modal="true"
        aria-labelledby={titleId} tabIndex={-1}>
        <div className="drawer__header">
          <h2 id={titleId}>{title}</h2>
          <button className="icon-button" type="button" onClick={onClose} aria-label={`Cerrar ${title}`}>
            <X size={16} aria-hidden="true" />
          </button>
        </div>
        <div className="drawer__body">{children}</div>
        {footer && <div className="drawer__footer">{footer}</div>}
      </aside>
    </>,
    document.body
  );
}
