import { useRef, useState, useEffect, useCallback, useMemo, type PointerEvent as ReactPointerEvent, type ReactNode } from "react";
import { useQueryClient, useMutation } from "@tanstack/react-query";
import { useTranslation } from "react-i18next";
import { NodeViewWrapper, ReactNodeViewRenderer, useEditor, EditorContent, type Editor, type NodeViewProps } from "@tiptap/react";
import StarterKit from "@tiptap/starter-kit";
import Image from "@tiptap/extension-image";
import Placeholder from "@tiptap/extension-placeholder";
import {
  ChevronLeft,
  ChevronRight,
  ChevronDown,
  History,
  RotateCcw,
  Trash2,
  Tags,
  Save,
  ReplaceAll,
  MoreHorizontal,
  Paperclip,
  Pencil,
  Sparkles,
  Search,
  Type,
  X,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { GitHubRepositoryLink } from "@/components/GitHubRepositoryLink";
import { Input } from "@/components/ui/input";
import {
  Command,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
} from "@/components/ui/command";
import {
  Drawer,
  DrawerContent,
  DrawerHeader,
  DrawerTitle,
} from "@/components/ui/drawer";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Select, SelectTrigger, SelectValue, SelectContent, SelectItem } from "@/components/ui/select";
import { EditorToolbar } from "./EditorToolbar";
import { RevisionHistoryDialog } from "./dialogs/RevisionHistoryDialog";
import { api } from "@/lib/api";
import { cn, formatDateTime, parseTagsText } from "@/lib/utils";
import { docToMarkdown, type Notebook, type MemoDetail, type TiptapDoc } from "@edgeever/shared";
import { compressImageForUpload } from "@/lib/image-compression";
import { localDb, type MemoUpdateSyncPayload } from "@/lib/local-db";
import { getMemoUpdateQueueId, queueMemoUpdate, shouldQueueMemoSaveError } from "@/lib/sync-queue";
import {
  getNotebookMoveOptions,
} from "@/lib/app-helpers";

const SUPPORTED_PASTE_IMAGE_TYPES = new Set(["image/png", "image/jpeg", "image/gif", "image/webp", "image/avif"]);
const MOBILE_EDITOR_QUERY = "(max-width: 639px)";
const DESKTOP_AUTOSAVE_IDLE_MS = 1200;
const MOBILE_DRAFT_PERSIST_IDLE_MS = 350;
const DESKTOP_DRAFT_PERSIST_IDLE_MS = 1500;
const MOBILE_AUTOSAVE_IDLE_MS = 10_000;
const MOBILE_AUTOSAVE_MAX_INTERVAL_MS = 30_000;
const DEFAULT_IMAGE_WIDTH_PERCENT = 72;
const MIN_IMAGE_WIDTH_PERCENT = 25;
const MAX_IMAGE_WIDTH_PERCENT = 100;
const IMAGE_WIDTH_PRESETS = [35, 50, 72, 100];

type NoteSearchMatch = {
  from: number;
  to: number;
};

const isEditorReady = (editor: Editor | null | undefined): editor is Editor =>
  Boolean(editor && !editor.isDestroyed && (editor as { extensionManager?: unknown }).extensionManager);

const getEditorSearchMatches = (editor: Editor | null, query: string): NoteSearchMatch[] => {
  const needle = query.trim().toLocaleLowerCase();

  if (!isEditorReady(editor) || needle.length === 0) {
    return [];
  }

  const characters: Array<{ char: string; pos: number }> = [];
  let previousTextEnd: number | null = null;

  editor.state.doc.descendants((node, pos) => {
    if (!node.isText || !node.text) {
      return;
    }

    if (previousTextEnd !== null && pos > previousTextEnd) {
      characters.push({ char: "\u0000", pos: -1 });
    }

    for (let index = 0; index < node.text.length; index += 1) {
      characters.push({ char: node.text[index] ?? "", pos: pos + index });
    }

    previousTextEnd = pos + node.text.length;
  });

  const haystack = characters.map((item) => item.char).join("").toLocaleLowerCase();
  const matches: NoteSearchMatch[] = [];
  let index = haystack.indexOf(needle);

  while (index !== -1) {
    const start = characters[index];
    const end = characters[index + needle.length - 1];

    if (start && end && start.pos >= 0 && end.pos >= 0) {
      matches.push({ from: start.pos, to: end.pos + 1 });
    }

    index = haystack.indexOf(needle, index + needle.length);
  }

  return matches;
};

const getImageFilesFromDataTransfer = (dataTransfer: DataTransfer | null) => {
  if (!dataTransfer) {
    return [];
  }

  const fileItems = Array.from(dataTransfer.items ?? [])
    .filter((item) => item.kind === "file")
    .map((item) => item.getAsFile())
    .filter((file): file is File => Boolean(file));
  const files = fileItems.length > 0 ? fileItems : Array.from(dataTransfer.files ?? []);

  return files.filter((file) => SUPPORTED_PASTE_IMAGE_TYPES.has(file.type));
};

const clampImageWidth = (width: number) =>
  Math.min(MAX_IMAGE_WIDTH_PERCENT, Math.max(MIN_IMAGE_WIDTH_PERCENT, Math.round(width)));

const parseImageWidth = (value: unknown) => {
  if (typeof value === "number" && Number.isFinite(value)) {
    return clampImageWidth(value);
  }

  if (typeof value !== "string") {
    return null;
  }

  const match = /(\d+(?:\.\d+)?)/.exec(value);
  return match ? clampImageWidth(Number(match[1])) : null;
};

const ResizableImageNodeView = ({ editor, node, selected, updateAttributes }: NodeViewProps) => {
  const { t } = useTranslation();
  const wrapperRef = useRef<HTMLDivElement | null>(null);
  const width = parseImageWidth(node.attrs.width) ?? DEFAULT_IMAGE_WIDTH_PERCENT;
  const editable = editor.isEditable;
  const alt = typeof node.attrs.alt === "string" ? node.attrs.alt : "";
  const title = typeof node.attrs.title === "string" ? node.attrs.title : "";
  const src = typeof node.attrs.src === "string" ? node.attrs.src : "";

  const updateWidth = useCallback(
    (nextWidth: number) => {
      updateAttributes({ width: clampImageWidth(nextWidth) });
    },
    [updateAttributes]
  );

  const startResize = useCallback(
    (event: ReactPointerEvent<HTMLButtonElement>) => {
      if (!editable) {
        return;
      }

      const wrapper = wrapperRef.current;
      const parent = wrapper?.parentElement;
      if (!wrapper || !parent) {
        return;
      }

      event.preventDefault();
      event.currentTarget.setPointerCapture(event.pointerId);

      const parentWidth = parent.getBoundingClientRect().width;
      if (parentWidth <= 0) {
        return;
      }

      const updateFromPointer = (clientX: number) => {
        const wrapperLeft = wrapper.getBoundingClientRect().left;
        updateWidth(((clientX - wrapperLeft) / parentWidth) * 100);
      };

      const handlePointerMove = (moveEvent: PointerEvent) => updateFromPointer(moveEvent.clientX);
      const stopResize = () => {
        window.removeEventListener("pointermove", handlePointerMove);
        window.removeEventListener("pointerup", stopResize);
        window.removeEventListener("pointercancel", stopResize);
      };

      window.addEventListener("pointermove", handlePointerMove);
      window.addEventListener("pointerup", stopResize);
      window.addEventListener("pointercancel", stopResize);
      updateFromPointer(event.clientX);
    },
    [editable, updateWidth]
  );

  return (
    <NodeViewWrapper
      ref={wrapperRef}
      as="figure"
      className={cn("edgeever-image-node", selected && "is-selected")}
      style={{ width: `${width}%` }}
      data-width={width}
    >
      <img src={src} alt={alt} title={title || undefined} draggable={false} />
      {editable && selected && (
        <div className="edgeever-image-controls" contentEditable={false}>
          <div className="edgeever-image-presets" aria-label={t("editor.imageScale")}>
            {IMAGE_WIDTH_PRESETS.map((preset) => (
              <button
                key={preset}
                type="button"
                className={cn("edgeever-image-preset", width === preset && "is-active")}
                title={t("editor.scaleTo", { percent: preset })}
                aria-label={t("editor.scaleTo", { percent: preset })}
                onClick={() => updateWidth(preset)}
              >
                {preset}
              </button>
            ))}
          </div>
          <button
            type="button"
            className="edgeever-image-resize-handle"
            title={t("editor.resizeImage")}
            aria-label={t("editor.resizeImage")}
            onPointerDown={startResize}
          />
        </div>
      )}
    </NodeViewWrapper>
  );
};

