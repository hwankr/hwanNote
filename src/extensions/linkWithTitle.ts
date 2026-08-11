import Link from "@tiptap/extension-link";

export const LinkWithTitle = Link.extend({
  addAttributes() {
    return {
      ...this.parent?.(),
      title: {
        default: null,
        parseHTML: (element: HTMLElement) => element.getAttribute("title"),
        renderHTML: (attributes: { title?: string | null }) =>
          attributes.title ? { title: attributes.title } : {}
      }
    };
  }
});
