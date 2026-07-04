import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import { EditorContent, useEditor } from "@tiptap/react";
import StarterKit from "@tiptap/starter-kit";
import Image from "@tiptap/extension-image";
import Placeholder from "@tiptap/extension-placeholder";
import { docToMarkdown, emptyDoc, markdownToDoc, type MemoDetail, type TiptapDoc } from "@edgeever/shared";
import "./styles/mobile-markdown-editor.css";

const AUTO_SAVE_DELAY_MS = 1200;
const LEAVE_SAVE_TIMEOUT_MS = 1600;
const DRAFT_STORAGE_PREFIX = "edgeever-mobile-tiptap-draft:";
const DEFAULT_MEMO_TITLE = "无标题笔记";

type MemoResponse = {
  memo: MemoDetail;
};

type MobileDraft = {
  title: string;
  tagsText: string;
  contentJson: TiptapDoc;
  updatedAt: string;
};

type SaveState = "loading" | "idle" | "dirty" | "saving" | "saved" | "error" | "local-draft" | "leaving";

const getParams = () => new URLSearchParams(window.location.hash ? window.location.hash.slice(1) : window.location.search);

const parseTags = (value: string) =>
  value
    .split(/[,，]/)
    .map((tag) => tag.trim())
    .filter(Boolean);

const safeReturnPath = (value: string | null) => (value?.startsWith("/") ? value : "/");

const requestJson = async <T,>(path: string, init?: RequestInit): Promise<T> => {
  const headers = new Headers(init?.headers);

  if (!headers.has("Content-Type")) {
    headers.set("Content-Type", "application/json");
  }

  const response = await fetch(path, {
    credentials: "include",
    ...init,
    headers,
  });

  if (!response.ok) {
    const body = await response.json().catch(() => null);
    const message =
      body && typeof body === "object" && "error" in body
        ? (body as { error?: { message?: string } }).error?.message
        : response.statusText;
    throw new Error(message || "Request failed");
  }

  return response.json() as Promise<T>;
};

const normalizeDoc = (memo: MemoDetail): TiptapDoc => {
  if (memo.contentJson && typeof memo.contentJson === "object") {
    return memo.contentJson as TiptapDoc;
  }

  if (memo.contentMarkdown) {
    return markdownToDoc(memo.contentMarkdown);
  }

  return emptyDoc();
};

