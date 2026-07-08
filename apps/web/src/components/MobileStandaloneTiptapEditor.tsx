import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { EditorContent, useEditor } from "@tiptap/react";
import StarterKit from "@tiptap/starter-kit";
import Image from "@tiptap/extension-image";
import Placeholder from "@tiptap/extension-placeholder";
import { docToMarkdown, emptyDoc, type MemoDetail, type Notebook, type TiptapDoc } from "@edgeever/shared";
import {
  MobileEditorFallback,
  MobileEditorHeader,
  MobileEditorNotebookButton,
  MobileEditorNotebookSheet,
  MobileEditorToolbar,
} from "@/components/MobileStandaloneEditorParts";
import { getNotebookMoveOptions } from "@/lib/app-helpers";
import { compressImageForUpload } from "@/lib/image-compression";
import { localDb, type LocalDraft } from "@/lib/local-db";
import {
  DEFAULT_MOBILE_EDITOR_MEMO_TITLE,
  MOBILE_EDITOR_AUTO_SAVE_DELAY_MS,
  MOBILE_EDITOR_INITIAL_FOCUS_DELAY_MS,
  MOBILE_EDITOR_LEAVE_SAVE_TIMEOUT_MS,
  getMobileEditorDraftKey,
  getMobileEditorParams,
  getMobileEditorSaveLabel,
  getMobileEditorStatusClassName,
  normalizeMobileEditorDoc,
  parseMobileEditorTags,
  requestMobileEditorJson,
  safeMobileEditorReturnPath,
  uploadMobileEditorResource,
  type MobileEditorDraft,
  type MobileEditorMemoResponse,
  type MobileEditorSaveState,
} from "@/lib/mobile-editor-standalone";
import { getMemoUpdateQueueId, queueMemoUpdate, shouldQueueMemoSaveError, syncQueuedChanges } from "@/lib/sync-queue";

type ListNotebooksResponse = {
  notebooks: Notebook[];
};

type MobileStandaloneTiptapEditorProps = {
  memoId?: string | null;
  returnTo?: string;
  onLeave?: () => void;
};