const ResizableImage = Image.extend({
  addAttributes() {
    return {
      ...this.parent?.(),
      width: {
        default: null,
        parseHTML: (element) =>
          parseImageWidth(element.getAttribute("data-width") ?? element.getAttribute("width") ?? element.style.width),
        renderHTML: (attributes) => {
          const width = parseImageWidth(attributes.width);
          return width ? { "data-width": String(width), style: `width: ${width}%` } : {};
        },
      },
    };
  },
  addNodeView() {
    return ReactNodeViewRenderer(ResizableImageNodeView);
  },
});

const syncStatusToSaveState = (status: "pending" | "syncing" | "conflict" | "error") => {
  if (status === "conflict") {
    return "conflict";
  }
  if (status === "syncing") {
    return "saving";
  }
  return "queued";
};

class MemoSaveRequestError extends Error {
  originalError: unknown;
  payload: MemoUpdateSyncPayload;
  tagsText: string;

  constructor(originalError: unknown, payload: MemoUpdateSyncPayload, tagsText: string) {
    super(originalError instanceof Error ? originalError.message : "Memo save failed");
    this.name = "MemoSaveRequestError";
    this.originalError = originalError;
    this.payload = payload;
    this.tagsText = tagsText;
  }
}

const MobileNotebookSelectSheet = ({
  isUpdating,
  options,
  selectedNotebookId,
  onClose,
  onSelect,
}: {
  isUpdating: boolean;
  options: any[];
  selectedNotebookId: string;
  onClose: () => void;
  onSelect: (notebookId: string) => void;
}) => {
  const { t } = useTranslation();
  const listRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    window.setTimeout(() => {
      const selectedNode = listRef.current?.querySelector<HTMLElement>(
        `[data-mobile-notebook-select-id="${CSS.escape(selectedNotebookId)}"]`
      );
      selectedNode?.scrollIntoView({ block: "center" });
    }, 0);
  }, [selectedNotebookId]);

  return (
    <Drawer open={true} onOpenChange={(open) => { if (!open) onClose(); }}>
      <DrawerContent className="inset-x-0 max-h-[62dvh] overflow-hidden border-x-0 border-b-0 pb-[env(safe-area-inset-bottom)] lg:hidden">
        <header className="flex h-12 items-center justify-between border-b border-slate-200 px-4">
          <DrawerHeader className="min-w-0 p-0">
            <DrawerTitle className="text-base">{t("editor.currentNotebook")}</DrawerTitle>
          </DrawerHeader>
          <Button size="icon" variant="ghost" title={t("editor.close")} aria-label={t("editor.close")} onClick={onClose}>
            <X className="h-4 w-4" />
          </Button>
        </header>
        <Command className="min-h-0 flex-1">
          <CommandInput placeholder={t("editor.searchNotebook")} />
          <CommandList ref={listRef} className="max-h-[calc(62dvh-6.25rem-env(safe-area-inset-bottom))] p-2">
            <CommandEmpty>{t("editor.noNotebookFound")}</CommandEmpty>
            <CommandGroup>
              {options.map((option) => {
                const selected = option.id === selectedNotebookId;
                return (
                  <CommandItem
                    key={option.id}
                    className={cn(
                      "h-12 px-3 text-base",
                      selected ? "bg-emerald-50 font-semibold text-emerald-700 data-[selected=true]:bg-emerald-50" : "text-slate-700"
                    )}
                    style={{ paddingLeft: `${12 + option.depth * 18}px` }}
                    value={option.id}
                    keywords={[option.name, option.selectLabel, option.slug ?? ""]}
                    data-mobile-notebook-select-id={option.id}
                    aria-label={selected ? t("editor.currentNotebookAria", { name: option.name }) : t("editor.switchToNotebook", { name: option.name })}
                    aria-current={selected ? "page" : undefined}
                    disabled={isUpdating}
                    onSelect={() => onSelect(option.id)}
                  >
                    <span className="min-w-0 flex-1 truncate">{option.name}</span>
                  </CommandItem>
                );
              })}
            </CommandGroup>
          </CommandList>
        </Command>
      </DrawerContent>
    </Drawer>
  );
};