const MobileTiptapEditorApp = () => {
  const params = useMemo(() => getParams(), []);
  const memoId = params.get("memoId");
  const returnTo = safeReturnPath(params.get("returnTo"));
  const draftKey = memoId ? `${DRAFT_STORAGE_PREFIX}${memoId}` : "";
  const [memo, setMemo] = useState<MemoDetail | null>(null);
  const memoRef = useRef<MemoDetail | null>(null);
  const [title, setTitle] = useState("");
  const titleRef = useRef("");
  const [tagsText, setTagsText] = useState("");
  const tagsTextRef = useRef("");
  const contentJsonRef = useRef<TiptapDoc>(emptyDoc());
  const [saveState, setSaveState] = useState<SaveState>("loading");
  const saveStateRef = useRef<SaveState>("loading");
  const [error, setError] = useState<string | null>(null);
  const dirtyRef = useRef(false);
  const leavingRef = useRef(false);
  const savingRef = useRef(false);
  const saveTimerRef = useRef<number | null>(null);
  const currentSavePromiseRef = useRef<Promise<boolean> | null>(null);
  const lastSavedSnapshotRef = useRef("");

  const setSaveStateStable = useCallback((nextState: SaveState) => {
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

    const draft: MobileDraft = {
      title: titleRef.current,
      tagsText: tagsTextRef.current,
      contentJson: contentJsonRef.current,
      updatedAt: new Date().toISOString(),
    };
    localStorage.setItem(draftKey, JSON.stringify(draft));
  }, [draftKey]);

  const readLocalDraft = useCallback((): MobileDraft | null => {
    if (!draftKey) {
      return null;
    }

    try {
      const raw = localStorage.getItem(draftKey);
      return raw ? (JSON.parse(raw) as MobileDraft) : null;
    } catch {
      return null;
    }
  }, [draftKey]);

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
      }, AUTO_SAVE_DELAY_MS);
    },
  });

  const saveNowRef = useRef<({ keepalive }?: { keepalive?: boolean }) => Promise<boolean>>(async () => false);

  useEffect(() => {
    memoRef.current = memo;
  }, [memo]);

  useEffect(() => {
    titleRef.current = title;
  }, [title]);

  useEffect(() => {
    tagsTextRef.current = tagsText;
  }, [tagsText]);

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
        const nextContentJson = contentJsonRef.current;
        const data = await requestJson<MemoResponse>(`/api/v1/memos/${encodeURIComponent(currentMemo.id)}`, {
          method: "PATCH",
          keepalive,
          body: JSON.stringify({
            expectedRevision: currentMemo.revision,
            title: titleRef.current,
            contentJson: nextContentJson,
            tags: parseTags(tagsTextRef.current),
          }),
        });

        setMemo(data.memo);
        lastSavedSnapshotRef.current = currentSnapshot();
        dirtyRef.current = false;
        if (draftKey) {
          localStorage.removeItem(draftKey);
        }
        setSaveStateStable("saved");
        window.setTimeout(() => {
          if (!dirtyRef.current && !savingRef.current && !leavingRef.current) {
            setSaveStateStable("idle");
          }
        }, 1200);
        return true;
      })();

      try {
        return await currentSavePromiseRef.current;
      } catch (saveError) {
        persistLocalDraft();
        setError(saveError instanceof Error ? saveError.message : "保存失败，已保留本地草稿");
        setSaveStateStable("error");
        return false;
      } finally {
        savingRef.current = false;
        currentSavePromiseRef.current = null;
      }
    },
    [currentSnapshot, draftKey, persistLocalDraft, setSaveStateStable]
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
    }, AUTO_SAVE_DELAY_MS);
  }, [persistLocalDraft, saveNow, setSaveStateStable]);

  const navigateBack = useCallback(() => {
    window.location.replace(returnTo);
  }, [returnTo]);

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
      new Promise((resolve) => window.setTimeout(resolve, LEAVE_SAVE_TIMEOUT_MS)),
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
        const data = await requestJson<MemoResponse>(`/api/v1/memos/${encodeURIComponent(memoId)}`);
        if (cancelled) {
          return;
        }

        const nextTitle = data.memo.title || "";
        const nextTagsText = Array.isArray(data.memo.tags) ? data.memo.tags.join(", ") : "";
        const nextContentJson = normalizeDoc(data.memo);
        const draft = readLocalDraft();
        const useDraft = Boolean(draft && Date.parse(draft.updatedAt || "") >= Date.parse(data.memo.updatedAt || ""));

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
    };
  }, [editor, memoId, readLocalDraft, scheduleMetadataSave, setSaveStateStable]);

  useEffect(() => {
    window.history.replaceState({ edgeeverMobileEditor: true }, "");
    window.history.pushState({ edgeeverMobileEditorBackGuard: true }, "");

    const handlePopState = () => {
      void leavePage();
    };
    const handlePageHide = () => {
      if (dirtyRef.current) {
        persistLocalDraft();
        void saveNow({ keepalive: true });
      }
    };
    const handleVisibilityChange = () => {
      if (document.visibilityState === "hidden" && dirtyRef.current) {
        persistLocalDraft();
        void saveNow({ keepalive: true });
      }
    };

    window.addEventListener("popstate", handlePopState);
    window.addEventListener("pagehide", handlePageHide);
    document.addEventListener("visibilitychange", handleVisibilityChange);

    return () => {
      window.removeEventListener("popstate", handlePopState);
      window.removeEventListener("pagehide", handlePageHide);
      document.removeEventListener("visibilitychange", handleVisibilityChange);
      if (saveTimerRef.current !== null) {
        window.clearTimeout(saveTimerRef.current);
      }
    };
  }, [leavePage, persistLocalDraft, saveNow]);

  const saveLabel =
    saveState === "loading"
      ? "加载中"
      : saveState === "saving"
        ? "保存中"
        : saveState === "dirty"
          ? "未保存"
          : saveState === "saved"
            ? "已保存"
            : saveState === "local-draft"
              ? "本地草稿"
              : saveState === "leaving"
                ? "返回中"
                : saveState === "error"
                  ? "保存失败"
                  : "已保存";

  const statusClassName =
    saveState === "error" ? "error" : saveState === "dirty" || saveState === "saving" || saveState === "leaving" ? "active" : "";

  const fallbackMarkdown = memo ? docToMarkdown(contentJsonRef.current) : "";

  return (
    <div className="mobile-editor-shell">
      <header className="mobile-editor-header">
        <button className="mobile-editor-back" type="button" aria-label="返回" onClick={() => void leavePage()}>
          ‹
        </button>
        <div className="mobile-editor-actions">
          <span className={`mobile-editor-status ${statusClassName}`}>{saveLabel}</span>
          <button className="mobile-editor-done" type="button" disabled={saveState === "loading"} onClick={() => void leavePage()}>
            完成
          </button>
        </div>
      </header>

      <main className="mobile-editor-main">
        {error && <div className="mobile-editor-error">{error}</div>}
        <input
          className="mobile-editor-title"
          value={title}
          autoComplete="on"
          autoCorrect="on"
          inputMode="text"
          placeholder={DEFAULT_MEMO_TITLE}
          onChange={(event) => handleTitleChange(event.target.value)}
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

        <div className="edgeever-mobile-tiptap-editor">
          <EditorContent editor={editor} />
        </div>

        {saveState === "error" && fallbackMarkdown && (
          <details className="mobile-editor-fallback">
            <summary>查看当前正文 Markdown 备份</summary>
            <pre>{fallbackMarkdown}</pre>
          </details>
        )}
      </main>
    </div>
  );
};

const root = document.getElementById("mobile-editor-root");

if (!root) {
  throw new Error("Mobile editor root not found");
}

createRoot(root).render(
  <React.StrictMode>
    <MobileTiptapEditorApp />
  </React.StrictMode>
);
