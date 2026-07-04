import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import MDEditor, { commands } from "@uiw/react-md-editor/nohighlight";
import type { PreviewType } from "@uiw/react-md-editor";
import "@uiw/react-md-editor/markdown-editor.css";
import { docToMarkdown, type MemoDetail, type Resource, type TiptapDoc } from "@edgeever/shared";
import "./styles/mobile-markdown-editor.css";

const AUTO_SAVE_DELAY_MS = 1200;
const LEAVE_SAVE_TIMEOUT_MS = 1600;
const DRAFT_STORAGE_PREFIX = "edgeever-mobile-edit-draft:";
const DEFAULT_MEMO_TITLE = "无标题笔记";

type MemoResponse = {
  memo: MemoDetail;
};

type ResourceResponse = {
  resource: Resource;
};

type MobileDraft = {
  title: string;
  tagsText: string;
  body: string;
  updatedAt: string;
};

type SaveState = "loading" | "idle" | "dirty" | "saving" | "saved" | "uploading" | "error" | "local-draft" | "leaving";

const getParams = () => new URLSearchParams(window.location.hash ? window.location.hash.slice(1) : window.location.search);

const parseTags = (value: string) =>
  value
    .split(/[,，]/)
    .map((tag) => tag.trim())
    .filter(Boolean);

const escapeMarkdownLabel = (value: string) => value.replace(/\]/g, "\\]");

const safeReturnPath = (value: string | null) => (value?.startsWith("/") ? value : "/");

