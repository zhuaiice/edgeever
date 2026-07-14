import { useState } from "react";
import { AlertCircle, CheckCircle2, Download } from "lucide-react";
import { useTranslation } from "react-i18next";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { api } from "@/lib/api";
import { createMarkdownExport, downloadMarkdownExport, type MarkdownExportProgress } from "@/lib/markdown-export";

type ExportState = "idle" | "exporting" | "complete" | "error";

export const DataExportCard = () => {
  const { t } = useTranslation();
  const [state, setState] = useState<ExportState>("idle");
  const [progress, setProgress] = useState<MarkdownExportProgress>({ completed: 0, total: 0 });

  const handleExport = async () => {
    setState("exporting");
    setProgress({ completed: 0, total: 0 });

    try {
      const blob = await createMarkdownExport(
        {
          listNotebooks: api.listNotebooks,
          getPage: api.getMarkdownExportPage,
          getResourceBlob: api.getResourceBlob,
        },
        setProgress
      );
      downloadMarkdownExport(blob);
      setState("complete");
    } catch (error) {
      console.error("Failed to export Markdown ZIP", error);
      setState("error");
    }
  };

  const percentage = progress.total > 0 ? Math.round((progress.completed / progress.total) * 100) : 0;

  return (
    <Card className="w-full min-w-0 overflow-hidden shadow-none">
      <CardHeader className="p-4 pb-3">
        <CardTitle className="flex items-center gap-2 text-sm">
          <Download className="h-4 w-4 text-emerald-700" />
          {t("dataExport.title")}
        </CardTitle>
      </CardHeader>
      <CardContent className="grid gap-3 p-4 pt-0">
        <div className="grid gap-3 md:grid-cols-[minmax(0,1fr)_auto] md:items-center">
          <CardDescription className="min-w-0 text-xs leading-5 md:truncate">
            {t("dataExport.description")}
          </CardDescription>
          <Button
            size="sm"
            type="button"
            className="w-full whitespace-nowrap md:w-auto"
            disabled={state === "exporting"}
            onClick={() => void handleExport()}
          >
            <Download className="h-4 w-4" />
            {state === "exporting" ? t("dataExport.exportingButton") : t("dataExport.exportButton")}
          </Button>
        </div>

        {state === "exporting" ? (
          <div className="grid gap-1.5" aria-live="polite">
            <div className="flex items-center justify-between text-xs text-slate-500">
              <span>{t("dataExport.exporting")}</span>
              <span>{t("dataExport.progress", { completed: progress.completed, total: progress.total })}</span>
            </div>
            <div className="h-1.5 overflow-hidden rounded-full bg-slate-200">
              <div
                className="h-full rounded-full bg-emerald-600 transition-[width]"
                style={{ width: `${percentage}%` }}
              />
            </div>
          </div>
        ) : null}

        {state === "complete" ? (
          <p className="flex items-center gap-1.5 text-xs text-emerald-700" aria-live="polite">
            <CheckCircle2 className="h-3.5 w-3.5" />
            {t("dataExport.complete")}
          </p>
        ) : null}

        {state === "error" ? (
          <p className="flex items-center gap-1.5 text-xs text-red-600" role="alert">
            <AlertCircle className="h-3.5 w-3.5" />
            {t("dataExport.error")}
          </p>
        ) : null}

      </CardContent>
    </Card>
  );
};
