type ToastKind = 'error' | 'warning' | 'success' | 'info';

const ICONS: Record<ToastKind, string> = {
    error: '✕',
    warning: '!',
    success: '✓',
    info: 'i',
};

const DEFAULT_TIMEOUT: Record<ToastKind, number> = {
    error: 7000,
    warning: 5000,
    success: 3500,
    info: 4000,
};

let container: HTMLElement | null = null;

function getContainer(): HTMLElement {
    if (container) return container;
    container = document.getElementById('toasts');
    if (!container) {
        container = document.createElement('div');
        container.id = 'toasts';
        container.setAttribute('aria-live', 'polite');
        document.body.appendChild(container);
    }
    return container;
}

export function showToast(message: string, kind: ToastKind = 'info', title?: string): void {
    const host = getContainer();

    // Don't stack the same message if it fires repeatedly.
    const existing = Array.from(host.children).find(
        (el) => (el as HTMLElement).dataset.message === message
    ) as HTMLElement | undefined;
    if (existing) {
        existing.classList.remove('shake');
        void existing.offsetWidth;
        existing.classList.add('shake');
        return;
    }

    const toast = document.createElement('div');
    toast.className = `toast ${kind}`;
    toast.dataset.message = message;
    toast.setAttribute('role', kind === 'error' ? 'alert' : 'status');

    const icon = document.createElement('span');
    icon.className = 'toast-icon';
    icon.textContent = ICONS[kind];

    const body = document.createElement('div');
    body.className = 'toast-body';
    if (title) {
        const heading = document.createElement('div');
        heading.className = 'toast-title';
        heading.textContent = title;
        body.appendChild(heading);
    }
    const text = document.createElement('div');
    text.className = 'toast-text';
    text.textContent = message;
    body.appendChild(text);

    const close = document.createElement('button');
    close.type = 'button';
    close.className = 'toast-close';
    close.setAttribute('aria-label', 'Dismiss');
    close.textContent = '×';

    toast.append(icon, body, close);
    host.appendChild(toast);

    let timer = window.setTimeout(dismiss, DEFAULT_TIMEOUT[kind]);

    function dismiss() {
        window.clearTimeout(timer);
        toast.classList.add('leaving');
        toast.addEventListener('animationend', () => toast.remove(), { once: true });
    }

    close.addEventListener('click', dismiss);
    // Give the reader time when they're hovering over it.
    toast.addEventListener('mouseenter', () => window.clearTimeout(timer));
    toast.addEventListener('mouseleave', () => {
        timer = window.setTimeout(dismiss, 2000);
    });
}
