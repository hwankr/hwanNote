import { Extension } from "@tiptap/core";

export interface TabIndentOptions {
  tabSize: number;
}

export const TabIndent = Extension.create<TabIndentOptions>({
  name: "tabIndent",

  addOptions() {
    return {
      tabSize: 4
    };
  },

  addKeyboardShortcuts() {
    return {
      Tab: ({ editor }) => {
        const { $from } = editor.state.selection;

        // Let lists handle their own indentation
        for (let depth = $from.depth; depth > 0; depth--) {
          const nodeName = $from.node(depth).type.name;
          if (nodeName === "listItem" || nodeName === "taskItem") {
            return false;
          }
        }

        const spaces = " ".repeat(this.options.tabSize);
        return editor.commands.insertContent(spaces);
      },

      Backspace: ({ editor }) => {
        if (!editor.state.selection.empty) {
          return false;
        }

        const { $from } = editor.state.selection;

        // Let lists handle their own Backspace
        for (let depth = $from.depth; depth > 0; depth--) {
          const nodeName = $from.node(depth).type.name;
          if (nodeName === "listItem" || nodeName === "taskItem") {
            return false;
          }
        }

        const offsetInParent = $from.parentOffset;
        if (offsetInParent === 0) {
          return false;
        }

        // Check if all characters from line start to cursor are spaces
        const textBeforeCursor = $from.parent.textBetween(0, offsetInParent, "\0");
        if (!/^ +$/.test(textBeforeCursor)) {
          return false;
        }

        const tabSize = this.options.tabSize;
        const spacesToDelete = offsetInParent % tabSize || tabSize;

        if (spacesToDelete <= 1) {
          return false;
        }

        const { from } = editor.state.selection;
        const { tr } = editor.state;
        tr.delete(from - spacesToDelete, from);
        editor.view.dispatch(tr);

        return true;
      },

      "Shift-Tab": ({ editor }) => {
        if (!editor.state.selection.empty) {
          return false;
        }

        const { $from } = editor.state.selection;

        // Let lists handle their own outdent
        for (let depth = $from.depth; depth > 0; depth--) {
          const nodeName = $from.node(depth).type.name;
          if (nodeName === "listItem" || nodeName === "taskItem") {
            return false;
          }
        }

        // Find how many spaces to remove before cursor
        const { from } = editor.state.selection;
        const textBefore = editor.state.doc.textBetween(
          Math.max(0, from - this.options.tabSize),
          from,
          "\0"
        );

        // Count trailing spaces (up to tabSize)
        let spacesToRemove = 0;
        for (let i = textBefore.length - 1; i >= 0 && spacesToRemove < this.options.tabSize; i--) {
          if (textBefore[i] === " ") {
            spacesToRemove++;
          } else {
            break;
          }
        }

        if (spacesToRemove === 0) {
          return false;
        }

        const { tr } = editor.state;
        tr.delete(from - spacesToRemove, from);
        editor.view.dispatch(tr);

        return true;
      }
    };
  }
});
