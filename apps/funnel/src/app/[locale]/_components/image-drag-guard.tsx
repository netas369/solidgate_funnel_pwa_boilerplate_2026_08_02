'use client';

import { useEffect } from 'react';

/**
 * Globally prevents drag-to-save / drag-to-tab behaviour on all <img> elements.
 * CSS `user-drag: none` is webkit-only; this listener catches the dragstart
 * event for any image regardless of browser or when it was added to the DOM.
 */
export function ImageDragGuard() {
  useEffect(() => {
    const handler = (e: DragEvent) => {
      if (e.target instanceof HTMLImageElement) e.preventDefault();
    };
    document.addEventListener('dragstart', handler);
    return () => document.removeEventListener('dragstart', handler);
  }, []);

  return null;
}
