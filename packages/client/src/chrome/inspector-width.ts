import { INSPECTOR_WIDTH_PX } from './Inspector';

export const INSPECTOR_WIDTH_STORAGE_KEY = 'kelpi.inspector.width';
export const INSPECTOR_MIN_WIDTH = 240;
export const INSPECTOR_MAX_WIDTH = 640;
export function clampInspectorWidth(value: number): number {
    return Number.isFinite(value) ? Math.min(INSPECTOR_MAX_WIDTH, Math.max(INSPECTOR_MIN_WIDTH, Math.round(value))) : INSPECTOR_WIDTH_PX;
}
export function readStoredInspectorWidth(storage?: Storage): number {
    try {
        const raw = (storage ?? window.localStorage).getItem(INSPECTOR_WIDTH_STORAGE_KEY);
        return raw === null || raw.trim() === '' ? INSPECTOR_WIDTH_PX : clampInspectorWidth(Number(raw));
    } catch { return INSPECTOR_WIDTH_PX; }
}
export function storeInspectorWidth(value: number): void {
    try { window.localStorage.setItem(INSPECTOR_WIDTH_STORAGE_KEY, String(clampInspectorWidth(value))); } catch { /* Optional preference. */ }
}