export const MobileStandaloneTiptapEditor = ({
  memoId: memoIdProp,
  returnTo: returnToProp,
  onLeave,
}: MobileStandaloneTiptapEditorProps = {}) => {
  const params = useMemo(() => getMobileEditorParams(), []);
  const memoId = memoIdProp ?? params.get("memoId");
  const returnTo = safeMobileEditorReturnPath(returnToProp ?? params.get("returnTo"));
  const draftKey = getMobileEditorDraftKey(memoId);
  const [memo, setMemo] = useState<MemoDetail | null>(null);
  const memoRef = useRef<MemoDetail | null>(null);
  const [notebooks, setNotebooks] = useState<Notebook[]>([]);
  const [notebookUpdatePending, setNotebookUpdatePending] = useState(false);
  const [notebookSheetOpen, setNotebookSheetOpen] = useState(false);
  const [title, setTitle] = useState("");
  const titleRef = useRef("");
  const [tagsText, setTagsText] = useState("");
  const tagsTextRef = useRef("");
  const contentJsonRef = useRef<TiptapDoc>(emptyDoc());
  const [saveState, setSaveState] = useState<MobileEditorSaveState>("loading");
  const saveStateRef = useRef<MobileEditorSaveState>("loading");
  const [error, setError] = useState<string | null>(null);
  const notebookOptions = useMemo(() => getNotebookMoveOptions(notebooks), [notebooks]);
  const [, setToolbarVersion] = useState(0);
  const dirtyRef = useRef(false);
  const leavingRef = useRef(false);
  const savingRef = useRef(false);
  const saveTimerRef = useRef<number | null>(null);
  const initialFocusTimerRef = useRef<number | null>(null);
  const currentSavePromiseRef = useRef<Promise<boolean> | null>(null);
  const lastSavedSnapshotRef = useRef("");
  const backgroundSavePendingRef = useRef(false);
  const imageInputRef = useRef<HTMLInputElement | null>(null);

  const setSaveStateStable = useCallback((nextState: MobileEditorSaveState) => {
    if (saveStateRef.current === nextState) {
      return;
    }

    saveStateRef.current = nextState;
    setSaveState(nextState);
  }, []);

  const currentSnapshot = useCallback(
    () =>
      JSON.stringify({
        title: titleRef.current,
        tagsText: tagsTextRef.current,
        contentJson: contentJsonRef.current,
      }),
    []
  );

  const persistLocalDraft = useCallback(() => {
    if (!draftKey) {
      return;
    }

    const currentMemo = memoRef.current;
    const draft: MobileEditorDraft = {
      expectedRevision: currentMemo?.revision,
      title: titleRef.current,
      tagsText: tagsTextRef.current,
      contentJson: contentJsonRef.current,
      updatedAt: new Date().toISOString(),
    };
    localStorage.setItem(draftKey, JSON.stringify(draft));

    if (!currentMemo || currentMemo.isDeleted) {
      return;
    }

    void localDb.drafts.put({
      memoId: currentMemo.id,
      expectedRevision: currentMemo.revision,
      title: draft.title,
      tagsText: draft.tagsText,
      contentJson: draft.contentJson,
      updatedAt: draft.updatedAt,
    });
    void queueMemoUpdate({
      memoId: currentMemo.id,
      expectedRevision: currentMemo.revision,
      title: draft.title,
      contentJson: draft.contentJson,
      tags: parseMobileEditorTags(draft.tagsText),
    });
  }, [draftKey]);

  const readLocalDraft = useCallback((): MobileEditorDraft | null => {
    if (!draftKey) {
      return null;
    }

    try {
      const raw = localStorage.getItem(draftKey);
      return raw ? (JSON.parse(raw) as MobileEditorDraft) : null;
    } catch {
      return null;
    }
  }, [draftKey]);

  const readBestLocalDraft = useCallback(async (): Promise<MobileEditorDraft | null> => {
    const browserDraft = readLocalDraft();
    const persistedDraft = memoId ? await localDb.drafts.get(memoId).catch(() => null) : null;
    const drafts = [browserDraft, persistedDraft].filter(Boolean) as Array<MobileEditorDraft | LocalDraft>;

    if (drafts.length === 0) {
      return null;
    }

    const latest = drafts.reduce((current, candidate) =>
      Date.parse(candidate.updatedAt || "") > Date.parse(current.updatedAt || "") ? candidate : current
    );

    return {
      expectedRevision: latest.expectedRevision,
      title: latest.title,
      tagsText: latest.tagsText,
      contentJson: latest.contentJson,
      updatedAt: latest.updatedAt,
    };
  }, [memoId, readLocalDraft]);

  const editor = useEditor({
    extensions: [
      StarterKit,
      Image.configure({
        allowBase64: false,
        inline: false,
      }),
      Placeholder.configure({
        placeholder: "开始记录...",
      }),
    ],
    content: emptyDoc(),
    editorProps: {
      attributes: {
        class: "edgeever-mobile-tiptap-content",
        autocapitalize: "sentences",
        autocomplete: "on",
        autocorrect: "on",
        inputmode: "text",
        spellcheck: "true",
      },
    },
    onUpdate: ({ editor: activeEditor }) => {
      contentJsonRef.current = activeEditor.getJSON() as TiptapDoc;
      dirtyRef.current = true;
      persistLocalDraft();

      if (saveStateRef.current !== "dirty") {
        setSaveStateStable("dirty");
      }

      if (saveTimerRef.current !== null) {
        window.clearTimeout(saveTimerRef.current);
      }
      saveTimerRef.current = window.setTimeout(() => {
        saveTimerRef.current = null;
        void saveNowRef.current();
      }, MOBILE_EDITOR_AUTO_SAVE_DELAY_MS);
    },
  });

  const saveNowRef = useRef<({ keepalive }?: { keepalive?: boolean }) => Promise<boolean>>(async () => false);

  useEffect(() => {
    if (!editor) {
      return;
    }

    const refreshToolbar = () => setToolbarVersion((version) => version + 1);

    editor.on("selectionUpdate", refreshToolbar);
    editor.on("transaction", refreshToolbar);
    editor.on("focus", refreshToolbar);
    editor.on("blur", refreshToolbar);

    return () => {
      editor.off("selectionUpdate", refreshToolbar);
      editor.off("transaction", refreshToolbar);
      editor.off("focus", refreshToolbar);
      editor.off("blur", refreshToolbar);
    };
  }, [editor]);

  useEffect(() => {
    memoRef.current = memo;
  }, [memo]);

  useEffect(() => {
    titleRef.current = title;
  }, [title]);

  useEffect(() => {
    tagsTextRef.current = tagsText;
  }, [tagsText]);

  const clearPersistedDrafts = useCallback(async (memoId: string) => {
    if (draftKey) {
      localStorage.removeItem(draftKey);
    }

    await Promise.all([
      localDb.drafts.delete(memoId),
      localDb.syncQueue.delete(getMemoUpdateQueueId(memoId)),
    ]);
  }, [draftKey]);

  const buildSavePayload = useCallback((currentMemo: MemoDetail) => ({
    expectedRevision: currentMemo.revision,
    title: titleRef.current,
    contentJson: contentJsonRef.current,
    tags: parseMobileEditorTags(tagsTextRef.current),
  }), []);

  const applySavedMemo = useCallback(async (savedMemo: MemoDetail, savedSnapshot: string) => {
    memoRef.current = savedMemo;
    setMemo(savedMemo);
    backgroundSavePendingRef.current = false;
    lastSavedSnapshotRef.current = savedSnapshot;

    if (currentSnapshot() === savedSnapshot) {
      dirtyRef.current = false;
      await clearPersistedDrafts(savedMemo.id);
      setSaveStateStable("saved");
      window.setTimeout(() => {
        if (!dirtyRef.current && !savingRef.current && !leavingRef.current) {
          setSaveStateStable("idle");
        }
      }, 1200);
      return;
    }

    dirtyRef.current = true;
    persistLocalDraft();
    setSaveStateStable("dirty");
  }, [clearPersistedDrafts, currentSnapshot, persistLocalDraft, setSaveStateStable]);

  const sendBackgroundSave = useCallback(() => {
    const currentMemo = memoRef.current;
    if (!currentMemo || currentMemo.isDeleted || !dirtyRef.current) {
      return false;
    }

    const path = `/api/v1/memos/${encodeURIComponent(currentMemo.id)}/save`;
    const body = JSON.stringify(buildSavePayload(currentMemo));
    const snapshot = currentSnapshot();

    if (typeof navigator.sendBeacon === "function") {
      const accepted = navigator.sendBeacon(path, new Blob([body], { type: "application/json" }));

      if (accepted) {
        backgroundSavePendingRef.current = true;
        void Promise.all([
          localDb.drafts.delete(currentMemo.id),
          localDb.syncQueue.delete(getMemoUpdateQueueId(currentMemo.id)),
        ]);
        return true;
      }
    }

    void requestMobileEditorJson<MobileEditorMemoResponse>(path, {
      method: "POST",
      keepalive: true,
      body,
    })
      .then((data) => applySavedMemo(data.memo, snapshot))
      .catch(() => {
        persistLocalDraft();
        setSaveStateStable("local-draft");
      });

    return true;
  }, [applySavedMemo, buildSavePayload, currentSnapshot, persistLocalDraft, setSaveStateStable]);

  const reconcileBackgroundSave = useCallback(async () => {
    const currentMemo = memoRef.current;
    if (!currentMemo || !backgroundSavePendingRef.current) {
      return;
    }

    try {
      const data = await requestMobileEditorJson<MobileEditorMemoResponse>(`/api/v1/memos/${encodeURIComponent(currentMemo.id)}`);
      const remoteSnapshot = JSON.stringify({
        title: data.memo.title || "",
        tagsText: Array.isArray(data.memo.tags) ? data.memo.tags.join(", ") : "",
        contentJson: normalizeMobileEditorDoc(data.memo),
      });

      memoRef.current = data.memo;
      setMemo(data.memo);
      backgroundSavePendingRef.current = false;

      if (remoteSnapshot === currentSnapshot()) {
        lastSavedSnapshotRef.current = remoteSnapshot;
        dirtyRef.current = false;
        await clearPersistedDrafts(data.memo.id);
        setSaveStateStable("saved");
        return;
      }

      dirtyRef.current = true;
      persistLocalDraft();
      void saveNowRef.current();
    } catch {
      persistLocalDraft();
      setSaveStateStable("local-draft");
    }
  }, [clearPersistedDrafts, currentSnapshot, persistLocalDraft, setSaveStateStable]);

  const saveNow = useCallback(
    async ({ keepalive = false }: { keepalive?: boolean } = {}) => {
      const currentMemo = memoRef.current;
      if (!currentMemo) {
        return false;
      }

      if (savingRef.current) {
        return currentSavePromiseRef.current ?? false;
      }

      const snapshot = currentSnapshot();
      if (!dirtyRef.current && snapshot === lastSavedSnapshotRef.current) {
        return true;
      }

      if (saveTimerRef.current !== null) {
        window.clearTimeout(saveTimerRef.current);
        saveTimerRef.current = null;
      }

      savingRef.current = true;
      setSaveStateStable("saving");
      setError(null);

      currentSavePromiseRef.current = (async () => {
        const data = await requestMobileEditorJson<MobileEditorMemoResponse>(`/api/v1/memos/${encodeURIComponent(currentMemo.id)}`, {
          method: "PATCH",
          keepalive,
          body: JSON.stringify(buildSavePayload(currentMemo)),
        });

        await applySavedMemo(data.memo, snapshot);
        return true;
      })();

      try {
        return await currentSavePromiseRef.current;
      } catch (saveError) {
        persistLocalDraft();
        if (shouldQueueMemoSaveError(saveError)) {
          setError(null);
          setSaveStateStable("local-draft");
          return true;
        }

        setError(saveError instanceof Error ? saveError.message : "保存失败，已保留本地草稿");
        setSaveStateStable("error");
        return false;
      } finally {
        savingRef.current = false;
        currentSavePromiseRef.current = null;
      }
    },
    [applySavedMemo, buildSavePayload, currentSnapshot, persistLocalDraft, setSaveStateStable]
  );

  useEffect(() => {
    saveNowRef.current = saveNow;
  }, [saveNow]);

  const scheduleMetadataSave = useCallback(() => {
    dirtyRef.current = true;
    persistLocalDraft();
    setSaveStateStable("dirty");

    if (saveTimerRef.current !== null) {
      window.clearTimeout(saveTimerRef.current);
    }
    saveTimerRef.current = window.setTimeout(() => {
      saveTimerRef.current = null;
      void saveNow();
    }, MOBILE_EDITOR_AUTO_SAVE_DELAY_MS);
  }, [persistLocalDraft, saveNow, setSaveStateStable]);

  const navigateBack = useCallback(() => {
    if (onLeave) {
      onLeave();
      return;
    }

    window.location.replace(returnTo);
  }, [onLeave, returnTo]);

  const leavePage = useCallback(async () => {
    if (leavingRef.current) {
      return;
    }

    leavingRef.current = true;
    persistLocalDraft();
    if (saveTimerRef.current !== null) {
      window.clearTimeout(saveTimerRef.current);
      saveTimerRef.current = null;
    }
    setSaveStateStable("leaving");

    await Promise.race([
      saveNow({ keepalive: true }),
      new Promise((resolve) => window.setTimeout(resolve, MOBILE_EDITOR_LEAVE_SAVE_TIMEOUT_MS)),
    ]);
    navigateBack();
  }, [navigateBack, persistLocalDraft, saveNow, setSaveStateStable]);

  const handleTitleChange = (nextTitle: string) => {
    setTitle(nextTitle);
    titleRef.current = nextTitle;
    scheduleMetadataSave();
  };

  const handleTagsChange = (nextTagsText: string) => {
    setTagsText(nextTagsText);
    tagsTextRef.current = nextTagsText;
    scheduleMetadataSave();
  };

  const handleNotebookChange = async (nextNotebookId: string) => {
    const currentMemo = memoRef.current;
    if (!currentMemo || !nextNotebookId || nextNotebookId === currentMemo.notebookId || notebookUpdatePending) {
      return;
    }

    setNotebookUpdatePending(true);
    setSaveStateStable("saving");
    setError(null);

    try {
      if (dirtyRef.current) {
        const saved = await saveNow();
        if (!saved) {
          return;
        }
      }

      const sourceMemo = memoRef.current;
      if (!sourceMemo || nextNotebookId === sourceMemo.notebookId) {
        return;
      }

      const data = await requestMobileEditorJson<MobileEditorMemoResponse>(`/api/v1/memos/${encodeURIComponent(sourceMemo.id)}`, {
        method: "PATCH",
        body: JSON.stringify({
          expectedRevision: sourceMemo.revision,
          notebookId: nextNotebookId,
        }),
      });

      memoRef.current = data.memo;
      setMemo(data.memo);
      setSaveStateStable("saved");
      window.setTimeout(() => {
        if (!dirtyRef.current && !savingRef.current && !leavingRef.current) {
          setSaveStateStable("idle");
        }
      }, 1200);
    } catch (notebookError) {
      setError(notebookError instanceof Error ? notebookError.message : "切换笔记本失败");
      setSaveStateStable("error");
    } finally {
      setNotebookUpdatePending(false);
      setNotebookSheetOpen(false);
    }
  };

  const handleImageUpload = async (file?: File | null) => {
    const currentMemo = memoRef.current;
    if (!currentMemo || !editor || !file) {
      return;
    }

    setError(null);
    setSaveStateStable("compressing");

    try {
      const uploadFile = (await compressImageForUpload(file)).file;
      setSaveStateStable("uploading");
      const { resource } = await uploadMobileEditorResource(currentMemo.id, uploadFile);
      editor
        .chain()
        .focus()
        .setImage({
          src: resource.url,
          alt: file.name,
          title: file.name,
        })
        .run();
    } catch (uploadError) {
      setError(uploadError instanceof Error ? uploadError.message : "图片上传失败");
      setSaveStateStable("error");
    }
  };

  const focusEditorAfterLoad = useCallback(() => {
    if (!editor) {
      return;
    }

    if (initialFocusTimerRef.current !== null) {
      window.clearTimeout(initialFocusTimerRef.current);
    }

    initialFocusTimerRef.current = window.setTimeout(() => {
      initialFocusTimerRef.current = null;

      if (leavingRef.current || editor.isDestroyed) {
        return;
      }

      const activeElement = document.activeElement;
      if (activeElement && activeElement !== document.body && activeElement !== document.documentElement) {
        return;
      }

      editor.commands.focus("end");
    }, MOBILE_EDITOR_INITIAL_FOCUS_DELAY_MS);
  }, [editor]);

  useEffect(() => {
    let cancelled = false;

    void requestMobileEditorJson<ListNotebooksResponse>("/api/v1/notebooks")
      .then((data) => {
        if (!cancelled) {
          setNotebooks(data.notebooks);
        }
      })
      .catch(() => {
        if (!cancelled) {
          setNotebooks([]);
        }
      });

    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    if (!memoId || !editor) {
      if (!memoId) {
        setError("缺少 memoId");
        setSaveStateStable("error");
      }
      return;
    }

    let cancelled = false;

    void (async () => {
      try {
        const data = await requestMobileEditorJson<MobileEditorMemoResponse>(`/api/v1/memos/${encodeURIComponent(memoId)}`);
        if (cancelled) {
          return;
        }

        const nextTitle = data.memo.title || "";
        const nextTagsText = Array.isArray(data.memo.tags) ? data.memo.tags.join(", ") : "";
        const nextContentJson = normalizeMobileEditorDoc(data.memo);
        const draft = await readBestLocalDraft();
        const queuedUpdate = await localDb.syncQueue.get(getMemoUpdateQueueId(data.memo.id));
        const useDraft = Boolean(draft && (queuedUpdate || Date.parse(draft.updatedAt || "") >= Date.parse(data.memo.updatedAt || "")));

        setMemo(data.memo);

        if (useDraft && draft) {
          setTitle(draft.title || "");
          titleRef.current = draft.title || "";
          setTagsText(draft.tagsText || "");
          tagsTextRef.current = draft.tagsText || "";
          contentJsonRef.current = draft.contentJson || emptyDoc();
          editor.commands.setContent(contentJsonRef.current, { emitUpdate: false });
          dirtyRef.current = true;
          setSaveStateStable("local-draft");
          scheduleMetadataSave();
          focusEditorAfterLoad();
        } else {
          setTitle(nextTitle);
          titleRef.current = nextTitle;
          setTagsText(nextTagsText);
          tagsTextRef.current = nextTagsText;
          contentJsonRef.current = nextContentJson;
          editor.commands.setContent(nextContentJson, { emitUpdate: false });
          lastSavedSnapshotRef.current = JSON.stringify({
            title: nextTitle,
            tagsText: nextTagsText,
            contentJson: nextContentJson,
          });
          dirtyRef.current = false;
          setSaveStateStable("idle");
          focusEditorAfterLoad();
        }
      } catch (loadError) {
        if (cancelled) {
          return;
        }
        setError(loadError instanceof Error ? loadError.message : "加载失败");
        setSaveStateStable("error");
      }
    })();

    return () => {
      cancelled = true;
      if (initialFocusTimerRef.current !== null) {
        window.clearTimeout(initialFocusTimerRef.current);
        initialFocusTimerRef.current = null;
      }
    };
  }, [editor, focusEditorAfterLoad, memoId, readBestLocalDraft, scheduleMetadataSave, setSaveStateStable]);

  useEffect(() => {
    window.history.replaceState({ edgeeverMobileEditor: true }, "");
    window.history.pushState({ edgeeverMobileEditorBackGuard: true }, "");

    const handlePopState = () => {
      void leavePage();
    };
    const handlePageHide = () => {
      if (dirtyRef.current) {
        persistLocalDraft();
        if (!sendBackgroundSave()) {
          void saveNow({ keepalive: true });
        }
      }
    };
    const handleVisibilityChange = () => {
      if (document.visibilityState === "hidden" && dirtyRef.current) {
        persistLocalDraft();
        if (!sendBackgroundSave()) {
          void saveNow({ keepalive: true });
        }
        return;
      }

      if (document.visibilityState === "visible") {
        void reconcileBackgroundSave();
        void syncQueuedChanges({
          onSynced: (syncedMemo) => {
            if (syncedMemo.id !== memoRef.current?.id) {
              return;
            }

            memoRef.current = syncedMemo;
            setMemo(syncedMemo);
            lastSavedSnapshotRef.current = currentSnapshot();
            dirtyRef.current = false;
            if (draftKey) {
              localStorage.removeItem(draftKey);
            }
            setSaveStateStable("saved");
          },
        });
      }
    };
    const handleOnline = () => {
      void syncQueuedChanges({
        onSynced: (syncedMemo) => {
          if (syncedMemo.id !== memoRef.current?.id) {
            return;
          }

          memoRef.current = syncedMemo;
          setMemo(syncedMemo);
          lastSavedSnapshotRef.current = currentSnapshot();
          dirtyRef.current = false;
          if (draftKey) {
            localStorage.removeItem(draftKey);
          }
          setSaveStateStable("saved");
        },
      });
    };

    window.addEventListener("popstate", handlePopState);
    window.addEventListener("pagehide", handlePageHide);
    window.addEventListener("online", handleOnline);
    document.addEventListener("visibilitychange", handleVisibilityChange);

    return () => {
      window.removeEventListener("popstate", handlePopState);
      window.removeEventListener("pagehide", handlePageHide);
      window.removeEventListener("online", handleOnline);
      document.removeEventListener("visibilitychange", handleVisibilityChange);
      if (saveTimerRef.current !== null) {
        window.clearTimeout(saveTimerRef.current);
      }
      if (initialFocusTimerRef.current !== null) {
        window.clearTimeout(initialFocusTimerRef.current);
      }
    };
  }, [currentSnapshot, draftKey, leavePage, persistLocalDraft, reconcileBackgroundSave, saveNow, sendBackgroundSave, setSaveStateStable]);

  const saveLabel = getMobileEditorSaveLabel(saveState);
  const statusClassName = getMobileEditorStatusClassName(saveState);
  const editorActionDisabled =
    !memo || !editor || saveState === "loading" || saveState === "compressing" || saveState === "uploading" || saveState === "leaving";
  const currentNotebookLabel =
    notebookOptions.find((notebook) => notebook.id === memo?.notebookId)?.name ?? (notebookOptions.length === 0 ? "等待分类" : "笔记本");

  const fallbackMarkdown = memo ? docToMarkdown(contentJsonRef.current) : "";

  const runEditorCommand = (command: () => boolean) => {
    if (editorActionDisabled || !editor) {
      return;
    }

    command();
    editor.commands.focus();
  };

  return (
    <div className="mobile-editor-shell">
      <MobileEditorHeader saveLabel={saveLabel} statusClassName={statusClassName} saveState={saveState} onLeave={() => void leavePage()} />

      <main className="mobile-editor-main">
        {error && <div className="mobile-editor-error">{error}</div>}
        <input
          className="mobile-editor-title"
          value={title}
          autoComplete="on"
          autoCorrect="on"
          inputMode="text"
          placeholder={DEFAULT_MOBILE_EDITOR_MEMO_TITLE}
          onChange={(event) => handleTitleChange(event.target.value)}
        />
        <div className="mobile-editor-meta-row">
          <MobileEditorNotebookButton
            label={currentNotebookLabel}
            disabled={!memo || notebookUpdatePending || saveState === "loading" || notebookOptions.length === 0}
            onOpen={() => setNotebookSheetOpen(true)}
          />
          <input
            className="mobile-editor-tags"
            value={tagsText}
            autoComplete="on"
            autoCorrect="on"
            inputMode="text"
            placeholder="添加标签，用逗号分隔"
            onChange={(event) => handleTagsChange(event.target.value)}
          />
        </div>

        <MobileEditorToolbar
          disabled={editorActionDisabled}
          boldActive={Boolean(editor?.isActive("bold"))}
          bulletListActive={Boolean(editor?.isActive("bulletList"))}
          blockquoteActive={Boolean(editor?.isActive("blockquote"))}
          onPickImage={() => imageInputRef.current?.click()}
          onToggleBold={() => runEditorCommand(() => editor?.chain().focus().toggleBold().run() ?? false)}
          onToggleBulletList={() => runEditorCommand(() => editor?.chain().focus().toggleBulletList().run() ?? false)}
          onToggleBlockquote={() => runEditorCommand(() => editor?.chain().focus().toggleBlockquote().run() ?? false)}
          onSetHorizontalRule={() => runEditorCommand(() => editor?.chain().focus().setHorizontalRule().run() ?? false)}
        />
        <input
          ref={imageInputRef}
          type="file"
          accept="image/png,image/jpeg,image/gif,image/webp,image/avif"
          hidden
          onChange={(event) => {
            const file = event.target.files?.[0];
            event.target.value = "";
            void handleImageUpload(file);
          }}
        />

        {notebookSheetOpen && (
          <MobileEditorNotebookSheet
            options={notebookOptions}
            selectedNotebookId={memo?.notebookId}
            updating={notebookUpdatePending}
            onClose={() => setNotebookSheetOpen(false)}
            onSelect={(notebookId) => void handleNotebookChange(notebookId)}
          />
        )}

        <div className="edgeever-mobile-tiptap-editor">
          <EditorContent editor={editor} />
        </div>

        {saveState === "error" && fallbackMarkdown && <MobileEditorFallback markdown={fallbackMarkdown} />}
      </main>
    </div>
  );
};
