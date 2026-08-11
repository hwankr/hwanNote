import { useCallback, useEffect, useMemo, useState } from "react";
import { confirm as confirmDialog, message } from "@tauri-apps/plugin-dialog";
import { useI18n } from "../../i18n/context";
import { formatDateKey, parseDateKey, type TodoItem } from "../../lib/calendarData";
import { type WeekStart } from "../../lib/calendarRange";
import { useNoteStore } from "../../stores/noteStore";
import { selectTodoRowsByGroup, useCalendarStore } from "../../stores/calendarStore";
import CalendarSidebar, { type CalendarSidebarMode } from "./CalendarSidebar";
import MonthGrid from "./MonthGrid";

interface CalendarPageProps {
  onNavigateToNote: (noteId: string) => void;
  weekStartsOn: WeekStart;
}

type TodoUpdateFn = (
  dateKey: string,
  todoId: string,
  updates: Partial<Pick<TodoItem, "text" | "done">>
) => void;

export default function CalendarPage({ onNavigateToNote, weekStartsOn }: CalendarPageProps) {
  const { t } = useI18n();
  const todayDateKey = formatDateKey(new Date());
  const data = useCalendarStore((s) => s.data);
  const selectedDate = useCalendarStore((s) => s.selectedDate);
  const currentMonth = useCalendarStore((s) => s.currentMonth);
  const loaded = useCalendarStore((s) => s.loaded);
  const loadState = useCalendarStore((s) => s.loadState);
  const loadError = useCalendarStore((s) => s.loadError);
  const sourcePath = useCalendarStore((s) => s.sourcePath);
  const backupPath = useCalendarStore((s) => s.backupPath);
  const loadCalendarData = useCalendarStore((s) => s.loadCalendarData);
  const resetCalendarData = useCalendarStore((s) => s.resetCalendarData);
  const setSelectedDate = useCalendarStore((s) => s.setSelectedDate);
  const setCurrentMonth = useCalendarStore((s) => s.setCurrentMonth);
  const createTodo = useCalendarStore((s) => s.createTodo);
  const toggleTodo = useCalendarStore((s) => s.toggleTodo);
  const updateTodo = useCalendarStore((s) => s.updateTodo) as TodoUpdateFn;
  const deleteTodo = useCalendarStore((s) => s.deleteTodo);
  const setTodoDueDate = useCalendarStore((s) => s.setTodoDueDate);
  const setTodoShowSpan = useCalendarStore((s) => s.setTodoShowSpan);
  const createInboxTodo = useCalendarStore((s) => s.createInboxTodo);
  const toggleInboxTodo = useCalendarStore((s) => s.toggleInboxTodo);
  const updateInboxTodo = useCalendarStore((s) => s.updateInboxTodo);
  const deleteInboxTodo = useCalendarStore((s) => s.deleteInboxTodo);
  const setInboxTodoDueDate = useCalendarStore((s) => s.setInboxTodoDueDate);

  const notesById = useNoteStore((s) => s.notesById);
  const allNotes = useNoteStore((s) => s.allNotes);

  const [sidebarMode, setSidebarMode] = useState<CalendarSidebarMode>("day");
  const [recoveryBusy, setRecoveryBusy] = useState(false);

  useEffect(() => {
    if (!loaded && loadState === "idle") {
      void loadCalendarData();
    }
  }, [loaded, loadCalendarData, loadState]);

  const handleRecoveryReload = useCallback(async () => {
    setRecoveryBusy(true);
    try {
      await loadCalendarData();
    } finally {
      setRecoveryBusy(false);
    }
  }, [loadCalendarData]);

  const handleRecoveryReset = useCallback(async () => {
    const confirmed = await confirmDialog(t("calendar.recoveryResetConfirm"), {
      title: t("calendar.recoveryResetTitle"),
      kind: "warning",
    });
    if (!confirmed) {
      return;
    }

    setRecoveryBusy(true);
    try {
      const result = await resetCalendarData();
      if (result === "blocked") {
        await message(t("calendar.recoveryResetFailed"), {
          title: t("calendar.recoveryResetFailedTitle"),
          kind: "error",
        });
      }
    } finally {
      setRecoveryBusy(false);
    }
  }, [resetCalendarData, t]);

  const handlePrevMonth = useCallback(() => {
    setCurrentMonth(new Date(currentMonth.getFullYear(), currentMonth.getMonth() - 1, 1));
  }, [currentMonth, setCurrentMonth]);

  const handleNextMonth = useCallback(() => {
    setCurrentMonth(new Date(currentMonth.getFullYear(), currentMonth.getMonth() + 1, 1));
  }, [currentMonth, setCurrentMonth]);

  const handleToday = useCallback(() => {
    const now = new Date();
    setCurrentMonth(new Date(now.getFullYear(), now.getMonth(), 1));
    setSelectedDate(formatDateKey(now));
  }, [setCurrentMonth, setSelectedDate]);

  const handleOpenDay = useCallback(
    (dateKey: string) => {
      const sourceDate = parseDateKey(dateKey);
      setSelectedDate(dateKey);
      setCurrentMonth(new Date(sourceDate.getFullYear(), sourceDate.getMonth(), 1));
      setSidebarMode("day");
    },
    [setCurrentMonth, setSelectedDate, setSidebarMode]
  );

  const handleUpdateTodo = useCallback(
    (dateKey: string, todoId: string, text: string) => {
      updateTodo(dateKey, todoId, { text });
    },
    [updateTodo]
  );

  const handleSetTodoDueDate = useCallback(
    (dateKey: string, todoId: string, dueDateKey: string | null) => {
      setTodoDueDate(dateKey, todoId, dueDateKey);
    },
    [setTodoDueDate]
  );

  const handleSetTodoShowSpan = useCallback(
    (dateKey: string, todoId: string, showSpan: boolean) => {
      setTodoShowSpan(dateKey, todoId, showSpan);
    },
    [setTodoShowSpan]
  );

  const handleUpdateInboxTodo = useCallback(
    (todoId: string, text: string) => {
      updateInboxTodo(todoId, { text });
    },
    [updateInboxTodo]
  );

  const handleSetInboxTodoDueDate = useCallback(
    (todoId: string, dueDateKey: string | null) => {
      setInboxTodoDueDate(todoId, dueDateKey);
    },
    [setInboxTodoDueDate]
  );

  const linkedNoteIds = data.noteLinks[selectedDate] ?? [];
  const pinnedNotes = useMemo(
    () =>
      allNotes.filter((note) => note.isPinned).map((note) => ({
        id: note.id,
        title: note.title,
      })),
    [allNotes]
  );

  const getNoteTitle = useCallback(
    (noteId: string) => {
      return notesById[noteId]?.title ?? noteId;
    },
    [notesById]
  );

  const groupedTodoRows = useMemo(
    () => selectTodoRowsByGroup({ data }, { todayDateKey }),
    [data, todayDateKey]
  );

  const dayTodos = data.todos[selectedDate]?.items ?? [];

  if (loadState === "idle" || loadState === "loading") {
    return (
      <div className="calendar-page calendar-recovery-page">
        <p className="calendar-recovery-loading" role="status">{t("calendar.loading")}</p>
      </div>
    );
  }

  if (loadState === "corrupt" || loadState === "load_error") {
    return (
      <div className="calendar-page calendar-recovery-page">
        <section className="calendar-recovery-card" role="alert">
          <div className="calendar-recovery-heading">
            <span className="calendar-recovery-icon" aria-hidden="true">!</span>
            <div>
              <h2>{t("calendar.recoveryTitle")}</h2>
              <p>{t("calendar.recoveryDescription")}</p>
            </div>
          </div>

          <dl className="calendar-recovery-details">
            {sourcePath && (
              <div>
                <dt>{t("calendar.recoverySource")}</dt>
                <dd>{sourcePath}</dd>
              </div>
            )}
            {backupPath && (
              <div>
                <dt>{t("calendar.recoveryBackup")}</dt>
                <dd>{backupPath}</dd>
              </div>
            )}
            {loadError && (
              <div>
                <dt>{t("calendar.recoveryError")}</dt>
                <dd>{loadError}</dd>
              </div>
            )}
          </dl>

          <div className="calendar-recovery-actions">
            <button type="button" onClick={() => void handleRecoveryReload()} disabled={recoveryBusy}>
              {t("calendar.recoveryReload")}
            </button>
            {loadState === "corrupt" && (
              <button
                type="button"
                className="calendar-recovery-reset"
                onClick={() => void handleRecoveryReset()}
                disabled={recoveryBusy}
              >
                {t("calendar.recoveryReset")}
              </button>
            )}
          </div>
        </section>
      </div>
    );
  }

  return (
    <div className="calendar-page">
      <MonthGrid
        currentMonth={currentMonth}
        selectedDate={selectedDate}
        data={data}
        onSelectDate={setSelectedDate}
        onOpenDay={handleOpenDay}
        onPrevMonth={handlePrevMonth}
        onNextMonth={handleNextMonth}
        onToday={handleToday}
      />
      <CalendarSidebar
        selectedDate={selectedDate}
        todayDateKey={todayDateKey}
        mode={sidebarMode}
        onModeChange={setSidebarMode}
        data={data}
        weekStartsOn={weekStartsOn}
        dayTodos={dayTodos}
        groupedTodoRows={groupedTodoRows}
        linkedNoteIds={linkedNoteIds}
        onNavigateToNote={onNavigateToNote}
        noteTitle={getNoteTitle}
        pinnedNotes={pinnedNotes}
        onCreateTodo={createTodo}
        onToggleTodo={toggleTodo}
        onUpdateTodo={handleUpdateTodo}
        onDeleteTodo={deleteTodo}
        onOpenDay={handleOpenDay}
        onSetTodoDueDate={handleSetTodoDueDate}
        onSetTodoShowSpan={handleSetTodoShowSpan}
        onCreateInboxTodo={createInboxTodo}
        onToggleInboxTodo={toggleInboxTodo}
        onUpdateInboxTodo={handleUpdateInboxTodo}
        onDeleteInboxTodo={deleteInboxTodo}
        onSetInboxTodoDueDate={handleSetInboxTodoDueDate}
      />
    </div>
  );
}
