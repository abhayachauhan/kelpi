/**
 * Issue #79: the sidebar drag that never ends.
 *
 * `Sidebar.bulk.test.tsx` already pins the happy path (§WS-002: snapshot tracking, the clamp,
 * the release). This file pins the three ways the release never arrives, each of which left
 * `drag.current` live, the window listeners installed and `document.body`'s `col-resize` cursor
 * over the whole app: the sidebar then tracked the bare cursor for the rest of the session and
 * re-entered a full grid resize on every mouse move.
 *
 * jsdom has no `PointerEvent`, so every event here is a real bubbling `MouseEvent` with the
 * pointer type name, the same shape `Sidebar.bulk.test.tsx` uses, and for the same reason:
 * Testing Library's synthesized events arrive without `clientX`.
 */

import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { SidebarResizer } from './SidebarResizer';

afterEach(() => {
    cleanup();
    document.body.style.removeProperty('cursor');
});

function press(handle: HTMLElement, clientX: number): void {
    handle.dispatchEvent(new MouseEvent('pointerdown', { clientX, button: 0, bubbles: true }));
}

function moveTo(clientX: number): void {
    window.dispatchEvent(new MouseEvent('pointermove', { clientX }));
}

describe('sidebar resizer: a gesture always ends (issue #79)', () => {
    it('sets the body cursor for the length of the drag and clears it on release', () => {
        const onResize = vi.fn();
        render(<SidebarResizer width={220} onResize={onResize} />);
        const handle = screen.getByTestId('sidebar-resizer');

        expect(document.body.style.cursor).toBe('');
        press(handle, 220);
        expect(document.body.style.cursor).toBe('col-resize');
        window.dispatchEvent(new MouseEvent('pointerup', { clientX: 260 }));
        expect(document.body.style.cursor).toBe('');
    });

    it('ends the drag on pointercancel, cursor and listeners with it', () => {
        const onResize = vi.fn();
        const onCommit = vi.fn();
        const onResizeEnd = vi.fn();
        render(
            <SidebarResizer width={220} onResize={onResize} onCommit={onCommit} onResizeEnd={onResizeEnd} />
        );
        const handle = screen.getByTestId('sidebar-resizer');

        press(handle, 220);
        moveTo(260);
        expect(onResize).toHaveBeenLastCalledWith(260);

        // The browser took the pointer away instead of releasing it.
        window.dispatchEvent(new MouseEvent('pointercancel', { clientX: 260 }));
        expect(onResizeEnd).toHaveBeenCalledTimes(1);
        // What the user had already dragged to is kept, not snapped back.
        expect(onCommit).toHaveBeenCalledWith(260);
        expect(document.body.style.cursor).toBe('');

        // The lockout itself: a bare move afterwards must resize nothing.
        onResize.mockClear();
        moveTo(120);
        expect(onResize).not.toHaveBeenCalled();
    });

    it('unmounting mid-drag removes the listeners and clears the cursor (⇧⌘S while dragging)', () => {
        const onResize = vi.fn();
        const onCommit = vi.fn();
        const onResizeEnd = vi.fn();
        const view = render(
            <SidebarResizer width={220} onResize={onResize} onCommit={onCommit} onResizeEnd={onResizeEnd} />
        );
        press(screen.getByTestId('sidebar-resizer'), 220);
        moveTo(280);
        expect(onResize).toHaveBeenLastCalledWith(280);

        // `App.tsx` stops rendering the handle the moment the sidebar starts closing.
        view.unmount();

        expect(onResizeEnd).toHaveBeenCalledTimes(1);
        expect(onCommit).toHaveBeenCalledWith(280);
        expect(document.body.style.cursor).toBe('');

        onResize.mockClear();
        moveTo(190);
        expect(onResize).not.toHaveBeenCalled();
    });

    it('signals the end of a press that never moved, so the resizing flag always clears', () => {
        const onCommit = vi.fn();
        const onResizeEnd = vi.fn();
        const onResizeStart = vi.fn();
        render(
            <SidebarResizer
                width={220}
                onResize={vi.fn()}
                onCommit={onCommit}
                onResizeEnd={onResizeEnd}
                onResizeStart={onResizeStart}
            />
        );
        press(screen.getByTestId('sidebar-resizer'), 220);
        expect(onResizeStart).toHaveBeenCalledTimes(1);

        window.dispatchEvent(new MouseEvent('pointerup', { clientX: 220 }));
        // `onCommit` fires with the unchanged width; `onResizeEnd` is the unconditional one
        // App.tsx clears `sidebarResizing` from.
        expect(onResizeEnd).toHaveBeenCalledTimes(1);
    });

    it('ends the drag when the window loses focus (released over a native web view)', () => {
        const onResize = vi.fn();
        const onCommit = vi.fn();
        const onResizeEnd = vi.fn();
        render(
            <SidebarResizer width={220} onResize={onResize} onCommit={onCommit} onResizeEnd={onResizeEnd} />
        );
        press(screen.getByTestId('sidebar-resizer'), 220);
        moveTo(270);

        // A web pane's `WebContentsView` is a sibling layer: the release lands in ANOTHER web
        // contents and this document never sees a pointerup at all. Losing focus is the signal.
        window.dispatchEvent(new Event('blur'));

        expect(onResizeEnd).toHaveBeenCalledTimes(1);
        expect(onCommit).toHaveBeenCalledWith(270);
        expect(document.body.style.cursor).toBe('');
        onResize.mockClear();
        moveTo(180);
        expect(onResize).not.toHaveBeenCalled();
    });

    it('ends the drag when the document goes hidden (a Space switch mid-drag)', () => {
        const onResize = vi.fn();
        const onResizeEnd = vi.fn();
        render(<SidebarResizer width={220} onResize={onResize} onResizeEnd={onResizeEnd} />);
        press(screen.getByTestId('sidebar-resizer'), 220);
        moveTo(240);

        Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => 'hidden' });
        document.dispatchEvent(new Event('visibilitychange'));
        Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => 'visible' });

        expect(onResizeEnd).toHaveBeenCalledTimes(1);
        onResize.mockClear();
        moveTo(300);
        expect(onResize).not.toHaveBeenCalled();
    });

    it('a second drag after an unmount-interrupted one still tracks (the teardown is not sticky)', () => {
        const first = render(<SidebarResizer width={220} onResize={vi.fn()} />);
        press(screen.getByTestId('sidebar-resizer'), 220);
        first.unmount();

        const onResize = vi.fn();
        render(<SidebarResizer width={220} onResize={onResize} />);
        press(screen.getByTestId('sidebar-resizer'), 200);
        moveTo(250);
        expect(onResize).toHaveBeenLastCalledWith(270);
    });
});

 it.each(['left','right'] as const)('respects a wider side-panel range when docked %s',side=>{
 const resize=vi.fn();const commit=vi.fn();render(<SidebarResizer side={side} width={280} minimumWidth={240} maximumWidth={640} label="Resize side panel" onResize={resize} onCommit={commit}/>);
 const edge=screen.getByRole('separator',{name:'Resize side panel'});press(edge,500);moveTo(side==='right'?0:1000);expect(resize).toHaveBeenLastCalledWith(640);
 moveTo(side==='right'?1000:0);expect(resize).toHaveBeenLastCalledWith(240);window.dispatchEvent(new MouseEvent('pointerup'));expect(commit).toHaveBeenLastCalledWith(240);
 });
 it('captures pointer input across plugin iframes and releases capture when the gesture ends',()=>{
 const resize=vi.fn();render(<SidebarResizer width={280} onResize={resize}/>);const edge=screen.getByTestId('sidebar-resizer');const set=vi.fn();const release=vi.fn();Object.assign(edge,{setPointerCapture:set,releasePointerCapture:release});
 const event=new MouseEvent('pointerdown',{clientX:280,button:0,bubbles:true});Object.defineProperty(event,'pointerId',{value:12});edge.dispatchEvent(event);expect(set).toHaveBeenCalledWith(12);
 moveTo(300);window.dispatchEvent(new MouseEvent('pointerup'));expect(release).toHaveBeenCalledWith(12);resize.mockClear();moveTo(200);expect(resize).not.toHaveBeenCalled();
 });

 it.each(['left','right'] as const)('supports arrow keys and bounds on the %s panel edge', side=>{
 const resize=vi.fn();const commit=vi.fn();render(<SidebarResizer side={side} width={280} minimumWidth={240} maximumWidth={640} label="Resize side panel" onResize={resize} onCommit={commit}/>);
 const edge=screen.getByRole('separator',{name:'Resize side panel'});expect(edge.tabIndex).toBe(0);
 fireEvent.keyDown(edge,{key:'ArrowLeft'});expect(resize).toHaveBeenLastCalledWith(side==='right'?304:256);
 fireEvent.keyDown(edge,{key:'End'});expect(commit).toHaveBeenLastCalledWith(640);
 fireEvent.keyDown(edge,{key:'Home'});expect(commit).toHaveBeenLastCalledWith(240);
 resize.mockClear();fireEvent.keyDown(edge,{key:'Enter'});expect(resize).not.toHaveBeenCalled();
 });