export const EditorPane = ({
  memo,
  mobileDefaultEditMemoId,
  preserveUnsavedContentFromMemoId,
  saveBlocked = false,
  isTrashView,
  notebooks,
  isLoading,
  imageCompressionEnabled,
  hasNextMemo,
  hasPreviousMemo,
  onBackToList,
  onOpenNextMemo,
  onOpenPreviousMemo,
  onSaved,
  onDeleted,
  onPermanentDeleted,
  onRestored,
  onMobileDefaultEditConsumed,
  searchFocusToken,
  replaceFocusToken,
  selectionActionBar,
}: {
  memo: MemoDetail | null;
  mobileDefaultEditMemoId: string | null;
  preserveUnsavedContentFromMemoId?: string | null;
  saveBlocked?: boolean;
  isTrashView: boolean;
  notebooks: Notebook[];
  isLoading: boolean;
  imageCompressionEnabled: boolean;
  hasNextMemo: boolean;
  hasPreviousMemo: boolean;
  onBackToList: () => void;
  onOpenNextMemo: () => void;
  onOpenPreviousMemo: () => void;
  onSaved: (memo: MemoDetail) => Promise<void>;
  onDeleted: (memoId: string) => Promise<void>;
  onPermanentDeleted: (memoId: string) => Promise<void>;
  onRestored: (memoId: string) => Promise<void>;
  onMobileDefaultEditConsumed: () => void;
  searchFocusToken: number;
  replaceFocusToken: number;
  selectionActionBar?: ReactNode;
}) => {
  const { t } = useTranslation();
  const queryClient = useQueryClient();
  const isSelectionMode = Boolean(selectionActionBar);
  const [title, setTitle] = useState("");
  const [tagsText, setTagsText] = useState("");
  const [saveState, setSaveState] = useState<"idle" | "saving" | "saved" | "queued" | "error" | "conflict">("idle");
  const [hasUnsavedChanges, setHasUnsavedChanges] = useState(false);
  const [dirtyVersion, setDirtyVersion] = useState(0);
  const [autoSaveVersion, setAutoSaveVersion] = useState(0);
  const [, setEditorStateVersion] = useState(0);
  const [imageUploadState, setImageUploadState] = useState<"idle" | "compressing" | "uploading" | "error">("idle");
  const [historyOpen, setHistoryOpen] = useState(false);
  const [mobileNotebookSheetOpen, setMobileNotebookSheetOpen] = useState(false);
  const [notebookUpdatePending, setNotebookUpdatePending] = useState(false);
  const [noteSearchOpen, setNoteSearchOpen] = useState(false);
  const [noteSearchQuery, setNoteSearchQuery] = useState("");
  const [noteSearchReplaceOpen, setNoteSearchReplaceOpen] = useState(false);
  const [noteSearchReplacement, setNoteSearchReplacement] = useState("");
  const [noteSearchIndex, setNoteSearchIndex] = useState(0);
  const [isMobileViewport, setIsMobileViewport] = useState(() =>
    typeof window === "undefined" ? false : window.matchMedia(MOBILE_EDITOR_QUERY).matches
  );
  const [isMobileEditing, setIsMobileEditing] = useState(false);
  const [mobileToolbarOpen, setMobileToolbarOpen] = useState(false);
  const notebookOptions = useMemo(() => getNotebookMoveOptions(notebooks), [notebooks]);
  const readOnly = isTrashView || Boolean(memo?.isDeleted);
  const effectiveReadOnly = readOnly || (isMobileViewport && !isMobileEditing);

  const memoRef = useRef<MemoDetail | null>(memo);
  const editorRef = useRef<Editor | null>(null);
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const noteSearchInputRef = useRef<HTMLInputElement | null>(null);
  const noteReplaceInputRef = useRef<HTMLInputElement | null>(null);
  const hydratingRef = useRef(false);
  const hasUnsavedChangesRef = useRef(false);
  const editingMemoIdRef = useRef<string | null>(memo?.id ?? null);
  const imageCompressionEnabledRef = useRef(imageCompressionEnabled);
  const draftPersistTimerRef = useRef<number | null>(null);
  const autoSaveTimerRef = useRef<number | null>(null);
  const pendingBackAfterSaveRef = useRef(false);
  const toolbarRefreshFrameRef = useRef<number | null>(null);
  const isComposingRef = useRef(false);
  const lastAutoSaveVersionRef = useRef(0);
  const unsavedSinceRef = useRef<number | null>(null);
  const draftTitleRef = useRef("");
  const draftTagsTextRef = useRef("");
  const saveStateRef = useRef<"idle" | "saving" | "saved" | "queued" | "error" | "conflict">("idle");

  const clearAutoSaveTimer = useCallback(() => {
    if (autoSaveTimerRef.current !== null) {
      window.clearTimeout(autoSaveTimerRef.current);
      autoSaveTimerRef.current = null;
    }
  }, []);

  const scheduleAutoSave = useCallback(() => {
    clearAutoSaveTimer();

    if (isComposingRef.current) {
      return;
    }

    const now = Date.now();
    const unsavedSince = unsavedSinceRef.current ?? now;
    const delay =
      isMobileViewport && isMobileEditing
        ? Math.max(0, Math.min(MOBILE_AUTOSAVE_IDLE_MS, MOBILE_AUTOSAVE_MAX_INTERVAL_MS - (now - unsavedSince)))
        : DESKTOP_AUTOSAVE_IDLE_MS;

    autoSaveTimerRef.current = window.setTimeout(() => {
      autoSaveTimerRef.current = null;

      if (isComposingRef.current) {
        return;
      }

      setAutoSaveVersion((version) => version + 1);
    }, delay);
  }, [clearAutoSaveTimer, isMobileEditing, isMobileViewport]);

  useEffect(() => {
    const mediaQuery = window.matchMedia(MOBILE_EDITOR_QUERY);
    const updateMobileViewport = () => setIsMobileViewport(mediaQuery.matches);

    updateMobileViewport();
    mediaQuery.addEventListener("change", updateMobileViewport);

    return () => mediaQuery.removeEventListener("change", updateMobileViewport);
  }, []);

  useEffect(() => {
    setIsMobileEditing(false);
    setMobileToolbarOpen(false);
  }, [memo?.id]);

  useEffect(() => {
    if (memo?.id && memo.id === mobileDefaultEditMemoId) {
      setIsMobileEditing(true);
      let frame = 0;
      let cancelled = false;

      const focusWhenReady = (attempt = 0) => {
        frame = window.requestAnimationFrame(() => {
          if (cancelled) {
            return;
          }

          const currentEditor = editorRef.current;
          if (isEditorReady(currentEditor)) {
            currentEditor.commands.focus("end");
            onMobileDefaultEditConsumed();
            return;
          }

          if (attempt < 10) {
            focusWhenReady(attempt + 1);
            return;
          }

          onMobileDefaultEditConsumed();
        });
      };

      focusWhenReady();

      return () => {
        cancelled = true;
        window.cancelAnimationFrame(frame);
      };
    }
  }, [memo?.id, mobileDefaultEditMemoId, onMobileDefaultEditConsumed]);

  const insertImageFiles = useCallback((files: File[]) => {
    const currentMemo = memoRef.current;
    const currentEditor = editorRef.current;

    if (saveBlocked || !currentMemo || currentMemo.isDeleted || !currentEditor || !currentEditor.isEditable || files.length === 0) {
      return;
    }

    const targetMemoId = currentMemo.id;

    void (async () => {
      setImageUploadState("uploading");

      try {
        for (const file of files) {
          const shouldCompress = imageCompressionEnabledRef.current;
          setImageUploadState(shouldCompress ? "compressing" : "uploading");
          const uploadFile = shouldCompress ? (await compressImageForUpload(file)).file : file;

          setImageUploadState("uploading");
          const { resource } = await api.uploadMemoResource(targetMemoId, uploadFile);
          void queryClient.invalidateQueries({ queryKey: ["resources"] });

          const activeEditor = editorRef.current;
          if (memoRef.current?.id !== targetMemoId || !isEditorReady(activeEditor)) {
            setImageUploadState("idle");
            return;
          }

          activeEditor
            .chain()
            .focus()
            .setImage({
              src: resource.url,
              alt: file.name,
              title: file.name,
              width: DEFAULT_IMAGE_WIDTH_PERCENT,
            })
            .run();
        }

        setImageUploadState("idle");
      } catch {
        setImageUploadState("error");
        window.setTimeout(() => setImageUploadState("idle"), 2200);
      }
    })();
  }, [queryClient, saveBlocked, t]);

  const insertResourceFiles = useCallback((files: File[]) => {
    const currentMemo = memoRef.current;
    const currentEditor = editorRef.current;

    if (saveBlocked || !currentMemo || currentMemo.isDeleted || !currentEditor || !currentEditor.isEditable || files.length === 0) {
      return;
    }

    const targetMemoId = currentMemo.id;

    void (async () => {
      setImageUploadState("uploading");

      try {
        for (const file of files) {
          const isImage = SUPPORTED_PASTE_IMAGE_TYPES.has(file.type);
          const shouldCompress = isImage && imageCompressionEnabledRef.current;
          setImageUploadState(shouldCompress ? "compressing" : "uploading");
          const uploadFile = shouldCompress ? (await compressImageForUpload(file)).file : file;

          setImageUploadState("uploading");
          const { resource } = await api.uploadMemoResource(targetMemoId, uploadFile);
          void queryClient.invalidateQueries({ queryKey: ["resources"] });

          const activeEditor = editorRef.current;
          if (memoRef.current?.id !== targetMemoId || !isEditorReady(activeEditor)) {
            setImageUploadState("idle");
            return;
          }

          if (resource.kind === "image") {
            activeEditor
              .chain()
              .focus()
              .setImage({
                src: resource.url,
                alt: file.name,
                title: file.name,
                width: DEFAULT_IMAGE_WIDTH_PERCENT,
              })
              .run();
          } else {
            activeEditor
              .chain()
              .focus()
              .insertContent({
                type: "paragraph",
                content: [{ type: "text", text: t("editor.attachmentInsertText", { filename: resource.filename || file.name, url: resource.url }) }],
              })
              .run();
          }
        }

        setImageUploadState("idle");
      } catch {
        setImageUploadState("error");
        window.setTimeout(() => setImageUploadState("idle"), 2200);
      }
    })();
  }, [queryClient, saveBlocked, t]);

  const editor = useEditor({
    extensions: [
      StarterKit,
      ResizableImage.configure({
        allowBase64: false,
        inline: false,
      }),
      Placeholder.configure({
        placeholder: t("editor.placeholder"),
      }),
    ],
    content: memo?.contentJson ?? { type: "doc", content: [{ type: "paragraph" }] },
    editable: Boolean(memo && !effectiveReadOnly),
    editorProps: {
      attributes: {
        class: "prose prose-slate max-w-none focus:outline-none min-h-[300px] px-4 py-3 sm:px-7",
      },
      handlePaste: (_view, event) => {
        const files = getImageFilesFromDataTransfer(event.clipboardData);

        if (files.length === 0) {
          return false;
        }

        event.preventDefault();
        insertImageFiles(files);
        return true;
      },
      handleDrop: (_view, event) => {
        const files = getImageFilesFromDataTransfer(event.dataTransfer);

        if (files.length === 0) {
          return false;
        }

        event.preventDefault();
        insertImageFiles(files);
        return true;
      },
      handleDOMEvents: {
        compositionstart: () => {
          isComposingRef.current = true;
          clearAutoSaveTimer();
          return false;
        },
        compositionend: () => {
          isComposingRef.current = false;
          scheduleAutoSave();
          return false;
        },
      },
    },
  });

  useEffect(() => {
    imageCompressionEnabledRef.current = imageCompressionEnabled;
  }, [imageCompressionEnabled]);

  useEffect(() => {
    saveStateRef.current = saveState;
  }, [saveState]);

  useEffect(() => {
    editorRef.current = editor;
    return () => {
      if (editorRef.current === editor) {
        editorRef.current = null;
      }
    };
  }, [editor]);

  const noteSearchMatches = useMemo(
    () => getEditorSearchMatches(editor, noteSearchQuery),
    [dirtyVersion, editor, memo?.id, noteSearchQuery]
  );

  const selectNoteSearchMatch = useCallback(
    (index: number) => {
      const match = noteSearchMatches[index];

      if (!isEditorReady(editor) || !match) {
        return;
      }

      editor.commands.setTextSelection({ from: match.from, to: match.to });
    },
    [editor, noteSearchMatches]
  );

  const focusNoteSearchInput = useCallback(() => {
    window.requestAnimationFrame(() => {
      noteSearchInputRef.current?.focus();
      noteSearchInputRef.current?.select();
    });
  }, []);

  const openNoteSearch = useCallback((showReplace = false) => {
    setNoteSearchOpen(true);
    setNoteSearchReplaceOpen(showReplace);
    focusNoteSearchInput();
  }, [focusNoteSearchInput]);

  const openNoteReplace = useCallback(() => {
    setNoteSearchOpen(true);
    setNoteSearchReplaceOpen(true);
    focusNoteSearchInput();
  }, [focusNoteSearchInput]);

  const closeNoteSearch = useCallback(() => {
    setNoteSearchOpen(false);
    if (isEditorReady(editor)) {
      editor.commands.focus();
    }
  }, [editor]);

  const moveNoteSearchMatch = useCallback(
    (direction: 1 | -1) => {
      if (noteSearchMatches.length === 0) {
        return;
      }

      setNoteSearchIndex((current) => {
        const next = (current + direction + noteSearchMatches.length) % noteSearchMatches.length;
        selectNoteSearchMatch(next);
        return next;
      });
    },
    [noteSearchMatches.length, selectNoteSearchMatch]
  );

  useEffect(() => {
    if (searchFocusToken === 0) {
      return;
    }

    openNoteSearch();
  }, [openNoteSearch, searchFocusToken]);

  useEffect(() => {
    if (replaceFocusToken === 0) {
      return;
    }

    openNoteReplace();
  }, [openNoteReplace, replaceFocusToken]);

  useEffect(() => {
    setNoteSearchIndex(0);

    if (noteSearchOpen && noteSearchMatches[0]) {
      selectNoteSearchMatch(0);
    }
  }, [noteSearchMatches, noteSearchOpen, selectNoteSearchMatch]);

  const replaceAllNoteSearchMatches = useCallback(() => {
    if (!isEditorReady(editor) || effectiveReadOnly || noteSearchMatches.length === 0) {
      return;
    }

    editor
      .chain()
      .focus()
      .command(({ tr, dispatch }) => {
        for (const match of [...noteSearchMatches].reverse()) {
          tr.insertText(noteSearchReplacement, match.from, match.to);
        }

        dispatch?.(tr);
        return true;
      })
      .run();

    setNoteSearchIndex(0);
    window.requestAnimationFrame(() => noteSearchInputRef.current?.focus());
  }, [editor, effectiveReadOnly, noteSearchMatches, noteSearchReplacement]);

  useEffect(() => {
    if (!isEditorReady(editor)) {
      return;
    }

    const refreshToolbar = () => {
      if (isMobileViewport && !mobileToolbarOpen) {
        return;
      }

      if (toolbarRefreshFrameRef.current !== null) {
        return;
      }

      toolbarRefreshFrameRef.current = window.requestAnimationFrame(() => {
        toolbarRefreshFrameRef.current = null;
        setEditorStateVersion((version) => version + 1);
      });
    };
    editor.on("selectionUpdate", refreshToolbar);

    return () => {
      editor.off("selectionUpdate", refreshToolbar);
      if (toolbarRefreshFrameRef.current !== null) {
        window.cancelAnimationFrame(toolbarRefreshFrameRef.current);
        toolbarRefreshFrameRef.current = null;
      }
    };
  }, [editor, isMobileViewport, mobileToolbarOpen]);

  useEffect(() => {
    if (isMobileViewport && isMobileEditing) {
      clearAutoSaveTimer();
    }
  }, [clearAutoSaveTimer, isMobileEditing, isMobileViewport]);

  const writeCurrentDraftNow = useCallback(async () => {
    const latestMemo = memoRef.current;
    const latestEditor = editorRef.current;

    if (!latestMemo || latestMemo.isDeleted || !isEditorReady(latestEditor)) {
      return;
    }

    await localDb.drafts.put({
      memoId: latestMemo.id,
      title: draftTitleRef.current,
      tagsText: draftTagsTextRef.current,
      contentJson: latestEditor.getJSON() as TiptapDoc,
      updatedAt: new Date().toISOString(),
    });
  }, []);

  const persistCurrentDraft = useCallback(
    (nextTitle = title, nextTagsText = tagsText) => {
      const currentMemo = memoRef.current;
      const currentEditor = editorRef.current;

      if (!currentMemo || currentMemo.isDeleted || !isEditorReady(currentEditor)) {
        return;
      }

      draftTitleRef.current = nextTitle;
      draftTagsTextRef.current = nextTagsText;

      if (draftPersistTimerRef.current !== null) {
        window.clearTimeout(draftPersistTimerRef.current);
      }

      draftPersistTimerRef.current = window.setTimeout(() => {
        draftPersistTimerRef.current = null;
        void writeCurrentDraftNow();
      }, isMobileViewport ? MOBILE_DRAFT_PERSIST_IDLE_MS : DESKTOP_DRAFT_PERSIST_IDLE_MS);
    },
    [isMobileViewport, tagsText, title, writeCurrentDraftNow]
  );

  const markDirty = useCallback(() => {
    const currentMemo = memoRef.current;
    if (hydratingRef.current || currentMemo?.isDeleted) {
      return;
    }

    if (!hasUnsavedChangesRef.current) {
      hasUnsavedChangesRef.current = true;
      unsavedSinceRef.current = Date.now();
      setHasUnsavedChanges(true);
    }

    if (noteSearchOpen && noteSearchQuery.trim()) {
      setDirtyVersion((version) => version + 1);
    }

    if (saveStateRef.current !== "idle") {
      saveStateRef.current = "idle";
      setSaveState("idle");
    }
  }, [noteSearchOpen, noteSearchQuery]);

  const currentSnapshot = useCallback(() => {
    const currentEditor = editorRef.current;
    if (!isEditorReady(currentEditor)) {
      return null;
    }

    return JSON.stringify({
      title,
      tagsText,
      contentJson: currentEditor.getJSON(),
    });
  }, [tagsText, title]);

  useEffect(() => {
    const currentEditor = editorRef.current;
    let cancelled = false;

    if (!memo) {
      memoRef.current = null;
      editingMemoIdRef.current = null;
      hasUnsavedChangesRef.current = false;
      unsavedSinceRef.current = null;
      draftTitleRef.current = "";
      draftTagsTextRef.current = "";
      setHasUnsavedChanges(false);
      setTitle("");
      setTagsText("");
      setSaveState("idle");
      if (isEditorReady(currentEditor)) {
        currentEditor.commands.clearContent();
      }
      return;
    }

    const sameMemo = editingMemoIdRef.current === memo.id;
    const shouldPreserveUnsavedContent =
      Boolean(preserveUnsavedContentFromMemoId) &&
      editingMemoIdRef.current === preserveUnsavedContentFromMemoId &&
      memo.id !== preserveUnsavedContentFromMemoId &&
      hasUnsavedChangesRef.current &&
      !memo.isDeleted;

    memoRef.current = memo;

    if (shouldPreserveUnsavedContent) {
      editingMemoIdRef.current = memo.id;
      setSaveState("idle");
      void localDb.drafts.delete(preserveUnsavedContentFromMemoId as string);
      return;
    }

    if (sameMemo && hasUnsavedChangesRef.current && !memo.isDeleted) {
      return;
    }

    void (async () => {
      const [draft, queuedUpdate] = memo.isDeleted
        ? [null, null]
        : await Promise.all([
            localDb.drafts.get(memo.id),
            localDb.syncQueue.get(getMemoUpdateQueueId(memo.id)),
          ]);

      if (cancelled) {
        return;
      }

      const draftUpdatedAt = draft ? Date.parse(draft.updatedAt) : 0;
      const remoteUpdatedAt = Date.parse(memo.updatedAt);
      const useDraft = Boolean(draft && (queuedUpdate || draftUpdatedAt >= remoteUpdatedAt));
      const nextTitle = useDraft && draft ? draft.title : memo.title ?? "";
      const nextTagsText = useDraft && draft ? draft.tagsText : memo.tags.join(", ");
      const nextContent = useDraft && draft ? draft.contentJson : memo.contentJson;
      const nextHasUnsavedChanges = Boolean(useDraft && !queuedUpdate);

      hydratingRef.current = true;
      editingMemoIdRef.current = memo.id;
      hasUnsavedChangesRef.current = nextHasUnsavedChanges;
      unsavedSinceRef.current = nextHasUnsavedChanges ? Date.now() : null;
      draftTitleRef.current = nextTitle;
      draftTagsTextRef.current = nextTagsText;
      setHasUnsavedChanges(nextHasUnsavedChanges);
      setSaveState(queuedUpdate ? syncStatusToSaveState(queuedUpdate.status) : "idle");
      setTitle(nextTitle);
      setTagsText(nextTagsText);

      if (isEditorReady(currentEditor)) {
        currentEditor.commands.setContent(nextContent);
      }

      window.setTimeout(() => {
        hydratingRef.current = false;
      }, 0);
    })();

    return () => {
      cancelled = true;
    };
  }, [isTrashView, memo, editor, preserveUnsavedContentFromMemoId]);

  useEffect(() => {
    if (isEditorReady(editor)) {
      editor.setEditable(Boolean(memo && !effectiveReadOnly));
    }
  }, [editor, effectiveReadOnly, memo]);

  useEffect(() => {
    if (!isEditorReady(editor) || !memo) {
      return;
    }

    const persistDraft = () => {
      if (hydratingRef.current || memoRef.current?.isDeleted) {
        return;
      }
      persistCurrentDraft();
      markDirty();
      if (!isComposingRef.current) {
        scheduleAutoSave();
      }
    };

    editor.on("update", persistDraft);
    return () => {
      editor.off("update", persistDraft);
    };
  }, [editor, markDirty, memo, persistCurrentDraft, scheduleAutoSave]);

  useEffect(() => {
    return () => {
      if (draftPersistTimerRef.current !== null) {
        window.clearTimeout(draftPersistTimerRef.current);
        draftPersistTimerRef.current = null;
      }
      if (autoSaveTimerRef.current !== null) {
        window.clearTimeout(autoSaveTimerRef.current);
        autoSaveTimerRef.current = null;
      }
    };
  }, []);

  const saveMutation = useMutation({
    mutationFn: async () => {
      const currentMemo = memoRef.current;
      const currentEditor = editorRef.current;

      if (!currentMemo || !isEditorReady(currentEditor)) {
        throw new Error("No memo selected");
      }

      if (saveBlocked) {
        throw new Error("Memo is not ready to save");
      }

      if (currentMemo.isDeleted) {
        throw new Error("Deleted memos are read-only");
      }

      const snapshot = currentSnapshot();
      if (!snapshot) {
        throw new Error("Editor is not ready");
      }

      const contentJson = currentEditor.getJSON() as TiptapDoc;
      const payload: MemoUpdateSyncPayload = {
        memoId: currentMemo.id,
        expectedRevision: currentMemo.revision,
        title,
        contentJson,
        tags: parseTagsText(tagsText),
      };
      let data;

      try {
        data = await api.updateMemo(currentMemo.id, {
          expectedRevision: payload.expectedRevision,
          title: payload.title,
          contentJson: payload.contentJson,
          tags: payload.tags,
        });
      } catch (error) {
        throw new MemoSaveRequestError(error, payload, tagsText);
      }

      return { memo: data.memo, snapshot };
    },
    onMutate: () => {
      if (!saveBlocked) {
        setSaveState("saving");
      }
    },
    onSuccess: async ({ memo: savedMemo, snapshot }) => {
      memoRef.current = savedMemo;
      await onSaved(savedMemo);

      if (currentSnapshot() === snapshot) {
        hasUnsavedChangesRef.current = false;
        unsavedSinceRef.current = null;
        setHasUnsavedChanges(false);
        await localDb.drafts.delete(savedMemo.id);
        setSaveState("saved");
        window.setTimeout(() => setSaveState("idle"), 1400);
        return;
      }

      persistCurrentDraft();
      hasUnsavedChangesRef.current = true;
      unsavedSinceRef.current = Date.now();
      setHasUnsavedChanges(true);
      setSaveState("idle");
      scheduleAutoSave();
    },
    onError: async (error) => {
      const sourceError = error instanceof MemoSaveRequestError ? error.originalError : error;
      const code =
        sourceError && typeof sourceError === "object" && "code" in sourceError
          ? String(sourceError.code)
          : null;

      if (code === "revision_conflict") {
        setSaveState("conflict");
        return;
      }

      if (error instanceof MemoSaveRequestError && shouldQueueMemoSaveError(sourceError)) {
        await queueMemoUpdate(error.payload);
        await localDb.drafts.put({
          memoId: error.payload.memoId,
          title: error.payload.title,
          tagsText: error.tagsText,
          contentJson: error.payload.contentJson,
          updatedAt: new Date().toISOString(),
        });

        hasUnsavedChangesRef.current = false;
        unsavedSinceRef.current = null;
        setHasUnsavedChanges(false);
        setSaveState("queued");
        return;
      }

      setSaveState("error");
    },
  });

  useEffect(() => {
    if (
      !memo ||
      memo.isDeleted ||
      !editor ||
      autoSaveVersion === 0 ||
      autoSaveVersion === lastAutoSaveVersionRef.current ||
      !hasUnsavedChanges ||
      saveBlocked ||
      saveMutation.isPending ||
      saveState === "conflict"
    ) {
      return;
    }

    lastAutoSaveVersionRef.current = autoSaveVersion;
    saveMutation.mutate();
  }, [autoSaveVersion, editor, hasUnsavedChanges, memo, saveBlocked, saveMutation, saveState]);

  useEffect(() => {
    if (!saveBlocked && hasUnsavedChangesRef.current && !isComposingRef.current) {
      scheduleAutoSave();
    }
  }, [memo?.id, saveBlocked, scheduleAutoSave]);

  useEffect(() => {
    const flushBeforeBackground = () => {
      if (!hasUnsavedChangesRef.current) {
        return;
      }

      if (draftPersistTimerRef.current !== null) {
        window.clearTimeout(draftPersistTimerRef.current);
        draftPersistTimerRef.current = null;
      }

      void writeCurrentDraftNow();

      if (
        isComposingRef.current ||
        saveBlocked ||
        saveMutation.isPending ||
        saveStateRef.current === "conflict"
      ) {
        return;
      }

      saveMutation.mutate();
    };

    const handleVisibilityChange = () => {
      if (document.visibilityState === "hidden") {
        flushBeforeBackground();
      }
    };

    document.addEventListener("visibilitychange", handleVisibilityChange);
    window.addEventListener("pagehide", flushBeforeBackground);

    return () => {
      document.removeEventListener("visibilitychange", handleVisibilityChange);
      window.removeEventListener("pagehide", flushBeforeBackground);
    };
  }, [saveBlocked, saveMutation, writeCurrentDraftNow]);

  useEffect(() => {
    if (
      !pendingBackAfterSaveRef.current ||
      saveBlocked ||
      !memo ||
      memo.isDeleted ||
      !editor ||
      !hasUnsavedChanges ||
      saveMutation.isPending ||
      saveState === "conflict"
    ) {
      return;
    }

    pendingBackAfterSaveRef.current = false;
    saveMutation.mutate(undefined, {
      onSuccess: () => onBackToList(),
      onError: (error) => {
        const sourceError = error instanceof MemoSaveRequestError ? error.originalError : error;
        if (error instanceof MemoSaveRequestError && shouldQueueMemoSaveError(sourceError)) {
          onBackToList();
        }
      },
    });
  }, [editor, hasUnsavedChanges, memo, onBackToList, saveBlocked, saveMutation, saveState]);

  if (isSelectionMode) {
    return (
      <div className="flex h-full min-w-0 flex-col bg-white">
        {selectionActionBar}
      </div>
    );
  }

  if (isLoading) {
    return (
      <div className="flex h-full min-w-0 flex-col bg-white">
        {selectionActionBar}
        <div className="flex min-h-0 flex-1 items-center justify-center text-sm text-slate-500">{t("editor.loading")}</div>
      </div>
    );
  }

  if (!memo) {
    return (
      <div className="flex h-full min-w-0 flex-col bg-white">
        {selectionActionBar}
        <div className="flex min-h-0 flex-1 items-center justify-center px-8 text-center">
          <div>
            <Sparkles className="mx-auto mb-3 h-8 w-8 text-slate-300 animate-pulse" />
            <div className="text-sm font-medium text-slate-400">{t("editor.emptySelection")}</div>
          </div>
        </div>
      </div>
    );
  }

  const saveLabel =
    saveState === "saving"
      ? t("editor.saveState.saving")
      : saveState === "saved"
        ? t("editor.saveState.saved")
        : saveState === "queued"
          ? t("editor.saveState.queued")
          : saveState === "conflict"
            ? t("editor.saveState.conflict")
            : saveState === "error"
              ? t("editor.saveState.error")
              : hasUnsavedChanges
                ? t("editor.saveState.unsaved")
                : t("editor.saveState.saved");

  const saveStateClassName =
    saveState === "error" || saveState === "conflict"
      ? "bg-rose-50 text-rose-700"
      : saveState === "queued"
        ? "bg-amber-50 text-amber-700"
        : saveState === "saving" || hasUnsavedChanges
          ? "bg-emerald-50 text-emerald-700"
          : "bg-slate-100 text-slate-500";

  const imageUploadLabel =
    imageUploadState === "error"
      ? t("editor.uploadState.failed")
      : imageUploadState === "compressing"
        ? t("editor.uploadState.compressing")
        : imageUploadState === "uploading"
          ? t("editor.uploadState.uploading")
          : null;

  const mobileStatusLabel = imageUploadLabel ?? saveLabel;
  const mobileStatusClassName =
    imageUploadState === "error"
      ? "bg-rose-50 text-rose-700"
      : imageUploadState !== "idle"
        ? "bg-emerald-50 text-emerald-700"
        : saveStateClassName;

  const updatedLabel = formatDateTime(memo.updatedAt);
  const currentNotebookLabel = notebookOptions.find((notebook) => notebook.id === memo.notebookId)?.name ?? t("editor.notebookFallback");

  const mobileDoneDisabled =
    saveMutation.isPending ||
    notebookUpdatePending ||
    imageUploadState === "compressing" ||
    imageUploadState === "uploading";
  const noteSearchMatchLabel = noteSearchQuery.trim()
    ? `${noteSearchMatches.length > 0 ? noteSearchIndex + 1 : 0}/${noteSearchMatches.length}`
    : "0/0";

  const updateMemoNotebook = (notebookId: string, sourceMemo: MemoDetail = memoRef.current ?? memo) => {
    if (saveBlocked || effectiveReadOnly || notebookId === sourceMemo.notebookId || notebookUpdatePending) {
      setMobileNotebookSheetOpen(false);
      return;
    }

    setNotebookUpdatePending(true);
    setSaveState("saving");

    void api
      .updateMemo(sourceMemo.id, {
        expectedRevision: sourceMemo.revision,
        notebookId,
      })
      .then(async (data) => {
        memoRef.current = data.memo;
        await onSaved(data.memo);
        setSaveState("saved");
        window.setTimeout(() => setSaveState("idle"), 1200);
      })
      .catch(() => setSaveState("error"))
      .finally(() => {
        setNotebookUpdatePending(false);
        setMobileNotebookSheetOpen(false);
      });
  };

  const handleNotebookChange = (notebookId: string) => {
    if (saveBlocked || !hasUnsavedChanges || saveMutation.isPending) {
      updateMemoNotebook(notebookId);
      return;
    }

    saveMutation.mutate(undefined, {
      onSuccess: ({ memo: savedMemo }) => updateMemoNotebook(notebookId, savedMemo),
    });
  };

  const handleMobileBack = () => {
    clearAutoSaveTimer();

    if (saveBlocked && editor && hasUnsavedChanges) {
      pendingBackAfterSaveRef.current = true;
      setSaveState("saving");
      setIsMobileEditing(false);
      setMobileToolbarOpen(false);
      return;
    }

    if (readOnly || saveBlocked || !editor || !hasUnsavedChanges) {
      onBackToList();
      return;
    }

    saveMutation.mutate(undefined, {
      onSuccess: () => onBackToList(),
      onError: (error) => {
        const sourceError = error instanceof MemoSaveRequestError ? error.originalError : error;
        if (error instanceof MemoSaveRequestError && shouldQueueMemoSaveError(sourceError)) {
          onBackToList();
        }
      },
    });
  };

  const handleMobileDone = () => {
    clearAutoSaveTimer();

    if (readOnly || saveBlocked || !editor || !hasUnsavedChanges) {
      setIsMobileEditing(false);
      setMobileToolbarOpen(false);
      return;
    }

    saveMutation.mutate(undefined, {
      onSuccess: () => {
        setIsMobileEditing(false);
        setMobileToolbarOpen(false);
      },
      onError: (error) => {
        const sourceError = error instanceof MemoSaveRequestError ? error.originalError : error;
        if (error instanceof MemoSaveRequestError && shouldQueueMemoSaveError(sourceError)) {
          setIsMobileEditing(false);
          setMobileToolbarOpen(false);
        }
      },
    });
  };

  return (
    <div className="relative flex h-full min-w-0 flex-col bg-white">
      {selectionActionBar}
      <header className="shrink-0 border-b border-slate-200 bg-white">
        <div className="flex min-h-12 items-center justify-between gap-2 border-b border-slate-100 px-3 py-2 sm:px-5">
          <div className="flex min-w-0 items-center gap-2 text-sm">
            <Button
              className="lg:hidden"
              size="icon"
              variant="ghost"
              title={hasUnsavedChanges && !readOnly ? t("editor.saveAndBack") : t("editor.backToList")}
              aria-label={hasUnsavedChanges && !readOnly ? t("editor.saveAndBack") : t("editor.backToList")}
              disabled={mobileDoneDisabled}
              onClick={handleMobileBack}
            >
              <ChevronLeft className="h-4 w-4" />
            </Button>
            <div className="hidden items-center gap-1 sm:flex lg:hidden">
              <button
                className="flex h-8 w-8 items-center justify-center rounded-md text-slate-500 transition hover:bg-slate-50 hover:text-slate-900 disabled:opacity-30"
                type="button"
                title={t("editor.previousMemo")}
                aria-label={t("editor.previousMemo")}
                disabled={!hasPreviousMemo}
                onClick={onOpenPreviousMemo}
              >
                <ChevronLeft className="h-3.5 w-3.5" />
              </button>
              <button
                className="flex h-8 w-8 items-center justify-center rounded-md text-slate-500 transition hover:bg-slate-50 hover:text-slate-900 disabled:opacity-30"
                type="button"
                title={t("editor.nextMemo")}
                aria-label={t("editor.nextMemo")}
                disabled={!hasNextMemo}
                onClick={onOpenNextMemo}
              >
                <ChevronRight className="h-3.5 w-3.5" />
              </button>
            </div>
            <div className="hidden items-center gap-1 lg:flex">
              <Button size="icon" variant="ghost" title={t("editor.previousMemo")} aria-label={t("editor.previousMemo")} onClick={onOpenPreviousMemo} disabled={!hasPreviousMemo}>
                <ChevronLeft className="h-4 w-4" />
              </Button>
              <Button size="icon" variant="ghost" title={t("editor.nextMemo")} aria-label={t("editor.nextMemo")} onClick={onOpenNextMemo} disabled={!hasNextMemo}>
                <ChevronRight className="h-4 w-4" />
              </Button>
            </div>
            <span className="hidden truncate text-xs text-slate-400 sm:inline">
              {t("editor.updatedAt", { time: updatedLabel })}
            </span>
          </div>

          <div className="flex shrink-0 items-center gap-1">
            {imageUploadState !== "idle" && (
              <span
                className={cn(
                  "hidden rounded-md px-2 py-1 text-xs font-medium md:inline-flex",
                  imageUploadState === "error"
                    ? "bg-rose-50 text-rose-700"
                    : "bg-emerald-50 text-emerald-700"
                )}
              >
                {imageUploadState === "error"
                  ? t("editor.uploadState.fileFailed")
                  : imageUploadState === "compressing"
                    ? t("editor.uploadState.imageCompressing")
                    : t("editor.uploadState.fileUploading")}
              </span>
            )}
            <span className={cn("hidden rounded-md px-2 py-1 text-xs font-medium sm:inline-flex", saveStateClassName)}>
              {saveLabel}
            </span>
            <span className={cn("inline-flex max-w-[5.5rem] truncate rounded-full px-2 py-1 text-[11px] font-medium sm:hidden", mobileStatusClassName)}>
              {mobileStatusLabel}
            </span>
            {isMobileEditing && !readOnly && (
              <button
                className="inline-flex h-8 items-center justify-center rounded-full bg-slate-950 px-3 text-xs font-semibold text-white transition hover:bg-slate-800 disabled:bg-slate-200 disabled:text-slate-500 sm:hidden"
                type="button"
                disabled={mobileDoneDisabled}
                onClick={handleMobileDone}
              >
                {saveMutation.isPending ? t("editor.saveState.saving") : t("editor.done")}
              </button>
            )}
            <input
              ref={fileInputRef}
              className="hidden"
              type="file"
              multiple
              onChange={(event) => {
                const files = Array.from(event.target.files ?? []);
                event.target.value = "";
                insertResourceFiles(files);
              }}
            />
            {isMobileEditing && !readOnly && (
              <Button
                className="sm:hidden"
                size="icon"
                variant="ghost"
                title={t("editor.uploadAttachment")}
                aria-label={t("editor.uploadAttachment")}
                disabled={mobileDoneDisabled || effectiveReadOnly || saveBlocked}
                onClick={() => fileInputRef.current?.click()}
              >
                <Paperclip className="h-4 w-4" />
              </Button>
            )}
            {isMobileEditing && !readOnly && (
              <Button
                className="sm:hidden"
                size="icon"
                variant={mobileToolbarOpen ? "soft" : "ghost"}
                title={mobileToolbarOpen ? t("editor.collapseFormat") : t("editor.format")}
                aria-label={mobileToolbarOpen ? t("editor.collapseFormat") : t("editor.format")}
                aria-pressed={mobileToolbarOpen}
                disabled={effectiveReadOnly}
                onClick={() => setMobileToolbarOpen((open) => !open)}
              >
                <Type className="h-4 w-4" />
              </Button>
            )}
            <Button className="hidden sm:inline-flex" size="icon" variant="ghost" title={t("editor.searchCurrentMemo")} aria-label={t("editor.searchCurrentMemo")} onClick={() => openNoteSearch()}>
              <Search className="h-4 w-4" />
            </Button>
            <Button className="hidden sm:inline-flex" size="icon" variant="ghost" title={t("editor.versionHistory")} aria-label={t("editor.versionHistory")} disabled={saveBlocked} onClick={() => setHistoryOpen(true)}>
              <History className="h-4 w-4" />
            </Button>
            <GitHubRepositoryLink className="hidden h-8 w-8 justify-center rounded-md text-slate-500 transition hover:bg-slate-50 hover:text-slate-900 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-emerald-500/70 lg:inline-flex" />
            {!readOnly && (
              <Button
                className="hidden sm:inline-flex"
                size="icon"
                variant="solid"
                title={t("editor.save")}
                aria-label={t("editor.save")}
                onClick={() => saveMutation.mutate()}
                disabled={!editor || saveBlocked || saveMutation.isPending || !hasUnsavedChanges}
              >
                <Save className="h-4 w-4" />
              </Button>
            )}
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <Button
                  className={cn(!isMobileEditing && !readOnly && "hidden sm:inline-flex")}
                  size="icon"
                  variant="ghost"
                  title={t("editor.more")}
                  aria-label={t("editor.moreAria")}
                >
                  <MoreHorizontal className="h-4 w-4" />
                </Button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end" className="w-44 bg-white border border-slate-200 rounded-md py-1 shadow-md">
                <DropdownMenuItem
                  className="flex h-9 w-full items-center gap-2 px-3 text-left text-sm text-slate-700 hover:bg-slate-50 cursor-pointer outline-none"
                  onClick={() => openNoteSearch()}
                >
                  <Search className="h-4 w-4 text-slate-500" />
                  {t("editor.searchCurrentMemo")}
                </DropdownMenuItem>
                <DropdownMenuItem
                  className="flex h-9 w-full items-center gap-2 px-3 text-left text-sm text-slate-700 hover:bg-slate-50 cursor-pointer outline-none"
                  onClick={openNoteReplace}
                >
                  <ReplaceAll className="h-4 w-4 text-slate-500" />
                  {t("editor.replaceCurrentMemo")}
                </DropdownMenuItem>
                <DropdownMenuItem
                  className="flex h-9 w-full items-center gap-2 px-3 text-left text-sm text-slate-700 hover:bg-slate-50 cursor-pointer outline-none"
                  disabled={saveBlocked}
                  onClick={() => {
                    setHistoryOpen(true);
                  }}
                >
                  <History className="h-4 w-4 text-slate-500" />
                  {t("editor.versionHistory")}
                </DropdownMenuItem>
                {readOnly ? (
                  <>
                    <DropdownMenuItem
                      className="flex h-9 w-full items-center gap-2 px-3 text-left text-sm text-slate-700 hover:bg-slate-50 cursor-pointer outline-none"
                      onClick={() => void onRestored(memo.id)}
                    >
                      <RotateCcw className="h-4 w-4 text-slate-500" />
                      {t("editor.restoreMemo")}
                    </DropdownMenuItem>
                    <DropdownMenuSeparator className="my-1 h-px bg-slate-100" />
                    <DropdownMenuItem
                      className="flex h-9 w-full items-center gap-2 px-3 text-left text-sm text-rose-700 hover:bg-rose-50 cursor-pointer outline-none"
                      disabled={saveBlocked}
                      onClick={() => void onPermanentDeleted(memo.id)}
                    >
                      <Trash2 className="h-4 w-4" />
                      {t("editor.deleteForever")}
                    </DropdownMenuItem>
                  </>
                ) : (
                  <>
                    <DropdownMenuSeparator className="my-1 h-px bg-slate-100" />
                    <DropdownMenuItem
                      className="flex h-9 w-full items-center gap-2 px-3 text-left text-sm text-rose-700 hover:bg-rose-50 cursor-pointer outline-none"
                      disabled={saveBlocked}
                      onClick={() => void onDeleted(memo.id)}
                    >
                      <Trash2 className="h-4 w-4" />
                      {t("editor.deleteMemo")}
                    </DropdownMenuItem>
                  </>
                )}
              </DropdownMenuContent>
            </DropdownMenu>
          </div>
        </div>

        <div className="space-y-3 px-4 pb-4 pt-4 sm:px-7">
          <input
            value={title}
            readOnly={effectiveReadOnly}
            onChange={(event) => {
              setTitle(event.target.value);
              persistCurrentDraft(event.target.value, tagsText);
              markDirty();
              scheduleAutoSave();
            }}
            className="block w-full rounded-md border-0 bg-transparent text-2xl font-bold leading-tight text-slate-950 outline-none transition placeholder:text-slate-300 focus-visible:bg-slate-50 focus-visible:shadow-[inset_3px_0_0_var(--brand-green)] sm:text-3xl"
            placeholder={t("common.untitledMemo")}
          />
          <div className="flex flex-wrap items-center gap-2">
            <button
              className="flex h-8 min-w-0 max-w-full items-center gap-1 rounded-md border border-transparent bg-transparent px-2 text-sm font-medium text-slate-600 outline-none transition hover:border-slate-200 hover:bg-slate-50 hover:text-slate-900 focus-visible:border-emerald-300 focus-visible:ring-2 focus-visible:ring-emerald-500/20 disabled:opacity-50 sm:hidden"
              type="button"
              disabled={saveBlocked || effectiveReadOnly || notebookUpdatePending}
              title={t("editor.currentNotebook")}
              aria-label={t("editor.currentNotebookAria", { name: currentNotebookLabel })}
              onClick={() => setMobileNotebookSheetOpen(true)}
            >
              <span className="min-w-0 truncate">{currentNotebookLabel}</span>
              <ChevronDown className="h-3.5 w-3.5 shrink-0 text-slate-400" />
            </button>
            <div className="hidden min-w-[9rem] max-w-[18rem] sm:block">
              <Select
                value={memo.notebookId}
                disabled={saveBlocked || effectiveReadOnly || notebookUpdatePending}
                onValueChange={(value) => handleNotebookChange(value)}
              >
                <SelectTrigger className="h-8 min-w-0 border-transparent bg-transparent px-2 text-sm font-medium text-slate-600 hover:border-slate-200 hover:bg-slate-50 hover:text-slate-900 whitespace-nowrap">
                  <SelectValue placeholder={t("editor.notebookPlaceholder")} />
                </SelectTrigger>
                <SelectContent className="max-h-60 bg-white border border-slate-200 rounded-md py-1 shadow-md">
                  {notebookOptions.map((notebook) => (
                    <SelectItem key={notebook.id} value={notebook.id}>
                      {notebook.selectLabel}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <label className="flex h-8 min-w-[12rem] flex-1 items-center gap-2 rounded-md border border-transparent px-2 text-sm text-slate-500 transition focus-within:border-slate-200 focus-within:bg-slate-50 focus-within:ring-2 focus-within:ring-emerald-500/15">
              <Tags className="h-4 w-4" />
              <input
                value={tagsText}
                readOnly={effectiveReadOnly}
                onChange={(event) => {
                  setTagsText(event.target.value);
                  persistCurrentDraft(title, event.target.value);
                  markDirty();
                  scheduleAutoSave();
                }}
                className="min-w-0 flex-1 bg-transparent outline-none placeholder:text-slate-400"
                placeholder={t("editor.tagPlaceholder")}
              />
            </label>
          </div>
        </div>
        {noteSearchOpen && (
          <div className="flex flex-wrap items-center gap-2 border-t border-slate-100 px-4 py-2 sm:px-7">
            <Search className="h-4 w-4 shrink-0 text-slate-400" />
            <Input
              ref={noteSearchInputRef}
              value={noteSearchQuery}
              className="h-8 min-w-[12rem] flex-1"
              placeholder={t("editor.searchPlaceholder")}
              onChange={(event) => setNoteSearchQuery(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === "Enter") {
                  event.preventDefault();
                  moveNoteSearchMatch(event.shiftKey ? -1 : 1);
                }

                if (event.key === "Escape") {
                  event.preventDefault();
                  closeNoteSearch();
                }
              }}
            />
            {noteSearchReplaceOpen && (
              <Input
                ref={noteReplaceInputRef}
                value={noteSearchReplacement}
                className="h-8 min-w-[12rem] flex-1"
                placeholder={t("editor.replacePlaceholder")}
                disabled={effectiveReadOnly}
                onChange={(event) => setNoteSearchReplacement(event.target.value)}
                onKeyDown={(event) => {
                  if (event.key === "Enter") {
                    event.preventDefault();
                    replaceAllNoteSearchMatches();
                  }

                  if (event.key === "Escape") {
                    event.preventDefault();
                    closeNoteSearch();
                  }
                }}
              />
            )}
            <span
              className={cn(
                "w-12 shrink-0 text-center text-xs tabular-nums",
                noteSearchQuery.trim() && noteSearchMatches.length === 0 ? "text-rose-500" : "text-slate-500"
              )}
              aria-live="polite"
            >
              {noteSearchMatchLabel}
            </span>
            <Button
              size="icon"
              variant="ghost"
              title={t("editor.previousSearchResult")}
              aria-label={t("editor.previousSearchResult")}
              disabled={noteSearchMatches.length === 0}
              onClick={() => moveNoteSearchMatch(-1)}
            >
              <ChevronLeft className="h-4 w-4" />
            </Button>
            <Button
              size="icon"
              variant="ghost"
              title={t("editor.nextSearchResult")}
              aria-label={t("editor.nextSearchResult")}
              disabled={noteSearchMatches.length === 0}
              onClick={() => moveNoteSearchMatch(1)}
            >
              <ChevronRight className="h-4 w-4" />
            </Button>
            {noteSearchReplaceOpen && (
              <Button
                size="sm"
                variant="solid"
                title={t("editor.replaceAll")}
                aria-label={t("editor.replaceAll")}
                disabled={effectiveReadOnly || noteSearchMatches.length === 0}
                onClick={replaceAllNoteSearchMatches}
              >
                <ReplaceAll className="h-4 w-4" />
                {t("editor.replaceAll")}
              </Button>
            )}
            <Button size="icon" variant="ghost" title={t("editor.closeSearch")} aria-label={t("editor.closeSearch")} onClick={closeNoteSearch}>
              <X className="h-4 w-4" />
            </Button>
          </div>
        )}
        {(!isMobileViewport || mobileToolbarOpen) && <EditorToolbar editor={editor} readOnly={effectiveReadOnly} />}
      </header>

      <div className="edgeever-editor min-h-0 flex-1 overflow-y-auto bg-white">
        <EditorContent editor={editor} />
      </div>

      {isMobileViewport && !isMobileEditing && !readOnly && (
        <Button
          className="fixed bottom-[calc(1rem+env(safe-area-inset-bottom))] right-4 z-30 h-12 w-12 rounded-full shadow-lg sm:hidden"
          size="icon"
          variant="solid"
          title={t("editor.editMemo")}
          aria-label={t("editor.editMemo")}
          onClick={() => setIsMobileEditing(true)}
        >
          <Pencil className="h-5 w-5" />
        </Button>
      )}

      {historyOpen && (
        <RevisionHistoryDialog
          currentMarkdown={isEditorReady(editor) ? docToMarkdown(editor.getJSON() as TiptapDoc) : memo.contentMarkdown}
          memo={memo}
          onClose={() => setHistoryOpen(false)}
          onRestored={async (restoredMemo) => {
            await localDb.drafts.delete(restoredMemo.id);
            hasUnsavedChangesRef.current = false;
            setHasUnsavedChanges(false);
            await onSaved(restoredMemo);
            setHistoryOpen(false);
          }}
        />
      )}

      {mobileNotebookSheetOpen && (
        <MobileNotebookSelectSheet
          isUpdating={saveBlocked || notebookUpdatePending || saveMutation.isPending}
          options={notebookOptions}
          selectedNotebookId={memo.notebookId}
          onClose={() => setMobileNotebookSheetOpen(false)}
          onSelect={handleNotebookChange}
        />
      )}
    </div>
  );
};