const requestJson = async <T,>(path: string, init?: RequestInit): Promise<T> => {
  const headers = new Headers(init?.headers);

  if (!(init?.body instanceof FormData) && !headers.has("Content-Type")) {
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

const uploadResource = async (memoId: string, file: File) => {
  const form = new FormData();
  form.append("file", file);

  return requestJson<ResourceResponse>(`/api/v1/memos/${encodeURIComponent(memoId)}/resources`, {
    method: "POST",
    body: form,
  });
};

const markdownForResource = (resource: Resource) => {
  const filename = resource.filename || "附件";

  if (resource.kind === "image") {
    return `![${escapeMarkdownLabel(filename)}](${resource.url})`;
  }

  return `附件：${filename}\n${resource.url}`;
};

const insertAtCursor = (value: string, insertion: string) => {
  const textarea = document.querySelector<HTMLTextAreaElement>(".edgeever-mobile-md-editor textarea");
  const start = textarea?.selectionStart ?? value.length;
  const end = textarea?.selectionEnd ?? start;
  const nextValue = `${value.slice(0, start)}${insertion}${value.slice(end)}`;
  const nextCursor = start + insertion.length;

  window.setTimeout(() => {
    textarea?.focus();
    textarea?.setSelectionRange(nextCursor, nextCursor);
  }, 0);

  return nextValue;
};

const MobileMarkdownEditorApp = () => {
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
  const [markdown, setMarkdown] = useState("");
  const markdownRef = useRef("");
  const [preview, setPreview] = useState<PreviewType>("edit");
  const [saveState, setSaveState] = useState<SaveState>("loading");
  const [error, setError] = useState<string | null>(null);
  const dirtyRef = useRef(false);
  const leavingRef = useRef(false);
  const savingRef = useRef(false);
  const saveTimerRef = useRef<number | null>(null);
  const currentSavePromiseRef = useRef<Promise<boolean> | null>(null);
  const lastSavedSnapshotRef = useRef("");
  const imageInputRef = useRef<HTMLInputElement | null>(null);
  const fileInputRef = useRef<HTMLInputElement | null>(null);

  useEffect(() => {
    memoRef.current = memo;
  }, [memo]);

  useEffect(() => {
    titleRef.current = title;
  }, [title]);

  useEffect(() => {
    tagsTextRef.current = tagsText;
  }, [tagsText]);

  useEffect(() => {
    markdownRef.current = markdown;
  }, [markdown]);

  const currentSnapshot = useCallback(
    () =>
      JSON.stringify({
        title: titleRef.current,
        tagsText: tagsTextRef.current,
        body: markdownRef.current,
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
      body: markdownRef.current,
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
      setSaveState("saving");
      setError(null);

      currentSavePromiseRef.current = (async () => {
        const data = await requestJson<MemoResponse>(`/api/v1/memos/${encodeURIComponent(currentMemo.id)}`, {
          method: "PATCH",
          keepalive,
          body: JSON.stringify({
            expectedRevision: currentMemo.revision,
            title: titleRef.current,
            contentMarkdown: markdownRef.current,
            tags: parseTags(tagsTextRef.current),
          }),
        });

        setMemo(data.memo);
        lastSavedSnapshotRef.current = currentSnapshot();
        dirtyRef.current = false;
        if (draftKey) {
          localStorage.removeItem(draftKey);
        }
        setSaveState("saved");
        window.setTimeout(() => {
          if (!dirtyRef.current && !savingRef.current && !leavingRef.current) {
            setSaveState("idle");
          }
        }, 1200);
        return true;
      })();

      try {
        return await currentSavePromiseRef.current;
      } catch (saveError) {
        persistLocalDraft();
        setError(saveError instanceof Error ? saveError.message : "保存失败，已保留本地草稿");
        setSaveState("error");
        return false;
      } finally {
        savingRef.current = false;
        currentSavePromiseRef.current = null;
      }
    },
    [currentSnapshot, draftKey, persistLocalDraft]
  );

  const scheduleSave = useCallback(() => {
    dirtyRef.current = true;
    persistLocalDraft();
    setSaveState("dirty");

    if (saveTimerRef.current !== null) {
      window.clearTimeout(saveTimerRef.current);
    }
    saveTimerRef.current = window.setTimeout(() => {
      saveTimerRef.current = null;
      void saveNow();
    }, AUTO_SAVE_DELAY_MS);
  }, [persistLocalDraft, saveNow]);

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
    setSaveState("leaving");

    await Promise.race([
      saveNow({ keepalive: true }),
      new Promise((resolve) => window.setTimeout(resolve, LEAVE_SAVE_TIMEOUT_MS)),
    ]);
    navigateBack();
  }, [navigateBack, persistLocalDraft, saveNow]);

  const handleTitleChange = (nextTitle: string) => {
    setTitle(nextTitle);
    titleRef.current = nextTitle;
    scheduleSave();
  };

  const handleTagsChange = (nextTagsText: string) => {
    setTagsText(nextTagsText);
    tagsTextRef.current = nextTagsText;
    scheduleSave();
  };

  const handleMarkdownChange = (nextMarkdown?: string) => {
    const value = nextMarkdown ?? "";
    setMarkdown(value);
    markdownRef.current = value;
    scheduleSave();
  };

  const handleUpload = async (file?: File | null) => {
    const currentMemo = memoRef.current;
    if (!currentMemo || !file) {
      return;
    }

    setSaveState("uploading");
    setError(null);

    try {
      const data = await uploadResource(currentMemo.id, file);
      const insertion = `\n\n${markdownForResource(data.resource)}\n\n`;
      const nextMarkdown = insertAtCursor(markdownRef.current, insertion);
      setMarkdown(nextMarkdown);
      markdownRef.current = nextMarkdown;
      dirtyRef.current = true;
      persistLocalDraft();
      void saveNow();
    } catch (uploadError) {
      setError(uploadError instanceof Error ? uploadError.message : "上传失败");
      setSaveState("error");
    }
  };

  useEffect(() => {
    if (!memoId) {
      setError("缺少 memoId");
      setSaveState("error");
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
        const nextMarkdown = data.memo.contentMarkdown || docToMarkdown(data.memo.contentJson as TiptapDoc);
        const draft = readLocalDraft();
        const useDraft = Boolean(draft && Date.parse(draft.updatedAt || "") >= Date.parse(data.memo.updatedAt || ""));

        setMemo(data.memo);

        if (useDraft && draft) {
          setTitle(draft.title || "");
          titleRef.current = draft.title || "";
          setTagsText(draft.tagsText || "");
          tagsTextRef.current = draft.tagsText || "";
          setMarkdown(draft.body || "");
          markdownRef.current = draft.body || "";
          dirtyRef.current = true;
          setSaveState("local-draft");
          scheduleSave();
        } else {
          setTitle(nextTitle);
          titleRef.current = nextTitle;
          setTagsText(nextTagsText);
          tagsTextRef.current = nextTagsText;
          setMarkdown(nextMarkdown);
          markdownRef.current = nextMarkdown;
          lastSavedSnapshotRef.current = JSON.stringify({
            title: nextTitle,
            tagsText: nextTagsText,
            body: nextMarkdown,
          });
          dirtyRef.current = false;
          setSaveState("idle");
        }

        for (const delay of [0, 120, 500]) {
          window.setTimeout(() => {
            document.querySelector<HTMLTextAreaElement>(".edgeever-mobile-md-editor textarea")?.focus();
          }, delay);
        }
      } catch (loadError) {
        if (cancelled) {
          return;
        }
        setError(loadError instanceof Error ? loadError.message : "加载失败");
        setSaveState("error");
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [memoId, readLocalDraft, scheduleSave]);

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
        : saveState === "uploading"
          ? "上传中"
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
    saveState === "error" ? "error" : saveState === "dirty" || saveState === "saving" || saveState === "uploading" || saveState === "leaving" ? "active" : "";

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

        <div className="mobile-editor-tool-row">
          <button type="button" onClick={() => imageInputRef.current?.click()} disabled={!memo || saveState === "uploading"}>
            图片
          </button>
          <button type="button" onClick={() => fileInputRef.current?.click()} disabled={!memo || saveState === "uploading"}>
            附件
          </button>
          <div className="mobile-editor-preview-toggle" role="group" aria-label="编辑预览切换">
            <button type="button" aria-pressed={preview === "edit"} onClick={() => setPreview("edit")}>
              编辑
            </button>
            <button type="button" aria-pressed={preview === "preview"} onClick={() => setPreview("preview")}>
              预览
            </button>
          </div>
        </div>
        <input
          ref={imageInputRef}
          type="file"
          accept="image/png,image/jpeg,image/gif,image/webp,image/avif"
          hidden
          onChange={(event) => {
            const file = event.target.files?.[0];
            event.target.value = "";
            void handleUpload(file);
          }}
        />
        <input
          ref={fileInputRef}
          type="file"
          hidden
          onChange={(event) => {
            const file = event.target.files?.[0];
            event.target.value = "";
            void handleUpload(file);
          }}
        />

        <div className="edgeever-mobile-md-editor" data-color-mode="light">
          <MDEditor
            value={markdown}
            preview={preview}
            height="calc(100dvh - 15.75rem)"
            minHeight={360}
            visibleDragbar={false}
            enableScroll
            autoFocus
            autoFocusEnd
            textareaProps={{
              autoComplete: "on",
              autoCorrect: "on",
              inputMode: "text",
              enterKeyHint: "enter",
              spellCheck: true,
              placeholder: "开始记录...",
              "aria-label": "笔记正文",
            }}
            commands={[
              commands.bold,
              commands.italic,
              commands.heading,
              commands.quote,
              commands.unorderedListCommand,
              commands.orderedListCommand,
              commands.link,
            ]}
            extraCommands={[]}
            onChange={handleMarkdownChange}
          />
        </div>
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
    <MobileMarkdownEditorApp />
  </React.StrictMode>
);
