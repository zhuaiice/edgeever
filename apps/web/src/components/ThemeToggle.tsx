import { MoonStar, SunMedium } from "lucide-react";
import { useTranslation } from "react-i18next";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { useTheme } from "./ThemeProvider";

export const ThemeToggle = ({ className }: { className?: string }) => {
  const { t } = useTranslation();
  const { resolvedTheme, setPreference } = useTheme();
  const nextTheme = resolvedTheme === "dark" ? "light" : "dark";
  const label = nextTheme === "dark" ? t("settings.themeToggleToDark") : t("settings.themeToggleToLight");

  return (
    <Button
      className={cn(
        "hidden h-8 w-8 text-slate-600 transition-colors hover:bg-slate-100 hover:text-slate-950 focus-visible:ring-2 focus-visible:ring-slate-300 lg:inline-flex",
        className
      )}
      size="icon"
      variant="ghost"
      title={label}
      aria-label={label}
      onClick={() => setPreference(nextTheme)}
    >
      {resolvedTheme === "dark" ? <SunMedium className="h-5 w-5" strokeWidth={2.25} /> : <MoonStar className="h-5 w-5" strokeWidth={2.25} />}
    </Button>
  );
};
