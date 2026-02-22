import { Node, mergeAttributes } from "@tiptap/core";
import { Plugin, PluginKey, TextSelection } from "@tiptap/pm/state";
import { EditorView } from "@tiptap/pm/view";

declare module "@tiptap/core" {
  interface Commands<ReturnType> {
    toggleBlock: {
      insertToggleBlock: (title?: string) => ReturnType;
    };
  }
}

export const ToggleSummary = Node.create({
  name: "toggleSummary",
  content: "inline*",
  defining: true,

  parseHTML() {
    return [{ tag: "summary" }];
  },

  renderHTML({ HTMLAttributes }) {
    return ["summary", mergeAttributes(HTMLAttributes), 0];
  },

  addKeyboardShortcuts() {
    const findNodeDepth = (from: { depth: number; node: (depth: number) => { type: { name: string } } }, nodeName: string) => {
      for (let depth = from.depth; depth >= 0; depth -= 1) {
        if (from.node(depth).type.name === nodeName) {
          return depth;
        }
      }
      return -1;
    };

    const isNodeEffectivelyEmpty = (node: { isText: boolean; text?: string; isLeaf: boolean; childCount: number; child: (index: number) => unknown; textContent: string }) => {
      if (node.isText) {
        return (node.text ?? "").trim().length === 0;
      }

      if (node.isLeaf) {
        return false;
      }

      if (!node.textContent.trim()) {
        for (let i = 0; i < node.childCount; i += 1) {
          const child = node.child(i) as {
            isText: boolean;
            text?: string;
            isLeaf: boolean;
            childCount: number;
            child: (index: number) => unknown;
            textContent: string;
          };
          if (!isNodeEffectivelyEmpty(child)) {
            return false;
          }
        }
        return true;
      }

      return false;
    };

    return {
      Enter: () => {
        const { state, schema } = this.editor;
        const { $from } = state.selection;

        const summaryDepth = findNodeDepth($from, this.type.name);
        if (summaryDepth === -1) {
          return false;
        }

        const toggleBlockDepth = findNodeDepth($from, "toggleBlock");
        if (toggleBlockDepth === -1) {
          return false;
        }

        const toggleBlockPos = toggleBlockDepth === 0 ? 0 : $from.before(toggleBlockDepth);
        const tr = state.tr;
        const toggleBlockNode = tr.doc.nodeAt(toggleBlockPos);
        if (!toggleBlockNode || toggleBlockNode.type.name !== "toggleBlock" || toggleBlockNode.childCount < 2) {
          return false;
        }

        if (!toggleBlockNode.attrs.open) {
          tr.setNodeMarkup(toggleBlockPos, toggleBlockNode.type, {
            ...toggleBlockNode.attrs,
            open: true
          });
        }

        const summarySize = toggleBlockNode.child(0).nodeSize;
        const toggleContentPos = toggleBlockPos + 1 + summarySize;
        const toggleContentNode = tr.doc.nodeAt(toggleContentPos);
        if (!toggleContentNode || toggleContentNode.type.name !== "toggleContent") {
          return false;
        }

        if (toggleContentNode.childCount === 0) {
          const paragraph = schema.nodes.paragraph;
          if (!paragraph) {
            return false;
          }
          tr.insert(toggleContentPos + 1, paragraph.create());
        }

        const cursorPos = Math.max(0, Math.min(toggleContentPos + 1, tr.doc.content.size));
        tr.setSelection(TextSelection.near(tr.doc.resolve(cursorPos), 1));
        tr.scrollIntoView();

        this.editor.view.dispatch(tr);
        this.editor.view.focus();
        return true;
      },

      Backspace: () => {
        const { state } = this.editor;
        const { selection } = state;
        const { $from } = selection;

        if (!selection.empty || $from.parent.type !== this.type || $from.parentOffset !== 0) {
          return false;
        }

        const summaryDepth = findNodeDepth($from, this.type.name);
        if (summaryDepth === -1) {
          return false;
        }

        const toggleBlockDepth = findNodeDepth($from, "toggleBlock");
        if (toggleBlockDepth === -1) {
          return false;
        }

        const toggleBlockPos = toggleBlockDepth === 0 ? 0 : $from.before(toggleBlockDepth);
        const toggleBlockNode = state.doc.nodeAt(toggleBlockPos);
        if (!toggleBlockNode || toggleBlockNode.type.name !== "toggleBlock" || toggleBlockNode.childCount < 2) {
          return false;
        }

        const summaryNode = toggleBlockNode.child(0);
        const toggleContentNode = toggleBlockNode.child(1);
        if (summaryNode.type.name !== "toggleSummary" || toggleContentNode.type.name !== "toggleContent") {
          return false;
        }

        const isSummaryEmpty = summaryNode.textContent.trim().length === 0;
        const isContentEmpty = isNodeEffectivelyEmpty(toggleContentNode as unknown as {
          isText: boolean;
          text?: string;
          isLeaf: boolean;
          childCount: number;
          child: (index: number) => unknown;
          textContent: string;
        });

        if (!isSummaryEmpty || !isContentEmpty) {
          return false;
        }

        const tr = state.tr.delete(toggleBlockPos, toggleBlockPos + toggleBlockNode.nodeSize).scrollIntoView();
        this.editor.view.dispatch(tr);
        this.editor.view.focus();
        return true;
      }
    };
  }
});

