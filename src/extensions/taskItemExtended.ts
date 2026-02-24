import TaskItem from "@tiptap/extension-task-item";
import { TextSelection } from "@tiptap/pm/state";

export const TaskItemExtended = TaskItem.extend({
  addKeyboardShortcuts() {
    const findNodeDepth = (from: { depth: number; node: (depth: number) => { type: { name: string } } }, nodeName: string) => {
      for (let depth = from.depth; depth >= 0; depth -= 1) {
        if (from.node(depth).type.name === nodeName) {
          return depth;
        }
      }
      return -1;
    };

    return {
      ...this.parent?.(),

      Backspace: () => {
        const { state } = this.editor;
        const { selection } = state;
        const { $from } = selection;

        if (!selection.empty) {
          return false;
        }

        if ($from.parent.type.name !== "paragraph") {
          return false;
        }

        if ($from.parentOffset !== 0) {
          return false;
        }

        if ($from.parent.textContent.length !== 0) {
          return false;
        }

        const taskItemDepth = findNodeDepth($from, "taskItem");
        if (taskItemDepth === -1) {
          return false;
        }

        const taskItemPos = taskItemDepth === 0 ? 0 : $from.before(taskItemDepth);
        const taskItemNode = state.doc.nodeAt(taskItemPos);
        if (!taskItemNode) {
          return false;
        }

        if (taskItemNode.childCount > 1) {
          return false;
        }

        const taskListDepth = findNodeDepth($from, "taskList");
        if (taskListDepth === -1) {
          return false;
        }

        const taskListPos = taskListDepth === 0 ? 0 : $from.before(taskListDepth);
        const taskListNode = state.doc.nodeAt(taskListPos);
        if (!taskListNode) {
          return false;
        }

        if (taskListNode.childCount > 1) {
          const tr = state.tr.delete(taskItemPos, taskItemPos + taskItemNode.nodeSize);
          tr.setSelection(TextSelection.near(tr.doc.resolve(Math.max(0, taskItemPos)), -1));
          tr.scrollIntoView();
          this.editor.view.dispatch(tr);
          this.editor.view.focus();
          return true;
        }

        if (taskListNode.childCount === 1) {
          const { paragraph } = state.schema.nodes;
          const tr = state.tr.replaceWith(taskListPos, taskListPos + taskListNode.nodeSize, paragraph.create());
          tr.setSelection(TextSelection.near(tr.doc.resolve(taskListPos + 1), 1));
          tr.scrollIntoView();
          this.editor.view.dispatch(tr);
          this.editor.view.focus();
          return true;
        }

        return false;
      }
    };
  }
});
