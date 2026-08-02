let iosHapticInput: HTMLInputElement | null = null;
let iosHapticLabel: HTMLLabelElement | null = null;

function ensureIOSHapticElements(): { input: HTMLInputElement; label: HTMLLabelElement } | null {
  if (typeof document === 'undefined') return null;

  if (iosHapticInput && iosHapticLabel && document.body.contains(iosHapticInput)) {
    return { input: iosHapticInput, label: iosHapticLabel };
  }

  const input = document.createElement('input');
  input.type = 'checkbox';
  input.setAttribute('switch', '');
  input.id = 'haptic-switch';
  input.style.position = 'fixed';
  input.style.top = '-100px';
  input.style.left = '-100px';
  input.style.opacity = '0';
  input.style.pointerEvents = 'none';
  input.style.width = '0';
  input.style.height = '0';
  input.tabIndex = -1;
  input.setAttribute('aria-hidden', 'true');

  const label = document.createElement('label');
  label.htmlFor = 'haptic-switch';
  label.style.position = 'fixed';
  label.style.top = '-100px';
  label.style.left = '-100px';
  label.style.opacity = '0';
  label.style.pointerEvents = 'none';
  label.style.width = '0';
  label.style.height = '0';

  document.body.appendChild(input);
  document.body.appendChild(label);

  iosHapticInput = input;
  iosHapticLabel = label;

  return { input, label };
}

const isIOS = typeof navigator !== 'undefined' && /iPhone|iPad|iPod/.test(navigator.userAgent);

export function triggerHaptic(durationMs = 10): void {
  if (isIOS) {
    const els = ensureIOSHapticElements();
    if (els) {
      els.label.click();
    }
  } else if (typeof navigator !== 'undefined' && 'vibrate' in navigator) {
    navigator.vibrate(durationMs);
  }
}