export const ToggleContent = Node.create({
  name: "toggleContent",
  content: "block*",
  defining: true,

  parseHTML() {
    return [{ tag: 'div[data-type="toggleContent"]' }];
  },

  renderHTML({ HTMLAttributes }) {
    return ["div", mergeAttributes(HTMLAttributes, { "data-type": "toggleContent" }), 0];
  }
});

export const ToggleBlock = Node.create({
  name: "toggleBlock",
  group: "block",
  content: "toggleSummary toggleContent",
  defining: true,
  isolating: true,

  addAttributes() {
    return {
      open: {
        default: true,
        parseHTML: (element: HTMLElement) => element.hasAttribute("open"),
        renderHTML: (attributes: { open?: boolean }) => (attributes.open ? { open: "open" } : {})
      }
    };
  },

  parseHTML() {
    return [{ tag: 'details[data-type="toggleBlock"]' }, { tag: "details" }];
  },

  renderHTML({ HTMLAttributes }) {
    return ["details", mergeAttributes(HTMLAttributes, { "data-type": "toggleBlock" }), 0];
  },

  addCommands() {
    return {
      insertToggleBlock:
        (title = "Toggle") =>
        ({ commands }) =>
          commands.insertContent({
            type: this.name,
            attrs: { open: true },
            content: [
              {
                type: "toggleSummary",
                content: title ? [{ type: "text", text: title }] : []
              },
              {
                type: "toggleContent",
                content: [{ type: "paragraph" }]
              }
            ]
          })
    };
  },

  addProseMirrorPlugins() {
    const findToggleBlockNode = (view: EditorView, element: HTMLElement) => {
      const pos = view.posAtDOM(element, 0);
      const resolved = view.state.doc.resolve(Math.max(0, Math.min(pos, view.state.doc.content.size)));

      for (let depth = resolved.depth; depth >= 0; depth -= 1) {
        const currentNode = resolved.node(depth);
        if (currentNode.type !== this.type) {
          continue;
        }

        return {
          nodePos: depth === 0 ? 0 : resolved.before(depth),
          nodeAttrs: currentNode.attrs as Record<string, unknown>
        };
      }

      return null;
    };

    const getTargetElement = (target: EventTarget | null) => {
      if (target instanceof Element) {
        return target;
      }

      if (target && typeof target === "object" && "parentElement" in target) {
        return (target as { parentElement: Element | null }).parentElement;
      }

      return null;
    };

    const isSummaryTextClick = (summary: HTMLElement, event: MouseEvent) => {
      const range = document.createRange();
      range.selectNodeContents(summary);
      const rects = Array.from(range.getClientRects()).filter((rect) => rect.width > 0 && rect.height > 0);

      return rects.some(
        (rect) =>
          event.clientX >= rect.left &&
          event.clientX <= rect.right &&
          event.clientY >= rect.top &&
          event.clientY <= rect.bottom
      );
    };

    return [
      new Plugin({
        key: new PluginKey("toggleBlockOpenState"),
        props: {
          handleDOMEvents: {
            click: (view, event) => {
              if (!(event instanceof MouseEvent)) {
                return false;
              }

              const targetElement = getTargetElement(event.target);
              const summary = targetElement?.closest("summary");
              if (!summary) {
                return false;
              }

              const details = summary.parentElement;
              if (!(details instanceof HTMLDetailsElement) || details.dataset.type !== "toggleBlock") {
                return false;
              }

              event.preventDefault();

              const found = findToggleBlockNode(view, details);
              if (!found) {
                return false;
              }

              if (isSummaryTextClick(summary, event)) {
                const coords = view.posAtCoords({
                  left: event.clientX,
                  top: event.clientY
                });

                view.focus();

                if (coords) {
                  const safePos = Math.max(0, Math.min(coords.pos, view.state.doc.content.size));
                  view.dispatch(view.state.tr.setSelection(TextSelection.create(view.state.doc, safePos)));
                }

                return true;
              }

              view.dispatch(
                view.state.tr.setNodeMarkup(found.nodePos, this.type, {
                  ...found.nodeAttrs,
                  open: !Boolean(found.nodeAttrs.open)
                })
              );
              return true;
            },
            toggle: (view, event) => {
              const target = event.target;
              if (!(target instanceof HTMLDetailsElement)) {
                return false;
              }

              if (target.dataset.type !== "toggleBlock") {
                return false;
              }

              const found = findToggleBlockNode(view, target);
              if (!found) {
                return false;
              }

              if (Boolean(found.nodeAttrs.open) === target.open) {
                return false;
              }

              view.dispatch(
                view.state.tr.setNodeMarkup(found.nodePos, this.type, {
                  ...found.nodeAttrs,
                  open: target.open
                })
              );
              return false;
            }
          }
        }
      })
    ];
  }
});
