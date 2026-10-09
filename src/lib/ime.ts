/** IME confirmation keys can report keyCode 229 after isComposing turns false. */
export function isImeComposing(event: { isComposing?: boolean; keyCode?: number }): boolean {
  return event.isComposing === true || event.keyCode === 229;
}
