// Focus ownership is intent-based, not a completion timer. Once the user moves
// elsewhere, a background response must not steal it back.
export function createComposerFocus(getComposer: () => HTMLTextAreaElement | null, isBlocked: () => boolean) {
  let owned = false;
  const onPointer = (event: PointerEvent) => {
    owned = event.target === getComposer();
  };
  const onFocus = (event: FocusEvent) => {
    if (event.target === getComposer()) owned = true;
    else if (event.target !== document.body) owned = false;
  };
  const onKey = (event: KeyboardEvent) => { if (event.key === "Tab") owned = false; };
  const onSelection = () => { if (!window.getSelection()?.isCollapsed) owned = false; };
  const onBlur = () => { owned = false; };
  const restore = () => {
    const composer = getComposer();
    if (!owned || !composer || isBlocked() || !document.hasFocus() || !window.getSelection()?.isCollapsed) return;
    if (document.activeElement !== composer) composer.focus({ preventScroll: true });
  };
  return {
    restore,
    claim() { owned = true; restore(); },
    release() { owned = false; },
    connect() {
      document.addEventListener("pointerdown", onPointer, true);
      document.addEventListener("focusin", onFocus, true);
      document.addEventListener("keydown", onKey, true);
      document.addEventListener("selectionchange", onSelection);
      window.addEventListener("blur", onBlur);
      return () => {
        document.removeEventListener("pointerdown", onPointer, true);
        document.removeEventListener("focusin", onFocus, true);
        document.removeEventListener("keydown", onKey, true);
        document.removeEventListener("selectionchange", onSelection);
        window.removeEventListener("blur", onBlur);
      };
    }
  };
}
